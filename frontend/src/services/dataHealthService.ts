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

// ============================================================================
// US-064 [FE-025] DataWorkspace 数据源切换 — provider health + routing plans
// ----------------------------------------------------------------------------
// 后端事实源 backend/src/data/services/DataSourceHealthService.ts:
//   - GET /api/market/data-sources/health 一次性返 providers + routing_plans
//     + quant_readiness, 与 DataUpdateStatus.tsx 沿用同款 endpoint
//   - provider.status: healthy / degraded / unhealthy / disabled / unknown
//   - routing_plans[feature]: 已按 route_score / 健康度排序的 provider 列表,
//     rank=1 即"主用源", rank>=2 即"备用源"; is_preferred=true 表示用户/env
//     显式指定 (DATA_SOURCE_PREFERENCE / preferred_provider override)
// ============================================================================

/** 单个 provider 的健康状态 (与 DataSourceHealth model 一一对应). */
export interface DataSourceProvider {
  id?: number | null;
  provider_name: string;
  provider_label: string;
  provider_type: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'disabled' | 'unknown' | string;
  priority: number;
  is_enabled: boolean;
  supported_features: string[];
  health_score: number;
  success_count: number;
  failure_count: number;
  consecutive_failures: number;
  last_success_at?: string | null;
  last_failure_at?: string | null;
  last_latency_ms?: number | null;
  last_checked_at?: string | null;
  last_error?: string | null;
  metadata?: Record<string, any>;
}

/** 单个 feature 的路由条目 (provider + rank + route_score). */
export interface DataSourceRoutingEntry extends DataSourceProvider {
  rank: number;
  feature: string;
  route_score: number;
  route_reason?: string;
  preference_rank?: number | null;
  is_preferred?: boolean;
}

/** /api/market/data-sources/health 的完整响应. */
export interface DataSourceHealthBundle {
  status: string;
  summary: {
    total_providers: number;
    enabled_providers: number;
    healthy_providers: number;
    degraded_providers: number;
    unhealthy_providers: number;
    disabled_providers: number;
    avg_health_score: number;
  };
  providers: DataSourceProvider[];
  routing_plans?: Record<string, DataSourceRoutingEntry[]>;
  quant_readiness?: {
    score?: number;
    status?: string;
    summary?: string;
    primary_history_provider?: string | null;
    primary_stock_list_provider?: string | null;
    primary_stock_basic_provider?: string | null;
    primary_fundamental_provider?: string | null;
    primary_money_flow_provider?: string | null;
    primary_valuation_provider?: string | null;
    realtime_providers?: string[];
    missing_configs?: string[];
    recommendations?: string[];
    capability_notes?: string[];
    [key: string]: unknown;
  };
  probe_result?: unknown;
}

/**
 * 拉取数据源健康 + 路由计划. refresh=true 会触发主动 probe (更慢, 一般 ops
 * 手动按钮触发, 默认 polling 用 false).
 */
export async function getDataSourceProvidersStatus(
  refresh = false
): Promise<DataSourceHealthBundle> {
  const res = await api.get('/market/data-sources/health', {
    params: refresh ? { refresh: 'true' } : undefined,
  });
  if (!res.data?.success) {
    throw new Error(res.data?.error || res.data?.message || '获取数据源健康状态失败');
  }
  return res.data.data as DataSourceHealthBundle;
}

const dataHealthService = {
  getDataHealthStatus,
  triggerDataSync,
  getDataSourceProvidersStatus,
};

export default dataHealthService;
