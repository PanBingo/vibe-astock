/**
 * 实时洞察开关与节流。默认开；设 VA_LIVE_INSIGHT=0 / false / off / no 后，
 * 定时采集和页面写动作都不再联网。读接口仍可打开，只说明已关闭。
 */
export function liveInsightEnabled(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; reason: string | null } {
  const v = String(env.VA_LIVE_INSIGHT ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") {
    return { enabled: false, reason: "环境变量 VA_LIVE_INSIGHT 已关闭实时洞察。采集和刷新都不再联网。" };
  }
  return { enabled: true, reason: null };
}

/** 连续竞价期间两张快照的最短间隔。手动刷新也不能绕过休市 / 午休。 */
export const CAPTURE_MIN_MS = 120_000;
/** 收盘后只在这个时刻之前自动补一张收盘累计，过了不补抓。 */
export const CLOSE_GRACE_END = "15:20";
/** 板块资金只留净额排序的前 N 名，掉出名单不等于归零。 */
export const BOARD_TOP_N = 40;
/** 成交额榜里拿来做分钟资金的上限（未涨停、涨跌幅温和）。 */
export const FLOW_CANDIDATES = 6;
/** 只给涨停行业里广度最高的几只龙头补概念归属。 */
export const LEADER_CONCEPTS = 3;
export const FLOW_ABS_PCT_MIN = 0.3;
export const FLOW_ABS_PCT_MAX = 4;

export const INSIGHT_SOURCE = [
  "盘中采集，不是复盘快照。",
  "涨跌分布 em_market_breadth；行业/概念板块资金 em_board_fund_flow（整段失败才改用新浪 sina_board_flow，两条口径分开存放，不能接成一条曲线）；",
  "行业涨跌家数 em_industry_comparison；涨停池 em_zt_pool；成交额榜 em_turnover_rank；",
  "个股分钟资金 em_fund_flow_minute（东财主力净额当日累计，元）；概念归属 em_concept_blocks；",
  "指数行情 tx_quotes_batch；盘中情绪 cn_shortline_live。",
  "不使用 cn_shortline_emotion / cn_shortline_daily / cn_shortline_facts。",
].join("");
