type RiskThresholdAction = 'tighten' | 'relax' | 'keep' | 'observe';

export interface RiskThresholdHistoryItem {
  action: RiskThresholdAction;
  loop_run_id?: string;
  generated_at?: string | Date;
  reason?: string;
}

export interface RiskThresholdStability {
  latest_action: RiskThresholdAction;
  latest_action_label: string;
  consecutive_same_action: number;
  actionable_samples: number;
  window_size: number;
  can_apply: boolean;
  confidence: number;
  evidence_passed: boolean;
  protection_delta_pct?: number;
  protected_runs?: number;
  thresholds: RiskThresholdStabilityConfig;
  label: string;
  reason: string;
  history: RiskThresholdHistoryItem[];
}

export interface RiskThresholdStabilityConfig {
  min_consecutive_same_action: number;
  min_actionable_samples: number;
  min_protected_runs: number;
  tighten_min_protection_delta_pct: number;
  relax_max_protection_delta_pct: number;
}

const DEFAULT_STABILITY_CONFIG: RiskThresholdStabilityConfig = {
  min_consecutive_same_action: 2,
  min_actionable_samples: 2,
  min_protected_runs: 3,
  tighten_min_protection_delta_pct: 0.5,
  relax_max_protection_delta_pct: -0.8,
};

const RISK_THRESHOLD_ACTION_LABELS: Record<RiskThresholdAction, string> = {
  tighten: '收紧',
  relax: '放松',
  keep: '保持',
  observe: '观察',
};

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function roundNumber(value: any, digits = 2): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function normalizeAction(value: any): RiskThresholdAction | null {
  const action = String(value || '').toLowerCase();
  if (['tighten', 'relax', 'keep', 'observe'].includes(action)) {
    return action as RiskThresholdAction;
  }
  return null;
}

class RiskThresholdStabilityService {
  buildConfigFromParameters(parameters: any): Partial<RiskThresholdStabilityConfig> {
    const params = asPlainObject(parameters);
    return {
      min_consecutive_same_action:
        params.risk_threshold_stability_min_consecutive_same_action,
      min_actionable_samples: params.risk_threshold_stability_min_actionable_samples,
      min_protected_runs: params.risk_threshold_stability_min_protected_runs,
      tighten_min_protection_delta_pct:
        params.risk_threshold_stability_tighten_min_delta_pct,
      relax_max_protection_delta_pct: params.risk_threshold_stability_relax_max_delta_pct,
    };
  }

  normalizeConfigForDisplay(
    config: Partial<RiskThresholdStabilityConfig> = {}
  ): RiskThresholdStabilityConfig {
    return this.normalizeConfig(config);
  }

  buildFromSnapshots(
    snapshots: any[] = [],
    evidence: { protection_delta_pct?: number; protected_runs?: number } = {},
    config: Partial<RiskThresholdStabilityConfig> = {}
  ): RiskThresholdStability {
    return this.buildFromHistory(
      (snapshots || [])
        .map(snapshot => this.extractHistoryItem(snapshot))
        .filter(Boolean) as RiskThresholdHistoryItem[],
      evidence,
      config
    );
  }

  buildFromHistory(
    history: RiskThresholdHistoryItem[] = [],
    evidence: { protection_delta_pct?: number; protected_runs?: number } = {},
    config: Partial<RiskThresholdStabilityConfig> = {}
  ): RiskThresholdStability {
    const thresholds = this.normalizeConfig(config);
    const actions = (history || []).filter(item => normalizeAction(item.action));
    const latestAction = actions[0]?.action || 'observe';
    let consecutiveSameAction = 0;

    for (const item of actions) {
      if (item.action === latestAction) consecutiveSameAction += 1;
      else break;
    }

    const actionable = ['tighten', 'relax'].includes(latestAction);
    const actionableSamples = actions.filter(item => ['tighten', 'relax'].includes(item.action))
      .length;
    const protectedRuns = Number(evidence.protected_runs || 0);
    const protectionDeltaPct =
      evidence.protection_delta_pct !== undefined
        ? Number(evidence.protection_delta_pct)
        : undefined;
    const hasEvidence =
      protectedRuns >= thresholds.min_protected_runs && Number.isFinite(Number(protectionDeltaPct));
    const evidencePassed =
      !actionable ||
      (latestAction === 'tighten' &&
        hasEvidence &&
        Number(protectionDeltaPct) >= thresholds.tighten_min_protection_delta_pct) ||
      (latestAction === 'relax' &&
        hasEvidence &&
        Number(protectionDeltaPct) <= thresholds.relax_max_protection_delta_pct);
    const canApply =
      actionable &&
      consecutiveSameAction >= thresholds.min_consecutive_same_action &&
      actionableSamples >= thresholds.min_actionable_samples &&
      evidencePassed;
    const confidence = canApply
      ? Math.min(0.9, 0.55 + consecutiveSameAction * 0.12)
      : actionable
      ? Math.min(0.62, 0.3 + consecutiveSameAction * 0.1 + (evidencePassed ? 0.12 : 0))
      : 0.3;
    const label = canApply
      ? '稳定建议'
      : actionable
      ? '观察建议'
      : latestAction === 'keep'
      ? '保持观察'
      : '样本不足';
    const evidenceText =
      hasEvidence && protectionDeltaPct !== undefined
        ? `保护样本 ${protectedRuns} 次，保护差值 ${roundNumber(protectionDeltaPct, 2)}pct`
        : `保护样本 ${protectedRuns}/${thresholds.min_protected_runs} 次，收益证据不足`;
    const reason = canApply
      ? `最近 ${consecutiveSameAction} 次风险阈值建议均为${
          RISK_THRESHOLD_ACTION_LABELS[latestAction]
        }，且${evidenceText}，可手动预览后应用。`
      : actionable
      ? `最近同向建议 ${consecutiveSameAction} 次，${evidenceText}，暂按观察处理，避免低样本误调参。`
      : latestAction === 'keep'
      ? '最近建议为保持当前阈值，无需主动应用。'
      : '风险闸门后验样本不足，继续积累自动荐股闭环样本。';

    return {
      latest_action: latestAction,
      latest_action_label: RISK_THRESHOLD_ACTION_LABELS[latestAction],
      consecutive_same_action: consecutiveSameAction,
      actionable_samples: actionableSamples,
      window_size: actions.length,
      can_apply: canApply,
      confidence: roundNumber(confidence, 4),
      evidence_passed: evidencePassed,
      protection_delta_pct:
        protectionDeltaPct !== undefined && Number.isFinite(Number(protectionDeltaPct))
          ? roundNumber(protectionDeltaPct, 4)
          : undefined,
      protected_runs: protectedRuns,
      thresholds,
      label,
      reason,
      history: actions.slice(0, 5),
    };
  }

  private normalizeConfig(
    config: Partial<RiskThresholdStabilityConfig>
  ): RiskThresholdStabilityConfig {
    return {
      min_consecutive_same_action: this.positiveInt(
        config.min_consecutive_same_action,
        DEFAULT_STABILITY_CONFIG.min_consecutive_same_action
      ),
      min_actionable_samples: this.positiveInt(
        config.min_actionable_samples,
        DEFAULT_STABILITY_CONFIG.min_actionable_samples
      ),
      min_protected_runs: this.positiveInt(
        config.min_protected_runs,
        DEFAULT_STABILITY_CONFIG.min_protected_runs
      ),
      tighten_min_protection_delta_pct: this.finiteNumber(
        config.tighten_min_protection_delta_pct,
        DEFAULT_STABILITY_CONFIG.tighten_min_protection_delta_pct
      ),
      relax_max_protection_delta_pct: this.finiteNumber(
        config.relax_max_protection_delta_pct,
        DEFAULT_STABILITY_CONFIG.relax_max_protection_delta_pct
      ),
    };
  }

  private positiveInt(value: any, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }

  private finiteNumber(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private extractHistoryItem(snapshot: any): RiskThresholdHistoryItem | null {
    const runMetrics = asPlainObject(snapshot?.run_metrics);
    const paperTrading = asPlainObject(runMetrics.paper_trading);
    const metadata = asPlainObject(snapshot?.metadata);
    const loopPolicy = asPlainObject(snapshot?.loop_policy);
    const gate = asPlainObject(
      metadata.risk_profile_gate ||
        loopPolicy.risk_profile_gate ||
        runMetrics.risk_profile_gate ||
        paperTrading.risk_profile_gate
    );
    const threshold = asPlainObject(gate.threshold_version);
    const action = normalizeAction(threshold.action);
    if (!action) return null;

    return {
      action,
      loop_run_id: snapshot?.loop_run_id,
      generated_at: snapshot?.generated_at,
      reason: threshold.reason,
    };
  }
}

export const riskThresholdStabilityService = new RiskThresholdStabilityService();
