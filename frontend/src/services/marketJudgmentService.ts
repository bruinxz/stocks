import api from './api';

/**
 * US-040 「今日大盘判断卡片」前端 API 客户端。
 *
 * 调用：
 *   - GET /api/today/market-judgment        → getMarketJudgmentToday()
 *
 * 数据形态对齐 backend `MarketJudgmentService.MarketJudgmentResult`：
 *   - regime / regime_label / 仓位建议 / 昨夜外盘列表 / brief 一句话;
 *   - status: 'ok' | 'partial' | 'failed' ─ 部分维度缺失走 partial 仍可显示；
 *   - components.regime.error / components.overnight_foreign.error
 *     单维度失败时 UI 渲染 "—" + Tooltip 显示 error，而不是 panic。
 */

export type MarketJudgmentStatus = 'ok' | 'partial' | 'failed';

export type MarketRegime = 'bull' | 'bear' | 'range' | 'rebound' | 'stress' | 'unknown';

export interface OvernightForeignQuote {
  symbol: string;
  name: string;
  current: number;
  change: number;
  change_pct: number;
}

export interface OvernightForeignSummary {
  count: number;
  positive: number;
  negative: number;
  avg_change_pct: number;
}

export interface MarketJudgmentComponentError {
  error: string | null;
}

export interface MarketJudgmentComponents {
  regime: MarketJudgmentComponentError;
  overnight_foreign: MarketJudgmentComponentError;
}

export interface MarketJudgmentResult {
  trade_date: string;
  regime: MarketRegime;
  regime_label: string;
  benchmark_code: string;
  benchmark_return_20d_pct: number | null;
  benchmark_atr_14d_pct: number | null;
  suggested_position_pct: number;
  suggested_position_label: string;
  suggested_position_reason: string;
  overnight_foreign: OvernightForeignQuote[];
  overnight_summary: OvernightForeignSummary;
  brief: string;
  status: MarketJudgmentStatus;
  message: string;
  components: MarketJudgmentComponents;
}

export interface GetMarketJudgmentTodayOptions {
  trade_date?: string;
}

/**
 * 获取「今日大盘判断卡片」当日数据。
 *
 * status='partial' / 'failed' 仍正常返回（components 内每个维度的 error 字段标识哪个数据源失败）。
 * 触发网络错误或 4xx/5xx 时抛 Error 让 caller 显示页面级降级。
 */
export async function getMarketJudgmentToday(
  options: GetMarketJudgmentTodayOptions = {}
): Promise<MarketJudgmentResult> {
  const params: Record<string, string> = {};
  if (options.trade_date) params.trade_date = options.trade_date;
  const response = await api.get<{
    success: boolean;
    data: MarketJudgmentResult;
    message?: string;
  }>('/today/market-judgment', { params });
  if (!response.data?.success) {
    throw new Error(response.data?.message || '获取今日大盘判断失败');
  }
  return response.data.data;
}

export const marketJudgmentService = {
  getMarketJudgmentToday,
};

export default marketJudgmentService;
