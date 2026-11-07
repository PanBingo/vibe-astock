/**
 * 实时洞察的纯计算。只吃已经落盘的快照，不取数。
 * 疑似建仓是主力净额累计形态的统计推断，不是机构席位或股东持仓。
 */
import { FLOW_ABS_PCT_MAX } from "./config.ts";
import type {
  Accumulation, Anomaly, BoardPoint, BoardView, CaptureSnapshot, Diffusion, FlowSeries, Hotspot, LiveInsightView, Reliability,
} from "./types.ts";

export const MIN_BOARD_DELTA_YUAN = 1.5e8;
export const MIN_RANK_JUMP = 12;
export const MIN_RANK_DELTA_YUAN = 5e7;
export const MIN_COMPARE_MIN = 2;
export const MAX_COMPARE_MIN = 40;
export const STALE_SNAPSHOT_MIN = 8;
export const FLOW_MIN_MINUTE_POINTS = 20;
export const FLOW_MIN_SAMPLES = 3;
export const FLOW_MIN_SPAN_MIN = 15;
export const FLOW_MAX_STEP_SHARE = 0.6;
export const FLOW_MIN_UP_FRACTION = 0.55;
export const FLOW_STALE_MIN = 15;
export const DIFFUSION_BREADTH_DELTA = 2;
export const DIFFUSION_MAX_GAP_MIN = 25;

export const ACCUMULATION_DISCLAIMER = "统计推断：用公开的东财主力净额当日累计看形态，不是龙虎榜机构席位，也不是十大股东或基金持仓。";

export const LIMITATIONS = [
  "板块资金是供应商公布的净额排序快照。东财「主力净额」和新浪「流入减流出」分类不同，不能接成一条曲线，也不能互相替代。",
  "只保留净额居前的一批板块。掉出名单没有后续点，不当成净额归零。",
  "个股分钟资金是当日累计，盘中会改；ETF 往往没有。样本不够、最后一点过旧、或处在午休，都不标疑似建仓。",
  "疑似建仓只描述「涨跌幅还不大、净额累计逐步抬升」这一种统计形态，不能据此推断谁在买、更不是买卖建议。",
  "热点扩散只看东财涨停池里的同行业只数变化，以及龙头在东财概念归属里对得上的概念板块。空池按缺失处理，不写成 0 家涨停。",
  "时间变化来自本机按间隔存下的快照。程序没开、休市、午休或取数失败的时段不会补造。",
  "延迟取决于上游当次响应和本机采集间隔（连续竞价约 2 分钟一张）。行情时间、采集时间和上游日期不一致时标成陈旧或非今日。",
];

const LUNCH_START = 11 * 60 + 30;
const LUNCH_END = 13 * 60;

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && v.trim() !== "-" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function yuanText(v: number | null): string {
  if (v == null) return "缺失";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v / 1e8).toFixed(2)}亿元`;
}

export function pctText(v: number | null): string {
  if (v == null) return "缺失";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function parseHm(hm: string): number | null {
  const m = /^(\d{2}):(\d{2})/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function crossedLunch(a: string, b: string): boolean {
  const x = parseHm(a), y = parseHm(b);
  if (x == null || y == null) return false;
  const lo = Math.min(x, y), hi = Math.max(x, y);
  return lo < LUNCH_START && hi >= LUNCH_END;
}

function gapMin(a: string, b: string): number | null {
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms)) return null;
  return ms / 60_000;
}

export function pickBaseline(snaps: CaptureSnapshot[], latest: CaptureSnapshot): { prev: CaptureSnapshot | null; note: string | null } {
  const prior = snaps.filter((s) => s.captured_at < latest.captured_at && s.date === latest.date);
  if (!prior.length) return { prev: null, note: "还没有上一张快照，只展示当前这一张，不标资金异动。" };
  for (const prev of [...prior].reverse()) {
    if (prev.board_source !== latest.board_source || latest.board_source === "none" || prev.board_source === "none") {
      return { prev: null, note: "相邻快照的资金口径不一致或没有板块资金，不能把净额接成趋势。" };
    }
    const gap = gapMin(prev.captured_at, latest.captured_at);
    if (gap == null || gap < 0) continue;
    if (crossedLunch(prev.clock, latest.clock)) return { prev: null, note: "最近两张快照跨过午休，净额差不作为盘中异动。" };
    if (gap < MIN_COMPARE_MIN) continue;
    if (gap > MAX_COMPARE_MIN) return { prev: null, note: `最近一张可对照的快照距今约 ${Math.round(gap)} 分钟，超过 ${MAX_COMPARE_MIN} 分钟，不标成盘中异动。` };
    return { prev, note: null };
  }
  return { prev: null, note: "没有落在 2–40 分钟窗口内的同口径对照，不标资金异动。" };
}

function historyOf(snaps: CaptureSnapshot[], latest: CaptureSnapshot, kind: "industry" | "concept", code: string) {
  return snaps.filter((s) => s.date === latest.date && s.board_source === latest.board_source && s.board_source !== "none").map((s) => {
    const row = (kind === "industry" ? s.industry : s.concept).find((r) => r.code === code);
    return { clock: s.clock.slice(0, 5), main_net: row?.main_net ?? null };
  }).slice(-8);
}

export function boardViews(snaps: CaptureSnapshot[], latest: CaptureSnapshot, kind: "industry" | "concept", prev: CaptureSnapshot | null): BoardView[] {
  const rows = kind === "industry" ? latest.industry : latest.concept;
  const prevRows = new Map((prev ? (kind === "industry" ? prev.industry : prev.concept) : []).map((r) => [r.code, r]));
  const ranked = [...rows].filter((r) => r.code);
  const inflow = [...ranked].sort((a, b) => (b.main_net ?? -Infinity) - (a.main_net ?? -Infinity)).slice(0, 12);
  const outflow = [...ranked].sort((a, b) => (a.main_net ?? Infinity) - (b.main_net ?? Infinity)).slice(0, 8);
  const picked: BoardPoint[] = [];
  const seen = new Set<string>();
  for (const r of [...inflow, ...outflow]) if (!seen.has(r.code)) { seen.add(r.code); picked.push(r); }
  return picked.map((r) => {
    const p = prevRows.get(r.code);
    const delta = r.main_net != null && p?.main_net != null ? r.main_net - p.main_net : null;
    const deltaPct = r.change_pct != null && p?.change_pct != null ? r.change_pct - p.change_pct : null;
    return {
      code: r.code, name: r.name, rank: r.rank, main_net: r.main_net, change_pct: r.change_pct, main_pct: r.main_pct,
      up_count: r.up_count, down_count: r.down_count, leader: r.leader,
      delta_net: delta, delta_pct: deltaPct, baseline_clock: delta == null ? null : prev!.clock.slice(0, 5),
      history: historyOf(snaps, latest, kind, r.code),
    };
  });
}

function relationOf(deltaNet: number, deltaPct: number | null): string {
  if (deltaPct == null) return "有净额变化，板块涨跌幅缺失，不判断是否同向。";
  if (Math.abs(deltaPct) < 0.05 && Math.abs(deltaNet) >= MIN_BOARD_DELTA_YUAN) return "净额变化大，板块涨跌幅几乎没动。";
  const same = (deltaNet > 0 && deltaPct > 0) || (deltaNet < 0 && deltaPct < 0);
  if (same) return deltaNet > 0 ? "主力净额上升，板块涨跌幅也上升。" : "主力净额下降，板块涨跌幅也下降。";
  if (deltaNet > 0 && deltaPct < 0) return "主力净额上升，板块涨跌幅下降。";
  return "主力净额下降，板块涨跌幅上升。";
}

function anomalyReliability(gap: number, pctKnown: boolean): Reliability {
  if (!pctKnown) return "low";
  if (gap >= 5 && gap <= 20) return "high";
  return "medium";
}

export function findAnomalies(latest: CaptureSnapshot, prev: CaptureSnapshot | null): Anomaly[] {
  if (!prev || prev.board_source !== latest.board_source) return [];
  const gap = gapMin(prev.captured_at, latest.captured_at) ?? 0;
  const out: Anomaly[] = [];
  for (const kind of ["industry", "concept"] as const) {
    const now = new Map((kind === "industry" ? latest.industry : latest.concept).map((r) => [r.code, r]));
    const before = kind === "industry" ? prev.industry : prev.concept;
    for (const p of before) {
      const n = now.get(p.code);
      if (!n || n.main_net == null || p.main_net == null) continue;
      const delta = n.main_net - p.main_net;
      const rankJump = n.rank != null && p.rank != null ? Math.abs(n.rank - p.rank) : 0;
      const hit = Math.abs(delta) >= MIN_BOARD_DELTA_YUAN || (rankJump >= MIN_RANK_JUMP && Math.abs(delta) >= MIN_RANK_DELTA_YUAN);
      if (!hit) continue;
      const deltaPct = n.change_pct != null && p.change_pct != null ? n.change_pct - p.change_pct : null;
      const relation = relationOf(delta, deltaPct);
      out.push({
        kind, code: n.code, name: n.name || p.name, baseline_clock: prev.clock.slice(0, 5), latest_clock: latest.clock.slice(0, 5),
        main_net: n.main_net, baseline_net: p.main_net, delta_net: delta, change_pct: n.change_pct, baseline_pct: p.change_pct,
        relation, reliability: anomalyReliability(gap, n.change_pct != null && p.change_pct != null),
        explanation: `${kind === "industry" ? "行业" : "概念"}「${n.name || n.code}」${latest.board_caliber}从 ${yuanText(p.main_net)}（${prev.clock.slice(0, 5)}）到 ${yuanText(n.main_net)}（${latest.clock.slice(0, 5)}），变化 ${yuanText(delta)}。涨跌幅 ${pctText(p.change_pct)} → ${pctText(n.change_pct)}。${relation}这是两张快照的差，不是买卖建议。`,
      });
    }
  }
  out.sort((a, b) => Math.abs(b.delta_net) - Math.abs(a.delta_net));
  return out.slice(0, 12);
}

interface TimedNet { hm: number; clock: string; main_net: number }

function inSession(hm: number): boolean {
  return (hm >= 9 * 60 + 30 && hm < LUNCH_START) || (hm >= LUNCH_END && hm <= 15 * 60);
}

export function clockIn(text: string): string | null {
  const m = /(\d{2}):(\d{2})(?::\d{2})?/.exec(text);
  return m ? `${m[1]}:${m[2]}` : null;
}

export function sessionPoints(points: { time: string; main_net: number }[]): TimedNet[] {
  const out: TimedNet[] = [];
  for (const p of points) {
    const clock = clockIn(p.time);
    const hm = clock ? parseHm(clock) : null;
    if (hm == null || !inSession(hm) || !Number.isFinite(p.main_net)) continue;
    out.push({ hm, clock: p.time, main_net: p.main_net });
  }
  out.sort((a, b) => a.hm - b.hm || a.clock.localeCompare(b.clock));
  const dedup: TimedNet[] = [];
  for (const p of out) if (dedup[dedup.length - 1]?.hm !== p.hm) dedup.push(p);
  return dedup;
}

function spanMin(points: TimedNet[]): number {
  if (points.length < 2) return 0;
  let span = points[points.length - 1]!.hm - points[0]!.hm;
  if (points.some((p) => p.hm < LUNCH_START) && points.some((p) => p.hm >= LUNCH_END)) span -= 90;
  return Math.max(0, span);
}

function shapeOf(points: TimedNet[]): { upFraction: number; stepShare: number; total: number } | null {
  if (points.length < 2) return null;
  let up = 0, maxJump = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i]!.main_net - points[i - 1]!.main_net;
    if (d > 0) up += 1;
    if (d > maxJump) maxJump = d;
  }
  const total = points[points.length - 1]!.main_net - points[0]!.main_net;
  return { upFraction: up / (points.length - 1), stepShare: total > 0 ? maxJump / total : Infinity, total };
}

const NONE_DISC = ACCUMULATION_DISCLAIMER;

function flowBase(code: string, name: string, method: Accumulation["method"], points: number, span: number | null, main: number | null, pct: number | null, up: number | null, share: number | null, status: Accumulation["status"], reliability: Reliability | null, statement: string): Accumulation {
  return { code, name, status, reliability, method, points, span_min: span, main_net: main, change_pct: pct, up_fraction: up, step_share: Number.isFinite(share ?? NaN) ? share : null, statement, disclaimer: NONE_DISC };
}

export function judgeFlow(input: {
  code: string; name: string; change_pct: number | null; method: "minute_series" | "capture_samples";
  points: { time: string; main_net: number }[];
  phase: string; hm: string; archive: boolean;
}): Accumulation {
  const pts = sessionPoints(input.points);
  const span = spanMin(pts);
  const last = pts[pts.length - 1];
  const shape = shapeOf(pts);
  const method = input.method;
  const need = method === "minute_series" ? FLOW_MIN_MINUTE_POINTS : FLOW_MIN_SAMPLES;
  if (!input.archive && input.phase === "lunch") {
    return flowBase(input.code, input.name, method, pts.length, span, last?.main_net ?? null, input.change_pct, shape?.upFraction ?? null, shape?.stepShare ?? null, "lunch", null,
      "午间休市。分钟资金停在上午，不把缺少的下午点当成净额回落，也不在午休标疑似建仓。");
  }
  if (!input.archive && (input.phase === "morning" || input.phase === "afternoon") && last) {
    const now = parseHm(input.hm);
    if (now != null && now - last.hm > FLOW_STALE_MIN) {
      return flowBase(input.code, input.name, method, pts.length, span, last.main_net, input.change_pct, shape?.upFraction ?? null, shape?.stepShare ?? null, "stale", null,
        `最后一点是 ${last.clock}，比当前 ${input.hm.slice(0, 5)} 早了超过 ${FLOW_STALE_MIN} 分钟，序列陈旧，不推断。`);
    }
  }
  if (pts.length < need || span < FLOW_MIN_SPAN_MIN || !shape) {
    return flowBase(input.code, input.name, method, pts.length, span, last?.main_net ?? null, input.change_pct, shape?.upFraction ?? null, shape?.stepShare ?? null, "insufficient", null,
      `样本不足：连续竞价内 ${pts.length} 个点、跨度 ${span} 分钟。${method === "minute_series" ? `分钟序列至少要 ${FLOW_MIN_MINUTE_POINTS} 个点` : `采集样本至少要 ${FLOW_MIN_SAMPLES} 个点`}，且跨度不少于 ${FLOW_MIN_SPAN_MIN} 分钟。`);
  }
  if (input.change_pct == null) {
    return flowBase(input.code, input.name, method, pts.length, span, last!.main_net, null, shape.upFraction, shape.stepShare, "insufficient", null,
      "没有同一只股票的当日涨跌幅，不能排除价格已经大幅走出来，所以不标疑似建仓。");
  }
  if (Math.abs(input.change_pct) > FLOW_ABS_PCT_MAX) {
    return flowBase(input.code, input.name, method, pts.length, span, last!.main_net, input.change_pct, shape.upFraction, shape.stepShare, "not_indicated", null,
      `当日涨跌幅 ${pctText(input.change_pct)}，绝对值超过 ${FLOW_ABS_PCT_MAX}%。净额抬升更像价格已经走出之后的成交，不按低波动净流入形态记录。`);
  }
  if (!(shape.total > 0) || !(last!.main_net > 0)) {
    return flowBase(input.code, input.name, method, pts.length, span, last!.main_net, input.change_pct, shape.upFraction, shape.stepShare, "not_indicated", null,
      `区间净额变化 ${yuanText(shape.total)}，最后一点 ${yuanText(last!.main_net)}。没有形成「累计净额为正且继续抬升」。`);
  }
  if (shape.stepShare >= FLOW_MAX_STEP_SHARE) {
    return flowBase(input.code, input.name, method, pts.length, span, last!.main_net, input.change_pct, shape.upFraction, shape.stepShare, "not_indicated", null,
      `单步最大跃升占区间抬升的 ${(shape.stepShare * 100).toFixed(0)}%，超过 ${FLOW_MAX_STEP_SHARE * 100}%。更像一笔冲击，不是逐步抬升。`);
  }
  if (shape.upFraction < FLOW_MIN_UP_FRACTION) {
    return flowBase(input.code, input.name, method, pts.length, span, last!.main_net, input.change_pct, shape.upFraction, shape.stepShare, "not_indicated", null,
      `净额上升的步数只占 ${(shape.upFraction * 100).toFixed(0)}%，低于 ${FLOW_MIN_UP_FRACTION * 100}%，持续性不够。`);
  }
  let reliability: Reliability = method === "capture_samples" ? "low"
    : pts.length >= 60 && shape.upFraction >= 0.7 && shape.stepShare < 0.35 && Math.abs(input.change_pct) <= 2 ? "high"
      : "medium";
  if (method === "capture_samples") reliability = "low";
  const when = input.archive || input.phase === "closed" ? `截至 ${last!.clock} 的统计形态` : `截至 ${last!.clock}`;
  return flowBase(input.code, input.name, method, pts.length, span, last!.main_net, input.change_pct, shape.upFraction, shape.stepShare, "suspected", reliability,
    `${when}：${input.name}（${input.code}）东财主力净额累计从 ${yuanText(pts[0]!.main_net)} 抬到 ${yuanText(last!.main_net)}（${pts.length} 个点，跨度 ${span} 分钟，上升步数 ${(shape.upFraction * 100).toFixed(0)}%）。当日涨跌幅 ${pctText(input.change_pct)}。这只说明公开净额在涨跌幅还不大时逐步变大。`);
}

export function accumulationClues(snaps: CaptureSnapshot[], phase: string, hm: string, archive: boolean): Accumulation[] {
  const latest = snaps[snaps.length - 1];
  if (!latest) return [];
  const by = new Map<string, { name: string; pct: number | null; stitched: { time: string; main_net: number }[]; series: FlowSeries | null }>();
  for (const s of snaps) {
    for (const f of s.flows) {
      const row = by.get(f.code) ?? { name: f.name, pct: f.change_pct, stitched: [], series: null };
      row.name = f.name || row.name;
      if (f.change_pct != null) row.pct = f.change_pct;
      if (f.kind === "minute_series" && f.points.length >= 2) row.series = f;
      else if (f.points[0] && Number.isFinite(f.points[0].main_net)) row.stitched.push({ time: `${s.date} ${s.clock}`, main_net: f.points[f.points.length - 1]!.main_net });
      by.set(f.code, row);
    }
  }
  const out: Accumulation[] = [];
  for (const [code, row] of by) {
    if (row.series) out.push(judgeFlow({ code, name: row.name, change_pct: row.pct, method: "minute_series", points: row.series.points, phase, hm, archive }));
    else out.push(judgeFlow({ code, name: row.name, change_pct: row.pct, method: "capture_samples", points: row.stitched, phase, hm, archive }));
  }
  const rank = { suspected: 0, stale: 1, lunch: 2, insufficient: 3, not_indicated: 4 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || a.code.localeCompare(b.code));
  return out.slice(0, 12);
}

interface Group { industry: string; rows: CaptureSnapshot["limit_ups"] }

function groupsOf(snap: CaptureSnapshot): { groups: Group[]; blank: number } | null {
  if (snap.limit_up_date !== snap.date) return null;
  const map = new Map<string, CaptureSnapshot["limit_ups"]>();
  let blank = 0;
  for (const r of snap.limit_ups) {
    if (!r.industry) { blank += 1; continue; }
    const g = map.get(r.industry) ?? [];
    g.push(r);
    map.set(r.industry, g);
  }
  return { groups: [...map.entries()].map(([industry, rows]) => ({ industry, rows })), blank };
}

function leaderOf(rows: CaptureSnapshot["limit_ups"]) {
  return [...rows].sort((a, b) => (b.limit_days ?? -1) - (a.limit_days ?? -1) || (a.first_seal || "99:99:99").localeCompare(b.first_seal || "99:99:99") || a.code.localeCompare(b.code))[0]!;
}

function persistenceOf(valid: CaptureSnapshot[], industry: string): number {
  let n = 0;
  let prev: CaptureSnapshot | null = null;
  for (const s of [...valid].reverse()) {
    const rows = s.limit_ups.filter((r) => r.industry === industry);
    if (rows.length < 2) break;
    if (prev) {
      const gap = gapMin(s.captured_at, prev.captured_at);
      if (gap == null || gap > DIFFUSION_MAX_GAP_MIN || crossedLunch(s.clock, prev.clock)) break;
    }
    n += 1;
    prev = s;
  }
  return n;
}

function intensityOf(rows: CaptureSnapshot["limit_ups"]): number | null {
  const known = rows.filter((r) => r.limit_days != null);
  if (!known.length) return null;
  return known.filter((r) => (r.limit_days ?? 0) >= 2).length / rows.length;
}

export function hotspotBoards(snaps: CaptureSnapshot[]): { hotspots: Hotspot[]; note: string | null } {
  const latest = [...snaps].reverse().find((s) => s.limit_up_date === s.date && s.limit_ups.length);
  if (!latest) {
    const bad = [...snaps].reverse().find((s) => s.limit_up_date && s.limit_up_date !== s.date);
    if (bad) return { hotspots: [], note: `涨停池日期是 ${bad.limit_up_date}，采集日是 ${bad.date}，不用这张池做热点。` };
    return { hotspots: [], note: snaps.length ? "还没有可用的涨停池快照。空池不会写成 0 家。" : null };
  }
  const grouped = groupsOf(latest);
  if (!grouped) return { hotspots: [], note: null };
  const valid = snaps.filter((s) => s.limit_up_date === s.date);
  const hotspots = grouped.groups.map((g) => {
    const leader = leaderOf(g.rows);
    const persistence = persistenceOf(valid, g.industry);
    const names = [...g.rows].sort((a, b) => (b.limit_days ?? -1) - (a.limit_days ?? -1)).slice(0, 8).map((r) => ({ code: r.code, name: r.name, limit_days: r.limit_days }));
    return {
      industry: g.industry, breadth: g.rows.length, leader_code: leader.code, leader_name: leader.name,
      leader_boards: leader.limit_days, leader_seal: leader.first_seal, intensity: intensityOf(g.rows), persistence,
      names, names_more: Math.max(0, g.rows.length - names.length),
      note: valid.length < 2 ? "只有一张涨停池快照，下面是当前结构，还不能判断扩散。" : `最近连续 ${persistence} 张快照里该行业涨停不少于 2 只。`,
    };
  }).sort((a, b) => b.breadth - a.breadth || (b.leader_boards ?? -1) - (a.leader_boards ?? -1)).slice(0, 8);
  const note = grouped.blank ? `有 ${grouped.blank} 只涨停没有行业，不参与扩散。` : (valid.length < 2 ? "只有一张涨停池快照，先列出行业结构，不把它们叫扩散。" : null);
  return { hotspots, note };
}

export function diffusionSignals(snaps: CaptureSnapshot[]): { signals: Diffusion[]; note: string | null } {
  const valid = snaps.filter((s) => s.limit_up_date === s.date && s.limit_ups.length);
  if (valid.length < 2) return { signals: [], note: valid.length === 1 ? "扩散需要至少两张同一交易日的涨停池快照。" : null };
  const latest = valid[valid.length - 1]!;
  let prev: CaptureSnapshot | null = null;
  for (const s of valid.slice(0, -1).reverse()) {
    const gap = gapMin(s.captured_at, latest.captured_at);
    if (gap == null || gap < MIN_COMPARE_MIN) continue;
    if (crossedLunch(s.clock, latest.clock)) return { signals: [], note: "最近的涨停池快照跨过午休，这段间隔不判断扩散。" };
    if (gap > DIFFUSION_MAX_GAP_MIN) return { signals: [], note: `两张涨停池快照相隔约 ${Math.round(gap)} 分钟，超过 ${DIFFUSION_MAX_GAP_MIN} 分钟，不判断扩散。` };
    prev = s;
    break;
  }
  if (!prev) return { signals: [], note: "没有足够近的上一张涨停池快照。" };
  const prevGroups = new Map((groupsOf(prev)?.groups ?? []).map((g) => [g.industry, g]));
  const nowGroups = groupsOf(latest)?.groups ?? [];
  const conceptNow = new Map(latest.concept.map((r) => [r.name, r]));
  const conceptPrev = new Map(prev.concept.map((r) => [r.name, r]));
  const signals: Diffusion[] = [];
  for (const g of nowGroups) {
    const before = prevGroups.get(g.industry);
    if (!before || before.rows.length < 1) continue;
    const prevLeader = leaderOf(before.rows);
    if (!g.rows.some((r) => r.code === prevLeader.code)) continue;
    const breadthNow = g.rows.length, breadthPrev = before.rows.length;
    if (breadthNow - breadthPrev < DIFFUSION_BREADTH_DELTA) continue;
    const prevCodes = new Set(before.rows.map((r) => r.code));
    const fresh = g.rows.filter((r) => !prevCodes.has(r.code));
    if (fresh.length < DIFFUSION_BREADTH_DELTA) continue;
    const tags = latest.leader_concepts.find((c) => c.code === prevLeader.code);
    const concepts = (tags?.concepts ?? []).map((name) => {
      const n = conceptNow.get(name), p = conceptPrev.get(name);
      return { name, change_pct: n?.change_pct ?? null, main_net: n?.main_net ?? null, delta_net: n?.main_net != null && p?.main_net != null ? n.main_net - p.main_net : null };
    }).filter((c) => conceptNow.has(c.name) || conceptPrev.has(c.name)).slice(0, 5);
    const gap = gapMin(prev.captured_at, latest.captured_at) ?? 0;
    const follow = concepts.some((c) => (c.change_pct ?? 0) > 0 && (c.delta_net == null || c.delta_net > 0));
    let reliability: Reliability = "low";
    if (concepts.length && follow && gap <= 15) reliability = "medium";
    const persist = persistenceOf(valid, g.industry);
    if (reliability === "medium" && persist >= 3) reliability = "high";
    const evidence = [
      `${prev.clock.slice(0, 5)} 龙头 ${prevLeader.name}（${prevLeader.code}，${prevLeader.limit_days ?? "?"} 板，首封 ${prevLeader.first_seal || "缺失"}）仍在 ${latest.clock.slice(0, 5)} 的「${g.industry}」涨停里。`,
      `同行业涨停从 ${breadthPrev} 只到 ${breadthNow} 只，新出现 ${fresh.slice(0, 6).map((r) => `${r.name}(${r.code})`).join("、")}。`,
      concepts.length
        ? `龙头概念归属对得上的概念板块：${concepts.map((c) => `${c.name} 涨跌 ${pctText(c.change_pct)} 净额 ${yuanText(c.main_net)}`).join("；")}。`
        : `没有取到 ${prevLeader.name} 的概念归属${tags?.reason ? `（${tags.reason}）` : ""}，相关概念不判断，可靠性因此降低。`,
      "扩散指涨停家数从已有龙头的行业里变多，不是预测还会继续扩散。",
    ];
    signals.push({
      industry: g.industry, leader_code: prevLeader.code, leader_name: prevLeader.name,
      breadth_prev: breadthPrev, breadth_now: breadthNow, new_names: fresh.slice(0, 8).map((r) => ({ code: r.code, name: r.name })),
      baseline_clock: prev.clock.slice(0, 5), latest_clock: latest.clock.slice(0, 5), concepts, reliability, evidence,
    });
  }
  signals.sort((a, b) => (b.breadth_now - b.breadth_prev) - (a.breadth_now - a.breadth_prev));
  return { signals: signals.slice(0, 8), note: signals.length ? null : "这两张快照里没有「原龙头还在、同行业至少多 2 只」的扩散。" };
}

export function ageMin(capturedAt: string, now: Date): number | null {
  const ms = now.getTime() - Date.parse(capturedAt);
  if (!Number.isFinite(ms)) return null;
  return ms / 60_000;
}

export function freshnessOf(latest: CaptureSnapshot | null, phase: string, archive: boolean, now: Date): { stale: boolean; text: string } {
  if (archive) return { stale: false, text: "这是所选日期的采集记录，不是当前实时行情。" };
  if (phase === "weekend") return { stale: false, text: "周末休市，没有实时行情。不会用上一交易日的收盘池充数。" };
  if (!latest) return { stale: false, text: "今天还没有采集。连续竞价时程序开着会大约每 2 分钟存一张；没开就不会补。" };
  if (phase === "lunch") return { stale: false, text: `午间休市。最近一张是 ${latest.clock.slice(0, 5)}，13:00 后再采集。不会把上午的数说成下午的实时。` };
  if (phase === "pre_open" || phase === "auction") return { stale: false, text: "还没到连续竞价，不采集，也不用上一交易日的池子充当天。" };
  if (phase === "closing_auction") return { stale: false, text: "收盘集合竞价。15:00 后若还没有收盘那张，会再存一张累计值。" };
  if (phase === "closed") return { stale: false, text: `已收盘。最近一张是 ${latest.clock.slice(0, 5)} 的采集，不是正在变动的盘中，也不是复盘端点。` };
  const age = ageMin(latest.captured_at, now);
  if (age != null && age > STALE_SNAPSHOT_MIN) return { stale: true, text: `最近一张是 ${latest.clock.slice(0, 5)}，距现在约 ${Math.round(age)} 分钟，已经超过 ${STALE_SNAPSHOT_MIN} 分钟，当作陈旧。` };
  return { stale: false, text: `最近采集 ${latest.clock.slice(0, 5)}，连续竞价约每 ${CAPTURE_EVERY} 分钟一张。数字在收盘前还会变。` };
}

const CAPTURE_EVERY = 2;

export function boardSide(view: Pick<LiveInsightView, "industry" | "concept">, kind: "industry" | "concept"): BoardView[] {
  return kind === "industry" ? view.industry : view.concept;
}
