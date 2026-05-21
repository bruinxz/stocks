export type TradePolicyTone = 'success' | 'warning' | 'danger' | 'info' | 'default';

export interface TradePolicyChip {
  label: string;
  value: string | number;
  tone?: TradePolicyTone;
}

export interface TradePolicyExplain {
  available: boolean;
  headline: string;
  reason: string;
  allowed: boolean;
  chips: TradePolicyChip[];
  strategy_budget: Record<string, any>;
  environment_budget: Record<string, any>;
  risk_gate: Record<string, any>;
  entry_risk_guard: Record<string, any>;
  profit_gate: Record<string, any>;
  outcome_feedback: Record<string, any>;
  data_quality: Record<string, any>;
  outcome: Record<string, any>;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: any): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roundNumber(value: any, digits = 2): number {
  const parsed = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(parsed * base) / base;
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function firstText(...values: any[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function firstNumber(...values: any[]): number | undefined {
  for (const value of values) {
    const parsed = toOptionalNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function normalizeBudgetActionKey(value: any): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (['increase', 'boost', 'add', 'add_risk', 'recovered', 'recover_small'].includes(normalized)) {
    return 'increase';
  }
  if (['pause', 'block', 'blocked', 'extended_cooldown', 'extend_cooldown'].includes(normalized)) {
    return 'pause';
  }
  if (['reduce', 'reduced', 'decrease', 'cut'].includes(normalized)) {
    return 'reduce';
  }
  if (
    ['observe', 'watch', 'resample', 'continue_resample', 'continue_sampling'].includes(normalized)
  ) {
    return 'observe';
  }
  return normalized || 'no_budget_action';
}

function budgetActionLabel(value?: string): string {
  const labels: Record<string, string> = {
    increase: '加预算',
    reduce: '降权',
    pause: '暂停/冷却',
    observe: '小仓观察',
    no_budget_action: '未记录预算动作',
  };
  return labels[normalizeBudgetActionKey(value)] || value || '未记录预算动作';
}

function budgetPolicyActionLabel(value?: string): string {
  const labels: Record<string, string> = {
    collect_samples: '收集样本',
    scale_up: '放大执行',
    cap_increase: '限制放大',
    verify: '继续验证',
    promote_from_observe: '观察升档',
    sample_smaller: '缩小试错',
    keep_observe: '继续观察',
    keep_defensive: '防守跟随',
    tighten_reduce: '继续压仓',
    reopen_small: '小仓重开',
    keep_paused: '继续暂停',
    no_policy_execution: '未执行预算策略',
  };
  return labels[String(value || '')] || value || '未执行预算策略';
}

function riskGateLabel(action?: string): string {
  const normalized = String(action || '').toLowerCase();
  if (['pause', 'block'].includes(normalized)) return '暂停新增';
  if (['reduce', 'caution'].includes(normalized)) return '降低仓位';
  if (['observe', 'watch'].includes(normalized)) return '观察放行';
  return '允许小仓';
}

function compactText(value: any, maxLength = 120): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function hasMeaningfulValue(value: Record<string, any>): boolean {
  return Object.values(value).some(item => {
    if (item === undefined || item === null || item === '') return false;
    if (typeof item === 'object') return Object.keys(asPlainObject(item)).length > 0;
    return true;
  });
}

function hasAnyMeaningfulValue(...values: any[]): boolean {
  return values.some(value => {
    if (value === undefined || value === null || value === '') return false;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return Boolean(normalized) && !['unknown', 'no_budget_action'].includes(normalized);
    }
    if (typeof value === 'object') return hasMeaningfulValue(asPlainObject(value));
    return true;
  });
}

export function buildTradePolicyExplain(input: {
  outcome?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
  signalMetadata?: Record<string, any> | null;
  paperTrading?: Record<string, any> | null;
  strategyKey?: string;
}): TradePolicyExplain {
  const outcome = asPlainObject(input.outcome);
  const metadata = asPlainObject(input.metadata);
  const signalMetadata = asPlainObject(input.signalMetadata || metadata.signal_metadata);
  const paperTrading = asPlainObject(input.paperTrading || metadata.paper_trading);
  const strategyVariant = asPlainObject(
    metadata.strategy_variant || signalMetadata.strategy_variant || paperTrading.strategy_variant
  );
  const strategyDiscipline = asPlainObject(
    metadata.strategy_budget_discipline ||
      signalMetadata.strategy_budget_discipline ||
      paperTrading.strategy_budget_discipline ||
      strategyVariant.strategy_budget_discipline
  );
  const strategyPolicy = asPlainObject(
    metadata.strategy_allocation_policy ||
      signalMetadata.strategy_allocation_policy ||
      paperTrading.strategy_allocation_policy ||
      strategyDiscipline.policy ||
      strategyVariant.strategy_allocation_policy
  );
  const strategyDecision = asPlainObject(
    strategyPolicy.decision || strategyPolicy.weight_decision || strategyDiscipline.decision
  );
  const strategyKey =
    input.strategyKey ||
    firstText(
      metadata.strategy_key,
      signalMetadata.strategy_key,
      paperTrading.strategy_key,
      strategyVariant.strategy_key,
      strategyDiscipline.strategy_key
    );
  const strategyBudget = {
    strategy_key: strategyKey,
    strategy_name: firstText(
      strategyPolicy.strategy_name,
      strategyDiscipline.strategy_name,
      strategyVariant.strategy_name,
      strategyKey
    ),
    action: firstText(
      metadata.strategy_budget_action,
      signalMetadata.strategy_budget_action,
      paperTrading.strategy_budget_action,
      strategyDiscipline.action_label,
      strategyDiscipline.action,
      strategyDecision.action_label,
      strategyPolicy.action
    ),
    label: firstText(
      metadata.strategy_budget_label,
      signalMetadata.strategy_budget_label,
      paperTrading.strategy_budget_label,
      strategyDiscipline.label
    ),
    reason: compactText(
      firstText(
        metadata.strategy_budget_reason,
        signalMetadata.strategy_budget_reason,
        paperTrading.strategy_budget_reason,
        strategyDiscipline.reason,
        strategyDecision.reason,
        strategyPolicy.reason
      ),
      180
    ),
    allocation_pct: firstNumber(
      metadata.strategy_allocation_pct,
      signalMetadata.strategy_allocation_pct,
      paperTrading.strategy_allocation_pct,
      strategyDiscipline.allocation_pct,
      strategyPolicy.allocation_pct,
      strategyVariant.strategy_allocation_pct
    ),
    allocation_amount: firstNumber(
      metadata.strategy_allocation_amount,
      signalMetadata.strategy_allocation_amount,
      paperTrading.strategy_allocation_amount,
      strategyPolicy.capital_amount,
      strategyDiscipline.capital_amount,
      strategyVariant.strategy_allocation_amount
    ),
    max_single_trade_pct: firstNumber(
      metadata.strategy_max_single_trade_pct,
      signalMetadata.strategy_max_single_trade_pct,
      paperTrading.strategy_max_single_trade_pct,
      strategyPolicy.max_single_trade_pct,
      strategyDiscipline.max_single_trade_pct,
      strategyVariant.strategy_max_single_trade_pct
    ),
    max_single_trade_amount: firstNumber(
      metadata.strategy_max_single_trade_amount,
      signalMetadata.strategy_max_single_trade_amount,
      paperTrading.strategy_max_single_trade_amount,
      strategyPolicy.max_single_trade_amount,
      strategyDiscipline.max_single_trade_amount,
      strategyVariant.strategy_max_single_trade_amount
    ),
    confidence: firstNumber(
      metadata.strategy_budget_confidence,
      signalMetadata.strategy_budget_confidence,
      paperTrading.strategy_budget_confidence,
      strategyDiscipline.sample_confidence,
      strategyDiscipline.confidence,
      strategyDecision.sample_confidence
    ),
    raw_policy: strategyPolicy,
  };

  const environmentPolicy = asPlainObject(
    metadata.environment_policy ||
      signalMetadata.environment_policy ||
      paperTrading.environment_policy
  );
  const budgetAction = normalizeBudgetActionKey(
    firstText(
      metadata.environment_strategy_budget_action,
      signalMetadata.environment_strategy_budget_action,
      paperTrading.environment_strategy_budget_action,
      metadata.budget_action,
      signalMetadata.budget_action,
      paperTrading.budget_action
    )
  );
  const budgetPolicyAction = firstText(
    metadata.environment_strategy_budget_policy_action,
    signalMetadata.environment_strategy_budget_policy_action,
    paperTrading.environment_strategy_budget_policy_action
  );
  const environmentBudget = {
    action: budgetAction,
    action_label: budgetActionLabel(budgetAction),
    multiplier: firstNumber(
      metadata.environment_strategy_budget_multiplier,
      signalMetadata.environment_strategy_budget_multiplier,
      paperTrading.environment_strategy_budget_multiplier,
      metadata.recommended_budget_multiplier,
      signalMetadata.recommended_budget_multiplier,
      paperTrading.recommended_budget_multiplier
    ),
    reason: compactText(
      firstText(
        metadata.environment_strategy_budget_reason,
        signalMetadata.environment_strategy_budget_reason,
        paperTrading.environment_strategy_budget_reason,
        metadata.budget_action_reason,
        signalMetadata.budget_action_reason,
        paperTrading.budget_action_reason,
        environmentPolicy.reason
      ),
      180
    ),
    policy_action: budgetPolicyAction,
    policy_action_label: budgetPolicyActionLabel(budgetPolicyAction),
    policy_reason: compactText(
      firstText(
        metadata.environment_strategy_budget_policy_reason,
        signalMetadata.environment_strategy_budget_policy_reason,
        paperTrading.environment_strategy_budget_policy_reason
      ),
      180
    ),
    policy_multiplier: firstNumber(
      metadata.environment_strategy_budget_policy_multiplier,
      signalMetadata.environment_strategy_budget_policy_multiplier,
      paperTrading.environment_strategy_budget_policy_multiplier
    ),
    score_adjustment: firstNumber(
      metadata.environment_strategy_budget_policy_score_adjustment,
      signalMetadata.environment_strategy_budget_policy_score_adjustment,
      paperTrading.environment_strategy_budget_policy_score_adjustment,
      metadata.environment_strategy_adjustment,
      signalMetadata.environment_strategy_adjustment
    ),
    capital_efficiency_score: firstNumber(
      metadata.environment_strategy_capital_efficiency_score,
      signalMetadata.environment_strategy_capital_efficiency_score,
      paperTrading.environment_strategy_capital_efficiency_score
    ),
    version_id: firstText(
      metadata.environment_strategy_budget_policy_version_id,
      signalMetadata.environment_strategy_budget_policy_version_id,
      paperTrading.environment_strategy_budget_policy_version_id,
      metadata.budget_policy_version_id,
      signalMetadata.budget_policy_version_id,
      paperTrading.budget_policy_version_id
    ),
    version_hash: firstText(
      metadata.environment_strategy_budget_policy_version_hash,
      signalMetadata.environment_strategy_budget_policy_version_hash,
      paperTrading.environment_strategy_budget_policy_version_hash
    ),
    snapshot_id: firstNumber(
      metadata.budget_policy_version_snapshot_id,
      signalMetadata.budget_policy_version_snapshot_id,
      paperTrading.budget_policy_version_snapshot_id
    ),
    guard_action: firstText(
      metadata.environment_strategy_budget_policy_version_guard_action,
      signalMetadata.environment_strategy_budget_policy_version_guard_action,
      paperTrading.environment_strategy_budget_policy_version_guard_action
    ),
    guard_reason: compactText(
      firstText(
        metadata.environment_strategy_budget_policy_version_guard_reason,
        signalMetadata.environment_strategy_budget_policy_version_guard_reason,
        paperTrading.environment_strategy_budget_policy_version_guard_reason
      ),
      160
    ),
    rollback_action: firstText(
      metadata.environment_strategy_budget_policy_rollback_action,
      signalMetadata.environment_strategy_budget_policy_rollback_action,
      paperTrading.environment_strategy_budget_policy_rollback_action
    ),
    rollback_source: firstText(
      metadata.environment_strategy_budget_policy_rollback_source,
      signalMetadata.environment_strategy_budget_policy_rollback_source,
      paperTrading.environment_strategy_budget_policy_rollback_source
    ),
    rollback_reason: compactText(
      firstText(
        metadata.environment_strategy_budget_policy_rollback_reason,
        signalMetadata.environment_strategy_budget_policy_rollback_reason,
        paperTrading.environment_strategy_budget_policy_rollback_reason
      ),
      160
    ),
    market_regime_label: firstText(
      metadata.market_regime_label,
      signalMetadata.market_regime_label,
      paperTrading.market_regime_label,
      environmentPolicy.market_regime_label
    ),
  };

  const riskGateRaw = asPlainObject(
    metadata.risk_profile_gate ||
      signalMetadata.risk_profile_gate ||
      paperTrading.risk_profile_gate ||
      metadata.paper_trade_risk_profile_gate ||
      signalMetadata.paper_trade_risk_profile_gate
  );
  const riskGate = {
    ...riskGateRaw,
    action: firstText(riskGateRaw.action, riskGateRaw.gate_action),
    action_label: riskGateLabel(firstText(riskGateRaw.action, riskGateRaw.gate_action)),
    reason: compactText(riskGateRaw.reason, 180),
    effective_trade_limit: firstNumber(riskGateRaw.effective_trade_limit, riskGateRaw.trade_limit),
    effective_default_position_pct: firstNumber(
      riskGateRaw.effective_default_position_pct,
      riskGateRaw.default_position_pct
    ),
    effective_max_position_pct: firstNumber(
      riskGateRaw.effective_max_position_pct,
      riskGateRaw.max_position_pct
    ),
    position_multiplier: firstNumber(
      riskGateRaw.position_multiplier,
      riskGateRaw.effective_position_multiplier
    ),
  };

  const entryDecision = asPlainObject(
    metadata.entry_risk_guard_decision ||
      signalMetadata.entry_risk_guard_decision ||
      paperTrading.entry_risk_guard_decision
  );
  const entryGuardRaw = asPlainObject(
    metadata.entry_risk_guard || signalMetadata.entry_risk_guard || paperTrading.entry_risk_guard
  );
  const entryRiskGuard = {
    allowed:
      entryDecision.allowed !== undefined
        ? entryDecision.allowed !== false
        : entryDecision.action
        ? !['block', 'pause', 'reject'].includes(String(entryDecision.action).toLowerCase())
        : true,
    label: firstText(entryDecision.label, entryDecision.conclusion, entryDecision.action_label),
    reason: compactText(
      firstText(entryDecision.reason, entryDecision.message, entryGuardRaw.reason),
      180
    ),
    risk_notes: Array.isArray(entryDecision.risk_notes)
      ? entryDecision.risk_notes.slice(0, 4)
      : Array.isArray(entryGuardRaw.risk_notes)
      ? entryGuardRaw.risk_notes.slice(0, 4)
      : [],
    current_exposure_pct: firstNumber(
      entryDecision.current_exposure_pct,
      entryGuardRaw.current_exposure_pct
    ),
    today_buy_count: firstNumber(entryDecision.today_buy_count, entryGuardRaw.today_buy_count),
    max_daily_new_positions: firstNumber(
      entryDecision.max_daily_new_positions,
      entryGuardRaw.max_daily_new_positions
    ),
  };

  const profitGateRaw = asPlainObject(
    metadata.profit_gate || signalMetadata.profit_gate || paperTrading.profit_gate
  );
  const profitGate = {
    enabled: profitGateRaw.enabled === true,
    label: firstText(profitGateRaw.gate_label, profitGateRaw.label),
    action: firstText(profitGateRaw.gate_action, profitGateRaw.action),
    allow_entries: profitGateRaw.allow_entries !== false,
    quality_score: firstNumber(profitGateRaw.quality_score),
    min_quality_score: firstNumber(profitGateRaw.min_quality_score),
    completed_samples: firstNumber(profitGateRaw.completed_samples),
    min_samples: firstNumber(profitGateRaw.min_samples),
    effective_position_multiplier: firstNumber(
      profitGateRaw.effective_position_multiplier,
      profitGateRaw.position_multiplier
    ),
    reason: compactText(profitGateRaw.reason, 180),
  };
  const outcomeFeedbackRaw = asPlainObject(
    metadata.outcome_feedback || signalMetadata.outcome_feedback || paperTrading.outcome_feedback
  );
  const outcomeFeedback = {
    enabled: outcomeFeedbackRaw.enabled === true,
    allow_entries: outcomeFeedbackRaw.allow_entries !== false,
    closed_samples: firstNumber(outcomeFeedbackRaw.closed_samples),
    min_closed_samples: firstNumber(outcomeFeedbackRaw.min_closed_samples),
    effective_min_score: firstNumber(
      outcomeFeedbackRaw.effective_min_score,
      outcomeFeedbackRaw.recommended_min_score
    ),
    effective_position_multiplier: firstNumber(
      outcomeFeedbackRaw.effective_position_multiplier,
      outcomeFeedbackRaw.position_multiplier
    ),
    reason: compactText(outcomeFeedbackRaw.reason, 180),
    insights: Array.isArray(outcomeFeedbackRaw.insights)
      ? outcomeFeedbackRaw.insights.slice(0, 3)
      : [],
  };
  const dataQuality = {
    score: firstNumber(
      metadata.data_quality_score,
      signalMetadata.data_quality_score,
      paperTrading.data_quality_score
    ),
    bucket: firstText(
      metadata.data_quality_bucket,
      signalMetadata.data_quality_bucket,
      paperTrading.data_quality_bucket
    ),
    position_multiplier: firstNumber(
      metadata.data_quality_position_multiplier,
      signalMetadata.data_quality_position_multiplier,
      paperTrading.data_quality_position_multiplier
    ),
    reason: compactText(
      firstText(metadata.data_quality_reason, signalMetadata.data_quality_reason),
      160
    ),
  };
  const outcomeSummary = {
    trade_status: firstText(outcome.trade_status),
    entry_price: firstNumber(outcome.entry_price),
    latest_price: firstNumber(outcome.latest_price, outcome.exit_price),
    total_pnl: firstNumber(outcome.total_pnl),
    total_pnl_pct: firstNumber(outcome.total_pnl_pct),
    excess_return_pct: firstNumber(outcome.excess_return_pct),
    holding_days: firstNumber(outcome.holding_days),
  };

  const riskGateActionKey = String(riskGate.action || '').toLowerCase();
  const blocked =
    riskGateActionKey === 'pause' ||
    riskGateActionKey === 'block' ||
    budgetAction === 'pause' ||
    entryRiskGuard.allowed === false ||
    profitGate.allow_entries === false ||
    outcomeFeedback.allow_entries === false;
  const allowed = !blocked;
  const available =
    hasAnyMeaningfulValue(
      strategyBudget.action,
      strategyBudget.label,
      strategyBudget.reason,
      strategyBudget.allocation_pct,
      strategyBudget.allocation_amount,
      strategyBudget.max_single_trade_pct,
      strategyBudget.max_single_trade_amount,
      strategyBudget.confidence,
      strategyBudget.raw_policy
    ) ||
    hasAnyMeaningfulValue(
      budgetAction !== 'no_budget_action' ? budgetAction : '',
      environmentBudget.multiplier,
      environmentBudget.reason,
      environmentBudget.policy_action,
      environmentBudget.policy_reason,
      environmentBudget.policy_multiplier,
      environmentBudget.score_adjustment,
      environmentBudget.capital_efficiency_score,
      environmentBudget.version_id,
      environmentBudget.guard_action,
      environmentBudget.rollback_action,
      environmentBudget.market_regime_label
    ) ||
    hasMeaningfulValue(riskGateRaw) ||
    hasMeaningfulValue(entryDecision) ||
    hasMeaningfulValue(entryGuardRaw) ||
    hasMeaningfulValue(profitGateRaw) ||
    hasMeaningfulValue(outcomeFeedbackRaw) ||
    hasAnyMeaningfulValue(
      dataQuality.score,
      dataQuality.bucket,
      dataQuality.position_multiplier,
      dataQuality.reason
    );

  const headline = !available
    ? '暂无预算/风控记录'
    : !allowed
    ? '风控或预算未完全放行'
    : budgetAction === 'increase'
    ? '预算加码后放行'
    : budgetAction === 'reduce'
    ? '降权小仓放行'
    : budgetAction === 'observe'
    ? '观察仓放行'
    : '策略预算与风控放行';

  const reason = compactText(
    [
      strategyBudget.reason,
      environmentBudget.reason,
      riskGate.reason,
      entryRiskGuard.reason,
      profitGate.reason,
      outcomeFeedback.reason,
    ]
      .filter(Boolean)
      .join('；') || '当前记录未沉淀完整预算/风控说明，可查看原始链路与交易流水。',
    260
  );

  const chips: TradePolicyChip[] = [
    strategyBudget.max_single_trade_pct !== undefined
      ? {
          label: '单票上限',
          value: `${roundNumber(strategyBudget.max_single_trade_pct, 1)}%`,
          tone: 'info',
        }
      : null,
    strategyBudget.allocation_pct !== undefined
      ? {
          label: '策略预算',
          value: `${roundNumber(strategyBudget.allocation_pct, 1)}%`,
          tone: 'info',
        }
      : null,
    environmentBudget.action && environmentBudget.action !== 'no_budget_action'
      ? {
          label: '预算动作',
          value: environmentBudget.action_label,
          tone:
            environmentBudget.action === 'increase'
              ? 'success'
              : environmentBudget.action === 'pause'
              ? 'danger'
              : environmentBudget.action === 'reduce'
              ? 'warning'
              : 'info',
        }
      : null,
    environmentBudget.multiplier !== undefined
      ? {
          label: '环境倍率',
          value: `${roundNumber(environmentBudget.multiplier, 2)}x`,
          tone: 'warning',
        }
      : null,
    riskGate.action
      ? { label: '组合闸门', value: riskGate.action_label, tone: allowed ? 'success' : 'danger' }
      : null,
    entryRiskGuard.label
      ? {
          label: '入场风控',
          value: entryRiskGuard.label,
          tone: entryRiskGuard.allowed ? 'success' : 'danger',
        }
      : null,
    profitGate.enabled && profitGate.effective_position_multiplier !== undefined
      ? {
          label: '收益闸门',
          value: `${roundNumber(profitGate.effective_position_multiplier, 2)}x`,
          tone: 'warning',
        }
      : null,
    outcomeFeedback.enabled && outcomeFeedback.effective_position_multiplier !== undefined
      ? {
          label: '闭环倍率',
          value: `${roundNumber(outcomeFeedback.effective_position_multiplier, 2)}x`,
          tone: 'info',
        }
      : null,
  ].filter(Boolean) as TradePolicyChip[];

  return {
    available,
    headline,
    reason,
    allowed,
    chips,
    strategy_budget: strategyBudget,
    environment_budget: environmentBudget,
    risk_gate: riskGate,
    entry_risk_guard: entryRiskGuard,
    profit_gate: profitGate,
    outcome_feedback: outcomeFeedback,
    data_quality: dataQuality,
    outcome: outcomeSummary,
  };
}
