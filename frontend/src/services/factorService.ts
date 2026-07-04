import api from './api';

/**
 * US-015 因子选股工作区前端 API 客户端。
 *
 * 调用 4 个后端端点：
 *   - GET  /api/factors/overview                      → listFactorsOverview()
 *   - POST /api/factors/preview                       → previewFactorSelection(payload)
 *   - GET  /api/strategies/multi-factor/latest-picks  → getEtfRotationLatestPicks()
 *   - GET  /api/factors/industry-heatmap              → getIndustryHeatmap(date?)  (US-074)
 *
 * 所有响应遵循后端统一信封 `{ success, data, message? }`，
 * service 层把 `data` 层解出来直接返回给组件——简化组件层 await 链。
 */

// ---------- /api/factors/overview ------------------------------------------

export interface FactorOverviewItem {
  name: string;
  description: string;
  category: string;
  latest_trade_date: string | null;
  universe_size: number;
  non_neutral_count: number;
  /** US-045 因子健康列 (FE-006): 近 90 日 IC 均值 (look_forward=20); 缺数据 null */
  ic_90d: number | null;
  /** US-045 因子健康列: 最新一条 IC report 的 ic_ir (信息比率); 缺数据 null */
  ic_ir: number | null;
  /** US-045 因子健康列: 进入 ic_90d 聚合的 IC report 行数 */
  ic_sample_count: number;
  /** US-045 因子健康列: 4 档分类 - alpha=有效/weak=失效/unstable=方向但不稳/unknown=无数据 */
  health_class: 'alpha' | 'weak' | 'unstable' | 'unknown';
}

export interface FactorOverviewResponse {
  latest_trade_date: string | null;
  factors: FactorOverviewItem[];
}

export async function listFactorsOverview(): Promise<FactorOverviewResponse> {
  const res = await api.get('/factors/overview');
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取因子总览失败');
  }
  return res.data.data as FactorOverviewResponse;
}

// ---------- /api/factors/preview -------------------------------------------

export interface FactorPreviewRequest {
  trade_date?: string;
  weights?: Record<string, number>;
  topN?: number;
  industryNeutral?: boolean;
  maxPerIndustry?: number;
  excludeST?: boolean;
  excludeNew60d?: boolean;
}

export interface FactorPreviewSignal {
  stock_code: string;
  name: string | null;
  industry: string | null;
  signal: 'buy' | 'sell' | 'hold';
  composite_score: number;
  factor_z_scores: Record<string, number>;
  reason: string;
}

export interface FactorPreviewFiltered {
  st: number;
  new60d: number;
  industry_capped: number;
  no_factor_data: number;
}

export interface FactorPreviewResponse {
  trade_date: string;
  target_portfolio: string[];
  signals: FactorPreviewSignal[];
  filtered: FactorPreviewFiltered;
  params: {
    topN: number;
    rebalancePeriod: 'daily' | 'weekly' | 'monthly';
    industryNeutral: boolean;
    maxPerIndustry: number;
    excludeST: boolean;
    excludeNew60d: boolean;
    weights: Record<string, number>;
  } | null;
  universe_size: number;
  eligible_count: number;
  /** 仅 latest-picks 在 factor_scores 为空时使用 */
  note?: string;
}

export async function previewFactorSelection(
  payload: FactorPreviewRequest
): Promise<FactorPreviewResponse> {
  const res = await api.post('/factors/preview', payload);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '预览选股失败');
  }
  return res.data.data as FactorPreviewResponse;
}

// ---------- /api/strategies/multi-factor/latest-picks (ETF 因子轮动, 新主线 §4.1) ----
// 后端该端点已收敛为 ETF 因子轮动信号 (ETFRotationStrategy), 用下面的强类型版本消费.

export interface EtfRotationFactorZ {
  value_z: number | null;
  quality_z: number | null;
  lowvol_z: number | null;
  momentum_z: number | null; // shadow, 权重 0
  value_raw: number | null;
  quality_raw: number | null;
  lowvol_raw: number | null;
  momentum_raw: number | null;
  constituent_source: string;
}

export interface EtfRotationSignal {
  strategy_key: string;
  etf_code: string;
  name?: string;
  action: 'buy' | 'sell' | 'hold';
  score: number | null;
  rank: number;
  target_weight: number | null;
  factors: EtfRotationFactorZ;
  reasons: string[];
  data_incomplete: boolean;
}

export interface EtfRotationLatestResponse {
  trade_date: string | null;
  strategy_key: string;
  signals: EtfRotationSignal[];
  buy_count: number;
  sell_count: number;
  hold_count: number;
  universe_size: number;
  note?: string;
}

export async function getEtfRotationLatestPicks(): Promise<EtfRotationLatestResponse> {
  const res = await api.get('/strategies/multi-factor/latest-picks');
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取 ETF 因子轮动最新调仓失败');
  }
  return res.data.data as EtfRotationLatestResponse;
}

// ---------- /api/factors/industry-heatmap ----------------------------------

export interface FactorHeatmapCell {
  industry: string;
  factor: string;
  avg_z: number;
  sample_size: number;
}

export interface FactorIndustryHeatmapResponse {
  trade_date: string | null;
  /** 横轴：因子名 (按 FactorRegistry 注册顺序) */
  factors: string[];
  /** 纵轴：行业名 (按"行业 × 全因子" z 总和降序——最受多因子青睐的行业排顶) */
  industries: string[];
  /** 仅非空格 (industry, factor) 三元组 + 样本数 */
  cells: FactorHeatmapCell[];
  /** 当日同时落在 factor_scores 与 stocks 表的股票数 */
  universe_size: number;
  /** factor_scores 为空 / 给定日无数据时的解释；正常情况省略 */
  note?: string;
}

export async function getIndustryHeatmap(date?: string): Promise<FactorIndustryHeatmapResponse> {
  const res = await api.get('/factors/industry-heatmap', {
    params: date ? { date } : undefined,
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取行业热力数据失败');
  }
  return res.data.data as FactorIndustryHeatmapResponse;
}

// ---------- /api/factors/industry-board (Batch AF 2026-06-18) --------------

export interface IndustryBoardIndustryToday {
  change_pct: number | null;
  main_inflow: number | null;
  main_inflow_ratio: number | null;
  limit_up_count: number;
  advancing_count: number | null;
  declining_count: number | null;
  leader_stock_code: string | null;
  leader_stock_name: string | null;
  leader_stock_change_pct: number | null;
}

export interface IndustryBoardSeriesPoint {
  trade_date: string;
  change_pct: number | null;
  main_inflow_ratio: number | null;
}

export interface IndustryBoardIndustry {
  industry_code: string;
  industry_name: string;
  today: IndustryBoardIndustryToday;
  series: IndustryBoardSeriesPoint[];
}

export interface IndustryBoardHotConcept {
  keyword: string;
  heat_score: number;
  rank: number | null;
  is_new: boolean;
  related_stocks: Array<{ stock_code: string; stock_name: string }>;
}

export interface IndustryBoardNewsItem {
  title: string;
  publish_time: string;
  source: string;
  category: string | null;
  url: string | null;
}

export interface IndustryBoardResponse {
  trade_date: string | null;
  today_iso?: string;
  lag_days?: number;
  data_staleness?: 'fresh' | 'recent' | 'stale' | 'very_stale';
  dates: string[];
  industries: IndustryBoardIndustry[];
  hot_concepts: IndustryBoardHotConcept[];
  universe_size: number;
  limit_up_today?: number;
  recent_news?: IndustryBoardNewsItem[];
  note?: string;
}

export async function getIndustryBoard(opts?: {
  date?: string;
  top?: number;
  lookback?: number;
}): Promise<IndustryBoardResponse> {
  const params: Record<string, string | number> = {};
  if (opts?.date) params.date = opts.date;
  if (opts?.top) params.top = opts.top;
  if (opts?.lookback) params.lookback = opts.lookback;
  const res = await api.get('/factors/industry-board', {
    params: Object.keys(params).length > 0 ? params : undefined,
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取行业决策面板失败');
  }
  return res.data.data as IndustryBoardResponse;
}

// ---------- /api/factors/:name/detail (US-094) -----------------------------

export interface FactorICHistoryPoint {
  period_end: string;
  ic_mean: number | null;
  ic_ir: number | null;
  look_forward_days: number;
}

export interface FactorQuintileNetValuePoint {
  trade_date: string;
  Q1: number;
  Q2: number;
  Q3: number;
  Q4: number;
  Q5: number;
}

export interface FactorDetailResponse {
  name: string;
  description: string;
  category: string;
  period_start: string | null;
  period_end: string | null;
  effective_trade_days: number;
  ic_history: FactorICHistoryPoint[];
  quintile_curves: FactorQuintileNetValuePoint[];
  note?: string;
}

/**
 * US-094 单因子详情：IC 历史曲线 + 5 等分组合累计净值（Q1..Q5）。
 *
 * 点击 FactorWorkspace 因子卡片打开抽屉时使用。
 *
 * 参数：
 *   - limitDays?: 1..250；默认 120（约半年 A 股交易日）。
 *   - icLimit?:   1..200；默认 60。
 */
export async function getFactorDetail(
  name: string,
  options?: { limitDays?: number; icLimit?: number }
): Promise<FactorDetailResponse> {
  const params: Record<string, number> = {};
  if (options?.limitDays != null) params.limit_days = options.limitDays;
  if (options?.icLimit != null) params.ic_limit = options.icLimit;
  const res = await api.get(`/factors/${encodeURIComponent(name)}/detail`, {
    params: Object.keys(params).length > 0 ? params : undefined,
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || `获取因子 ${name} 详情失败`);
  }
  return res.data.data as FactorDetailResponse;
}

// ---------- bundled export ------------------------------------------------

export const factorService = {
  listFactorsOverview,
  previewFactorSelection,
  getEtfRotationLatestPicks,
  getIndustryHeatmap,
  getIndustryBoard,
  getFactorDetail,
};

export default factorService;
