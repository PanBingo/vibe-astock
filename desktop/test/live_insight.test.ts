// 实时洞察页面：用夹具渲染用户看得到的降级和证据，不请求生产接口。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { LiveInsightView } from "../src/verticals/finance/shortline/insightTypes.ts";

const base = (): LiveInsightView => ({
  enabled: true, disabled_reason: null, date: "2026-10-12", clock: "10:10:00", phase: "morning", phase_label: "上午连续竞价",
  trading_day: true, archive: false, capture_count: 2, latest_captured_at: "2026-10-12T02:10:00.000Z", latest_clock: "10:10:00",
  stale: false, freshness: "最近采集 10:10，数字在收盘前还会变。", capture_due: false, poll_ms: 20000,
  board_source: "eastmoney", board_caliber: "东财主力净额（元，今日累计）。不是新浪流入减流出。",
  market: {
    indexes: [{ code: "sh000001", name: "上证指数", price: 3200, change_pct: 0.4, quote_time: "20261012101000", today: true }, { code: "sz399001", name: "深证成指", price: 10000, change_pct: -0.2, quote_time: "20261009150000", today: false }],
    breadth: { date: "2026-10-12", exchanges: [{ market: "SH", label: "沪市", up: 1800, down: 900, flat: 40, amount: 1e12 }], buckets: [], fetched_at: "2026-10-12T02:10:00.000Z" },
    breadth_note: null,
    live: { as_of: "10:10:01", phase: "上午连续竞价", limit_up: 40, broken: 5, limit_down: 2, highest_board: 5, seal_rate: 0.8, broken_rate: 0.1 },
    live_reason: null,
  },
  industry: [{ code: "BK1", name: "半导体", rank: 1, main_net: 4e8, change_pct: 1.2, main_pct: 2, up_count: 20, down_count: 3, leader: "龙头", delta_net: 3e8, delta_pct: 0.8, baseline_clock: "10:00", history: [{ clock: "10:00", main_net: 1e8 }, { clock: "10:10", main_net: 4e8 }] }],
  concept: [],
  anomalies: [{ kind: "industry", code: "BK1", name: "半导体", baseline_clock: "10:00", latest_clock: "10:10", main_net: 4e8, baseline_net: 1e8, delta_net: 3e8, change_pct: 1.2, baseline_pct: 0.4, relation: "主力净额上升，板块涨跌幅也上升。", reliability: "high", explanation: "行业「半导体」东财主力净额从 +1.00亿元（10:00）到 +4.00亿元（10:10），变化 +3.00亿元。这是两张快照的差，不是买卖建议。" }],
  anomaly_note: null,
  accumulation: [{ code: "600000", name: "浦发", status: "suspected", reliability: "medium", method: "minute_series", points: 30, span_min: 29, main_net: 3e7, change_pct: 1.2, up_fraction: 1, step_share: 0.03, statement: "截至 10:00 的统计形态：浦发（600000）东财主力净额累计抬升。", disclaimer: "统计推断：用公开的东财主力净额当日累计看形态，不是龙虎榜机构席位，也不是十大股东或基金持仓。" }],
  hotspots: [{ industry: "半导体", breadth: 3, leader_code: "600001", leader_name: "龙头", leader_boards: 3, leader_seal: "09:35:00", intensity: 0.33, persistence: 2, names: [{ code: "600001", name: "龙头", limit_days: 3 }], names_more: 2, note: "最近连续 2 张快照里该行业涨停不少于 2 只。" }],
  diffusion: [{ industry: "半导体", leader_code: "600001", leader_name: "龙头", breadth_prev: 1, breadth_now: 3, new_names: [{ code: "600002", name: "跟风甲" }], baseline_clock: "10:00", latest_clock: "10:10", concepts: [{ name: "芯片", change_pct: 1.4, main_net: 3.2e8, delta_net: 1.2e8 }], reliability: "medium", evidence: ["10:00 龙头 龙头（600001）仍在 10:10 的「半导体」涨停里。", "同行业涨停从 1 只到 3 只。", "不是预测还会继续扩散。"] }],
  diffusion_note: null,
  gaps: ["成交额榜里符合条件的样本偏少。"],
  limits: ["疑似建仓只描述统计形态，不能据此推断谁在买。"],
  source: "盘中采集，不是复盘快照。",
  attempt: null,
});

test("实时洞察展示口径、证据、可靠性和非今日行情", async () => {
  await withRenderer(async (r) => {
    const { InsightBody } = await r.load("/src/verticals/finance/shortline/InsightTab.tsx");
    const text = textOf(r.html(InsightBody, { v: base(), error: null, paused: false }));
    assert.match(text, /东财主力净额/);
    assert.match(text, /不是买卖建议/);
    assert.match(text, /统计推断/);
    assert.match(text, /不是龙虎榜机构席位/);
    assert.match(text, /可靠性 高/);
    assert.match(text, /深证成指 · 非今日/);
    assert.match(text, /半导体/);
    assert.match(text, /从 1 只到 3 只/);
    assert.doesNotMatch(text, /建议买入|目标价|可以买/);
  });
});

test("样本不足、陈旧和休市都写在页面上，不当成已经发生的信号", async () => {
  await withRenderer(async (r) => {
    const { InsightBody } = await r.load("/src/verticals/finance/shortline/InsightTab.tsx");
    const v = base();
    v.phase_label = "周末休市";
    v.freshness = "周末休市。今天没有实时。";
    v.archive = false;
    v.anomalies = [];
    v.anomaly_note = "还没有上一张快照，只展示当前这一张，不标资金异动。";
    v.accumulation = [{ ...v.accumulation[0]!, status: "insufficient", reliability: null, statement: "样本不足：连续竞价内 4 个点。", disclaimer: v.accumulation[0]!.disclaimer }];
    v.diffusion = [];
    v.diffusion_note = "扩散需要至少两张同一交易日的涨停池快照。";
    v.stale = true;
    v.market.breadth_note = "涨跌分布上游日期 2026-10-09 与采集日 2026-10-12 不一致。";
    v.market.live = null;
    v.market.live_reason = "今天不是交易日，没有盘中情绪。";
    const text = textOf(r.html(InsightBody, { v, error: null, paused: false }));
    assert.match(text, /周末休市/);
    assert.match(text, /样本不足/);
    assert.match(text, /不标资金异动/);
    assert.match(text, /至少两张/);
    assert.match(text, /不一致/);
    assert.match(text, /没有盘中情绪/);
    assert.doesNotMatch(text, /疑似低波动净流入\s*浦发/);
  });
});
