import moment from 'moment-timezone';
import { BudgetPolicyVersionSnapshot } from '../models/BudgetPolicyVersionSnapshot';
import { logger } from '../utils/logger';

function toOptionalNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function modelToPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
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

  async getVersionIntelligence(
    options: {
      current_version?: any;
      limit?: number;
      min_closed_count?: number;
    } = {}
  ) {
    const limit = Math.max(5, Math.min(300, Math.floor(Number(options.limit || 120))));
    const minClosedCount = Math.max(2, Math.floor(Number(options.min_closed_count || 3)));
    const snapshots = (
      await BudgetPolicyVersionSnapshot.findAll({
        order: [['generated_at', 'DESC']],
        limit,
      })
    ).map(item => modelToPlain<any>(item));
    const current = this.normalizeCurrentVersion(options.current_version);
    const champion = this.pickChampionSnapshot(snapshots, current.version_id, minClosedCount);
    const rollbackPlan = this.buildRollbackPlan({
      current,
      champion,
      min_closed_count: minClosedCount,
    });
    const recentSnapshots = snapshots.slice(0, 10).map(item => this.compactSnapshot(item));
    const equityCurve = [...snapshots]
      .sort((a, b) => new Date(a.generated_at).getTime() - new Date(b.generated_at).getTime())
      .map(item => this.compactSnapshot(item));

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      snapshot_count: snapshots.length,
      min_closed_count: minClosedCount,
      current_version: current,
      champion_snapshot: champion ? this.compactSnapshot(champion) : null,
      rollback_plan: rollbackPlan,
      recent_snapshots: recentSnapshots,
      equity_curve: equityCurve,
      reason: rollbackPlan.reason,
    };
  }

  private normalizeCurrentVersion(version: any) {
    const outcome = asPlainObject(version?.current_version_outcome);
    const guard = asPlainObject(version?.underperformance_guard);
    return {
      version_id: String(version?.version_id || '').trim(),
      version_hash: String(version?.version_hash || '').trim(),
      closed_count: toNumber(outcome.closed_count ?? guard.current_closed_count, 0),
      avg_excess_return_pct: roundNumber(
        outcome.avg_excess_return_pct ?? guard.current_avg_excess_return_pct,
        4
      ),
      capital_efficiency_score: roundNumber(
        outcome.capital_efficiency_score ?? guard.current_capital_efficiency_score,
        4
      ),
      excess_win_rate: roundNumber(outcome.excess_win_rate, 2),
      action_weights: Array.isArray(version?.action_weights) ? version.action_weights : [],
    };
  }

  private pickChampionSnapshot(snapshots: any[], currentVersionId: string, minClosedCount: number) {
    return [...snapshots]
      .filter(item => {
        if (!item?.version_id || item.version_id === currentVersionId) return false;
        if (toNumber(item.current_closed_count, 0) < minClosedCount) return false;
        if (toNumber(item.current_avg_excess_return_pct, 0) <= 0) return false;
        if (toNumber(item.current_capital_efficiency_score, 0) <= 0) return false;
        return Array.isArray(item.action_weights) && item.action_weights.length > 0;
      })
      .sort(
        (a, b) =>
          this.snapshotScore(b) - this.snapshotScore(a) ||
          new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime()
      )[0];
  }

  private snapshotScore(snapshot: any): number {
    return (
      toNumber(snapshot.current_capital_efficiency_score, 0) +
      toNumber(snapshot.current_avg_excess_return_pct, 0) * 2.4 +
      Math.log1p(toNumber(snapshot.current_closed_count, 0)) * 2 -
      (snapshot.guard_action === 'protective_downgrade' ? 4 : 0)
    );
  }

  private buildRollbackPlan(options: { current: any; champion: any; min_closed_count: number }) {
    const { current, champion, min_closed_count: minClosedCount } = options;
    if (!champion) {
      return {
        enabled: false,
        apply: false,
        action: 'collect_samples',
        severity: 'info',
        reason: '尚未找到可复用的预算权重冠军，继续收集版本快照',
      };
    }

    const championEfficiency = toNumber(champion.current_capital_efficiency_score, 0);
    const championExcess = toNumber(champion.current_avg_excess_return_pct, 0);
    const currentEfficiency = toNumber(current.capital_efficiency_score, 0);
    const currentExcess = toNumber(current.avg_excess_return_pct, 0);
    const currentClosed = toNumber(current.closed_count, 0);
    const efficiencyGap = roundNumber(championEfficiency - currentEfficiency, 2);
    const excessGap = roundNumber(championExcess - currentExcess, 4);
    const championClosed = toNumber(champion.current_closed_count, 0);
    const championStrong = championClosed >= Math.max(5, minClosedCount) && championExcess >= 0.8;
    const currentUnderperforms =
      currentClosed >= minClosedCount &&
      (efficiencyGap >= 6 || excessGap >= 1.2) &&
      (currentEfficiency < 0 || currentExcess < 0 || toNumber(current.excess_win_rate, 50) < 45);
    const currentIsYoung = currentClosed < 2 && championStrong;

    if (currentUnderperforms) {
      return {
        enabled: true,
        apply: true,
        action: 'protective_rollback',
        severity: efficiencyGap >= 10 || excessGap >= 2 ? 'high' : 'medium',
        source_version_id: champion.version_id,
        source_snapshot_id: champion.id,
        source_version_hash: champion.version_hash,
        source_action_weights: Array.isArray(champion.action_weights)
          ? champion.action_weights
          : [],
        champion_closed_count: championClosed,
        champion_avg_excess_return_pct: roundNumber(championExcess, 4),
        champion_capital_efficiency_score: roundNumber(championEfficiency, 2),
        current_closed_count: currentClosed,
        current_avg_excess_return_pct: roundNumber(currentExcess, 4),
        current_capital_efficiency_score: roundNumber(currentEfficiency, 2),
        efficiency_gap: efficiencyGap,
        excess_gap: excessGap,
        blend_weight: 1,
        reason: `持久化快照显示当前版本跑输冠军 ${champion.version_id}，效率差 ${efficiencyGap}、超额差 ${excessGap}%，下一轮回滚继承冠军权重`,
      };
    }

    if (currentIsYoung) {
      return {
        enabled: true,
        apply: true,
        action: 'champion_warm_start',
        severity: 'low',
        source_version_id: champion.version_id,
        source_snapshot_id: champion.id,
        source_version_hash: champion.version_hash,
        source_action_weights: Array.isArray(champion.action_weights)
          ? champion.action_weights
          : [],
        champion_closed_count: championClosed,
        champion_avg_excess_return_pct: roundNumber(championExcess, 4),
        champion_capital_efficiency_score: roundNumber(championEfficiency, 2),
        current_closed_count: currentClosed,
        efficiency_gap: efficiencyGap,
        excess_gap: excessGap,
        blend_weight: 0.65,
        reason: `当前版本尚年轻，先按 65% 权重继承历史冠军 ${champion.version_id}，降低冷启动试错成本`,
      };
    }

    return {
      enabled: true,
      apply: false,
      action: 'compare',
      severity: 'info',
      source_version_id: champion.version_id,
      source_snapshot_id: champion.id,
      champion_closed_count: championClosed,
      champion_avg_excess_return_pct: roundNumber(championExcess, 4),
      champion_capital_efficiency_score: roundNumber(championEfficiency, 2),
      current_closed_count: currentClosed,
      efficiency_gap: efficiencyGap,
      excess_gap: excessGap,
      reason: `当前版本与持久化冠军 ${champion.version_id} 对比中，暂不回滚`,
    };
  }

  private compactSnapshot(snapshot: any) {
    return {
      id: snapshot.id,
      version_id: snapshot.version_id,
      version_hash: snapshot.version_hash,
      generated_at: snapshot.generated_at,
      guard_action: snapshot.guard_action,
      guard_severity: snapshot.guard_severity,
      guarded_from_version_id: snapshot.guarded_from_version_id,
      champion_version_id: snapshot.champion_version_id,
      current_closed_count: toNumber(snapshot.current_closed_count, 0),
      current_avg_excess_return_pct: roundNumber(snapshot.current_avg_excess_return_pct, 4),
      current_capital_efficiency_score: roundNumber(snapshot.current_capital_efficiency_score, 2),
      comparison_efficiency_gap: roundNumber(snapshot.comparison_efficiency_gap, 2),
      comparison_excess_gap: roundNumber(snapshot.comparison_excess_gap, 4),
      score: roundNumber(this.snapshotScore(snapshot), 2),
      reason: snapshot.reason,
    };
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
