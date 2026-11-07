/** 读观察池。这里不取数、不入池。 */
import { ServiceError, type ServiceContext } from "../../service.ts";
import { ANCHOR_RULE, CLOSE_REFRESH_MAX, MANUAL_REFRESH_MAX, NEAR_PCT, POOL_SOURCE, limitWatchEnabled } from "./config.ts";
import { analyzeSymbol } from "./analyze.ts";
import { enrollDay, enrollFromClose } from "./enroll.ts";
import { refreshQuotes } from "./quotes.ts";
import { readPool } from "./store.ts";
import { clockOf } from "../shortline/intraday.ts";
import type { LimitWatchView, SymbolSummary } from "./types.ts";

function summaries(ctx: ServiceContext, day: string, hm: string): SymbolSummary[] {
  const pool = readPool(ctx);
  const quotes = new Map(pool.quotes.map((q) => [q.symbol, q]));
  const by = new Map<string, typeof pool.entries>();
  for (const e of pool.entries) by.set(e.symbol, [...(by.get(e.symbol) ?? []), e]);
  return [...by.values()].map((list) => analyzeSymbol(list, quotes.get(list[0]!.symbol) ?? null, day, hm))
    .sort((a, b) => Number(b.marks.some((m) => m.kind === "near" || m.kind === "second_start")) - Number(a.marks.some((m) => m.kind === "near" || m.kind === "second_start")) || b.latest_entry.localeCompare(a.latest_entry) || a.symbol.localeCompare(b.symbol));
}

export function limitWatchView(ctx: ServiceContext, query: Record<string, string>, _signal: AbortSignal, now = new Date()): LimitWatchView {
  const flag = limitWatchEnabled();
  const clock = clockOf(now);
  const pool = readPool(ctx);
  const symbols = summaries(ctx, clock.day, clock.hm);
  const symbol = query.symbol ?? "";
  const one = symbol ? symbols.find((s) => s.symbol === symbol) ?? null : null;
  const quote = symbol ? pool.quotes.find((q) => q.symbol === symbol) ?? null : null;
  const gaps = pool.runs.filter((r) => r.outcome !== "enrolled" || r.reason).slice(-8).map((r) => `${r.date} ${r.outcome === "enrolled" ? "已入池" : r.outcome === "skipped" ? "跳过" : "不完整"}：${r.reason ?? `${r.total ?? 0} 只`}`);
  return {
    enabled: flag.enabled, disabled_reason: flag.reason, as_of: clock.day, clock: clock.hms, near_pct: NEAR_PCT, rules: ANCHOR_RULE,
    symbols, detail: one ? { ...one, bars: quote?.bars ?? [], adjust: quote?.adjust ?? null } : null,
    runs: pool.runs.slice(-20), gaps, source: POOL_SOURCE,
  };
}

export async function limitWatchAct(ctx: ServiceContext, body: Record<string, unknown>, signal: AbortSignal, now = new Date()): Promise<LimitWatchView & { message: string }> {
  if (body.action === "enroll") {
    const date = typeof body.date === "string" ? body.date : "";
    const result = await enrollDay(ctx, date, { now, signal });
    return { ...limitWatchView(ctx, {}, signal, now), message: result.message };
  }
  if (body.action === "refresh") {
    const only = typeof body.symbol === "string" && /^\d{6}$/.test(body.symbol) ? body.symbol : undefined;
    const result = await refreshQuotes(ctx, { now, signal, limit: only ? 1 : MANUAL_REFRESH_MAX, only });
    const message = result.stopped
      ? `行情更新停下：${result.stopped}。已更新 ${result.updated.length} 只，其余仍用上次的 K 线。`
      : `更新了 ${result.updated.length} 只的前复权日 K。`;
    return { ...limitWatchView(ctx, only ? { symbol: only } : {}, signal, now), message };
  }
  throw new ServiceError("bad_request", "未知动作");
}

export async function limitWatchClose(j: { ctx: ServiceContext; day: string; now: Date; signal: AbortSignal }): Promise<string> {
  const enrolled = await enrollFromClose(j);
  const refreshed = await refreshQuotes(j.ctx, { now: j.now, signal: j.signal, limit: CLOSE_REFRESH_MAX });
  const tail = refreshed.stopped ? `行情在 ${refreshed.updated.length} 只后停下（${refreshed.stopped}）` : `顺手更新 ${refreshed.updated.length} 只跟踪中的日 K`;
  return `${enrolled}；${tail}`;
}
