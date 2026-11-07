/**
 * 观察池的自动联合。只读已经落盘的实时洞察和盘中快照，不取数、不写盘。
 * 结论是观察优先级，不是买卖建议，也没有验证过的准确率。
 */
import fs from "node:fs";

import { safePath, type ServiceContext } from "../../service.ts";
import { crossedLunch, diffusionSignals, freshnessOf, hotspotBoards, MIN_BOARD_DELTA_YUAN } from "../live_insight/analyze.ts";
import { readAttempt, readSnapshots } from "../live_insight/store.ts";
import type { CaptureSnapshot } from "../live_insight/types.ts";
import { loadDay } from "../shortline/intraday.ts";
import { phaseOf, type Phase } from "../shortline/watch.ts";
import { MIN_BARS } from "./config.ts";
import type { JointAssessment, JointItem, JointLeg, JointStatus, SymbolSummary } from "./types.ts";

export const ADVANCE_SHARE_MIN = 0.55;
export const BROKEN_RATE_MAX = 0.3;
export const BREADTH_MOVE = 2;

export type JointSession = "live" | "lunch" | "closed" | "pre_open" | "holiday";

export const JOINT_LABEL: Record<JointStatus, string> = {
  aligned: "联合条件满足",
  waiting: "等待确认",
  conflict: "风险或证据冲突",
  insufficient: "数据不足",
};

export const JOINT_INVALIDATION = [
  "回踩破位：已收盘 K 线收盘跌破启动板价格带下沿，或出现出货风险倾向，联合满足失效。",
  "板块退潮：同一口径连续快照的净额下降达到 1.5 亿元，或同行业涨停只数比上一张至少少 2 只，联合满足失效。",
  "上面任一失效都不会被其余正向读数抵消。这里没有综合分数，也不报告准确率。",
];

export interface JointEmotion {
  slot: string;
  limit_up: number | null;
  broken: number | null;
  source: string;
}

export interface JointContext {
  as_of: string;
  clock: string;
  session: JointSession;
  snapshot_date: string | null;
  historical: boolean;
  stale: boolean;
  stale_text: string | null;
  snaps: CaptureSnapshot[];
  emotion: JointEmotion | null;
  emotion_note: string | null;
}

const item = (label: string, value: string, at: string, source: string, counter = "", fail = ""): JointItem =>
  ({ label, value, at, source, counter, fail });

export function jointSession(phase: Phase, toldClosed: boolean): JointSession {
  if (phase === "weekend" || toldClosed) return "holiday";
  if (phase === "morning" || phase === "afternoon") return "live";
  if (phase === "lunch") return "lunch";
  if (phase === "closed" || phase === "closing_auction") return "closed";
  return "pre_open";
}

function insightDates(ctx: ServiceContext): string[] {
  let dir = "";
  try { dir = safePath(ctx, "live-insight"); } catch { return []; }
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
}

function readDay(ctx: ServiceContext, date: string): CaptureSnapshot[] {
  try { return readSnapshots(ctx, date).snapshots; } catch { return []; }
}

/** 只读。休市时用不晚于查看日的最近一天；交易日只用查看日当天，不用前一天充今天。 */
export function loadJointContext(ctx: ServiceContext, asOf: string, now = new Date()): JointContext {
  const phase = phaseOf(now);
  const attempt = readAttempt(ctx);
  const toldClosed = attempt?.date === asOf && attempt.outcome === "skipped" && /不是交易日|周末/.test(attempt.reason ?? "");
  const session = jointSession(phase, toldClosed);
  const historical = session === "holiday";
  let snapshotDate: string | null = historical ? null : asOf;
  if (historical) {
    for (const day of insightDates(ctx).filter((d) => d <= asOf).reverse()) {
      if (readDay(ctx, day).length) { snapshotDate = day; break; }
    }
  }
  const snaps = snapshotDate ? readDay(ctx, snapshotDate) : [];
  const latest = snaps.at(-1) ?? null;
  const fresh = !historical && session === "live" ? freshnessOf(latest, phase, false, now) : { stale: false, text: null as string | null };
  let emotion: JointEmotion | null = null;
  let emotionNote: string | null = null;
  if (snapshotDate) {
    try {
      const day = loadDay(ctx.dataRoot, snapshotDate);
      const last = [...day.snapshots].reverse().find((s) => s.live);
      if (last?.live) emotion = { slot: last.slot, limit_up: last.live.limit_up, broken: last.live.broken, source: "盘中情绪快照 cn_shortline_live" };
      else if (day.warnings.length) emotionNote = day.warnings[0] ?? null;
    } catch {
      emotionNote = "同日盘中快照没有读成，这次不拿它核对。";
    }
  }
  return {
    as_of: asOf, clock: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now),
    session, snapshot_date: snaps.length ? snapshotDate : snapshotDate, historical, stale: fresh.stale, stale_text: fresh.stale ? fresh.text : null,
    snaps, emotion, emotion_note: emotionNote,
  };
}

function yuan(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "缺失";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v / 1e8).toFixed(2)}亿元`;
}

function num(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function share(up: number, down: number): number | null {
  const d = up + down;
  return d > 0 ? up / d : null;
}

interface Point { clock: string; net: number | null; pct: number | null; source: string; caliber: string; code: string }
interface SeriesHit { points: Point[]; dropped: boolean; ambiguous: boolean; sources: string[] }

function moneySeries(snaps: CaptureSnapshot[], kind: "industry" | "concept", name: string): SeriesHit {
  const usable = snaps.filter((s) => s.board_source !== "none");
  const sources = [...new Set(usable.map((s) => s.board_source))];
  const latestSource = [...usable].reverse().find((s) => s.board_source !== "none")?.board_source ?? null;
  const same = latestSource ? usable.filter((s) => s.board_source === latestSource) : [];
  const points: Point[] = [];
  const codes = new Set<string>();
  for (const s of same) {
    const rows = (kind === "industry" ? s.industry : s.concept).filter((r) => r.name === name);
    for (const r of rows) codes.add(r.code);
    const row = rows.length === 1 ? rows[0] : undefined;
    if (!row) continue;
    points.push({ clock: s.clock.slice(0, 5), net: row.main_net, pct: row.change_pct, source: s.board_source, caliber: s.board_caliber, code: row.code });
  }
  const latest = same.at(-1);
  const seenBefore = same.slice(0, -1).some((s) => (kind === "industry" ? s.industry : s.concept).some((r) => r.name === name));
  const inLatest = latest ? (kind === "industry" ? latest.industry : latest.concept).some((r) => r.name === name) : false;
  return { points, dropped: seenBefore && !inLatest, ambiguous: codes.size > 1, sources };
}

function pairGapOk(prev: CaptureSnapshot, latest: CaptureSnapshot): boolean {
  const gap = (Date.parse(latest.captured_at) - Date.parse(prev.captured_at)) / 60_000;
  if (!Number.isFinite(gap) || gap < 2 || gap > 25) return false;
  if (crossedLunch(prev.clock, latest.clock)) return false;
  return prev.date === latest.date;
}

function breadthMove(snaps: CaptureSnapshot[], industry: string): { prev: number; now: number; from: string; to: string } | null {
  const valid = snaps.filter((s) => s.limit_up_date === s.date && s.limit_ups.length);
  const latest = valid.at(-1);
  if (!latest) return null;
  const prev = [...valid.slice(0, -1)].reverse().find((s) => pairGapOk(s, latest));
  if (!prev) return null;
  const count = (s: CaptureSnapshot) => s.limit_ups.filter((r) => r.industry === industry).length;
  return { prev: count(prev), now: count(latest), from: prev.clock.slice(0, 5), to: latest.clock.slice(0, 5) };
}

type LegKind = "supportive" | "weak" | "risk" | "ebb" | "previous" | "unconfirmed" | "missing" | "undecided";

function finish(status: JointStatus, note: string, legs: JointLeg[]): JointAssessment {
  return { status, label: JOINT_LABEL[status], session_note: note, legs, invalidation: JOINT_INVALIDATION };
}

export function jointHeadline(ctx: JointContext): string {
  if (ctx.historical) {
    const day = ctx.snapshot_date ?? "没有";
    return `休市。下面是 ${day} 的最近有效截面，不是当前实时，不能标成联合已确认。`;
  }
  if (ctx.session === "live") return `连续竞价。查看日 ${ctx.as_of} ${ctx.clock}。未收盘的当日 K 线和昨日收盘都不能当成今日盘中确认。`;
  if (ctx.session === "lunch") return "午间休市。上午的快照不是下午的实时。";
  if (ctx.session === "closed") return `已收盘。只在查看日 ${ctx.as_of} 的收盘截面上判断，不是盘中正在变动的行情。`;
  return "还没到连续竞价。不用上一交易日的池子充当天。";
}

export function assessJoint(symbol: SymbolSummary, ctx: JointContext): JointAssessment {
  const note = jointHeadline(ctx);
  const at = ctx.snapshot_date ? `${ctx.snapshot_date} ${ctx.snaps.at(-1)?.clock.slice(0, 5) ?? ""}`.trim() : ctx.as_of;
  const market = marketLeg(ctx, at);
  const sector = sectorLeg(symbol, ctx, at);
  const stock = stockLeg(symbol, ctx);
  const legs = [market.leg, sector.leg, stock.leg];
  const crossDay = !!ctx.snapshot_date && ctx.snapshot_date !== ctx.as_of && !ctx.historical;
  if (crossDay || ctx.stale) {
    const why = ctx.stale ? (ctx.stale_text || "实时快照已陈旧。") : `快照日 ${ctx.snapshot_date} 不是查看日 ${ctx.as_of}，不能当成今天。`;
    market.leg.items.push(item("时序", why, at, "实时洞察快照", "", "时序不对齐或陈旧，不能联合已确认。"));
    return finish("insufficient", note, legs);
  }
  if (market.kind === "weak" && (stock.kind === "supportive" || stock.kind === "previous" || stock.kind === "unconfirmed")) {
    return finish("conflict", note, legs);
  }
  if (stock.kind === "risk" || sector.kind === "ebb") return finish("conflict", note, legs);
  if (market.kind === "missing" || sector.kind === "missing" || stock.kind === "missing") return finish("insufficient", note, legs);
  if (ctx.historical || ctx.session !== "closed") return finish("waiting", note, legs);
  if (stock.kind === "previous" || stock.kind === "unconfirmed" || market.kind !== "supportive" || sector.kind !== "supportive" || stock.kind !== "supportive") {
    return finish("waiting", note, legs);
  }
  return finish("aligned", note, legs);
}

function marketLeg(ctx: JointContext, at: string): { leg: JointLeg; kind: LegKind } {
  const latest = ctx.snaps.at(-1) ?? null;
  const items: JointItem[] = [];
  const title = "市场环境";
  if (!latest || !ctx.snapshot_date) {
    items.push(item("涨跌家数 / 涨停炸板", "没有已落盘的实时洞察快照", ctx.as_of, "实时洞察", "", "缺少同日快照，不用过往复盘充今天。"));
    return { leg: { key: "market", title, verdict: "没有快照", items }, kind: "missing" };
  }
  const breadthOk = latest.breadth?.date === latest.date;
  const up = breadthOk ? latest.breadth?.exchanges.reduce((s, e) => s + (num(e.up) ? e.up : 0), 0) ?? null : null;
  const down = breadthOk ? latest.breadth?.exchanges.reduce((s, e) => s + (num(e.down) ? e.down : 0), 0) ?? null : null;
  const upKnown = breadthOk && !!latest.breadth?.exchanges.length && latest.breadth.exchanges.every((e) => num(e.up) && num(e.down));
  const liveOk = !!latest.live && (!latest.live.as_of || latest.live.as_of.startsWith(latest.date));
  const live = liveOk ? latest.live : null;
  if (latest.breadth && !breadthOk) {
    items.push(item("涨跌家数", `上游日期 ${latest.breadth.date} 与快照日 ${latest.date} 不一致`, at, "实时洞察涨跌分布", "", "日期对不上，这组家数不用。"));
  }
  if (latest.live && !liveOk) {
    items.push(item("涨停 / 炸板", `情绪时点 ${latest.live.as_of ?? "缺失"} 不是快照日 ${latest.date}`, at, "实时洞察盘中情绪", "", "时点对不上，不用这组涨停炸板。"));
  }
  const upN = upKnown ? up : null;
  const downN = upKnown ? down : null;
  const upShare = upN != null && downN != null ? share(upN, downN) : null;
  items.push(item(
    "涨跌家数",
    upN == null || downN == null ? "缺失" : `涨 ${upN} / 跌 ${downN}，上涨家数占比 ${(upShare! * 100).toFixed(1)}%`,
    at, "实时洞察涨跌分布", "", upN == null ? "没有与快照同日的涨跌家数。" : "",
  ));
  const brokenRate = live && num(live.broken_rate) ? live.broken_rate
    : live && num(live.limit_up) && num(live.broken) && live.limit_up + live.broken > 0 ? live.broken / (live.limit_up + live.broken) : null;
  items.push(item(
    "涨停 / 炸板",
    !live || !num(live.limit_up) || !num(live.broken) ? "缺失" : `涨停 ${live.limit_up}，炸板 ${live.broken}，炸板占比 ${((brokenRate ?? 0) * 100).toFixed(1)}%`,
    at, latest.live_reason ? `实时洞察（${latest.live_reason}）` : "实时洞察盘中情绪", "",
    !live ? "没有与快照同日的涨停和炸板。" : "",
  ));
  if (ctx.emotion && live && num(live.limit_up) && num(live.broken) && num(ctx.emotion.limit_up) && num(ctx.emotion.broken)
    && (ctx.emotion.limit_up !== live.limit_up || ctx.emotion.broken !== live.broken)) {
    items.push(item(
      "口径核对",
      `实时洞察涨停 ${live.limit_up}、炸板 ${live.broken}；${ctx.emotion.slot} 盘中快照涨停 ${ctx.emotion.limit_up}、炸板 ${ctx.emotion.broken}`,
      at, ctx.emotion.source, "两处家数不一致。", "不把两套家数合成一个数，市场环境视为不足。",
    ));
    return { leg: { key: "market", title, verdict: "两处家数不一致", items }, kind: "missing" };
  }
  if (ctx.emotion && live && num(ctx.emotion.limit_up) && num(ctx.emotion.broken)) {
    items.push(item("口径核对", `${ctx.emotion.slot} 的盘中快照与实时洞察涨停、炸板一致`, at, ctx.emotion.source));
  } else if (ctx.emotion_note) {
    items.push(item("盘中快照", ctx.emotion_note, at, "shortline/intraday", "", "没有拿它代替实时洞察。"));
  } else {
    items.push(item("情绪复盘", "打开本页不读取、不重算情绪复盘。没有同日已落盘的复盘包就不借用别日。", ctx.as_of, "不请求 cn_shortline_emotion"));
  }
  if (upN == null || downN == null || !live || !num(live.limit_up) || !num(live.broken) || brokenRate == null || live.limit_up <= 0) {
    return { leg: { key: "market", title, verdict: "关键家数缺失", items }, kind: "missing" };
  }
  const weak = (upShare ?? 0) <= 0.5 || brokenRate >= BROKEN_RATE_MAX;
  const supportive = (upShare ?? 0) >= ADVANCE_SHARE_MIN && brokenRate < BROKEN_RATE_MAX;
  if (weak) {
    items.push(item("判读", `上涨家数占比不超过 50%，或炸板占比达到 ${(BROKEN_RATE_MAX * 100).toFixed(0)}%。市场偏弱。个股强不能把这项抵消。`, at, "观察阈值，不是准确率"));
    return { leg: { key: "market", title, verdict: "市场偏弱", items }, kind: "weak" };
  }
  if (!supportive) {
    items.push(item("判读", `上涨家数占比要达到 ${(ADVANCE_SHARE_MIN * 100).toFixed(0)}% 且炸板占比低于 ${(BROKEN_RATE_MAX * 100).toFixed(0)}% 才算环境配合。当前停在中间。`, at, "观察阈值，不是准确率"));
    return { leg: { key: "market", title, verdict: "环境未配合", items }, kind: "undecided" };
  }
  items.push(item("判读", "涨多跌少，炸板占比低于阈值。这只说明市场环境这项配合，不是上涨预测。", at, "观察阈值，不是准确率"));
  return { leg: { key: "market", title, verdict: "环境配合", items }, kind: "supportive" };
}

function sectorLeg(symbol: SymbolSummary, ctx: JointContext, at: string): { leg: JointLeg; kind: LegKind } {
  const title = "板块持续性";
  const items: JointItem[] = [];
  const industry = symbol.industry.trim();
  if (!industry || industry === "未分类") {
    items.push(item("行业归属", "入池时没有行业，或是未分类", at, "东财涨停池 hybk", "", "不能按股票名字猜板块。"));
    return { leg: { key: "sector", title, verdict: "没有行业归属", items }, kind: "missing" };
  }
  if (ctx.snaps.length < 2) {
    items.push(item("快照窗口", ctx.snaps.length ? "只有一张快照" : "没有快照", at, "实时洞察", "", "单张排名或单张净额不能叫持续。"));
    return { leg: { key: "sector", title, verdict: "快照不足", items }, kind: "missing" };
  }
  const industryHit = moneySeries(ctx.snaps, "industry", industry);
  if (industryHit.sources.length > 1) {
    items.push(item("资金口径", industryHit.sources.join("、"), at, "实时洞察板块资金", "", "东财主力净额和新浪流入减流出不能接成一条曲线。"));
    return { leg: { key: "sector", title, verdict: "口径不一致", items }, kind: "missing" };
  }
  if (industryHit.ambiguous) {
    items.push(item("行业板块", `「${industry}」对应多条代码`, at, "实时洞察行业板块", "", "同名不止一条，不选其中一条。"));
    return { leg: { key: "sector", title, verdict: "归属冲突", items }, kind: "missing" };
  }
  const concepts = conceptNames(ctx.snaps, symbol.symbol);
  const move = breadthMove(ctx.snaps, industry);
  const spread = diffusionSignals(ctx.snaps).signals.find((s) => s.industry === industry) ?? null;
  const hot = hotspotBoards(ctx.snaps).hotspots.find((h) => h.industry === industry) ?? null;
  const seen = industryHit.points.length > 0 || concepts.names.length > 0 || !!hot || !!spread || (!!move && (move.prev > 0 || move.now > 0));
  if (!seen) {
    items.push(item("板块映射", `行业「${industry}」对不上资金板块名称，也没有这只代码的概念归属`, at, "涨停池行业字段 / 龙头概念归属", "", "缺失就不按名字去猜。"));
    return { leg: { key: "sector", title, verdict: "映射缺失", items }, kind: "missing" };
  }
  if (industryHit.dropped) {
    items.push(item("行业资金", `「${industry}」曾出现，最新一张同口径快照里没有`, at, industryHit.points[0]?.caliber || "板块资金", "", "掉出前列不当成净额归零或流出。"));
    return { leg: { key: "sector", title, verdict: "后续点缺失", items }, kind: "missing" };
  }
  const nets = industryHit.points.filter((p) => num(p.net));
  const first = nets[0];
  const last = nets.at(-1);
  const delta = first && last && first !== last && num(first.net) && num(last.net) ? last.net - first.net : null;
  if (industryHit.points.length) {
    items.push(item(
      "行业资金",
      delta == null ? `「${industry}」有名称，连续净额不足两点` : `${first!.clock} ${yuan(first!.net)} → ${last!.clock} ${yuan(last!.net)}，变化 ${yuan(delta)}`,
      at, first?.caliber || "板块资金", "",
      delta == null ? "没有两点同口径净额，不叫持续。" : "",
    ));
  }
  if (move) {
    items.push(item("行业涨停只数", `${move.from} ${move.prev} 只 → ${move.to} ${move.now} 只`, `${ctx.snapshot_date} ${move.to}`, "东财涨停池同行业字段"));
  }
  if (hot) items.push(item("连续出现", hot.note, at, "涨停池快照"));
  if (spread) items.push(item("扩散", spread.evidence.join(" "), `${ctx.snapshot_date} ${spread.latest_clock}`, "涨停池连续快照"));
  for (const name of concepts.names) {
    const hit = moneySeries(ctx.snaps, "concept", name);
    if (hit.sources.length > 1 || hit.ambiguous || hit.dropped || hit.points.filter((p) => num(p.net)).length < 2) {
      items.push(item("概念归属", `「${name}」${hit.dropped ? "掉出前列，不当成流出" : "没有两条同口径净额"}`, at, "代码对应的概念归属", "", "概念资金不按名字另找板块。"));
      continue;
    }
    const c0 = hit.points.filter((p) => num(p.net));
    const cFirst = c0[0]!, cLast = c0.at(-1)!;
    const cDelta = cLast.net! - cFirst.net!;
    items.push(item("概念资金", `「${name}」${cFirst.clock} ${yuan(cFirst.net)} → ${cLast.clock} ${yuan(cLast.net)}，变化 ${yuan(cDelta)}`, at, cLast.caliber));
    if (delta != null && Math.sign(delta) !== 0 && Math.sign(cDelta) !== 0 && Math.sign(delta) !== Math.sign(cDelta)) {
      items.push(item("行业与概念", "行业净额方向和概念净额方向相反", at, "同一代码的归属", "方向冲突。", "冲突不被另一边的正向读数抵消。"));
      return { leg: { key: "sector", title, verdict: "行业与概念冲突", items }, kind: "ebb" };
    }
  }
  if (concepts.reason && !concepts.names.length) {
    items.push(item("概念归属", concepts.reason, at, "龙头概念接口"));
  }
  const breadthEbb = !!move && move.now - move.prev <= -BREADTH_MOVE;
  const breadthUp = !!spread && spread.breadth_now - spread.breadth_prev >= BREADTH_MOVE;
  const pctKnown = num(first?.pct) && num(last?.pct);
  const moneyEbb = delta != null && delta <= -MIN_BOARD_DELTA_YUAN && pctKnown && last!.pct! <= first!.pct!;
  const moneyUp = delta != null && delta >= MIN_BOARD_DELTA_YUAN && pctKnown && last!.pct! >= first!.pct!;
  if (delta != null && pctKnown && last!.pct! !== first!.pct! && Math.sign(delta) !== Math.sign(last!.pct! - first!.pct!)) {
    items.push(item("净额和涨跌幅", "净额方向和板块涨跌幅方向相反", at, first?.caliber || "板块资金", "方向不一致。", "不把净额升幅当成板块持续。"));
    return { leg: { key: "sector", title, verdict: "资金和涨跌幅冲突", items }, kind: "ebb" };
  }
  if (moneyEbb || breadthEbb) {
    items.push(item("退潮", moneyEbb ? "同口径净额下降达到 1.5 亿元。" : `同行业涨停只数减少 ${move!.prev - move!.now} 只。`, at, "连续快照", "板块退潮。", "退潮不会被个股或市场的正向读数抵消。"));
    return { leg: { key: "sector", title, verdict: "板块退潮", items }, kind: "ebb" };
  }
  if (moneyUp || (breadthUp && (delta == null || delta >= 0))) {
    items.push(item("持续", moneyUp ? "同口径净额上升达到 1.5 亿元，涨跌幅没有反向下降。" : "同行业涨停扩散至少增加 2 只，资金没有同步转降。", at, "连续快照", "", "这是观察依据，不是还会继续的预测。"));
    return { leg: { key: "sector", title, verdict: "连续同向", items }, kind: "supportive" };
  }
  items.push(item("持续", "有快照，但净额变化没到 1.5 亿元，涨停扩散也没到增加 2 只。", at, "连续快照", "", "先不叫板块持续。"));
  return { leg: { key: "sector", title, verdict: "还看不出持续", items }, kind: "missing" };
}

function conceptNames(snaps: CaptureSnapshot[], symbol: string): { names: string[]; reason: string | null } {
  const row = [...snaps].reverse().flatMap((s) => s.leader_concepts).find((c) => c.code === symbol);
  if (!row) return { names: [], reason: "这只代码没有已落盘的概念归属，不从名称推断概念。" };
  return { names: row.concepts.filter((n) => n.trim()), reason: row.reason };
}

function stockLeg(symbol: SymbolSummary, ctx: JointContext): { leg: JointLeg; kind: LegKind } {
  const title = "个股回踩 / 二次启动";
  const at = symbol.quote_last_date ?? "没有行情日";
  const source = "腾讯前复权日 K，锚点用同一条序列的涨停日收盘";
  const items: JointItem[] = [];
  items.push(item("倾向", symbol.tendency_text, at, source));
  if (symbol.marks.length) {
    items.push(item("标记", symbol.marks.map((m) => `${m.kind} ${m.anchor_date} 收盘 ${m.anchor_close.toFixed(2)}`).join("；"), at, source));
  }
  for (const e of symbol.evidence) items.push(item("证据", e, at, source));
  for (const c of symbol.counter) items.push(item("反证", c, at, source, c, "反证还在，不能收成联合满足。"));
  const risk = symbol.marks.some((m) => m.kind === "broken") || symbol.tendency === "conflict" || symbol.tendency === "distribution" || symbol.counter.length > 0;
  if (risk) {
    items.push(item("失效", "破位、出货倾向或证据相反已经出现。", at, source, "个股风险。", "不会被市场或板块的正向读数抵消。"));
    return { leg: { key: "stock", title, verdict: "个股证据冲突或走弱", items }, kind: "risk" };
  }
  if (symbol.stale || symbol.tendency === "no_quote" || symbol.missing_launch || symbol.sample_bars < MIN_BARS || !symbol.quote_last_date) {
    const why = symbol.stale ? "日 K 陈旧。" : symbol.tendency === "no_quote" ? "没有前复权日 K。" : symbol.missing_launch ? "没有启动日。" : `已收盘样本 ${symbol.sample_bars} 根，不足 ${MIN_BARS} 根。`;
    items.push(item("样本", why, at, source, "", "关键的个股依据不足。"));
    return { leg: { key: "stock", title, verdict: "个股依据不足", items }, kind: "missing" };
  }
  const supportive = symbol.tendency === "shakeout" && symbol.marks.some((m) => m.kind === "near" || m.kind === "held" || m.kind === "second_start");
  if (!supportive) {
    items.push(item("样本", "有已收盘 K 线，但还没有接近、守住或二次启动候选。", at, source, "", "个股这项先不配合。"));
    return { leg: { key: "stock", title, verdict: "还没有回踩配合", items }, kind: "missing" };
  }
  if (symbol.unconfirmed) {
    items.push(item("未收盘", "最后一根还没收盘。已收盘部分只作为此前依据。", symbol.quote_last_date, source, "", "未收盘不能把联合标成已确认。"));
    return { leg: { key: "stock", title, verdict: "未收盘", items }, kind: "unconfirmed" };
  }
  if (symbol.quote_last_date > ctx.as_of) {
    items.push(item("行情日", `最后一根 ${symbol.quote_last_date} 晚于查看日 ${ctx.as_of}。`, symbol.quote_last_date, source, "", "晚于查看日的 K 线不参与联合。"));
    return { leg: { key: "stock", title, verdict: "行情日对不上", items }, kind: "missing" };
  }
  if (symbol.quote_last_date < ctx.as_of) {
    items.push(item("前日依据", `最后一根已收盘 K 线是 ${symbol.quote_last_date}，早于查看日 ${ctx.as_of}。`, symbol.quote_last_date, source, "", "这是前日依据，不能充今日盘中或今日收盘确认。"));
    return { leg: { key: "stock", title, verdict: "只有前日依据", items }, kind: "previous" };
  }
  items.push(item("收盘", `最后一根 ${symbol.quote_last_date} 已收盘，和查看日一致。`, symbol.quote_last_date, source));
  return { leg: { key: "stock", title, verdict: "收盘回踩线索还在", items }, kind: "supportive" };
}

