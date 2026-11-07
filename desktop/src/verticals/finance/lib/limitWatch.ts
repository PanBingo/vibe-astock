/** 与 orchestrator/src/finance/limit_watch/types.ts 的页面对齐。 */
export interface QfqBar { date: string; open: number; high: number; low: number; close: number; volume: number | null }
export interface Mark {
  kind: "near" | "broken" | "held" | "second_start" | "still_at_board";
  anchor_date: string; anchor_close: number; band_low: number; band_high: number; distance_pct: number | null; text: string;
}
export interface SymbolSummary {
  symbol: string; name: string; industry: string; status: "active" | "paused"; entries: number; latest_entry: string;
  launch_dates: string[]; missing_launch: boolean; marks: Mark[];
  tendency: "shakeout" | "distribution" | "conflict" | "insufficient" | "no_quote";
  tendency_text: string; evidence: string[]; counter: string[]; sample_bars: number; uncertainty: string;
  unconfirmed: boolean; quote_fetched_at: string | null; quote_last_date: string | null; stale: boolean; gaps: string[];
}
export interface LimitWatchView {
  enabled: boolean; disabled_reason: string | null; as_of: string; clock: string; near_pct: number; rules: string;
  symbols: SymbolSummary[];
  detail: (SymbolSummary & { bars: QfqBar[]; adjust: string | null }) | null;
  runs: { date: string; at: string; outcome: string; added: number; total: number | null; reason: string | null }[];
  gaps: string[]; source: string; message?: string;
}
