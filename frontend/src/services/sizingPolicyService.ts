/**
 * sizingPolicyService — Phase 2 用户 sizing 配置 CRUD
 *
 * 对应后端 /api/risk/sizing-policy GET/PUT
 */
import api from './api';

export type SizingMethod = 'equal_pct' | 'vol_target' | 'atr_based';

export interface SizingPolicyConfig {
  method: SizingMethod;
  base_position_pct: number;
  max_position_pct: number;
  vol_target_pct: number;
  vol_max_lookback_days: number;
  atr_risk_pct: number;
  atr_period: number;
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

export async function updateSizingPolicy(payload: Partial<SizingPolicyConfig>): Promise<SizingPolicyConfig> {
  const res = await api.put('/risk/sizing-policy', payload);
  if (!res.data?.success) throw new Error(res.data?.message || '更新 sizing policy 失败');
  return res.data.data as SizingPolicyConfig;
}

export const sizingPolicyService = {
  getSizingPolicy,
  updateSizingPolicy,
};

export default sizingPolicyService;
