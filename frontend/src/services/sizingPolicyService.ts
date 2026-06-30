/**
 * sizingPolicyService — Phase 2 用户 sizing 配置 CRUD
 *
 * 对应后端 /api/risk/sizing-policy GET/PUT
 */
import api from './api';

export type SizingMethod = 'equal_pct' | 'vol_target' | 'atr_based' | 'kelly';

export interface SizingPolicyConfig {
  method: SizingMethod;
  base_position_pct: number;
  max_position_pct: number;
  vol_target_pct: number;
  vol_max_lookback_days: number;
  atr_risk_pct: number;
  atr_period: number;
  /** kelly 用：分数 Kelly 乘数 (0.05-1.0)，默认 0.25 (Quarter Kelly) */
  kelly_fraction_multiplier: number;
  /** kelly 用：低于此样本数退化到 base_position_pct */
  kelly_min_sample_size: number;
  /**
   * Phase 2+ 硬切换开关 (默认 false = shadow mode)。
   * - false: 只 log 决策，下单仍走 equal_pct
   * - true: decideSizing 算出的 position_pct 真正替换 effectiveTargetPct
   * 切换前建议先观察 7-14 天 [shadow-sizing] log 确认 delta 合理。
   */
  hard_cutover_enabled: boolean;
}

export interface SizingPolicyWithDefaults {
  current: SizingPolicyConfig;
  defaults: SizingPolicyConfig;
}

export async function getSizingPolicy(): Promise<SizingPolicyWithDefaults> {
  const res = await api.get('/risk/sizing-policy');
  if (!res.data?.success) throw new Error(res.data?.message || '获取 sizing policy 失败');
  return res.data.data as SizingPolicyWithDefaults;
}

export async function updateSizingPolicy(
  payload: Partial<SizingPolicyConfig>
): Promise<SizingPolicyConfig> {
  const res = await api.put('/risk/sizing-policy', payload);
  if (!res.data?.success) throw new Error(res.data?.message || '更新 sizing policy 失败');
  return res.data.data as SizingPolicyConfig;
}

// ============================================================
// Phase 2+ sizing 决策审计报告
// ============================================================

export interface SizingAuditSummary {
  count: number;
  hard_cutover_count: number;
  shadow_count: number;
  avg_actual_pct: number;
  avg_decision_pct: number;
  avg_delta_pct: number;
  max_abs_delta_pct: number;
  max_abs_delta_symbol?: string;
  capped_by_max_pct: number;
  capped_by_cash_pct: number;
}

export interface SizingAuditByStrategy {
  strategy_key: string;
  count: number;
  avg_actual_pct: number;
  avg_decision_pct: number;
  avg_delta_pct: number;
  method_breakdown: Record<string, number>;
}

export interface SizingAuditRow {
  id: number;
  symbol: string;
  strategy_key?: string;
  method: string;
  hard_cutover: boolean;
  actual_pct: number;
  decision_pct: number;
  delta: number;
  reason?: string;
  created_at: string;
}

export interface SizingAuditReport {
  generated_at: string;
  user_id: number;
  filter: {
    portfolio_id?: number;
    method?: string;
    lookback_days: number;
    start_date: string;
  };
  summary: SizingAuditSummary;
  by_strategy: SizingAuditByStrategy[];
  recent_rows: SizingAuditRow[];
}

export async function getSizingAudit(
  params: {
    lookback_days?: number;
    portfolio_id?: number;
    method?: string;
  } = {}
): Promise<SizingAuditReport> {
  const res = await api.get('/risk/sizing-audit', { params });
  if (!res.data?.success) throw new Error(res.data?.message || '获取 sizing audit 失败');
  return res.data.data as SizingAuditReport;
}

// ============================================================
// Phase 4+ Strategy kill switch monitor
// ============================================================

export interface KillSwitchEvaluation {
  strategy_key: string;
  metric: string;
  threshold: number;
  observed_value: number | null;
  sample_size: number;
  triggered: boolean;
  reason: string;
}

export interface KillSwitchMonitorResult {
  generated_at: string;
  total_strategies: number;
  evaluated: number;
  triggered: number;
  skipped_no_kill_switch: number;
  skipped_disabled: number;
  skipped_insufficient_data: number;
  evaluations: KillSwitchEvaluation[];
  errors: Array<{ strategy_key: string; message: string }>;
}

export async function getKillSwitchStatus(dryRun = true): Promise<KillSwitchMonitorResult> {
  const res = await api.get('/risk/kill-switch-status', {
    params: { dry_run: dryRun ? 'true' : 'false' },
  });
  if (!res.data?.success) throw new Error(res.data?.message || '获取 kill switch 状态失败');
  return res.data.data as KillSwitchMonitorResult;
}

export const sizingPolicyService = {
  getSizingPolicy,
  updateSizingPolicy,
  getSizingAudit,
  getKillSwitchStatus,
};

export default sizingPolicyService;
