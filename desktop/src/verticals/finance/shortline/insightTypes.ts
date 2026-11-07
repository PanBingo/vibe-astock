/** 盯盘 · 实时洞察的页面形状，与 orchestrator/src/finance/live_insight/types.ts 的 LiveInsightView 一致。 */

export type Reliability = "high" | "medium" | "low";

export interface InsightIndex { code: string; name: string; price: number | null; change_pct: number | null; quote_time: string | null; today: boolean }
export interface InsightBreadth {
  date: string;
  exchanges: { market: string; label: string; up: number | null; down: number | null; flat: number | null; amount: number | null }[];
  buckets: { key: number; label: string; count: number }[];
  fetched_at: string;
}
export interface InsightLive { as_of: string | null; phase: string | null; limit_up: number | null; broken: number | null; limit_down: number | null; highest_board: number | null; seal_rate: number | null; broken_rate: number | null }
export interface InsightBoard {
  code: string; name: string; rank: number | null; main_net: number | null; change_pct: number | null; main_pct: number | null;
  up_count: number | null; down_count: number | null; leader: string | null; delta_net: number | null; delta_pct: number | null;
  baseline_clock: string | null; history: { clock: string; main_net: number | null }[];
}
export interface InsightAnomaly {
  kind: "industry" | "concept"; code: string; name: string; baseline_clock: string; latest_clock: string;
  main_net: number; baseline_net: number; delta_net: number; change_pct: number | null; baseline_pct: number | null;
  relation: string; reliability: Reliability; explanation: string;
}
export interface InsightAccumulation {
  code: string; name: string; status: "suspected" | "insufficient" | "not_indicated" | "stale" | "lunch";
  reliability: Reliability | null; method: "minute_series" | "capture_samples" | "none"; points: number; span_min: number | null;
  main_net: number | null; change_pct: number | null; up_fraction: number | null; step_share: number | null; statement: string; disclaimer: string;
}
export interface InsightHotspot {
  industry: string; breadth: number; leader_code: string; leader_name: string; leader_boards: number | null; leader_seal: string;
  intensity: number | null; persistence: number; names: { code: string; name: string; limit_days: number | null }[]; names_more: number; note: string;
}
export interface InsightDiffusion {
  industry: string; leader_code: string; leader_name: string; breadth_prev: number; breadth_now: number;
  new_names: { code: string; name: string }[]; baseline_clock: string; latest_clock: string;
  concepts: { name: string; change_pct: number | null; main_net: number | null; delta_net: number | null }[];
  reliability: Reliability; evidence: string[];
}
export interface InsightAttempt { at: string; date: string; phase: string; outcome: string; reason: string | null; gaps: string[] }

export interface LiveInsightView {
  enabled: boolean;
  disabled_reason: string | null;
  date: string;
  clock: string;
  phase: string;
  phase_label: string;
  trading_day: boolean | null;
  archive: boolean;
  capture_count: number;
  latest_captured_at: string | null;
  latest_clock: string | null;
  stale: boolean;
  freshness: string;
  capture_due: boolean;
  poll_ms: number;
  board_source: "eastmoney" | "sina" | "none";
  board_caliber: string;
  market: { indexes: InsightIndex[]; breadth: InsightBreadth | null; breadth_note: string | null; live: InsightLive | null; live_reason: string | null };
  industry: InsightBoard[];
  concept: InsightBoard[];
  anomalies: InsightAnomaly[];
  anomaly_note: string | null;
  accumulation: InsightAccumulation[];
  hotspots: InsightHotspot[];
  diffusion: InsightDiffusion[];
  diffusion_note: string | null;
  gaps: string[];
  limits: string[];
  source: string;
  attempt: InsightAttempt | null;
  outcome?: string;
}
