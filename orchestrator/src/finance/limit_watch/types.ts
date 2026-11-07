export const POOL_SCHEMA = 1 as const;

export interface PoolStock {
  symbol: string;
  name: string;
  industry: string;
  boards: number | null;
  first_seal: string | null;
}

export interface AnchorEntry {
  symbol: string;
  name: string;
  industry: string;
  /** 这一天收盘涨停、被写入观察池的交易日 */
  trade_date: string;
  boards: number | null;
  first_seal: string | null;
  source: "em_zt_pool";
  /** 上游 qdate，必须等于 trade_date */
  pool_qdate: string;
  enrolled_at: string;
  /** launch = 这一天就是启动板（连板数为 1，或上游没给连板数）。follow = 后续板，启动日另记。 */
  role: "launch" | "follow";
  /** 本轮启动板的交易日。后续板如果池里没有更早的启动日，就是 null，不能用后续板的价格冒充。 */
  launch_date: string | null;
}

export interface QfqBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface QuoteCache {
  symbol: string;
  adjust: string;
  fetched_at: string;
  bars: QfqBar[];
  gap: string | null;
}

export interface EnrollRun {
  date: string;
  at: string;
  outcome: "enrolled" | "skipped" | "incomplete";
  added: number;
  total: number | null;
  reason: string | null;
}

export interface PoolFile {
  schema: typeof POOL_SCHEMA;
  entries: AnchorEntry[];
  quotes: QuoteCache[];
  runs: EnrollRun[];
}

export interface Mark {
  kind: "near" | "broken" | "held" | "second_start" | "still_at_board";
  anchor_date: string;
  anchor_close: number;
  band_low: number;
  band_high: number;
  distance_pct: number | null;
  text: string;
}

export interface SymbolSummary {
  symbol: string;
  name: string;
  industry: string;
  status: "active" | "paused";
  entries: number;
  latest_entry: string;
  launch_dates: string[];
  missing_launch: boolean;
  marks: Mark[];
  tendency: "shakeout" | "distribution" | "conflict" | "insufficient" | "no_quote";
  tendency_text: string;
  evidence: string[];
  counter: string[];
  sample_bars: number;
  uncertainty: string;
  unconfirmed: boolean;
  quote_fetched_at: string | null;
  quote_last_date: string | null;
  stale: boolean;
  gaps: string[];
}

export type JointStatus = "aligned" | "waiting" | "conflict" | "insufficient";

export interface JointItem {
  label: string;
  value: string;
  at: string;
  source: string;
  counter: string;
  fail: string;
}

export interface JointLeg {
  key: "market" | "sector" | "stock";
  title: string;
  verdict: string;
  items: JointItem[];
}

export interface JointAssessment {
  status: JointStatus;
  label: string;
  session_note: string;
  legs: JointLeg[];
  invalidation: string[];
}

export interface LimitWatchView {
  enabled: boolean;
  disabled_reason: string | null;
  as_of: string;
  clock: string;
  near_pct: number;
  rules: string;
  /** 本页打开时附上的联合观察。只读已有快照，不是交易建议。 */
  joint_note: string;
  symbols: (SymbolSummary & { joint: JointAssessment })[];
  detail: (SymbolSummary & { bars: QfqBar[]; adjust: string | null; joint: JointAssessment }) | null;
  runs: EnrollRun[];
  gaps: string[];
  source: string;
}
