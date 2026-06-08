import api from './api';

/**
 * US-079 数据健康度看板前端 API 客户端。
 *
 * 调用 2 个后端端点：
 *   - GET  /api/data/health-status        → getDataHealthStatus()
 *   - POST /api/data/sync/:source         → triggerDataSync(source, date?)
 *
 * 所有响应遵循后端统一信封 `{ success, data, message? }`，
 * service 层把内层数据 unwrap 后返回给组件，错误抛 JS Error。
 */

export type DataHealthLevel = 'green' | 'yellow' | 'red' | 'unknown';

export type DataSourceCategory = 'daily' | 'periodic' | 'event';

export interface DataSourceHealthCard {
  key: string;
  display_name: string;
  category: DataSourceCategory;
  latest_data_date: string | null;
  last_sync_at: string | null;
  record_count: number;
  lag_trading_days: number | null;
  level: DataHealthLevel;
  sync_source: string;
  description: string;
  error?: string;
}

export interface DataHealthStatusResponse {
  reference_trade_date: string | null;
  cards: DataSourceHealthCard[];
  summary: Record<DataHealthLevel, number>;
  generated_at: string;
}

export interface DataSyncResult {
  success: boolean;
  source: string;
  date: string;
  result?: unknown;
  error?: string;
}

/**
 * 拉取全部数据源健康状态卡片。
 */
export async function getDataHealthStatus(): Promise<DataHealthStatusResponse> {
  const res = await api.get('/data/health-status');
  if (!res.data?.success) {
    throw new Error(res.data?.error || res.data?.message || '获取数据健康状态失败');
  }
  return res.data.data as DataHealthStatusResponse;
}

/**
 * 手动触发指定数据源的当日同步。
 * - source：北向 / 龙虎榜 / 涨停 / 行业流 / 雪球热词 (其他周期性源走运维 CLI)
 * - date：可选，默认服务端 today。格式 YYYY-MM-DD
 */
export async function triggerDataSync(source: string, date?: string): Promise<DataSyncResult> {
  const res = await api.post(`/data/sync/${encodeURIComponent(source)}`, date ? { date } : {});
  // service 层不抛错，让组件根据 success / error 自己显示——同步失败常见（节假日 / 网络），
  // 抛 Error 会让上层逻辑无法区分 "服务异常" vs "数据源当日无数据"。
  return res.data as DataSyncResult;
}

const dataHealthService = {
  getDataHealthStatus,
  triggerDataSync,
};

export default dataHealthService;
