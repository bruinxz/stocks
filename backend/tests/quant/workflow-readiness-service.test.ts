/**
 * workflow-readiness-service.test.ts
 *
 * Phase 1-3 iteration guard:
 * - Phase 1: simple strategy presets + data readiness gate.
 * - Phase 2: research credibility gate with hypothesis and backtest quality.
 * - Phase 3: paper-trading acceptance gate for canary/promotion decisions.
 */

import {
  QUANT_WORKFLOW_THRESHOLDS,
  evaluateQuantWorkflowReadiness,
  getQuantWorkflowPresetKeys,
  getQuantWorkflowPresets,
} from '../../src/quant/workflow/QuantWorkflowReadinessService';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('\n## quant workflow presets');

const presets = getQuantWorkflowPresets();
assert('has at least three beginner-friendly presets', presets.length >= 3);
assert(
  'default preset is conservative and paper-trading friendly',
  presets.some(
    item =>
      item.preset_key === 'steady_momentum_basic' &&
      item.mode === 'simple' &&
      item.paper_trading_defaults.default_position_pct <= 5
  )
);
assert(
  'every preset declares data requirements',
  presets.every(item => item.data_requirements.min_history_days >= 120)
);
assert(
  'preset keys are exposed for route validation',
  getQuantWorkflowPresetKeys().includes('steady_momentum_basic')
);
assert(
  'workflow thresholds are centralized',
  QUANT_WORKFLOW_THRESHOLDS.stage_2.backtest_trade_count_ready_min === 30 &&
    QUANT_WORKFLOW_THRESHOLDS.stage_3.average_slippage_ready_max_bps === 20
);

console.log('\n## stage 1-3 readiness evaluation');

const ready = evaluateQuantWorkflowReadiness({
  strategy: {
    preset_key: 'steady_momentum_basic',
    strategy_key: 'relative_strength_momentum',
    edge_hypothesis: {
      thesis: 'Strong but not overheated leaders persist for several weeks.',
      target_universe: 'A-share liquid large and mid cap stocks.',
      expected_holding_days: 15,
      invalidation_rule: 'Exit when relative strength decays below market median.',
      risk_notes: 'Avoid ST, suspended names, and crowded one-day spikes.',
    },
  },
  data: {
    daily_bar_coverage_pct: 98,
    factor_coverage_pct: 94,
    latest_trade_date: '2026-06-22',
    stale_symbol_count: 0,
    point_in_time_ready: true,
    corporate_action_adjusted: true,
    benchmark_ready: true,
  },
  backtest: {
    trading_days: 252,
    trade_count: 42,
    sharpe_ratio: 1.25,
    max_drawdown_pct: 11,
    benchmark_excess_return_pct: 8,
    validation_split: true,
    walk_forward_verdict: 'pass',
    overfit_score: 0.22,
  },
  paper: {
    trading_days: 35,
    completed_trades: 36,
    win_rate: 0.58,
    profit_loss_ratio: 1.45,
    max_drawdown_pct: 5,
    average_slippage_bps: 12,
    backtest_to_paper_correlation: 0.51,
    risk_guard_breaches: 0,
    manual_override_count: 1,
  },
});

assert('overall target stage is 3', ready.verdict.target_stage === 3);
assert('stage 1 ready', ready.stages[0].stage === 1 && ready.stages[0].status === 'ready');
assert('stage 2 ready', ready.stages[1].stage === 2 && ready.stages[1].status === 'ready');
assert('stage 3 ready', ready.stages[2].stage === 3 && ready.stages[2].status === 'ready');
assert('paper canary gate is open', ready.verdict.can_promote_paper_to_canary === true);

const blocked = evaluateQuantWorkflowReadiness({
  strategy: {
    preset_key: 'steady_momentum_basic',
    strategy_key: 'relative_strength_momentum',
    edge_hypothesis: {
      thesis: '',
      target_universe: '',
      expected_holding_days: 0,
      invalidation_rule: '',
      risk_notes: '',
    },
  },
  data: {
    daily_bar_coverage_pct: 72,
    factor_coverage_pct: 54,
    latest_trade_date: '',
    stale_symbol_count: 18,
    point_in_time_ready: false,
    corporate_action_adjusted: false,
    benchmark_ready: false,
  },
  backtest: {
    trading_days: 40,
    trade_count: 4,
    sharpe_ratio: 0.1,
    max_drawdown_pct: 48,
    benchmark_excess_return_pct: -6,
    validation_split: false,
    walk_forward_verdict: 'fail',
    overfit_score: 0.82,
  },
  paper: {
    trading_days: 6,
    completed_trades: 3,
    win_rate: 0.2,
    profit_loss_ratio: 0.6,
    max_drawdown_pct: 19,
    average_slippage_bps: 80,
    backtest_to_paper_correlation: 0.05,
    risk_guard_breaches: 2,
    manual_override_count: 6,
  },
});

assert('blocked data prevents starting backtest', blocked.verdict.can_start_backtest === false);
assert('blocked research prevents paper trading', blocked.verdict.can_start_paper_trading === false);
assert('blocked paper gate prevents canary promotion', blocked.verdict.can_promote_paper_to_canary === false);
assert(
  'blocked output carries concrete next actions',
  blocked.stages.every(stage => stage.next_actions.length > 0)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
