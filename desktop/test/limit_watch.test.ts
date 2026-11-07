// 观察池左右联动：用夹具渲染，不请求生产接口，也不把样例当成真实行情。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { JointAssessment, JointStatus, LimitWatchView, SymbolSummary } from "../src/verticals/finance/lib/limitWatch.ts";

const jointOf = (status: JointStatus = "insufficient"): JointAssessment => ({
  status,
  label: status === "aligned" ? "联合条件满足" : status === "waiting" ? "等待确认" : status === "conflict" ? "风险或证据冲突" : "数据不足",
  session_note: "夹具，不是生产行情。",
  legs: [
    { key: "market", title: "市场环境", verdict: "夹具", items: [{ label: "涨跌家数", value: "夹具不提供真实家数", at: "2026-11-07", source: "夹具", counter: "", fail: "" }] },
    { key: "sector", title: "板块持续性", verdict: "夹具", items: [{ label: "快照窗口", value: "夹具不提供真实板块", at: "2026-11-07", source: "夹具", counter: "", fail: "" }] },
    { key: "stock", title: "个股回踩 / 二次启动", verdict: "夹具", items: [{ label: "倾向", value: "夹具个股", at: "2026-11-06", source: "夹具", counter: "", fail: "" }] },
  ],
  invalidation: ["回踩破位后这项观察失效。"],
});

const stock = (over: Partial<SymbolSummary & { joint: JointAssessment }> & { symbol: string; name: string }): SymbolSummary & { joint: JointAssessment } => ({
  industry: "测试", status: "active", entries: 1, latest_entry: "2026-10-19", launch_dates: ["2026-10-19"], missing_launch: false,
  marks: [], tendency: "insufficient", tendency_text: "样本不足。", evidence: [], counter: [], sample_bars: 0,
  uncertainty: "夹具。", unconfirmed: false, quote_fetched_at: "2026-11-07T02:00:00.000Z", quote_last_date: "2026-11-02", stale: true, gaps: [],
  joint: jointOf(),
  ...over,
});

const view = (): LimitWatchView => ({
  enabled: true, disabled_reason: null, as_of: "2026-11-07", clock: "13:00:00", near_pct: 0.03,
  rules: "锚点是该涨停日在同一条前复权序列里的收盘价。不推断主力意图。",
  joint_note: "夹具。这不是当前实时。",
  symbols: [
    stock({ symbol: "600001", name: "测试甲", marks: [{ kind: "near", anchor_date: "2026-10-19", anchor_close: 10, band_low: 9.7, band_high: 10.3, distance_pct: 0.01, text: "收盘回到启动板附近。" }], tendency: "conflict", tendency_text: "证据相反，不收成单一结论。", evidence: ["回调段均量收缩。"], counter: ["收盘跌破下沿。"], quote_last_date: "2026-11-06", stale: false, gaps: ["最后一根日 K 是 2026-11-06。取数时间 2026-11-07T02:00，只说明何时抓到，不是行情日。"] }),
    stock({ symbol: "600002", name: "测试乙", quote_last_date: null, quote_fetched_at: "2026-11-07T03:00:00.000Z", stale: false, gaps: ["2026-11-07T03:00 腾讯限流，旧 K 线也没有。"], tendency: "no_quote", tendency_text: "还没有前复权日 K。" }),
  ],
  detail: null,
  runs: [], gaps: [], source: "夹具，不是生产行情",
});

const detailOf = (symbol: string, bars: { date: string; open: number; high: number; low: number; close: number; volume: number | null }[]) => {
  const s = view().symbols.find((x) => x.symbol === symbol)!;
  return { ...s, bars, adjust: bars.length ? "qfq" : null };
};

test("左侧选中高亮，右侧只画当前股票；没有 K 线不留上一只的图", async () => {
  await withRenderer(async (r) => {
    const mod = await r.load("/src/verticals/finance/pages/LimitWatch.tsx");
    const { LimitWatchBody, chartOption, filterRows, pickSelection, acceptDetail } = mod;
    const noop = () => {};
    const v = view();
    const withChart = r.html(LimitWatchBody, { v, message: null, selected: "600001", detail: detailOf("600001", [{ date: "2026-11-06", open: 10, high: 10.2, low: 9.8, close: 10.1, volume: 1000 }]), detailState: "ready", onSelect: noop, onEnroll: noop, onRefresh: noop, busy: false });
    const chartText = textOf(withChart);
    assert.match(withChart, /aria-selected="true"/);
    assert.match(withChart, /lg:flex-row/);
    assert.match(withChart, /lg:overflow-y-auto/);
    assert.match(chartText, /测试甲/);
    assert.match(chartText, /最后行情日 2026-11-06/);
    assert.match(chartText, /取数时间 2026-11-07T02:00:00.000Z/);
    assert.match(chartText, /两者不是一回事/);
    assert.match(chartText, /证据相反/);
    assert.match(chartText, /接近启动板/);
    const empty = textOf(r.html(LimitWatchBody, { v, message: null, selected: "600002", detail: detailOf("600002", []), detailState: "missing", onSelect: noop, onEnroll: noop, onRefresh: noop, busy: false }));
    assert.match(empty, /测试乙/);
    assert.match(empty, /没有可画的前复权 K 线/);
    assert.match(empty, /腾讯限流/);
    assert.doesNotMatch(empty, /前复权收盘 10\.00/);
    assert.equal(pickSelection("600002", filterRows(v.symbols, "near")), "600001");
    assert.equal(pickSelection("600002", []), null);
    assert.equal(acceptDetail("600002", "600001", "600002"), false);
    assert.equal(acceptDetail("600001", "600001", "600001"), true);
    const opt = chartOption([{ date: "2026-11-06", open: 10, high: 11, low: 9, close: 10.5, volume: 20 }], v.symbols[0], "#f00", "#0f0", "#999", "#333", "#222");
    const firstTip = opt.tooltip.formatter([{ dataIndex: 0 }]);
    assert.match(firstTip, /2026-11-06/);
    assert.match(firstTip, /10\.50/);
    assert.match(firstTip, /成交量/);
    assert.match(firstTip, /涨跌幅/);
    assert.match(firstTip, /暂无/);
    assert.doesNotMatch(firstTip, /0\.00%/);
    const blank = textOf(r.html(LimitWatchBody, { v: { ...v, symbols: [] }, message: null, selected: null, detail: null, detailState: "idle", onSelect: noop, onEnroll: noop, onRefresh: noop, busy: false }));
    assert.match(blank, /观察池还是空的/);
    assert.doesNotMatch(blank, /测试甲|10\.10/);
  });
});

test("涨跌幅用前一交易日收盘；无前收、非法值和缩放首根都不写成 0%", async () => {
  await withRenderer(async (r) => {
    const mod = await r.load("/src/verticals/finance/pages/LimitWatch.tsx");
    const { barChange, changeAt, tipBarIndex, chartOption } = mod;
    const up = barChange(10, 10.5);
    const down = barChange(10, 9);
    const flat = barChange(10, 10);
    assert.equal(up.text, "+5.00%");
    assert.equal(up.tone, "up");
    assert.equal(down.text, "-10.00%");
    assert.equal(down.tone, "down");
    assert.equal(flat.text, "0.00%");
    assert.equal(flat.tone, "flat");
    assert.equal(barChange(null, 10).text, "暂无");
    assert.equal(barChange(0, 10).text, "暂无");
    assert.equal(barChange(-1, 10).text, "暂无");
    assert.equal(barChange(Number.NaN, 10).text, "暂无");
    assert.equal(barChange(Number.POSITIVE_INFINITY, 10).text, "暂无");
    assert.equal(barChange(10, Number.NaN).text, "暂无");
    assert.equal(barChange(10, Number.POSITIVE_INFINITY).text, "暂无");
    for (const bad of [barChange(null, 10), barChange(0, 10), barChange(10, Number.NaN)]) assert.doesNotMatch(bad.text, /0%/);

    const bars = [
      { date: "2026-10-23", open: 10, high: 10.2, low: 9.8, close: 10, volume: 100 },
      { date: "2026-10-26", open: 10.2, high: 11.2, low: 10.1, close: 11, volume: 200 },
      { date: "2026-10-27", open: 11, high: 11, low: 10.4, close: 10.45, volume: 180 },
      { date: "2026-10-28", open: 10.45, high: 10.6, low: 10.4, close: 10.5, volume: 160 },
      { date: "2026-10-29", open: 10.5, high: 10.8, low: 10.4, close: 10.71, volume: 150 },
      { date: "2026-10-30", open: 10.71, high: 10.9, low: 10.6, close: 10.71, volume: 140 },
    ];
    assert.equal(changeAt(bars, 0).text, "暂无");
    assert.equal(changeAt(bars, 1).text, "+10.00%");
    assert.equal(changeAt(bars, 2).text, "-5.00%");
    const summary = {
      symbol: "600001", name: "测试甲", industry: "测试", status: "active", entries: 1, latest_entry: "2026-10-23",
      launch_dates: ["2026-10-23"], missing_launch: false,
      marks: [{ kind: "held", anchor_date: "2026-10-23", anchor_close: 10, band_low: 9.7, band_high: 10.3, distance_pct: 0, text: "夹具锚点。" }],
      tendency: "insufficient", tendency_text: "夹具。", evidence: [], counter: [], sample_bars: 6,
      uncertainty: "夹具，不是生产行情。", unconfirmed: false, quote_fetched_at: "2026-11-07T02:00:00.000Z",
      quote_last_date: "2026-10-30", stale: true, gaps: [],
    };
    const opt = chartOption(bars, summary, "#ff0000", "#00aa00", "#888888", "#333", "#222");
    const monday = opt.tooltip.formatter([{ dataIndex: 1, axisValue: "2026-10-26", seriesName: "成交量" }]);
    assert.match(monday, /2026-10-26/);
    assert.match(monday, /\+10\.00%/);
    assert.match(monday, /color:#ff0000/);
    assert.match(monday, /成交量/);
    assert.doesNotMatch(monday, /2026-10-23|2026-10-27|暂无/);
    const anchor = opt.tooltip.formatter([{ dataIndex: 0, axisValue: "2026-10-23", seriesName: "前复权" }]);
    assert.match(anchor, /触及后守住/);
    assert.match(anchor, /暂无/);
    assert.doesNotMatch(anchor, /\+10\.00%/);
    const zoomFirst = opt.tooltip.formatter([{ dataIndex: 4 }]);
    assert.match(zoomFirst, /2026-10-29/);
    assert.match(zoomFirst, /\+2\.00%/);
    assert.doesNotMatch(zoomFirst, /暂无/);
    assert.equal(tipBarIndex([{ dataIndex: 0, axisValue: "2026-10-30", seriesName: "成交量" }], bars), 5);
    assert.equal(tipBarIndex([{ seriesName: "成交量", dataIndex: 2, axisValue: "2026-10-27" }, { seriesName: "前复权", dataIndex: 2, axisValue: "2026-10-27" }], bars), 2);
    assert.equal(tipBarIndex([{ dataIndex: 1, axisValue: "2026-10-26" }, { dataIndex: 4, axisValue: "2026-10-29" }], bars), -1);

    const other = chartOption(bars.map((b, i) => ({ ...b, close: i === 0 ? 20 : 10 })), { ...summary, symbol: "600009", name: "测试丙" }, "#ff0000", "#00aa00", "#888888", "#333", "#222");
    const foreign = other.tooltip.formatter([{ dataIndex: 1, axisValue: "2026-10-26" }]);
    assert.match(foreign, /-50\.00%/);
    assert.doesNotMatch(foreign, /\+10\.00%/);

    const live = chartOption(bars, { ...summary, unconfirmed: true }, "#ff0000", "#00aa00", "#888888", "#333", "#222");
    const last = live.tooltip.formatter([{ dataIndex: bars.length - 1, axisValue: "2026-10-30", seriesName: "成交量" }]);
    assert.match(last, /未收盘，暂估/);
    assert.match(last, /0\.00%（暂估）/);
    assert.match(last, /color:#888888/);
    assert.doesNotMatch(last, /color:#ff0000|color:#00aa00/);
    const earlier = live.tooltip.formatter([{ dataIndex: 2, axisValue: "2026-10-27" }]);
    assert.match(earlier, /-5\.00%/);
    assert.doesNotMatch(earlier, /暂估/);
  });
});

test("联合筛选留下对应状态，详情分列三项依据", async () => {
  await withRenderer(async (r) => {
    const mod = await r.load("/src/verticals/finance/pages/LimitWatch.tsx");
    const { LimitWatchBody, filterRows, pickSelection } = mod;
    const noop = () => {};
    const v = view();
    v.symbols = [
      stock({ symbol: "600001", name: "测试甲", joint: jointOf("aligned") }),
      stock({ symbol: "600002", name: "测试乙", tendency: "no_quote", joint: jointOf("conflict") }),
    ];
    const kept = filterRows(v.symbols, "active", "conflict");
    assert.deepEqual(kept.map((s: { symbol: string }) => s.symbol), ["600002"]);
    assert.equal(pickSelection("600001", kept), "600002");
    assert.equal(filterRows(v.symbols, "active", "aligned").length, 1);
    const html = textOf(r.html(LimitWatchBody, {
      v, message: null, selected: "600001", detail: { ...v.symbols[0], bars: [], adjust: null }, detailState: "missing",
      onSelect: noop, onEnroll: noop, onRefresh: noop, busy: false,
    }));
    assert.match(html, /联合条件满足/);
    assert.match(html, /市场环境/);
    assert.match(html, /板块持续性/);
    assert.match(html, /个股回踩/);
    assert.match(html, /夹具不提供真实家数/);
    assert.match(html, /不是买卖建议/);
    assert.doesNotMatch(html, /建议买入|胜率已验证/);
  });
});
