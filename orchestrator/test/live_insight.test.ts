// 实时洞察：纯计算用夹具，采集用假取数。不把复盘端点或休市日的上一交易日池子当成实时。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import "../src/finance/register_tasks.ts";
import type { ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import {
  accumulationClues, diffusionSignals, findAnomalies, freshnessOf, hotspotBoards, judgeFlow, pickBaseline, sessionPoints,
} from "../src/finance/live_insight/analyze.ts";
import { captureLiveInsight, resetLiveInsightFlight, shouldCapture } from "../src/finance/live_insight/capture.ts";
import { seriesFromRawJson } from "../src/finance/live_insight/parse.ts";
import { readSnapshots } from "../src/finance/live_insight/store.ts";
import type { CaptureSnapshot } from "../src/finance/live_insight/types.ts";
import { buildLiveInsightView } from "../src/finance/live_insight/view.ts";

const DAY = "2026-10-12";
const signal = new AbortController().signal;
const sh = (hm: string, day = DAY) => new Date(`${day}T${hm.length === 5 ? `${hm}:00` : hm}+08:00`);

function tmpCtx(): ServiceContext {
  return { repoRoot: process.cwd(), dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-insight-")), python: "python3", node: process.execPath };
}

function snap(over: Partial<CaptureSnapshot> & { at: string; clock: string }): CaptureSnapshot {
  const { at, clock, ...rest } = over;
  return {
    schema: 1, date: DAY, captured_at: at, clock, phase: "morning", trading_day: true,
    board_source: "eastmoney", board_caliber: "东财主力净额（元，今日累计）。", industry: [], concept: [],
    breadth: null, indexes: [], limit_ups: [], limit_up_date: DAY, flows: [], leader_concepts: [], live: null, live_reason: null, gaps: [],
    ...rest,
  };
}

const board = (code: string, name: string, main: number, pct: number, rank = 1) =>
  ({ code, name, rank, main_net: main, main_pct: 1, change_pct: pct, up_count: 10, down_count: 2, leader: "甲" });

test("对照窗口：样本不足、跨午休、口径不同、间隔过长都不标异动", () => {
  const a = snap({ at: `${DAY}T02:00:00.000Z`, clock: "10:00:00", industry: [board("BK1", "半导体", 1e8, 0.4)] });
  assert.match(pickBaseline([a], a).note ?? "", /还没有上一张/);
  const b = snap({ at: `${DAY}T02:10:00.000Z`, clock: "10:10:00", industry: [board("BK1", "半导体", 4e8, 1.2)] });
  const anomalies = findAnomalies(b, pickBaseline([a, b], b).prev);
  assert.equal(anomalies.length, 1);
  assert.match(anomalies[0]!.explanation, /半导体/);
  assert.match(anomalies[0]!.explanation, /不是买卖建议/);
  assert.match(anomalies[0]!.relation, /上升/);
  const lunch = snap({ at: `${DAY}T05:10:00.000Z`, clock: "13:10:00", industry: [board("BK1", "半导体", 8e8, 2)] });
  const morning = snap({ at: `${DAY}T03:20:00.000Z`, clock: "11:20:00", industry: [board("BK1", "半导体", 1e8, 0.2)] });
  assert.match(pickBaseline([morning, lunch], lunch).note ?? "", /午休/);
  assert.equal(findAnomalies(lunch, null).length, 0);
  const sina = snap({ at: `${DAY}T02:12:00.000Z`, clock: "10:12:00", board_source: "sina", industry: [board("s1", "半导体", 9e8, 1)] });
  assert.match(pickBaseline([b, sina], sina).note ?? "", /口径不一致/);
  const late = snap({ at: `${DAY}T04:00:00.000Z`, clock: "12:00:00", industry: [board("BK1", "半导体", 9e8, 1)] });
  assert.match(pickBaseline([a, late], late).note ?? "", /超过 40 分钟|午休/);
});

test("疑似净流入是统计形态：有效序列入选，样本不足、单步跃升、陈旧和午休都不入选", () => {
  const points = Array.from({ length: 30 }, (_, i) => {
    const hm = 9 * 60 + 31 + i;
    const h = String(Math.floor(hm / 60)).padStart(2, "0");
    const m = String(hm % 60).padStart(2, "0");
    return { time: `${DAY} ${h}:${m}`, main_net: (i + 1) * 1e6 };
  });
  const ok = judgeFlow({ code: "600000", name: "浦发", change_pct: 1.2, method: "minute_series", points, phase: "morning", hm: "10:05", archive: false });
  assert.equal(ok.status, "suspected");
  assert.equal(ok.reliability, "medium");
  assert.match(ok.disclaimer, /不是龙虎榜机构席位/);
  assert.match(ok.statement, /统计形态|主力净额/);
  const few = judgeFlow({ code: "600000", name: "浦发", change_pct: 1.2, method: "minute_series", points: points.slice(0, 5), phase: "morning", hm: "09:40", archive: false });
  assert.equal(few.status, "insufficient");
  assert.match(few.statement, /样本不足/);
  const spike = points.map((p, i) => ({ ...p, main_net: i === 0 ? 0 : 2e7 }));
  const jumped = judgeFlow({ code: "600000", name: "浦发", change_pct: 1, method: "minute_series", points: spike, phase: "morning", hm: "10:05", archive: false });
  assert.equal(jumped.status, "not_indicated");
  const stale = judgeFlow({ code: "600000", name: "浦发", change_pct: 1, method: "minute_series", points: [{ time: `${DAY} 09:31`, main_net: 1 }], phase: "morning", hm: "10:05", archive: false });
  assert.equal(stale.status, "stale");
  const lunch = judgeFlow({ code: "600000", name: "浦发", change_pct: 1, method: "minute_series", points, phase: "lunch", hm: "12:00", archive: false });
  assert.equal(lunch.status, "lunch");
  assert.match(lunch.statement, /午间休市/);
  const session = sessionPoints([{ time: `${DAY} 12:10`, main_net: 1 }, { time: `${DAY} 09:31`, main_net: 2 }]);
  assert.deepEqual(session.map((p) => p.main_net), [2]);
});

test("热点扩散要原龙头还在且同行业至少多 2 只；一张快照或池子日期不对就降级", () => {
  const limit = (code: string, name: string, industry: string, boards: number, seal: string) =>
    ({ code, name, industry, limit_days: boards, first_seal: seal, seal_fund: 1e8, pct: 10, amount: 1e8 });
  const prev = snap({
    at: `${DAY}T02:00:00.000Z`, clock: "10:00:00",
    limit_ups: [limit("600001", "龙头", "半导体", 3, "09:35:00")],
    leader_concepts: [{ code: "600001", name: "龙头", concepts: ["芯片"], fetched_at: prevAt(), reason: null }],
    concept: [board("BK9", "芯片", 2e8, 0.5)],
  });
  const now = snap({
    at: `${DAY}T02:10:00.000Z`, clock: "10:10:00",
    limit_ups: [limit("600001", "龙头", "半导体", 3, "09:35:00"), limit("600002", "跟风甲", "半导体", 1, "10:02:00"), limit("600003", "跟风乙", "半导体", 1, "10:06:00")],
    leader_concepts: [{ code: "600001", name: "龙头", concepts: ["芯片"], fetched_at: prevAt(), reason: null }],
    concept: [board("BK9", "芯片", 3.2e8, 1.4)],
  });
  const spread = diffusionSignals([prev, now]);
  assert.equal(spread.signals.length, 1);
  assert.equal(spread.signals[0]!.leader_code, "600001");
  assert.equal(spread.signals[0]!.breadth_prev, 1);
  assert.equal(spread.signals[0]!.breadth_now, 3);
  assert.match(spread.signals[0]!.evidence.join(""), /跟风甲/);
  assert.equal(spread.signals[0]!.concepts[0]!.name, "芯片");
  const only = hotspotBoards([now]);
  assert.equal(only.hotspots.length, 1);
  assert.match(only.note ?? only.hotspots[0]!.note, /一张/);
  const wrongDay = snap({ at: `${DAY}T02:10:00.000Z`, clock: "10:10:00", limit_up_date: "2026-10-09", limit_ups: now.limit_ups });
  assert.match(hotspotBoards([wrongDay]).note ?? "", /不用这张池/);
  assert.equal(diffusionSignals([wrongDay]).signals.length, 0);
});

function prevAt() { return `${DAY}T02:00:00.000Z`; }

test("采集门：周末、午休、假日不取行情；节流不重复；空结果不落盘", async () => {
  const ctx = tmpCtx();
  const calls: string[] = [];
  const fetch = async (_ctx: ServiceContext, req: { endpoint: string }) => {
    calls.push(req.endpoint);
    if (req.endpoint === "fetch_trade_calendar") {
      return { envelope: { status: "ok", evidence: [
        { field: "last_trading_day", value: DAY, period: DAY },
        { field: "previous_trading_day", value: "2026-10-09", period: DAY },
        { field: "is_today_trading_day", value: true, period: DAY },
        { field: "session_phase", value: "trading", period: DAY },
      ] } };
    }
    if (req.endpoint === "cn_shortline_emotion" || req.endpoint === "cn_shortline_daily") throw new Error("不该调用复盘端点");
    return { envelope: { status: "failed", errors: [{ source: "eastmoney", error: "超时" }] }, fetched_at: `${DAY}T02:00:00.000Z` };
  };
  resetLiveInsightFlight();
  const weekend = await captureLiveInsight(ctx, { now: sh("10:00", "2026-11-07"), fetch: fetch as never, signal });
  assert.equal(weekend.outcome, "skipped");
  assert.equal(calls.length, 0, "周末不联网");
  const lunch = await captureLiveInsight(ctx, { now: sh("12:10"), fetch: fetch as never, signal, force: true });
  assert.equal(lunch.outcome, "skipped");
  assert.match(lunch.reason ?? "", /午间休市/);
  assert.equal(calls.length, 0, "午休即使手动刷新也不取行情");
  const closedCal = async () => ({ envelope: { status: "ok", evidence: [
    { field: "last_trading_day", value: "2026-10-09", period: DAY },
    { field: "previous_trading_day", value: "2026-10-08", period: DAY },
    { field: "is_today_trading_day", value: false, period: DAY },
    { field: "session_phase", value: "non_trading_day", period: DAY },
  ] } });
  const holiday = await captureLiveInsight(ctx, { now: sh("10:00"), fetch: closedCal as never, signal, force: true });
  assert.equal(holiday.outcome, "skipped");
  assert.match(holiday.reason ?? "", /不是交易日/);
  resetLiveInsightFlight();
  const failed = await captureLiveInsight(ctx, { now: sh("10:06"), fetch: fetch as never, signal, force: true });
  assert.equal(failed.outcome, "failed");
  assert.equal(readSnapshots(ctx, DAY).snapshots.length, 0, "核心读数全失败时不写空快照");
  assert.ok(!calls.includes("cn_shortline_emotion"));
  fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
  resetLiveInsightFlight();
});

test("假取数能落盘并被只读视图读回；节流和第二扇窗口不重复取", async () => {
  const ctx = tmpCtx();
  let calls = 0;
  let hold: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const fetch = async (_ctx: ServiceContext, req: { endpoint: string; symbol?: string }) => {
    calls += 1;
    if (hold && req.endpoint === "fetch_trade_calendar") await hold;
    return envelopeFor(req.endpoint, req.symbol, ctx.dataRoot);
  };
  resetLiveInsightFlight();
  hold = new Promise<void>((r) => { release = r; });
  const first = captureLiveInsight(ctx, { now: sh("10:05"), fetch: fetch as never, signal, force: true });
  const second = captureLiveInsight(ctx, { now: sh("10:05"), fetch: fetch as never, signal, force: true });
  release!();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.outcome, "saved");
  assert.equal(b.shared, true);
  assert.equal(readSnapshots(ctx, DAY).snapshots.length, 1);
  hold = null;
  const before = calls;
  const again = await captureLiveInsight(ctx, { now: sh("10:06"), fetch: fetch as never, signal, force: false });
  assert.equal(again.outcome, "throttled");
  assert.equal(calls, before, "节流后不再取数");
  const view = buildLiveInsightView(ctx, DAY, sh("10:07"));
  assert.equal(view.archive, false);
  assert.equal(view.industry[0]?.name, "半导体");
  assert.equal(view.market.indexes.find((x) => x.code === "sh000001")?.today, true);
  assert.match(view.source, /不是复盘快照/);
  assert.match(view.limits.join(""), /不能据此推断谁在买/);
  const archived = buildLiveInsightView(ctx, DAY, sh("10:00", "2026-11-07"));
  assert.equal(archived.archive, true);
  assert.match(archived.freshness, /不是当前实时/);
  fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
  resetLiveInsightFlight();
});

function envelopeFor(endpoint: string, symbol: string | undefined, root: string): { envelope: Record<string, unknown>; fetched_at: string; out_dir?: string } {
  const fetched_at = `${DAY}T02:05:00.000Z`;
  if (endpoint === "fetch_trade_calendar") {
    return { envelope: { status: "ok", evidence: [
      { field: "last_trading_day", value: DAY, period: DAY },
      { field: "previous_trading_day", value: "2026-10-09", period: DAY },
      { field: "is_today_trading_day", value: true, period: DAY },
      { field: "session_phase", value: "trading", period: DAY },
    ] }, fetched_at };
  }
  if (endpoint === "em_board_fund_flow") {
    return { envelope: { status: "ok", evidence: [
      { field: "board_main_net_today", value: 2.5e8, record_key: "industry|BK1", note: "半导体 排名 1", period: DAY },
      { field: "board_change_pct_today", value: 1.2, record_key: "industry|BK1", note: "半导体 排名 1", period: DAY },
      { field: "board_main_net_today", value: -1.2e8, record_key: "concept|BK9", note: "芯片 排名 4", period: DAY },
      { field: "board_change_pct_today", value: 0.8, record_key: "concept|BK9", note: "芯片 排名 4", period: DAY },
    ] }, fetched_at };
  }
  if (endpoint === "em_industry_comparison") {
    return { envelope: { status: "ok", evidence: [
      { field: "industry_board_up_count", value: 20, record_key: "BK1", note: "半导体 排名 1 领涨 龙头", period: DAY },
      { field: "industry_board_down_count", value: 3, record_key: "BK1", note: "半导体 排名 1 领涨 龙头", period: DAY },
    ] }, fetched_at };
  }
  if (endpoint === "em_market_breadth") {
    return { envelope: { status: "ok", extra: { date: DAY }, evidence: [
      { field: "market_up_count", value: 1800, record_key: "exchange|SH", note: "沪市全市场(东财指数行情口径)", period: DAY },
      { field: "market_down_count", value: 900, record_key: "exchange|SH", note: "沪市全市场(东财指数行情口径)", period: DAY },
      { field: "market_dist_count", value: 40, record_key: "dist|11", note: "涨停", period: DAY },
    ] }, fetched_at };
  }
  if (endpoint === "em_zt_pool") {
    return { envelope: { status: "ok", extra: { date: DAY }, evidence: [
      { field: "pool_limit_days", value: 3, record_key: "600001", note: "600001 龙头 半导体 3天3板 首封 09:35:00", period: DAY },
      { field: "pool_change_pct", value: 10, record_key: "600001", note: "600001 龙头 半导体 3天3板 首封 09:35:00", period: DAY },
    ] }, fetched_at };
  }
  if (endpoint === "em_turnover_rank") {
    return { envelope: { status: "ok", evidence: [
      { field: "change_pct", value: 1.1, record_key: "stock|600000", note: "浦发(600000)·银行;成交额榜第 1 名", period: DAY },
      { field: "turnover_amount", value: 5e9, record_key: "stock|600000", note: "浦发(600000)·银行;成交额榜第 1 名", period: DAY },
    ] }, fetched_at };
  }
  if (endpoint === "tx_quotes_batch") {
    return { envelope: { status: "ok", evidence: [
      { field: "price", value: 3200, record_key: "sh000001", period: DAY },
      { field: "change_pct", value: 0.4, record_key: "sh000001", period: DAY },
      { field: "quote_time", value: "20261012100500", record_key: "sh000001", period: DAY },
      { field: "security_name", value: "上证指数", record_key: "sh000001", period: DAY },
    ] }, fetched_at };
  }
  if (endpoint === "cn_shortline_live") {
    return { envelope: { status: "ok", extra: { result: { date: DAY, as_of: "10:05:01", phase: "上午连续竞价", live: { limit_up: 40, broken: 5, limit_down: 2, highest_board: 5, seal_rate: 0.8, broken_rate: 0.1 } } } }, fetched_at };
  }
  if (endpoint === "em_fund_flow_minute" && symbol === "600000") {
    const dir = path.join(root, "raw-test");
    fs.mkdirSync(dir, { recursive: true });
    const ref = "flow.json";
    const klines = Array.from({ length: 25 }, (_, i) => {
      const hm = 9 * 60 + 31 + i;
      const h = String(Math.floor(hm / 60)).padStart(2, "0");
      const m = String(hm % 60).padStart(2, "0");
      return `${DAY} ${h}:${m},${(i + 1) * 1e6},0,0,0,0`;
    });
    fs.writeFileSync(path.join(dir, ref), JSON.stringify({ data: { klines } }));
    return { envelope: { status: "ok", evidence: [{ field: "main_net_inflow_intraday_cum", value: 25e6, raw_ref: ref }], extra: { last_time: `${DAY} 09:55` } }, fetched_at, out_dir: dir };
  }
  if (endpoint === "em_concept_blocks") {
    return { envelope: { status: "ok", evidence: [{ field: "board_membership", value: "芯片", record_key: "BK9" }] }, fetched_at };
  }
  return { envelope: { status: "failed", reason: `测试未准备 ${endpoint}` }, fetched_at };
}

test("分钟资金原始 k 线能还原累计序列；坏行快照会被丢掉", () => {
  const series = seriesFromRawJson({ data: { klines: [`${DAY} 09:31,100,0,0,0,0`, `${DAY} 09:32,-`, `${DAY} 09:33,300,0,0,0,0`] } });
  assert.deepEqual(series.map((p) => p.main_net), [100, 300]);
  const ctx = tmpCtx();
  const file = path.join(ctx.dataRoot, "live-insight", DAY);
  fs.mkdirSync(file, { recursive: true });
  fs.writeFileSync(path.join(file, "snapshots.jsonl"), `{"schema":1,"date":"${DAY}","captured_at":"${DAY}T02:00:00.000Z","clock":"10:00:00"}\n不是json\n{"schema":2,"date":"${DAY}"}\n`);
  const read = readSnapshots(ctx, DAY);
  assert.equal(read.snapshots.length, 1);
  assert.equal(read.dropped, 2);
  fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
});

test("周末没有快照时先说明休市，不说成还没来得及采集", () => {
  assert.match(freshnessOf(null, "weekend", false, sh("10:00", "2026-11-07")).text, /周末休市/);
  assert.match(freshnessOf(null, "morning", false, sh("10:00")).text, /还没有采集/);
});

test("视图已登记；休市和竞价的门不采集", () => {
  assert.ok(listViews().some((v) => v.id === "live_insight"));
  assert.equal(shouldCapture({ phase: "auction", tradingDay: true, hm: "09:20", lastClock: null, lastAtMs: null, nowMs: 0, force: true }).ok, false);
  assert.equal(shouldCapture({ phase: "closed", tradingDay: true, hm: "16:00", lastClock: "15:01:00", lastAtMs: 0, nowMs: 10, force: true }).ok, false);
  assert.equal(accumulationClues([], "morning", "10:00", false).length, 0);
});
