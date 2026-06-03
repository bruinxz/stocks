import { Op } from 'sequelize';
import moment from 'moment-timezone';
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../models/AIInvestmentSignal';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { PaperTradingOrderIntent } from '../models/PaperTradingOrderIntent';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { RealtimeQuote } from '../models/RealtimeQuote';
import { User } from '../models/User';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { quantRecommendationService } from './QuantRecommendationService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { marketEnvironmentService } from './MarketEnvironmentService';
import { paperTradingRiskProfileService } from './PaperTradingRiskProfileService';
import { feishuBotWebhookService } from './FeishuBotWebhookService';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';
import { realtimeQuoteService } from '../data/services/RealtimeQuoteService';

export const DEFAULT_PAPER_TRADING_INITIAL_CAPITAL = 200000;

type AutoTradeStatus = 'executed' | 'planned' | 'skipped';
type RiskExitStatus = 'exited' | 'planned' | 'held' | 'skipped';
type RiskExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_take_profit'
  | 'sell_signal'
  | 'max_hold_days';

type ExecutionSide = 'BUY' | 'SELL';
type OrderIntentStatus = 'planned' | 'executed' | 'rejected' | 'skipped' | 'held';

interface ExecutionRealityDecision {
  allowed: boolean;
  side: ExecutionSide;
  action: 'allow' | 'reject' | 'watch';
  label: string;
  reasons: string[];
  price?: number;
  price_source?: string;
  quote_time?: string;
  quote_trade_date?: string;
  quote_age_minutes?: number;
  change_percent?: number;
  turnover?: number;
  avg_turnover_yuan?: number;
  from_realtime?: boolean;
  checks: Record<string, any>;
}

interface RecordOrderIntentParams {
  portfolio_id: number;
  signal?: AIInvestmentSignal | null;
  trade_id?: number;
  side: ExecutionSide;
  status: OrderIntentStatus;
  symbol: string;
  name?: string;
  source_type?: string;
  source_id?: string;
  intent_date?: string;
  reference_price?: number;
  execute_price?: number;
  quantity?: number;
  amount?: number;
  target_position_pct?: number;
  score?: number;
  risk_level?: string;
  reason_text?: string;
  reason_category?: string;
  metadata?: Record<string, any>;
}

type MarketEnvironmentSnapshotLike = {
  as_of?: string;
  market_regime?: string;
  market_regime_label?: string;
  benchmark_code?: string;
  benchmark_name?: string;
  benchmark_return_5d_pct?: number;
  benchmark_return_20d_pct?: number;
  benchmark_return_60d_pct?: number;
  benchmark_drawdown_60d_pct?: number;
  benchmark_price_vs_ma20_pct?: number;
  benchmark_price_vs_ma60_pct?: number;
  breadth?: Record<string, any>;
  industry?: {
    name?: string;
    regime?: string;
    label?: string;
    sample_count?: number;
    avg_return_20d_pct?: number;
    relative_return_20d_pct?: number;
    above_ma20_ratio?: number;
  };
};

interface EnvironmentEntryPolicy {
  enabled: boolean;
  allow_entry: boolean;
  position_multiplier: number;
  reason: string;
  market_regime?: string;
  market_regime_label?: string;
  industry_regime?: string;
  industry_label?: string;
  market_environment?: MarketEnvironmentSnapshotLike;
  matched_segment?: any;
  preferred_segment?: any;
  external_policy_snapshot_id?: string;
  loop_policy_snapshot_id?: number;
  external_policy_reason?: string;
  external_policy_match?: any;
  resample_match?: any;
  budget_action_policy_match?: any;
  budget_policy_version?: any;
  budget_policy_version_guard?: any;
  budget_policy_rollback_plan?: any;
  notes?: string[];
}

export interface PaperTradingAutoOptions {
  user_id?: number;
  username?: string;
  portfolio_name?: string;
  initial_capital?: number;
  force_new_portfolio?: boolean;
  source_type?: string;
  agent_session?: string;
  task_label?: string;
  limit?: number;
  scan_limit?: number;
  min_score?: number;
  max_positions?: number;
  default_position_pct?: number;
  max_position_pct?: number;
  min_trade_amount?: number;
  allowed_risk_levels?: string[];
  require_action_buy?: boolean;
  allow_watch_signals_for_sampling?: boolean;
  strategy_keys?: string[] | string;
  strategy_family_key?: string;
  dry_run?: boolean;
  report_to_feishu?: boolean;
  notify_to_feishu_bot?: boolean;
  signal_date_start?: string;
  signal_date_end?: string;
  signal_ids?: number[];
  ignore_profit_gate_for_forced_signals?: boolean;
  allow_min_lot_for_forced_signals?: boolean;
  max_forced_min_lot_position_pct?: number;
  allow_min_lot_for_sampling_signals?: boolean;
  max_sampling_min_lot_position_pct?: number;
  allow_low_data_quality_for_forced_signals?: boolean;
  use_attribution_feedback?: boolean;
  use_profit_gate?: boolean;
  profit_gate_horizon?: string;
  profit_gate_min_samples?: number;
  profit_gate_min_quality_score?: number;
  profit_gate_allow_deprioritized?: boolean;
  profit_gate_allow_sampling?: boolean;
  profit_gate_sampling_multiplier?: number;
  use_outcome_feedback?: boolean;
  outcome_feedback_min_closed_samples?: number;
  outcome_feedback_lookback_days?: number;
  outcome_feedback_limit?: number;
  external_environment_policy?: Record<string, any>;
  environment_policy_snapshot_id?: string;
  loop_policy_snapshot_id?: number;
  use_entry_risk_guard?: boolean;
  max_daily_new_positions?: number;
  max_daily_new_exposure_pct?: number;
  max_total_exposure_pct?: number;
  max_industry_exposure_pct?: number;
  min_cash_reserve_pct?: number;
  max_portfolio_drawdown_pct?: number;
  max_single_stock_volatility_pct?: number;
  max_position_correlation?: number;
  max_portfolio_var_pct?: number;
  min_avg_turnover_yuan?: number;
  cooldown_days_after_loss?: number;
  block_st?: boolean;
  block_limit_up?: boolean;
  block_limit_down?: boolean;
  block_suspended?: boolean;
  risk_profile_gate?: {
    [key: string]: any;
    enabled?: boolean;
    action?: string;
    reason?: string;
    effective_trade_limit?: number;
    effective_default_position_pct?: number;
    effective_max_position_pct?: number;
    position_multiplier?: number;
    quote_freshness_action?: string;
    quote_freshness_reason?: string;
    quote_freshness_multiplier?: number;
    quote_persistence?: Record<string, any>;
    metadata_contains?: Record<string, any>;
  };
}

export interface PaperTradingAutoSyncOptions extends PaperTradingAutoOptions {
  refresh_recommendations?: boolean;
  universe?: 'favorites' | 'market';
  style?: 'balanced' | 'momentum' | 'value' | 'low_risk';
  candidate_limit?: number;
  candidate_pool_limit?: number;
  lookback_days?: number;
  verify_signals?: boolean;
}

export interface PaperTradingAutoTradeItem {
  status: AutoTradeStatus;
  signal_id: number;
  source_type: string;
  source_id: string;
  signal_date: string;
  symbol: string;
  name?: string;
  decision: string;
  score?: number;
  risk_level?: string;
  action?: string;
  action_label?: string;
  quantity?: number;
  latest_price?: number;
  execute_price?: number;
  amount?: number;
  commission?: number;
  total_cost?: number;
  target_position_pct?: number;
  min_lot_sample?: boolean;
  min_lot_sample_reason?: string;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  original_score?: number;
  consensus_count?: number;
  consensus_bonus?: number;
  consensus_variants?: string[];
  recommendation_tier?: string;
  recommendation_tier_label?: string;
  strategy_allocation_pct?: number;
  strategy_allocation_amount?: number;
  strategy_max_single_trade_pct?: number;
  strategy_max_single_trade_amount?: number;
  strategy_budget_action?: string;
  strategy_budget_label?: string;
  strategy_budget_reason?: string;
  strategy_budget_confidence?: number;
  strategy_budget_discipline?: Record<string, any>;
  entry_risk_guard_decision?: {
    allowed: boolean;
    label: string;
    reasons: string[];
    candidate_position_pct?: number;
    strategy_allocation_pct?: number;
    checks?: Record<string, any>;
  };
  execution_reality_decision?: ExecutionRealityDecision;
  environment_multiplier?: number;
  environment_reason?: string;
  resample_sample?: boolean;
  resample_combo_key?: string;
  resample_reason?: string;
  resample_position_multiplier?: number;
  environment_strategy_budget_action?: string;
  environment_strategy_budget_multiplier?: number;
  environment_strategy_budget_reason?: string;
  environment_strategy_budget_policy_action?: string;
  environment_strategy_budget_policy_reason?: string;
  environment_strategy_budget_policy_multiplier?: number;
  environment_strategy_budget_policy_version_id?: string;
  environment_strategy_budget_policy_version_hash?: string;
  budget_policy_version_snapshot_id?: number;
  environment_strategy_budget_policy_version_guard_action?: string;
  environment_strategy_budget_policy_version_guard_reason?: string;
  environment_strategy_budget_policy_version_guard_champion?: string;
  environment_strategy_budget_policy_rollback_action?: string;
  environment_strategy_budget_policy_rollback_source?: string;
  environment_strategy_budget_policy_rollback_snapshot_id?: number;
  environment_strategy_budget_policy_rollback_reason?: string;
  market_regime?: string;
  market_regime_label?: string;
  industry_regime?: string;
  industry_label?: string;
  trade_id?: number;
  trace_url?: string;
  reason?: string;
}

export interface PaperTradingSnapshotResult {
  portfolio_id: number;
  date: string;
  total_value: number;
  current_cash: number;
  position_value: number;
  positions: Array<{
    symbol: string;
    name?: string;
    quantity: number;
    avg_cost: number;
    current_price: number;
    market_value: number;
    unrealized_pnl: number;
  }>;
}

export interface PaperTradingAutoResult {
  portfolio_id: number;
  user_id: number;
  dry_run: boolean;
  source_type: string;
  scanned: number;
  eligible: number;
  executed: number;
  planned: number;
  skipped: number;
  trades: PaperTradingAutoTradeItem[];
  skipped_items: PaperTradingAutoTradeItem[];
  snapshot?: PaperTradingSnapshotResult;
  generated?: any;
  archive?: any;
  feedback_policy?: {
    enabled: boolean;
    closed_samples: number;
    recommended_min_score?: number;
    effective_min_score: number;
    recommended_allowed_risk_levels?: string[];
    effective_allowed_risk_levels: string[];
    preferred_source_type?: string;
    preferred_action?: string;
    strongest_bucket?: string;
  };
  profit_gate_policy?: {
    enabled: boolean;
    allow_entries: boolean;
    source_type?: string;
    agent_session?: string;
    horizon: string;
    min_samples: number;
    min_quality_score: number;
    completed_samples: number;
    quality_score: number;
    gate_label?: string;
    gate_severity?: string;
    gate_action?: string;
    position_multiplier: number;
    effective_position_multiplier: number;
    sampling_mode?: boolean;
    reason?: string;
    risk_notes?: string[];
  };
  outcome_feedback_policy?: {
    enabled: boolean;
    closed_samples: number;
    min_closed_samples: number;
    lookback_days: number;
    recommended_min_score?: number;
    effective_min_score: number;
    recommended_allowed_risk_levels?: string[];
    effective_allowed_risk_levels: string[];
    position_multiplier: number;
    effective_position_multiplier: number;
    avg_excess_return_pct?: number;
    excess_win_rate?: number;
    allow_entries: boolean;
    preferred_segments?: any[];
    blocked_segments?: any[];
    best_segments?: any[];
    weak_segments?: any[];
    recovered_segments?: any[];
    extended_cooldown_segments?: any[];
    reason?: string;
    insights?: string[];
    next_actions?: string[];
  };
  entry_risk_guard_policy?: {
    enabled: boolean;
    max_daily_new_positions: number;
    max_daily_new_exposure_pct: number;
    max_total_exposure_pct: number;
    max_industry_exposure_pct: number;
    min_cash_reserve_pct: number;
    max_portfolio_drawdown_pct: number;
    max_single_stock_volatility_pct: number;
    max_position_correlation: number;
    max_portfolio_var_pct: number;
    min_avg_turnover_yuan: number;
    cooldown_days_after_loss: number;
    block_st: boolean;
    block_limit_up: boolean;
    block_limit_down: boolean;
    block_suspended: boolean;
    peak_total_value?: number;
    portfolio_drawdown_pct?: number;
    current_exposure_pct: number;
    current_strategy_exposure_pct?: Record<string, number>;
    today_buy_count: number;
    today_new_exposure_pct: number;
    remaining_daily_new_positions: number;
    remaining_daily_new_exposure_pct: number;
    staged_strategy_exposure_pct?: Record<string, number>;
    risk_notes: string[];
  };
  environment_guard_policy?: {
    enabled: boolean;
    description: string;
    pressure_market_multiplier: number;
    bear_market_multiplier: number;
    strong_market_multiplier: number;
    industry_cold_multiplier: number;
    industry_hot_multiplier: number;
    hard_block_rules: string[];
  };
  skip_reason_summary?: {
    total: number;
    top_reasons: Array<{
      reason: string;
      count: number;
      examples: Array<{
        symbol: string;
        name?: string;
        score?: number;
        consensus_count?: number;
      }>;
    }>;
    categories: Record<string, number>;
  };
  risk_profile?: any;
  risk_profile_gate?: any;
  strategy_filter_policy?: any;
}

interface EntryRiskGuardState {
  enabled: boolean;
  max_daily_new_positions: number;
  max_daily_new_exposure_pct: number;
  max_total_exposure_pct: number;
  max_industry_exposure_pct: number;
  min_cash_reserve_pct: number;
  max_portfolio_drawdown_pct: number;
  max_single_stock_volatility_pct: number;
  max_position_correlation: number;
  max_portfolio_var_pct: number;
  min_avg_turnover_yuan: number;
  cooldown_days_after_loss: number;
  block_st: boolean;
  block_limit_up: boolean;
  block_limit_down: boolean;
  block_suspended: boolean;
  total_value: number;
  peak_total_value: number;
  portfolio_drawdown_pct: number;
  current_exposure_pct: number;
  open_position_symbols: string[];
  current_strategy_exposure_pct: Map<string, number>;
  today_buy_count: number;
  today_new_exposure_pct: number;
  staged_count: number;
  staged_exposure_pct: number;
  staged_strategy_exposure_pct: Map<string, number>;
  industry_exposure_amount: Map<string, number>;
  risk_notes: string[];
}

interface EntryMarketProfile {
  symbol: string;
  name?: string;
  industry?: string;
  market?: string;
  data_status?: string;
  is_st: boolean;
  is_suspended: boolean;
  is_limit_up: boolean;
  is_limit_down: boolean;
  latest_change_percent?: number;
  volatility_20d_pct?: number;
  recent_returns_20d?: number[];
  max_correlation_with_positions?: number;
  estimated_portfolio_var_pct?: number;
  avg_turnover_yuan: number;
  realtime_turnover_yuan?: number;
  latest_price?: number;
  price_source?: string;
  quote_time?: string;
  quote_age_minutes?: number;
  quote_trade_date?: string;
  quote_freshness_status?: string;
  from_realtime?: boolean;
  latest_date?: string;
  cooldown_hit?: {
    exit_date?: string;
    total_pnl_pct?: number;
    realized_pnl_pct?: number;
  } | null;
}

export interface PaperTradingRiskCheckOptions {
  user_id?: number;
  username?: string;
  portfolio_name?: string;
  initial_capital?: number;
  force_new_portfolio?: boolean;
  dry_run?: boolean;
  report_to_feishu?: boolean;
  notify_to_feishu_bot?: boolean;
  limit?: number;
  enable_stop_loss?: boolean;
  enable_take_profit?: boolean;
  enable_trailing_take_profit?: boolean;
  enable_sell_signals?: boolean;
  use_adaptive_risk_policy?: boolean;
  adaptive_risk_lookback_days?: number;
  adaptive_risk_min_closed_samples?: number;
  adaptive_risk_override_signal_params?: boolean;
  default_stop_loss_pct?: number;
  default_take_profit_pct?: number;
  trailing_activation_pct?: number;
  trailing_drawdown_pct?: number;
  max_hold_days?: number;
  min_sell_signal_score?: number;
  sell_signal_source_type?: string;
}

export interface PaperTradingRiskExitItem {
  status: RiskExitStatus;
  reason?: RiskExitReason;
  reason_label?: string;
  symbol: string;
  name?: string;
  quantity: number;
  avg_cost: number;
  latest_price: number;
  execute_price?: number;
  amount?: number;
  commission?: number;
  net_revenue?: number;
  realized_pnl?: number;
  pnl_pct: number;
  holding_days: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  trailing_activation_pct?: number;
  trailing_drawdown_pct?: number;
  max_profit_pct?: number;
  drawdown_from_peak_pct?: number;
  peak_price?: number;
  trailing_stop_price?: number;
  signal_id?: number;
  source_signal_id?: number;
  sell_signal_id?: number;
  sell_signal_date?: string;
  sell_signal_score?: number;
  execution_reality_decision?: ExecutionRealityDecision;
  trade_id?: number;
  message?: string;
}

export interface PaperTradingAdaptiveRiskPolicy {
  enabled: boolean;
  applied: boolean;
  closed_samples: number;
  min_closed_samples: number;
  lookback_days: number;
  confidence: number;
  reason: string;
  requested_stop_loss_pct: number;
  requested_take_profit_pct: number;
  requested_trailing_activation_pct: number;
  requested_trailing_drawdown_pct: number;
  requested_max_hold_days: number;
  effective_stop_loss_pct: number;
  effective_take_profit_pct: number;
  effective_trailing_activation_pct: number;
  effective_trailing_drawdown_pct: number;
  effective_max_hold_days: number;
  override_signal_params: boolean;
  avg_mfe_pct?: number;
  avg_mae_pct?: number;
  avg_closed_return_pct?: number;
  avg_excess_return_pct?: number;
  win_rate?: number;
  excess_win_rate?: number;
  profit_factor?: number;
  avg_holding_days?: number;
  notes: string[];
}

export interface PaperTradingRiskCheckResult {
  portfolio_id: number;
  user_id: number;
  dry_run: boolean;
  checked: number;
  exit_candidates: number;
  exited: number;
  planned: number;
  held: number;
  skipped: number;
  exits: PaperTradingRiskExitItem[];
  held_items: PaperTradingRiskExitItem[];
  skipped_items: PaperTradingRiskExitItem[];
  adaptive_risk_policy?: PaperTradingAdaptiveRiskPolicy;
  snapshot?: PaperTradingSnapshotResult;
  risk_profile?: any;
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toOptionalNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const normalized = Math.floor(num);
  return max ? Math.min(normalized, max) : normalized;
}

function toBoolean(value: any, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function paperTradingMetaForPortfolio(
  metadata: Record<string, any>,
  portfolio_id?: number
): Record<string, any> {
  const legacy = asPlainObject(metadata.paper_trading);
  const byPortfolio = asPlainObject(metadata.paper_trading_by_portfolio);
  const keyed = portfolio_id ? asPlainObject(byPortfolio[String(portfolio_id)]) : {};
  return Object.keys(keyed).length > 0 ? keyed : legacy;
}

function executedSignalWhereForPortfolio(portfolio_id: number) {
  const keyedPortfolioId = String(portfolio_id);
  return {
    [Op.or]: [
      {
        metadata: {
          [Op.contains]: {
            paper_trading: {
              portfolio_id,
              status: 'executed',
            },
          },
        },
      },
      {
        metadata: {
          [Op.contains]: {
            paper_trading_by_portfolio: {
              [keyedPortfolioId]: {
                portfolio_id,
                status: 'executed',
              },
            },
          },
        },
      },
    ],
  } as any;
}

function nextPaperTradingMetadata(
  metadata: Record<string, any>,
  portfolio_id: number,
  paperTrading: Record<string, any>
) {
  const byPortfolio = asPlainObject(metadata.paper_trading_by_portfolio);
  return {
    ...metadata,
    paper_trading: paperTrading,
    paper_trading_by_portfolio: {
      ...byPortfolio,
      [String(portfolio_id)]: paperTrading,
    },
  };
}

function compactText(value: any, maxLength = 120): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length < 5) return 0;
  const ax = a.slice(-length);
  const bx = b.slice(-length);
  const avgA = ax.reduce((sum, value) => sum + value, 0) / length;
  const avgB = bx.reduce((sum, value) => sum + value, 0) / length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let index = 0; index < length; index++) {
    const da = ax[index] - avgA;
    const db = bx[index] - avgB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denominator = Math.sqrt(denomA * denomB);
  if (!denominator) return 0;
  return numerator / denominator;
}

function strategyKeysFromSignalMetadata(metadata: Record<string, any>): string[] {
  const strategyVariant = asPlainObject(metadata.strategy_variant);
  const paperTrading = paperTradingMetaForPortfolio(metadata);
  const paperVariant = asPlainObject(paperTrading.strategy_variant);
  const keys = [
    metadata.strategy_key,
    strategyVariant.strategy_key,
    paperTrading.strategy_key,
    paperVariant.strategy_key,
    ...(Array.isArray(strategyVariant.strategy_keys) ? strategyVariant.strategy_keys : []),
    ...(Array.isArray(paperVariant.strategy_keys) ? paperVariant.strategy_keys : []),
    ...(Array.isArray(metadata.consensus_variants) ? metadata.consensus_variants : []),
  ]
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return [...new Set(keys.length ? keys : ['unknown'])];
}

function normalizeStringArray(value: any): string[] {
  if (Array.isArray(value)) {
    return [
      ...new Set(value.map(item => String(item || '').trim()).filter(item => item.length > 0)),
    ];
  }
  if (typeof value === 'string') {
    return [
      ...new Set(
        value
          .split(',')
          .map(item => item.trim())
          .filter(item => item.length > 0)
      ),
    ];
  }
  return [];
}

function signalMatchesStrategyKeys(signal: AIInvestmentSignal, strategyKeys: string[]): boolean {
  if (!strategyKeys.length) return true;
  const allowed = new Set(strategyKeys);
  const metadata = asPlainObject(signal.metadata);
  return strategyKeysFromSignalMetadata(metadata).some(key => allowed.has(key));
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

function normalizeSkipReasonCategory(reason?: string): string {
  const text = String(reason || '').trim();
  if (!text) return 'unknown';
  if (text.includes('执行可行性') || text.includes('涨停') || text.includes('跌停')) {
    return 'execution_reality';
  }
  if (text.includes('已持有') || text.includes('重复加仓') || text.includes('执行过')) {
    return 'duplicate_or_existing_position';
  }
  if (text.includes('收益闸门') || text.includes('Profit')) return 'profit_gate';
  if (text.includes('收益闭环') || text.includes('降权片段')) return 'outcome_feedback';
  if (text.includes('市场环境') || text.includes('环境风控')) return 'market_environment_guard';
  if (text.includes('入场风控')) return 'entry_risk_guard';
  if (text.includes('风险等级')) return 'risk_level';
  if (text.includes('暂不参与') || text.includes('不是买入')) return 'trade_discipline';
  if (text.includes('资金') || text.includes('最小阈值') || text.includes('一手')) {
    return 'capital_or_lot_size';
  }
  if (text.includes('最新价格') || text.includes('数据')) return 'market_data';
  if (text.includes('持仓数量') || text.includes('上限')) return 'position_limit';
  if (text.includes('旧信号')) return 'stale_signal';
  return 'other';
}

function summarizeSkippedItems(items: PaperTradingAutoTradeItem[]) {
  const reasonMap = new Map<
    string,
    {
      reason: string;
      count: number;
      examples: Array<{
        symbol: string;
        name?: string;
        score?: number;
        consensus_count?: number;
      }>;
    }
  >();
  const categories: Record<string, number> = {};

  for (const item of items) {
    const reason = String(item.reason || '未说明原因');
    const category = normalizeSkipReasonCategory(reason);
    categories[category] = (categories[category] || 0) + 1;

    const bucket = reasonMap.get(reason) || { reason, count: 0, examples: [] };
    bucket.count += 1;
    if (item.symbol && bucket.examples.length < 3) {
      bucket.examples.push({
        symbol: item.symbol,
        name: item.name,
        score: item.score,
        consensus_count: item.consensus_count,
      });
    }
    reasonMap.set(reason, bucket);
  }

  return {
    total: items.length,
    top_reasons: Array.from(reasonMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    categories,
  };
}

function normalizeRiskLevel(value: any): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function quoteAgeMinutes(value?: Date | string | null): number | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function getChinaToday(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function dateOnly(value?: Date | string | null): string {
  if (!value) return getChinaToday();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return moment(date).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function riskReasonLabel(reason: RiskExitReason): string {
  const labels: Record<RiskExitReason, string> = {
    stop_loss: '触发止损',
    take_profit: '触发止盈',
    trailing_take_profit: '移动止盈',
    sell_signal: '出现卖出信号',
    max_hold_days: '达到最长持有期',
  };
  return labels[reason] || reason;
}

class PaperTradingAutomationService {
  private readonly commissionRate = 0.0003;
  private readonly slippageRate = 0.001;

  async ensurePortfolio(
    options: {
      user_id?: number;
      username?: string;
      name?: string;
      initial_capital?: number;
      force_new?: boolean;
    } = {}
  ): Promise<PaperTradingPortfolio> {
    const user = await this.resolveUser(options.user_id, options.username);
    const user_id = user.id;

    let portfolio: PaperTradingPortfolio | null = null;

    if (options.name) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id, name: options.name },
        order: [['id', 'ASC']],
      });
    }

    // 显式传入 name 时，调用方通常希望隔离到指定模拟盘（例如 20W 自主荐股盘）。
    // 如果命名盘不存在，直接创建该命名盘；不要回退到用户当前 active 模拟盘，避免收益闭环串盘。
    if (!portfolio && !options.name && !options.force_new) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id, is_active: true },
        order: [['id', 'ASC']],
      });

      if (!portfolio) {
        portfolio = await PaperTradingPortfolio.findOne({
          where: { user_id },
          order: [['id', 'ASC']],
        });
      }
    }

    if (!portfolio) {
      const initial_capital = toNumber(
        options.initial_capital,
        DEFAULT_PAPER_TRADING_INITIAL_CAPITAL
      );
      const displayName = user.nickname || user.username || '系统';
      portfolio = await PaperTradingPortfolio.create({
        user_id,
        name: options.name || `${displayName}的信号跟单模拟盘`,
        initial_capital,
        current_cash: initial_capital,
        total_value: initial_capital,
        is_active: true,
      });
    }

    return portfolio;
  }

  async syncLatestPricesAndSnapshot(portfolio_id: number): Promise<PaperTradingSnapshotResult> {
    const portfolio = await PaperTradingPortfolio.findByPk(portfolio_id);
    if (!portfolio) {
      throw new Error(`模拟盘不存在: ${portfolio_id}`);
    }

    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id },
      order: [['created_at', 'ASC']],
    });

    let positionValue = 0;
    const normalizedPositions: PaperTradingSnapshotResult['positions'] = [];

    for (const position of positions) {
      const quote = await this.getLatestPrice(position.symbol, toNumber(position.current_price, 0));
      const current_price = quote.price || toNumber(position.current_price, 0);
      const quantity = toNumber(position.quantity, 0);
      const avg_cost = toNumber(position.avg_cost, 0);
      const market_value = roundNumber(current_price * quantity, 2);
      const unrealized_pnl = roundNumber(market_value - avg_cost * quantity, 2);

      await position.update({
        current_price,
        market_value,
        unrealized_pnl,
      });

      positionValue += market_value;
      normalizedPositions.push({
        symbol: position.symbol,
        name: position.name,
        quantity,
        avg_cost,
        current_price,
        market_value,
        unrealized_pnl,
      });
    }

    const current_cash = roundNumber(toNumber(portfolio.current_cash, 0), 2);
    const total_value = roundNumber(current_cash + positionValue, 2);
    await portfolio.update({ total_value });

    const date = getChinaToday();
    const snapshotPayload = {
      portfolio_id,
      date,
      total_value,
      current_cash,
      position_value: roundNumber(positionValue, 2),
    };
    const existingSnapshot = await PaperTradingSnapshot.findOne({
      where: { portfolio_id, date },
      order: [['id', 'DESC']],
    });

    if (existingSnapshot) {
      await existingSnapshot.update(snapshotPayload);
    } else {
      await PaperTradingSnapshot.create(snapshotPayload);
    }

    return {
      ...snapshotPayload,
      positions: normalizedPositions,
    };
  }

  async autoBuyFromSignals(options: PaperTradingAutoOptions = {}): Promise<PaperTradingAutoResult> {
    const dry_run = toBoolean(options.dry_run, false);
    const report_to_feishu = toBoolean(options.report_to_feishu, true);
    const limit = toPositiveInt(options.limit, 5, 20);
    const scan_limit = toPositiveInt(options.scan_limit, Math.max(limit * 8, 40), 300);
    let min_score = toNumber(options.min_score, 72);
    const max_positions = toPositiveInt(options.max_positions, 8, 30);
    const riskProfileGate = asPlainObject(options.risk_profile_gate);
    const quotePersistence = await realtimeQuoteService.getPersistenceSummary().catch(error => {
      logger.warn(`读取实时行情新鲜度失败: ${error?.message || error}`);
      return null;
    });
    if (quotePersistence && riskProfileGate.quote_persistence === undefined) {
      riskProfileGate.quote_persistence = quotePersistence;
    }
    const quoteFreshnessAction =
      quotePersistence && quotePersistence.persisted && quotePersistence.is_fresh === false
        ? 'reduce'
        : quotePersistence && !quotePersistence.persisted
        ? 'observe'
        : 'allow';
    if (riskProfileGate.quote_freshness_action === undefined) {
      riskProfileGate.quote_freshness_action = quoteFreshnessAction;
    }
    if (
      riskProfileGate.quote_freshness_multiplier === undefined &&
      quoteFreshnessAction === 'reduce'
    ) {
      riskProfileGate.quote_freshness_multiplier = 0.5;
    }
    if (riskProfileGate.quote_freshness_reason === undefined && quotePersistence) {
      riskProfileGate.quote_freshness_reason =
        quoteFreshnessAction === 'reduce'
          ? `实时行情已过期 ${quotePersistence.age_minutes || 0} 分钟，本轮自动降仓`
          : quoteFreshnessAction === 'observe'
          ? '尚未发现实时行情落盘记录，本轮保持观察仓位'
          : '实时行情新鲜度正常';
    }
    const riskGateAction = String(riskProfileGate.action || '').toLowerCase();
    const riskGateMultiplier = clamp(
      toNumber(
        riskProfileGate.position_multiplier,
        riskGateAction === 'pause'
          ? 0
          : riskGateAction === 'reduce'
          ? 0.5
          : riskGateAction === 'observe'
          ? 0.7
          : 1
      ),
      0,
      1.2
    );
    const quoteFreshnessMultiplier = clamp(
      toNumber(
        riskProfileGate.quote_freshness_multiplier,
        riskProfileGate.quote_freshness_action === 'reduce' ? 0.5 : 1
      ),
      0.2,
      1
    );
    const default_position_pct = toNumber(
      riskProfileGate.effective_default_position_pct,
      toNumber(options.default_position_pct, 5) * riskGateMultiplier * quoteFreshnessMultiplier
    );
    const max_position_pct = toNumber(
      riskProfileGate.effective_max_position_pct,
      toNumber(options.max_position_pct, 12) * riskGateMultiplier * quoteFreshnessMultiplier
    );
    const min_trade_amount = toNumber(options.min_trade_amount, 3000);
    const entryRiskGuard = await this.resolveEntryRiskGuardPolicy({
      enabled: toBoolean(options.use_entry_risk_guard, true),
      portfolio_id: 0,
      total_value: 0,
      max_daily_new_positions: toPositiveInt(options.max_daily_new_positions, 3, 20),
      max_daily_new_exposure_pct: toNumber(options.max_daily_new_exposure_pct, 12),
      max_total_exposure_pct: toNumber(options.max_total_exposure_pct, 60),
      max_industry_exposure_pct: toNumber(options.max_industry_exposure_pct, 25),
      min_cash_reserve_pct: toNumber(options.min_cash_reserve_pct, 8),
      max_portfolio_drawdown_pct: toNumber(options.max_portfolio_drawdown_pct, 12),
      max_single_stock_volatility_pct: toNumber(options.max_single_stock_volatility_pct, 7),
      max_position_correlation: toNumber(options.max_position_correlation, 0.82),
      max_portfolio_var_pct: toNumber(options.max_portfolio_var_pct, 10),
      min_avg_turnover_yuan: toNumber(options.min_avg_turnover_yuan, 30000000),
      cooldown_days_after_loss: toPositiveInt(options.cooldown_days_after_loss, 12, 120),
      block_st: toBoolean(options.block_st, true),
      block_limit_up: toBoolean(options.block_limit_up, true),
      block_limit_down: toBoolean(options.block_limit_down, true),
      block_suspended: toBoolean(options.block_suspended, true),
    });
    const source_type = options.source_type || AISignalSourceType.QUANT_RECOMMENDATION;
    const allowWatchSignalsForSampling = toBoolean(options.allow_watch_signals_for_sampling, false);
    const strategyFilterKeys = normalizeStringArray(options.strategy_keys);
    const require_action_buy = toBoolean(
      options.require_action_buy,
      source_type === AISignalSourceType.QUANT_RECOMMENDATION
    );
    let allowedRiskLevelList = options.allowed_risk_levels?.length
      ? options.allowed_risk_levels.map(normalizeRiskLevel).filter(Boolean)
      : ['low', 'medium'];

    const portfolio = await this.ensurePortfolio({
      user_id: options.user_id,
      username: options.username,
      name: options.portfolio_name,
      initial_capital: options.initial_capital,
      force_new: options.force_new_portfolio,
    });
    const feedbackPolicy = await this.resolveAttributionFeedbackPolicy({
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      portfolio_name: options.portfolio_name,
      initial_capital: options.initial_capital,
      force_new_portfolio: options.force_new_portfolio,
      enabled: toBoolean(options.use_attribution_feedback, true),
      requested_min_score: min_score,
      requested_allowed_risk_levels: allowedRiskLevelList,
    });
    min_score = feedbackPolicy.effective_min_score;
    allowedRiskLevelList = feedbackPolicy.effective_allowed_risk_levels;
    const profitGatePolicy = await this.resolveProfitGatePolicy({
      enabled: toBoolean(options.use_profit_gate, true),
      source_type,
      agent_session: options.agent_session,
      task_label: options.task_label,
      horizon: options.profit_gate_horizon || '5d',
      min_samples: toPositiveInt(options.profit_gate_min_samples, 5, 100),
      min_quality_score: toNumber(options.profit_gate_min_quality_score, 45),
      allow_deprioritized: toBoolean(options.profit_gate_allow_deprioritized, false),
      allow_sampling: toBoolean(options.profit_gate_allow_sampling, true),
      sampling_multiplier: toNumber(options.profit_gate_sampling_multiplier, 0.35),
      limit: scan_limit,
    });
    const signalIds = Array.isArray(options.signal_ids)
      ? options.signal_ids
          .map(value => Number(value))
          .filter(value => Number.isFinite(value) && value > 0)
      : [];
    const ignoreProfitGateForForcedSignals =
      signalIds.length > 0 ? toBoolean(options.ignore_profit_gate_for_forced_signals, true) : false;
    const outcomeFeedbackPolicy = await this.resolveOutcomeFeedbackPolicy({
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      username: options.username,
      enabled: toBoolean(options.use_outcome_feedback, true),
      requested_min_score: min_score,
      requested_allowed_risk_levels: allowedRiskLevelList,
      source_type,
      agent_session: options.agent_session,
      min_closed_samples: toPositiveInt(options.outcome_feedback_min_closed_samples, 5, 100),
      lookback_days: toPositiveInt(options.outcome_feedback_lookback_days, 365, 3650),
      limit: toPositiveInt(options.outcome_feedback_limit, 2000, 10000),
    });
    min_score = outcomeFeedbackPolicy.effective_min_score;
    allowedRiskLevelList = outcomeFeedbackPolicy.effective_allowed_risk_levels;
    const allowedRiskLevels = new Set(allowedRiskLevelList.map(normalizeRiskLevel).filter(Boolean));

    const preSnapshot = await this.syncLatestPricesAndSnapshot(portfolio.id);
    await portfolio.reload();

    const existingPositions = await PaperTradingPosition.findAll({
      where: { portfolio_id: portfolio.id },
    });
    const existingSymbols = new Set(existingPositions.map(position => position.symbol));
    const remainingSlots = Math.max(0, max_positions - existingPositions.length);
    let availableCash = toNumber(portfolio.current_cash, 0);
    const totalValue = Math.max(toNumber(portfolio.total_value, 0), preSnapshot.total_value);
    Object.assign(
      entryRiskGuard,
      await this.resolveEntryRiskGuardPolicy({
        enabled: toBoolean(options.use_entry_risk_guard, true),
        portfolio_id: portfolio.id,
        total_value: totalValue,
        max_daily_new_positions: toPositiveInt(options.max_daily_new_positions, 3, 20),
        max_daily_new_exposure_pct: toNumber(options.max_daily_new_exposure_pct, 12),
        max_total_exposure_pct: toNumber(options.max_total_exposure_pct, 60),
        max_industry_exposure_pct: toNumber(options.max_industry_exposure_pct, 25),
        min_cash_reserve_pct: toNumber(options.min_cash_reserve_pct, 8),
        max_portfolio_drawdown_pct: toNumber(options.max_portfolio_drawdown_pct, 12),
        max_single_stock_volatility_pct: toNumber(options.max_single_stock_volatility_pct, 7),
        max_position_correlation: toNumber(options.max_position_correlation, 0.82),
        max_portfolio_var_pct: toNumber(options.max_portfolio_var_pct, 10),
        min_avg_turnover_yuan: toNumber(options.min_avg_turnover_yuan, 30000000),
        cooldown_days_after_loss: toPositiveInt(options.cooldown_days_after_loss, 12, 120),
        block_st: toBoolean(options.block_st, true),
        block_limit_up: toBoolean(options.block_limit_up, true),
        block_limit_down: toBoolean(options.block_limit_down, true),
        block_suspended: toBoolean(options.block_suspended, true),
      })
    );

    const where: any = {
      normalized_decision: {
        [Op.in]: allowWatchSignalsForSampling
          ? [AISignalDecision.BUY, AISignalDecision.STRONG_BUY, AISignalDecision.HOLD]
          : [AISignalDecision.BUY, AISignalDecision.STRONG_BUY],
      },
      confidence_score: {
        [Op.gte]: min_score,
      },
    };
    if (source_type && source_type !== 'all') {
      where.source_type = source_type;
    }
    if (options.agent_session || options.task_label) {
      const metadataFilters: Record<string, any> = {};
      if (options.agent_session) metadataFilters.agent_session = options.agent_session;
      if (options.task_label) metadataFilters.task_label = options.task_label;
      where.metadata = { [Op.contains]: metadataFilters };
    }
    const metadataContains = asPlainObject(
      riskProfileGate.metadata_contains || riskProfileGate.metadataContains
    );
    if (Object.keys(metadataContains).length > 0) {
      where.metadata = where.metadata
        ? { [Op.and]: [where.metadata, { [Op.contains]: metadataContains }] }
        : { [Op.contains]: metadataContains };
    }
    if (options.signal_date_start || options.signal_date_end) {
      where.signal_date = {};
      if (options.signal_date_start) where.signal_date[Op.gte] = options.signal_date_start;
      if (options.signal_date_end) where.signal_date[Op.lte] = options.signal_date_end;
    }
    if (signalIds.length > 0) {
      where.id = { [Op.in]: signalIds };
    }

    const signals = await AIInvestmentSignal.findAll({
      where,
      order: [
        ['signal_date', 'DESC'],
        ['confidence_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit: scan_limit,
    });
    const candidateSignals = strategyFilterKeys.length
      ? signals.filter(signal => signalMatchesStrategyKeys(signal, strategyFilterKeys))
      : signals;

    const trades: PaperTradingAutoTradeItem[] = [];
    const skipped_items: PaperTradingAutoTradeItem[] = [];
    const seenSymbols = new Set<string>();
    let eligible = 0;
    const riskGateTradeLimit = toPositiveInt(
      riskProfileGate.effective_trade_limit,
      riskGateAction === 'pause' ? 0 : limit,
      limit
    );
    const targetTradeCount =
      riskGateAction === 'pause' ? 0 : Math.min(riskGateTradeLimit, remainingSlots);

    if (riskGateAction === 'pause') {
      skipped_items.push({
        status: 'skipped',
        signal_id: 0,
        source_type,
        source_id: '',
        signal_date: getChinaToday(),
        symbol: '',
        decision: '',
        reason: `组合风险画像暂停新增：${riskProfileGate.reason || '当前组合风险不适合继续加仓'}`,
      });
    } else if (riskGateAction === 'reduce' || riskGateAction === 'observe') {
      skipped_items.push({
        status: 'skipped',
        signal_id: 0,
        source_type,
        source_id: '',
        signal_date: getChinaToday(),
        symbol: '',
        decision: '',
        reason: `组合风险画像已降仓：${riskProfileGate.reason || '当前仅允许小仓验证'}`,
      });
    } else if (riskProfileGate.quote_freshness_action === 'reduce') {
      skipped_items.push({
        status: 'skipped',
        signal_id: 0,
        source_type,
        source_id: '',
        signal_date: getChinaToday(),
        symbol: '',
        decision: '',
        reason: `实时行情过期已降仓：${
          riskProfileGate.quote_freshness_reason || '当前行情快照不够新鲜'
        }`,
      });
    }

    if (remainingSlots <= 0) {
      skipped_items.push({
        status: 'skipped',
        signal_id: 0,
        source_type,
        source_id: '',
        signal_date: getChinaToday(),
        symbol: '',
        decision: '',
        reason: '模拟盘持仓数量已达到上限',
      });
    }

    if (!profitGatePolicy.allow_entries && !ignoreProfitGateForForcedSignals) {
      skipped_items.push({
        status: 'skipped',
        signal_id: 0,
        source_type,
        source_id: '',
        signal_date: getChinaToday(),
        symbol: '',
        decision: '',
        reason: `收益闸门未放行：${profitGatePolicy.gate_label || '等待样本'}；${
          profitGatePolicy.reason || '后验质量不足'
        }`,
      });
    }

    if (!outcomeFeedbackPolicy.allow_entries) {
      skipped_items.push({
        status: 'skipped',
        signal_id: 0,
        source_type,
        source_id: '',
        signal_date: getChinaToday(),
        symbol: '',
        decision: '',
        reason: `收益闭环反哺未放行：${outcomeFeedbackPolicy.reason || '闭环样本质量不足'}`,
      });
    }

    if (strategyFilterKeys.length > 0 && candidateSignals.length === 0) {
      skipped_items.push({
        status: 'skipped',
        signal_id: 0,
        source_type,
        source_id: '',
        signal_date: getChinaToday(),
        symbol: '',
        decision: '',
        reason: `策略实验盘无匹配候选：${strategyFilterKeys.join('/')}`,
      });
    }

    for (const signal of candidateSignals) {
      const itemBase = this.buildTradeItemBase(signal);
      const symbol = normalizeSymbol(signal.symbol);
      const metadata = asPlainObject(signal.metadata);
      const paperTradingMeta = paperTradingMetaForPortfolio(metadata, portfolio.id);
      const action = String(metadata.action || '').toLowerCase();
      const dataQuality = asPlainObject(metadata.data_quality);
      const dataQualityBucket = String(
        metadata.data_quality_bucket || dataQuality.bucket || 'unknown'
      ).toLowerCase();
      const dataQualityScore = Number(metadata.data_quality_score ?? dataQuality.score ?? 100);
      const dataQualityAutoTradeAllowed =
        metadata.auto_trade_allowed_by_data_quality !== undefined
          ? Boolean(metadata.auto_trade_allowed_by_data_quality)
          : dataQuality.auto_trade_allowed !== undefined
          ? Boolean(dataQuality.auto_trade_allowed)
          : !['low', 'critical'].includes(dataQualityBucket);
      const forcedSignal = signalIds.includes(signal.id);
      const allowLowQualityForcedSample =
        forcedSignal &&
        toBoolean(options.allow_low_data_quality_for_forced_signals, false) &&
        dataQualityBucket === 'low';
      const lowQualityForcedSampleReason = allowLowQualityForcedSample
        ? `强制信号低数据质量小仓采样：${roundNumber(dataQualityScore, 0) || '--'}分/${dataQualityBucket}`
        : '';
      const dataQualityIssues = Array.isArray(dataQuality.issues)
        ? dataQuality.issues
        : Array.isArray(dataQuality.warnings)
        ? dataQuality.warnings
        : [];

      const recordBuyIntent = async (
        status: OrderIntentStatus,
        reason_text?: string,
        extra: Partial<RecordOrderIntentParams> = {}
      ) => {
        const baseMetadata = {
          action,
          action_label: metadata.action_label,
          decision: signal.normalized_decision || signal.decision,
          data_quality_bucket: dataQualityBucket,
          data_quality_score: Number.isFinite(dataQualityScore) ? dataQualityScore : undefined,
          loop_run_id: signal.loop_run_id || metadata.loop_run_id,
          agent_session: metadata.agent_session,
          task_label: metadata.task_label,
        };
        return this.recordOrderIntent({
          portfolio_id: portfolio.id,
          signal,
          side: 'BUY',
          status,
          symbol,
          name: signal.name || symbol,
          reference_price: toOptionalNumber(signal.current_price),
          score: toOptionalNumber(signal.confidence_score),
          risk_level: signal.risk_level,
          ...extra,
          reason_text,
          reason_category:
            extra.reason_category ||
            (reason_text ? normalizeSkipReasonCategory(reason_text) : undefined),
          metadata: {
            ...baseMetadata,
            ...(extra.metadata || {}),
          },
        });
      };

      const skip = async (reason: string, extra: Partial<RecordOrderIntentParams> = {}) => {
        skipped_items.push({ ...itemBase, status: 'skipped', reason });
        await recordBuyIntent(reason.includes('旧信号') ? 'skipped' : 'rejected', reason, extra);
      };

      if (trades.length >= targetTradeCount) {
        break;
      }

      if (remainingSlots <= 0) {
        break;
      }

      if (!profitGatePolicy.allow_entries && !ignoreProfitGateForForcedSignals) {
        await skip(`收益闸门未放行：${profitGatePolicy.reason || profitGatePolicy.gate_label}`);
        continue;
      }

      if (
        ['critical'].includes(dataQualityBucket) ||
        (!dataQualityAutoTradeAllowed && !allowLowQualityForcedSample)
      ) {
        await skip(
          `数据质量未达自动跟单标准（${
            Number.isFinite(dataQualityScore) ? dataQualityScore : '--'
          }分/${dataQualityBucket}），${dataQualityIssues.slice(0, 2).join('；') || '禁止自动买入'}`
        );
        continue;
      }

      if (dataQualityBucket === 'low' && !forcedSignal) {
        await skip(
          `Agent 数据质量偏低（${
            Number.isFinite(dataQualityScore) ? dataQualityScore : '--'
          }分），需人工复核后再跟单`
        );
        continue;
      }

      if (!outcomeFeedbackPolicy.allow_entries) {
        await skip(`收益闭环反哺未放行：${outcomeFeedbackPolicy.reason || '闭环样本质量不足'}`);
        continue;
      }

      if (seenSymbols.has(symbol)) {
        await skip('同一标的已有更新的候选信号，本条旧信号跳过');
        continue;
      }
      seenSymbols.add(symbol);

      if (existingSymbols.has(symbol)) {
        await skip('模拟盘已持有该标的，避免重复加仓');
        continue;
      }

      if (
        paperTradingMeta.status === 'executed' &&
        Number(paperTradingMeta.portfolio_id) === Number(portfolio.id)
      ) {
        await skip('该信号已被当前模拟盘执行过');
        continue;
      }

      const riskLevel = normalizeRiskLevel(signal.risk_level);
      if (!allowedRiskLevels.has(riskLevel)) {
        await skip(`风险等级 ${riskLevel || 'unknown'} 不在允许范围内`);
        continue;
      }

      if (action === 'avoid') {
        await skip('候选交易纪律为暂不参与');
        continue;
      }
      if (allowWatchSignalsForSampling && action && !['buy', 'watch'].includes(action)) {
        await skip(`策略采样只允许买入/观察动作：${metadata.action_label || action}`);
        continue;
      }
      if (require_action_buy && action !== 'buy') {
        await skip(`候选交易纪律不是买入动作：${metadata.action_label || action || '未给出'}`);
        continue;
      }

      const environmentPolicy = await this.evaluateEnvironmentEntryPolicy(signal, {
        metadata,
        outcome_feedback_policy: outcomeFeedbackPolicy,
        external_environment_policy: options.external_environment_policy,
        environment_policy_snapshot_id: options.environment_policy_snapshot_id,
        loop_policy_snapshot_id: options.loop_policy_snapshot_id,
        forced: signalIds.includes(signal.id),
      });
      if (!environmentPolicy.allow_entry) {
        await skip(`市场环境未放行：${environmentPolicy.reason}`);
        continue;
      }

      const blockedSegment = this.matchOutcomeBlockedSegment(signal, outcomeFeedbackPolicy);
      if (blockedSegment) {
        await skip(
          `收益闭环降权片段 ${blockedSegment.label || blockedSegment.key} 暂停自动买入：平均超额 ${
            blockedSegment.avg_excess_return_pct ?? '--'
          }% / 样本 ${blockedSegment.closed_count ?? '--'}`
        );
        continue;
      }

      const marketProfile = await this.getEntryMarketProfile(symbol, {
        cooldown_days_after_loss: entryRiskGuard.cooldown_days_after_loss,
      });
      const marketProfileWithPortfolioRisk = await this.enrichEntryMarketProfileRisk(
        marketProfile,
        entryRiskGuard,
        0
      );
      const preTradeRisk = this.evaluateEntryRiskGuard({
        guard: entryRiskGuard,
        profile: marketProfileWithPortfolioRisk,
        candidate_position_pct: 0,
      });
      if (!preTradeRisk.allowed) {
        await skip(preTradeRisk.reasons.join('；'));
        continue;
      }

      const quote = await this.getLatestPrice(symbol, toNumber(signal.current_price, 0));
      if (!quote.price || quote.price <= 0) {
        await skip('无法获取有效最新价格');
        continue;
      }
      const executionRealityDecision = this.evaluateExecutionReality({
        side: 'BUY',
        profile: marketProfileWithPortfolioRisk,
        quote,
        min_avg_turnover_yuan: entryRiskGuard.min_avg_turnover_yuan,
        block_limit_up: entryRiskGuard.block_limit_up,
        block_limit_down: entryRiskGuard.block_limit_down,
        block_suspended: entryRiskGuard.block_suspended,
        block_st: entryRiskGuard.block_st,
      });
      if (!executionRealityDecision.allowed) {
        await skip(executionRealityDecision.reasons.join('；'), {
          reference_price: executionRealityDecision.price || quote.price,
          metadata: {
            execution_reality_decision: executionRealityDecision,
            price_source: executionRealityDecision.price_source || quote.source,
          },
        });
        continue;
      }

      const strategyVariant = asPlainObject(metadata.strategy_variant);
      const externalStrategyBudgetDiscipline = asPlainObject(
        asPlainObject(options.external_environment_policy).strategy_budget_discipline
      );
      const metadataStrategyBudgetDiscipline = asPlainObject(
        metadata.strategy_budget_discipline || strategyVariant.strategy_budget_discipline
      );
      const strategyBudgetDiscipline = {
        ...externalStrategyBudgetDiscipline,
        ...metadataStrategyBudgetDiscipline,
      };
      const strategyAllocationPolicy = asPlainObject(
        metadata.strategy_allocation_policy ||
          strategyVariant.strategy_allocation_policy ||
          strategyBudgetDiscipline.policy
      );
      const strategyMaxSingleTradePct = toOptionalNumber(
        metadata.strategy_max_single_trade_pct ||
          strategyAllocationPolicy.max_single_trade_pct ||
          strategyBudgetDiscipline.max_single_trade_pct ||
          strategyVariant.strategy_max_single_trade_pct
      );
      const strategyPositionCap =
        strategyMaxSingleTradePct && strategyMaxSingleTradePct > 0
          ? Math.min(max_position_pct, strategyMaxSingleTradePct)
          : max_position_pct;
      const strategyKeysForBudget = strategyKeysFromSignalMetadata(metadata);
      const strategyAllocationPct = toOptionalNumber(
        metadata.strategy_allocation_pct ||
          strategyAllocationPolicy.allocation_pct ||
          strategyBudgetDiscipline.allocation_pct ||
          strategyVariant.strategy_allocation_pct
      );
      const suggestedPct = clamp(
        toNumber(
          metadata.suggested_position_pct || strategyVariant.suggested_position_pct,
          default_position_pct
        ),
        1,
        strategyPositionCap
      );
      const outcomePositionMultiplier = Number.isFinite(
        Number(outcomeFeedbackPolicy.effective_position_multiplier)
      )
        ? Number(outcomeFeedbackPolicy.effective_position_multiplier)
        : 1;
      const dataQualityPositionMultiplier =
        dataQualityBucket === 'high' || dataQualityBucket === 'unknown'
          ? 1
          : dataQualityBucket === 'medium'
          ? toNumber(dataQuality.position_multiplier, 0.75)
          : toNumber(dataQuality.position_multiplier, 0.35);
      const gatedSuggestedPct = clamp(
        suggestedPct *
          profitGatePolicy.effective_position_multiplier *
          outcomePositionMultiplier *
          dataQualityPositionMultiplier *
          environmentPolicy.position_multiplier,
        0,
        strategyPositionCap
      );
      const execute_price = roundNumber(quote.price * (1 + this.slippageRate), 3);
      const oneLotQuantity = 100;
      const oneLotAmount = roundNumber(execute_price * oneLotQuantity, 2);
      const oneLotCommission = roundNumber(oneLotAmount * this.commissionRate, 2);
      const oneLotCost = roundNumber(oneLotAmount + oneLotCommission, 2);
      const oneLotPositionPct =
        totalValue > 0 ? roundNumber((oneLotCost / totalValue) * 100, 4) : 0;
      const minTradeAmountPct =
        totalValue > 0 ? roundNumber((min_trade_amount / totalValue) * 100, 4) : 0;
      const forcedMinLotEnabled =
        forcedSignal && toBoolean(options.allow_min_lot_for_forced_signals, true);
      const samplingMinLotEnabled =
        !forcedSignal &&
        toBoolean(options.allow_min_lot_for_sampling_signals, true) &&
        (Boolean(profitGatePolicy.sampling_mode) ||
          Number(outcomeFeedbackPolicy.closed_samples || 0) <
            Number(outcomeFeedbackPolicy.min_closed_samples || 0));
      const requestedForcedMinLotCapPct = toNumber(
        options.max_forced_min_lot_position_pct,
        Math.max(strategyPositionCap, Math.min(6, Math.max(oneLotPositionPct, minTradeAmountPct)))
      );
      const requestedSamplingMinLotCapPct = toNumber(
        options.max_sampling_min_lot_position_pct,
        Math.max(
          Math.min(strategyPositionCap, 3),
          Math.min(3, Math.max(oneLotPositionPct, minTradeAmountPct))
        )
      );
      const forcedMinLotCapPct = Math.max(
        0.5,
        Math.min(
          Math.max(strategyPositionCap, oneLotPositionPct, minTradeAmountPct),
          requestedForcedMinLotCapPct
        )
      );
      const samplingMinLotCapPct = Math.max(
        0.5,
        Math.min(
          Math.max(Math.min(strategyPositionCap, 3), oneLotPositionPct, minTradeAmountPct),
          requestedSamplingMinLotCapPct
        )
      );
      let effectiveTargetPct = gatedSuggestedPct;
      let minLotSample = false;
      let minLotSampleReason = '';
      if (
        (forcedMinLotEnabled || samplingMinLotEnabled) &&
        gatedSuggestedPct > 0 &&
        oneLotCost <= availableCash * 0.98
      ) {
        const minExecutablePct = Math.max(oneLotPositionPct, minTradeAmountPct);
        const effectiveMinLotCapPct = forcedMinLotEnabled
          ? forcedMinLotCapPct
          : samplingMinLotCapPct;
        const canRespectPositionCap = minExecutablePct <= effectiveMinLotCapPct + 0.05;
        if (minExecutablePct > gatedSuggestedPct && canRespectPositionCap) {
          effectiveTargetPct = clamp(minExecutablePct, gatedSuggestedPct, effectiveMinLotCapPct);
          minLotSample = true;
          minLotSampleReason = `${
            forcedMinLotEnabled ? 'A股一手起买冷启动采样' : 'A股一手起买收益闭环补样'
          }：目标仓位由 ${roundNumber(
            gatedSuggestedPct,
            2
          )}% 提升至 ${roundNumber(effectiveTargetPct, 2)}%`;
        }
      }
      const tradeRisk = this.evaluateEntryRiskGuard({
        guard: entryRiskGuard,
        profile: await this.enrichEntryMarketProfileRisk(
          marketProfileWithPortfolioRisk,
          entryRiskGuard,
          effectiveTargetPct
        ),
        candidate_position_pct: effectiveTargetPct,
        strategy_keys: strategyKeysForBudget,
        strategy_allocation_pct: strategyAllocationPct,
      });
      if (!tradeRisk.allowed) {
        await skip(tradeRisk.reasons.join('；'));
        continue;
      }
      const entryRiskGuardDecision = this.buildEntryRiskGuardDecision({
        trade_risk: tradeRisk,
        guard: entryRiskGuard,
        profile: marketProfileWithPortfolioRisk,
        candidate_position_pct: effectiveTargetPct,
        strategy_allocation_pct: strategyAllocationPct,
        strategy_keys: strategyKeysForBudget,
      });
      if (gatedSuggestedPct <= 0) {
        await skip(
          `收益闸门仓位倍率为 ${profitGatePolicy.effective_position_multiplier}，不执行买入`
        );
        continue;
      }
      const targetAmount = Math.min(totalValue * (effectiveTargetPct / 100), availableCash * 0.98);
      if (targetAmount < min_trade_amount && !minLotSample) {
        await skip(`目标交易金额低于最小阈值 ${min_trade_amount}`);
        continue;
      }

      let quantity = Math.floor(targetAmount / execute_price / 100) * 100;
      let amount = roundNumber(execute_price * quantity, 2);
      let commission = roundNumber(amount * this.commissionRate, 2);
      let total_cost = roundNumber(amount + commission, 2);

      while (quantity >= 100 && total_cost > availableCash) {
        quantity -= 100;
        amount = roundNumber(execute_price * quantity, 2);
        commission = roundNumber(amount * this.commissionRate, 2);
        total_cost = roundNumber(amount + commission, 2);
      }

      if (quantity < 100) {
        await skip('可用资金不足以买入一手');
        continue;
      }

      const resampleMatch = asPlainObject(environmentPolicy.resample_match);
      const resampleSample = Object.keys(resampleMatch).length > 0;
      const budgetActionPolicyMatch = asPlainObject(environmentPolicy.budget_action_policy_match);
      const budgetPolicyVersion = asPlainObject(
        asPlainObject(options.external_environment_policy).budget_policy_version ||
          asPlainObject(options.external_environment_policy).budget_action_policy?.version ||
          asPlainObject(environmentPolicy).budget_policy_version
      );
      const budgetPolicyVersionGuard = asPlainObject(
        budgetPolicyVersion.underperformance_guard ||
          asPlainObject(environmentPolicy).budget_policy_version_guard ||
          asPlainObject(options.external_environment_policy).budget_policy_version_guard
      );
      const budgetPolicyRollbackPlan = asPlainObject(
        budgetPolicyVersion.rollback_plan ||
          asPlainObject(environmentPolicy).budget_policy_rollback_plan ||
          asPlainObject(options.external_environment_policy).budget_policy_version_rollback_plan
      );
      const resamplePositionMultiplier = toOptionalNumber(
        resampleMatch.resample_position_multiplier ?? resampleMatch.position_multiplier
      );
      const resampleReason =
        resampleMatch.resample_reason ||
        resampleMatch.resample_decision_reason ||
        resampleMatch.budget_action_reason ||
        resampleMatch.reason;
      const budgetAction =
        metadata.environment_strategy_budget_action ||
        resampleMatch.budget_action ||
        (resampleMatch.resample_policy_action === 'recover_small'
          ? 'increase'
          : resampleMatch.resample_policy_action === 'extend_cooldown'
          ? 'pause'
          : resampleSample
          ? 'observe'
          : metadata.environment_strategy_policy_action === 'extended_cooldown'
          ? 'reduce'
          : metadata.environment_strategy_policy_action === 'recovered'
          ? 'increase'
          : metadata.environment_strategy_policy_action === 'resample'
          ? 'observe'
          : undefined);
      const budgetMultiplier =
        toOptionalNumber(
          metadata.environment_strategy_budget_multiplier ??
            budgetActionPolicyMatch.position_multiplier ??
            resampleMatch.recommended_budget_multiplier ??
            resampleMatch.position_multiplier ??
            resampleMatch.resample_position_multiplier
        ) || undefined;
      const budgetPolicyReason =
        metadata.environment_strategy_budget_policy_reason || budgetActionPolicyMatch.reason;
      const strategyBudgetAction =
        metadata.strategy_budget_action ||
        strategyBudgetDiscipline.action_label ||
        strategyBudgetDiscipline.action ||
        strategyAllocationPolicy.action;
      const strategyBudgetReason = compactText(
        metadata.strategy_budget_reason ||
          strategyBudgetDiscipline.reason ||
          asPlainObject(strategyAllocationPolicy.decision).reason ||
          strategyAllocationPolicy.reason,
        140
      );
      const strategyBudgetConfidence = toOptionalNumber(
        metadata.strategy_budget_confidence ||
          strategyBudgetDiscipline.sample_confidence ||
          strategyBudgetDiscipline.confidence ||
          asPlainObject(strategyAllocationPolicy.decision).sample_confidence
      );
      const strategyBudgetLabel = compactText(
        metadata.strategy_budget_label ||
          strategyBudgetDiscipline.label ||
          [
            strategyAllocationPolicy.strategy_name || metadata.strategy_key,
            strategyAllocationPct ? `预算${roundNumber(strategyAllocationPct, 1)}%` : '',
            strategyMaxSingleTradePct ? `单票≤${roundNumber(strategyMaxSingleTradePct, 1)}%` : '',
            strategyBudgetAction ? `动作${strategyBudgetAction}` : '',
            strategyBudgetConfidence ? `置信${roundNumber(strategyBudgetConfidence, 0)}` : '',
          ]
            .filter(Boolean)
            .join('，'),
        120
      );
      const normalizedStrategyBudgetDiscipline = {
        ...strategyBudgetDiscipline,
        strategy_key: strategyBudgetDiscipline.strategy_key || metadata.strategy_key,
        strategy_keys: strategyBudgetDiscipline.strategy_keys || strategyKeysForBudget,
        action: strategyBudgetDiscipline.action || strategyBudgetAction,
        action_label: strategyBudgetDiscipline.action_label || strategyBudgetAction,
        allocation_pct: strategyBudgetDiscipline.allocation_pct || strategyAllocationPct,
        max_single_trade_pct:
          strategyBudgetDiscipline.max_single_trade_pct || strategyMaxSingleTradePct,
        sample_confidence: strategyBudgetDiscipline.sample_confidence || strategyBudgetConfidence,
        reason: strategyBudgetDiscipline.reason || strategyBudgetReason,
        label: strategyBudgetDiscipline.label || strategyBudgetLabel,
        policy: Object.keys(strategyAllocationPolicy).length
          ? strategyAllocationPolicy
          : strategyBudgetDiscipline.policy,
      };

      eligible++;
      const tradePayload: PaperTradingAutoTradeItem = {
        ...itemBase,
        status: dry_run ? 'planned' : 'executed',
        action,
        action_label: metadata.action_label,
        environment_multiplier: environmentPolicy.position_multiplier,
        environment_reason: environmentPolicy.reason,
        resample_sample: resampleSample || undefined,
        resample_combo_key: resampleMatch.key,
        resample_reason: resampleReason,
        resample_position_multiplier: resamplePositionMultiplier,
        environment_strategy_budget_action: budgetAction,
        environment_strategy_budget_multiplier: budgetMultiplier,
        environment_strategy_budget_reason:
          budgetPolicyReason ||
          metadata.environment_strategy_budget_reason ||
          resampleMatch.budget_action_reason,
        environment_strategy_budget_policy_action:
          metadata.environment_strategy_budget_policy_action || budgetActionPolicyMatch.action,
        environment_strategy_budget_policy_reason: budgetPolicyReason,
        environment_strategy_budget_policy_multiplier:
          toOptionalNumber(
            metadata.environment_strategy_budget_policy_multiplier ??
              budgetActionPolicyMatch.position_multiplier
          ) || undefined,
        environment_strategy_budget_policy_version_id:
          metadata.environment_strategy_budget_policy_version_id ||
          budgetPolicyVersion.version_id ||
          asPlainObject(options.external_environment_policy).budget_action_policy?.version_id,
        environment_strategy_budget_policy_version_hash:
          metadata.environment_strategy_budget_policy_version_hash ||
          budgetPolicyVersion.version_hash ||
          asPlainObject(options.external_environment_policy).budget_action_policy?.version_hash,
        budget_policy_version_snapshot_id:
          budgetPolicyVersion.snapshot_record_id ||
          asPlainObject(options.external_environment_policy).budget_policy_version_snapshot_id,
        environment_strategy_budget_policy_version_guard_action:
          metadata.environment_strategy_budget_policy_version_guard_action ||
          budgetPolicyVersionGuard.action,
        environment_strategy_budget_policy_version_guard_reason:
          metadata.environment_strategy_budget_policy_version_guard_reason ||
          budgetPolicyVersionGuard.reason,
        environment_strategy_budget_policy_version_guard_champion:
          metadata.environment_strategy_budget_policy_version_guard_champion ||
          budgetPolicyVersionGuard.champion_version_id,
        environment_strategy_budget_policy_rollback_action:
          metadata.environment_strategy_budget_policy_rollback_action ||
          budgetPolicyRollbackPlan.action,
        environment_strategy_budget_policy_rollback_source:
          metadata.environment_strategy_budget_policy_rollback_source ||
          budgetPolicyRollbackPlan.source_version_id,
        environment_strategy_budget_policy_rollback_snapshot_id: toOptionalNumber(
          metadata.environment_strategy_budget_policy_rollback_snapshot_id ??
            budgetPolicyRollbackPlan.source_snapshot_id
        ),
        environment_strategy_budget_policy_rollback_reason:
          metadata.environment_strategy_budget_policy_rollback_reason ||
          budgetPolicyRollbackPlan.reason,
        market_regime: environmentPolicy.market_regime,
        market_regime_label: environmentPolicy.market_regime_label,
        industry_regime: environmentPolicy.industry_regime,
        industry_label: environmentPolicy.industry_label,
        quantity,
        latest_price: quote.price,
        execute_price,
        amount,
        commission,
        total_cost,
        target_position_pct: roundNumber(effectiveTargetPct, 2),
        min_lot_sample: minLotSample || undefined,
        min_lot_sample_reason: minLotSampleReason || undefined,
        strategy_allocation_pct: strategyAllocationPct,
        strategy_allocation_amount: toOptionalNumber(
          metadata.strategy_allocation_amount ||
            strategyAllocationPolicy.capital_amount ||
            strategyBudgetDiscipline.capital_amount ||
            strategyVariant.strategy_allocation_amount
        ),
        strategy_max_single_trade_pct: strategyMaxSingleTradePct,
        strategy_max_single_trade_amount: toOptionalNumber(
          metadata.strategy_max_single_trade_amount ||
            strategyAllocationPolicy.max_single_trade_amount ||
            strategyBudgetDiscipline.max_single_trade_amount ||
            strategyVariant.strategy_max_single_trade_amount
        ),
        strategy_budget_action: strategyBudgetAction,
        strategy_budget_label: strategyBudgetLabel,
        strategy_budget_reason: strategyBudgetReason,
        strategy_budget_confidence: strategyBudgetConfidence,
        strategy_budget_discipline: normalizedStrategyBudgetDiscipline,
        entry_risk_guard_decision: entryRiskGuardDecision,
        execution_reality_decision: executionRealityDecision,
        stop_loss_pct: toOptionalNumber(metadata.stop_loss_pct),
        take_profit_pct: toOptionalNumber(metadata.take_profit_pct),
        reason: [
          strategyMaxSingleTradePct ? `策略预算：单票上限 ${strategyMaxSingleTradePct}%` : '',
          profitGatePolicy.enabled && profitGatePolicy.gate_label
            ? `收益闸门：${profitGatePolicy.gate_label}，倍率 ${profitGatePolicy.effective_position_multiplier}x`
            : '',
          outcomeFeedbackPolicy.enabled
            ? `交易收益闭环：样本 ${outcomeFeedbackPolicy.closed_samples}，仓位倍率 ${outcomeFeedbackPolicy.effective_position_multiplier}x`
            : '',
          dataQualityBucket && !['high', 'unknown'].includes(dataQualityBucket)
            ? `数据质量：${
                dataQualityScore || '--'
              }分/${dataQualityBucket}，仓位倍率 ${dataQualityPositionMultiplier}x`
            : '',
          lowQualityForcedSampleReason,
          environmentPolicy.enabled
            ? `环境风控：${environmentPolicy.reason}，倍率 ${environmentPolicy.position_multiplier}x`
            : '',
          minLotSampleReason,
        ]
          .filter(Boolean)
          .join('；'),
      };

      const orderIntentMetadata = {
        action,
        action_label: metadata.action_label,
        strategy_keys: strategyKeysForBudget,
        strategy_allocation_policy: strategyAllocationPolicy,
        strategy_budget_discipline: normalizedStrategyBudgetDiscipline,
        entry_risk_guard_decision: entryRiskGuardDecision,
        execution_reality_decision: executionRealityDecision,
        profit_gate: profitGatePolicy,
        outcome_feedback: outcomeFeedbackPolicy,
        environment_policy: environmentPolicy,
        entry_market_profile: marketProfileWithPortfolioRisk,
        loop_policy_snapshot_id:
          options.loop_policy_snapshot_id ?? metadata.loop_policy_snapshot_id,
        loop_run_id: signal.loop_run_id || metadata.loop_run_id,
        min_lot_sample: minLotSample || undefined,
        min_lot_sample_reason: minLotSampleReason || undefined,
        low_quality_forced_sample: allowLowQualityForcedSample || undefined,
        low_quality_forced_sample_reason: lowQualityForcedSampleReason || undefined,
      };

      if (!dry_run) {
        const trade = await this.createBuyTrade({
          portfolio,
          signal,
          symbol,
          name: signal.name || quote.name || symbol,
          latest_price: quote.price,
          execute_price,
          quantity,
          amount,
          commission,
          total_cost,
        });
        tradePayload.trade_id = trade.id;
        await this.markSignalExecuted(signal, {
          portfolio_id: portfolio.id,
          trade_id: trade.id,
          quantity,
          execute_price,
          amount,
          commission,
          total_cost,
          target_position_pct: tradePayload.target_position_pct,
          strategy_allocation_pct: tradePayload.strategy_allocation_pct,
          strategy_allocation_amount: tradePayload.strategy_allocation_amount,
          strategy_max_single_trade_pct: tradePayload.strategy_max_single_trade_pct,
          strategy_max_single_trade_amount: tradePayload.strategy_max_single_trade_amount,
          strategy_allocation_policy: strategyAllocationPolicy,
          strategy_budget_action: tradePayload.strategy_budget_action,
          strategy_budget_label: tradePayload.strategy_budget_label,
          strategy_budget_reason: tradePayload.strategy_budget_reason,
          strategy_budget_confidence: tradePayload.strategy_budget_confidence,
          strategy_budget_discipline: tradePayload.strategy_budget_discipline,
          entry_risk_guard_decision: tradePayload.entry_risk_guard_decision,
          execution_reality_decision: tradePayload.execution_reality_decision,
          min_lot_sample: minLotSample || undefined,
          min_lot_sample_reason: minLotSampleReason || undefined,
          stop_loss_pct: tradePayload.stop_loss_pct,
          take_profit_pct: tradePayload.take_profit_pct,
          strategy_key: metadata.strategy_key,
          strategy_variant: metadata.strategy_variant,
          strategy_bucket_label: metadata.strategy_bucket_label,
          loop_policy_snapshot_id:
            options.loop_policy_snapshot_id ?? metadata.loop_policy_snapshot_id,
          profit_gate: profitGatePolicy,
          outcome_feedback: outcomeFeedbackPolicy,
          environment_policy: environmentPolicy,
          resample_sample: resampleSample || undefined,
          resample_match: resampleSample ? resampleMatch : undefined,
          resample_combo_key: resampleMatch.key,
          resample_reason: resampleReason,
          resample_position_multiplier: resamplePositionMultiplier,
          environment_strategy_budget_action: budgetAction,
          environment_strategy_budget_multiplier: budgetMultiplier,
          environment_strategy_budget_reason:
            budgetPolicyReason ||
            metadata.environment_strategy_budget_reason ||
            resampleMatch.budget_action_reason,
          environment_strategy_budget_policy_action:
            metadata.environment_strategy_budget_policy_action || budgetActionPolicyMatch.action,
          environment_strategy_budget_policy_reason: budgetPolicyReason,
          environment_strategy_budget_policy_multiplier:
            toOptionalNumber(
              metadata.environment_strategy_budget_policy_multiplier ??
                budgetActionPolicyMatch.position_multiplier
            ) || undefined,
          environment_strategy_budget_policy_version_id:
            metadata.environment_strategy_budget_policy_version_id ||
            budgetPolicyVersion.version_id ||
            asPlainObject(options.external_environment_policy).budget_action_policy?.version_id,
          environment_strategy_budget_policy_version_hash:
            metadata.environment_strategy_budget_policy_version_hash ||
            budgetPolicyVersion.version_hash ||
            asPlainObject(options.external_environment_policy).budget_action_policy?.version_hash,
          budget_policy_version_snapshot_id:
            budgetPolicyVersion.snapshot_record_id ||
            asPlainObject(options.external_environment_policy).budget_policy_version_snapshot_id,
          environment_strategy_budget_policy_version_guard_action:
            metadata.environment_strategy_budget_policy_version_guard_action ||
            budgetPolicyVersionGuard.action,
          environment_strategy_budget_policy_version_guard_reason:
            metadata.environment_strategy_budget_policy_version_guard_reason ||
            budgetPolicyVersionGuard.reason,
          environment_strategy_budget_policy_version_guard_champion:
            metadata.environment_strategy_budget_policy_version_guard_champion ||
            budgetPolicyVersionGuard.champion_version_id,
          environment_strategy_budget_policy_rollback_action:
            metadata.environment_strategy_budget_policy_rollback_action ||
            budgetPolicyRollbackPlan.action,
          environment_strategy_budget_policy_rollback_source:
            metadata.environment_strategy_budget_policy_rollback_source ||
            budgetPolicyRollbackPlan.source_version_id,
          environment_strategy_budget_policy_rollback_snapshot_id: toOptionalNumber(
            metadata.environment_strategy_budget_policy_rollback_snapshot_id ??
              budgetPolicyRollbackPlan.source_snapshot_id
          ),
          environment_strategy_budget_policy_rollback_reason:
            metadata.environment_strategy_budget_policy_rollback_reason ||
            budgetPolicyRollbackPlan.reason,
          environment_strategy_capital_efficiency_score:
            metadata.environment_strategy_capital_efficiency_score ||
            budgetActionPolicyMatch.capital_efficiency_score ||
            resampleMatch.capital_efficiency_score,
          market_environment: environmentPolicy.market_environment || metadata.market_environment,
          entry_risk_guard: this.buildEntryRiskGuardPolicy(entryRiskGuard),
          entry_market_profile: marketProfileWithPortfolioRisk,
        });
        await recordBuyIntent('executed', tradePayload.reason || '自动跟单已模拟买入', {
          trade_id: trade.id,
          reference_price: quote.price,
          execute_price,
          quantity,
          amount,
          target_position_pct: tradePayload.target_position_pct,
          reason_category: 'executed',
          metadata: {
            ...orderIntentMetadata,
            trade_id: trade.id,
            total_cost,
            commission,
          },
        });
        await this.refreshRecommendationTradeOutcome(signal.id);
      } else {
        await recordBuyIntent('planned', tradePayload.reason || '自动跟单预演计划买入', {
          reference_price: quote.price,
          execute_price,
          quantity,
          amount,
          target_position_pct: tradePayload.target_position_pct,
          reason_category: 'planned',
          metadata: {
            ...orderIntentMetadata,
            total_cost,
            commission,
          },
        });
      }

      availableCash = roundNumber(availableCash - total_cost, 2);
      this.commitEntryRiskGuardTrade(entryRiskGuard, {
        profile: marketProfile,
        target_position_pct: tradePayload.target_position_pct || 0,
        amount,
        strategy_keys: strategyKeysForBudget,
      });
      trades.push(tradePayload);
    }

    const snapshot = dry_run ? preSnapshot : await this.syncLatestPricesAndSnapshot(portfolio.id);
    const riskProfile = await paperTradingRiskProfileService
      .getRiskProfile({
        user_id: portfolio.user_id,
        portfolio_name: portfolio.name,
        min_cash_reserve_pct: options.min_cash_reserve_pct,
        max_portfolio_drawdown_pct: options.max_portfolio_drawdown_pct,
        max_total_exposure_pct: options.max_total_exposure_pct,
        max_industry_exposure_pct: options.max_industry_exposure_pct,
        max_position_correlation: options.max_position_correlation,
        max_portfolio_var_pct: options.max_portfolio_var_pct,
        max_single_stock_volatility_pct: options.max_single_stock_volatility_pct,
      })
      .catch(error => {
        logger.warn(`生成模拟盘组合风险画像失败: ${error?.message || error}`);
        return null;
      });

    const result: PaperTradingAutoResult = {
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      dry_run,
      source_type,
      scanned: candidateSignals.length,
      eligible,
      executed: dry_run ? 0 : trades.length,
      planned: dry_run ? trades.length : 0,
      skipped: skipped_items.length,
      trades,
      skipped_items: skipped_items.slice(0, 30),
      snapshot,
      feedback_policy: feedbackPolicy,
      profit_gate_policy: profitGatePolicy,
      outcome_feedback_policy: outcomeFeedbackPolicy,
      entry_risk_guard_policy: this.buildEntryRiskGuardPolicy(entryRiskGuard),
      environment_guard_policy: this.buildEnvironmentGuardPolicy(),
      skip_reason_summary: summarizeSkippedItems(skipped_items),
      risk_profile: riskProfile,
      risk_profile_gate: riskProfileGate,
      strategy_filter_policy: strategyFilterKeys.length
        ? {
            strategy_family_key: options.strategy_family_key,
            strategy_keys: strategyFilterKeys,
            raw_scanned: signals.length,
            matched: candidateSignals.length,
            allow_watch_signals_for_sampling: allowWatchSignalsForSampling,
          }
        : undefined,
    };

    if (report_to_feishu) {
      await feishuTaskReportService.reportPaperTradingAutomation(result, {
        record_type: dry_run ? '模拟盘跟单预演' : '模拟盘自动跟单',
      });
    }

    return result;
  }

  async runAutoSync(options: PaperTradingAutoSyncOptions = {}): Promise<PaperTradingAutoResult> {
    const portfolio = await this.ensurePortfolio({
      user_id: options.user_id,
      username: options.username,
      name: options.portfolio_name,
      initial_capital: options.initial_capital,
      force_new: options.force_new_portfolio,
    });
    const refreshRecommendations = toBoolean(options.refresh_recommendations, false);
    let generated: any = null;
    let archive: any = null;

    if (refreshRecommendations) {
      const universe = options.universe === 'market' ? 'market' : 'favorites';
      const style = ['balanced', 'momentum', 'value', 'low_risk'].includes(options.style || '')
        ? options.style!
        : 'balanced';
      const candidateLimit = toPositiveInt(
        options.candidate_limit || options.limit,
        Math.max(toPositiveInt(options.limit, 5, 20), 10),
        50
      );

      generated = await quantRecommendationService.generateRecommendations({
        user_id: portfolio.user_id,
        universe,
        style,
        limit: candidateLimit,
        lookback_days: toPositiveInt(options.lookback_days, 120, 3650),
        candidate_pool_limit: toPositiveInt(
          options.candidate_pool_limit,
          universe === 'market'
            ? Math.max(candidateLimit * 12, 240)
            : Math.max(candidateLimit * 6, 60),
          1000
        ),
        exclude_st: true,
        min_market_cap_yi: 30,
        include_trend: true,
      });

      archive = await aiInvestmentSignalService.archiveQuantRecommendations({
        candidates: generated.recommendations || [],
        universe,
        style,
        as_of: generated.as_of,
      });

      if (toBoolean(options.verify_signals, false)) {
        archive.verification = await aiInvestmentSignalService.verifySignals({
          source_type: AISignalSourceType.QUANT_RECOMMENDATION,
          limit: Math.max(archive.total || 0, 20),
        });
      }
    }

    const result = await this.autoBuyFromSignals({
      ...options,
      user_id: portfolio.user_id,
      source_type: options.source_type || AISignalSourceType.QUANT_RECOMMENDATION,
    });

    const syncResult = {
      ...result,
      generated: generated
        ? {
            as_of: generated.as_of,
            universe: generated.universe,
            style: generated.style,
            total_candidates: generated.total_candidates,
            analyzed_candidates: generated.analyzed_candidates,
            recommendations: (generated.recommendations || []).slice(0, 10).map((item: any) => ({
              symbol: item.symbol,
              name: item.name,
              score: item.score,
              action: item.action,
              action_label: item.action_label,
              suggested_position_pct: item.suggested_position_pct,
              data_quality_score: item.data_quality_score,
              data_quality_bucket: item.data_quality_bucket,
            })),
          }
        : undefined,
      archive,
    };

    if (
      toBoolean(options.report_to_feishu, true) &&
      options.notify_to_feishu_bot !== false &&
      (refreshRecommendations || Array.isArray((syncResult as any).generated?.recommendations))
    ) {
      await feishuBotWebhookService.sendRecommendationSummary({
        scenario: 'paper_trading_auto_sync',
        record_type: result.dry_run ? '模拟盘荐股预演' : '模拟盘荐股同步',
        result: syncResult,
      });
    }

    return syncResult;
  }

  async runRiskCheck(
    options: PaperTradingRiskCheckOptions = {}
  ): Promise<PaperTradingRiskCheckResult> {
    const dry_run = toBoolean(options.dry_run, false);
    const report_to_feishu = toBoolean(options.report_to_feishu, true);
    const limit = toPositiveInt(options.limit, 20, 100);
    const enableStopLoss = toBoolean(options.enable_stop_loss, true);
    const enableTakeProfit = toBoolean(options.enable_take_profit, true);
    const enableTrailingTakeProfit = toBoolean(options.enable_trailing_take_profit, true);
    const enableSellSignals = toBoolean(options.enable_sell_signals, true);
    const defaultStopLossPct = Math.abs(toNumber(options.default_stop_loss_pct, 7));
    const defaultTakeProfitPct = Math.abs(toNumber(options.default_take_profit_pct, 14));
    const trailingActivationPct = Math.abs(toNumber(options.trailing_activation_pct, 8));
    const trailingDrawdownPct = Math.abs(toNumber(options.trailing_drawdown_pct, 4));
    const maxHoldDays = toNumber(options.max_hold_days, 0);
    const minSellSignalScore = toNumber(options.min_sell_signal_score, 60);
    const sellSignalSourceType = options.sell_signal_source_type || 'all';

    const portfolio = await this.ensurePortfolio({
      user_id: options.user_id,
      username: options.username,
      name: options.portfolio_name,
      initial_capital: options.initial_capital,
      force_new: options.force_new_portfolio,
    });
    await this.syncLatestPricesAndSnapshot(portfolio.id);
    await portfolio.reload();

    const adaptiveRiskPolicy = await this.resolveAdaptiveRiskPolicy({
      enabled: toBoolean(options.use_adaptive_risk_policy, true),
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      username: options.username,
      min_closed_samples: toPositiveInt(options.adaptive_risk_min_closed_samples, 5, 100),
      lookback_days: toPositiveInt(options.adaptive_risk_lookback_days, 180, 3650),
      override_signal_params: toBoolean(options.adaptive_risk_override_signal_params, false),
      requested_stop_loss_pct: defaultStopLossPct,
      requested_take_profit_pct: defaultTakeProfitPct,
      requested_trailing_activation_pct: trailingActivationPct,
      requested_trailing_drawdown_pct: trailingDrawdownPct,
      requested_max_hold_days: maxHoldDays,
    });

    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id: portfolio.id },
      order: [['created_at', 'ASC']],
    });

    const exits: PaperTradingRiskExitItem[] = [];
    const heldItems: PaperTradingRiskExitItem[] = [];
    const skippedItems: PaperTradingRiskExitItem[] = [];

    for (const position of positions) {
      const symbol = normalizeSymbol(position.symbol);
      const quantity = Math.floor(toNumber(position.quantity, 0));
      const avgCost = toNumber(position.avg_cost, 0);
      const sourceSignal = await this.findExecutionSignalForPosition(portfolio.id, symbol);
      const signalMeta = asPlainObject(sourceSignal?.metadata);
      const paperTradingMeta = paperTradingMetaForPortfolio(signalMeta, portfolio.id);
      const entryDate = paperTradingMeta.executed_at || position.created_at;
      const holdingDays = Math.max(0, moment().tz('Asia/Shanghai').diff(moment(entryDate), 'days'));
      const useAdaptiveDefaults =
        adaptiveRiskPolicy.applied && adaptiveRiskPolicy.override_signal_params;
      const stopLossPct = Math.abs(
        toNumber(
          useAdaptiveDefaults
            ? adaptiveRiskPolicy.effective_stop_loss_pct
            : paperTradingMeta.stop_loss_pct ?? signalMeta.stop_loss_pct,
          adaptiveRiskPolicy.effective_stop_loss_pct
        )
      );
      const takeProfitPct = Math.abs(
        toNumber(
          useAdaptiveDefaults
            ? adaptiveRiskPolicy.effective_take_profit_pct
            : paperTradingMeta.take_profit_pct ?? signalMeta.take_profit_pct,
          adaptiveRiskPolicy.effective_take_profit_pct
        )
      );
      const positionTrailingActivationPct = adaptiveRiskPolicy.effective_trailing_activation_pct;
      const positionTrailingDrawdownPct = adaptiveRiskPolicy.effective_trailing_drawdown_pct;
      const quote = await this.getLatestPrice(symbol, toNumber(position.current_price, 0));
      const latestPrice = quote.price || toNumber(position.current_price, 0);
      const marketProfile = await this.getEntryMarketProfile(symbol, {
        cooldown_days_after_loss: 0,
      });
      const executionRealityDecision = this.evaluateExecutionReality({
        side: 'SELL',
        profile: marketProfile,
        quote,
        min_avg_turnover_yuan: 0,
        block_limit_up: false,
        block_limit_down: true,
        block_suspended: true,
        block_st: false,
      });
      const pnlPct = avgCost > 0 ? roundNumber(((latestPrice - avgCost) / avgCost) * 100, 4) : 0;
      const trailingStats = await this.computePositionPeakProfit({
        symbol,
        entry_date: entryDate,
        entry_price: avgCost,
        latest_price: latestPrice,
        trailing_drawdown_pct: positionTrailingDrawdownPct,
      });

      const baseItem: PaperTradingRiskExitItem = {
        status: 'held',
        symbol,
        name: position.name || quote.name || symbol,
        quantity,
        avg_cost: avgCost,
        latest_price: latestPrice,
        pnl_pct: pnlPct,
        holding_days: holdingDays,
        stop_loss_pct: stopLossPct,
        take_profit_pct: takeProfitPct,
        trailing_activation_pct: positionTrailingActivationPct,
        trailing_drawdown_pct: positionTrailingDrawdownPct,
        max_profit_pct: trailingStats.max_profit_pct,
        drawdown_from_peak_pct: trailingStats.drawdown_from_peak_pct,
        peak_price: trailingStats.peak_price,
        trailing_stop_price:
          enableTrailingTakeProfit && trailingStats.max_profit_pct >= positionTrailingActivationPct
            ? trailingStats.trailing_stop_price
            : undefined,
        source_signal_id: sourceSignal?.id,
        execution_reality_decision: executionRealityDecision,
      };
      let exitReason: RiskExitReason | undefined;
      let sellSignal: AIInvestmentSignal | null = null;

      const recordSellIntent = async (
        status: OrderIntentStatus,
        reason_text?: string,
        extra: Partial<RecordOrderIntentParams> = {}
      ) => {
        const baseMetadata = {
          source_signal_id: sourceSignal?.id,
          sell_signal_id: sellSignal?.id,
          exit_reason: exitReason,
          exit_reason_label: exitReason ? riskReasonLabel(exitReason) : undefined,
          pnl_pct: pnlPct,
          holding_days: holdingDays,
          adaptive_risk_policy: adaptiveRiskPolicy,
          execution_reality_decision: executionRealityDecision,
        };
        return this.recordOrderIntent({
          portfolio_id: portfolio.id,
          signal: sourceSignal,
          side: 'SELL',
          status,
          symbol,
          name: position.name || quote.name || symbol,
          reference_price: latestPrice,
          quantity,
          score: toOptionalNumber(sellSignal?.confidence_score ?? sourceSignal?.confidence_score),
          risk_level: sourceSignal?.risk_level,
          reason_text,
          reason_category:
            extra.reason_category ||
            (reason_text ? normalizeSkipReasonCategory(reason_text) : undefined),
          metadata: {
            ...baseMetadata,
            ...(extra.metadata || {}),
          },
          ...extra,
        });
      };

      const skip = async (message: string) => {
        skippedItems.push({ ...baseItem, status: 'skipped', message });
        await recordSellIntent('rejected', message);
      };

      if (exits.length >= limit) {
        break;
      }

      if (!quantity || quantity <= 0) {
        await skip('持仓数量无效，跳过');
        continue;
      }

      if (!latestPrice || latestPrice <= 0 || !avgCost || avgCost <= 0) {
        await skip('无法获取有效价格或成本，跳过');
        continue;
      }

      if (enableStopLoss && stopLossPct > 0 && pnlPct <= -stopLossPct) {
        exitReason = 'stop_loss';
      } else if (enableTakeProfit && takeProfitPct > 0 && pnlPct >= takeProfitPct) {
        exitReason = 'take_profit';
      } else if (
        enableTrailingTakeProfit &&
        positionTrailingActivationPct > 0 &&
        positionTrailingDrawdownPct > 0 &&
        trailingStats.max_profit_pct >= positionTrailingActivationPct &&
        Math.abs(Math.min(trailingStats.drawdown_from_peak_pct, 0)) >= positionTrailingDrawdownPct
      ) {
        exitReason = 'trailing_take_profit';
      } else if (enableSellSignals) {
        sellSignal = await this.findLatestSellSignal({
          symbol,
          since_date: dateOnly(entryDate),
          min_score: minSellSignalScore,
          source_type: sellSignalSourceType,
        });
        if (sellSignal) {
          exitReason = 'sell_signal';
        }
      }

      if (
        !exitReason &&
        adaptiveRiskPolicy.effective_max_hold_days > 0 &&
        holdingDays >= adaptiveRiskPolicy.effective_max_hold_days
      ) {
        exitReason = 'max_hold_days';
      }

      if (!exitReason) {
        const holdMessage = this.buildRiskHoldMessage({
          pnl_pct: pnlPct,
          stop_loss_pct: stopLossPct,
          take_profit_pct: takeProfitPct,
          enable_trailing_take_profit: enableTrailingTakeProfit,
          trailing_activation_pct: positionTrailingActivationPct,
          trailing_drawdown_pct: positionTrailingDrawdownPct,
          max_profit_pct: trailingStats.max_profit_pct,
          drawdown_from_peak_pct: trailingStats.drawdown_from_peak_pct,
        });
        heldItems.push({
          ...baseItem,
          status: 'held',
          message: holdMessage,
        });
        if (heldItems.length <= 10) {
          await recordSellIntent('held', holdMessage, {
            reason_category: 'risk_hold',
            metadata: { max_profit_pct: trailingStats.max_profit_pct },
          });
        }
        continue;
      }

      if (!executionRealityDecision.allowed) {
        await skip(executionRealityDecision.reasons.join('；'));
        continue;
      }

      const execute_price = roundNumber(latestPrice * (1 - this.slippageRate), 3);
      const amount = roundNumber(execute_price * quantity, 2);
      const commission = roundNumber(amount * this.commissionRate, 2);
      const net_revenue = roundNumber(amount - commission, 2);
      const realized_pnl = roundNumber(amount - avgCost * quantity - commission, 2);

      const exitItem: PaperTradingRiskExitItem = {
        ...baseItem,
        status: dry_run ? 'planned' : 'exited',
        reason: exitReason,
        reason_label: riskReasonLabel(exitReason),
        execute_price,
        amount,
        commission,
        net_revenue,
        realized_pnl,
        sell_signal_id: sellSignal?.id,
        sell_signal_date: sellSignal?.signal_date,
        sell_signal_score: toOptionalNumber(sellSignal?.confidence_score),
        execution_reality_decision: executionRealityDecision,
      };

      if (!dry_run) {
        const trade = await this.createSellTrade({
          portfolio,
          position,
          symbol,
          name: exitItem.name || symbol,
          execute_price,
          quantity,
          amount,
          commission,
          net_revenue,
          realized_pnl,
        });
        exitItem.trade_id = trade.id;
        await recordSellIntent('executed', riskReasonLabel(exitReason), {
          trade_id: trade.id,
          execute_price,
          quantity,
          amount,
          reason_category: 'executed',
          metadata: {
            net_revenue,
            realized_pnl,
            sell_signal_id: sellSignal?.id,
            sell_signal_date: sellSignal?.signal_date,
            sell_signal_score: toOptionalNumber(sellSignal?.confidence_score),
          },
        });

        if (sourceSignal) {
          await this.markSignalClosed(sourceSignal, {
            portfolio_id: portfolio.id,
            sell_trade_id: trade.id,
            sell_signal_id: sellSignal?.id,
            exit_reason: exitReason,
            exit_reason_label: riskReasonLabel(exitReason),
            exit_price: execute_price,
            exit_quantity: quantity,
            exit_amount: amount,
            exit_commission: commission,
            realized_pnl,
            realized_pnl_pct: pnlPct,
            holding_days: holdingDays,
            max_profit_pct: trailingStats.max_profit_pct,
            drawdown_from_peak_pct: trailingStats.drawdown_from_peak_pct,
            peak_price: trailingStats.peak_price,
            trailing_stop_price:
              exitReason === 'trailing_take_profit' ? trailingStats.trailing_stop_price : undefined,
            trailing_activation_pct: positionTrailingActivationPct,
            trailing_drawdown_pct: positionTrailingDrawdownPct,
            adaptive_risk_policy: adaptiveRiskPolicy,
            execution_reality_decision: executionRealityDecision,
          });
          await this.refreshRecommendationTradeOutcome(sourceSignal.id);
        }
      } else {
        await recordSellIntent('planned', riskReasonLabel(exitReason), {
          execute_price,
          quantity,
          amount,
          reason_category: 'planned',
          metadata: {
            net_revenue,
            realized_pnl,
            sell_signal_id: sellSignal?.id,
            sell_signal_date: sellSignal?.signal_date,
            sell_signal_score: toOptionalNumber(sellSignal?.confidence_score),
          },
        });
      }

      exits.push(exitItem);
    }

    const snapshot = dry_run
      ? await this.syncLatestPricesAndSnapshot(portfolio.id)
      : await this.syncLatestPricesAndSnapshot(portfolio.id);
    const riskProfile = await paperTradingRiskProfileService
      .getRiskProfile({
        user_id: portfolio.user_id,
        portfolio_name: portfolio.name,
      })
      .catch(error => {
        logger.warn(`生成模拟盘风控后组合风险画像失败: ${error?.message || error}`);
        return null;
      });

    const result: PaperTradingRiskCheckResult = {
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      dry_run,
      checked: positions.length,
      exit_candidates: exits.length,
      exited: dry_run ? 0 : exits.length,
      planned: dry_run ? exits.length : 0,
      held: heldItems.length,
      skipped: skippedItems.length,
      exits,
      held_items: heldItems.slice(0, 30),
      skipped_items: skippedItems.slice(0, 30),
      adaptive_risk_policy: adaptiveRiskPolicy,
      snapshot,
      risk_profile: riskProfile,
    };

    if (report_to_feishu) {
      await feishuTaskReportService.reportPaperTradingRiskCheck(result, {
        record_type: dry_run ? '模拟盘风控预演' : '模拟盘风控退出',
      });

      if (options.notify_to_feishu_bot !== false) {
        await feishuBotWebhookService.sendRecommendationSummary({
          scenario: 'paper_trading_risk_check',
          record_type: dry_run ? '模拟盘风控预演' : '模拟盘风控退出',
          result,
        });
      }
    }

    return result;
  }

  private async resolveUser(user_id?: number, username?: string): Promise<User> {
    if (user_id) {
      const user = await User.findByPk(user_id);
      if (user) return user;
    }

    const preferredUsername = username || process.env.PAPER_TRADING_DEFAULT_USERNAME || 'lym';
    let user = await User.findOne({ where: { username: preferredUsername } });
    if (!user && preferredUsername !== 'lym') {
      user = await User.findOne({ where: { username: 'lym' } });
    }
    if (!user) {
      user = await User.findOne({
        where: { role: 'admin', is_active: true },
        order: [['id', 'ASC']],
      });
    }
    if (!user) {
      user = await User.findOne({ where: { is_active: true }, order: [['id', 'ASC']] });
    }
    if (!user) {
      throw new Error('未找到可用于模拟盘跟单的用户');
    }

    return user;
  }

  private async recordOrderIntent(params: RecordOrderIntentParams): Promise<void> {
    try {
      const symbol = normalizeSymbol(params.symbol);
      if (!symbol) return;

      const signal = params.signal || null;
      const metadata = asPlainObject(params.metadata);
      await PaperTradingOrderIntent.create({
        portfolio_id: params.portfolio_id,
        signal_id: signal?.id,
        trade_id: params.trade_id,
        source_type: params.source_type || signal?.source_type || 'paper_trading',
        source_id: params.source_id || signal?.source_id || metadata.source_id,
        symbol,
        name: params.name || signal?.name || symbol,
        side: params.side,
        status: params.status,
        intent_date: params.intent_date || getChinaToday(),
        reference_price: toOptionalNumber(params.reference_price),
        execute_price: toOptionalNumber(params.execute_price),
        quantity: params.quantity,
        amount: toOptionalNumber(params.amount),
        target_position_pct: toOptionalNumber(params.target_position_pct),
        score: toOptionalNumber(params.score ?? signal?.confidence_score),
        risk_level: params.risk_level || signal?.risk_level,
        reason_category: params.reason_category || normalizeSkipReasonCategory(params.reason_text),
        reason_text: compactText(params.reason_text, 800),
        metadata: {
          ...metadata,
          recorded_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
        },
      });
    } catch (error: any) {
      logger.warn(`记录模拟交易订单意图失败: ${error?.message || error}`);
    }
  }

  private async getLatestPrice(
    symbol: string,
    fallbackPrice = 0
  ): Promise<{
    price: number;
    name?: string;
    date?: string;
    source?: string;
    quote_time?: string;
  }> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const stock = await Stock.findOne({ where: { symbol: normalizedSymbol } });
    if (!stock) {
      return { price: roundNumber(fallbackPrice, 4), name: normalizedSymbol, source: 'fallback' };
    }

    const latestRealtime = await RealtimeQuote.findOne({
      where: { symbol: normalizedSymbol },
      order: [['quote_time', 'DESC']],
    }).catch(() => null);
    if (latestRealtime?.current_price && toNumber(latestRealtime.current_price, 0) > 0) {
      return {
        price: roundNumber(toNumber(latestRealtime.current_price, fallbackPrice), 4),
        name: latestRealtime.name || stock.name,
        date:
          latestRealtime.trade_date ||
          (latestRealtime.quote_time
            ? moment(latestRealtime.quote_time).tz('Asia/Shanghai').format('YYYY-MM-DD')
            : ''),
        source: latestRealtime.source || 'realtime_quote',
        quote_time: latestRealtime.quote_time?.toISOString(),
      };
    }

    const latestBar = await DailyBar.findOne({
      where: { stock_id: stock.id },
      order: [['time', 'DESC']],
    });

    const price = toNumber(latestBar?.close, toNumber(stock.price, fallbackPrice));
    return {
      price: roundNumber(price, 4),
      name: stock.name,
      date: latestBar?.time ? moment(latestBar.time).tz('Asia/Shanghai').format('YYYY-MM-DD') : '',
      source: latestBar ? 'daily_bar' : 'stock_snapshot',
    };
  }

  private async computePositionPeakProfit(params: {
    symbol: string;
    entry_date: string | Date;
    entry_price: number;
    latest_price: number;
    trailing_drawdown_pct: number;
  }): Promise<{
    max_profit_pct: number;
    drawdown_from_peak_pct: number;
    peak_price: number;
    trailing_stop_price: number;
  }> {
    const normalizedSymbol = normalizeSymbol(params.symbol);
    const entryPrice = toNumber(params.entry_price, 0);
    const latestPrice = toNumber(params.latest_price, 0);
    const trailingDrawdownPct = Math.max(0, toNumber(params.trailing_drawdown_pct, 0));
    let peakPrice = Math.max(entryPrice, latestPrice, 0);

    try {
      const stock = await Stock.findOne({ where: { symbol: normalizedSymbol } });
      if (stock?.id) {
        const entryStart = moment(params.entry_date).isValid()
          ? moment(params.entry_date).tz('Asia/Shanghai').startOf('day').toDate()
          : moment().tz('Asia/Shanghai').startOf('day').toDate();
        const bars = await DailyBar.findAll({
          where: {
            stock_id: stock.id,
            time: { [Op.gte]: entryStart },
          },
          attributes: ['high', 'close', 'time'],
          order: [['time', 'ASC']],
          raw: true,
        });

        for (const bar of bars as any[]) {
          peakPrice = Math.max(peakPrice, toNumber(bar.high, 0), toNumber(bar.close, 0));
        }
      }
    } catch (error) {
      logger.warn(`计算 ${normalizedSymbol} 持仓峰值收益失败，使用最新价兜底:`, error);
    }

    const max_profit_pct =
      entryPrice > 0 ? roundNumber(((peakPrice - entryPrice) / entryPrice) * 100, 4) : 0;
    const drawdown_from_peak_pct =
      peakPrice > 0 ? roundNumber(((latestPrice - peakPrice) / peakPrice) * 100, 4) : 0;

    return {
      max_profit_pct,
      drawdown_from_peak_pct,
      peak_price: roundNumber(peakPrice, 4),
      trailing_stop_price: roundNumber(peakPrice * (1 - trailingDrawdownPct / 100), 4),
    };
  }

  private buildRiskHoldMessage(params: {
    pnl_pct: number;
    stop_loss_pct: number;
    take_profit_pct: number;
    enable_trailing_take_profit: boolean;
    trailing_activation_pct: number;
    trailing_drawdown_pct: number;
    max_profit_pct: number;
    drawdown_from_peak_pct: number;
  }): string {
    const messages: string[] = [];
    const pnlPct = toNumber(params.pnl_pct, 0);
    const stopLossPct = Math.max(0, toNumber(params.stop_loss_pct, 0));
    const takeProfitPct = Math.max(0, toNumber(params.take_profit_pct, 0));
    const maxProfitPct = Math.max(0, toNumber(params.max_profit_pct, 0));
    const currentDrawdownPct = Math.abs(Math.min(toNumber(params.drawdown_from_peak_pct, 0), 0));

    if (pnlPct < 0 && stopLossPct > 0) {
      messages.push(`距止损线 ${roundNumber(Math.max(stopLossPct + pnlPct, 0), 2)}pct`);
    } else if (takeProfitPct > 0) {
      messages.push(`距固定止盈 ${roundNumber(Math.max(takeProfitPct - pnlPct, 0), 2)}pct`);
    }

    if (params.enable_trailing_take_profit && params.trailing_activation_pct > 0) {
      if (maxProfitPct >= params.trailing_activation_pct) {
        messages.push(
          `移动止盈已激活：峰值收益 ${roundNumber(maxProfitPct, 2)}%，当前回撤 ${roundNumber(
            currentDrawdownPct,
            2
          )}%，距触发 ${roundNumber(
            Math.max(params.trailing_drawdown_pct - currentDrawdownPct, 0),
            2
          )}pct`
        );
      } else {
        messages.push(
          `距移动止盈激活 ${roundNumber(
            Math.max(params.trailing_activation_pct - maxProfitPct, 0),
            2
          )}pct`
        );
      }
    }

    return messages.join('；') || '未触发退出纪律';
  }

  private async findExecutionSignalForPosition(
    portfolio_id: number,
    symbol: string
  ): Promise<AIInvestmentSignal | null> {
    const signals = await AIInvestmentSignal.findAll({
      where: { symbol },
      order: [
        ['updated_at', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit: 200,
    });

    const matched = signals.find(signal => {
      const signalMetadata = asPlainObject(signal.metadata);
      const paperTrading = paperTradingMetaForPortfolio(signalMetadata, portfolio_id);
      return (
        Number(paperTrading.portfolio_id) === Number(portfolio_id) &&
        ['executed', 'closing', 'closed'].includes(String(paperTrading.status || ''))
      );
    });
    if (matched) return matched;

    const outcome = await RecommendationTradeOutcome.findOne({
      where: {
        portfolio_id,
        symbol,
        trade_status: { [Op.in]: ['open', 'closing'] },
      },
      order: [['updated_at', 'DESC']],
    }).catch(() => null);
    return outcome?.signal_id ? AIInvestmentSignal.findByPk(outcome.signal_id) : null;
  }

  private async findLatestSellSignal(options: {
    symbol: string;
    since_date: string;
    min_score: number;
    source_type: string;
  }): Promise<AIInvestmentSignal | null> {
    const where: any = {
      symbol: options.symbol,
      signal_date: { [Op.gte]: options.since_date },
      normalized_decision: {
        [Op.in]: [AISignalDecision.SELL, AISignalDecision.STRONG_SELL],
      },
      confidence_score: { [Op.gte]: options.min_score },
    };
    if (options.source_type && options.source_type !== 'all') {
      where.source_type = options.source_type;
    }

    return AIInvestmentSignal.findOne({
      where,
      order: [
        ['signal_date', 'DESC'],
        ['confidence_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
    });
  }

  private async resolveAdaptiveRiskPolicy(options: {
    enabled: boolean;
    portfolio_id: number;
    user_id: number;
    username?: string;
    min_closed_samples: number;
    lookback_days: number;
    override_signal_params: boolean;
    requested_stop_loss_pct: number;
    requested_take_profit_pct: number;
    requested_trailing_activation_pct: number;
    requested_trailing_drawdown_pct: number;
    requested_max_hold_days: number;
  }): Promise<PaperTradingAdaptiveRiskPolicy> {
    const basePolicy: PaperTradingAdaptiveRiskPolicy = {
      enabled: options.enabled,
      applied: false,
      closed_samples: 0,
      min_closed_samples: options.min_closed_samples,
      lookback_days: options.lookback_days,
      confidence: 0,
      reason: options.enabled ? '收益闭环样本不足，沿用默认风控参数' : '自适应风控未启用',
      requested_stop_loss_pct: roundNumber(options.requested_stop_loss_pct, 2),
      requested_take_profit_pct: roundNumber(options.requested_take_profit_pct, 2),
      requested_trailing_activation_pct: roundNumber(options.requested_trailing_activation_pct, 2),
      requested_trailing_drawdown_pct: roundNumber(options.requested_trailing_drawdown_pct, 2),
      requested_max_hold_days: Math.max(
        0,
        Math.floor(toNumber(options.requested_max_hold_days, 0))
      ),
      effective_stop_loss_pct: roundNumber(options.requested_stop_loss_pct, 2),
      effective_take_profit_pct: roundNumber(options.requested_take_profit_pct, 2),
      effective_trailing_activation_pct: roundNumber(options.requested_trailing_activation_pct, 2),
      effective_trailing_drawdown_pct: roundNumber(options.requested_trailing_drawdown_pct, 2),
      effective_max_hold_days: Math.max(
        0,
        Math.floor(toNumber(options.requested_max_hold_days, 0))
      ),
      override_signal_params: options.override_signal_params,
      notes: [],
    };

    if (!options.enabled) return basePolicy;

    try {
      const { recommendationTradeOutcomeService } = await import(
        './RecommendationTradeOutcomeService'
      );
      const dashboard = await recommendationTradeOutcomeService.getDashboard({
        portfolio_id: options.portfolio_id,
        user_id: options.user_id,
        username: options.username,
        include_open: false,
        trade_status: 'closed',
        lookback_days: options.lookback_days,
        limit: 2000,
        report_to_feishu: false,
      });
      const summary: any = dashboard.summary || {};
      const closedSamples = Number(summary.closed_count || 0);
      const avgMfe = Math.max(0, toNumber(summary.avg_mfe_pct, 0));
      const avgMaeAbs = Math.abs(Math.min(toNumber(summary.avg_mae_pct, 0), 0));
      const avgReturn = toNumber(summary.avg_closed_return_pct, 0);
      const avgExcess = toNumber(summary.avg_excess_return_pct, 0);
      const winRate = toNumber(summary.win_rate, 0);
      const excessWinRate = toNumber(summary.excess_win_rate, 0);
      const profitFactor = toNumber(summary.profit_factor, 0);
      const avgHoldingDays = toNumber(summary.avg_holding_days, 0);

      const nextPolicy = { ...basePolicy };
      nextPolicy.closed_samples = closedSamples;
      nextPolicy.avg_mfe_pct = roundNumber(avgMfe, 4);
      nextPolicy.avg_mae_pct = roundNumber(toNumber(summary.avg_mae_pct, 0), 4);
      nextPolicy.avg_closed_return_pct = roundNumber(avgReturn, 4);
      nextPolicy.avg_excess_return_pct = roundNumber(avgExcess, 4);
      nextPolicy.win_rate = roundNumber(winRate, 2);
      nextPolicy.excess_win_rate = roundNumber(excessWinRate, 2);
      nextPolicy.profit_factor = roundNumber(profitFactor, 4);
      nextPolicy.avg_holding_days = roundNumber(avgHoldingDays, 2);
      nextPolicy.confidence = roundNumber(
        clamp(closedSamples / Math.max(options.min_closed_samples, 1), 0, 1),
        2
      );

      if (closedSamples < options.min_closed_samples) {
        nextPolicy.reason = `闭环样本 ${closedSamples}/${options.min_closed_samples}，暂不自动改风控阈值`;
        nextPolicy.notes = ['继续积累卖出样本后再调整止损/止盈参数，避免过拟合。'];
        return nextPolicy;
      }

      const weakOutcome = avgReturn < 0 || avgExcess < -1 || winRate < 45 || profitFactor < 0.9;
      const strongOutcome =
        avgReturn > 2 && avgExcess > 0.8 && winRate >= 55 && profitFactor >= 1.2;
      const requestedStop = Math.max(1, options.requested_stop_loss_pct || 7);
      const requestedTake = Math.max(1, options.requested_take_profit_pct || 14);
      const requestedTrailActivation = Math.max(1, options.requested_trailing_activation_pct || 8);
      const requestedTrailDrawdown = Math.max(1, options.requested_trailing_drawdown_pct || 4);
      const requestedMaxHold = Math.max(
        0,
        Math.floor(toNumber(options.requested_max_hold_days, 20))
      );

      const maeBasedStop = avgMaeAbs > 0 ? avgMaeAbs * (weakOutcome ? 0.85 : 1.1) : requestedStop;
      let effectiveStop = clamp((requestedStop + maeBasedStop) / 2, 4, 10);
      let effectiveTake = requestedTake;
      let effectiveTrailActivation = requestedTrailActivation;
      let effectiveTrailDrawdown = requestedTrailDrawdown;
      let effectiveMaxHold = requestedMaxHold > 0 ? requestedMaxHold : 0;
      const notes: string[] = [];

      if (avgMfe > 0) {
        effectiveTake = clamp(avgMfe * (weakOutcome ? 0.72 : strongOutcome ? 0.9 : 0.82), 9, 22);
        effectiveTrailActivation = clamp(
          avgMfe * (weakOutcome ? 0.48 : strongOutcome ? 0.62 : 0.55),
          5,
          14
        );
      }
      if (avgMaeAbs > 0) {
        effectiveTrailDrawdown = clamp(
          avgMaeAbs * (weakOutcome ? 0.55 : strongOutcome ? 0.75 : 0.65),
          2.5,
          7
        );
      }
      if (avgHoldingDays > 0 && requestedMaxHold > 0) {
        effectiveMaxHold = Math.max(
          5,
          Math.min(
            30,
            Math.round(avgHoldingDays * (weakOutcome ? 0.9 : strongOutcome ? 1.25 : 1.05))
          )
        );
      }

      if (weakOutcome) {
        effectiveStop = Math.min(effectiveStop, requestedStop);
        effectiveTake = Math.min(effectiveTake, requestedTake);
        effectiveTrailActivation = Math.min(effectiveTrailActivation, requestedTrailActivation);
        notes.push('历史闭环偏弱：收紧止损/止盈，优先保护本金和减少持仓拖延。');
      } else if (strongOutcome) {
        effectiveStop = Math.max(effectiveStop, Math.min(requestedStop + 1, 10));
        effectiveTake = Math.max(effectiveTake, requestedTake);
        notes.push('历史闭环偏强：允许略宽波动并提高止盈目标，让强势样本多跑一段。');
      } else {
        notes.push('历史闭环中性：按 MFE/MAE 对默认风控参数做小幅校准。');
      }

      nextPolicy.applied = true;
      nextPolicy.effective_stop_loss_pct = roundNumber(effectiveStop, 2);
      nextPolicy.effective_take_profit_pct = roundNumber(effectiveTake, 2);
      nextPolicy.effective_trailing_activation_pct = roundNumber(effectiveTrailActivation, 2);
      nextPolicy.effective_trailing_drawdown_pct = roundNumber(effectiveTrailDrawdown, 2);
      nextPolicy.effective_max_hold_days = effectiveMaxHold;
      nextPolicy.reason = `闭环样本 ${closedSamples}，胜率 ${roundNumber(
        winRate,
        2
      )}%，平均收益 ${roundNumber(avgReturn, 2)}%，已启用自适应风控`;
      nextPolicy.notes = notes;
      return nextPolicy;
    } catch (error: any) {
      logger.warn(`读取收益闭环自适应风控失败，沿用默认风控参数: ${error?.message || error}`);
      return {
        ...basePolicy,
        enabled: true,
        reason: `自适应风控读取失败，沿用默认参数：${error?.message || error}`,
      };
    }
  }

  private async resolveAttributionFeedbackPolicy(options: {
    portfolio_id: number;
    user_id: number;
    portfolio_name?: string;
    initial_capital?: number;
    force_new_portfolio?: boolean;
    enabled: boolean;
    requested_min_score: number;
    requested_allowed_risk_levels: string[];
  }): Promise<NonNullable<PaperTradingAutoResult['feedback_policy']>> {
    const fallbackLevels = (
      options.requested_allowed_risk_levels?.length
        ? options.requested_allowed_risk_levels
        : ['low', 'medium']
    )
      .map(normalizeRiskLevel)
      .filter(Boolean);
    const basePolicy = {
      enabled: options.enabled,
      closed_samples: 0,
      effective_min_score: options.requested_min_score,
      effective_allowed_risk_levels: fallbackLevels,
    };

    if (!options.enabled) {
      return basePolicy;
    }

    try {
      const { paperTradingAttributionService } = await import('./PaperTradingAttributionService');
      const attribution = await paperTradingAttributionService.getAttribution({
        user_id: options.user_id,
        portfolio_id: options.portfolio_id,
        portfolio_name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        include_open: false,
        report_to_feishu: false,
      });
      const feedback: any = attribution.feedback || {};
      const closedSamples = attribution.summary?.closed_count || 0;

      if (closedSamples < 3) {
        return {
          ...basePolicy,
          closed_samples: closedSamples,
          recommended_min_score: feedback.recommended_min_score,
          recommended_allowed_risk_levels: feedback.recommended_allowed_risk_levels,
          preferred_source_type: feedback.preferred_source_type,
          preferred_action: feedback.preferred_action,
          strongest_bucket: feedback.strongest_bucket,
        };
      }

      const recommendedMinScore = toNumber(
        feedback.recommended_min_score,
        options.requested_min_score
      );
      const effectiveMinScore = clamp(
        Math.max(options.requested_min_score, recommendedMinScore),
        55,
        92
      );
      const recommendedLevels = Array.isArray(feedback.recommended_allowed_risk_levels)
        ? feedback.recommended_allowed_risk_levels.map(normalizeRiskLevel).filter(Boolean)
        : [];
      const requestedLevelSet = new Set(fallbackLevels.map(normalizeRiskLevel).filter(Boolean));
      const intersectedLevels = recommendedLevels.filter(level => requestedLevelSet.has(level));
      const effectiveLevels = (intersectedLevels.length > 0 ? intersectedLevels : fallbackLevels)
        .map(normalizeRiskLevel)
        .filter(Boolean);

      return {
        enabled: true,
        closed_samples: closedSamples,
        recommended_min_score: recommendedMinScore,
        effective_min_score: effectiveMinScore,
        recommended_allowed_risk_levels: recommendedLevels,
        effective_allowed_risk_levels: effectiveLevels,
        preferred_source_type: feedback.preferred_source_type,
        preferred_action: feedback.preferred_action,
        strongest_bucket: feedback.strongest_bucket,
      };
    } catch (error: any) {
      logger.warn(`读取模拟盘归因反馈失败，自动跟单沿用原始参数: ${error?.message || error}`);
      return basePolicy;
    }
  }

  private async resolveProfitGatePolicy(options: {
    enabled: boolean;
    source_type?: string;
    agent_session?: string;
    task_label?: string;
    horizon: string;
    min_samples: number;
    min_quality_score: number;
    allow_deprioritized: boolean;
    allow_sampling: boolean;
    sampling_multiplier: number;
    limit: number;
  }): Promise<NonNullable<PaperTradingAutoResult['profit_gate_policy']>> {
    const basePolicy = {
      enabled: options.enabled,
      allow_entries: true,
      source_type: options.source_type,
      agent_session: options.agent_session,
      horizon: options.horizon,
      min_samples: options.min_samples,
      min_quality_score: options.min_quality_score,
      completed_samples: 0,
      quality_score: 0,
      position_multiplier: 1,
      effective_position_multiplier: 1,
      sampling_mode: false,
      reason: '收益闸门未启用，沿用原始仓位规则',
      risk_notes: [],
    };

    if (!options.enabled) return basePolicy;

    try {
      const dashboard = await aiInvestmentSignalService.getPerformanceDashboard({
        source_type: options.source_type === 'all' ? undefined : options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
        horizon: options.horizon,
        min_samples: options.min_samples,
        limit: Math.max(options.limit, 200),
      });
      const gate: any = dashboard.playbook?.overall?.gate || {};
      const qualityScore = Number(dashboard.playbook?.overall?.quality_score || 0);
      const completedSamples = Number(dashboard.playbook?.overall?.count || 0);
      const gateAction = String(gate.action || '');
      const positionMultiplier = Number.isFinite(Number(gate.position_multiplier))
        ? Number(gate.position_multiplier)
        : 0;
      const blockedBySamples = completedSamples < options.min_samples;
      const blockedByQuality = qualityScore < options.min_quality_score;
      const blockedByGate =
        ['wait_for_samples', 'collect_more_samples'].includes(gateAction) ||
        (!options.allow_deprioritized && gateAction === 'deprioritize');
      const samplingMode =
        options.allow_sampling &&
        blockedBySamples &&
        ['wait_for_samples', 'collect_more_samples', ''].includes(gateAction);
      const allowEntries = samplingMode || !(blockedBySamples || blockedByQuality || blockedByGate);
      const effectivePositionMultiplier = samplingMode
        ? clamp(options.sampling_multiplier, 0.1, 0.6)
        : allowEntries
        ? clamp(positionMultiplier || 1, 0.1, 1.5)
        : 0;

      return {
        enabled: true,
        allow_entries: allowEntries,
        source_type: options.source_type,
        agent_session: options.agent_session,
        horizon: options.horizon,
        min_samples: options.min_samples,
        min_quality_score: options.min_quality_score,
        completed_samples: completedSamples,
        quality_score: qualityScore,
        gate_action: gateAction,
        gate_label: gate.label,
        gate_severity: gate.severity,
        position_multiplier: positionMultiplier,
        effective_position_multiplier: effectivePositionMultiplier,
        sampling_mode: samplingMode,
        reason: samplingMode
          ? `Profit Gate 样本 ${completedSamples}/${options.min_samples}，进入小仓采样模式`
          : gate.reason || (allowEntries ? '收益闸门已放行' : '后验样本或质量分未达到自动跟单阈值'),
        risk_notes: samplingMode
          ? [
              ...(dashboard.playbook?.risk_notes || []),
              '样本不足时仅允许低倍率试单，目的是为后续闭环积累真实模拟交易样本。',
            ]
          : dashboard.playbook?.risk_notes || [],
      };
    } catch (error: any) {
      logger.warn(`读取收益闸门失败，自动跟单默认不放大信号: ${error?.message || error}`);
      return {
        ...basePolicy,
        allow_entries: false,
        enabled: true,
        effective_position_multiplier: 0,
        reason: `读取收益闸门失败：${error?.message || error}`,
      };
    }
  }

  private async resolveOutcomeFeedbackPolicy(options: {
    portfolio_id: number;
    user_id: number;
    username?: string;
    enabled: boolean;
    requested_min_score: number;
    requested_allowed_risk_levels: string[];
    source_type?: string;
    agent_session?: string;
    min_closed_samples: number;
    lookback_days: number;
    limit: number;
  }): Promise<NonNullable<PaperTradingAutoResult['outcome_feedback_policy']>> {
    const fallbackLevels = (
      options.requested_allowed_risk_levels?.length
        ? options.requested_allowed_risk_levels
        : ['low', 'medium']
    )
      .map(normalizeRiskLevel)
      .filter(Boolean);
    const basePolicy: NonNullable<PaperTradingAutoResult['outcome_feedback_policy']> = {
      enabled: options.enabled,
      closed_samples: 0,
      min_closed_samples: options.min_closed_samples,
      lookback_days: options.lookback_days,
      effective_min_score: options.requested_min_score,
      effective_allowed_risk_levels: fallbackLevels,
      position_multiplier: 1,
      effective_position_multiplier: 1,
      allow_entries: true,
      preferred_segments: [],
      blocked_segments: [],
      best_segments: [],
      weak_segments: [],
      reason: options.enabled ? '交易收益闭环样本不足，暂不改变交易参数' : '交易收益闭环反哺未启用',
      insights: [],
      next_actions: [],
    };

    if (!options.enabled) return basePolicy;

    try {
      const { recommendationTradeOutcomeService } = await import(
        './RecommendationTradeOutcomeService'
      );
      const dashboard = await recommendationTradeOutcomeService.getDashboard({
        portfolio_id: options.portfolio_id,
        user_id: options.user_id,
        username: options.username,
        include_open: true,
        source_type: options.source_type,
        agent_session: options.agent_session,
        lookback_days: options.lookback_days,
        limit: options.limit,
        report_to_feishu: false,
      });
      const summary: any = dashboard.summary || {};
      const feedback: any = dashboard.feedback || {};
      const closedSamples = Number(summary.closed_count || 0);
      const recommendedMinScore = toNumber(
        feedback.recommended_min_score,
        options.requested_min_score
      );
      const recommendedLevels = Array.isArray(feedback.allowed_risk_levels)
        ? feedback.allowed_risk_levels.map(normalizeRiskLevel).filter(Boolean)
        : [];
      const requestedLevelSet = new Set(fallbackLevels.map(normalizeRiskLevel).filter(Boolean));
      const intersectedLevels = recommendedLevels.filter(level => requestedLevelSet.has(level));
      const effectiveLevels = (intersectedLevels.length > 0 ? intersectedLevels : fallbackLevels)
        .map(normalizeRiskLevel)
        .filter(Boolean);
      const avgExcess = toNumber(summary.avg_excess_return_pct, 0);
      const excessWinRate = toNumber(summary.excess_win_rate, 0);
      const rawPositionMultiplier = toNumber(feedback.position_multiplier, 1);
      const allowEntries =
        closedSamples < options.min_closed_samples ||
        avgExcess >= -3 ||
        excessWinRate >= 35 ||
        toNumber(summary.profit_factor, 0) >= 0.8;
      const effectivePositionMultiplier =
        closedSamples < options.min_closed_samples
          ? clamp(Math.min(rawPositionMultiplier, 0.75), 0.35, 0.9)
          : allowEntries
          ? clamp(rawPositionMultiplier, 0.25, 1.25)
          : 0;
      const effectiveMinScore =
        closedSamples < options.min_closed_samples
          ? options.requested_min_score
          : clamp(Math.max(options.requested_min_score, recommendedMinScore), 55, 94);
      const weakSegments = Array.isArray(feedback.weak_segments) ? feedback.weak_segments : [];
      const bestSegments = Array.isArray(feedback.best_segments) ? feedback.best_segments : [];
      const strategyWeakSegments = weakSegments.filter(
        (segment: any) =>
          ['strategy_key', 'score_position'].includes(String(segment.dimension || '')) ||
          String(segment.key || '').includes('|')
      );
      const strategyBestSegments = bestSegments.filter(
        (segment: any) =>
          ['strategy_key', 'score_position'].includes(String(segment.dimension || '')) ||
          String(segment.key || '').includes('|')
      );
      const marketEnvironment: any = (dashboard as any).market_environment || {};
      const recoveredSegments = Array.isArray(
        marketEnvironment.policy?.recovered_environment_strategy_combos
      )
        ? marketEnvironment.policy.recovered_environment_strategy_combos
        : Array.isArray(marketEnvironment.resample_combo_rankings)
        ? marketEnvironment.resample_combo_rankings.filter(
            (segment: any) => segment?.resample_policy_action === 'recover_small'
          )
        : [];
      const extendedCooldownSegments = Array.isArray(
        marketEnvironment.policy?.extended_cooldown_environment_strategy_combos
      )
        ? marketEnvironment.policy.extended_cooldown_environment_strategy_combos
        : Array.isArray(marketEnvironment.resample_combo_rankings)
        ? marketEnvironment.resample_combo_rankings.filter(
            (segment: any) => segment?.resample_policy_action === 'extend_cooldown'
          )
        : [];
      const blockedSegments =
        closedSamples >= options.min_closed_samples
          ? weakSegments
              .filter(
                (segment: any) =>
                  Number(segment.closed_count || 0) >= 2 &&
                  (Number(segment.robust_score || 0) <= -6 ||
                    Number(segment.risk_adjusted_excess_return_pct || 0) <= -1 ||
                    Number(segment.avg_excess_return_pct || 0) <= -2 ||
                    Number(segment.excess_win_rate || 0) < 35)
              )
              .slice(0, 8)
          : [];
      const strategyBlockedSegments =
        closedSamples >= Math.max(2, Math.min(options.min_closed_samples, 5))
          ? strategyWeakSegments
              .filter(
                (segment: any) =>
                  Number(segment.closed_count || 0) >= 3 &&
                  (Number(segment.robust_score || 0) <= -4 ||
                    Number(segment.risk_adjusted_excess_return_pct || 0) <= -0.8 ||
                    Number(segment.bayesian_win_rate || 50) < 45)
              )
              .slice(0, 6)
          : [];
      const mergedBlockedSegments = [...blockedSegments];
      for (const segment of strategyBlockedSegments) {
        if (!mergedBlockedSegments.some(item => String(item.key) === String(segment.key))) {
          mergedBlockedSegments.push(segment);
        }
      }
      const recoveredPreferredSegments = [
        ...recoveredSegments.map((segment: any) => ({
          ...segment,
          action: 'recover_small',
          position_multiplier:
            segment.position_multiplier || segment.resample_recovery_position_multiplier || 0.58,
          reason: segment.resample_decision_reason || '复采样跑赢，解除冷却并恢复小仓常规采样',
        })),
        ...strategyBestSegments,
      ];
      const filteredBlockedSegments = mergedBlockedSegments.filter(
        segment =>
          !recoveredSegments.some((recovered: any) =>
            this.isSameEnvironmentStrategyComboSegment(segment, recovered)
          )
      );
      for (const segment of extendedCooldownSegments) {
        if (
          !filteredBlockedSegments.some(item =>
            this.isSameEnvironmentStrategyComboSegment(item, segment)
          )
        ) {
          filteredBlockedSegments.push({
            ...segment,
            action: 'extend_cooldown',
            reason:
              segment.resample_decision_reason ||
              `复采样仍跑输，延长冷却 ${segment.cooldown_extension_days || 7} 天`,
          });
        }
      }
      const reason =
        closedSamples < options.min_closed_samples
          ? `闭环样本 ${closedSamples}/${options.min_closed_samples}，先小仓位积累样本`
          : allowEntries
          ? `闭环样本 ${closedSamples}，平均超额 ${roundNumber(
              avgExcess,
              2
            )}%，仓位倍率 ${roundNumber(effectivePositionMultiplier, 2)}x`
          : `闭环样本 ${closedSamples}，平均超额 ${roundNumber(
              avgExcess,
              2
            )}%、超额胜率 ${roundNumber(excessWinRate, 2)}%，暂停自动入场`;

      return {
        enabled: true,
        closed_samples: closedSamples,
        min_closed_samples: options.min_closed_samples,
        lookback_days: options.lookback_days,
        recommended_min_score: recommendedMinScore,
        effective_min_score: effectiveMinScore,
        recommended_allowed_risk_levels: recommendedLevels,
        effective_allowed_risk_levels: effectiveLevels.length ? effectiveLevels : fallbackLevels,
        position_multiplier: roundNumber(rawPositionMultiplier, 2),
        effective_position_multiplier: roundNumber(effectivePositionMultiplier, 2),
        avg_excess_return_pct: roundNumber(avgExcess, 4),
        excess_win_rate: roundNumber(excessWinRate, 2),
        allow_entries: allowEntries,
        preferred_segments: [...recoveredPreferredSegments, ...bestSegments]
          .filter(
            (segment, index, array) =>
              array.findIndex(item => String(item.key) === String(segment.key)) === index
          )
          .slice(0, 6),
        blocked_segments: filteredBlockedSegments.slice(0, 10),
        best_segments: bestSegments,
        weak_segments: weakSegments,
        recovered_segments: recoveredSegments.slice(0, 6),
        extended_cooldown_segments: extendedCooldownSegments.slice(0, 6),
        reason,
        insights: Array.isArray(feedback.insights) ? feedback.insights.slice(0, 5) : [],
        next_actions: Array.isArray(feedback.next_actions) ? feedback.next_actions.slice(0, 5) : [],
      };
    } catch (error: any) {
      logger.warn(`读取推荐交易收益闭环反哺失败，自动跟单沿用原始参数: ${error?.message || error}`);
      return {
        ...basePolicy,
        enabled: true,
        reason: `收益闭环反哺读取失败，沿用原始参数：${error?.message || error}`,
      };
    }
  }

  private async resolveEntryRiskGuardPolicy(options: {
    enabled: boolean;
    portfolio_id: number;
    total_value: number;
    max_daily_new_positions: number;
    max_daily_new_exposure_pct: number;
    max_total_exposure_pct: number;
    max_industry_exposure_pct: number;
    min_cash_reserve_pct: number;
    max_portfolio_drawdown_pct: number;
    max_single_stock_volatility_pct: number;
    max_position_correlation: number;
    max_portfolio_var_pct: number;
    min_avg_turnover_yuan: number;
    cooldown_days_after_loss: number;
    block_st: boolean;
    block_limit_up: boolean;
    block_limit_down: boolean;
    block_suspended: boolean;
  }): Promise<EntryRiskGuardState> {
    const totalValue = Math.max(toNumber(options.total_value, 0), 1);
    const state: EntryRiskGuardState = {
      enabled: options.enabled,
      max_daily_new_positions: Math.max(1, options.max_daily_new_positions),
      max_daily_new_exposure_pct: clamp(options.max_daily_new_exposure_pct, 1, 100),
      max_total_exposure_pct: clamp(options.max_total_exposure_pct, 1, 100),
      max_industry_exposure_pct: clamp(options.max_industry_exposure_pct, 1, 100),
      min_cash_reserve_pct: clamp(options.min_cash_reserve_pct, 0, 80),
      max_portfolio_drawdown_pct: clamp(options.max_portfolio_drawdown_pct, 1, 80),
      max_single_stock_volatility_pct: clamp(options.max_single_stock_volatility_pct, 1, 30),
      max_position_correlation: clamp(options.max_position_correlation, 0.1, 0.99),
      max_portfolio_var_pct: clamp(options.max_portfolio_var_pct, 1, 50),
      min_avg_turnover_yuan: Math.max(0, options.min_avg_turnover_yuan),
      cooldown_days_after_loss: Math.max(0, options.cooldown_days_after_loss),
      block_st: options.block_st,
      block_limit_up: options.block_limit_up,
      block_limit_down: options.block_limit_down,
      block_suspended: options.block_suspended,
      total_value: totalValue,
      peak_total_value: totalValue,
      portfolio_drawdown_pct: 0,
      current_exposure_pct: 0,
      open_position_symbols: [],
      current_strategy_exposure_pct: new Map<string, number>(),
      today_buy_count: 0,
      today_new_exposure_pct: 0,
      staged_count: 0,
      staged_exposure_pct: 0,
      staged_strategy_exposure_pct: new Map<string, number>(),
      industry_exposure_amount: new Map<string, number>(),
      risk_notes: options.enabled
        ? ['已启用入场风控：流动性、涨跌停、行业集中度、日内新增仓位与亏损冷却均会被检查。']
        : ['入场风控未启用。'],
    };

    if (!options.enabled || !options.portfolio_id) return state;

    const [positions, todayTrades] = await Promise.all([
      PaperTradingPosition.findAll({ where: { portfolio_id: options.portfolio_id } }),
      PaperTradingTrade.findAll({
        where: {
          portfolio_id: options.portfolio_id,
          direction: 'BUY',
          created_at: {
            [Op.gte]: moment().tz('Asia/Shanghai').startOf('day').toDate(),
          },
        },
      }),
    ]);
    const snapshots = await PaperTradingSnapshot.findAll({
      where: {
        portfolio_id: options.portfolio_id,
        date: {
          [Op.gte]: moment().tz('Asia/Shanghai').subtract(90, 'days').format('YYYY-MM-DD'),
        },
      },
      order: [['date', 'ASC']],
      raw: true,
    });
    const peakTotalValue = Math.max(
      totalValue,
      ...snapshots.map(snapshot => toNumber((snapshot as any).total_value, 0))
    );
    state.peak_total_value = peakTotalValue;
    state.portfolio_drawdown_pct =
      peakTotalValue > 0
        ? roundNumber(((totalValue - peakTotalValue) / peakTotalValue) * 100, 2)
        : 0;
    const executedSignals = await AIInvestmentSignal.findAll({
      where: executedSignalWhereForPortfolio(options.portfolio_id),
      order: [['updated_at', 'DESC']],
      limit: 2000,
    }).catch(() => [] as AIInvestmentSignal[]);
    const signalMetadataBySymbol = new Map<string, Record<string, any>>();
    for (const signal of executedSignals) {
      const symbol = normalizeSymbol(signal.symbol);
      if (!symbol || signalMetadataBySymbol.has(symbol)) continue;
      signalMetadataBySymbol.set(symbol, asPlainObject(signal.metadata));
    }

    const symbols = [...new Set(positions.map(position => normalizeSymbol(position.symbol)))];
    state.open_position_symbols = symbols;
    const stocks = symbols.length
      ? await Stock.findAll({ where: { symbol: { [Op.in]: symbols } }, raw: true })
      : [];
    const stockMap = new Map<string, any>(
      (stocks as any[]).map(stock => [normalizeSymbol(stock.symbol), stock])
    );

    const positionValue = positions.reduce(
      (sum, position) => sum + toNumber(position.market_value, 0),
      0
    );
    state.current_exposure_pct = roundNumber((positionValue / totalValue) * 100, 2);
    state.today_buy_count = todayTrades.length;
    const todayAmount = todayTrades.reduce((sum, trade) => sum + toNumber(trade.amount, 0), 0);
    state.today_new_exposure_pct = roundNumber((todayAmount / totalValue) * 100, 2);

    for (const position of positions) {
      const symbol = normalizeSymbol(position.symbol);
      const stock = stockMap.get(symbol);
      const industry = stock?.industry || '未分类';
      state.industry_exposure_amount.set(
        industry,
        toNumber(state.industry_exposure_amount.get(industry), 0) +
          toNumber(position.market_value, 0)
      );
      const signalMetadata = signalMetadataBySymbol.get(symbol) || {};
      const normalizedStrategyKeys = strategyKeysFromSignalMetadata(signalMetadata);
      const positionPct =
        totalValue > 0 ? (toNumber(position.market_value, 0) / totalValue) * 100 : 0;
      for (const strategyKey of normalizedStrategyKeys) {
        state.current_strategy_exposure_pct.set(
          strategyKey,
          roundNumber(
            toNumber(state.current_strategy_exposure_pct.get(strategyKey), 0) + positionPct,
            4
          )
        );
      }
    }

    return state;
  }

  private buildEntryRiskGuardPolicy(
    guard: EntryRiskGuardState
  ): NonNullable<PaperTradingAutoResult['entry_risk_guard_policy']> {
    return {
      enabled: guard.enabled,
      max_daily_new_positions: guard.max_daily_new_positions,
      max_daily_new_exposure_pct: roundNumber(guard.max_daily_new_exposure_pct, 2),
      max_total_exposure_pct: roundNumber(guard.max_total_exposure_pct, 2),
      max_industry_exposure_pct: roundNumber(guard.max_industry_exposure_pct, 2),
      min_cash_reserve_pct: roundNumber(guard.min_cash_reserve_pct, 2),
      max_portfolio_drawdown_pct: roundNumber(guard.max_portfolio_drawdown_pct, 2),
      max_single_stock_volatility_pct: roundNumber(guard.max_single_stock_volatility_pct, 2),
      max_position_correlation: roundNumber(guard.max_position_correlation, 2),
      max_portfolio_var_pct: roundNumber(guard.max_portfolio_var_pct, 2),
      min_avg_turnover_yuan: roundNumber(guard.min_avg_turnover_yuan, 2),
      cooldown_days_after_loss: guard.cooldown_days_after_loss,
      block_st: guard.block_st,
      block_limit_up: guard.block_limit_up,
      block_limit_down: guard.block_limit_down,
      block_suspended: guard.block_suspended,
      peak_total_value: roundNumber(guard.peak_total_value, 2),
      portfolio_drawdown_pct: roundNumber(guard.portfolio_drawdown_pct, 2),
      current_exposure_pct: roundNumber(guard.current_exposure_pct, 2),
      current_strategy_exposure_pct: Object.fromEntries(guard.current_strategy_exposure_pct),
      today_buy_count: guard.today_buy_count + guard.staged_count,
      today_new_exposure_pct: roundNumber(
        guard.today_new_exposure_pct + guard.staged_exposure_pct,
        2
      ),
      remaining_daily_new_positions: Math.max(
        0,
        guard.max_daily_new_positions - guard.today_buy_count - guard.staged_count
      ),
      remaining_daily_new_exposure_pct: roundNumber(
        Math.max(
          0,
          guard.max_daily_new_exposure_pct -
            guard.today_new_exposure_pct -
            guard.staged_exposure_pct
        ),
        2
      ),
      staged_strategy_exposure_pct: Object.fromEntries(guard.staged_strategy_exposure_pct),
      risk_notes: guard.risk_notes.slice(0, 8),
    };
  }

  private async getEntryMarketProfile(
    symbol: string,
    options: { cooldown_days_after_loss: number }
  ): Promise<EntryMarketProfile> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const stock = await Stock.findOne({ where: { symbol: normalizedSymbol } });
    const bars = stock
      ? await DailyBar.findAll({
          where: { stock_id: stock.id },
          order: [['time', 'DESC']],
          limit: 20,
          raw: true,
        })
      : [];
    const latest: any = bars[0] || null;
    const closes = (bars as any[])
      .slice()
      .reverse()
      .map(bar => toNumber(bar.close, 0))
      .filter(value => value > 0);
    const dailyReturns = closes
      .slice(1)
      .map((close, index) =>
        closes[index] > 0 ? ((close - closes[index]) / closes[index]) * 100 : 0
      )
      .filter(Number.isFinite);
    const avgReturn = dailyReturns.length
      ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
      : 0;
    const volatility20d =
      dailyReturns.length > 1
        ? Math.sqrt(
            dailyReturns.reduce((sum, value) => sum + (value - avgReturn) ** 2, 0) /
              (dailyReturns.length - 1)
          )
        : 0;
    const validTurnovers = (bars as any[])
      .slice(0, 20)
      .map(bar => toNumber(bar.turnover, 0))
      .filter(value => value > 0);
    const avgTurnover =
      validTurnovers.length > 0
        ? validTurnovers.reduce((sum, value) => sum + value, 0) / validTurnovers.length
        : 0;
    const latestQuote = await RealtimeQuote.findOne({
      where: { symbol: normalizedSymbol },
      order: [['quote_time', 'DESC']],
    }).catch(() => null);
    const name = stock?.name || normalizedSymbol;
    const latestChangePercent = toOptionalNumber(
      latestQuote?.change_percent ?? latest?.change_percent ?? stock?.change_percent
    );
    const latestQuoteTime = latestQuote?.quote_time;
    const latestQuoteAgeMinutes = quoteAgeMinutes(latestQuoteTime);
    const latestQuoteTradeDate =
      latestQuote?.trade_date ||
      (latestQuoteTime ? moment(latestQuoteTime).tz('Asia/Shanghai').format('YYYY-MM-DD') : '');
    const realtimeTurnover = toOptionalNumber(latestQuote?.turnover);
    const realtimePrice = toOptionalNumber(latestQuote?.current_price);
    const cooldownHit =
      options.cooldown_days_after_loss > 0
        ? await RecommendationTradeOutcome.findOne({
            where: {
              symbol: normalizedSymbol,
              trade_status: 'closed',
              [Op.or]: [{ total_pnl_pct: { [Op.lt]: 0 } }, { realized_pnl_pct: { [Op.lt]: 0 } }],
              exit_date: {
                [Op.gte]: moment()
                  .tz('Asia/Shanghai')
                  .subtract(options.cooldown_days_after_loss, 'days')
                  .format('YYYY-MM-DD'),
              },
            },
            order: [['exit_date', 'DESC']],
          })
        : null;

    return {
      symbol: normalizedSymbol,
      name,
      industry: stock?.industry || '未分类',
      market: stock?.market,
      data_status: stock?.data_status,
      is_st: /(^|\*)ST|退/i.test(name),
      is_suspended: Boolean(latest?.is_suspended),
      is_limit_up:
        Number.isFinite(Number(latestChangePercent)) && Number(latestChangePercent) >= 9.7,
      is_limit_down:
        Number.isFinite(Number(latestChangePercent)) && Number(latestChangePercent) <= -9.7,
      latest_change_percent: latestChangePercent,
      volatility_20d_pct: roundNumber(volatility20d, 2),
      recent_returns_20d: dailyReturns.slice(-20).map(value => roundNumber(value, 4)),
      avg_turnover_yuan: roundNumber(avgTurnover, 2),
      realtime_turnover_yuan: realtimeTurnover,
      latest_price: realtimePrice || toOptionalNumber(latest?.close ?? stock?.price),
      price_source: latestQuote
        ? latestQuote.source || 'realtime_quote'
        : latest
        ? 'daily_bar'
        : 'stock_snapshot',
      quote_time: latestQuoteTime?.toISOString(),
      quote_age_minutes: latestQuoteAgeMinutes,
      quote_trade_date: latestQuoteTradeDate,
      quote_freshness_status:
        latestQuoteTime && latestQuoteAgeMinutes !== undefined && latestQuoteAgeMinutes <= 30
          ? 'fresh'
          : 'stale_or_missing',
      from_realtime: Boolean(latestQuote),
      latest_date: latest?.time ? moment(latest.time).tz('Asia/Shanghai').format('YYYY-MM-DD') : '',
      cooldown_hit: cooldownHit
        ? {
            exit_date: cooldownHit.exit_date,
            total_pnl_pct: toOptionalNumber(cooldownHit.total_pnl_pct),
            realized_pnl_pct: toOptionalNumber(cooldownHit.realized_pnl_pct),
          }
        : null,
    };
  }

  private async enrichEntryMarketProfileRisk(
    profile: EntryMarketProfile,
    guard: EntryRiskGuardState,
    candidate_position_pct: number
  ): Promise<EntryMarketProfile> {
    if (!guard.enabled) return profile;
    const returns = profile.recent_returns_20d || [];
    let maxCorrelation = 0;

    if (returns.length >= 5 && guard.open_position_symbols.length > 0) {
      const peers = await Promise.all(
        guard.open_position_symbols
          .filter(symbol => normalizeSymbol(symbol) !== normalizeSymbol(profile.symbol))
          .slice(0, 20)
          .map(symbol =>
            this.getEntryMarketProfile(symbol, { cooldown_days_after_loss: 0 }).catch(() => null)
          )
      );
      for (const peer of peers) {
        if (!peer?.recent_returns_20d?.length) continue;
        maxCorrelation = Math.max(
          maxCorrelation,
          pearsonCorrelation(returns, peer.recent_returns_20d)
        );
      }
    }

    const existingVarProxy =
      Math.max(0, guard.current_exposure_pct + guard.staged_exposure_pct) *
      Math.max(0, toNumber(profile.max_correlation_with_positions, 0.35));
    const candidateVarProxy =
      Math.max(0, candidate_position_pct) * Math.max(0, toNumber(profile.volatility_20d_pct, 0));
    const estimatedPortfolioVarPct = Math.sqrt(existingVarProxy ** 2 + candidateVarProxy ** 2) / 10;

    return {
      ...profile,
      max_correlation_with_positions: roundNumber(maxCorrelation, 4),
      estimated_portfolio_var_pct: roundNumber(estimatedPortfolioVarPct, 2),
    };
  }

  private evaluateEntryRiskGuard(options: {
    guard: EntryRiskGuardState;
    profile: EntryMarketProfile;
    candidate_position_pct: number;
    strategy_keys?: string[];
    strategy_allocation_pct?: number;
  }): { allowed: boolean; reasons: string[] } {
    const { guard, profile } = options;
    if (!guard.enabled) return { allowed: true, reasons: [] };

    const candidatePct = Math.max(0, toNumber(options.candidate_position_pct, 0));
    const reasons: string[] = [];
    if (guard.block_st && profile.is_st) {
      reasons.push('入场风控：ST/退市风险标的禁止自动买入');
    }
    if (guard.block_suspended && profile.is_suspended) {
      reasons.push('入场风控：最新交易日停牌，禁止自动买入');
    }
    if (guard.block_limit_up && profile.is_limit_up) {
      reasons.push(`入场风控：最新涨幅 ${profile.latest_change_percent ?? '--'}%，疑似涨停追高`);
    }
    if (guard.block_limit_down && profile.is_limit_down) {
      reasons.push(
        `入场风控：最新跌幅 ${profile.latest_change_percent ?? '--'}%，疑似跌停流动性风险`
      );
    }
    if (
      profile.data_status &&
      ['no_data', 'conflict', 'incomplete'].includes(profile.data_status)
    ) {
      reasons.push(`入场风控：数据状态 ${profile.data_status}，等待数据质量修复`);
    }
    if (guard.min_avg_turnover_yuan > 0 && profile.avg_turnover_yuan > 0) {
      if (profile.avg_turnover_yuan < guard.min_avg_turnover_yuan) {
        reasons.push(
          `入场风控：20日均成交额 ${Math.round(
            profile.avg_turnover_yuan / 10000
          )} 万，低于阈值 ${Math.round(guard.min_avg_turnover_yuan / 10000)} 万`
        );
      }
    }
    if (guard.cooldown_days_after_loss > 0 && profile.cooldown_hit) {
      reasons.push(
        `入场风控：${guard.cooldown_days_after_loss}日亏损冷却中，最近退出收益 ${
          profile.cooldown_hit.total_pnl_pct ?? profile.cooldown_hit.realized_pnl_pct ?? '--'
        }%`
      );
    }
    if (guard.today_buy_count + guard.staged_count >= guard.max_daily_new_positions) {
      reasons.push(`入场风控：今日新增持仓数已达 ${guard.max_daily_new_positions} 笔上限`);
    }
    if (
      guard.max_portfolio_drawdown_pct > 0 &&
      Math.abs(Math.min(guard.portfolio_drawdown_pct, 0)) > guard.max_portfolio_drawdown_pct
    ) {
      reasons.push(
        `入场风控：组合回撤 ${Math.abs(guard.portfolio_drawdown_pct)}% 超过 ${
          guard.max_portfolio_drawdown_pct
        }%，暂停新增仓位`
      );
    }
    if (
      guard.max_single_stock_volatility_pct > 0 &&
      toNumber(profile.volatility_20d_pct, 0) > guard.max_single_stock_volatility_pct
    ) {
      reasons.push(
        `入场风控：20日波动率 ${profile.volatility_20d_pct}% 超过 ${guard.max_single_stock_volatility_pct}%，避免高波动追入`
      );
    }
    if (
      guard.open_position_symbols.length > 0 &&
      guard.max_position_correlation > 0 &&
      toNumber(profile.max_correlation_with_positions, 0) > guard.max_position_correlation
    ) {
      reasons.push(
        `入场风控：与现有持仓最高相关性 ${profile.max_correlation_with_positions} 超过 ${guard.max_position_correlation}，避免同向拥挤`
      );
    }

    if (candidatePct > 0) {
      if (
        guard.max_portfolio_var_pct > 0 &&
        toNumber(profile.estimated_portfolio_var_pct, 0) > guard.max_portfolio_var_pct
      ) {
        reasons.push(
          `入场风控：组合VaR代理值 ${profile.estimated_portfolio_var_pct}% 超过 ${guard.max_portfolio_var_pct}%`
        );
      }
      const estimatedCashPct = Math.max(
        0,
        100 - guard.current_exposure_pct - guard.staged_exposure_pct - candidatePct
      );
      if (estimatedCashPct < guard.min_cash_reserve_pct - 0.01) {
        reasons.push(
          `入场风控：买入后现金水位约 ${roundNumber(estimatedCashPct, 2)}%，低于 ${
            guard.min_cash_reserve_pct
          }%`
        );
      }
      const nextDailyExposure =
        guard.today_new_exposure_pct + guard.staged_exposure_pct + candidatePct;
      if (nextDailyExposure > guard.max_daily_new_exposure_pct + 0.01) {
        reasons.push(
          `入场风控：今日新增仓位 ${roundNumber(nextDailyExposure, 2)}% 将超过 ${
            guard.max_daily_new_exposure_pct
          }%`
        );
      }
      const nextTotalExposure =
        guard.current_exposure_pct + guard.staged_exposure_pct + candidatePct;
      if (nextTotalExposure > guard.max_total_exposure_pct + 0.01) {
        reasons.push(
          `入场风控：总风险暴露 ${roundNumber(nextTotalExposure, 2)}% 将超过 ${
            guard.max_total_exposure_pct
          }%`
        );
      }
      const industry = profile.industry || '未分类';
      const currentIndustryPct =
        (toNumber(guard.industry_exposure_amount.get(industry), 0) / guard.total_value) * 100;
      if (currentIndustryPct + candidatePct > guard.max_industry_exposure_pct + 0.01) {
        reasons.push(
          `入场风控：${industry} 行业暴露 ${roundNumber(
            currentIndustryPct + candidatePct,
            2
          )}% 将超过 ${guard.max_industry_exposure_pct}%`
        );
      }
      const strategyAllocationPct = toNumber(options.strategy_allocation_pct, 0);
      if (strategyAllocationPct > 0) {
        for (const strategyKey of options.strategy_keys || []) {
          const currentStrategyPct = toNumber(
            guard.current_strategy_exposure_pct.get(strategyKey),
            0
          );
          const stagedStrategyPct = toNumber(
            guard.staged_strategy_exposure_pct.get(strategyKey),
            0
          );
          const nextStrategyPct = currentStrategyPct + stagedStrategyPct + candidatePct;
          if (nextStrategyPct > strategyAllocationPct + 0.01) {
            reasons.push(
              `入场风控：策略 ${strategyKey} 暴露 ${roundNumber(
                nextStrategyPct,
                2
              )}% 将超过策略预算 ${strategyAllocationPct}%`
            );
            break;
          }
        }
      }
    }

    return { allowed: reasons.length === 0, reasons };
  }

  private evaluateExecutionReality(options: {
    side: ExecutionSide;
    profile: EntryMarketProfile;
    quote?: { price?: number; source?: string; date?: string; quote_time?: string };
    min_avg_turnover_yuan?: number;
    block_limit_up?: boolean;
    block_limit_down?: boolean;
    block_suspended?: boolean;
    block_st?: boolean;
  }): ExecutionRealityDecision {
    const { side, profile } = options;
    const checks: Record<string, any> = {
      block_st: options.block_st !== false,
      block_suspended: options.block_suspended !== false,
      block_limit_up: options.block_limit_up !== false,
      block_limit_down: options.block_limit_down !== false,
      min_avg_turnover_yuan: roundNumber(options.min_avg_turnover_yuan || 0, 2),
      latest_change_percent: profile.latest_change_percent,
      data_status: profile.data_status,
      quote_freshness_status: profile.quote_freshness_status,
    };
    const reasons: string[] = [];
    const quotePrice = toOptionalNumber(options.quote?.price);
    const price = quotePrice || profile.latest_price;
    const turnover = toOptionalNumber(profile.realtime_turnover_yuan);
    const avgTurnover = toNumber(profile.avg_turnover_yuan, 0);
    const effectiveTurnover = Math.max(toNumber(turnover, 0), avgTurnover);
    const minTurnover = toNumber(options.min_avg_turnover_yuan, 0);

    if (!price || price <= 0) {
      reasons.push('执行可行性：没有有效现价，无法模拟成交');
    }
    if (options.block_st !== false && profile.is_st && side === 'BUY') {
      reasons.push('执行可行性：ST/退市风险标的禁止新增买入');
    }
    if (options.block_suspended !== false && profile.is_suspended) {
      reasons.push('执行可行性：最新交易日停牌，无法成交');
    }
    if (profile.data_status && ['no_data', 'conflict'].includes(profile.data_status)) {
      reasons.push(`执行可行性：数据状态 ${profile.data_status}，成交假设不可信`);
    }
    if (side === 'BUY' && options.block_limit_up !== false && profile.is_limit_up) {
      reasons.push(
        `执行可行性：涨幅 ${profile.latest_change_percent ?? '--'}%，疑似涨停，买入可能排队无法成交`
      );
    }
    if (side === 'SELL' && options.block_limit_down !== false && profile.is_limit_down) {
      reasons.push(
        `执行可行性：跌幅 ${profile.latest_change_percent ?? '--'}%，疑似跌停，卖出可能无法成交`
      );
    }
    if (
      side === 'BUY' &&
      minTurnover > 0 &&
      effectiveTurnover > 0 &&
      effectiveTurnover < minTurnover
    ) {
      reasons.push(
        `执行可行性：成交额约 ${Math.round(effectiveTurnover / 10000)} 万，低于阈值 ${Math.round(
          minTurnover / 10000
        )} 万`
      );
    }

    const allowed = reasons.length === 0;
    const quoteTime = options.quote?.quote_time || profile.quote_time;
    const quoteAge = quoteAgeMinutes(quoteTime) ?? profile.quote_age_minutes;
    return {
      allowed,
      side,
      action: allowed ? 'allow' : 'reject',
      label: allowed
        ? `${side === 'BUY' ? '买入' : '卖出'}可模拟成交：价格/流动性/涨跌停检查通过`
        : `${side === 'BUY' ? '买入' : '卖出'}执行受限：${compactText(reasons[0], 48)}`,
      reasons: reasons.slice(0, 8),
      price: price ? roundNumber(price, 4) : undefined,
      price_source: options.quote?.source || profile.price_source || 'unknown',
      quote_time: quoteTime,
      quote_trade_date: profile.quote_trade_date || options.quote?.date,
      quote_age_minutes: quoteAge,
      change_percent: profile.latest_change_percent,
      turnover,
      avg_turnover_yuan: avgTurnover ? roundNumber(avgTurnover, 2) : undefined,
      from_realtime: Boolean(profile.from_realtime || options.quote?.source === 'realtime_quote'),
      checks: {
        ...checks,
        is_st: profile.is_st,
        is_suspended: profile.is_suspended,
        is_limit_up: profile.is_limit_up,
        is_limit_down: profile.is_limit_down,
        effective_turnover_yuan: effectiveTurnover ? roundNumber(effectiveTurnover, 2) : undefined,
      },
    };
  }

  private buildEntryRiskGuardDecision(options: {
    trade_risk: { allowed: boolean; reasons: string[] };
    guard: EntryRiskGuardState;
    profile: EntryMarketProfile;
    candidate_position_pct: number;
    strategy_keys?: string[];
    strategy_allocation_pct?: number;
  }): NonNullable<PaperTradingAutoTradeItem['entry_risk_guard_decision']> {
    const { trade_risk, guard, profile } = options;
    const candidatePct = roundNumber(options.candidate_position_pct, 2);
    const strategyAllocationPct = toOptionalNumber(options.strategy_allocation_pct);
    const nextDailyExposure = roundNumber(
      guard.today_new_exposure_pct + guard.staged_exposure_pct + candidatePct,
      2
    );
    const nextTotalExposure = roundNumber(
      guard.current_exposure_pct + guard.staged_exposure_pct + candidatePct,
      2
    );
    const estimatedCashPct = roundNumber(Math.max(0, 100 - nextTotalExposure), 2);
    const industry = profile.industry || '未分类';
    const currentIndustryPct =
      guard.total_value > 0
        ? roundNumber(
            (toNumber(guard.industry_exposure_amount.get(industry), 0) / guard.total_value) * 100,
            2
          )
        : 0;
    const label = trade_risk.allowed
      ? `入场风控放行：目标${candidatePct}%｜现金${estimatedCashPct}%｜今日新增${nextDailyExposure}%`
      : `入场风控拦截：${compactText(trade_risk.reasons[0], 48)}`;
    return {
      allowed: trade_risk.allowed,
      label,
      reasons: trade_risk.reasons.slice(0, 6),
      candidate_position_pct: candidatePct,
      strategy_allocation_pct: strategyAllocationPct,
      checks: {
        min_cash_reserve_pct: guard.min_cash_reserve_pct,
        estimated_cash_pct: estimatedCashPct,
        max_daily_new_exposure_pct: guard.max_daily_new_exposure_pct,
        next_daily_exposure_pct: nextDailyExposure,
        max_total_exposure_pct: guard.max_total_exposure_pct,
        next_total_exposure_pct: nextTotalExposure,
        max_industry_exposure_pct: guard.max_industry_exposure_pct,
        industry,
        current_industry_exposure_pct: currentIndustryPct,
        next_industry_exposure_pct: roundNumber(currentIndustryPct + candidatePct, 2),
        strategy_keys: options.strategy_keys || [],
        max_daily_new_positions: guard.max_daily_new_positions,
        today_buy_count: guard.today_buy_count + guard.staged_count,
        remaining_daily_new_positions: Math.max(
          0,
          guard.max_daily_new_positions - guard.today_buy_count - guard.staged_count
        ),
      },
    };
  }

  private commitEntryRiskGuardTrade(
    guard: EntryRiskGuardState,
    options: {
      profile: EntryMarketProfile;
      target_position_pct: number;
      amount: number;
      strategy_keys?: string[];
    }
  ) {
    if (!guard.enabled) return;
    const pct = Math.max(0, toNumber(options.target_position_pct, 0));
    guard.staged_count += 1;
    guard.staged_exposure_pct = roundNumber(guard.staged_exposure_pct + pct, 4);
    const industry = options.profile.industry || '未分类';
    guard.industry_exposure_amount.set(
      industry,
      toNumber(guard.industry_exposure_amount.get(industry), 0) + toNumber(options.amount, 0)
    );
    for (const strategyKey of options.strategy_keys || []) {
      guard.staged_strategy_exposure_pct.set(
        strategyKey,
        roundNumber(toNumber(guard.staged_strategy_exposure_pct.get(strategyKey), 0) + pct, 4)
      );
    }
  }

  private buildEnvironmentGuardPolicy(): NonNullable<
    PaperTradingAutoResult['environment_guard_policy']
  > {
    return {
      enabled: true,
      description:
        '自动跟单根据大盘/行业状态动态调仓：压力市和弱行业降仓，压力市叠加弱行业默认禁入，强势环境只小幅放大。',
      pressure_market_multiplier: 0.45,
      bear_market_multiplier: 0.6,
      strong_market_multiplier: 1.08,
      industry_cold_multiplier: 0.65,
      industry_hot_multiplier: 1.08,
      hard_block_rules: [
        '压力市+行业弱势禁入',
        '压力市+弱历史环境片段禁入',
        '非强制信号遇样本充分的弱环境片段禁入',
      ],
    };
  }

  private normalizeEnvironmentKey(value: any): string {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  private buildEnvironmentCandidates(environment?: MarketEnvironmentSnapshotLike): string[] {
    const marketRegime = this.normalizeEnvironmentKey(environment?.market_regime);
    const industryRegime = this.normalizeEnvironmentKey(environment?.industry?.regime);
    const candidates = [
      marketRegime,
      industryRegime,
      environment?.market_regime_label,
      environment?.industry?.label,
      marketRegime ? `market_regime:${marketRegime}` : '',
      industryRegime ? `industry_regime:${industryRegime}` : '',
    ]
      .map(value => this.normalizeEnvironmentKey(value))
      .filter(Boolean);
    return [...new Set(candidates)];
  }

  private buildEnvironmentStrategyComboKey(
    environment: MarketEnvironmentSnapshotLike,
    strategyKey?: string
  ): string {
    const policy = asPlainObject(environment as any);
    const externalPolicySnapshotId =
      policy.external_policy_snapshot_id || policy.snapshot_id || policy.id || 'unknown';
    return `env:${externalPolicySnapshotId}|strategy:${strategyKey || 'unknown'}`;
  }

  private extractStrategyKeyFromEnvironmentComboKey(key?: string): string {
    const match = String(key || '').match(/strategy:(.+)$/);
    return match?.[1] || '';
  }

  private extractEnvironmentPolicyIdFromComboKey(key?: string): string {
    const match = String(key || '').match(/env:([^|]+)/);
    return match?.[1] || '';
  }

  private isSameEnvironmentStrategyComboSegment(a: any, b: any): boolean {
    const aKey = this.normalizeEnvironmentKey(a?.key);
    const bKey = this.normalizeEnvironmentKey(b?.key);
    if (aKey && bKey && aKey === bKey) return true;
    const aStrategy = this.normalizeEnvironmentKey(
      a?.strategy_key || this.extractStrategyKeyFromEnvironmentComboKey(a?.key)
    );
    const bStrategy = this.normalizeEnvironmentKey(
      b?.strategy_key || this.extractStrategyKeyFromEnvironmentComboKey(b?.key)
    );
    if (!aStrategy || !bStrategy || aStrategy !== bStrategy) return false;
    const aEnv = this.normalizeEnvironmentKey(
      a?.environment_policy_snapshot_id || this.extractEnvironmentPolicyIdFromComboKey(a?.key)
    );
    const bEnv = this.normalizeEnvironmentKey(
      b?.environment_policy_snapshot_id || this.extractEnvironmentPolicyIdFromComboKey(b?.key)
    );
    return !aEnv || !bEnv || aEnv === bEnv;
  }

  private matchResampleEnvironmentStrategyPolicy(
    item: any,
    options: {
      environment: MarketEnvironmentSnapshotLike;
      strategy_key?: string;
      external_policy: Record<string, any>;
      environment_policy_snapshot_id?: string;
    }
  ): boolean {
    const key = this.normalizeEnvironmentKey(item?.key);
    const strategyKey = this.normalizeEnvironmentKey(options.strategy_key);
    const itemStrategyKey = this.normalizeEnvironmentKey(
      item?.strategy_key || this.extractStrategyKeyFromEnvironmentComboKey(item?.key)
    );
    if (!strategyKey || strategyKey === 'unknown' || !itemStrategyKey) return false;

    const candidates = [
      this.buildEnvironmentStrategyComboKey(options.environment, options.strategy_key),
      `env:${
        options.environment_policy_snapshot_id ||
        options.external_policy.snapshot_id ||
        options.external_policy.id ||
        'unknown'
      }|strategy:${options.strategy_key || 'unknown'}`,
    ].map(value => this.normalizeEnvironmentKey(value));

    if (key && candidates.includes(key)) return true;

    const itemEnvironmentId = this.normalizeEnvironmentKey(
      item?.environment_policy_snapshot_id || this.extractEnvironmentPolicyIdFromComboKey(item?.key)
    );
    const currentEnvironmentIds = [
      options.environment_policy_snapshot_id,
      options.external_policy.snapshot_id,
      options.external_policy.id,
      (options.environment as any)?.external_policy_snapshot_id,
      (options.environment as any)?.snapshot_id,
      (options.environment as any)?.id,
    ]
      .map(value => this.normalizeEnvironmentKey(value))
      .filter(Boolean);

    if (itemEnvironmentId && currentEnvironmentIds.includes(itemEnvironmentId)) {
      return itemStrategyKey === strategyKey;
    }

    return itemStrategyKey === strategyKey;
  }

  private resolveSignalMarketEnvironment(
    signal: AIInvestmentSignal,
    metadata: Record<string, any> = asPlainObject(signal.metadata)
  ): MarketEnvironmentSnapshotLike {
    const paperTrading = paperTradingMetaForPortfolio(metadata);
    const candidates = [
      metadata.market_environment,
      paperTrading.market_environment,
      asPlainObject(paperTrading.environment_policy).market_environment,
      asPlainObject(metadata.strategy_variant).market_environment,
    ];
    for (const candidate of candidates) {
      const env = asPlainObject(candidate);
      if (env.market_regime || env.industry) {
        return env as MarketEnvironmentSnapshotLike;
      }
    }
    return {};
  }

  private async resolveEnvironmentForSignal(
    signal: AIInvestmentSignal,
    metadata: Record<string, any>
  ): Promise<MarketEnvironmentSnapshotLike> {
    const existing = this.resolveSignalMarketEnvironment(signal, metadata);
    if (existing.market_regime || existing.industry?.regime) {
      return existing;
    }

    try {
      const stock = await Stock.findOne({ where: { symbol: normalizeSymbol(signal.symbol) } });
      return (await marketEnvironmentService.getEnvironmentForStock(
        normalizeSymbol(signal.symbol),
        {
          stock,
          as_of: signal.signal_date || getChinaToday(),
          industry: stock?.industry,
        }
      )) as MarketEnvironmentSnapshotLike;
    } catch (error: any) {
      logger.warn(
        `读取 ${signal.symbol} 市场环境失败，自动跟单使用未知环境: ${error?.message || error}`
      );
      return {};
    }
  }

  private findEnvironmentFeedbackSegment(
    environment: MarketEnvironmentSnapshotLike | undefined,
    segments?: any[]
  ): any | null {
    if (!Array.isArray(segments) || segments.length === 0) return null;
    const candidates = this.buildEnvironmentCandidates(environment);
    if (!candidates.length) return null;
    return (
      segments.find((segment: any) => {
        const key = this.normalizeEnvironmentKey(segment?.key);
        const label = this.normalizeEnvironmentKey(segment?.label);
        const dimension = this.normalizeEnvironmentKey(segment?.dimension);
        if (!key || key === 'unknown') return false;
        if (dimension && !['market_regime', 'industry_regime'].includes(dimension)) return false;
        return candidates.includes(key) || candidates.includes(label);
      }) || null
    );
  }

  private findStrategyFeedbackSegment(strategyKey?: string, segments?: any[]): any | null {
    if (!Array.isArray(segments) || segments.length === 0) return null;
    const normalizedStrategy = this.normalizeEnvironmentKey(strategyKey);
    if (!normalizedStrategy) return null;
    return (
      segments.find((segment: any) => {
        const key = this.normalizeEnvironmentKey(segment?.key);
        const segmentStrategy = this.normalizeEnvironmentKey(
          segment?.strategy_key || this.extractStrategyKeyFromEnvironmentComboKey(segment?.key)
        );
        return (
          segmentStrategy === normalizedStrategy ||
          key === normalizedStrategy ||
          key.endsWith(`strategy:${normalizedStrategy}`)
        );
      }) || null
    );
  }

  private async evaluateEnvironmentEntryPolicy(
    signal: AIInvestmentSignal,
    options: {
      metadata: Record<string, any>;
      outcome_feedback_policy?: PaperTradingAutoResult['outcome_feedback_policy'];
      external_environment_policy?: Record<string, any>;
      environment_policy_snapshot_id?: string;
      loop_policy_snapshot_id?: number;
      forced?: boolean;
    }
  ): Promise<EnvironmentEntryPolicy> {
    const environment = await this.resolveEnvironmentForSignal(signal, options.metadata);
    const marketRegime = this.normalizeEnvironmentKey(environment.market_regime || 'unknown');
    const industryRegime = this.normalizeEnvironmentKey(environment.industry?.regime || 'unknown');
    const externalPolicy = asPlainObject(options.external_environment_policy);
    const externalSegments = this.resolveExternalEnvironmentSegments(environment, externalPolicy);
    const strategyKey =
      options.metadata.strategy_key ||
      asPlainObject(options.metadata.strategy_variant).strategy_key ||
      paperTradingMetaForPortfolio(options.metadata).strategy_key;
    const signalBudgetAction = normalizeBudgetActionKey(
      options.metadata.environment_strategy_budget_action ||
        options.metadata.budget_action ||
        paperTradingMetaForPortfolio(options.metadata).environment_strategy_budget_action ||
        paperTradingMetaForPortfolio(options.metadata).budget_action
    );
    const budgetActionPolicy = asPlainObject(externalPolicy.budget_action_policy);
    const externalBudgetPolicyVersion = asPlainObject(
      externalPolicy.budget_policy_version || budgetActionPolicy.version
    );
    const externalBudgetPolicyGuard = asPlainObject(
      externalBudgetPolicyVersion.underperformance_guard || budgetActionPolicy.version_guard
    );
    const externalBudgetPolicyRollbackPlan = asPlainObject(
      externalBudgetPolicyVersion.rollback_plan
    );
    const budgetActionRules = Array.isArray(budgetActionPolicy.actions)
      ? budgetActionPolicy.actions
      : [];
    const budgetActionPolicyMatch =
      signalBudgetAction !== 'no_budget_action'
        ? budgetActionRules.find(
            (item: any) =>
              normalizeBudgetActionKey(item?.key || item?.budget_action || item?.action) ===
              signalBudgetAction
          )
        : null;
    const budgetActionPolicyAlreadyApplied = Boolean(
      options.metadata.environment_strategy_budget_policy_action ||
        options.metadata.environment_strategy_budget_policy_reason ||
        options.metadata.environment_strategy_budget_policy_multiplier
    );
    const resamplePolicies = Array.isArray(externalPolicy.resample_environment_strategy_combos)
      ? externalPolicy.resample_environment_strategy_combos
      : [];
    const resamplePolicy = resamplePolicies.find((item: any) =>
      this.matchResampleEnvironmentStrategyPolicy(item, {
        environment,
        strategy_key: strategyKey,
        external_policy: externalPolicy,
        environment_policy_snapshot_id: options.environment_policy_snapshot_id,
      })
    );
    const recoveredPolicies = Array.isArray(externalPolicy.recovered_environment_strategy_combos)
      ? externalPolicy.recovered_environment_strategy_combos
      : [];
    const recoveredPolicy = recoveredPolicies.find((item: any) =>
      this.matchResampleEnvironmentStrategyPolicy(item, {
        environment,
        strategy_key: strategyKey,
        external_policy: externalPolicy,
        environment_policy_snapshot_id: options.environment_policy_snapshot_id,
      })
    );
    const extendedCooldownPolicies = Array.isArray(
      externalPolicy.extended_cooldown_environment_strategy_combos
    )
      ? externalPolicy.extended_cooldown_environment_strategy_combos
      : [];
    const extendedCooldownPolicy = extendedCooldownPolicies.find((item: any) =>
      this.matchResampleEnvironmentStrategyPolicy(item, {
        environment,
        strategy_key: strategyKey,
        external_policy: externalPolicy,
        environment_policy_snapshot_id: options.environment_policy_snapshot_id,
      })
    );
    const notes: string[] = [];
    let multiplier = 1;
    let allowEntry = true;

    if (marketRegime === 'stress') {
      multiplier *= 0.45;
      notes.push('压力市，先保护本金');
    } else if (marketRegime === 'bear') {
      multiplier *= 0.6;
      notes.push('弱势市，降低试错仓位');
    } else if (marketRegime === 'range') {
      multiplier *= 0.88;
      notes.push('震荡市，控制仓位');
    } else if (marketRegime === 'rebound') {
      multiplier *= 0.95;
      notes.push('反弹市，保持验证仓');
    } else if (marketRegime === 'bull') {
      multiplier *= 1.08;
      notes.push('强势市，小幅放大');
    } else {
      multiplier *= 0.85;
      notes.push('市场环境未知，保守入场');
    }

    if (industryRegime === 'hot') {
      multiplier *= 1.08;
      notes.push('行业强势');
    } else if (industryRegime === 'cold') {
      multiplier *= 0.65;
      notes.push('行业弱势');
    } else if (industryRegime === 'unknown') {
      multiplier *= 0.92;
      notes.push('行业环境未知');
    }

    if (externalSegments.block) {
      allowEntry = false;
      multiplier = 0;
      notes.push(`策略快照暂停 ${externalSegments.block.label || externalSegments.block.key}`);
    } else if (externalSegments.reduce) {
      const segmentMultiplier = toNumber(externalSegments.reduce.position_multiplier, 0.65);
      multiplier *= clamp(segmentMultiplier, 0.25, 0.85);
      notes.push(
        `策略快照降仓 ${externalSegments.reduce.label || externalSegments.reduce.key}：${
          externalSegments.reduce.reason || `${roundNumber(segmentMultiplier, 2)}x`
        }`
      );
    } else if (externalSegments.boost) {
      const segmentMultiplier = toNumber(externalSegments.boost.position_multiplier, 1.05);
      multiplier *= clamp(segmentMultiplier, 0.95, 1.15);
      notes.push(
        `策略快照优势 ${externalSegments.boost.label || externalSegments.boost.key}：${
          externalSegments.boost.reason || `${roundNumber(segmentMultiplier, 2)}x`
        }`
      );
    } else if (externalPolicy?.default_position_multiplier !== undefined) {
      const policyMultiplier = clamp(
        toNumber(externalPolicy.default_position_multiplier, 1),
        0.35,
        1.15
      );
      multiplier *= policyMultiplier;
      notes.push(`策略快照环境默认倍率 ${roundNumber(policyMultiplier, 2)}x`);
    }

    const blockedFeedbackSegments = options.outcome_feedback_policy?.blocked_segments || [];
    const weakFeedbackSegments = [
      ...blockedFeedbackSegments,
      ...(options.outcome_feedback_policy?.weak_segments || []),
    ];
    const preferredFeedbackSegments = [
      ...(options.outcome_feedback_policy?.preferred_segments || []),
      ...(options.outcome_feedback_policy?.best_segments || []),
    ];
    const weakSegment = this.findEnvironmentFeedbackSegment(environment, weakFeedbackSegments);
    const preferredSegment = this.findEnvironmentFeedbackSegment(
      environment,
      preferredFeedbackSegments
    );
    const recoveredStrategySegment = this.findStrategyFeedbackSegment(
      strategyKey,
      options.outcome_feedback_policy?.recovered_segments || []
    );
    const extendedCooldownStrategySegment = this.findStrategyFeedbackSegment(
      strategyKey,
      options.outcome_feedback_policy?.extended_cooldown_segments || []
    );

    if (weakSegment) {
      const robustScore = toNumber(weakSegment.robust_score, 0);
      const avgExcess = toNumber(weakSegment.avg_excess_return_pct, 0);
      const riskAdjustedExcess = toNumber(weakSegment.risk_adjusted_excess_return_pct, 0);
      const bayesianWinRate = toNumber(weakSegment.bayesian_win_rate, 50);
      const excessWinRate = toNumber(weakSegment.excess_win_rate, 50);
      const closedCount = toNumber(weakSegment.closed_count, 0);
      const isBlockedSegment = blockedFeedbackSegments.some(
        (segment: any) =>
          this.normalizeEnvironmentKey(segment?.key) ===
          this.normalizeEnvironmentKey(weakSegment.key)
      );
      const isMaterialWeak =
        isBlockedSegment ||
        (closedCount >= 2 &&
          (robustScore <= -4 ||
            riskAdjustedExcess <= -0.8 ||
            avgExcess <= -1 ||
            bayesianWinRate < 45 ||
            excessWinRate < 38));
      multiplier *= isMaterialWeak ? 0.55 : 0.85;
      notes.push(
        `历史${isMaterialWeak ? '弱' : '偏弱'}环境片段 ${
          weakSegment.label || weakSegment.key
        }：超额 ${roundNumber(avgExcess, 2)}%/${closedCount}样本`
      );
      if (
        isMaterialWeak &&
        (!options.forced ||
          (closedCount >= 3 && (robustScore <= -6 || avgExcess <= -3 || excessWinRate < 30)))
      ) {
        allowEntry = false;
      }
    } else if (preferredSegment) {
      const boost =
        toNumber(preferredSegment.closed_count, 0) >= 3 &&
        toNumber(preferredSegment.avg_excess_return_pct, 0) > 0
          ? 1.05
          : 1.02;
      multiplier *= boost;
      notes.push(`历史优势环境片段 ${preferredSegment.label || preferredSegment.key}`);
    }

    if (marketRegime === 'stress' && industryRegime === 'cold') {
      if (!options.forced) {
        allowEntry = false;
      }
      multiplier *= 0.5;
      notes.push('压力市叠加弱行业，默认禁止新开仓');
    }

    const activeExtendedCooldownSegment = extendedCooldownPolicy || extendedCooldownStrategySegment;
    const activeRecoveredSegment = recoveredPolicy || recoveredStrategySegment;

    if (activeExtendedCooldownSegment) {
      allowEntry = false;
      multiplier = 0;
      notes.unshift(
        `复采样仍跑输，延长冷却 ${activeExtendedCooldownSegment.cooldown_extension_days || 7} 天：${
          activeExtendedCooldownSegment.resample_decision_reason ||
          activeExtendedCooldownSegment.reason ||
          activeExtendedCooldownSegment.label ||
          activeExtendedCooldownSegment.key
        }`
      );
    } else if (activeRecoveredSegment) {
      const recoveryMultiplier = clamp(
        toNumber(
          activeRecoveredSegment.recommended_budget_multiplier ||
            activeRecoveredSegment.position_multiplier ||
            activeRecoveredSegment.resample_recovery_position_multiplier,
          0.58
        ),
        0.35,
        0.75
      );
      multiplier *= recoveryMultiplier;
      allowEntry = allowEntry || Boolean(options.forced);
      notes.unshift(
        `复采样跑赢，解除冷却小仓恢复 ${roundNumber(recoveryMultiplier, 2)}x：${
          activeRecoveredSegment.resample_decision_reason ||
          activeRecoveredSegment.reason ||
          activeRecoveredSegment.label ||
          activeRecoveredSegment.key
        }`
      );
    }

    if (resamplePolicy) {
      const resampleMultiplier = clamp(
        toNumber(
          resamplePolicy.recommended_budget_multiplier ||
            resamplePolicy.resample_position_multiplier,
          0.35
        ),
        0.15,
        0.45
      );
      multiplier *= resampleMultiplier;
      allowEntry = allowEntry || Boolean(options.forced);
      notes.unshift(
        `冷却期满复采样 ${resamplePolicy.label || resamplePolicy.key}：${
          resamplePolicy.resample_reason || `${roundNumber(resampleMultiplier, 2)}x`
        }`
      );
    }

    if (budgetActionPolicyMatch) {
      const actionMultiplier = clamp(
        toNumber(budgetActionPolicyMatch.position_multiplier, 1),
        0,
        1.2
      );
      if (!budgetActionPolicyAlreadyApplied) {
        multiplier *= actionMultiplier;
      }
      if (budgetActionPolicyMatch.allow_entry === false && !options.forced) {
        allowEntry = false;
      }
      notes.unshift(
        `预算动作策略${budgetActionPolicyAlreadyApplied ? '已在候选阶段生效' : ''} ${
          budgetActionPolicyMatch.label || signalBudgetAction
        }：${budgetActionPolicyMatch.reason || `${roundNumber(actionMultiplier, 2)}x`}`
      );
    }

    if (externalBudgetPolicyGuard.action === 'protective_downgrade') {
      const guardMultiplier = clamp(
        toNumber(externalBudgetPolicyGuard.multiplier_cap, 0.82),
        0.4,
        1
      );
      multiplier *= guardMultiplier;
      notes.unshift(`预算权重保护降级：${externalBudgetPolicyGuard.reason}`);
    }

    if (externalBudgetPolicyRollbackPlan.apply) {
      const rollbackMultiplier =
        externalBudgetPolicyRollbackPlan.action === 'champion_warm_start'
          ? clamp(
              0.92 + toNumber(externalBudgetPolicyRollbackPlan.blend_weight, 0.65) * 0.08,
              0.9,
              1
            )
          : 0.9;
      multiplier *= rollbackMultiplier;
      notes.unshift(
        `预算版本回滚${
          externalBudgetPolicyRollbackPlan.action === 'champion_warm_start' ? '温启动' : ''
        }：${externalBudgetPolicyRollbackPlan.reason || '继承历史冠军权重'}`
      );
    } else if (externalBudgetPolicyRollbackPlan.blocked_by_rollback_audit) {
      multiplier *= 0.92;
      notes.unshift(
        `预算回滚审计阻断：${
          externalBudgetPolicyRollbackPlan.blocked_reason ||
          externalBudgetPolicyRollbackPlan.reason ||
          '历史回滚效果不佳'
        }`
      );
    }

    const normalizedMultiplier = roundNumber(clamp(multiplier, 0, 1.15), 2);
    const reason = [
      `${environment.market_regime_label || this.environmentMarketLabel(marketRegime)}`,
      `${environment.industry?.label || this.environmentIndustryLabel(industryRegime)}`,
      ...notes.slice(0, 3),
    ]
      .filter(Boolean)
      .join('，');

    return {
      enabled: true,
      allow_entry: allowEntry,
      position_multiplier: allowEntry ? normalizedMultiplier : 0,
      reason,
      market_regime: marketRegime || 'unknown',
      market_regime_label:
        environment.market_regime_label || this.environmentMarketLabel(marketRegime),
      industry_regime: industryRegime || 'unknown',
      industry_label: environment.industry?.label || this.environmentIndustryLabel(industryRegime),
      market_environment: environment,
      matched_segment: weakSegment || undefined,
      preferred_segment: activeRecoveredSegment || preferredSegment || undefined,
      notes,
      external_policy_snapshot_id:
        options.environment_policy_snapshot_id || externalPolicy.snapshot_id || externalPolicy.id,
      loop_policy_snapshot_id: options.loop_policy_snapshot_id,
      external_policy_reason: externalPolicy.reason,
      external_policy_match:
        externalSegments.block || externalSegments.reduce || externalSegments.boost,
      resample_match: resamplePolicy || activeRecoveredSegment,
      budget_action_policy_match: budgetActionPolicyMatch || undefined,
      budget_policy_version:
        Object.keys(externalBudgetPolicyVersion).length > 0
          ? externalBudgetPolicyVersion
          : undefined,
      budget_policy_version_guard:
        Object.keys(externalBudgetPolicyGuard).length > 0 ? externalBudgetPolicyGuard : undefined,
      budget_policy_rollback_plan:
        Object.keys(externalBudgetPolicyRollbackPlan).length > 0
          ? externalBudgetPolicyRollbackPlan
          : undefined,
    };
  }

  private resolveExternalEnvironmentSegments(
    environment: MarketEnvironmentSnapshotLike,
    policy: Record<string, any>
  ): { block?: any; reduce?: any; boost?: any } {
    if (!policy || Object.keys(policy).length === 0) return {};
    const match = (segments: any[]) => this.findEnvironmentFeedbackSegment(environment, segments);
    return {
      block: match(Array.isArray(policy.blocked_segments) ? policy.blocked_segments : []),
      reduce: match(Array.isArray(policy.reduced_segments) ? policy.reduced_segments : []),
      boost: match(Array.isArray(policy.boosted_segments) ? policy.boosted_segments : []),
    };
  }

  private environmentMarketLabel(key: string): string {
    const labels: Record<string, string> = {
      bull: '市场强势',
      bear: '市场弱势',
      range: '震荡市',
      rebound: '反弹市',
      stress: '压力市',
      unknown: '环境未知',
    };
    return labels[key] || key || '环境未知';
  }

  private environmentIndustryLabel(key: string): string {
    const labels: Record<string, string> = {
      hot: '行业强势',
      warm: '行业中性',
      cold: '行业弱势',
      unknown: '行业未知',
    };
    return labels[key] || key || '行业未知';
  }

  private matchOutcomeBlockedSegment(
    signal: AIInvestmentSignal,
    policy?: PaperTradingAutoResult['outcome_feedback_policy']
  ): any | null {
    if (!policy?.enabled || !Array.isArray(policy.blocked_segments)) return null;
    const metadata = asPlainObject(signal.metadata);
    const signalStrategyKey = String(
      metadata.strategy_key || asPlainObject(metadata.strategy_variant).strategy_key || ''
    )
      .trim()
      .toLowerCase();
    const environment = this.resolveSignalMarketEnvironment(signal, metadata);
    const environmentCandidates = this.buildEnvironmentCandidates(environment);
    const candidates = [
      signal.source_type,
      metadata.agent_session,
      metadata.style || metadata.recommendation_style,
      metadata.action_label || metadata.action,
      signal.risk_level,
      signalStrategyKey,
      ...environmentCandidates,
    ]
      .map(value =>
        String(value || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean);

    return (
      policy.blocked_segments.find((segment: any) => {
        const key = String(segment?.key || '')
          .trim()
          .toLowerCase();
        if (!key || key === 'unknown') return false;
        const segmentStrategyKey = this.normalizeEnvironmentKey(
          segment?.strategy_key || this.extractStrategyKeyFromEnvironmentComboKey(segment?.key)
        );
        if (segmentStrategyKey && segmentStrategyKey === signalStrategyKey) return segment;
        return candidates.includes(key);
      }) || null
    );
  }

  private buildTradeItemBase(signal: AIInvestmentSignal): PaperTradingAutoTradeItem {
    const metadata = asPlainObject(signal.metadata);
    const dataQuality = asPlainObject(metadata.data_quality);
    const environment = this.resolveSignalMarketEnvironment(signal, metadata);
    return {
      status: 'skipped',
      signal_id: signal.id,
      trace_url: this.buildSignalTraceUrl(signal.id),
      source_type: signal.source_type,
      source_id: signal.source_id,
      signal_date: signal.signal_date,
      symbol: signal.symbol,
      name: signal.name,
      decision: signal.normalized_decision || signal.decision,
      score: toOptionalNumber(signal.confidence_score),
      risk_level: signal.risk_level,
      action: metadata.action,
      action_label: metadata.action_label,
      stop_loss_pct: toOptionalNumber(metadata.stop_loss_pct),
      take_profit_pct: toOptionalNumber(metadata.take_profit_pct),
      target_position_pct: toOptionalNumber(metadata.suggested_position_pct),
      original_score: toOptionalNumber(metadata.original_score),
      consensus_count: toOptionalNumber(metadata.consensus_count),
      consensus_bonus: toOptionalNumber(metadata.consensus_bonus),
      consensus_variants: Array.isArray(metadata.consensus_variants)
        ? metadata.consensus_variants
        : [],
      recommendation_tier: metadata.recommendation_tier,
      recommendation_tier_label: metadata.recommendation_tier_label,
      strategy_allocation_pct: toOptionalNumber(metadata.strategy_allocation_pct),
      strategy_allocation_amount: toOptionalNumber(metadata.strategy_allocation_amount),
      strategy_max_single_trade_pct: toOptionalNumber(metadata.strategy_max_single_trade_pct),
      strategy_max_single_trade_amount: toOptionalNumber(metadata.strategy_max_single_trade_amount),
      strategy_budget_action: metadata.strategy_budget_action,
      strategy_budget_label: metadata.strategy_budget_label,
      strategy_budget_reason: metadata.strategy_budget_reason,
      strategy_budget_confidence: toOptionalNumber(metadata.strategy_budget_confidence),
      strategy_budget_discipline: asPlainObject(
        metadata.strategy_budget_discipline ||
          asPlainObject(metadata.strategy_variant).strategy_budget_discipline
      ),
      entry_risk_guard_decision: asPlainObject(
        paperTradingMetaForPortfolio(metadata).entry_risk_guard_decision
      ) as any,
      market_regime: environment.market_regime,
      market_regime_label: environment.market_regime_label,
      industry_regime: environment.industry?.regime,
      industry_label: environment.industry?.label,
      reason:
        metadata.data_quality_bucket || dataQuality.bucket
          ? `数据质量 ${metadata.data_quality_score ?? dataQuality.score ?? '--'}分/${
              metadata.data_quality_bucket || dataQuality.bucket
            }`
          : undefined,
    };
  }

  private async createBuyTrade(params: {
    portfolio: PaperTradingPortfolio;
    signal: AIInvestmentSignal;
    symbol: string;
    name: string;
    latest_price: number;
    execute_price: number;
    quantity: number;
    amount: number;
    commission: number;
    total_cost: number;
  }): Promise<PaperTradingTrade> {
    const {
      portfolio,
      symbol,
      name,
      latest_price,
      execute_price,
      quantity,
      amount,
      commission,
      total_cost,
    } = params;

    const position = await PaperTradingPosition.findOne({
      where: { portfolio_id: portfolio.id, symbol },
    });
    if (position) {
      throw new Error(`模拟盘已持有 ${symbol}，自动跟单拒绝重复加仓`);
    }

    await PaperTradingPosition.create({
      portfolio_id: portfolio.id,
      symbol,
      name,
      quantity,
      avg_cost: execute_price,
      current_price: latest_price,
      market_value: roundNumber(quantity * latest_price, 2),
      unrealized_pnl: roundNumber(quantity * latest_price - amount, 2),
    });

    const current_cash = roundNumber(toNumber(portfolio.current_cash, 0) - total_cost, 2);
    await portfolio.update({ current_cash });

    return PaperTradingTrade.create({
      portfolio_id: portfolio.id,
      symbol,
      name,
      direction: 'BUY',
      execute_price,
      quantity,
      amount,
      commission,
    });
  }

  private async createSellTrade(params: {
    portfolio: PaperTradingPortfolio;
    position: PaperTradingPosition;
    symbol: string;
    name: string;
    execute_price: number;
    quantity: number;
    amount: number;
    commission: number;
    net_revenue: number;
    realized_pnl: number;
  }): Promise<PaperTradingTrade> {
    const {
      portfolio,
      position,
      symbol,
      name,
      execute_price,
      quantity,
      amount,
      commission,
      net_revenue,
      realized_pnl,
    } = params;

    if (toNumber(position.quantity, 0) <= quantity) {
      await position.destroy();
    } else {
      const remainingQuantity = toNumber(position.quantity, 0) - quantity;
      await position.update({
        quantity: remainingQuantity,
        current_price: execute_price,
        market_value: roundNumber(remainingQuantity * execute_price, 2),
        unrealized_pnl: roundNumber(
          remainingQuantity * execute_price - toNumber(position.avg_cost, 0) * remainingQuantity,
          2
        ),
      });
    }

    await portfolio.update({
      current_cash: roundNumber(toNumber(portfolio.current_cash, 0) + net_revenue, 2),
    });

    return PaperTradingTrade.create({
      portfolio_id: portfolio.id,
      symbol,
      name,
      direction: 'SELL',
      execute_price,
      quantity,
      amount,
      commission,
      realized_pnl,
    });
  }

  private async markSignalExecuted(signal: AIInvestmentSignal, execution: Record<string, any>) {
    const metadata = asPlainObject(signal.metadata);
    const loop_run_id = signal.loop_run_id || metadata.loop_run_id || execution.loop_run_id;
    const strategyBudgetDiscipline = asPlainObject(execution.strategy_budget_discipline);
    const entryRiskGuardDecision = asPlainObject(execution.entry_risk_guard_decision);
    const executionRealityDecision = asPlainObject(execution.execution_reality_decision);
    const portfolioId = Number(execution.portfolio_id);
    const paperTrading = {
      ...paperTradingMetaForPortfolio(metadata, portfolioId),
      ...execution,
      loop_run_id,
      status: 'executed',
      executed_at: new Date().toISOString(),
      execution_source: 'paper_trading_auto_sync',
    };
    await signal.update({
      metadata: nextPaperTradingMetadata(
        {
          ...metadata,
          strategy_budget_action:
            execution.strategy_budget_action || metadata.strategy_budget_action,
          strategy_budget_label: execution.strategy_budget_label || metadata.strategy_budget_label,
          strategy_budget_reason:
            execution.strategy_budget_reason || metadata.strategy_budget_reason,
          strategy_budget_confidence:
            execution.strategy_budget_confidence || metadata.strategy_budget_confidence,
          strategy_budget_discipline:
            Object.keys(strategyBudgetDiscipline).length > 0
              ? strategyBudgetDiscipline
              : metadata.strategy_budget_discipline,
          entry_risk_guard_decision:
            Object.keys(entryRiskGuardDecision).length > 0
              ? entryRiskGuardDecision
              : metadata.entry_risk_guard_decision,
          execution_reality_decision:
            Object.keys(executionRealityDecision).length > 0
              ? executionRealityDecision
              : metadata.execution_reality_decision,
        },
        portfolioId,
        paperTrading
      ),
    });
  }

  private async markSignalClosed(signal: AIInvestmentSignal, exit: Record<string, any>) {
    const metadata = asPlainObject(signal.metadata);
    const loop_run_id =
      signal.loop_run_id ||
      metadata.loop_run_id ||
      paperTradingMetaForPortfolio(metadata, Number(exit.portfolio_id)).loop_run_id;
    const portfolioId = Number(
      exit.portfolio_id || paperTradingMetaForPortfolio(metadata).portfolio_id
    );
    const paperTrading = {
      ...paperTradingMetaForPortfolio(metadata, portfolioId),
      ...exit,
      loop_run_id,
      status: 'closed',
      closed_at: new Date().toISOString(),
      close_source: 'paper_trading_risk_check',
    };
    await signal.update({
      metadata: nextPaperTradingMetadata(metadata, portfolioId, paperTrading),
    });
  }

  private async refreshRecommendationTradeOutcome(signal_id: number) {
    try {
      const { recommendationTradeOutcomeService } = await import(
        './RecommendationTradeOutcomeService'
      );
      await recommendationTradeOutcomeService.refreshOutcomeBySignal(signal_id);
    } catch (error: any) {
      logger.warn(`推荐交易收益闭环刷新失败 signal#${signal_id}: ${error?.message || error}`);
    }
  }

  private buildSignalTraceUrl(signal_id?: number): string | undefined {
    if (!signal_id) return undefined;
    const baseUrl = String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');
    const path = `/signals/${signal_id}/trace`;
    return baseUrl ? `${baseUrl}${path}` : path;
  }
}

export const paperTradingAutomationService = new PaperTradingAutomationService();
