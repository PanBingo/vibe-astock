/** 涨停回调观察池的阈值。判断一律用同一条前复权日 K，不把不复权现价和前复权历史混在一起。 */
export const NEAR_PCT = 0.03;
export const RALLY_MIN_PCT = 0.05;
export const SECOND_START_PCT = 0.04;
export const VOLUME_SHRINK = 0.7;
export const VOLUME_EXPAND = 1.2;
export const MIN_BARS = 3;
/** 最近一次入池距今不超过这么多天，才自动更新行情。更早的只保留记录，不自动请求。 */
export const ACTIVE_DAYS = 90;
export const QUOTE_MAX_AGE_MS = 6 * 3600 * 1000;
export const CLOSE_REFRESH_MAX = 20;
export const MANUAL_REFRESH_MAX = 12;
export const QUOTE_CONCURRENCY = 2;
export const SETTLED_HM = "15:05";
export const KLINE_COUNT = 180;

export function limitWatchEnabled(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; reason: string | null } {
  const v = String(env.VA_LIMIT_WATCH ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") {
    return { enabled: false, reason: "环境变量 VA_LIMIT_WATCH 已关闭涨停观察池的写入和行情更新。已有记录仍可看。" };
  }
  return { enabled: true, reason: null };
}

export const POOL_SOURCE = "东财涨停池 em_zt_pool（只要行情日对得上、列表非空的收盘池；炸板池不进）。锚点和现价都取腾讯日 K 前复权 tx_kline adjust=qfq。不使用盘中未收线的收盘价做确认，也不把资金流说成主力意图。";

export const ANCHOR_RULE = "锚点是该涨停日在同一条前复权序列里的收盘价。涨停池只收收盘仍封住的股票，所以这个收盘价就是当日涨停价。开盘、最高、最低只对照展示，不拿来当锚点。价格带是收盘价上下 3%。前复权会在以后除权时整段重算，所以每次判断都从当次取回的序列里重读锚点那一天，不用以前存下的价格。";
