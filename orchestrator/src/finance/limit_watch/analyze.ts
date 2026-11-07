/**
 * 涨停回调的纯计算。价格只从调用方给的同一条前复权序列里读，不用条目里存过的旧价格。
 */
import {
  ACTIVE_DAYS, ANCHOR_RULE, MIN_BARS, NEAR_PCT, QUOTE_MAX_AGE_MS, RALLY_MIN_PCT, SECOND_START_PCT, VOLUME_EXPAND, VOLUME_SHRINK,
} from "./config.ts";
import type { AnchorEntry, Mark, QfqBar, QuoteCache, SymbolSummary } from "./types.ts";

const DAY_MS = 86_400_000;

export function daysBetween(earlier: string, later: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(earlier) || !/^\d{4}-\d{2}-\d{2}$/.test(later)) return null;
  const d = Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`);
  return Number.isFinite(d) ? Math.round(d / DAY_MS) : null;
}

export function unsupportedKline(symbol: string): string | null {
  if (!/^\d{6}$/.test(symbol)) return "代码不是 6 位 A 股，不取 K 线";
  if (symbol.startsWith("92") || /^(43|83|87)/.test(symbol)) return "腾讯日 K 不支持北交所，不能在前复权序列上判断回踩";
  return null;
}

/** 把同一只的多次涨停连到各自的启动日。已有条目的入池时间不变；启动日按日期重算，后写入的旧日期也能补上。 */
export function linkLaunches(entries: AnchorEntry[]): AnchorEntry[] {
  const by = new Map<string, AnchorEntry[]>();
  for (const e of entries) {
    const list = by.get(e.symbol) ?? [];
    list.push(e);
    by.set(e.symbol, list);
  }
  const out: AnchorEntry[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.symbol.localeCompare(b.symbol));
    let launch: string | null = null;
    for (const e of list) {
      if (e.boards === 1 || e.boards == null) {
        launch = e.trade_date;
        out.push({ ...e, role: "launch", launch_date: e.trade_date });
      } else {
        out.push({ ...e, role: "follow", launch_date: launch });
      }
    }
  }
  return out.sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.symbol.localeCompare(b.symbol));
}

export function splitUnconfirmed(bars: QfqBar[], asOfDay: string, hm: string): { confirmed: QfqBar[]; unconfirmed: QfqBar | null } {
  if (!bars.length) return { confirmed: [], unconfirmed: null };
  const last = bars[bars.length - 1]!;
  if (last.date === asOfDay && hm < "15:05") return { confirmed: bars.slice(0, -1), unconfirmed: last };
  return { confirmed: bars, unconfirmed: null };
}

function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

interface AnchorJudge {
  marks: Mark[];
  evidence: string[];
  counter: string[];
  sample: number;
  gaps: string[];
}

function judgeAnchor(entry: AnchorEntry, confirmed: QfqBar[], nearPct: number): AnchorJudge {
  const bar = confirmed.find((b) => b.date === entry.trade_date) ?? null;
  if (!bar) {
    return { marks: [], evidence: [], counter: [], sample: 0, gaps: [`${entry.trade_date} 不在这次前复权序列里，锚点缺失，不判断回踩`] };
  }
  const price = bar.close;
  const low = price * (1 - nearPct);
  const high = price * (1 + nearPct);
  const after = confirmed.filter((b) => b.date > entry.trade_date);
  const gaps: string[] = [];
  const evidence: string[] = [];
  const counter: string[] = [];
  const marks: Mark[] = [];
  if (after.length < MIN_BARS) {
    gaps.push(`${entry.trade_date} 之后只有 ${after.length} 根已收盘 K 线，少于 ${MIN_BARS} 根，不判断回调或二次启动`);
    return { marks, evidence, counter, sample: after.length, gaps };
  }
  const latest = after[after.length - 1]!;
  const peak = after.reduce((m, b) => (b.high > m.high ? b : m), after[0]!);
  const hadRally = peak.high >= price * (1 + RALLY_MIN_PCT);
  const afterPeak = after.filter((b) => b.date >= peak.date);
  const trough = afterPeak.reduce((m, b) => (b.low < m.low ? b : m), afterPeak[0]!);
  const distance = latest.close / price - 1;
  const touched = after.some((b) => b.low <= high && b.low >= low);
  if (!hadRally && latest.close <= high && latest.close >= low) {
    marks.push({ kind: "still_at_board", anchor_date: entry.trade_date, anchor_close: price, band_low: low, band_high: high, distance_pct: distance, text: `${entry.trade_date} 之后还没有离开涨停价 ${RALLY_MIN_PCT * 100}% 以上，现在仍在价格带里，先不算回调。` });
  } else if (hadRally && latest.close >= low && latest.close <= high) {
    marks.push({ kind: "near", anchor_date: entry.trade_date, anchor_close: price, band_low: low, band_high: high, distance_pct: distance, text: `收盘 ${latest.close.toFixed(2)} 回到 ${entry.trade_date} 前复权涨停价 ${price.toFixed(2)} 的 ${nearPct * 100}% 带内（${pct(distance)}）。` });
  } else if (latest.close < low) {
    marks.push({ kind: "broken", anchor_date: entry.trade_date, anchor_close: price, band_low: low, band_high: high, distance_pct: distance, text: `收盘 ${latest.close.toFixed(2)} 低于 ${entry.trade_date} 涨停价下沿 ${low.toFixed(2)}，收盘确认跌破。` });
  } else if (hadRally && touched && latest.close >= low) {
    marks.push({ kind: "held", anchor_date: entry.trade_date, anchor_close: price, band_low: low, band_high: high, distance_pct: distance, text: `曾有 K 线低点进入 ${entry.trade_date} 的价格带，最近收盘 ${latest.close.toFixed(2)} 仍在下沿之上。` });
  }
  const drawdown = peak.high > 0 ? trough.low / peak.high - 1 : 0;
  const pullbackVols = afterPeak.filter((b) => b.date <= trough.date).map((b) => b.volume).filter((v): v is number => v != null && v >= 0);
  const avgPullback = mean(pullbackVols);
  const limitVol = bar.volume;
  if (limitVol == null || avgPullback == null) {
    gaps.push(`${entry.trade_date} 或回调段没有成交量，不能用量能区分震仓和出货`);
  } else {
    const ratio = avgPullback / limitVol;
    if (ratio < VOLUME_SHRINK && latest.close >= low) evidence.push(`回调段均量是涨停日的 ${(ratio * 100).toFixed(0)}%，低于 ${VOLUME_SHRINK * 100}%，收盘还在价格带下沿之上。`);
    if (ratio >= VOLUME_EXPAND) counter.push(`回调段均量是涨停日的 ${(ratio * 100).toFixed(0)}%，不低于 ${VOLUME_EXPAND * 100}%。`);
    if (latest.close < low) counter.push(`收盘跌破涨停价下沿，和「缩量守住」相反。`);
    if (ratio < VOLUME_SHRINK && latest.close < low) evidence.push(`回调段均量收缩到涨停日的 ${(ratio * 100).toFixed(0)}%，但收盘已经跌破下沿。`);
  }
  if (drawdown <= -0.05 && drawdown >= -0.25 && latest.close >= low) evidence.push(`自高点 ${peak.date} 回撤 ${pct(drawdown)}，幅度在 5%–25%，最近收盘未跌破下沿。`);
  if (drawdown < -0.15) counter.push(`自高点回撤 ${pct(drawdown)}，超过 15%。`);
  const rebound = trough.low > 0 ? latest.close / trough.low - 1 : 0;
  const leftBand = latest.close > high;
  const reboundVol = latest.volume;
  if (hadRally && (touched || trough.low <= high) && leftBand && rebound >= SECOND_START_PCT && reboundVol != null && avgPullback != null && reboundVol >= avgPullback * VOLUME_EXPAND) {
    marks.push({ kind: "second_start", anchor_date: entry.trade_date, anchor_close: price, band_low: low, band_high: high, distance_pct: distance, text: `自回撤低点 ${trough.date} 的收盘涨了 ${pct(rebound)}，回到价格带上方，最近一根成交量不低于回调段均量的 ${VOLUME_EXPAND} 倍。这是观察候选，不是上涨结论。` });
  } else if (hadRally && leftBand && rebound >= SECOND_START_PCT && (reboundVol == null || avgPullback == null || reboundVol < avgPullback * VOLUME_EXPAND)) {
    gaps.push(`价格离开了 ${entry.trade_date} 的价格带，但最近一根成交量没有放大到回调段的 ${VOLUME_EXPAND} 倍，不标二次启动。`);
  }
  return { marks, evidence, counter, sample: after.length, gaps };
}

export function analyzeSymbol(entries: AnchorEntry[], quote: QuoteCache | null, asOfDay: string, hm: string): SymbolSummary {
  const sorted = [...entries].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  const latest = sorted[sorted.length - 1]!;
  const age = daysBetween(latest.trade_date, asOfDay);
  const status = age != null && age <= ACTIVE_DAYS ? "active" : "paused";
  const launches = sorted.filter((e) => e.role === "launch");
  const missingLaunch = sorted.some((e) => e.role === "follow" && !e.launch_date);
  const base: SymbolSummary = {
    symbol: latest.symbol, name: latest.name, industry: latest.industry, status, entries: sorted.length,
    latest_entry: latest.trade_date, launch_dates: launches.map((e) => e.trade_date), missing_launch: missingLaunch,
    marks: [], tendency: "no_quote", tendency_text: "还没有前复权日 K。", evidence: [], counter: [], sample_bars: 0,
    uncertainty: "没有行情就不能判断回踩。", unconfirmed: false, quote_fetched_at: quote?.fetched_at ?? null,
    quote_last_date: quote?.bars.at(-1)?.date ?? null, stale: false, gaps: [],
  };
  if (missingLaunch) base.gaps.push("有后续涨停板，但观察池里没有更早的启动日，不用后续板的收盘价代替启动板。");
  const blocked = unsupportedKline(latest.symbol);
  if (blocked) return { ...base, gaps: [...base.gaps, blocked], uncertainty: blocked };
  if (!quote || quote.gap || !quote.bars.length) {
    return { ...base, gaps: [...base.gaps, quote?.gap || "行情还没取到"], uncertainty: "行情缺失，不给震仓或出货倾向。" };
  }
  if (quote.adjust !== "qfq") {
    return { ...base, gaps: [...base.gaps, `行情复权是 ${quote.adjust}，不是前复权`], tendency: "insufficient", tendency_text: "复权口径不对，停止判断。", uncertainty: "口径不一致时不比较价格。" };
  }
  const { confirmed, unconfirmed } = splitUnconfirmed(quote.bars, asOfDay, hm);
  const stale = quote.bars.at(-1)?.date != null && daysBetween(quote.bars.at(-1)!.date, asOfDay) != null && daysBetween(quote.bars.at(-1)!.date, asOfDay)! > 10;
  const judges = launches.map((e) => judgeAnchor(e, confirmed, NEAR_PCT));
  const marks = judges.flatMap((j) => j.marks);
  const evidence = judges.flatMap((j) => j.evidence);
  const counter = judges.flatMap((j) => j.counter);
  const gaps = [...base.gaps, ...judges.flatMap((j) => j.gaps)];
  const sample = Math.max(0, ...judges.map((j) => j.sample), 0);
  if (unconfirmed) gaps.push(`最后一根 ${unconfirmed.date} 还没收盘（高低收都可能变），确认只用它前面的已收盘 K 线。`);
  let tendency: SymbolSummary["tendency"] = "insufficient";
  let tendencyText = "样本或证据不够，不给震仓/出货倾向。";
  if (!launches.length) {
    tendencyText = "没有可确认的启动板，不对后续板单独下倾向。";
  } else if (sample < MIN_BARS) {
    tendencyText = `启动板之后已收盘 K 线不足 ${MIN_BARS} 根。`;
  } else if (evidence.length && counter.length) {
    tendency = "conflict";
    tendencyText = "缩量守住和放量跌破（或深度回撤）同时出现，证据相反，不收成单一结论。";
  } else if (evidence.length) {
    tendency = "shakeout";
    tendencyText = "量价更接近「缩量、回撤有限、收盘还在涨停价下沿之上」。这只是倾向，不是主力震仓的证明。";
  } else if (counter.length) {
    tendency = "distribution";
    tendencyText = "量价更接近「放量或收盘跌破涨停价下沿」。这是出货风险倾向，不是确认有人在出货，也不是卖出建议。";
  }
  return {
    ...base, marks, tendency, tendency_text: tendencyText, evidence, counter, sample_bars: sample, gaps, stale, unconfirmed: !!unconfirmed,
    quote_fetched_at: quote.fetched_at, quote_last_date: quote.bars.at(-1)?.date ?? null,
    uncertainty: `${ANCHOR_RULE} 样本 ${sample} 根已收盘 K 线。未使用资金流，不推断主力意图。二次启动只是观察候选。`,
  };
}

export function isActive(entries: AnchorEntry[], asOfDay: string): boolean {
  const latest = entries.map((e) => e.trade_date).sort().at(-1);
  const age = latest ? daysBetween(latest, asOfDay) : null;
  return age != null && age <= ACTIVE_DAYS;
}

/** 只挑跟踪中的、行情过期或缺失的，并且有上限。停更的不在自动名单里。 */
export function refreshPlan(entries: AnchorEntry[], quotes: QuoteCache[], asOfDay: string, nowMs: number, limit: number): string[] {
  const by = new Map<string, AnchorEntry[]>();
  for (const e of entries) by.set(e.symbol, [...(by.get(e.symbol) ?? []), e]);
  const quoteAt = new Map(quotes.map((q) => [q.symbol, q]));
  const due: { symbol: string; at: number }[] = [];
  for (const [symbol, list] of by) {
    if (!isActive(list, asOfDay) || unsupportedKline(symbol)) continue;
    const q = quoteAt.get(symbol);
    const at = q ? Date.parse(q.fetched_at) : 0;
    if (!q || q.gap || !q.bars.length || !Number.isFinite(at) || nowMs - at >= QUOTE_MAX_AGE_MS) due.push({ symbol, at: Number.isFinite(at) ? at : 0 });
  }
  due.sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));
  return due.slice(0, limit).map((d) => d.symbol);
}
