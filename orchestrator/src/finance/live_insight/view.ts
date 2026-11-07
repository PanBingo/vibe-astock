/**
 * 页面只读已采集的快照。要新的一张走 POST capture，避免打开页面就写盘。
 */
import { ServiceError, type ServiceContext } from "../../service.ts";
import { validDate } from "../shortline/history.ts";
import { PHASE_LABELS, phaseOf, type Phase } from "../shortline/watch.ts";
import { clockOf } from "../shortline/intraday.ts";
import { INSIGHT_SOURCE, liveInsightEnabled } from "./config.ts";
import {
  LIMITATIONS, accumulationClues, boardViews, diffusionSignals, findAnomalies, freshnessOf, hotspotBoards, pickBaseline,
} from "./analyze.ts";
import { captureLiveInsight, shouldCapture, type CaptureDeps } from "./capture.ts";
import { readAttempt, readSnapshots } from "./store.ts";
import type { CaptureSnapshot, LiveInsightView } from "./types.ts";

const QUIET: Phase[] = ["weekend", "lunch", "pre_open", "auction", "closing_auction"];

export function insightPollMs(phase: Phase, tradingDay: boolean | null): number {
  if (tradingDay === false || phase === "weekend") return 60_000;
  if (phase === "morning" || phase === "afternoon") return 20_000;
  return 60_000;
}

export function buildLiveInsightView(ctx: ServiceContext, date: string, now = new Date()): LiveInsightView {
  const flag = liveInsightEnabled();
  const clock = clockOf(now);
  const phase = phaseOf(now);
  const archive = date !== clock.day;
  const { snapshots, dropped } = readSnapshots(ctx, date);
  const latest = snapshots.at(-1) ?? null;
  const baseline = latest ? pickBaseline(snapshots, latest) : { prev: null, note: null };
  const fresh = freshnessOf(latest, archive ? (latest?.phase ?? phase) : phase, archive, now);
  const breadthNote = latest?.breadth?.date && latest.breadth.date !== latest.date
    ? `涨跌分布上游日期 ${latest.breadth.date} 与采集日 ${latest.date} 不一致。`
    : null;
  const hot = hotspotBoards(snapshots);
  const spread = diffusionSignals(snapshots);
  const judgePhase = archive ? (latest?.phase ?? "closed") : phase;
  const judgeHm = archive ? (latest?.clock ?? "15:00:00") : clock.hm;
  const gaps = [
    ...(latest?.gaps ?? []),
    ...(dropped ? [`有 ${dropped} 行快照读不出来，已跳过。`] : []),
    ...(baseline.note ? [baseline.note] : []),
    ...(hot.note ? [hot.note] : []),
    ...(spread.note ? [spread.note] : []),
  ];
  const attempt = readAttempt(ctx);
  const toldClosed = !archive && attempt?.date === date && attempt.outcome === "skipped" && /不是交易日|周末/.test(attempt.reason ?? "");
  const tradingDay = archive ? latest?.trading_day ?? null : phase === "weekend" || toldClosed ? false : latest?.trading_day ?? null;
  const knownDay: boolean | null = phase === "weekend" || toldClosed ? false : tradingDay;
  const due = !archive && flag.enabled && shouldCapture({
    phase, tradingDay: knownDay === true ? true : knownDay === false ? false : null,
    hm: clock.hm, lastClock: latest?.clock ?? null, lastAtMs: latest ? Date.parse(latest.captured_at) : null, nowMs: now.getTime(), force: false,
  }).ok;
  // 今天还没问过日历时，连续竞价允许页面触发一轮；采集函数会查日历。已经确认休市就不再触发。
  const captureDue = !archive && flag.enabled && !toldClosed && (due || (knownDay == null && !QUIET.includes(phase) && phase !== "closed" && !latest));
  return {
    enabled: flag.enabled, disabled_reason: flag.reason, date, clock: clock.hms, phase, phase_label: PHASE_LABELS[phase],
    trading_day: tradingDay, archive, capture_count: snapshots.length, latest_captured_at: latest?.captured_at ?? null, latest_clock: latest?.clock ?? null,
    stale: fresh.stale || !!breadthNote, freshness: [fresh.text, breadthNote].filter(Boolean).join(""),
    capture_due: captureDue, poll_ms: insightPollMs(phase, tradingDay),
    board_source: latest?.board_source ?? "none", board_caliber: latest?.board_caliber ?? "还没有板块资金快照。",
    market: {
      indexes: latest?.indexes ?? [], breadth: latest?.breadth ?? null, breadth_note: breadthNote,
      live: latest?.live ?? null, live_reason: latest?.live_reason ?? (latest ? null : "还没有盘中情绪。非交易日、开盘前和竞价阶段上游本来就不给，不会改用复盘情绪。"),
    },
    industry: latest ? boardViews(snapshots, latest, "industry", baseline.prev) : [],
    concept: latest ? boardViews(snapshots, latest, "concept", baseline.prev) : [],
    anomalies: latest ? findAnomalies(latest, baseline.prev) : [],
    anomaly_note: baseline.note,
    accumulation: accumulationClues(snapshots, judgePhase, judgeHm, archive),
    hotspots: hot.hotspots, diffusion: spread.signals, diffusion_note: spread.note ?? hot.note,
    gaps: [...new Set(gaps)], limits: LIMITATIONS, source: INSIGHT_SOURCE,
    attempt,
  };
}

export async function liveInsightView(ctx: ServiceContext, query: Record<string, string>, _signal: AbortSignal, now = new Date()): Promise<LiveInsightView> {
  const date = query.date || clockOf(now).day;
  if (!validDate(date)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  return buildLiveInsightView(ctx, date, now);
}

export async function liveInsightAct(ctx: ServiceContext, body: Record<string, unknown>, signal: AbortSignal, deps: CaptureDeps = {}): Promise<LiveInsightView & { outcome: string }> {
  if (body.action !== "capture") throw new ServiceError("bad_request", "未知动作");
  const now = deps.now ?? new Date();
  const result = await captureLiveInsight(ctx, { ...deps, now, signal, force: body.force === true });
  const view = buildLiveInsightView(ctx, clockOf(now).day, now);
  return { ...view, outcome: result.outcome, attempt: { at: now.toISOString(), date: view.date, phase: view.phase, outcome: result.outcome, reason: result.reason, gaps: result.gaps } };
}

export function snapshotUseful(snap: CaptureSnapshot | null): boolean {
  return !!snap && (snap.industry.length + snap.concept.length + snap.limit_ups.length) > 0;
}
