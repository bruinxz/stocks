import api from './api';

/**
 * AI 单股深度问答 service —— US-055
 *
 * 前端 `AI 解读` 按钮调用本 service 拉取多维度 AI 分析结果。
 * 与 backend/src/services/AIAdvisorService.analyzeSingleStock 一对一。
 *
 * 入口：
 *   - PortfolioWorkspace（持仓表格行操作列）
 *   - FactorWorkspace（选股结果表格行操作列）
 *
 * 数据形态对齐 backend AnalyzeSingleStockResult：
 *   - dimensions: string[]            — 已分析的维度
 *   - summary: string                  — 中文 markdown
 *   - recommendation: string           — strong_buy / buy / hold / sell / strong_sell / unknown
 *   - key_points: Record<dim, string[]>
 *   - status: 'completed' | 'partial' | 'failed' | 'pending'
 */

export type AnalysisDimension = 'fundamental' | 'technical' | 'capital' | 'news' | 'sentiment';

export const ALL_ANALYSIS_DIMENSIONS: AnalysisDimension[] = [
  'fundamental',
  'technical',
  'capital',
  'news',
  'sentiment',
];

export const DIMENSION_LABELS: Record<AnalysisDimension, string> = {
  fundamental: '基本面',
  technical: '技术面',
  capital: '资金面',
  news: '新闻面',
  sentiment: '情绪面',
};

export type RecommendationKey = 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' | 'unknown';

export const RECOMMENDATION_LABELS: Record<RecommendationKey, string> = {
  strong_buy: '强烈买入',
  buy: '买入',
  hold: '持有 / 观望',
  sell: '卖出',
  strong_sell: '强烈卖出',
  unknown: '暂无明确建议',
};

export const RECOMMENDATION_COLORS: Record<RecommendationKey, string> = {
  strong_buy: '#9b1f00',
  buy: '#dc2626',
  hold: '#1890ff',
  sell: '#16a34a',
  strong_sell: '#135200',
  unknown: '#8c8c8c',
};

export interface SingleStockAnalysisRequest {
  stock_code: string;
  dimensions?: AnalysisDimension[];
  target_date?: string;
  dry_run?: boolean;
  is_async?: boolean;
  task_label?: string;
  stock_name?: string;
}

export interface AnalyzeSingleStockResult {
  report_id: string;
  stock_code: string;
  stock_name: string | null;
  dimensions: AnalysisDimension[];
  summary: string;
  recommendation: RecommendationKey | string;
  confidence_score: number | null;
  risk_level: string | null;
  key_points: Record<string, string[]>;
  /** 归档接口保留的数据库字段；新代码统一读取 key_points。 */
  key_points_json?: Record<string, string[]>;
  status: 'completed' | 'partial' | 'failed' | 'pending';
  task_id: string | null;
  target_date: string | null;
  error: string | null;
  generated_at: string;
  metadata: Record<string, unknown>;
  persisted: boolean;
  /** 价格测算报告归档后会从 metadata 恢复到这两个顶层字段。 */
  market_snapshot?: AIPriceMarketSnapshot | null;
  price_decision?: AIPriceDecisionPlan | null;
}

export type AIPriceDecisionPositionState = 'watching' | 'holding';
export type AIPriceFreshness = 'live' | 'same_day' | 'previous_close' | 'stale';

export interface AIPriceMarketSnapshot {
  stock_code: string;
  stock_name: string | null;
  current_price: number;
  change_percent: number | null;
  previous_close: number | null;
  day_open: number | null;
  day_high: number | null;
  day_low: number | null;
  quote_time: string;
  quote_source: string;
  quote_age_minutes: number;
  freshness: AIPriceFreshness;
  refresh_error: string | null;
}

export interface AIPriceDecisionPlan {
  action: RecommendationKey | string;
  action_label: string;
  position_action: 'open' | 'maintain' | 'close' | 'avoid';
  position_action_label: string;
  current_price: number;
  entry_zone: [number, number] | null;
  sell_zone: [number, number];
  stop_loss: number | null;
  take_profit: number | null;
  suggested_position_pct: number | null;
  planned_capital: number | null;
  planned_position_value: number | null;
  suggested_shares: number | null;
  holding_cost: number | null;
  holding_pnl_pct: number | null;
  risk_reward_ratio: number | null;
  support_level: number | null;
  resistance_level: number | null;
  atr_14: number;
  volatility_20: number | null;
  execution_ready: boolean;
  execution_note: string;
  decision_basis: string[];
  risk_warnings: string[];
  model: 'tradingagents_price_v1';
}

export interface AIPriceDecisionResult extends AnalyzeSingleStockResult {
  market_snapshot: AIPriceMarketSnapshot | null;
  price_decision: AIPriceDecisionPlan | null;
}

export interface AIPriceDecisionRequest extends SingleStockAnalysisRequest {
  position_state?: AIPriceDecisionPositionState;
  planned_capital?: number;
  holding_cost?: number;
  refresh_quote?: boolean;
}

/**
 * 当前价格交易测算：TradingAgents 给方向，后端用实时行情与 ATR/支撑压力生成价位。
 */
export async function analyzePriceDecision(
  request: AIPriceDecisionRequest
): Promise<AIPriceDecisionResult> {
  const response = await api.post<{
    success: boolean;
    data?: AIPriceDecisionResult;
    message?: string;
  }>('/ai/price-decision', request);
  if (!response.data?.success || !response.data.data) {
    throw new Error(response.data?.message || 'AI 买卖测算请求失败');
  }
  return response.data.data;
}

/**
 * 同步触发单股分析（POST /api/ai/analyze-stock）。
 *
 * 默认 dimensions = 全 5 维度；服务端会调 TradingAgents 一次完整分析。
 * status='partial' 仍正常返回（部分维度缺数据），UI 应按 key_points 渲染。
 */
export async function analyzeSingleStock(
  request: SingleStockAnalysisRequest
): Promise<AnalyzeSingleStockResult> {
  const response = await api.post<{
    success: boolean;
    data: AnalyzeSingleStockResult;
    message?: string;
  }>('/ai/analyze-stock', request);
  if (!response.data?.success) {
    throw new Error(response.data?.message || 'AI 分析请求失败');
  }
  return response.data.data;
}

/**
 * 查询单条 AI 分析报告详情。
 */
export async function getReportById(reportId: string): Promise<AnalyzeSingleStockResult | null> {
  try {
    const response = await api.get<{ success: boolean; data: AnalyzeSingleStockResult }>(
      `/ai/analyze-stock/reports/${encodeURIComponent(reportId)}`
    );
    return response.data?.data || null;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

/**
 * 列表查询（按 stock_code 过滤、时间倒序）。
 *
 * `config.signal` 支持 AbortController — 组件在 useEffect cleanup 时可取消未完成的请求，
 * 避免快速切换 stock 时旧请求 late-arriver 覆盖新状态。axios `config.signal` 原生支持自 v0.22.0（2021-10）。
 */
export async function listReports(
  params: {
    stock_code?: string;
    limit?: number;
    offset?: number;
  },
  config?: { signal?: AbortSignal }
): Promise<AnalyzeSingleStockResult[]> {
  const response = await api.get<{ success: boolean; data: AnalyzeSingleStockResult[] }>(
    '/ai/analyze-stock/reports',
    { params, signal: config?.signal }
  );
  return response.data?.data || [];
}

export const aiStockAnalysisService = {
  analyzeSingleStock,
  analyzePriceDecision,
  getReportById,
  listReports,
};

export default aiStockAnalysisService;
