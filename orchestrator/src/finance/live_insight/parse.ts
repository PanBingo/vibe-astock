/** 把取数信封整理成快照字段。不联网。对不上的数字留 null。 */
import { num } from "./analyze.ts";
import type { BoardPoint, BreadthSnap, FlowSeries, IndexQuote, LeaderConcepts, LimitUpPoint, LiveCounts } from "./types.ts";

interface Ev { field?: string; value?: unknown; record_key?: string; note?: string; period?: string; raw_ref?: string }

export function evidenceOf(env: unknown): Ev[] {
  if (!env || typeof env !== "object") return [];
  const list = (env as { evidence?: unknown }).evidence;
  return Array.isArray(list) ? list.filter((x): x is Ev => !!x && typeof x === "object") : [];
}

export function envelopeGaps(env: unknown, label: string): string[] {
  if (!env || typeof env !== "object") return [`${label}没有返回`];
  const e = env as { status?: string; degraded?: unknown; missing?: unknown; errors?: unknown; reason?: unknown };
  const gaps: string[] = [];
  if (e.status === "failed") gaps.push(`${label}没取到${textOf(e.reason) || textOf(e.degraded) || errorText(e.errors) || ""}`.trim());
  else if (typeof e.degraded === "string" && e.degraded) gaps.push(`${label}：${e.degraded}`);
  const missing = Array.isArray(e.missing) ? e.missing : [];
  for (const m of missing) {
    if (typeof m === "string" && m) gaps.push(`${label}：${m}`);
    else if (m && typeof m === "object" && typeof (m as { reason?: unknown }).reason === "string") gaps.push(`${label}：${(m as { reason: string }).reason}`);
  }
  if (e.status !== "failed" && Array.isArray(e.errors) && e.errors.length) {
    const t = errorText(e.errors);
    if (t) gaps.push(`${label}：${t}`);
  }
  return gaps;
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function errorText(errors: unknown): string {
  if (!Array.isArray(errors)) return "";
  const first = errors.find((x) => x && typeof x === "object") as { source?: unknown; error?: unknown; message?: unknown } | undefined;
  if (!first) return "";
  const msg = textOf(first.error) || textOf(first.message);
  const kind = /429|too many|频繁|限流/i.test(msg) ? "限流"
    : /time[sd]?\s?out|超时|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|connect/i.test(msg) ? "网络或超时" : msg.slice(0, 80);
  return [textOf(first.source), kind].filter(Boolean).join(" ");
}

export function isTransportGap(text: string): boolean {
  return /限流|网络或超时|超时|连不上|ECONN|ENOTFOUND|429/.test(text);
}

function rankOf(note: string | undefined): number | null {
  const m = /排名\s*(\d+)/.exec(note ?? "");
  return m ? Number(m[1]) : null;
}

function nameOf(note: string | undefined, fallback: string): string {
  const raw = (note ?? "").replace(/排名\s*\d+.*/, "").replace(/领涨.*/, "").replace(/新浪口径.*/, "").trim();
  return raw || fallback;
}

function leaderOf(note: string | undefined): string | null {
  const m = /领涨\s*([^\s;%]+)/.exec(note ?? "");
  if (!m || m[1] === "—" || m[1] === "-") return null;
  return m[1];
}

export function boardsFromEnvelope(env: unknown, source: "eastmoney" | "sina", kind: "industry" | "concept"): BoardPoint[] {
  if (!env || typeof env !== "object" || (env as { status?: string }).status === "failed") return [];
  const netF = source === "eastmoney" ? "board_main_net_today" : "board_net_sina";
  const pctF = source === "eastmoney" ? "board_main_pct_today" : "board_net_ratio_sina";
  const chgF = source === "eastmoney" ? "board_change_pct_today" : "board_change_pct_sina";
  const prefix = `${kind}|`;
  const by = new Map<string, BoardPoint>();
  for (const e of evidenceOf(env)) {
    if (!e.record_key?.startsWith(prefix) || !e.field) continue;
    const code = e.record_key.slice(prefix.length);
    if (!code) continue;
    const row = by.get(code) ?? { code, name: nameOf(e.note, code), rank: rankOf(e.note), main_net: null, main_pct: null, change_pct: null, up_count: null, down_count: null, leader: leaderOf(e.note) };
    if (e.field === netF) row.main_net = num(e.value);
    if (e.field === pctF) row.main_pct = num(e.value);
    if (e.field === chgF) row.change_pct = num(e.value);
    if (!row.name) row.name = nameOf(e.note, code);
    by.set(code, row);
  }
  return [...by.values()];
}

export function industryStatsFromEnvelope(env: unknown): Map<string, { up_count: number | null; down_count: number | null; leader: string | null; change_pct: number | null }> {
  const by = new Map<string, { up_count: number | null; down_count: number | null; leader: string | null; change_pct: number | null }>();
  if (!env || typeof env !== "object" || (env as { status?: string }).status === "failed") return by;
  for (const e of evidenceOf(env)) {
    if (!e.record_key || !e.field) continue;
    const row = by.get(e.record_key) ?? { up_count: null, down_count: null, leader: leaderOf(e.note), change_pct: null };
    if (e.field === "industry_board_up_count") row.up_count = num(e.value);
    if (e.field === "industry_board_down_count") row.down_count = num(e.value);
    if (e.field === "industry_board_change_pct") row.change_pct = num(e.value);
    if (!row.leader) row.leader = leaderOf(e.note);
    by.set(e.record_key, row);
  }
  return by;
}

export function applyIndustryStats(rows: BoardPoint[], stats: ReturnType<typeof industryStatsFromEnvelope>): BoardPoint[] {
  return rows.map((r) => {
    const s = stats.get(r.code);
    if (!s) return r;
    return { ...r, up_count: s.up_count, down_count: s.down_count, leader: r.leader ?? s.leader, change_pct: r.change_pct ?? s.change_pct };
  });
}

export function breadthFromEnvelope(env: unknown, fetchedAt: string): BreadthSnap | null {
  if (!env || typeof env !== "object" || (env as { status?: string }).status === "failed") return null;
  const evs = evidenceOf(env);
  const extraDate = (env as { extra?: { date?: unknown } }).extra?.date;
  const period = evs.find((e) => e.field === "market_dist_count")?.period ?? (typeof extraDate === "string" ? extraDate : "");
  const buckets: BreadthSnap["buckets"] = [];
  const exchanges = new Map<string, BreadthSnap["exchanges"][number]>();
  for (const e of evs) {
    if (e.field === "market_dist_count" && e.record_key?.startsWith("dist|")) {
      const key = Number(e.record_key.slice(5));
      const count = num(e.value);
      if (Number.isInteger(key) && count != null) buckets.push({ key, label: e.note || String(key), count });
    }
    if (e.record_key?.startsWith("exchange|")) {
      const market = e.record_key.slice(9);
      const row = exchanges.get(market) ?? { market, label: market, up: null, down: null, flat: null, amount: null };
      if (e.field === "market_up_count") row.up = num(e.value);
      if (e.field === "market_down_count") row.down = num(e.value);
      if (e.field === "market_flat_count") row.flat = num(e.value);
      if (e.field === "market_turnover_amount") row.amount = num(e.value);
      const label = /^(.*)全市场/.exec(e.note ?? "");
      if (label?.[1]) row.label = label[1];
      exchanges.set(market, row);
    }
  }
  if (!buckets.length && !exchanges.size) return null;
  buckets.sort((a, b) => b.key - a.key);
  return { date: /^\d{4}-\d{2}-\d{2}$/.test(period) ? period : "", exchanges: [...exchanges.values()], buckets, fetched_at: fetchedAt };
}

export function limitUpsFromEnvelope(env: unknown): { rows: LimitUpPoint[]; poolDate: string | null } {
  if (!env || typeof env !== "object" || (env as { status?: string }).status === "failed") return { rows: [], poolDate: null };
  const by = new Map<string, LimitUpPoint>();
  let poolDate: string | null = null;
  for (const e of evidenceOf(env)) {
    if (!e.record_key || !/^\d{6}$/.test(e.record_key) || !e.field?.startsWith("pool_")) continue;
    if (e.period && /^\d{4}-\d{2}-\d{2}$/.test(e.period)) poolDate = e.period;
    const row = by.get(e.record_key) ?? { ...emptyLimit(e.record_key), ...parseLimitNote(e.note, e.record_key) };
    if (e.field === "pool_change_pct") row.pct = num(e.value);
    if (e.field === "pool_limit_days") row.limit_days = num(e.value);
    if (e.field === "pool_seal_fund") row.seal_fund = num(e.value);
    if (e.field === "pool_amount") row.amount = num(e.value);
    const parsed = parseLimitNote(e.note, e.record_key);
    if (parsed.name) row.name = parsed.name;
    if (parsed.industry) row.industry = parsed.industry;
    if (parsed.first_seal) row.first_seal = parsed.first_seal;
    by.set(e.record_key, row);
  }
  const extraDate = (env as { extra?: { date?: unknown } }).extra?.date;
  if (!poolDate && typeof extraDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(extraDate)) poolDate = extraDate;
  return { rows: [...by.values()], poolDate };
}

function emptyLimit(code: string): LimitUpPoint {
  return { code, name: code, industry: "", limit_days: null, first_seal: "", seal_fund: null, pct: null, amount: null };
}

export function parseLimitNote(note: string | undefined, code: string): { name: string; industry: string; first_seal: string } {
  const seal = /首封\s*(\d{2}:\d{2}(?::\d{2})?)/.exec(note ?? "");
  const rest = (note ?? "").replace(code, " ").replace(/首封.*/, " ").replace(/\d+天\d+板/g, " ").replace(/\s+/g, " ").trim();
  const parts = rest.split(" ").filter(Boolean);
  return { name: parts[0] ?? code, industry: parts.slice(1).join(""), first_seal: seal?.[1] ?? "" };
}

export interface TurnoverRow { code: string; name: string; pct: number | null; amount: number | null }

export function turnoverFromEnvelope(env: unknown): TurnoverRow[] {
  if (!env || typeof env !== "object" || (env as { status?: string }).status === "failed") return [];
  const by = new Map<string, TurnoverRow>();
  for (const e of evidenceOf(env)) {
    const code = e.record_key?.startsWith("stock|") ? e.record_key.slice(6) : "";
    if (!/^\d{6}$/.test(code) || !e.field) continue;
    const named = /^(.+?)\((\d{6})\)/.exec(e.note ?? "");
    const row = by.get(code) ?? { code, name: named?.[1] ?? code, pct: null, amount: null };
    if (e.field === "change_pct") row.pct = num(e.value);
    if (e.field === "turnover_amount") row.amount = num(e.value);
    if (named?.[1]) row.name = named[1];
    by.set(code, row);
  }
  return [...by.values()].sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
}

export function indexesFromEnvelope(env: unknown, day: string, names: Record<string, string>): IndexQuote[] {
  if (!env || typeof env !== "object" || (env as { status?: string }).status === "failed") return [];
  const by = new Map<string, IndexQuote>();
  for (const code of Object.keys(names)) by.set(code, { code, name: names[code]!, price: null, change_pct: null, quote_time: null, today: false });
  for (const e of evidenceOf(env)) {
    const code = e.record_key && by.has(e.record_key) ? e.record_key : null;
    if (!code || !e.field) continue;
    const row = by.get(code)!;
    if (e.field === "price") row.price = num(e.value);
    if (e.field === "change_pct") row.change_pct = num(e.value);
    if (e.field === "quote_time" && typeof e.value === "string") row.quote_time = e.value;
    if (e.field === "security_name" && typeof e.value === "string" && e.value) row.name = e.value;
  }
  const compact = day.replace(/-/g, "");
  for (const row of by.values()) row.today = !!row.quote_time && (row.quote_time.startsWith(compact) || row.quote_time.startsWith(day));
  return [...by.values()];
}

export function liveFromEnvelope(env: unknown, day: string): { live: LiveCounts | null; reason: string | null } {
  const gaps = envelopeGaps(env, "盘中情绪");
  const result = (env as { extra?: { result?: unknown } } | null)?.extra?.result;
  if (!result || typeof result !== "object") return { live: null, reason: gaps[0] ?? "盘中情绪没有结果" };
  const r = result as { date?: unknown; as_of?: unknown; phase?: unknown; live?: Record<string, unknown> };
  if (r.date !== day) return { live: null, reason: `盘中情绪的日期是 ${String(r.date ?? "缺失")}，不是采集日 ${day}，不用它充当天。` };
  const live = r.live ?? {};
  return {
    live: {
      as_of: typeof r.as_of === "string" ? r.as_of : null,
      phase: typeof r.phase === "string" ? r.phase : null,
      limit_up: num(live.limit_up), broken: num(live.broken), limit_down: num(live.limit_down),
      highest_board: num(live.highest_board), seal_rate: num(live.seal_rate), broken_rate: num(live.broken_rate),
    },
    reason: gaps.filter((g) => !g.includes("没取到")).join("；") || null,
  };
}

export function conceptsFromEnvelope(env: unknown, code: string, name: string, fetchedAt: string): LeaderConcepts {
  const gaps = envelopeGaps(env, `${name} 的概念归属`);
  if (!env || typeof env !== "object" || (env as { status?: string }).status === "failed") {
    return { code, name, concepts: [], fetched_at: fetchedAt, reason: gaps[0] ?? "概念归属没取到" };
  }
  const concepts: string[] = [];
  for (const e of evidenceOf(env)) {
    if (e.field === "board_membership" && typeof e.value === "string" && e.value) concepts.push(e.value);
  }
  return { code, name, concepts, fetched_at: fetchedAt, reason: concepts.length ? null : (gaps[0] ?? "概念归属是空的") };
}

export function seriesFromRawJson(raw: unknown): { time: string; main_net: number }[] {
  const lines = findKlines(raw, 0);
  if (!lines) return [];
  const out: { time: string; main_net: number }[] = [];
  for (const line of lines) {
    const parts = line.split(",");
    const main = num(parts[1]);
    if (parts[0] && main != null) out.push({ time: parts[0], main_net: main });
  }
  return out;
}

function findKlines(v: unknown, depth: number): string[] | null {
  if (depth > 6 || !v || typeof v !== "object") return null;
  if (!Array.isArray(v) && Array.isArray((v as { klines?: unknown }).klines)) {
    const lines = (v as { klines: unknown[] }).klines;
    if (lines.every((x) => typeof x === "string")) return lines as string[];
  }
  const values = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
  for (const item of values) {
    const hit = findKlines(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function flowFromParts(code: string, name: string, changePct: number | null, fetchedAt: string, series: { time: string; main_net: number }[], lastTime: string | null, lastNet: number | null): FlowSeries {
  if (series.length >= 2) return { code, name, change_pct: changePct, points: series, fetched_at: fetchedAt, kind: "minute_series" };
  if (lastNet == null) return { code, name, change_pct: changePct, points: [], fetched_at: fetchedAt, kind: "snapshot_only" };
  return { code, name, change_pct: changePct, points: [{ time: lastTime || fetchedAt, main_net: lastNet }], fetched_at: fetchedAt, kind: "snapshot_only" };
}
