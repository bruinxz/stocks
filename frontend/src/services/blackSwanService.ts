import api from './api';

/**
 * US-133 [PR-018] — 黑天鹅事件历史前端 service.
 *
 * 消费 `/api/black-swan/events` + `/api/black-swan/events/:id` 两条只读接口.
 *
 * 与既有 riskAlertService.ts 边界:
 *   - riskAlertService — 操作 RiskAlert (per-user-per-position), 用于告警铃铛 / 标记已读.
 *   - 本服务 — BlackSwanEvent (global 视角) + BlackSwanPostmortemReport (per-event 复盘).
 *
 * 任何"写"路径 (强 resolve / 调 severity) 未来再加, 本 story 仅 read-only.
 */

export type BlackSwanEventType =
  | 'ST'
  | 'SUSPENDED'
  | 'NEWS_KEYWORD'
  | 'SHAREHOLDER_REDUCTION'
  | 'MARKET_REGIME'
  | 'OTHER';

export type BlackSwanSeverity = 'low' | 'medium' | 'high' | 'critical';

export type BlackSwanScope = 'symbol' | 'sector' | 'market' | 'portfolio';

export type BlackSwanStatus = 'open' | 'resolved' | 'expired';

export type BlackSwanSource = 'detector_cron' | 'watchdog' | 'manual' | 'external';

export interface BlackSwanEventRow {
  id: number;
  detected_at: string;
  event_type: BlackSwanEventType | string;
  severity: BlackSwanSeverity | string;
  scope: BlackSwanScope | string;
  symbol: string | null;
  signature: string;
  title: string;
  description: string;
  detail: Record<string, unknown>;
  scope_detail: Record<string, unknown>;
  source: BlackSwanSource | string;
  status: BlackSwanStatus | string;
  resolved_at: string | null;
  resolved_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BlackSwanPostmortemRow {
  id: number;
  black_swan_event_id: number;
  title: string;
  summary: string;
  event_summary: Record<string, unknown>;
  counterfactual_baselines: Record<string, unknown>;
  event_timeline: Record<string, unknown>;
  improvement_suggestions: Record<string, unknown>;
  source: string;
  status: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  generated_at: string;
  created_at: string;
  updated_at: string;
}

export interface ListEventsResult {
  items: BlackSwanEventRow[];
  total: number;
  page: number;
  limit: number;
}

export interface GetEventResult {
  event: BlackSwanEventRow;
  postmortem: BlackSwanPostmortemRow | null;
}

export interface ListEventsFilters {
  event_type?: BlackSwanEventType | '';
  severity?: BlackSwanSeverity | '';
  scope?: BlackSwanScope | '';
  status?: BlackSwanStatus | '';
  symbol?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

/** 拉一页事件列表 — query 参数空串自动跳过 (axios 默认行为). */
export async function listBlackSwanEvents(
  filters: ListEventsFilters = {}
): Promise<ListEventsResult> {
  const params: Record<string, unknown> = {};
  if (filters.event_type) params.event_type = filters.event_type;
  if (filters.severity) params.severity = filters.severity;
  if (filters.scope) params.scope = filters.scope;
  if (filters.status) params.status = filters.status;
  if (filters.symbol) params.symbol = filters.symbol;
  if (filters.date_from) params.date_from = filters.date_from;
  if (filters.date_to) params.date_to = filters.date_to;
  if (filters.page != null) params.page = filters.page;
  if (filters.limit != null) params.limit = filters.limit;
  const res = await api.get('/black-swan/events', { params });
  return res.data?.data as ListEventsResult;
}

/** 拉单事件详情 + 关联 postmortem (postmortem 可能 null 表示待生成). */
export async function getBlackSwanEvent(id: number): Promise<GetEventResult> {
  const res = await api.get(`/black-swan/events/${id}`);
  return res.data?.data as GetEventResult;
}
