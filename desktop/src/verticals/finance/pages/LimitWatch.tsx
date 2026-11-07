/**
 * 涨停回调观察池。左侧点一只，右侧看这只已存的前复权日 K。
 * 点选只读，不触发全池行情刷新。
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
export type WatchFilter = "active" | "paused" | "near" | "second";

function money(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(2);
}

export function filterRows(symbols: SymbolSummary[], filter: WatchFilter): SymbolSummary[] {
  return symbols.filter((s) => {
    if (filter === "active") return s.status === "active";
    if (filter === "paused") return s.status === "paused";
    if (filter === "near") return s.marks.some((m) => m.kind === "near" || m.kind === "held");
    return s.marks.some((m) => m.kind === "second_start");
  });
}

/** 当前选中还在筛选结果里就留着，否则改选第一只；筛空就清空，避免右侧留着已隐藏的股票。 */
export function pickSelection(selected: string | null, rows: SymbolSummary[]): string | null {
  if (selected && rows.some((s) => s.symbol === selected)) return selected;
  return rows[0]?.symbol ?? null;
}

/** 后返回的详情如果不是当前选中的那只，丢掉，避免快速切换时旧图盖住新选股。 */
export function acceptDetail(requested: string, current: string | null, detailSymbol: string | null): boolean {
  return current === requested && (detailSymbol === null || detailSymbol === requested);
}

export function chartOption(bars: QfqBar[], summary: SymbolSummary, rise: string, fall: string, text: string, axis: string, grid: string) {
  const dates = bars.map((b) => b.date);
  const candles = bars.map((b) => [b.open, b.close, b.low, b.high]);
  const volumes = bars.map((b) => ({ value: b.volume ?? "-", itemStyle: { color: b.close >= b.open ? rise : fall, opacity: 0.75 } }));
  const lines = new Map<string, { yAxis: number; name: string }>();
  for (const m of summary.marks) {
    if (!lines.has(m.anchor_date)) lines.set(m.anchor_date, { yAxis: m.anchor_close, name: `${m.anchor_date} 涨停收盘` });
  }
  const markLine = lines.size ? {
    symbol: "none",
    data: [...lines.values(), ...summary.marks.slice(0, 1).flatMap((m) => [
      { yAxis: m.band_low, name: "价格带下沿", lineStyle: { type: "dashed", color: text } },
      { yAxis: m.band_high, name: "价格带上沿", lineStyle: { type: "dashed", color: text } },
    ])],
    label: { color: text, fontSize: 10 },
    lineStyle: { color: rise, width: 1.5 },
  } : undefined;
  const tip = (params: unknown) => {
    const list = Array.isArray(params) ? params : [params];
    const first = list[0] as { dataIndex?: number } | undefined;
    const i = first?.dataIndex ?? -1;
    const b = bars[i];
    if (!b) return "";
    const mark = summary.marks.filter((m) => m.anchor_date === b.date).map((m) => MARK[m.kind] ?? m.kind).join("、");
    const row = (k: string, val: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${k}</span><b>${val}</b></div>`;
    return [`<div style="font-weight:600">${b.date}${mark ? ` · ${mark}` : ""}</div>`,
      row("开", money(b.open)), row("高", money(b.high)), row("低", money(b.low)), row("收", money(b.close)),
      row("成交量", b.volume == null ? "没有" : String(b.volume))].join("");
  };
  return {
    animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: { trigger: "axis", formatter: tip },
    grid: [{ left: 64, right: 16, top: 28, height: "56%" }, { left: 64, right: 16, top: "74%", height: "14%" }],
    xAxis: [
      { type: "category", data: dates, boundaryGap: true, axisLabel: { show: false }, axisLine: { lineStyle: { color: axis } }, splitLine: { show: false } },
      { type: "category", gridIndex: 1, data: dates, boundaryGap: true, axisLabel: { color: text, fontSize: 10 }, axisLine: { lineStyle: { color: axis } } },
    ],
    yAxis: [
      { type: "value", scale: true, axisLabel: { color: text, fontSize: 10 }, splitLine: { lineStyle: { color: grid } } },
      { type: "value", gridIndex: 1, splitNumber: 2, axisLabel: { color: text, fontSize: 10 }, splitLine: { show: false } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1], startValue: Math.max(0, dates.length - 80), zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false },
      { type: "slider", xAxisIndex: [0, 1], height: 18, bottom: 8 },
    ],
    series: [
      { name: "前复权", type: "candlestick", data: candles, barMaxWidth: 14, markLine, itemStyle: { color: rise, color0: fall, borderColor: rise, borderColor0: fall } },
      { name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 14, data: volumes },
    ],
  };
}

export function LimitWatchBody({ v, message, selected, detail, detailState, onSelect, onEnroll, onRefresh, busy }: {
  v: LimitWatchView;
  message: string | null;
  selected: string | null;
  detail: (SymbolSummary & { bars: QfqBar[]; adjust: string | null }) | null;
  detailState: "idle" | "loading" | "ready" | "missing";
  onSelect: (symbol: string | null) => void;
  onEnroll: (date: string) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const palette = usePalette();
  const [filter, setFilter] = useState<WatchFilter>("active");
  const [date, setDate] = useState(v.as_of);
  const rows = filterRows(v.symbols, filter);
  const shown = detail && detail.symbol === selected ? detail : null;
  const option = useMemo(() => (shown && shown.bars.length ? chartOption(shown.bars, shown, palette.rise, palette.fall, palette.text, palette.axis, palette.grid) : null), [shown, palette]);
  useEffect(() => {
    const next = pickSelection(selected, filterRows(v.symbols, filter));
    if (next !== selected) onSelect(next);
  }, [filter, v.symbols, selected, onSelect]);

  const move = (dir: number) => {
    const i = rows.findIndex((s) => s.symbol === selected);
    const next = rows[i + dir];
    if (next) onSelect(next.symbol);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-muted-foreground">
          补纳入交易日
          <input type="date" aria-label="补纳入交易日" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent text-foreground outline-none [color-scheme:dark]" />
        </label>
        <button type="button" disabled={busy || !v.enabled} onClick={() => onEnroll(date)} className="rounded-lg border border-border/60 px-2.5 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50">纳入这一天的涨停</button>
        <button type="button" disabled={busy || !v.enabled} onClick={onRefresh} className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-2.5 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50"><RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} /> 更新跟踪中的日 K</button>
        <a href="/daily-review" className="text-muted-foreground hover:text-foreground">返回每日复盘</a>
      </div>
      <p role="status" className="text-[13px] text-muted-foreground">{v.as_of} {v.clock} · 池内 {v.symbols.length} 只 · 价格带 ±{(v.near_pct * 100).toFixed(0)}% · 前复权收盘价为锚点。点左侧股票只读这只已存的 K 线，不重新抓全池。{v.disabled_reason ?? ""}{message ? ` ${message}` : ""}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {([["active", "跟踪中"], ["paused", "停更"], ["near", "接近启动板"], ["second", "二次启动候选"]] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setFilter(key)} className={cn("rounded-lg border px-2 py-1", filter === key ? "border-primary text-foreground" : "border-border/60 text-muted-foreground")}>{label}</button>
        ))}
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="lg:w-80 lg:shrink-0 lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto" role="listbox" aria-label="观察池股票" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); move(1); } if (e.key === "ArrowUp") { e.preventDefault(); move(-1); } }}>
          {!rows.length ? <p className="text-sm text-muted-foreground">{v.symbols.length ? "这个筛选下没有股票。" : "观察池还是空的。交易日收盘后会自动纳入当天完整涨停池；当时程序没开，可以用上面的日期补纳入。休市不会造记录。"}</p> : rows.map((s) => (
            <button key={s.symbol} type="button" role="option" aria-selected={selected === s.symbol} onClick={() => onSelect(s.symbol)}
              className={cn("mb-1 w-full rounded-lg border px-2 py-1.5 text-left text-[12px]", selected === s.symbol ? "border-primary bg-primary/15 text-foreground" : "border-border/40 text-muted-foreground hover:text-foreground")}>
              <span className="font-medium text-foreground">{s.name}</span> <span className="font-mono">{s.symbol}</span>
              <span className="mt-0.5 block">行情日 {s.quote_last_date ?? "没有"} · {s.marks.map((m) => MARK[m.kind]).join("、") || TEND[s.tendency]}{s.stale ? " · 行情偏旧" : ""}</span>
            </button>
          ))}
        </div>
        <section aria-label="选中股票的 K 线" className="min-w-0 flex-1 rounded-lg border border-border/60 p-3 lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto">
          {!selected || !shown ? (
            <p role="status" className="text-sm text-muted-foreground">{detailState === "loading" ? "正在读取这只已存的日 K，不重新抓全池。" : rows.length ? "还没有这只的详情。" : "没有可显示的股票。"}</p>
          ) : (
            <>
              <h3 className="text-sm font-semibold">{shown.name} {shown.symbol}</h3>
              <p className="mt-1 text-[13px]">{shown.tendency_text}</p>
              <p className={cn("mt-1 text-[12px]", shown.stale && "text-warning")}>最后行情日 {shown.quote_last_date ?? "没有"}。取数时间 {shown.quote_fetched_at ?? "没有"}。两者不是一回事。</p>
              <p className="mt-1 text-[12px] text-muted-foreground">样本 {shown.sample_bars} 根已收盘 K 线。{shown.unconfirmed ? "最后一根未收盘。" : ""}{shown.uncertainty}</p>
              {shown.evidence.map((e) => <p key={e} className="mt-1 text-[12px]">证据：{e}</p>)}
              {shown.counter.map((e) => <p key={e} className="mt-1 text-[12px]">反证：{e}</p>)}
              {shown.marks.map((m) => <p key={`${m.kind}-${m.anchor_date}`} className="mt-1 text-[12px]">{MARK[m.kind]} · 锚点 {m.anchor_date} 前复权收盘 {money(m.anchor_close)}，带 {money(m.band_low)}–{money(m.band_high)}。{m.text}</p>)}
              {shown.gaps.map((g) => <p key={g} role="status" className="mt-1 text-[12px] text-warning">{g}</p>)}
              {option ? <EChart option={option} height={460} /> : <p role="status" className="mt-3 text-[13px] text-muted-foreground">这只没有可画的前复权 K 线。{shown.gaps.find((g) => g.includes("没") || g.includes("限流") || g.includes("不支持") || g.includes("失败")) ?? shown.gaps[0] ?? "没有返回日 K。"}</p>}
            </>
          )}
        </section>
      </div>
      {v.gaps.map((g) => <p key={g} role="status" className="text-[12px] text-warning">{g}</p>)}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{v.rules}</p>
      <p className="text-[11px] text-muted-foreground">来源：{v.source} 成交量是腾讯口径，科创板为股，其余多为手，只在同一只里比较。</p>
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
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<LimitWatchView["detail"]>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "missing">("idle");
  const token = useRef(0);

  const open = (symbol: string | null) => {
    setSelected(symbol);
    setDetail(null);
    if (!symbol) { setDetailState("idle"); return; }
    setDetailState("loading");
    const mine = ++token.current;
    backend.limitWatch<LimitWatchView>(symbol).then((v) => {
      if (!acceptDetail(symbol, symbol, v.detail?.symbol ?? null) || token.current !== mine) return;
      setDetail(v.detail);
      setDetailState(v.detail && v.detail.bars.length ? "ready" : "missing");
    }).catch(() => { if (token.current === mine) setDetailState("missing"); });
  };

  useEffect(() => {
    setBusy(true);
    backend.limitWatch<LimitWatchView>().then((v) => { setData(v); setError(null); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "没取到")).finally(() => setBusy(false));
  }, []);

  useAiPage(data ? { key: "limit-watch", title: `涨停观察池 ${data.as_of}`, context: limitWatchSummary(data), suggestions: ["哪些票回到了启动板价格带", "证据和反证为什么相反", "哪些是未收盘的 K 线"] } : null);
  return (
    <div>
      <PageHeader title="涨停观察池" subtitle="左侧点一只，右侧看它的前复权日 K、启动板价格带和回踩线索。不是必涨，也不是交易建议。" actions={<Activity className="h-4 w-4 text-primary" />} />
      {error && <p role="status" className="mb-3 text-sm text-muted-foreground">{error}</p>}
      {!data ? <p role="status" className="text-sm text-muted-foreground">观察池加载中…</p> : (
        <LimitWatchBody v={data} message={message} busy={busy} selected={selected} detail={detail} detailState={detailState} onSelect={open} onEnroll={(date) => {
          setBusy(true);
          backend.limitWatchAct<LimitWatchView & { message: string }>({ action: "enroll", date }).then((v) => { setData(v); setMessage(v.message); setError(null); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "没写入")).finally(() => setBusy(false));
        }} onRefresh={() => {
          setBusy(true);
          backend.limitWatchAct<LimitWatchView & { message: string }>({ action: "refresh" }).then((v) => { setData(v); setMessage(v.message); setError(null); if (selected) open(selected); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "没更新")).finally(() => setBusy(false));
        }} />
      )}
      <Disclaimer />
    </div>
  );
}
