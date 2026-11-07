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
import type { JointAssessment, JointStatus, LimitWatchView, QfqBar, SymbolSummary } from "@/lib/limitWatch";

const MARK: Record<string, string> = { near: "接近启动板", broken: "跌破", held: "触及后守住", second_start: "二次启动候选", still_at_board: "仍在涨停价附近" };
const TEND: Record<SymbolSummary["tendency"], string> = {
  shakeout: "震仓回调倾向", distribution: "出货风险倾向", conflict: "证据相反", insufficient: "样本不足", no_quote: "没有行情",
};
export type WatchFilter = "active" | "paused" | "near" | "second";
export type JointFilter = "all" | JointStatus;
const JOINT_FILTER: [JointFilter, string][] = [["all", "联合不限"], ["aligned", "联合条件满足"], ["waiting", "等待确认"], ["conflict", "风险或证据冲突"], ["insufficient", "数据不足"]];

function money(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(2);
}

export type ChangeTone = "up" | "down" | "flat" | "missing";

/**
 * 一根 K 线的涨跌幅：当根收盘相对同一条前复权序列里前一根的收盘。
 * 前一根就是上一个实际交易日，中间隔了周末或节假日也用它，不看开盘价。
 * 整段第一根、前收不是有限正数、当根收盘不是有限数，都是「暂无」，不写成 0%。
 */
export function barChange(prevClose: number | null | undefined, close: number | null | undefined): { text: string; tone: ChangeTone } {
  if (typeof close !== "number" || !Number.isFinite(close)) return { text: "暂无", tone: "missing" };
  if (typeof prevClose !== "number" || !Number.isFinite(prevClose) || prevClose <= 0) return { text: "暂无", tone: "missing" };
  const pct = ((close - prevClose) / prevClose) * 100;
  if (!Number.isFinite(pct)) return { text: "暂无", tone: "missing" };
  const digits = pct.toFixed(2);
  const shown = Number(digits);
  if (shown === 0) return { text: "0.00%", tone: "flat" };
  return { text: `${shown > 0 ? "+" : ""}${digits}%`, tone: shown > 0 ? "up" : "down" };
}

/** 下标对应完整已获取序列。缩放只改可见窗口，不把第一根可见柱当成没有前收。 */
export function changeAt(bars: QfqBar[], index: number): { text: string; tone: ChangeTone } {
  if (index <= 0 || index >= bars.length) return barChange(null, bars[index]?.close);
  return barChange(bars[index - 1]?.close, bars[index]?.close);
}

/** 轴触发时按日期对上完整序列；日期对不上就退回双方一致的 dataIndex，避免成交量轴串到别的日子。 */
export function tipBarIndex(params: unknown, bars: { date: string }[]): number {
  const list = (Array.isArray(params) ? params : [params]).filter((p): p is Record<string, unknown> => !!p && typeof p === "object");
  const dates = [...new Set(list.flatMap((p) => {
    const v = p.axisValue ?? p.axisValueLabel ?? p.name;
    return typeof v === "string" && bars.some((b) => b.date === v) ? [v] : [];
  }))];
  if (dates.length === 1) return bars.findIndex((b) => b.date === dates[0]);
  const indexes = [...new Set(list.map((p) => p.dataIndex).filter((i): i is number => typeof i === "number" && i >= 0 && i < bars.length))];
  const only = indexes.length === 1 ? indexes[0] : undefined;
  return only === undefined ? -1 : only;
}

export function filterRows(symbols: (SymbolSummary & { joint?: JointAssessment })[], filter: WatchFilter, joint: JointFilter = "all"): (SymbolSummary & { joint?: JointAssessment })[] {
  return symbols.filter((s) => {
    if (filter === "active" && s.status !== "active") return false;
    if (filter === "paused" && s.status !== "paused") return false;
    if (filter === "near" && !s.marks.some((m) => m.kind === "near" || m.kind === "held")) return false;
    if (filter === "second" && !s.marks.some((m) => m.kind === "second_start")) return false;
    return joint === "all" || s.joint?.status === joint;
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
    const i = tipBarIndex(params, bars);
    const b = bars[i];
    if (!b) return "";
    const mark = summary.marks.filter((m) => m.anchor_date === b.date).map((m) => MARK[m.kind] ?? m.kind).join("、");
    const ch = changeAt(bars, i);
    const provisional = summary.unconfirmed && i === bars.length - 1;
    const color = ch.tone === "up" ? rise : ch.tone === "down" ? fall : text;
    const row = (k: string, val: string, paint?: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${k}</span><b${paint ? ` style="color:${paint}"` : ""}>${val}</b></div>`;
    return [`<div style="font-weight:600">${b.date}${mark ? ` · ${mark}` : ""}${provisional ? " · 未收盘，暂估" : ""}</div>`,
      row("开", money(b.open)), row("高", money(b.high)), row("低", money(b.low)), row("收", money(b.close)),
      row("涨跌幅", provisional ? `${ch.text}（暂估）` : ch.text, color),
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
  detail: (SymbolSummary & { bars: QfqBar[]; adjust: string | null; joint?: JointAssessment }) | null;
  detailState: "idle" | "loading" | "ready" | "missing";
  onSelect: (symbol: string | null) => void;
  onEnroll: (date: string) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const palette = usePalette();
  const [filter, setFilter] = useState<WatchFilter>("active");
  const [jointFilter, setJointFilter] = useState<JointFilter>("all");
  const [date, setDate] = useState(v.as_of);
  const rows = filterRows(v.symbols, filter, jointFilter);
  const shown = detail && detail.symbol === selected ? detail : null;
  const option = useMemo(() => (shown && shown.bars.length ? chartOption(shown.bars, shown, palette.rise, palette.fall, palette.text, palette.axis, palette.grid) : null), [shown, palette]);
  useEffect(() => {
    const next = pickSelection(selected, filterRows(v.symbols, filter));
    if (next !== selected) onSelect(next);
  }, [filter, jointFilter, v.symbols, selected, onSelect]);

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
      <p className="text-[12px] text-muted-foreground">{v.joint_note} 联合状态只排观察优先级，不是买卖建议，也不是胜率。</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {([["active", "跟踪中"], ["paused", "停更"], ["near", "接近启动板"], ["second", "二次启动候选"]] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setFilter(key)} className={cn("rounded-lg border px-2 py-1", filter === key ? "border-primary text-foreground" : "border-border/60 text-muted-foreground")}>{label}</button>
        ))}
        {JOINT_FILTER.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setJointFilter(key)} className={cn("rounded-lg border px-2 py-1", jointFilter === key ? "border-primary text-foreground" : "border-border/60 text-muted-foreground")}>{label}</button>
        ))}
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="lg:w-80 lg:shrink-0 lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto" role="listbox" aria-label="观察池股票" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); move(1); } if (e.key === "ArrowUp") { e.preventDefault(); move(-1); } }}>
          {!rows.length ? <p className="text-sm text-muted-foreground">{v.symbols.length ? "这个筛选下没有股票。" : "观察池还是空的。交易日收盘后会自动纳入当天完整涨停池；当时程序没开，可以用上面的日期补纳入。休市不会造记录。"}</p> : rows.map((s) => (
            <button key={s.symbol} type="button" role="option" aria-selected={selected === s.symbol} onClick={() => onSelect(s.symbol)}
              className={cn("mb-1 w-full rounded-lg border px-2 py-1.5 text-left text-[12px]", selected === s.symbol ? "border-primary bg-primary/15 text-foreground" : "border-border/40 text-muted-foreground hover:text-foreground")}>
              <span className="font-medium text-foreground">{s.name}</span> <span className="font-mono">{s.symbol}</span>
              <span className="mt-0.5 block">行情日 {s.quote_last_date ?? "没有"} · {s.marks.map((m) => MARK[m.kind]).join("、") || TEND[s.tendency]}{s.stale ? " · 行情偏旧" : ""} · {s.joint?.label ?? "数据不足"}</span>
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
              {shown.joint ? (
                <div className="mt-2 space-y-2 rounded-lg border border-border/50 p-2 text-[12px]">
                  <p className="font-medium">{shown.joint.label}</p>
                  <p className="text-muted-foreground">{shown.joint.session_note}</p>
                  {shown.joint.legs.map((leg) => (
                    <div key={leg.key}>
                      <p className="font-medium">{leg.title} · {leg.verdict}</p>
                      {leg.items.map((item) => (
                        <p key={`${leg.key}-${item.label}`} className="text-muted-foreground">
                          {item.label}：{item.value}（{item.at} · {item.source}）
                          {item.counter ? ` 反证：${item.counter}` : ""}{item.fail ? ` ${item.fail}` : ""}
                        </p>
                      ))}
                    </div>
                  ))}
                  {shown.joint.invalidation.map((line) => <p key={line} className="text-muted-foreground">{line}</p>)}
                </div>
              ) : null}
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
  const counts = ["aligned", "waiting", "conflict", "insufficient"].map((k) => `${k === "aligned" ? "满足" : k === "waiting" ? "等待" : k === "conflict" ? "冲突" : "不足"} ${v.symbols.filter((s) => s.joint?.status === k).length}`).join("，");
  return [`涨停观察池 ${v.as_of}，${v.symbols.length} 只。锚点是涨停日前复权收盘价。`, `联合观察（不是买卖建议，也不是胜率）：${counts}。`, near.length ? `接近启动板：${near.map((s) => `${s.name}(${s.symbol})`).join("、")}` : "没有接近启动板的标记。", "二次启动只是观察候选，不是买卖建议。"].join("\n");
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
