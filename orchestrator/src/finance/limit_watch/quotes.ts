/** 只更新有上限的跟踪名单。失败时留下旧行情，并写上这次的时间和原因。 */
import { fetchEndpoint, type ServiceContext } from "../../service.ts";
import { readRawDoc } from "../candidates.ts";
import { failedNote } from "../schedule.ts";
import { unsupportedKline } from "./analyze.ts";
import { KLINE_COUNT, MANUAL_REFRESH_MAX, QUOTE_CONCURRENCY, limitWatchEnabled } from "./config.ts";
import type { FetchLike } from "./enroll.ts";
import { readPool, rememberQuote, updatePool } from "./store.ts";
import { refreshPlan } from "./analyze.ts";
import { clockOf } from "../shortline/intraday.ts";
import type { QfqBar, QuoteCache } from "./types.ts";

export function barsFromEnvelope(env: unknown, doc: unknown): { ok: true; bars: QfqBar[] } | { ok: false; reason: string } {
  const status = env && typeof env === "object" ? String((env as { status?: unknown }).status ?? "") : "";
  if (status === "failed" || status === "partial") return { ok: false, reason: failedNote(env) || `K 线${status || "没取到"}` };
  const extra = env && typeof env === "object" ? (env as { extra?: { adjust?: unknown } }).extra : undefined;
  const adjust = typeof extra?.adjust === "string" ? extra.adjust : "";
  if (adjust !== "qfq") return { ok: false, reason: `K 线复权是 ${adjust || "未知"}，不是前复权，不拿来和锚点比` };
  const rows = doc && typeof doc === "object" && Array.isArray((doc as { rows?: unknown }).rows) ? (doc as { rows: unknown[] }).rows : null;
  if (!rows?.length) return { ok: false, reason: "前复权 K 线没有明细行" };
  const bars: QfqBar[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") return { ok: false, reason: "K 线有一行不是对象" };
    const r = row as Record<string, unknown>;
    if (typeof r.adjust === "string" && r.adjust !== "qfq") return { ok: false, reason: `序列里出现复权 ${r.adjust}，和前复权混在一起，整段不用` };
    const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "";
    const nums = ["open", "high", "low", "close"].map((k) => r[k]);
    if (!date || nums.some((n) => typeof n !== "number" || !Number.isFinite(n) || n <= 0)) return { ok: false, reason: `${date || "某日"} 的前复权价格缺失或不是正数，不用这串去比锚点` };
    if (seen.has(date)) return { ok: false, reason: `${date} 在 K 线里出现两次` };
    seen.add(date);
    const volume = typeof r.volume === "number" && Number.isFinite(r.volume) && r.volume >= 0 ? r.volume : null;
    bars.push({ date, open: nums[0] as number, high: nums[1] as number, low: nums[2] as number, close: nums[3] as number, volume });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, bars };
}

function isThrottle(text: string): boolean {
  return /429|限流|频繁|超时|timeout|ECONN|ENOTFOUND|连不上/i.test(text);
}

export async function refreshQuotes(ctx: ServiceContext, deps: { now: Date; signal: AbortSignal; fetch?: FetchLike; limit?: number; only?: string }): Promise<{ updated: string[]; stopped: string | null }> {
  const flag = limitWatchEnabled();
  if (!flag.enabled) return { updated: [], stopped: flag.reason };
  const clock = clockOf(deps.now);
  const pool = readPool(ctx);
  const limit = deps.limit ?? MANUAL_REFRESH_MAX;
  const symbols = deps.only ? [deps.only] : refreshPlan(pool.entries, pool.quotes, clock.day, deps.now.getTime(), limit);
  const fetch = deps.fetch ?? fetchEndpoint;
  const updated: string[] = [];
  let stopped: string | null = null;
  let cursor = 0;
  const worker = async () => {
    while (cursor < symbols.length && !stopped) {
      const symbol = symbols[cursor++]!;
      const blocked = unsupportedKline(symbol);
      if (blocked) {
        await updatePool(ctx, (p) => rememberQuote(p, { symbol, adjust: "qfq", fetched_at: deps.now.toISOString(), bars: [], gap: blocked }));
        continue;
      }
      try {
        const r = await fetch(ctx, { endpoint: "tx_kline", symbol, args: { period: "day", adjust: "qfq", count: KLINE_COUNT }, consistency: { mode: "fresh" }, signal: deps.signal, session: "limit-watch", timeout_ms: 20_000 });
        const evs = (r.envelope as { evidence?: { raw_ref?: unknown }[] }).evidence;
        const ref = (Array.isArray(evs) ? evs : []).map((e) => (typeof e?.raw_ref === "string" ? e.raw_ref : "")).find(Boolean) ?? "";
        const doc = r.out_dir && ref ? readRawDoc(ctx, r.out_dir, ref) : null;
        const parsed = barsFromEnvelope(r.envelope, doc);
        if (!parsed.ok && isThrottle(parsed.reason)) { stopped = parsed.reason; continue; }
        const quote: QuoteCache = parsed.ok
          ? { symbol, adjust: "qfq", fetched_at: r.fetched_at ?? deps.now.toISOString(), bars: parsed.bars, gap: null }
          : { symbol, adjust: "qfq", fetched_at: deps.now.getTime() ? (r.fetched_at ?? deps.now.toISOString()) : deps.now.toISOString(), bars: pool.quotes.find((q) => q.symbol === symbol)?.bars ?? [], gap: `${deps.now.toISOString().slice(0, 16)} ${parsed.reason}` };
        if (!parsed.ok) {
          const prev = pool.quotes.find((q) => q.symbol === symbol);
          quote.bars = prev?.bars ?? [];
          quote.adjust = prev?.adjust ?? "qfq";
        }
        await updatePool(ctx, (p) => rememberQuote(p, quote));
        updated.push(symbol);
      } catch (e) {
        if (deps.signal.aborted) throw e;
        const msg = e instanceof Error ? e.message.slice(0, 120) : "没取到";
        if (isThrottle(msg)) { stopped = msg; continue; }
        await updatePool(ctx, (p) => {
          const prev = p.quotes.find((q) => q.symbol === symbol);
          rememberQuote(p, { symbol, adjust: prev?.adjust ?? "qfq", fetched_at: deps.now.toISOString(), bars: prev?.bars ?? [], gap: `${deps.now.toISOString().slice(0, 16)} ${msg}` });
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(QUOTE_CONCURRENCY, symbols.length) }, () => worker()));
  return { updated, stopped };
}
