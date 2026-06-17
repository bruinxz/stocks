import api from './api';

/**
 * US-018 今日作战工作区前端 API 客户端。
 *
 * 调用 2 个后端端点（详见 backend/src/services/TodaySignalsService.ts）：
 *   - GET  /api/today/signals          → getTodaySignals()
 *   - POST /api/today/apply-signals    → applyTodaySignals()
 *
 * 所有响应遵循后端统一信封 `{ success, data, message? }`。service 层把
 * `data` 解出来直接返回；`success=false` 抛 JS Error（与 factorService /
 * portfolioWorkspaceService 一致）。
 */

// ---------- 类型定义 ----------

export interface AccountSummary {
  total_value: number;
  current_cash: number;
  position_value: number;
  /** 今日盈亏 (相对最近一次 snapshot / 昨日收盘的浮盈) */
  pnl_yesterday: number | null;
  pnl_month_to_date: number | null;
  /** 期初本金 */
  initial_capital: number;
  /** 总收益 = total_value - initial_capital */
  total_return: number;
  /** 总收益率 (initial_capital ≤ 0 时为 null) */
  total_return_pct: number | null;
  portfolio_id: number | null;
}

export interface UnreadRiskAlertItem {
  id: number;
  symbol: string;
  name: string;
  level: string;
  message: string;
  created_at: string;
}

export interface MultiFactorAlphaSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  composite_score: number;
  factor_z_scores: Record<string, number>;
  reason: string;
}

export interface DragonHeadSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'sell_half' | 'hold';
  reason: string;
  reference_price?: number;
  continuous_days?: number;
  industry_rank?: number;
  famous_yz_net_buy?: number;
  circulating_market_cap?: number;
}

export interface EarningsSurpriseSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  reference_price?: number;
  forecast_type?: string | null;
  profit_change_low?: number | null;
  profit_change_high?: number | null;
  northbound_ratio_delta?: number | null;
  report_period?: string | null;
}

export interface MultiFactorBlock {
  trade_date: string | null;
  signals: MultiFactorAlphaSignal[];
  new_picks: number;
  drops: number;
  keeps: number;
  target_portfolio: string[];
  error?: string;
}

export interface DragonHeadBlock {
  trade_date: string | null;
  candidates: DragonHeadSignal[];
  eligible_count: number;
  limit_up_pool_size?: number;
  market_sentiment_value?: number | null;
  market_sentiment_blocked?: boolean;
  filter_stats?: Record<string, number>;
  error?: string;
}

export interface EarningsSurpriseBlock {
  trade_date: string | null;
  candidates: EarningsSurpriseSignal[];
  forecast_pool_size: number;
  eligible_count: number;
  northbound_missing?: boolean;
  filter_stats?: Record<string, number>;
  error?: string;
}

export interface KeyEventItem {
  event_type: 'earnings_surprise' | 'earnings_announcement' | 'limit_up_chain';
  stock_code: string;
  stock_name: string | null;
  summary: string;
  rank_value: number;
  metadata?: Record<string, unknown>;
}

export interface TodaySignalsData {
  trade_date: string | null;
  account: AccountSummary | null;
  unread_alerts: UnreadRiskAlertItem[];
  unread_alert_count: number;
  multi_factor: MultiFactorBlock;
  dragon_head: DragonHeadBlock;
  earnings_surprise: EarningsSurpriseBlock;
  key_events: KeyEventItem[];
}

export interface ApplyOrderItem {
  strategy: 'multi_factor' | 'dragon_head' | 'earnings_surprise';
  symbol: string;
  name: string | null;
  quantity: number;
  expected_amount: number;
  status: 'placed' | 'skipped' | 'failed';
  reason?: string;
  execute_price?: number;
}

export interface ApplySignalsData {
  trade_date: string | null;
  placed: number;
  skipped: number;
  orders: ApplyOrderItem[];
}

export interface ApplySignalsRequest {
  trade_date?: string;
  per_order_amount?: number;
  max_orders?: number;
  /** 多账户多盘场景必传 (2026-06-17 串盘修复) */
  portfolio_id?: number;
}

// ---------- API 调用 ----------

export async function getTodaySignals(params?: {
  trade_date?: string;
  dragon_head_limit?: number;
  earnings_limit?: number;
  alerts_limit?: number;
  /** 多账户多盘场景必传, 决定 KPI / MFA 差分基线用哪个盘 (2026-06-17 串盘修复) */
  portfolio_id?: number;
}): Promise<TodaySignalsData> {
  const res = await api.get('/today/signals', { params });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取今日作战信号失败');
  }
  return res.data.data as TodaySignalsData;
}

export async function applyTodaySignals(
  payload: ApplySignalsRequest = {}
): Promise<ApplySignalsData> {
  const res = await api.post('/today/apply-signals', payload);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '一键应用今日信号失败');
  }
  return res.data.data as ApplySignalsData;
}

// ---------- bundled export ------------------------------------------------

export const todayWorkspaceService = {
  getTodaySignals,
  applyTodaySignals,
};

export default todayWorkspaceService;
