/**
 * Stateless self-assessment scorer for the beginner quant workflow.
 *
 * This module does not read databases, start backtests, place paper/live orders,
 * or unlock canary trading. It only scores the payload supplied by the caller
 * and returns advisory readiness labels for the UI/operator.
 */
export type QuantWorkflowStatus = 'ready' | 'degraded' | 'blocked';

export interface QuantStrategyPreset {
  preset_key: string;
  strategy_key: string;
  display_name: string;
  mode: 'simple';
  risk_level: 'low' | 'medium' | 'high';
  description: string;
  suitable_for: string[];
  data_requirements: {
    min_history_days: number;
    min_daily_bar_coverage_pct: number;
    min_factor_coverage_pct: number;
    required_features: string[];
  };
  backtest_defaults: {
    lookback_days: number;
    initial_capital: number;
    benchmark_symbol: string;
    validation_split: boolean;
    commission_rate: number;
    slippage_bps: number;
  };
  paper_trading_defaults: {
    default_position_pct: number;
    max_single_position_pct: number;
    max_positions: number;
    min_paper_trading_days: number;
    min_completed_trades: number;
  };
  required_hypothesis_fields: string[];
}

export interface QuantWorkflowInput {
  strategy?: {
    preset_key?: string;
    strategy_key?: string;
    edge_hypothesis?: {
      thesis?: string;
      target_universe?: string;
      expected_holding_days?: number;
      invalidation_rule?: string;
      risk_notes?: string;
    };
  };
  data?: {
    daily_bar_coverage_pct?: number;
    factor_coverage_pct?: number;
    latest_trade_date?: string;
    stale_symbol_count?: number;
    point_in_time_ready?: boolean;
    corporate_action_adjusted?: boolean;
    benchmark_ready?: boolean;
  };
  backtest?: {
    trading_days?: number;
    trade_count?: number;
    sharpe_ratio?: number;
    max_drawdown_pct?: number;
    benchmark_excess_return_pct?: number;
    validation_split?: boolean;
    walk_forward_verdict?: string;
    overfit_score?: number;
  };
  paper?: {
    trading_days?: number;
    completed_trades?: number;
    win_rate?: number;
    profit_loss_ratio?: number;
    max_drawdown_pct?: number;
    average_slippage_bps?: number;
    backtest_to_paper_correlation?: number;
    risk_guard_breaches?: number;
    manual_override_count?: number;
  };
}

export interface QuantWorkflowCheck {
  key: string;
  label: string;
  status: QuantWorkflowStatus;
  expected: string;
  actual: string | number | boolean | null;
  mandatory: boolean;
  weight: number;
  message: string;
}

export interface QuantWorkflowStage {
  stage: 1 | 2 | 3;
  stage_key: 'simple_usable_loop' | 'research_credibility' | 'paper_trading_acceptance';
  title: string;
  status: QuantWorkflowStatus;
  score: number;
  checks: QuantWorkflowCheck[];
  next_actions: string[];
}

export interface QuantWorkflowReadiness {
  version: 'phase_1_to_3_v1';
  generated_at: string;
  mode: 'simple';
  presets: QuantStrategyPreset[];
  selected_preset: QuantStrategyPreset;
  stages: QuantWorkflowStage[];
  verdict: {
    target_stage: 3;
    current_stage: 0 | 1 | 2 | 3;
    status: QuantWorkflowStatus;
    status_label: string;
    can_start_backtest: boolean;
    can_start_paper_trading: boolean;
    can_promote_paper_to_canary: boolean;
    conclusion: string;
  };
}

const DEFAULT_PRESET_KEY = 'steady_momentum_basic';

export const QUANT_WORKFLOW_THRESHOLDS = Object.freeze({
  stage_score: {
    ready_min: 85,
    degraded_min: 60,
  },
  stage_1: {
    daily_bar_coverage_degraded_min: 85,
    factor_coverage_degraded_min: 75,
    stale_symbol_ready_max: 0,
    stale_symbol_degraded_max: 5,
  },
  stage_2: {
    hypothesis_thesis_min_length: 20,
    hypothesis_universe_min_length: 10,
    expected_holding_days_ready_min: 1,
    invalidation_rule_min_length: 15,
    risk_notes_min_length: 10,
    backtest_trading_days_ready_min: 180,
    backtest_trading_days_degraded_min: 120,
    backtest_trade_count_ready_min: 30,
    backtest_trade_count_degraded_min: 12,
    benchmark_excess_return_ready_min: 0,
    benchmark_excess_return_degraded_min: -2,
    max_drawdown_ready_max: 20,
    max_drawdown_degraded_max: 35,
    overfit_score_ready_max: 0.3,
    overfit_score_degraded_max: 0.5,
  },
  stage_3: {
    minimum_degraded_paper_trading_days: 15,
    minimum_degraded_completed_trades: 12,
    paper_win_rate_ready_min: 0.52,
    paper_win_rate_degraded_min: 0.45,
    paper_profit_loss_ratio_ready_min: 1.2,
    paper_profit_loss_ratio_degraded_min: 1,
    paper_max_drawdown_ready_max: 12,
    paper_max_drawdown_degraded_max: 20,
    average_slippage_ready_max_bps: 20,
    average_slippage_degraded_max_bps: 40,
    backtest_paper_correlation_ready_min: 0.45,
    backtest_paper_correlation_degraded_min: 0.3,
    risk_guard_breaches_ready_max: 0,
    risk_guard_breaches_degraded_max: 0,
    manual_override_ready_max: 2,
    manual_override_degraded_max: 5,
  },
});

const PRESETS: QuantStrategyPreset[] = [
  {
    preset_key: DEFAULT_PRESET_KEY,
    strategy_key: 'relative_strength_momentum',
    display_name: '稳健动量入门',
    mode: 'simple',
    risk_level: 'medium',
    description: '用中期相对强度筛选流动性充足、趋势延续的股票，默认只建议小仓纸面验证。',
    suitable_for: ['第一次配置量化策略', '想先跑通回测-纸面闭环', '偏趋势跟随'],
    data_requirements: {
      min_history_days: 252,
      min_daily_bar_coverage_pct: 95,
      min_factor_coverage_pct: 90,
      required_features: ['daily_bar', 'turnover', 'benchmark', 'industry'],
    },
    backtest_defaults: {
      lookback_days: 504,
      initial_capital: 100000,
      benchmark_symbol: 'sh.000300',
      validation_split: true,
      commission_rate: 0.0003,
      slippage_bps: 10,
    },
    paper_trading_defaults: {
      default_position_pct: 3,
      max_single_position_pct: 5,
      max_positions: 5,
      min_paper_trading_days: 30,
      min_completed_trades: 30,
    },
    required_hypothesis_fields: [
      'thesis',
      'target_universe',
      'expected_holding_days',
      'invalidation_rule',
      'risk_notes',
    ],
  },
  {
    preset_key: 'dividend_defensive_basic',
    strategy_key: 'high_dividend_value',
    display_name: '低波红利防守',
    mode: 'simple',
    risk_level: 'low',
    description: '偏防守的红利/质量组合，强调回撤控制和较低换手。',
    suitable_for: ['偏长期持有', '希望降低回撤', '先从低波动策略开始'],
    data_requirements: {
      min_history_days: 504,
      min_daily_bar_coverage_pct: 96,
      min_factor_coverage_pct: 92,
      required_features: ['daily_bar', 'dividend_history', 'financial_report', 'benchmark'],
    },
    backtest_defaults: {
      lookback_days: 756,
      initial_capital: 100000,
      benchmark_symbol: 'sh.000300',
      validation_split: true,
      commission_rate: 0.0003,
      slippage_bps: 8,
    },
    paper_trading_defaults: {
      default_position_pct: 4,
      max_single_position_pct: 6,
      max_positions: 6,
      min_paper_trading_days: 45,
      min_completed_trades: 20,
    },
    required_hypothesis_fields: [
      'thesis',
      'target_universe',
      'expected_holding_days',
      'invalidation_rule',
      'risk_notes',
    ],
  },
  {
    preset_key: 'reversal_observer_basic',
    strategy_key: 'left_side_reversal',
    display_name: '左侧反转观察',
    mode: 'simple',
    risk_level: 'high',
    description: '只用于观察仓和纸面验证的反转策略，默认更严格限制仓位和晋级条件。',
    suitable_for: ['研究反转机会', '只做纸面观察', '愿意接受更高噪音'],
    data_requirements: {
      min_history_days: 252,
      min_daily_bar_coverage_pct: 97,
      min_factor_coverage_pct: 92,
      required_features: ['daily_bar', 'limit_up_down', 'turnover', 'market_breadth'],
    },
    backtest_defaults: {
      lookback_days: 504,
      initial_capital: 100000,
      benchmark_symbol: 'sh.000300',
      validation_split: true,
      commission_rate: 0.0003,
      slippage_bps: 15,
    },
    paper_trading_defaults: {
      default_position_pct: 2,
      max_single_position_pct: 3,
      max_positions: 4,
      min_paper_trading_days: 45,
      min_completed_trades: 40,
    },
    required_hypothesis_fields: [
      'thesis',
      'target_universe',
      'expected_holding_days',
      'invalidation_rule',
      'risk_notes',
    ],
  },
];

export function getQuantWorkflowPresets(): QuantStrategyPreset[] {
  return PRESETS.map(preset => ({
    ...preset,
    suitable_for: [...preset.suitable_for],
    data_requirements: {
      ...preset.data_requirements,
      required_features: [...preset.data_requirements.required_features],
    },
    backtest_defaults: { ...preset.backtest_defaults },
    paper_trading_defaults: { ...preset.paper_trading_defaults },
    required_hypothesis_fields: [...preset.required_hypothesis_fields],
  }));
}

export function getQuantWorkflowPresetKeys(): string[] {
  return PRESETS.map(preset => preset.preset_key);
}

export function evaluateQuantWorkflowReadiness(
  input: QuantWorkflowInput = {}
): QuantWorkflowReadiness {
  const presets = getQuantWorkflowPresets();
  const selected_preset =
    presets.find(preset => preset.preset_key === input.strategy?.preset_key) ||
    presets.find(preset => preset.preset_key === DEFAULT_PRESET_KEY) ||
    presets[0];

  const stage1 = buildSimpleUsableLoopStage(input, selected_preset);
  const stage2 = buildResearchCredibilityStage(input, stage1);
  const stage3 = buildPaperTradingAcceptanceStage(input, stage2, selected_preset);
  const stages = [stage1, stage2, stage3];

  const current_stage = stages.reduce<0 | 1 | 2 | 3>((acc, stage) => {
    if (stage.status === 'blocked') return acc;
    return stage.stage;
  }, 0);
  const status = stage3.status;

  return {
    version: 'phase_1_to_3_v1',
    generated_at: new Date().toISOString(),
    mode: 'simple',
    presets,
    selected_preset,
    stages,
    verdict: {
      target_stage: 3,
      current_stage,
      status,
      status_label:
        status === 'ready'
          ? '阶段 3 可进入纸面晋级观察'
          : status === 'degraded'
          ? '阶段 3 需人工复核'
          : '阶段 3 未达标',
      can_start_backtest: stage1.status !== 'blocked',
      can_start_paper_trading: stage1.status !== 'blocked' && stage2.status !== 'blocked',
      can_promote_paper_to_canary: stage3.status === 'ready',
      conclusion: buildConclusion(stage1, stage2, stage3),
    },
  };
}

function buildSimpleUsableLoopStage(
  input: QuantWorkflowInput,
  preset: QuantStrategyPreset
): QuantWorkflowStage {
  const data = input.data || {};
  const strategy = input.strategy || {};
  return buildStage({
    stage: 1,
    stage_key: 'simple_usable_loop',
    title: '阶段 1：简单可用闭环',
    checks: [
      checkBoolean({
        key: 'preset_selected',
        label: '已选择简单策略预设',
        actual: Boolean(strategy.preset_key || preset.preset_key),
        expected: '选择一个 simple mode 预设',
        mandatory: true,
        weight: 12,
        message_ready: `使用预设：${preset.display_name}`,
        message_blocked: '尚未选择策略预设。',
      }),
      checkThreshold({
        key: 'daily_bar_coverage',
        label: 'K 线覆盖率',
        value: data.daily_bar_coverage_pct,
        ready_min: preset.data_requirements.min_daily_bar_coverage_pct,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_1.daily_bar_coverage_degraded_min,
        expected: `>= ${preset.data_requirements.min_daily_bar_coverage_pct}%`,
        mandatory: true,
        weight: 18,
        unit: '%',
      }),
      checkThreshold({
        key: 'factor_coverage',
        label: '因子覆盖率',
        value: data.factor_coverage_pct,
        ready_min: preset.data_requirements.min_factor_coverage_pct,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_1.factor_coverage_degraded_min,
        expected: `>= ${preset.data_requirements.min_factor_coverage_pct}%`,
        mandatory: false,
        weight: 12,
        unit: '%',
      }),
      checkBoolean({
        key: 'latest_trade_date',
        label: '最新交易日已同步',
        actual: Boolean(data.latest_trade_date),
        expected: 'latest_trade_date 非空',
        mandatory: true,
        weight: 14,
        message_ready: `最新交易日：${data.latest_trade_date}`,
        message_blocked: '缺少最新交易日，不能判断数据是否新鲜。',
      }),
      checkMax({
        key: 'stale_symbols',
        label: '过期股票数量',
        value: data.stale_symbol_count,
        ready_max: QUANT_WORKFLOW_THRESHOLDS.stage_1.stale_symbol_ready_max,
        degraded_max: QUANT_WORKFLOW_THRESHOLDS.stage_1.stale_symbol_degraded_max,
        expected: '0',
        mandatory: false,
        weight: 10,
        unit: '只',
      }),
      checkBoolean({
        key: 'benchmark_ready',
        label: '基准指数已准备',
        actual: data.benchmark_ready === true,
        expected: 'benchmark_ready=true',
        mandatory: true,
        weight: 16,
        message_ready: '基准可用于超额收益比较。',
        message_blocked: '缺少基准数据，回测结果无法比较。',
      }),
      checkBoolean({
        key: 'corporate_action_adjusted',
        label: '复权/公司行动处理',
        actual: data.corporate_action_adjusted === true,
        expected: 'corporate_action_adjusted=true',
        mandatory: false,
        weight: 10,
        message_ready: '价格序列已处理复权。',
        message_blocked: '复权状态未知，收益可能失真。',
      }),
    ],
  });
}

function buildResearchCredibilityStage(
  input: QuantWorkflowInput,
  previous: QuantWorkflowStage
): QuantWorkflowStage {
  const hypothesis = input.strategy?.edge_hypothesis || {};
  const backtest = input.backtest || {};
  const data = input.data || {};
  return buildStage({
    stage: 2,
    stage_key: 'research_credibility',
    title: '阶段 2：研究可信度',
    checks: [
      carryPreviousStageCheck(previous, 'stage_1_ready', '阶段 1 未阻断', 10),
      checkText({
        key: 'hypothesis_thesis',
        label: '可证伪 alpha 假设',
        value: hypothesis.thesis,
        min_length: QUANT_WORKFLOW_THRESHOLDS.stage_2.hypothesis_thesis_min_length,
        weight: 10,
      }),
      checkText({
        key: 'hypothesis_universe',
        label: '目标股票池明确',
        value: hypothesis.target_universe,
        min_length: QUANT_WORKFLOW_THRESHOLDS.stage_2.hypothesis_universe_min_length,
        weight: 8,
      }),
      checkThreshold({
        key: 'expected_holding_days',
        label: '预期持有周期',
        value: hypothesis.expected_holding_days,
        ready_min: QUANT_WORKFLOW_THRESHOLDS.stage_2.expected_holding_days_ready_min,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_2.expected_holding_days_ready_min,
        expected: '>= 1 天',
        mandatory: true,
        weight: 6,
        unit: '天',
      }),
      checkText({
        key: 'invalidation_rule',
        label: '失效规则',
        value: hypothesis.invalidation_rule,
        min_length: QUANT_WORKFLOW_THRESHOLDS.stage_2.invalidation_rule_min_length,
        weight: 8,
      }),
      checkText({
        key: 'risk_notes',
        label: '风险边界',
        value: hypothesis.risk_notes,
        min_length: QUANT_WORKFLOW_THRESHOLDS.stage_2.risk_notes_min_length,
        weight: 6,
      }),
      checkThreshold({
        key: 'backtest_trading_days',
        label: '回测交易日样本',
        value: backtest.trading_days,
        ready_min: QUANT_WORKFLOW_THRESHOLDS.stage_2.backtest_trading_days_ready_min,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_2.backtest_trading_days_degraded_min,
        expected: '>= 180 个交易日',
        mandatory: true,
        weight: 10,
        unit: '天',
      }),
      checkThreshold({
        key: 'backtest_trade_count',
        label: '回测成交样本',
        value: backtest.trade_count,
        ready_min: QUANT_WORKFLOW_THRESHOLDS.stage_2.backtest_trade_count_ready_min,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_2.backtest_trade_count_degraded_min,
        expected: '>= 30 笔',
        mandatory: true,
        weight: 8,
        unit: '笔',
      }),
      checkThreshold({
        key: 'benchmark_excess_return',
        label: '相对基准超额收益',
        value: backtest.benchmark_excess_return_pct,
        ready_min: QUANT_WORKFLOW_THRESHOLDS.stage_2.benchmark_excess_return_ready_min,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_2.benchmark_excess_return_degraded_min,
        expected: '> 0%',
        mandatory: false,
        weight: 8,
        unit: '%',
      }),
      checkMax({
        key: 'max_drawdown',
        label: '最大回撤',
        value: backtest.max_drawdown_pct,
        ready_max: QUANT_WORKFLOW_THRESHOLDS.stage_2.max_drawdown_ready_max,
        degraded_max: QUANT_WORKFLOW_THRESHOLDS.stage_2.max_drawdown_degraded_max,
        expected: '<= 20%',
        mandatory: true,
        weight: 8,
        unit: '%',
      }),
      checkBoolean({
        key: 'validation_split',
        label: '样本外验证切分',
        actual: backtest.validation_split === true,
        expected: 'validation_split=true',
        mandatory: true,
        weight: 8,
        message_ready: '已开启训练/验证切分。',
        message_blocked: '缺少样本外验证，容易过拟合。',
      }),
      checkWalkForward(backtest.walk_forward_verdict),
      checkMax({
        key: 'overfit_score',
        label: '过拟合风险分',
        value: backtest.overfit_score,
        ready_max: QUANT_WORKFLOW_THRESHOLDS.stage_2.overfit_score_ready_max,
        degraded_max: QUANT_WORKFLOW_THRESHOLDS.stage_2.overfit_score_degraded_max,
        expected: '<= 0.30',
        mandatory: true,
        weight: 6,
      }),
      checkBoolean({
        key: 'point_in_time_ready',
        label: '点时数据约束',
        actual: data.point_in_time_ready === true,
        expected: 'point_in_time_ready=true',
        mandatory: true,
        weight: 4,
        message_ready: '数据使用点时口径。',
        message_blocked: '点时约束未知，存在未来函数风险。',
      }),
    ],
  });
}

function buildPaperTradingAcceptanceStage(
  input: QuantWorkflowInput,
  previous: QuantWorkflowStage,
  preset: QuantStrategyPreset
): QuantWorkflowStage {
  const paper = input.paper || {};
  return buildStage({
    stage: 3,
    stage_key: 'paper_trading_acceptance',
    title: '阶段 3：纸面交易验收',
    checks: [
      carryPreviousStageCheck(previous, 'stage_2_ready', '阶段 2 未阻断', 12),
      checkThreshold({
        key: 'paper_trading_days',
        label: '纸面交易观察天数',
        value: paper.trading_days,
        ready_min: preset.paper_trading_defaults.min_paper_trading_days,
        degraded_min: Math.max(
          QUANT_WORKFLOW_THRESHOLDS.stage_3.minimum_degraded_paper_trading_days,
          Math.floor(preset.paper_trading_defaults.min_paper_trading_days / 2)
        ),
        expected: `>= ${preset.paper_trading_defaults.min_paper_trading_days} 天`,
        mandatory: true,
        weight: 12,
        unit: '天',
      }),
      checkThreshold({
        key: 'paper_completed_trades',
        label: '纸面已完成交易',
        value: paper.completed_trades,
        ready_min: preset.paper_trading_defaults.min_completed_trades,
        degraded_min: Math.max(
          QUANT_WORKFLOW_THRESHOLDS.stage_3.minimum_degraded_completed_trades,
          Math.floor(preset.paper_trading_defaults.min_completed_trades / 2)
        ),
        expected: `>= ${preset.paper_trading_defaults.min_completed_trades} 笔`,
        mandatory: true,
        weight: 12,
        unit: '笔',
      }),
      checkThreshold({
        key: 'paper_win_rate',
        label: '纸面胜率',
        value: paper.win_rate,
        ready_min: QUANT_WORKFLOW_THRESHOLDS.stage_3.paper_win_rate_ready_min,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_3.paper_win_rate_degraded_min,
        expected: '>= 52%',
        mandatory: false,
        weight: 8,
      }),
      checkThreshold({
        key: 'paper_profit_loss_ratio',
        label: '纸面盈亏比',
        value: paper.profit_loss_ratio,
        ready_min: QUANT_WORKFLOW_THRESHOLDS.stage_3.paper_profit_loss_ratio_ready_min,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_3.paper_profit_loss_ratio_degraded_min,
        expected: '>= 1.2',
        mandatory: true,
        weight: 10,
      }),
      checkMax({
        key: 'paper_max_drawdown',
        label: '纸面最大回撤',
        value: paper.max_drawdown_pct,
        ready_max: QUANT_WORKFLOW_THRESHOLDS.stage_3.paper_max_drawdown_ready_max,
        degraded_max: QUANT_WORKFLOW_THRESHOLDS.stage_3.paper_max_drawdown_degraded_max,
        expected: '<= 12%',
        mandatory: true,
        weight: 12,
        unit: '%',
      }),
      checkMax({
        key: 'paper_slippage',
        label: '平均滑点',
        value: paper.average_slippage_bps,
        ready_max: QUANT_WORKFLOW_THRESHOLDS.stage_3.average_slippage_ready_max_bps,
        degraded_max: QUANT_WORKFLOW_THRESHOLDS.stage_3.average_slippage_degraded_max_bps,
        expected: '<= 20 bps',
        mandatory: false,
        weight: 8,
        unit: 'bps',
      }),
      checkThreshold({
        key: 'backtest_paper_consistency',
        label: '回测/纸面一致性',
        value: paper.backtest_to_paper_correlation,
        ready_min: QUANT_WORKFLOW_THRESHOLDS.stage_3.backtest_paper_correlation_ready_min,
        degraded_min: QUANT_WORKFLOW_THRESHOLDS.stage_3.backtest_paper_correlation_degraded_min,
        expected: '相关性 >= 0.45',
        mandatory: true,
        weight: 12,
      }),
      checkMax({
        key: 'risk_guard_breaches',
        label: '风控硬违规',
        value: paper.risk_guard_breaches,
        ready_max: QUANT_WORKFLOW_THRESHOLDS.stage_3.risk_guard_breaches_ready_max,
        degraded_max: QUANT_WORKFLOW_THRESHOLDS.stage_3.risk_guard_breaches_degraded_max,
        expected: '0 次',
        mandatory: true,
        weight: 8,
        unit: '次',
      }),
      checkMax({
        key: 'manual_overrides',
        label: '人工覆盖次数',
        value: paper.manual_override_count,
        ready_max: QUANT_WORKFLOW_THRESHOLDS.stage_3.manual_override_ready_max,
        degraded_max: QUANT_WORKFLOW_THRESHOLDS.stage_3.manual_override_degraded_max,
        expected: '<= 2 次',
        mandatory: false,
        weight: 6,
        unit: '次',
      }),
    ],
  });
}

function buildStage(opts: {
  stage: 1 | 2 | 3;
  stage_key: QuantWorkflowStage['stage_key'];
  title: string;
  checks: QuantWorkflowCheck[];
}): QuantWorkflowStage {
  const totalWeight = opts.checks.reduce((sum, check) => sum + check.weight, 0) || 1;
  const earned = opts.checks.reduce((sum, check) => {
    if (check.status === 'ready') return sum + check.weight;
    if (check.status === 'degraded') return sum + check.weight * 0.5;
    return sum;
  }, 0);
  const mandatoryBlocked = opts.checks.some(check => check.mandatory && check.status === 'blocked');
  const score = Math.round((earned / totalWeight) * 100);
  const status: QuantWorkflowStatus = mandatoryBlocked
    ? 'blocked'
    : score >= QUANT_WORKFLOW_THRESHOLDS.stage_score.ready_min
    ? 'ready'
    : score >= QUANT_WORKFLOW_THRESHOLDS.stage_score.degraded_min
    ? 'degraded'
    : 'blocked';
  const next_actions = opts.checks
    .filter(check => check.status !== 'ready')
    .map(check => check.message)
    .slice(0, 6);

  return {
    stage: opts.stage,
    stage_key: opts.stage_key,
    title: opts.title,
    status,
    score,
    checks: opts.checks,
    next_actions,
  };
}

function checkThreshold(opts: {
  key: string;
  label: string;
  value: number | undefined;
  ready_min: number;
  degraded_min: number;
  expected: string;
  mandatory: boolean;
  weight: number;
  unit?: string;
}): QuantWorkflowCheck {
  const value = normalizeNumber(opts.value);
  const status: QuantWorkflowStatus =
    value >= opts.ready_min ? 'ready' : value >= opts.degraded_min ? 'degraded' : 'blocked';
  return {
    key: opts.key,
    label: opts.label,
    status,
    expected: opts.expected,
    actual: Number.isFinite(value) ? value : null,
    mandatory: opts.mandatory,
    weight: opts.weight,
    message:
      status === 'ready'
        ? `${opts.label}达标。`
        : `${opts.label}不足，当前 ${formatValue(value, opts.unit)}，目标 ${opts.expected}。`,
  };
}

function checkMax(opts: {
  key: string;
  label: string;
  value: number | undefined;
  ready_max: number;
  degraded_max: number;
  expected: string;
  mandatory: boolean;
  weight: number;
  unit?: string;
}): QuantWorkflowCheck {
  const value = normalizeNumber(opts.value);
  const status: QuantWorkflowStatus =
    value <= opts.ready_max ? 'ready' : value <= opts.degraded_max ? 'degraded' : 'blocked';
  return {
    key: opts.key,
    label: opts.label,
    status,
    expected: opts.expected,
    actual: Number.isFinite(value) ? value : null,
    mandatory: opts.mandatory,
    weight: opts.weight,
    message:
      status === 'ready'
        ? `${opts.label}达标。`
        : `${opts.label}超限，当前 ${formatValue(value, opts.unit)}，目标 ${opts.expected}。`,
  };
}

function checkBoolean(opts: {
  key: string;
  label: string;
  actual: boolean;
  expected: string;
  mandatory: boolean;
  weight: number;
  message_ready: string;
  message_blocked: string;
}): QuantWorkflowCheck {
  return {
    key: opts.key,
    label: opts.label,
    status: opts.actual ? 'ready' : 'blocked',
    expected: opts.expected,
    actual: opts.actual,
    mandatory: opts.mandatory,
    weight: opts.weight,
    message: opts.actual ? opts.message_ready : opts.message_blocked,
  };
}

function checkText(opts: {
  key: string;
  label: string;
  value: string | undefined;
  min_length: number;
  weight: number;
}): QuantWorkflowCheck {
  const value = String(opts.value || '').trim();
  const status: QuantWorkflowStatus = value.length >= opts.min_length ? 'ready' : 'blocked';
  return {
    key: opts.key,
    label: opts.label,
    status,
    expected: `至少 ${opts.min_length} 个字符`,
    actual: value.length,
    mandatory: true,
    weight: opts.weight,
    message:
      status === 'ready'
        ? `${opts.label}已填写。`
        : `${opts.label}缺失或过短，需要写成可复核的研究假设。`,
  };
}

function checkWalkForward(verdict: string | undefined): QuantWorkflowCheck {
  const value = String(verdict || '').toLowerCase();
  const status: QuantWorkflowStatus =
    value === 'pass' ? 'ready' : value === 'warn' || value === 'warning' ? 'degraded' : 'blocked';
  return {
    key: 'walk_forward_verdict',
    label: 'Walk-forward 验证',
    status,
    expected: 'pass',
    actual: value || null,
    mandatory: true,
    weight: 8,
    message:
      status === 'ready'
        ? 'Walk-forward 通过。'
        : 'Walk-forward 未通过，先补样本外滚动验证再进入纸面交易。',
  };
}

function carryPreviousStageCheck(
  previous: QuantWorkflowStage,
  key: string,
  label: string,
  weight: number
): QuantWorkflowCheck {
  const ok = previous.status !== 'blocked';
  return {
    key,
    label,
    status: ok ? 'ready' : 'blocked',
    expected: '上一阶段不阻断',
    actual: previous.status,
    mandatory: true,
    weight,
    message: ok ? `${label}。` : `先完成${previous.title}。`,
  };
}

function normalizeNumber(value: number | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function formatValue(value: number, unit?: string): string {
  if (!Number.isFinite(value)) return '缺失';
  return `${value}${unit || ''}`;
}

function buildConclusion(
  stage1: QuantWorkflowStage,
  stage2: QuantWorkflowStage,
  stage3: QuantWorkflowStage
): string {
  if (stage1.status === 'blocked') return '先补齐数据与简单策略预设，暂不建议启动新回测。';
  if (stage2.status === 'blocked')
    return '可以做探索性回测，但研究可信度不足，暂不建议进入纸面交易。';
  if (stage3.status === 'ready') return '阶段 1-3 门禁通过，可进入小仓 canary/影子观察。';
  if (stage3.status === 'degraded') return '纸面交易已有基础样本，但仍需人工复核后再扩大观察。';
  return '纸面交易样本或一致性不足，继续收集样本并保持风控拦截。';
}
