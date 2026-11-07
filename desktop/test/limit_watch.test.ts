// 观察池页面：夹具渲染标记、证据相反和未收盘，不请求生产接口。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { LimitWatchView } from "../src/verticals/finance/lib/limitWatch.ts";

const view = (): LimitWatchView => ({
  enabled: true, disabled_reason: null, as_of: "2026-10-13", clock: "18:00:00", near_pct: 0.03,
  rules: "锚点是该涨停日在同一条前复权序列里的收盘价。不推断主力意图。",
  symbols: [{
    symbol: "600000", name: "浦发银行", industry: "银行", status: "active", entries: 2, latest_entry: "2026-10-10",
    launch_dates: ["2026-10-09"], missing_launch: false,
    marks: [{ kind: "near", anchor_date: "2026-10-09", anchor_close: 10, band_low: 9.7, band_high: 10.3, distance_pct: 0.01, text: "收盘回到启动板附近。" }],
    tendency: "conflict", tendency_text: "证据相反，不收成单一结论。",
    evidence: ["回调段均量收缩。"], counter: ["收盘跌破下沿。"], sample_bars: 6,
    uncertainty: "样本 6 根。未使用资金流。", unconfirmed: true, quote_fetched_at: "2026-10-13T10:00:00.000Z", quote_last_date: "2026-10-13", stale: false,
    gaps: ["最后一根还没收盘。"],
  }],
  detail: null,
  runs: [], gaps: ["2026-10-12 不完整：涨停池是空的"], source: "东财涨停池；腾讯前复权",
});

test("观察池列出接近启动板、证据相反、未收盘和空池缺口", async () => {
  await withRenderer(async (r) => {
    const { LimitWatchBody } = await r.load("/src/verticals/finance/pages/LimitWatch.tsx");
    const noop = () => {};
    const html = r.html(LimitWatchBody, { v: view(), message: null, onPick: noop, onEnroll: noop, onRefresh: noop, busy: false });
    const text = textOf(html);
    assert.match(text, /浦发银行/);
    assert.match(text, /接近启动板/);
    assert.match(text, /证据相反/);
    assert.match(text, /最后一根未收盘/);
    assert.match(text, /前复权/);
    assert.match(text, /不推断主力意图/);
    assert.match(text, /涨停池是空的/);
    assert.doesNotMatch(text, /建议买入|目标价|必涨/);
  });
});
