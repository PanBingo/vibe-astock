/** 实时洞察落盘的一张快照，和页面读到的结果。缺数用 null，不用 0 顶上。 */

export const SNAPSHOT_SCHEMA = 1 as const;

export interface BoardPoint {
  code: string;
  name: string;
  rank: number | null;
  /** 供应商净额，单位元。东财是主力净额；新浪是流入减流出。看 snapshot.board_caliber。 */
  main_net: number | null;
  main_pct: number | null;
  change_pct: number | null;
  up_count: number | null;
  down_count: number | null;
  leader: string | null;
}

export interface LimitUpPoint {
  code: string;
  name: string;
  industry: string;
  limit_days: number | null;
  first_seal: string;
  seal_fund: number | null;
  pct: number | null;
  amount: number | null;
}

export interface FlowSeries {
  code: string;
  name: string;
  change_pct: number | null;
  /** 东财分钟资金：主力净额为当日累计（元），不是这一分钟的增量。 */
  points: { time: string; main_net: number }[];
  fetched_at: string;
  kind: "minute_series" | "snapshot_only";
}

export interface IndexQuote {
  code: string;
  name: string;
  price: number | null;
  change_pct: number | null;
  quote_time: string | null;
  today: boolean;
}

export interface BreadthSnap {
  date: string;
  exchanges: { market: string; label: string; up: number | null; down: number | null; flat: number | null; amount: number | null }[];
  buckets: { key: number; label: string; count: number }[];
  fetched_at: string;
}

export interface LiveCounts {
  as_of: string | null;
  phase: string | null;
  limit_up: number | null;
  broken: number | null;
  limit_down: number | null;
  highest_board: number | null;
  seal_rate: number | null;
  broken_rate: number | null;
}

export interface LeaderConcepts {
  code: string;
  name: string;
  concepts: string[];
  fetched_at: string | null;
  reason: string | null;
}

export interface CaptureSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  date: string;
  captured_at: string;
  clock: string;
  phase: string;
  trading_day: boolean;
  board_source: "eastmoney" | "sina" | "none";
  board_caliber: string;
  industry: BoardPoint[];
  concept: BoardPoint[];
  breadth: BreadthSnap | null;
  indexes: IndexQuote[];
  limit_ups: LimitUpPoint[];
  /** 涨停池证据上的交易日。对不上采集日时，扩散分析不用这张池。 */
  limit_up_date: string | null;
  flows: FlowSeries[];
  leader_concepts: LeaderConcepts[];
  live: LiveCounts | null;
  live_reason: string | null;
  gaps: string[];
}

export type Reliability = "high" | "medium" | "low";

export interface BoardView {
  code: string;
  name: string;
  rank: number | null;
  main_net: number | null;
  change_pct: number | null;
  main_pct: number | null;
  up_count: number | null;
  down_count: number | null;
  leader: string | null;
  delta_net: number | null;
  delta_pct: number | null;
  baseline_clock: string | null;
  history: { clock: string; main_net: number | null }[];
}

export interface Anomaly {
  kind: "industry" | "concept";
  code: string;
  name: string;
  baseline_clock: string;
  latest_clock: string;
  main_net: number;
  baseline_net: number;
  delta_net: number;
  change_pct: number | null;
  baseline_pct: number | null;
  relation: string;
  reliability: Reliability;
  explanation: string;
}

export interface Accumulation {
  code: string;
  name: string;
  status: "suspected" | "insufficient" | "not_indicated" | "stale" | "lunch";
  reliability: Reliability | null;
  method: "minute_series" | "capture_samples" | "none";
  points: number;
  span_min: number | null;
  main_net: number | null;
  change_pct: number | null;
  up_fraction: number | null;
  step_share: number | null;
  statement: string;
  disclaimer: string;
}

export interface Hotspot {
  industry: string;
  breadth: number;
  leader_code: string;
  leader_name: string;
  leader_boards: number | null;
  leader_seal: string;
  /** 连板（≥2）占该行业涨停只数的比例。没有板位数据时是 null。 */
  intensity: number | null;
  persistence: number;
  names: { code: string; name: string; limit_days: number | null }[];
  names_more: number;
  note: string;
}

export interface DiffusionConcept {
  name: string;
  change_pct: number | null;
  main_net: number | null;
  delta_net: number | null;
}

export interface Diffusion {
  industry: string;
  leader_code: string;
  leader_name: string;
  breadth_prev: number;
  breadth_now: number;
  new_names: { code: string; name: string }[];
  baseline_clock: string;
  latest_clock: string;
  concepts: DiffusionConcept[];
  reliability: Reliability;
  evidence: string[];
}

export interface InsightAttempt {
  at: string;
  date: string;
  phase: string;
  outcome: "saved" | "throttled" | "skipped" | "failed" | "disabled";
  reason: string | null;
  gaps: string[];
}

export interface LiveInsightView {
  enabled: boolean;
  disabled_reason: string | null;
  date: string;
  clock: string;
  phase: string;
  phase_label: string;
  trading_day: boolean | null;
  /** 看的不是今天：历史采集，页面不当成当前实时。 */
  archive: boolean;
  capture_count: number;
  latest_captured_at: string | null;
  latest_clock: string | null;
  stale: boolean;
  freshness: string;
  capture_due: boolean;
  poll_ms: number;
  board_source: CaptureSnapshot["board_source"];
  board_caliber: string;
  market: {
    indexes: IndexQuote[];
    breadth: BreadthSnap | null;
    breadth_note: string | null;
    live: LiveCounts | null;
    live_reason: string | null;
  };
  industry: BoardView[];
  concept: BoardView[];
  anomalies: Anomaly[];
  anomaly_note: string | null;
  accumulation: Accumulation[];
  hotspots: Hotspot[];
  diffusion: Diffusion[];
  diffusion_note: string | null;
  gaps: string[];
  limits: string[];
  source: string;
  attempt: InsightAttempt | null;
}
