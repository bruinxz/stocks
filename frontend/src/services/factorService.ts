import api from './api';

/**
 * US-015 因子选股工作区前端 API 客户端。
 *
 * 调用 3 个后端端点：
 *   - GET  /api/factors/overview                      → listFactorsOverview()
 *   - POST /api/factors/preview                       → previewFactorSelection(payload)
 *   - GET  /api/strategies/multi-factor/latest-picks  → getLatestMultiFactorPicks()
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

// ---------- /api/strategies/multi-factor/latest-picks ----------------------

export async function getLatestMultiFactorPicks(): Promise<FactorPreviewResponse> {
  const res = await api.get('/strategies/multi-factor/latest-picks');
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取多因子最新调仓失败');
  }
  return res.data.data as FactorPreviewResponse;
}

// ---------- bundled export ------------------------------------------------

export const factorService = {
  listFactorsOverview,
  previewFactorSelection,
  getLatestMultiFactorPicks,
};

export default factorService;
