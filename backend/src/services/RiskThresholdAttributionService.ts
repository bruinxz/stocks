type ThresholdAction = 'tighten' | 'relax' | 'keep' | 'observe';

export interface RiskThresholdAttributionItem {
  key: string;
  label: string;
  action: ThresholdAction;
  reason: string;
  confidence: number;
  sample_count: number;
  triggered_count: number;
  breach_rate_pct: number;
  avg_excess_return_pct: number;
  trigger_avg_excess_return_pct?: number;
  non_trigger_avg_excess_return_pct?: number;
  trigger_delta_pct?: number;
  current_limit?: number;
  suggested_limit?: number;
}

const THRESHOLD_DEFINITIONS = [
  {
    key: 'min_cash_reserve_pct',
    label: '现金底线',
    metric_keys: ['cash_pct'],
    direction: 'min',
    step: 2,
    min: 3,
    max: 30,
  },
  {
    key: 'max_total_exposure_pct',
    label: '总仓位',
    metric_keys: ['exposure_pct', 'total_exposure_pct'],
    direction: 'max',
    step: 5,
    min: 25,
    max: 95,
  },
  {
    key: 'max_portfolio_drawdown_pct',
    label: '组合回撤',
    metric_keys: ['drawdown_abs_pct', 'abs_drawdown_pct', 'max_drawdown_pct', 'drawdown_pct'],
    direction: 'max_abs',
    step: 2,
    min: 4,
    max: 35,
  },
  {
    key: 'max_industry_exposure_pct',
    label: '行业集中',
    metric_keys: ['max_industry_exposure_pct', 'industry_exposure_pct'],
    direction: 'max',
    step: 3,
    min: 10,
    max: 60,
  },
  {
    key: 'max_position_correlation',
    label: '持仓相关性',
    metric_keys: ['max_position_correlation', 'max_pair_correlation'],
    direction: 'max',
    step: 0.03,
    min: 0.35,
    max: 0.95,
  },
  {
    key: 'max_portfolio_var_pct',
    label: '组合VaR',
    metric_keys: ['portfolio_var_pct', 'portfolio_var_proxy_pct'],
    direction: 'max',
    step: 1,
    min: 3,
    max: 25,
  },
  {
    key: 'max_single_stock_volatility_pct',
    label: '单票波动',
    metric_keys: [
      'max_single_stock_volatility_pct',
      'single_stock_volatility_pct',
      'max_volatility_20d_pct',
    ],
    direction: 'max',
    step: 1,
    min: 3,
    max: 25,
  },
] as const;

const BASELINE_LIMITS: Record<string, number> = {
  min_cash_reserve_pct: 8,
  max_total_exposure_pct: 60,
  max_portfolio_drawdown_pct: 12,
  max_industry_exposure_pct: 25,
  max_position_correlation: 0.82,
  max_portfolio_var_pct: 10,
  max_single_stock_volatility_pct: 7,
};

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export class RiskThresholdAttributionService {
  buildFromSnapshots(
    snapshots: any[] = [],
    currentLimits: Record<string, any> = {}
  ): {
    generated_at: string;
    sample_count: number;
    conclusion: string;
    items: RiskThresholdAttributionItem[];
  } {
    const normalized = (snapshots || [])
      .map(snapshot => this.extractSnapshotRiskEvidence(snapshot))
      .filter(item => item.has_metrics || Number.isFinite(item.excess_return_pct));

    const items = THRESHOLD_DEFINITIONS.map(definition =>
      this.buildItem(definition, normalized, currentLimits)
    );
    const actionable = items.filter(item => ['tighten', 'relax'].includes(item.action));
    const strongest = [...actionable].sort((a, b) => b.confidence - a.confidence)[0];

    return {
      generated_at: new Date().toISOString(),
      sample_count: normalized.length,
      conclusion: strongest
        ? `分项归因显示「${strongest.label}」最值得关注：${strongest.reason}`
        : normalized.length >= 3
        ? '各风险阈值暂未出现稳定单项信号，建议保持当前参数并继续观察。'
        : '风险阈值分项样本不足，继续积累自动荐股闭环样本。',
      items,
    };
  }

  private buildItem(
    definition: (typeof THRESHOLD_DEFINITIONS)[number],
    snapshots: Array<{
      metrics: Record<string, any>;
      excess_return_pct: number;
      gate_action: string;
      has_metrics: boolean;
    }>,
    currentLimits: Record<string, any>
  ): RiskThresholdAttributionItem {
    const currentLimit = toNumber(currentLimits[definition.key], BASELINE_LIMITS[definition.key]);
    const rows = snapshots
      .map(snapshot => ({
        metric_value: this.normalizeMetricValue(
          definition,
          this.pickMetric(snapshot.metrics, definition.metric_keys)
        ),
        excess_return_pct: snapshot.excess_return_pct,
        gate_action: snapshot.gate_action,
      }))
      .filter(row => Number.isFinite(row.metric_value));

    const triggered = rows.filter(row =>
      definition.direction === 'min'
        ? row.metric_value < currentLimit
        : row.metric_value > currentLimit
    );
    const nonTriggered = rows.filter(row => !triggered.includes(row));
    const triggerAvg = average(triggered.map(row => row.excess_return_pct));
    const nonTriggerAvg = average(nonTriggered.map(row => row.excess_return_pct));
    const avgExcess = average(rows.map(row => row.excess_return_pct));
    const delta = triggered.length && nonTriggered.length ? triggerAvg - nonTriggerAvg : 0;
    const breachRatePct = rows.length ? (triggered.length / rows.length) * 100 : 0;
    const protectedTriggerCount = triggered.filter(row =>
      ['reduce', 'pause'].includes(String(row.gate_action || ''))
    ).length;
    const protectedRatio = triggered.length ? protectedTriggerCount / triggered.length : 0;
    const sampleConfidence = Math.min(0.86, 0.18 + rows.length * 0.055 + triggered.length * 0.06);

    let action: ThresholdAction = 'observe';
    let suggestedLimit = currentLimit;
    if (rows.length >= 3 && triggered.length >= 2) {
      if (delta < -0.8 || protectedRatio >= 0.6) {
        action = 'tighten';
        suggestedLimit =
          definition.direction === 'min'
            ? clamp(currentLimit + definition.step, definition.min, definition.max)
            : clamp(currentLimit - definition.step, definition.min, definition.max);
      } else if (delta > 1.2 && breachRatePct > 15) {
        action = 'relax';
        suggestedLimit =
          definition.direction === 'min'
            ? clamp(currentLimit - definition.step, definition.min, definition.max)
            : clamp(currentLimit + definition.step, definition.min, definition.max);
      } else {
        action = 'keep';
      }
    }

    const confidence =
      action === 'observe'
        ? Math.min(0.45, sampleConfidence)
        : action === 'keep'
        ? Math.min(0.58, sampleConfidence)
        : sampleConfidence;
    const reason =
      action === 'tighten'
        ? `${definition.label}触发 ${triggered.length}/${
            rows.length
          } 次，触发样本较未触发低 ${roundNumber(Math.abs(delta), 2)}pct，建议小幅收紧。`
        : action === 'relax'
        ? `${definition.label}触发后平均超额反而高 ${roundNumber(
            delta,
            2
          )}pct，当前阈值可能偏保守，可观察性放松。`
        : action === 'keep'
        ? `${definition.label}已有 ${rows.length} 个样本，但触发收益差异不明显，建议保持。`
        : `${definition.label}有效样本 ${rows.length} 个、触发 ${triggered.length} 次，暂不足以单独调参。`;

    return {
      key: definition.key,
      label: definition.label,
      action,
      reason,
      confidence: roundNumber(confidence, 4),
      sample_count: rows.length,
      triggered_count: triggered.length,
      breach_rate_pct: roundNumber(breachRatePct, 2),
      avg_excess_return_pct: roundNumber(avgExcess, 4),
      trigger_avg_excess_return_pct: triggered.length ? roundNumber(triggerAvg, 4) : undefined,
      non_trigger_avg_excess_return_pct: nonTriggered.length
        ? roundNumber(nonTriggerAvg, 4)
        : undefined,
      trigger_delta_pct:
        triggered.length && nonTriggered.length ? roundNumber(delta, 4) : undefined,
      current_limit: roundNumber(
        currentLimit,
        definition.key === 'max_position_correlation' ? 4 : 2
      ),
      suggested_limit: roundNumber(
        suggestedLimit,
        definition.key === 'max_position_correlation' ? 4 : 2
      ),
    };
  }

  private extractSnapshotRiskEvidence(snapshot: any) {
    const runMetrics = asPlainObject(snapshot?.run_metrics);
    const paper = asPlainObject(runMetrics.paper_trading);
    const riskProfile = asPlainObject(runMetrics.risk_profile || paper.risk_profile);
    const riskGate = asPlainObject(runMetrics.risk_profile_gate || paper.risk_profile_gate);
    const outcomeSummary = asPlainObject(runMetrics.trade_outcomes?.summary);
    const metrics = asPlainObject(riskProfile.risk_metrics || riskGate.metrics);
    const excessReturn = toNumber(
      snapshot?.avg_excess_return_pct,
      toNumber(
        outcomeSummary.avg_excess_return_pct,
        toNumber(outcomeSummary.excess_return_pct, toNumber(runMetrics.avg_excess_return_pct, 0))
      )
    );
    return {
      metrics,
      excess_return_pct: excessReturn,
      gate_action: String(riskGate.action || this.extractGateAction(snapshot) || 'allow'),
      has_metrics: Object.keys(metrics).length > 0,
    };
  }

  private extractGateAction(snapshot: any): string {
    const metadata = asPlainObject(snapshot?.metadata);
    const loopPolicy = asPlainObject(snapshot?.loop_policy);
    const gate = asPlainObject(metadata.risk_profile_gate || loopPolicy.risk_profile_gate);
    return String(gate.action || '');
  }

  private pickMetric(metrics: Record<string, any>, keys: readonly string[]): number {
    for (const key of keys) {
      const value = Number(metrics[key]);
      if (Number.isFinite(value)) return value;
    }
    return NaN;
  }

  private normalizeMetricValue(definition: (typeof THRESHOLD_DEFINITIONS)[number], value: number) {
    if (!Number.isFinite(value)) return value;
    if (definition.direction === 'max_abs') return Math.abs(value);
    return value;
  }
}

export const riskThresholdAttributionService = new RiskThresholdAttributionService();
