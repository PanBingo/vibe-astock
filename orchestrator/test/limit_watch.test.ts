// 涨停观察池：入池完整性和幂等、多锚点、回踩/跌破/二次启动、证据相反、复权边界。夹具不进生产。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import "../src/finance/register_tasks.ts";
import type { ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { analyzeSymbol, linkLaunches, quoteFreshness, refreshPlan, splitUnconfirmed } from "../src/finance/limit_watch/analyze.ts";
import { snapshotKey } from "../src/snapshot.ts";
import { acceptPool, clashingDay, enrollDay, enrollGate } from "../src/finance/limit_watch/enroll.ts";
import { barsFromEnvelope } from "../src/finance/limit_watch/quotes.ts";
import { mergeEntries, readPool, resetPoolChain } from "../src/finance/limit_watch/store.ts";
import type { AnchorEntry, QfqBar, QuoteCache } from "../src/finance/limit_watch/types.ts";
import { limitWatchView } from "../src/finance/limit_watch/view.ts";

const DAY = "2026-10-13";
const signal = new AbortController().signal;
const sh = (hm: string, day = DAY) => new Date(`${day}T${hm.length === 5 ? `${hm}:00` : hm}+08:00`);

function tmp(): ServiceContext {
  return { repoRoot: process.cwd(), dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-pool-")), python: "python3", node: process.execPath };
}
const bar = (date: string, close: number, volume: number | null, high = close, low = close): QfqBar =>
  ({ date, open: close, high, low, close, volume });

function entry(partial: Partial<AnchorEntry> & { symbol: string; trade_date: string }): AnchorEntry {
  return {
    name: "甲", industry: "半导体", boards: 1, first_seal: "09:35:00", source: "em_zt_pool", pool_qdate: partial.trade_date,
    enrolled_at: "2026-10-13T08:00:00.000Z", role: "launch", launch_date: partial.trade_date, ...partial,
  };
}

function poolDoc(date: string, codes: { c: string; n: string; lbc: number }[]) {
  return { data: { qdate: date.replace(/-/g, ""), pool: codes.map((x) => ({ ...x, hybk: "半导体", fbt: 93500 })) } };
}

test("空池、行情日不对、炸板式空列表都不入池；完整名单一次写全且重跑不丢", async () => {
  assert.match(acceptPool({ data: { qdate: "20261013", pool: [] } }, DAY).ok ? "" : (acceptPool({ data: { qdate: "20261013", pool: [] } }, DAY) as { reason: string }).reason, /空的/);
  const mismatch = acceptPool({ data: { qdate: "20261010", pool: [{ c: "600000", n: "浦发", lbc: 1 }] } }, DAY);
  assert.equal(mismatch.ok, false);
  const many = Array.from({ length: 40 }, (_, i) => ({ c: String(600000 + i).padStart(6, "0"), n: `股${i}`, lbc: i === 3 ? 2 : 1 }));
  const ok = acceptPool(poolDoc(DAY, many), DAY);
  assert.equal(ok.ok && ok.stocks.length, 40);
  const ctx = tmp();
  resetPoolChain();
  const fetch = async () => ({ envelope: { status: "ok", evidence: [{ raw_ref: "raw/pool.json" }] }, out_dir: ctx.dataRoot });
  fs.mkdirSync(path.join(ctx.dataRoot, "raw"), { recursive: true });
  fs.writeFileSync(path.join(ctx.dataRoot, "raw", "pool.json"), JSON.stringify(poolDoc(DAY, many)));
  const first = await enrollDay(ctx, DAY, { now: sh("15:40"), signal, fetch: fetch as never });
  assert.equal(first.outcome, "enrolled");
  assert.equal(first.added, 40);
  assert.equal(first.total, 40);
  const again = await enrollDay(ctx, DAY, { now: sh("16:00"), signal, fetch: fetch as never });
  assert.equal(again.added, 0);
  assert.equal(readPool(ctx).entries.length, 40);
  const older = "2026-10-10";
  fs.writeFileSync(path.join(ctx.dataRoot, "raw", "pool.json"), JSON.stringify(poolDoc(older, [{ c: "600001", n: "龙头", lbc: 1 }])));
  const past = await enrollDay(ctx, older, { now: sh("15:40"), signal, fetch: fetch as never });
  assert.equal(past.added, 1);
  assert.ok(readPool(ctx).entries.some((e) => e.trade_date === older && e.symbol === "600001"));
  assert.equal(readPool(ctx).entries.filter((e) => e.trade_date === DAY).length, 40, "补旧日期不会改写成今天，也不会删掉今天");
  const early = await enrollDay(ctx, DAY, { now: sh("10:00"), signal, fetch: async () => { throw new Error("不该取数"); } });
  assert.equal(early.outcome, "skipped");
  assert.match(early.message, /没收盘/);
  fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
});

test("多次涨停保留锚点，后续板找不到启动日就不冒充", () => {
  const a = entry({ symbol: "600000", trade_date: "2026-10-09", boards: 1 });
  const b = entry({ symbol: "600000", trade_date: "2026-10-10", boards: 2, role: "launch", launch_date: "2026-10-10" });
  const linked = linkLaunches([b, a]);
  assert.equal(linked.length, 2);
  assert.equal(linked.find((e) => e.trade_date === "2026-10-10")?.launch_date, "2026-10-09");
  assert.equal(linked.find((e) => e.trade_date === "2026-10-10")?.role, "follow");
  const onlyFollow = linkLaunches([entry({ symbol: "600000", trade_date: "2026-10-10", boards: 3 })]);
  assert.equal(onlyFollow[0]?.launch_date, null);
  const merged = mergeEntries([], "2026-10-09", [{ symbol: "600000", name: "甲", industry: "半导体", boards: 1, first_seal: null }], "2026-10-09", "t1");
  const again = mergeEntries(merged.entries, "2026-10-09", [{ symbol: "600000", name: "甲", industry: "半导体", boards: 1, first_seal: null }], "2026-10-09", "t2");
  assert.equal(again.added, 0);
  assert.equal(again.entries[0]?.enrolled_at, "t1");
});

test("接近、跌破、二次启动、证据相反、样本不足、缺失锚点和未收线", () => {
  const launch = entry({ symbol: "600000", trade_date: "2026-10-01" });
  const bars = [
    bar("2026-10-01", 10, 100),
    bar("2026-10-02", 10.8, 80, 11),
    bar("2026-10-03", 10.6, 40, 10.7, 10.4),
    bar("2026-10-06", 10.2, 30, 10.3, 10.05),
    bar("2026-10-07", 10.1, 30, 10.2, 10.0),
  ];
  const near = analyzeSymbol([launch], { symbol: "600000", adjust: "qfq", fetched_at: "2026-10-07T08:00:00.000Z", bars, gap: null }, "2026-10-08", "18:00");
  assert.ok(near.marks.some((m) => m.kind === "near"));
  assert.equal(near.marks.find((m) => m.kind === "near")?.anchor_close, 10);
  assert.equal(near.tendency, "shakeout");
  const brokenBars = bars.map((b, i) => i === bars.length - 1 ? bar(b.date, 9, 30, 9.2, 8.8) : b);
  const broken = analyzeSymbol([launch], { symbol: "600000", adjust: "qfq", fetched_at: "2026-10-07T08:00:00.000Z", bars: brokenBars, gap: null }, "2026-10-08", "18:00");
  assert.ok(broken.marks.some((m) => m.kind === "broken"));
  assert.equal(broken.tendency, "conflict");
  const rebound = [
    bar("2026-10-01", 10, 100),
    bar("2026-10-02", 11, 80, 11.5, 10.6),
    bar("2026-10-03", 10.2, 30, 10.4, 10),
    bar("2026-10-06", 11.4, 90, 11.4, 10.5),
  ];
  const second = analyzeSymbol([launch], { symbol: "600000", adjust: "qfq", fetched_at: "2026-10-08T08:00:00.000Z", bars: rebound, gap: null }, "2026-10-09", "18:00");
  assert.ok(second.marks.some((m) => m.kind === "second_start"), second.marks.map((m) => m.kind).join(","));
  const short = analyzeSymbol([launch], { symbol: "600000", adjust: "qfq", fetched_at: "t", bars: bars.slice(0, 3), gap: null }, "2026-10-08", "18:00");
  assert.equal(short.tendency, "insufficient");
  assert.match(short.gaps.join(""), /少于 3 根/);
  const missing = analyzeSymbol([launch], { symbol: "600000", adjust: "qfq", fetched_at: "t", bars: bars.slice(1), gap: null }, "2026-10-08", "18:00");
  assert.match(missing.gaps.join(""), /锚点缺失/);
  const restated = [
    bar("2026-10-01", 8, 100, 8.1, 7.9),
    bar("2026-10-02", 8.8, 40, 9, 8.6),
    bar("2026-10-03", 8.4, 30, 8.5, 8.3),
    bar("2026-10-06", 8.1, 30, 8.2, 8),
    bar("2026-10-07", 8.05, 30, 8.1, 8),
  ];
  const used = analyzeSymbol([launch], { symbol: "600000", adjust: "qfq", fetched_at: "t", bars: restated, gap: null }, "2026-10-08", "18:00");
  assert.equal(used.marks.find((m) => m.anchor_close)?.anchor_close, 8, "重述后的前复权收盘才是锚点");
  const badAdj = analyzeSymbol([launch], { symbol: "600000", adjust: "none", fetched_at: "t", bars, gap: null } as QuoteCache, "2026-10-08", "18:00");
  assert.match(badAdj.tendency_text, /复权/);
  const live = [...bars, bar("2026-10-08", 12, 200, 12.2, 11)];
  const { confirmed, unconfirmed } = splitUnconfirmed(live, "2026-10-08", "10:30");
  assert.equal(unconfirmed?.date, "2026-10-08");
  assert.equal(confirmed.at(-1)?.date, "2026-10-07");
  const intraday = analyzeSymbol([launch], { symbol: "600000", adjust: "qfq", fetched_at: "t", bars: live, gap: null }, "2026-10-08", "10:30");
  assert.equal(intraday.unconfirmed, true);
  assert.ok(!intraday.marks.some((m) => m.kind === "second_start"));
  assert.match(intraday.gaps.join(""), /还没收盘/);
});

test("自动更新只覆盖跟踪中且过期的有限名单，读页面不写盘", () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry({ symbol: String(600000 + i).padStart(6, "0"), trade_date: "2026-10-01", name: `股${i}` }));
  entries.push(entry({ symbol: "600100", trade_date: "2026-01-01", name: "旧" }));
  const fresh: QuoteCache = { symbol: "600000", adjust: "qfq", fetched_at: "2026-10-13T07:00:00.000Z", bars: [bar("2026-10-10", 10, 1)], gap: null };
  const plan = refreshPlan(entries, [fresh], "2026-10-13", Date.parse("2026-10-13T08:00:00.000Z"), 8);
  assert.equal(plan.length, 8);
  assert.ok(!plan.includes("600000"));
  assert.ok(!plan.includes("600100"));
  const ctx = tmp();
  const view = limitWatchView(ctx, {}, signal, sh("12:00", "2026-11-07"));
  assert.equal(view.symbols.length, 0);
  assert.equal(fs.existsSync(path.join(ctx.dataRoot, "limit-watch", "pool.json")), false);
  assert.ok(listViews().some((v) => v.id === "limit_watch"));
  assert.match(enrollGate("2026-11-07", "2026-11-07", "10:00") ?? "", /没收盘/);
  assert.equal(enrollGate("2026-11-08", "2026-11-07", "16:00"), "还没到的日期不入池");
  const parsed = barsFromEnvelope({ status: "ok", extra: { adjust: "qfq" } }, { rows: [{ date: "2026-10-01", open: 1, high: 1.1, low: 0.9, close: 1, volume: 10, adjust: "qfq" }] });
  assert.equal(parsed.ok && parsed.bars[0]?.close, 1);
  const mixed = barsFromEnvelope({ status: "ok", extra: { adjust: "qfq" } }, { rows: [{ date: "2026-10-01", open: 1, high: 1, low: 1, close: 1, volume: 1, adjust: "none" }] });
  assert.equal(mixed.ok, false);
  fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
});

test("历史涨停池：qdate 仍是最新行情日也按请求日入池；晚于 qdate、空池、名单撞日都不写；后补启动板能接上", async () => {
  const hist = acceptPool({ data: { qdate: "20261106", pool: [{ c: "002086", n: "东方海洋", lbc: 1 }, { c: "600000", n: "甲", lbc: 2 }] } }, "2026-10-19");
  assert.equal(hist.ok, true);
  if (hist.ok) {
    assert.equal(hist.stocks.length, 2);
    assert.equal(hist.qdate, "2026-11-06");
  }
  const future = acceptPool({ data: { qdate: "20261106", pool: [{ c: "600000", n: "甲", lbc: 1 }] } }, "2026-11-07");
  assert.equal(future.ok, false);
  assert.match(future.ok ? "" : future.reason, /晚于上游最新行情日/);
  const empty = acceptPool({ data: { qdate: "20261106", pool: [] } }, "2026-10-13");
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? "" : empty.reason, /空的/);
  assert.notEqual(snapshotKey("em_zt_pool", "MARKET", { date: "20261019" }), snapshotKey("em_zt_pool", "MARKET", { date: "20261106" }));
  const ctx = tmp();
  resetPoolChain();
  const docs = new Map<string, unknown>([
    ["20261102", { data: { qdate: "20261106", pool: [{ c: "002086", n: "东方海洋", lbc: 3, hybk: "农业", fbt: 93200 }] } }],
    ["20261019", { data: { qdate: "20261106", pool: [{ c: "002086", n: "东方海洋", lbc: 1, hybk: "农业", fbt: 93100 }, { c: "600001", n: "乙", lbc: 1, hybk: "银行", fbt: 100000 }] } }],
    ["20261106", { data: { qdate: "20261106", pool: [{ c: "002086", n: "东方海洋", lbc: 3, hybk: "农业", fbt: 93200 }] } }],
  ]);
  fs.mkdirSync(path.join(ctx.dataRoot, "raw"), { recursive: true });
  const fetch = async (_c: unknown, req: { args?: { date?: string } }) => {
    const key = req.args?.date ?? "";
    fs.writeFileSync(path.join(ctx.dataRoot, "raw", "pool.json"), JSON.stringify(docs.get(key)));
    return { envelope: { status: "ok", evidence: [{ raw_ref: "raw/pool.json" }] }, out_dir: ctx.dataRoot };
  };
  const later = await enrollDay(ctx, "2026-11-02", { now: sh("16:00", "2026-11-07"), signal, fetch: fetch as never });
  assert.equal(later.added, 1);
  assert.equal(readPool(ctx).entries[0]?.launch_date, null, "先入的 3 板还没有启动日");
  const firstAt = readPool(ctx).entries[0]?.enrolled_at;
  const earlier = await enrollDay(ctx, "2026-10-19", { now: sh("16:10", "2026-11-07"), signal, fetch: fetch as never });
  assert.equal(earlier.added, 2);
  const rows = readPool(ctx).entries.filter((e) => e.symbol === "002086").sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  assert.deepEqual(rows.map((e) => e.trade_date), ["2026-10-19", "2026-11-02"]);
  assert.equal(rows[1]?.launch_date, "2026-10-19");
  assert.equal(rows[1]?.enrolled_at, firstAt, "补启动日不改第一次入池时间");
  assert.equal(readPool(ctx).entries.length, 3);
  const clash = await enrollDay(ctx, "2026-11-06", { now: sh("16:20", "2026-11-07"), signal, fetch: fetch as never });
  assert.equal(clash.outcome, "incomplete");
  assert.match(clash.message, /2026-11-02/);
  assert.equal(readPool(ctx).entries.length, 3, "名单撞日不新增");
  assert.equal(clashingDay(readPool(ctx).entries, "2026-11-06", ["002086"]), "2026-11-02");
  fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
});

test("最后行情日和取数时间分开；早于查看日超过 3 天标陈旧，不写成停牌", () => {
  const old = quoteFreshness("2026-11-02", "2026-11-07", "2026-11-07T02:00:00.000Z");
  assert.equal(old.stale, true);
  assert.match(old.note, /最后一根日 K 是 2026-11-02/);
  assert.match(old.note, /取数时间 2026-11-07T02:00/);
  assert.match(old.note, /看不出来/);
  assert.doesNotMatch(old.note, /因停牌|已停牌/);
  const friday = quoteFreshness("2026-11-06", "2026-11-07", "2026-11-07T02:00:00.000Z");
  assert.equal(friday.stale, false);
  assert.match(friday.note, /不是行情日/);
});

test("历史锚点用截至最近收盘的截面，不把这当成无前视回测", () => {
  const launch = entry({ symbol: "002086", trade_date: "2026-10-19", name: "东方海洋" });
  const bars = [
    bar("2026-10-19", 10, 100, 10.1, 9.2),
    bar("2026-10-20", 11.2, 80, 11.4, 10.4),
    bar("2026-10-21", 10.15, 25, 10.4, 10),
    bar("2026-10-22", 10.05, 20, 10.2, 9.95),
    bar("2026-11-06", 10.08, 22, 10.2, 9.98),
  ];
  const view = analyzeSymbol([launch], { symbol: "002086", adjust: "qfq", fetched_at: "2026-11-07T08:00:00.000Z", bars, gap: null }, "2026-11-07", "16:00");
  assert.ok(view.marks.some((m) => m.kind === "near"));
  assert.equal(view.marks.find((m) => m.kind === "near")?.anchor_close, 10);
  assert.equal("win_rate" in view, false);
  assert.match(view.uncertainty, /不推断主力意图/);
});
