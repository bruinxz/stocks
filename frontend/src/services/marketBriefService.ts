import api from './api';

/**
 * US-073 「AI 大盘速读」前端 API 客户端。
 *
 * 调用：
 *   - GET /api/ai/market-brief/today        → getMarketBriefToday()
 *
 * 数据形态对齐 backend `MarketBriefService.MarketBriefResult`：
 *   - 5 维原始数据 (沪深300 上日收盘 / 今日开盘 / 北向 / 涨停数 / AI 一句话);
 *   - status: 'ok' | 'partial' | 'failed' ─ 部分维度缺失走 partial 仍可显示；
 *   - nlp_engine: trading_agents | heuristic_fallback ─ UI 标签源头；
 *   - components: 各数据源独立 `error` 字段供 UI drill-down。
 *
 * 后端 controller `getMarketBriefToday` 加 `?refresh=true` 可绕过 cache。
 */

export type MarketBriefStatus = 'ok' | 'partial' | 'failed';

export interface MarketBriefBenchmarkComponent {
  symbol: string;
  prev_close: number | null;
  today_open: number | null;
  open_change_pct: number | null;
  error: string | null;
}

export interface MarketBriefNorthboundComponent {
  net_amount_yi: number | null;
  sample_count: number;
  error: string | null;
}

export interface MarketBriefLimitUpComponent {
  count: number | null;
  error: string | null;
}

export interface MarketBriefAIComponent {
  engine: string | null;
  error: string | null;
}

export interface MarketBriefComponents {
  benchmark: MarketBriefBenchmarkComponent;
  northbound: MarketBriefNorthboundComponent;
  limit_up: MarketBriefLimitUpComponent;
  ai_view: MarketBriefAIComponent;
}

export interface MarketBriefResult {
  trade_date: string;
  prev_close: number | null;
  today_open: number | null;
  open_change_pct: number | null;
  northbound_net_amount: number | null;
  limit_up_count: number | null;
  ai_view: string | null;
  nlp_engine: string | null;
  status: MarketBriefStatus;
  message: string;
  components: MarketBriefComponents;
  persisted: boolean;
  dry_run: boolean;
}

export interface GetMarketBriefTodayOptions {
  /** 覆盖默认 today（YYYY-MM-DD） */
  date?: string;
  /** true=强制重新生成，绕过 DB 缓存 */
  refresh?: boolean;
}

/**
 * 获取「AI 大盘速读」当日卡片数据。
 *
 * status='partial' / 'failed' 仍正常返回（components 内每个维度的 error 字段标识哪个数据源失败）。
 * 触发网络错误或 4xx/5xx 时抛 Error 让 caller 显示页面级降级。
 */
export async function getMarketBriefToday(
  options: GetMarketBriefTodayOptions = {}
): Promise<MarketBriefResult> {
  const params: Record<string, string> = {};
  if (options.date) params.date = options.date;
  if (options.refresh) params.refresh = 'true';
  const response = await api.get<{
    success: boolean;
    data: MarketBriefResult;
    message?: string;
  }>('/ai/market-brief/today', { params });
  if (!response.data?.success) {
    throw new Error(response.data?.message || '获取 AI 大盘速读失败');
  }
  return response.data.data;
}

export const marketBriefService = {
  getMarketBriefToday,
};

export default marketBriefService;
