import moment from 'moment-timezone';
import { BudgetPolicyVersionSnapshot } from '../models/BudgetPolicyVersionSnapshot';
import { logger } from '../utils/logger';

function toOptionalNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

class BudgetPolicyVersionSnapshotService {
  async recordVersion(version: any, options: { username?: string; source?: string } = {}) {
    const version_id = String(version?.version_id || '').trim();
    if (!version_id) return null;

    try {
      const guard = asPlainObject(version.underperformance_guard);
      const current = asPlainObject(version.current_version_outcome);
      const payload = {
        version_id,
        version_hash: String(version.version_hash || '').trim(),
        schema: version.schema || 'budget_policy_weight_v1',
        generated_at: this.parseGeneratedAt(version.generated_at),
        lookback_days: toOptionalNumber(version.lookback_days),
        action_count: toOptionalNumber(version.action_count),
        audit_feedback_applied_count: toOptionalNumber(version.audit_feedback_applied_count),
        guard_action: guard.action,
        guard_severity: guard.severity,
        guarded_from_version_id: version.guarded_from_version_id || version.raw_version_id,
        champion_version_id: guard.champion_version_id,
        champion_avg_excess_return_pct: toOptionalNumber(guard.champion_avg_excess_return_pct),
        champion_capital_efficiency_score: toOptionalNumber(
          guard.champion_capital_efficiency_score
        ),
        comparison_efficiency_gap: toOptionalNumber(version.comparison_efficiency_gap),
        comparison_excess_gap: toOptionalNumber(version.comparison_excess_gap),
        current_closed_count: toOptionalNumber(current.closed_count ?? guard.current_closed_count),
        current_avg_excess_return_pct: toOptionalNumber(
          current.avg_excess_return_pct ?? guard.current_avg_excess_return_pct
        ),
        current_capital_efficiency_score: toOptionalNumber(
          current.capital_efficiency_score ?? guard.current_capital_efficiency_score
        ),
        reason: version.reason ? String(version.reason).slice(0, 1000) : undefined,
        action_weights: Array.isArray(version.action_weights) ? version.action_weights : [],
        underperformance_guard: guard,
        current_version_outcome: current,
        version_rankings: Array.isArray(version.version_rankings)
          ? version.version_rankings.slice(0, 20)
          : [],
        payload: asPlainObject(version.payload),
        metadata: {
          username: options.username,
          source: options.source || 'optimization_dashboard',
          recorded_at: new Date().toISOString(),
          raw_version_hash: version.raw_version_hash,
          comparison_champion_label: version.comparison_champion_label,
          audit_feedback_reason: version.audit_feedback_reason,
        },
      };

      const existing = await BudgetPolicyVersionSnapshot.findOne({ where: { version_id } });
      if (existing) {
        await existing.update(payload as any);
        return existing;
      }
      return await BudgetPolicyVersionSnapshot.create(payload as any);
    } catch (error: any) {
      logger.warn(`记录预算权重版本快照失败 ${version_id}: ${error?.message || error}`);
      return null;
    }
  }

  async getRecentSnapshots(options: { limit?: number } = {}) {
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit || 8))));
    return BudgetPolicyVersionSnapshot.findAll({
      order: [['generated_at', 'DESC']],
      limit,
      raw: true,
    });
  }

  private parseGeneratedAt(value: any): Date {
    if (!value) return new Date();
    const parsed = moment.tz(String(value), 'Asia/Shanghai');
    if (parsed.isValid()) return parsed.toDate();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }
}

export const budgetPolicyVersionSnapshotService = new BudgetPolicyVersionSnapshotService();
export default budgetPolicyVersionSnapshotService;
