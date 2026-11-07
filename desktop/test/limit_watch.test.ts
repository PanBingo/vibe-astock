// 观察池左右联动：用夹具渲染，不请求生产接口，也不把样例当成真实行情。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { LimitWatchView, SymbolSummary } from "../src/verticals/finance/lib/limitWatch.ts";

const stock = (over: Partial<SymbolSummary> & { symbol: string; name: string }): SymbolSummary => ({
  industry: "测试", status: "active", entries: 1, latest_entry: "2026-10-19", launch_dates: ["2026-10-19"], missing_launch: false,
  marks: [], tendency: "insufficient", tendency_text: "样本不足。", evidence: [], counter: [], sample_bars: 0,
  uncertainty: "夹具。", unconfirmed: false, quote_fetched_at: "2026-11-07T02:00:00.000Z", quote_last_date: "2026-11-02", stale: true, gaps: [],
  ...over,
});

const view = (): LimitWatchView => ({
  enabled: true, disabled_reason: null, as_of: "2026-11-07", clock: "13:00:00", near_pct: 0.03,
  rules: "锚点是该涨停日在同一条前复权序列里的收盘价。不推断主力意图。",
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
    assert.match(opt.tooltip.formatter([{ dataIndex: 0 }]), /2026-11-06/);
    assert.match(opt.tooltip.formatter([{ dataIndex: 0 }]), /10\.50/);
    assert.match(opt.tooltip.formatter([{ dataIndex: 0 }]), /成交量/);
    const blank = textOf(r.html(LimitWatchBody, { v: { ...v, symbols: [] }, message: null, selected: null, detail: null, detailState: "idle", onSelect: noop, onEnroll: noop, onRefresh: noop, busy: false }));
    assert.match(blank, /观察池还是空的/);
    assert.doesNotMatch(blank, /测试甲|10\.10/);
  });
});
