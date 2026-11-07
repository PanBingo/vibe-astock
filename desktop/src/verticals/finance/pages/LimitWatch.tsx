/**
 * 涨停回调观察池。打开页面只读；纳入和更新行情都是明确的按钮。
 * 二次启动是观察候选，不是买卖建议。
 */
import { useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { backend } from "@/lib/backend";
import { PageHeader } from "@/components/ui/PageHeader";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import { useAiPage } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";
import type { LimitWatchView, QfqBar, SymbolSummary } from "@/lib/limitWatch";

const MARK: Record<string, string> = { near: "接近启动板", broken: "跌破", held: "触及后守住", second_start: "二次启动候选", still_at_board: "仍在涨停价附近" };
const TEND: Record<SymbolSummary["tendency"], string> = {
  shakeout: "震仓回调倾向", distribution: "出货风险倾向", conflict: "证据相反", insufficient: "样本不足", no_quote: "没有行情",
};

function money(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(2);
}

export function chartOption(bars: QfqBar[], summary: SymbolSummary, rise: string, fall: string, text: string, axis: string) {
  const launch = summary.marks.find((m) => m.kind === "near" || m.kind === "broken" || m.kind === "held" || m.kind === "still_at_board") ?? summary.marks[0];
  const dates = bars.map((b) => b.date);
  const candles = bars.map((b) => [b.open, b.close, b.low, b.high]);
  const volumes = bars.map((b) => ({ value: b.volume ?? "-", itemStyle: { color: b.close >= b.open ? rise : fall, opacity: 0.7 } }));
  const markLine = launch ? {
    symbol: "none",
    data: [
      { yAxis: launch.anchor_close, name: "启动板收盘", lineStyle: { color: rise } },
      { yAxis: launch.band_low, name: "下沿", lineStyle: { type: "dashed", color: text } },
      { yAxis: launch.band_high, name: "上沿", lineStyle: { type: "dashed", color: text } },
    ],
    label: { color: text, fontSize: 10 },
  } : undefined;
  return {
    animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: { trigger: "axis" },
    grid: [{ left: 64, right: 16, top: 28, height: "58%" }, { left: 64, right: 16, top: "74%", height: "14%" }],
    xAxis: [
      { type: "category", data: dates, boundaryGap: true, axisLabel: { show: false }, axisLine: { lineStyle: { color: axis } } },
      { type: "category", gridIndex: 1, data: dates, boundaryGap: true, axisLabel: { color: text, fontSize: 10 }, axisLine: { lineStyle: { color: axis } } },
    ],
    yAxis: [
      { type: "value", scale: true, axisLabel: { color: text, fontSize: 10 } },
      { type: "value", gridIndex: 1, splitNumber: 2, axisLabel: { color: text, fontSize: 10 } },
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], startValue: Math.max(0, dates.length - 80) }, { type: "slider", xAxisIndex: [0, 1], height: 16, bottom: 8 }],
    series: [
      { name: "前复权", type: "candlestick", data: candles, markLine, itemStyle: { color: rise, color0: fall, borderColor: rise, borderColor0: fall } },
      { name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: volumes },
    ],
  };
}

export function LimitWatchBody({ v, message, onPick, onEnroll, onRefresh, busy }: {
  v: LimitWatchView;
  message: string | null;
  onPick: (symbol: string) => void;
  onEnroll: (date: string) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const palette = usePalette();
  const [filter, setFilter] = useState<"active" | "paused" | "near" | "second">("active");
  const [date, setDate] = useState(v.as_of);
  const rows = v.symbols.filter((s) => {
    if (filter === "active") return s.status === "active";
    if (filter === "paused") return s.status === "paused";
    if (filter === "near") return s.marks.some((m) => m.kind === "near" || m.kind === "held");
    return s.marks.some((m) => m.kind === "second_start");
  });
  const option = useMemo(() => (v.detail && v.detail.bars.length ? chartOption(v.detail.bars, v.detail, palette.rise, palette.fall, palette.text, palette.axis) : null), [v.detail, palette]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-muted-foreground">
          补纳入交易日
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent text-foreground outline-none [color-scheme:dark]" />
        </label>
        <button type="button" disabled={busy || !v.enabled} onClick={() => onEnroll(date)} className="rounded-lg border border-border/60 px-2.5 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50">纳入这一天的涨停</button>
        <button type="button" disabled={busy || !v.enabled} onClick={onRefresh} className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-2.5 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50"><RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} /> 更新跟踪中的日 K</button>
        <a href="/daily-review" className="text-muted-foreground hover:text-foreground">返回每日复盘</a>
      </div>
      <p role="status" className="text-[13px] text-muted-foreground">{v.as_of} {v.clock} · 池内 {v.symbols.length} 只 · 价格带 ±{(v.near_pct * 100).toFixed(0)}% · 前复权收盘价为锚点。{v.disabled_reason ?? ""}{message ? ` ${message}` : ""}</p>
      <p className="text-[12px] leading-relaxed text-muted-foreground">{v.rules}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {([["active", "跟踪中"], ["paused", "停更"], ["near", "接近启动板"], ["second", "二次启动候选"]] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setFilter(key)} className={cn("rounded-lg border px-2 py-1", filter === key ? "border-primary text-foreground" : "border-border/60 text-muted-foreground")}>{label}</button>
        ))}
      </div>
      {!rows.length ? <p className="text-sm text-muted-foreground">{v.symbols.length ? "这个筛选下没有股票。" : "观察池还是空的。交易日收盘后会自动纳入当天完整涨停池；当时程序没开，可以用上面的日期补纳入。休市不会造记录。"}</p> : (
        <div className="overflow-x-auto">
          <table aria-label="涨停观察池" className="w-full text-left text-[12px]">
            <thead className="text-[11px] text-muted-foreground"><tr>{["名称", "最近入池", "启动日", "状态", "标记", "倾向"].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.symbol} className="cursor-pointer border-t border-border/40" onClick={() => onPick(s.symbol)}>
                  <td className="px-2 py-1"><b>{s.name}</b> <span className="font-mono text-muted-foreground">{s.symbol}</span></td>
                  <td className="px-2 py-1 font-mono">{s.latest_entry} · {s.entries} 次</td>
                  <td className="px-2 py-1 font-mono">{s.launch_dates.join("、") || "缺失"}{s.missing_launch ? " · 有后续板没有启动日" : ""}</td>
                  <td className="px-2 py-1">{s.status === "active" ? "跟踪中" : "停更"}{s.unconfirmed ? " · 最后一根未收盘" : ""}{s.stale ? " · 行情偏旧" : ""}</td>
                  <td className="px-2 py-1">{s.marks.map((m) => MARK[m.kind] ?? m.kind).join("、") || "—"}</td>
                  <td className="px-2 py-1">{TEND[s.tendency]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {v.detail && (
        <section className="rounded-lg border border-border/60 p-3">
          <h3 className="mb-1 text-sm font-semibold">{v.detail.name} {v.detail.symbol}</h3>
          <p className="text-[13px]">{v.detail.tendency_text}</p>
          <p className="mt-1 text-[12px] text-muted-foreground">样本 {v.detail.sample_bars} 根已收盘 K 线。行情时间 {v.detail.quote_fetched_at ?? "没有"}，最后一根 {v.detail.quote_last_date ?? "—"}。{v.detail.uncertainty}</p>
          {v.detail.evidence.length > 0 && <ul className="mt-2 list-disc pl-4 text-[12px]">{v.detail.evidence.map((e) => <li key={e}>证据：{e}</li>)}</ul>}
          {v.detail.counter.length > 0 && <ul className="mt-1 list-disc pl-4 text-[12px]">{v.detail.counter.map((e) => <li key={e}>反证：{e}</li>)}</ul>}
          {v.detail.marks.map((m) => <p key={`${m.kind}-${m.anchor_date}`} className="mt-1 text-[12px]">{MARK[m.kind]} · 锚点 {m.anchor_date} 前复权收盘 {money(m.anchor_close)}，带 {money(m.band_low)}–{money(m.band_high)}。{m.text}</p>)}
          {v.detail.gaps.map((g) => <p key={g} role="status" className="mt-1 text-[12px] text-warning">{g}</p>)}
          {option ? <EChart option={option} height={420} /> : <p className="mt-2 text-[13px] text-muted-foreground">这只还没有可画的前复权 K 线。{v.detail.gaps[0] ?? ""}</p>}
        </section>
      )}
      {v.gaps.map((g) => <p key={g} role="status" className="text-[12px] text-warning">{g}</p>)}
      <p className="text-[11px] text-muted-foreground">来源：{v.source}</p>
    </div>
  );
}

export function limitWatchSummary(v: LimitWatchView): string {
  const near = v.symbols.filter((s) => s.marks.some((m) => m.kind === "near"));
  return [`涨停观察池 ${v.as_of}，${v.symbols.length} 只。锚点是涨停日前复权收盘价。`, near.length ? `接近启动板：${near.map((s) => `${s.name}(${s.symbol})`).join("、")}` : "没有接近启动板的标记。", "二次启动只是观察候选，不是买卖建议。没有资金流结论。"].join("\n");
}

export function LimitWatch() {
  const [data, setData] = useState<LimitWatchView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (symbol?: string) => {
    setBusy(true);
    backend.limitWatch<LimitWatchView>(symbol).then((v) => { setData(v); setError(null); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "没取到")).finally(() => setBusy(false));
  };
  useEffect(() => { load(); }, []);
  useAiPage(data ? { key: "limit-watch", title: `涨停观察池 ${data.as_of}`, context: limitWatchSummary(data), suggestions: ["哪些票回到了启动板价格带", "证据和反证为什么相反", "哪些是未收盘的 K 线"] } : null);
  return (
    <div>
      <PageHeader title="涨停观察池" subtitle="收盘确认的涨停写入池里，用来看回踩启动板和二次启动线索。不是必涨，也不是交易建议。" actions={<Activity className="h-4 w-4 text-primary" />} />
      {error && <p role="status" className="mb-3 text-sm text-muted-foreground">{error}</p>}
      {!data ? <p role="status" className="text-sm text-muted-foreground">观察池加载中…</p> : (
        <LimitWatchBody v={data} message={message} busy={busy} onPick={(symbol) => load(symbol)} onEnroll={(date) => {
          setBusy(true);
          backend.limitWatchAct<LimitWatchView & { message: string }>({ action: "enroll", date }).then((v) => { setData(v); setMessage(v.message); setError(null); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "没写入")).finally(() => setBusy(false));
        }} onRefresh={() => {
          setBusy(true);
          backend.limitWatchAct<LimitWatchView & { message: string }>({ action: "refresh" }).then((v) => { setData(v); setMessage(v.message); setError(null); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "没更新")).finally(() => setBusy(false));
        }} />
      )}
      <Disclaimer />
    </div>
  );
}
