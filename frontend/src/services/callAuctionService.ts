import api from './api';

/**
 * US-041 / FE-002 「集合竞价异动卡片」前端 API 客户端。
 *
 * 调用：
 *   - GET /api/today/call-auction        → getCallAuctionToday()
 *
 * 数据形态对齐 backend `CallAuctionAnomalyService.CallAuctionAnomalyResult`：
 *   - 4 类异动: one_word / gap_up / gap_down / normal (normal 不进 anomalies 列表);
 *   - status: 'ok' | 'partial' | 'failed' ─ 部分维度缺失走 partial 仍可显示；
 *   - components.timing.error 时 (9:25 前) UI 显示倒计时, 不报错;
 *   - components.universe.error / components.quotes.error 单维度失败时 UI 渲染 "—" + Tooltip.
 */

export type CallAuctionStatus = 'ok' | 'partial' | 'failed';
export type AuctionAnomalyType = 'one_word' | 'gap_up' | 'gap_down' | 'normal';
export type AuctionUniverseSource = 'limit_up_pool' | 'position';

export interface AuctionAnomalyItem {
  symbol: string;
  name: string | null;
  anomaly_type: AuctionAnomalyType;
  open: number | null;
  prev_close: number | null;
  open_change_pct: number | null;
  is_one_word: boolean;
  was_yesterday_limit_up: boolean;
  is_position: boolean;
  continuous_days?: number | null;
  industry?: string | null;
  sources: AuctionUniverseSource[];
  note: string;
}

export interface AuctionAnomalySummary {
  total: number;
  one_word_count: number;
  gap_up_count: number;
  gap_down_count: number;
  resolved_count: number;
}

export interface CallAuctionComponentError {
  error: string | null;
}

export interface CallAuctionComponents {
  universe: CallAuctionComponentError;
  quotes: CallAuctionComponentError;
  timing: CallAuctionComponentError;
}

export interface CallAuctionAnomalyResult {
  trade_date: string;
  is_after_auction: boolean;
  server_clock: string;
  universe_size: number;
  anomalies: AuctionAnomalyItem[];
  summary: AuctionAnomalySummary;
  brief: string;
  status: CallAuctionStatus;
  message: string;
  components: CallAuctionComponents;
}

export interface GetCallAuctionTodayOptions {
  trade_date?: string;
  portfolio_id?: number;
}

/**
 * 获取「集合竞价异动卡片」当日数据。
 *
 * status='partial' / 'failed' 仍正常返回（components 内每个维度的 error 字段标识哪个数据源失败）。
 * 触发网络错误或 4xx/5xx 时抛 Error 让 caller 显示页面级降级。
 */
export async function getCallAuctionToday(
  options: GetCallAuctionTodayOptions = {}
): Promise<CallAuctionAnomalyResult> {
  const params: Record<string, string> = {};
  if (options.trade_date) params.trade_date = options.trade_date;
  if (options.portfolio_id != null) params.portfolio_id = String(options.portfolio_id);
  const response = await api.get<{
    success: boolean;
    data: CallAuctionAnomalyResult;
    message?: string;
  }>('/today/call-auction', { params });
  if (!response.data?.success) {
    throw new Error(response.data?.message || '获取集合竞价异动失败');
  }
  return response.data.data;
}

export const callAuctionService = {
  getCallAuctionToday,
};

export default callAuctionService;
