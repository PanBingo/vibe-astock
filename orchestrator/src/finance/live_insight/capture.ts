/**
 * 盘中采集。只在连续竞价和收盘后的短窗口联网；休市、午休、开盘前直接跳过。
 * 读接口不写盘。同一数据目录同时只有一轮采集。
 */
import fs from "node:fs";
import path from "node:path";

import { fetchEndpoint, type ServiceContext } from "../../service.ts";
import { calendarFromEnvelope } from "../session.ts";
import { PHASE_LABELS, phaseOf, type Phase } from "../shortline/watch.ts";
import { clockOf } from "../shortline/intraday.ts";
import { num } from "./analyze.ts";
import {
  BOARD_TOP_N, CAPTURE_MIN_MS, CLOSE_GRACE_END, FLOW_ABS_PCT_MAX, FLOW_ABS_PCT_MIN, FLOW_CANDIDATES, INSIGHT_SOURCE, LEADER_CONCEPTS, liveInsightEnabled,
} from "./config.ts";
import {
  applyIndustryStats, boardsFromEnvelope, breadthFromEnvelope, conceptsFromEnvelope, envelopeGaps, errorText, evidenceOf,
  flowFromParts, indexesFromEnvelope, industryStatsFromEnvelope, isTransportGap, limitUpsFromEnvelope, liveFromEnvelope,
  seriesFromRawJson, turnoverFromEnvelope,
} from "./parse.ts";
import { appendSnapshot, readSnapshots, writeAttempt } from "./store.ts";
import { SNAPSHOT_SCHEMA, type CaptureSnapshot, type InsightAttempt } from "./types.ts";

const INDEXES: Record<string, string> = { sh000001: "上证指数", sz399001: "深证成指", sz399006: "创业板指" };
const EAST_CALIBER = "东财主力净额（元，今日累计）。不是新浪流入减流出，也不能当成机构席位净买。";
const SINA_CALIBER = "新浪口径：流入减流出（元）。板块分类和东财不同，不能与东财主力净额比大小或接成趋势。";

export interface FetchLike {
  (ctx: ServiceContext, req: {
    endpoint: string; symbol?: string; args?: Record<string, unknown>; session?: string; timeout_ms?: number;
    consistency?: { mode: "fresh" | "prefer_cache" | "cache_only"; max_age_ms?: number }; signal?: AbortSignal;
  }): Promise<{ envelope: Record<string, unknown>; fetched_at?: string; out_dir?: string }>;
}

export interface CaptureDeps {
  now?: Date;
  fetch?: FetchLike;
  signal?: AbortSignal;
  force?: boolean;
}

export interface CaptureResult {
  outcome: InsightAttempt["outcome"];
  reason: string | null;
  gaps: string[];
  snapshot: CaptureSnapshot | null;
  shared: boolean;
}

const flights = new Map<string, Promise<CaptureResult>>();
const calendarCache = new Map<string, { at: number; value: boolean | null }>();

export function resetLiveInsightFlight(): void { flights.clear(); calendarCache.clear(); }

export function shouldCapture(input: { phase: Phase; tradingDay: boolean | null; hm: string; lastClock: string | null; lastAtMs: number | null; nowMs: number; force: boolean }): { ok: boolean; outcome: "skipped" | "throttled"; reason: string } | { ok: true } {
  if (input.tradingDay === false || input.phase === "weekend") return { ok: false, outcome: "skipped", reason: "今天不是交易日（或是周末）。不采集，也不用上一交易日的收盘池冒充实时。" };
  if (input.tradingDay == null) return { ok: false, outcome: "skipped", reason: "交易日历没取到，不猜测今天开市，本次不采集。" };
  if (input.phase === "lunch") return { ok: false, outcome: "skipped", reason: "午间休市。不把上午的累计值再采一次当成下午的新变化。" };
  if (input.phase === "pre_open" || input.phase === "auction") return { ok: false, outcome: "skipped", reason: "还没进入连续竞价，板块资金和涨停池还不能代表盘中。" };
  if (input.phase === "closing_auction") return { ok: false, outcome: "skipped", reason: "收盘集合竞价中，等 15:00 之后再存收盘累计。" };
  const closeSnap = input.lastClock != null && input.lastClock >= "15:00";
  if (input.phase === "closed") {
    if (closeSnap) return { ok: false, outcome: "skipped", reason: "收盘累计已经存过，不再重复联网。" };
    if (input.hm > CLOSE_GRACE_END && !input.force) return { ok: false, outcome: "skipped", reason: `已过 ${CLOSE_GRACE_END}，自动采集停止。手动刷新可以补存一张，并标明是收盘累计而不是盘中路径。` };
    if (input.hm > CLOSE_GRACE_END && input.force) return { ok: true };
    return { ok: true };
  }
  if (input.phase !== "morning" && input.phase !== "afternoon") return { ok: false, outcome: "skipped", reason: `${PHASE_LABELS[input.phase]}不采集。` };
  if (!input.force && input.lastAtMs != null && input.nowMs - input.lastAtMs < CAPTURE_MIN_MS) {
    return { ok: false, outcome: "throttled", reason: `距离上一张不足 ${CAPTURE_MIN_MS / 1000} 秒，这次不重复采集。` };
  }
  return { ok: true };
}

export async function captureLiveInsight(ctx: ServiceContext, deps: CaptureDeps = {}): Promise<CaptureResult> {
  const key = path.resolve(ctx.dataRoot);
  const existing = flights.get(key);
  if (existing) {
    const shared = await existing;
    return { ...shared, shared: true };
  }
  const job = runCapture(ctx, deps).finally(() => { if (flights.get(key) === job) flights.delete(key); });
  flights.set(key, job);
  return job;
}

async function runCapture(ctx: ServiceContext, deps: CaptureDeps): Promise<CaptureResult> {
  const now = deps.now ?? new Date();
  const signal = deps.signal ?? new AbortController().signal;
  const fetch = deps.fetch ?? fetchEndpoint;
  const clock = clockOf(now);
  const phase = phaseOf(now);
  const flag = liveInsightEnabled();
  if (!flag.enabled) return finish(ctx, clock.day, phase, "disabled", flag.reason, [], null, now);
  // 周末、午休、竞价不查日历、不取行情。法定假日若正落在这些钟点，文案按钟点写；
  // 连续竞价和收盘窗口会先查日历，假日不会把上一交易日的池子取回来。
  const quiet = phase === "weekend" || phase === "lunch" || phase === "pre_open" || phase === "auction" || phase === "closing_auction";
  const tradingDay = quiet ? phase !== "weekend" : await tradingDayOf(ctx, clock.day, fetch, signal, now.getTime());
  const last = readSnapshots(ctx, clock.day).snapshots.at(-1) ?? null;
  const decision = shouldCapture({
    phase, tradingDay, hm: clock.hm, lastClock: last?.clock ?? null, lastAtMs: last ? Date.parse(last.captured_at) : null, nowMs: now.getTime(), force: deps.force === true,
  });
  if (!decision.ok) return finish(ctx, clock.day, phase, decision.outcome, decision.reason, [], null, now);
  try {
    const snapshot = await collect(ctx, fetch, signal, clock, phase, now);
    if (!snapshot) return finish(ctx, clock.day, phase, "failed", "板块、涨跌分布、涨停池和指数都没取到，不写入空快照。", ["核心读数全部缺失"], null, now);
    appendSnapshot(ctx, snapshot);
    return finish(ctx, clock.day, phase, "saved", snapshot.gaps.length ? "已存，但有缺项" : null, snapshot.gaps, snapshot, now);
  } catch (e) {
    if (signal.aborted) throw e;
    const reason = e instanceof Error ? e.message.slice(0, 160) : "采集失败";
    return finish(ctx, clock.day, phase, "failed", reason, [reason], null, now);
  }
}

function finish(ctx: ServiceContext, date: string, phase: Phase, outcome: InsightAttempt["outcome"], reason: string | null, gaps: string[], snapshot: CaptureSnapshot | null, now: Date): CaptureResult {
  const attempt: InsightAttempt = { at: now.toISOString(), date, phase, outcome, reason, gaps };
  try { writeAttempt(ctx, attempt); } catch { /* 数据目录写不了时，调用方仍能看到 outcome */ }
  return { outcome, reason, gaps, snapshot, shared: false };
}

async function tradingDayOf(ctx: ServiceContext, day: string, fetch: FetchLike, signal: AbortSignal, nowMs: number): Promise<boolean | null> {
  const key = `${path.resolve(ctx.dataRoot)}\u0000${day}`;
  const hit = calendarCache.get(key);
  if (hit && nowMs - hit.at < (hit.value == null ? 60_000 : 30 * 60_000)) return hit.value;
  let value: boolean | null = null;
  try {
    const r = await fetch(ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", consistency: { mode: "fresh" }, signal, session: "live-insight", timeout_ms: 12_000 });
    const env = r.envelope as { evidence?: { field?: string; value?: unknown; period?: string }[]; status?: string };
    const period = (env.evidence ?? []).find((e) => e.field === "is_today_trading_day")?.period;
    if (env.status !== "failed" && period === day) value = calendarFromEnvelope(env)?.is_today_trading_day ?? null;
  } catch (e) {
    if (signal.aborted) throw e;
    value = null;
  }
  calendarCache.set(key, { at: nowMs, value });
  return value;
}

async function collect(ctx: ServiceContext, fetch: FetchLike, signal: AbortSignal, clock: { day: string; hm: string; hms: string }, phase: Phase, now: Date): Promise<CaptureSnapshot | null> {
  const gaps: string[] = [];
  const got = await gather(ctx, fetch, signal, [
    { id: "breadth", endpoint: "em_market_breadth" },
    { id: "industry", endpoint: "em_board_fund_flow", args: { board_type: "industry", period: "today", top_n: BOARD_TOP_N } },
    { id: "concept", endpoint: "em_board_fund_flow", args: { board_type: "concept", period: "today", top_n: BOARD_TOP_N } },
    { id: "industry_stats", endpoint: "em_industry_comparison", args: { top_n: BOARD_TOP_N } },
    { id: "zt", endpoint: "em_zt_pool", args: { date: clock.day.replace(/-/g, "") } },
    { id: "turnover", endpoint: "em_turnover_rank", args: { top_n: 40 } },
    { id: "indexes", endpoint: "tx_quotes_batch", args: { codes: Object.keys(INDEXES) } },
    { id: "live", endpoint: "cn_shortline_live" },
  ]);
  for (const [id, row] of Object.entries(got)) if (row.gaps.length) gaps.push(...row.gaps.map((g) => `${id}: ${g}`));

  let industry = boardsFromEnvelope(got.industry?.env, "eastmoney", "industry");
  let concept = boardsFromEnvelope(got.concept?.env, "eastmoney", "concept");
  let boardSource: CaptureSnapshot["board_source"] = industry.length || concept.length ? "eastmoney" : "none";
  let caliber = boardSource === "eastmoney" ? EAST_CALIBER : "";
  if (!industry.length && !concept.length) {
    const sina = await gather(ctx, fetch, signal, [
      { id: "sina_industry", endpoint: "sina_board_flow", args: { board_type: "industry" } },
      { id: "sina_concept", endpoint: "sina_board_flow", args: { board_type: "concept" } },
    ]);
    for (const row of Object.values(sina)) gaps.push(...row.gaps);
    industry = boardsFromEnvelope(sina.sina_industry?.env, "sina", "industry");
    concept = boardsFromEnvelope(sina.sina_concept?.env, "sina", "concept");
    if (industry.length || concept.length) {
      boardSource = "sina";
      caliber = SINA_CALIBER;
      gaps.push("东财板块资金没取到，这一张改用新浪。它不能和之前的东财快照比净额。");
    }
  }
  industry = applyIndustryStats(industry, industryStatsFromEnvelope(got.industry_stats?.env));
  const breadth = breadthFromEnvelope(got.breadth?.env, got.breadth?.fetched_at ?? now.toISOString());
  if (breadth && breadth.date && breadth.date !== clock.day) gaps.push(`涨跌分布的上游日期是 ${breadth.date}，不是采集日 ${clock.day}，不能当成今天的实时分布。`);
  const zt = limitUpsFromEnvelope(got.zt?.env);
  if (zt.poolDate && zt.poolDate !== clock.day) gaps.push(`涨停池日期是 ${zt.poolDate}，不是采集日 ${clock.day}，扩散分析不用这张池。`);
  const indexes = indexesFromEnvelope(got.indexes?.env, clock.day, INDEXES);
  if (indexes.some((x) => x.quote_time && !x.today)) gaps.push("有指数的行情时间不是采集日，页面会标非今日。");
  const live = liveFromEnvelope(got.live?.env, clock.day);
  const flows = await loadFlows(ctx, fetch, signal, turnoverFromEnvelope(got.turnover?.env), new Set(zt.rows.map((r) => r.code)), gaps);
  const leaders = pickLeaders(zt.poolDate === clock.day ? zt.rows : []);
  const leaderConcepts = [];
  for (const leader of leaders.slice(0, LEADER_CONCEPTS)) {
    const row = await one(ctx, fetch, signal, { endpoint: "em_concept_blocks", symbol: leader.code });
    if (row.gaps.length) gaps.push(...row.gaps);
    leaderConcepts.push(conceptsFromEnvelope(row.env, leader.code, leader.name, row.fetched_at ?? now.toISOString()));
  }
  const useful = industry.length || concept.length || (zt.poolDate === clock.day && zt.rows.length) || breadth || indexes.some((x) => x.price != null);
  if (!useful) return null;
  return {
    schema: SNAPSHOT_SCHEMA, date: clock.day, captured_at: now.toISOString(), clock: clock.hms, phase, trading_day: true,
    board_source: boardSource, board_caliber: caliber || "这一张没有板块资金。", industry, concept,
    breadth, indexes, limit_ups: zt.poolDate === clock.day ? zt.rows : [], limit_up_date: zt.poolDate,
    flows, leader_concepts: leaderConcepts, live: live.live, live_reason: live.reason, gaps,
  };
}

interface Job { id: string; endpoint: string; symbol?: string; args?: Record<string, unknown> }
type Call = Omit<Job, "id">;
interface Got { env: Record<string, unknown> | null; fetched_at?: string; out_dir?: string; gaps: string[] }

async function gather(ctx: ServiceContext, fetch: FetchLike, signal: AbortSignal, jobs: Job[]): Promise<Record<string, Got>> {
  const out: Record<string, Got> = {};
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]!;
      out[job.id] = await one(ctx, fetch, signal, job);
    }
  }));
  return out;
}

async function one(ctx: ServiceContext, fetch: FetchLike, signal: AbortSignal, job: Call): Promise<Got> {
  try {
    const r = await fetch(ctx, { endpoint: job.endpoint, symbol: job.symbol, args: job.args, consistency: { mode: "fresh" }, signal, session: "live-insight", timeout_ms: 12_000 });
    const gaps = envelopeGaps(r.envelope, job.endpoint);
    return { env: r.envelope, fetched_at: r.fetched_at, out_dir: r.out_dir, gaps };
  } catch (e) {
    if (signal.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const kind = isTransportGap(msg) || /429|超时|timeout|ECONN|ENOTFOUND/i.test(msg) ? ( /429|限流|频繁/.test(msg) ? "限流" : "网络或超时" ) : msg.slice(0, 120);
    return { env: null, gaps: [`${job.endpoint} ${kind}`] };
  }
}

async function loadFlows(ctx: ServiceContext, fetch: FetchLike, signal: AbortSignal, turnover: ReturnType<typeof turnoverFromEnvelope>, limitUp: Set<string>, gaps: string[]): Promise<CaptureSnapshot["flows"]> {
  const candidates = turnover.filter((r) => r.pct != null && Math.abs(r.pct) >= FLOW_ABS_PCT_MIN && Math.abs(r.pct) <= FLOW_ABS_PCT_MAX && !limitUp.has(r.code)).slice(0, FLOW_CANDIDATES);
  if (turnover.length && candidates.length < 3) gaps.push(`成交额榜里涨跌幅在 ${FLOW_ABS_PCT_MIN}%–${FLOW_ABS_PCT_MAX}% 且未涨停的只有 ${candidates.length} 只，分钟资金样本偏少。`);
  if (!candidates.length) {
    if (!turnover.length) gaps.push("成交额榜没取到，本次不做个股分钟资金。");
    return [];
  }
  const flows: CaptureSnapshot["flows"] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const row = candidates[cursor++]!;
      const got = await one(ctx, fetch, signal, { endpoint: "em_fund_flow_minute", symbol: row.code });
      if (got.gaps.length) gaps.push(...got.gaps);
      const ev = evidenceOf(got.env).find((e) => e.field === "main_net_inflow_intraday_cum");
      const series = readSeries(got.out_dir, ev?.raw_ref);
      const extra = (got.env as { extra?: { last_time?: unknown } } | null)?.extra;
      const lastTime = typeof extra?.last_time === "string" ? extra.last_time : null;
      const flow = flowFromParts(row.code, row.name, row.pct, got.fetched_at ?? "", series, lastTime, num(ev?.value));
      if (flow.points.length) flows.push(flow);
      else if (!got.gaps.length) gaps.push(`${row.code} 没有分钟资金（非交易时段、ETF 或不覆盖）。`);
    }
  }));
  return flows;
}

function readSeries(outDir: string | undefined, ref: string | undefined): { time: string; main_net: number }[] {
  if (!outDir || !ref || ref.includes("..") || path.isAbsolute(ref)) return [];
  const root = path.resolve(outDir);
  const abs = path.resolve(root, ref);
  if (abs !== root && !abs.startsWith(root + path.sep)) return [];
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 2_000_000) return [];
    return seriesFromRawJson(JSON.parse(fs.readFileSync(abs, "utf8")));
  } catch {
    return [];
  }
}

function pickLeaders(rows: CaptureSnapshot["limit_ups"]): { code: string; name: string }[] {
  const by = new Map<string, CaptureSnapshot["limit_ups"]>();
  for (const r of rows) {
    if (!r.industry) continue;
    const g = by.get(r.industry) ?? [];
    g.push(r);
    by.set(r.industry, g);
  }
  return [...by.values()].sort((a, b) => b.length - a.length).map((g) => {
    const leader = [...g].sort((a, b) => (b.limit_days ?? -1) - (a.limit_days ?? -1) || (a.first_seal || "99").localeCompare(b.first_seal || "99"))[0]!;
    return { code: leader.code, name: leader.name };
  });
}

export async function liveInsightBeat(b: { ctx: ServiceContext; now: Date; signal: AbortSignal }): Promise<string | void> {
  if (!liveInsightEnabled().enabled) return;
  const r = await captureLiveInsight(b.ctx, { now: b.now, signal: b.signal, force: false });
  if (r.outcome === "saved") return `实时洞察已采集 ${r.snapshot?.clock ?? ""}（${r.snapshot?.board_source ?? "无板块"}）`;
  if (r.outcome === "failed") return `实时洞察没采成：${r.reason ?? "失败"}`;
}

export { INSIGHT_SOURCE, errorText };
