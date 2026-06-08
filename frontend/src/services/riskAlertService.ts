import api from './api';

/**
 * US-077 风控告警中心 — 前端 API 客户端。
 *
 * 调用 5 个后端端点：
 *   - GET  /api/risk-alerts/list         → listRiskAlerts() — 分页 + 过滤
 *   - PUT  /api/risk-alerts/mark-read    → markAlertsAsRead() — 批量按 ID
 *   - PUT  /api/risk-alerts/read-all     → markAllRiskAlertsRead() — 全部已读
 *   - PUT  /api/risk-alerts/:id/read     → markSingleRiskAlertRead() — 单条已读
 *   - GET  /api/risk-alerts              → getLegacyRiskAlerts() — 老 50 条预览（兼容）
 *
 * 信封：所有响应 `{ success, data, message? }`；service 层解出 data 返回；
 * success=false 抛 JS Error（与 factorService / portfolioWorkspaceService 一致）。
 */

// ---------- 类型 ----------

export type AlertCategory = 'position' | 'market' | 'individual';

export interface RiskAlertItem {
  id: number;
  user_id: number;
  symbol: string;
  name: string;
  level: string;
  message: string;
  rule_id?: string | null;
  is_read: boolean;
  created_at: string;
  updated_at: string;
  category: AlertCategory;
}

export interface RiskAlertListResponse {
  items: RiskAlertItem[];
  total: number;
  page: number;
  limit: number;
  unread_count: number;
}

export interface RiskAlertListParams {
  level?: 'HIGH' | 'MEDIUM' | 'LOW';
  type?: AlertCategory;
  date_from?: string;
  date_to?: string;
  is_read?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}

export interface MarkReadResponse {
  updated: number;
}

// ---------- API 调用 ----------

export async function listRiskAlerts(
  params: RiskAlertListParams = {}
): Promise<RiskAlertListResponse> {
  // 把 undefined 字段移除（axios 否则可能 ?level=undefined 传出去）
  const cleanParams: Record<string, string | number | boolean> = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      cleanParams[k] = v as string | number | boolean;
    }
  });
  const res = await api.get('/risk-alerts/list', { params: cleanParams });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取风控告警列表失败');
  }
  return res.data.data as RiskAlertListResponse;
}

export async function markAlertsAsRead(ids: number[]): Promise<MarkReadResponse> {
  const res = await api.put('/risk-alerts/mark-read', { ids });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '批量标记已读失败');
  }
  return res.data.data as MarkReadResponse;
}

export async function markAllRiskAlertsRead(): Promise<void> {
  const res = await api.put('/risk-alerts/read-all');
  if (!res.data?.success) {
    throw new Error(res.data?.message || '一键标记已读失败');
  }
}

export async function markSingleRiskAlertRead(id: number): Promise<void> {
  const res = await api.put(`/risk-alerts/${id}/read`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '标记已读失败');
  }
}

// ---------- 辅助 ----------

/**
 * 派生 category — 前端兜底分类（与后端 deriveAlertCategory 同款语义）。
 * 后端 listAlerts 已经把 category 字段填上；这里保留是为支持
 * legacy /api/risk-alerts 入口（旧 50 条预览）需要前端自己分类的情况。
 */
export function deriveAlertCategory(alert: {
  symbol?: string | null;
  rule_id?: string | null;
}): AlertCategory {
  const ruleId = String(alert.rule_id || '').toLowerCase();
  const symbol = String(alert.symbol || '');

  if (
    ruleId === 'position_limit' ||
    ruleId === 'industry_concentration' ||
    ruleId === 'drawdown_breaker' ||
    ruleId === 'trailing_stop' ||
    ruleId === 'per_stock_stop_loss'
  ) {
    return 'position';
  }
  if (
    ruleId === 'market_regime_alert' ||
    ruleId === 'factor_correlation' ||
    ruleId === 'black_swan'
  ) {
    return 'market';
  }
  if (symbol.startsWith('SYSTEM:')) return 'market';
  return 'individual';
}

export const ALERT_CATEGORY_LABEL: Record<AlertCategory, string> = {
  position: '持仓',
  market: '市场',
  individual: '单股',
};

export const ALERT_LEVEL_LABEL: Record<string, string> = {
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
};

// ---------- bundled export ----------

export const riskAlertService = {
  listRiskAlerts,
  markAlertsAsRead,
  markAllRiskAlertsRead,
  markSingleRiskAlertRead,
  deriveAlertCategory,
};

export default riskAlertService;
