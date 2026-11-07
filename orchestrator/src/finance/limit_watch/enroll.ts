/**
 * 把某一个已经收盘的交易日的完整涨停池写入观察池。
 * 读页面不调用这里。空池、行情日对不上、没收盘，都不写股票。
 */
import { fetchEndpoint, type ServiceContext } from "../../service.ts";
import { readRawDoc } from "../candidates.ts";
import { failedNote } from "../schedule.ts";
import { sealTime } from "../review_tiers.ts";
import { clockOf } from "../shortline/intraday.ts";
import { SETTLED_HM, limitWatchEnabled } from "./config.ts";
import { mergeEntries, rememberRun, updatePool } from "./store.ts";
import type { PoolStock } from "./types.ts";

export interface FetchLike {
  (ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown>; consistency?: { mode: "fresh" }; signal?: AbortSignal; session?: string; timeout_ms?: number }): Promise<{ envelope: Record<string, unknown>; out_dir?: string; fetched_at?: string }>;
}

export function acceptPool(doc: unknown, date: string): { ok: true; stocks: PoolStock[]; qdate: string } | { ok: false; reason: string } {
  const data = doc && typeof doc === "object" && "data" in doc ? (doc as { data?: unknown }).data : null;
  if (!data || typeof data !== "object") return { ok: false, reason: "涨停池原始数据不是东财的 data 对象" };
  const qdate = String((data as { qdate?: unknown }).qdate ?? "");
  const want = date.replace(/-/g, "");
  if (!/^\d{8}$/.test(qdate) || qdate !== want) return { ok: false, reason: `涨停池行情日是 ${qdate || "空"}，不是 ${want}，不把别的日子写进来` };
  const pool = (data as { pool?: unknown }).pool;
  if (!Array.isArray(pool)) return { ok: false, reason: "涨停池不是列表，不能当成完整名单" };
  if (!pool.length) return { ok: false, reason: "涨停池是空的。空响应不当成当日完整的 0 只，也不入池" };
  const stocks: PoolStock[] = [];
  const seen = new Set<string>();
  for (const row of pool) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const symbol = typeof r.c === "string" && /^\d{6}$/.test(r.c) ? r.c : "";
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const boards = typeof r.lbc === "number" && Number.isInteger(r.lbc) && r.lbc >= 1 ? r.lbc : null;
    stocks.push({
      symbol, name: typeof r.n === "string" ? r.n.replace(/\s/g, "") : symbol,
      industry: typeof r.hybk === "string" && r.hybk.trim() ? r.hybk.trim() : "未分类",
      boards, first_seal: sealTime(r.fbt),
    });
  }
  if (!stocks.length) return { ok: false, reason: "涨停池里没有可用的 6 位代码，不入池" };
  return { ok: true, stocks, qdate: `${qdate.slice(0, 4)}-${qdate.slice(4, 6)}-${qdate.slice(6)}` };
}

export function enrollGate(date: string, today: string, hm: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "日期格式不对";
  if (date > today) return "还没到的日期不入池";
  if (date === today && hm < SETTLED_HM) return `还没到 ${SETTLED_HM}，当天涨停池没收盘，不入池`;
  return null;
}

export async function enrollDay(ctx: ServiceContext, date: string, deps: { now: Date; signal: AbortSignal; fetch?: FetchLike }): Promise<{ outcome: "enrolled" | "skipped" | "incomplete"; added: number; total: number | null; message: string }> {
  const flag = limitWatchEnabled();
  const now = deps.now;
  const clock = clockOf(now);
  if (!flag.enabled) return { outcome: "skipped", added: 0, total: null, message: flag.reason ?? "已关闭" };
  const gate = enrollGate(date, clock.day, clock.hm);
  if (gate) {
    await updatePool(ctx, (pool) => { pool.runs.push({ date, at: now.toISOString(), outcome: "skipped", added: 0, total: null, reason: gate }); pool.runs = pool.runs.slice(-200); });
    return { outcome: "skipped", added: 0, total: null, message: gate };
  }
  const fetch = deps.fetch ?? fetchEndpoint;
  let doc: unknown = null;
  let status = "";
  let note = "";
  try {
    const r = await fetch(ctx, { endpoint: "em_zt_pool", args: { date: date.replace(/-/g, "") }, consistency: { mode: "fresh" }, signal: deps.signal, session: "limit-watch", timeout_ms: 20_000 });
    status = String((r.envelope as { status?: unknown }).status ?? "");
    note = failedNote(r.envelope);
    const evs = (r.envelope as { evidence?: { raw_ref?: unknown }[] }).evidence;
    const ref = (Array.isArray(evs) ? evs : []).map((e) => (typeof e?.raw_ref === "string" ? e.raw_ref : "")).find(Boolean) ?? "";
    doc = r.out_dir && ref ? readRawDoc(ctx, r.out_dir, ref) : null;
  } catch (e) {
    if (deps.signal.aborted) throw e;
    note = e instanceof Error ? e.message.slice(0, 120) : "没取到";
    status = "failed";
  }
  if (status === "failed" || status === "partial") {
    const reason = `${date} 的涨停池不完整（${status || "失败"}${note ? `：${note}` : ""}），不入池`;
    await updatePool(ctx, (pool) => { pool.runs.push({ date, at: now.toISOString(), outcome: "incomplete", added: 0, total: null, reason }); pool.runs = pool.runs.slice(-200); });
    return { outcome: "incomplete", added: 0, total: null, message: reason };
  }
  const accepted = acceptPool(doc, date);
  if (!accepted.ok) {
    await updatePool(ctx, (pool) => { pool.runs.push({ date, at: now.toISOString(), outcome: "incomplete", added: 0, total: null, reason: accepted.reason }); pool.runs = pool.runs.slice(-200); });
    return { outcome: "incomplete", added: 0, total: null, message: accepted.reason };
  }
  const saved = await updatePool(ctx, (pool) => {
    const merged = mergeEntries(pool.entries, date, accepted.stocks, accepted.qdate, now.toISOString());
    pool.entries = merged.entries;
    const run = { date, at: now.toISOString(), outcome: "enrolled" as const, added: merged.added, total: accepted.stocks.length, reason: merged.added ? null : "这一天的股票已经在池里，没有新增，也没有删除旧记录" };
    rememberRun(pool, run);
    return merged;
  });
  return { outcome: "enrolled", added: saved.added, total: accepted.stocks.length, message: `${date} 涨停 ${accepted.stocks.length} 只，新写入 ${saved.added} 只` };
}

export async function enrollFromClose(j: { ctx: ServiceContext; day: string; now: Date; signal: AbortSignal }, fetch?: FetchLike): Promise<string> {
  const clock = clockOf(j.now);
  if (j.day !== clock.day) return `观察池拒绝把任务日 ${j.day} 写成 ${clock.day}`;
  const result = await enrollDay(j.ctx, j.day, { now: j.now, signal: j.signal, fetch });
  return `涨停观察池：${result.message}`;
}
