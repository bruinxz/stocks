import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { createHash } from 'crypto';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { AIInvestmentSignal } from '../models/AIInvestmentSignal';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { User } from '../models/User';
import { QuantSignal } from '../models/QuantSignal';
import { QuantFusionAudit } from '../models/QuantFusionAudit';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { benchmarkIndexService } from './BenchmarkIndexService';
import { paperTradingAutomationService } from '../portfolio/internal/PaperTradingAutomationService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { recommendationLoopPolicySnapshotService } from './RecommendationLoopPolicySnapshotService';
import { budgetPolicyVersionSnapshotService } from './BudgetPolicyVersionSnapshotService';
import { buildTradePolicyExplain } from './TradePolicyExplainService';
import { normalizeSymbol, extractMarket } from '../utils/stockSymbol';
import { logger } from '../utils/logger';
import {
  recommendationScorePositionKey,
  recommendationScorePositionLabel,
  recommendationStrategyKeyLabel,
} from '../utils/recommendationStrategyVariant';
// Phase 5: 自动归类 trade root_cause (10 级优先级链)
import {
  classifyTradeRootCause,
  TradeRootCauseInput,
} from './TradeRootCauseClassifier';
// Phase 5+: 自动生成事后复盘 (亏损/wrong_entry/wrong_regime 等触发)
import { tradePostmortemService } from './TradePostmortemService';
// Phase 2+: Kelly sizing 统计聚合（写新 outcome 后 invalidate 缓存）
import { strategyKellyStatsService } from './StrategyKellyStatsService';

export interface RecommendationTradeOutcomeRefreshOptions {
  user_id?: number;
  username?: string;
  portfolio_id?: number;
  portfolio_name?: string;
  initial_capital?: number;
  force_new_portfolio?: boolean;
  loop_run_id?: string;
  include_open?: boolean;
  lookback_days?: number;
  source_type?: string;
  agent_session?: string;
  signal_id?: number;
  limit?: number;
  report_to_feishu?: boolean;
  /**
   * 当 true 时, refreshPortfolioOutcomes 自动遍历所有 is_active=true PaperTradingPortfolio,
   * 对每个 portfolio 各调一次 refreshPortfolioOutcomes 并聚合结果. portfolio_name 被忽略.
   *
   * 修复 (2026-06-16): 之前 RECOMMENDATION_TRADE_OUTCOME_REFRESH cron 只跑
   * portfolio_name=AUTONOMOUS_PORTFOLIO_NAME 一个盘 (且 task 19 was is_active=false),
   * 11 个 Codex 模拟盘 67 个 open outcome 的 latest_price 建仓后从未刷新到 EOD close,
   * 导致 EV/TCA 输入数据失真 (sh.600105 真涨 9.74% 但 outcome 仍记 0%).
   */
  all_portfolios?: boolean;
}

export interface RecommendationTradeOutcomeQueryOptions
  extends RecommendationTradeOutcomeRefreshOptions {
  trade_status?: string;
  start_date?: string;
  end_date?: string;
  offset?: number;
}

export interface RecommendationTradeOutcomeOptimizationOptions
  extends RecommendationTradeOutcomeQueryOptions {
  horizons?: string[] | string;
}

export interface RecommendationTradeOutcomeSummary {
  total_count: number;
  open_count: number;
  closed_count: number;
  win_count: number;
  loss_count: number;
  excess_win_count: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_pnl: number;
  avg_total_pnl_pct: number;
  avg_closed_return_pct: number;
  avg_excess_return_pct: number;
  win_rate: number;
  excess_win_rate: number;
  payoff_ratio: number;
  profit_factor: number;
  avg_holding_days: number;
  avg_mfe_pct: number;
  avg_mae_pct: number;
  open_exposure: number;
  best_trade?: any;
  worst_trade?: any;
}

export interface RecommendationTradeOutcomeDashboard {
  generated_at: string;
  portfolio_id: number;
  user_id: number;
  filters: Record<string, any>;
  summary: RecommendationTradeOutcomeSummary;
  groups: {
    by_source_type: RecommendationTradeOutcomeBucket[];
    by_agent_session: RecommendationTradeOutcomeBucket[];
    by_style: RecommendationTradeOutcomeBucket[];
    by_action: RecommendationTradeOutcomeBucket[];
    by_risk_level: RecommendationTradeOutcomeBucket[];
    by_industry: RecommendationTradeOutcomeBucket[];
    by_consensus: RecommendationTradeOutcomeBucket[];
    by_score_position_bucket: RecommendationTradeOutcomeBucket[];
    by_strategy_key: RecommendationTradeOutcomeBucket[];
    by_market_regime: RecommendationTradeOutcomeBucket[];
    by_industry_regime: RecommendationTradeOutcomeBucket[];
    /** Phase 5+: 按 root_cause 聚合（亏损归因 dashboard 用） */
    by_root_cause: RecommendationTradeOutcomeBucket[];
    by_environment_policy_version: RecommendationTradeOutcomeBucket[];
    by_environment_strategy_combo: RecommendationTradeOutcomeBucket[];
    by_resample: RecommendationTradeOutcomeBucket[];
    by_candidate_tuning: RecommendationTradeOutcomeBucket[];
    by_budget_action: RecommendationTradeOutcomeBucket[];
    by_budget_policy_action: RecommendationTradeOutcomeBucket[];
    by_budget_policy_version: RecommendationTradeOutcomeBucket[];
    by_budget_policy_rollback: RecommendationTradeOutcomeBucket[];
  };
  outcomes: any[];
  /** Phase 5+: 策略 × 根因 交叉矩阵 — 让用户看到每种策略各种亏损/盈利原因的占比 */
  cross_strategy_root_cause?: Array<{
    strategy_key: string;
    strategy_label: string;
    total_closed: number;
    by_root_cause: Array<{
      root_cause: string;
      root_cause_label: string;
      count: number;
      pct: number;
      avg_return_pct: number;
    }>;
  }>;
  feedback: {
    recommended_min_score: number;
    position_multiplier: number;
    allowed_risk_levels: string[];
    best_segments: RecommendationTradeOutcomeBucket[];
    weak_segments: RecommendationTradeOutcomeBucket[];
    insights: string[];
    next_actions: string[];
  };
}

export interface RecommendationTradeOutcomeBucket {
  key: string;
  label: string;
  count: number;
  open_count: number;
  closed_count: number;
  tracked_count?: number;
  win_rate: number;
  excess_win_rate: number;
  avg_return_pct: number;
  avg_excess_return_pct: number;
  total_pnl: number;
  profit_factor: number;
  avg_holding_days: number;
  best_symbol?: string;
  best_name?: string;
  best_return_pct?: number;
  worst_symbol?: string;
  worst_name?: string;
  worst_return_pct?: number;
  avg_consensus_count?: number;
  avg_consensus_bonus?: number;
  dimension?: string;
  auto_action?: string;
  confidence?: number;
  robust_score?: number;
  sample_confidence?: number;
  bayesian_win_rate?: number;
  return_volatility_pct?: number;
  drawdown_penalty?: number;
  risk_adjusted_excess_return_pct?: number;
  avg_position_pct?: number;
  avg_entry_amount?: number;
  total_entry_amount?: number;
  pnl_per_10k?: number;
  excess_per_position_pct?: number;
  capital_efficiency_score?: number;
  budget_action?: 'increase' | 'reduce' | 'observe' | 'pause';
  budget_action_reason?: string;
  recommended_budget_multiplier?: number;
  takeover_ready?: boolean;
  takeover_reason?: string;
  cooldown_active?: boolean;
  cooldown_reason?: string;
  recent_loss_streak?: number;
  cooldown_days?: number;
  resample_ready?: boolean;
  resample_reason?: string;
  resample_position_multiplier?: number;
  resample_closed_count?: number;
  resample_avg_excess_return_pct?: number;
  resample_win_rate?: number;
  resample_excess_win_rate?: number;
  resample_total_pnl?: number;
  resample_profit_factor?: number;
  resample_decision?: 'promote' | 'continue_sampling' | 'cooldown' | 'observe';
  resample_decision_reason?: string;
  resample_recovery_ready?: boolean;
  resample_recovery_position_multiplier?: number;
  cooldown_extended?: boolean;
  cooldown_extension_days?: number;
  cooldown_expires_at?: string;
  resample_policy_action?:
    | 'recover_small'
    | 'extend_cooldown'
    | 'continue_resample'
    | 'observe'
    | 'none';
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

function paperTradingEntries(metadata: Record<string, any>): Record<string, any>[] {
  const byPortfolio = asPlainObject(metadata.paper_trading_by_portfolio);
  const entries = Object.values(byPortfolio)
    .map(item => asPlainObject(item))
    .filter(item => Object.keys(item).length > 0);
  const legacy = asPlainObject(metadata.paper_trading);
  if (Object.keys(legacy).length > 0) {
    const legacyPortfolioId = Number(legacy.portfolio_id);
    const exists = entries.some(item => Number(item.portfolio_id) === legacyPortfolioId);
    if (!exists) entries.push(legacy);
  }
  return entries;
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: any, length = 12): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, length);
}

function getChinaToday(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function consensusGroupKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const consensusCount = toNumber(signalMetadata.consensus_count, 0);
  if (consensusCount >= 4) return 'consensus_4_plus';
  if (consensusCount === 3) return 'consensus_3';
  if (consensusCount === 2) return 'consensus_2';
  return 'no_consensus';
}

function consensusGroupLabel(key: string): string {
  const labels: Record<string, string> = {
    consensus_4_plus: '4组以上共识',
    consensus_3: '3组共识',
    consensus_2: '2组共识',
    no_consensus: '无显式共识',
  };
  return labels[key] || key;
}

function marketRegimeKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const env =
    asPlainObject(metadata.market_environment).market_regime ||
    asPlainObject(signalMetadata.market_environment).market_regime;
  return String(env || 'unknown');
}

function marketRegimeLabel(key: string): string {
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

/**
 * Phase 5+: trade root_cause → 中文标签。
 * 与 TradeRootCauseClassifier.ROOT_CAUSE_LABELS 严格对齐 (10 种)。
 */
function rootCauseLabel(key: string): string {
  const labels: Record<string, string> = {
    profit_take: '止盈出场',
    stop_loss: '止损触发',
    time_stop: '持仓超期',
    wrong_entry: '入场时机不佳',
    wrong_regime: '市场环境切换',
    catalyst_failed: '催化兑现失败',
    data_quality: '数据异常',
    backtest_drift: '实盘偏离回测',
    risk_kill_switch: '风控熔断',
    unknown: '未归类',
    unclassified: '未归类',
  };
  return labels[key] || key || '未归类';
}

function industryRegimeKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const industry =
    asPlainObject(asPlainObject(metadata.market_environment).industry).regime ||
    asPlainObject(asPlainObject(signalMetadata.market_environment).industry).regime;
  return String(industry || 'unknown');
}

function industryRegimeLabel(key: string): string {
  const labels: Record<string, string> = {
    hot: '行业强势',
    warm: '行业中性',
    cold: '行业弱势',
    unknown: '行业未知',
  };
  return labels[key] || key || '行业未知';
}

function environmentPolicyVersionKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const environmentPolicy = asPlainObject(
    metadata.environment_policy ||
      signalMetadata.environment_policy ||
      paperTrading.environment_policy ||
      asPlainObject(signalMetadata.paper_trading).environment_policy
  );
  return String(
    metadata.environment_policy_snapshot_id ||
      signalMetadata.environment_policy_snapshot_id ||
      paperTrading.environment_policy_snapshot_id ||
      environmentPolicy.external_policy_snapshot_id ||
      environmentPolicy.snapshot_id ||
      environmentPolicy.id ||
      'unknown'
  );
}

function environmentPolicyVersionLabel(key: string): string {
  if (!key || key === 'unknown') return '环境版本未知';
  const parts = String(key).split('_env_');
  if (parts.length >= 2) return `环境闸门 ${parts[1]}`;
  return key;
}

function strategyKeyFromOutcome(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  return (
    metadata.strategy_key ||
    signalMetadata.strategy_key ||
    asPlainObject(signalMetadata.strategy_variant).strategy_key ||
    paperTrading.strategy_key ||
    asPlainObject(paperTrading.strategy_variant).strategy_key ||
    'unknown'
  );
}

function environmentStrategyComboKey(record: RecommendationTradeOutcome): string {
  return `env:${environmentPolicyVersionKey(record)}|strategy:${strategyKeyFromOutcome(record)}`;
}

function environmentStrategyComboLabel(key: string): string {
  const envMatch = String(key || '').match(/env:([^|]+)/);
  const strategyMatch = String(key || '').match(/strategy:(.+)$/);
  const envKey = envMatch?.[1] || 'unknown';
  const strategyKey = strategyMatch?.[1] || 'unknown';
  return `${environmentPolicyVersionLabel(envKey)} × ${recommendationStrategyKeyLabel(
    strategyKey
  )}`;
}

function isResampleOutcome(record: RecommendationTradeOutcome): boolean {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const environmentPolicy = asPlainObject(
    metadata.environment_policy ||
      paperTrading.environment_policy ||
      signalMetadata.environment_policy ||
      asPlainObject(signalMetadata.paper_trading).environment_policy
  );
  return Boolean(
    metadata.resample_sample ||
      paperTrading.resample_sample ||
      signalMetadata.resample_sample ||
      environmentPolicy.resample_match ||
      metadata.resample_match ||
      paperTrading.resample_match
  );
}

function resampleGroupKey(record: RecommendationTradeOutcome): string {
  return isResampleOutcome(record) ? 'resample' : 'normal';
}

function resampleGroupLabel(key: string): string {
  return key === 'resample' ? '冷却复采样' : '常规推荐';
}

function candidateTuningKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  return String(
    metadata.environment_strategy_policy_action ||
      signalMetadata.environment_strategy_policy_action ||
      paperTrading.environment_strategy_policy_action ||
      'no_tuning'
  );
}

function candidateTuningLabel(key: string): string {
  const labels: Record<string, string> = {
    recovered: '源头恢复优先',
    extended_cooldown: '源头延长冷却',
    resample: '源头复采样',
    no_tuning: '未调权候选',
  };
  return labels[key] || key || '未调权候选';
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

function budgetActionKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const explicit =
    metadata.environment_strategy_budget_action ||
    signalMetadata.environment_strategy_budget_action ||
    paperTrading.environment_strategy_budget_action ||
    metadata.budget_action ||
    signalMetadata.budget_action ||
    paperTrading.budget_action;
  if (explicit) return normalizeBudgetActionKey(explicit);

  const policyAction = candidateTuningKey(record);
  if (policyAction !== 'no_tuning') return normalizeBudgetActionKey(policyAction);

  const multiplier = toOptionalNumber(
    metadata.environment_strategy_budget_multiplier ??
      signalMetadata.environment_strategy_budget_multiplier ??
      paperTrading.environment_strategy_budget_multiplier ??
      metadata.recommended_budget_multiplier ??
      signalMetadata.recommended_budget_multiplier ??
      paperTrading.recommended_budget_multiplier
  );
  if (multiplier !== undefined) {
    if (multiplier <= 0.05) return 'pause';
    if (multiplier < 0.65) return 'reduce';
    if (multiplier > 1.03) return 'increase';
    return 'observe';
  }
  return 'no_budget_action';
}

function budgetActionLabel(key: string): string {
  const labels: Record<string, string> = {
    increase: '加预算执行',
    reduce: '降权执行',
    pause: '暂停/冷却执行',
    observe: '小仓观察执行',
    no_budget_action: '未纳入预算动作',
  };
  return labels[key] || key || '未纳入预算动作';
}

function budgetPolicyActionKey(record: RecommendationTradeOutcome | any): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  return String(
    metadata.environment_strategy_budget_policy_action ||
      signalMetadata.environment_strategy_budget_policy_action ||
      paperTrading.environment_strategy_budget_policy_action ||
      'no_policy_execution'
  );
}

function budgetPolicyActionLabel(key: string): string {
  const labels: Record<string, string> = {
    collect_samples: '收集样本执行',
    scale_up: '放大执行',
    cap_increase: '限制放大执行',
    verify: '验证执行',
    promote_from_observe: '观察升档执行',
    sample_smaller: '缩小试错执行',
    keep_observe: '继续观察执行',
    keep_defensive: '防守跟随执行',
    tighten_reduce: '继续压仓执行',
    reopen_small: '小仓重开执行',
    keep_paused: '继续暂停执行',
    no_policy_execution: '未执行预算策略',
  };
  return labels[key] || key || '未执行预算策略';
}

function budgetPolicyVersionKey(record: RecommendationTradeOutcome | any): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  return String(
    metadata.environment_strategy_budget_policy_version_id ||
      signalMetadata.environment_strategy_budget_policy_version_id ||
      paperTrading.environment_strategy_budget_policy_version_id ||
      metadata.budget_policy_version_id ||
      signalMetadata.budget_policy_version_id ||
      paperTrading.budget_policy_version_id ||
      'no_budget_policy_version'
  );
}

function budgetPolicyVersionLabel(key: string): string {
  if (!key || key === 'no_budget_policy_version') return '未记录预算权重版本';
  return `预算权重 ${key}`;
}

function budgetPolicyRollbackKey(record: RecommendationTradeOutcome | any): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const rollbackAction =
    metadata.environment_strategy_budget_policy_rollback_action ||
    signalMetadata.environment_strategy_budget_policy_rollback_action ||
    paperTrading.environment_strategy_budget_policy_rollback_action ||
    metadata.budget_policy_rollback_action ||
    signalMetadata.budget_policy_rollback_action ||
    paperTrading.budget_policy_rollback_action;
  const rollbackSource =
    metadata.environment_strategy_budget_policy_rollback_source ||
    signalMetadata.environment_strategy_budget_policy_rollback_source ||
    paperTrading.environment_strategy_budget_policy_rollback_source ||
    metadata.budget_policy_rollback_source ||
    signalMetadata.budget_policy_rollback_source ||
    paperTrading.budget_policy_rollback_source;
  if (!rollbackAction && !rollbackSource) return 'no_budget_policy_rollback';
  if (
    rollbackAction &&
    !['protective_rollback', 'champion_warm_start', 'rollback'].includes(String(rollbackAction))
  ) {
    return 'no_budget_policy_rollback';
  }
  return `${rollbackAction || 'rollback'}:${rollbackSource || 'unknown'}`;
}

function budgetPolicyRollbackLabel(key: string): string {
  if (!key || key === 'no_budget_policy_rollback') return '未触发预算版本回滚';
  const [action, source] = key.split(':');
  const labels: Record<string, string> = {
    protective_rollback: '保护回滚',
    champion_warm_start: '冠军温启动',
    rollback: '版本回滚',
  };
  return `${labels[action] || action} · ${source || 'unknown'}`;
}

function dateOnly(value?: Date | string | null): string {
  if (!value) return getChinaToday();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return moment(date).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function normalizeHorizonList(
  value?: string[] | string,
  fallback = ['1d', '3d', '5d', '10d', '20d']
) {
  const raw = Array.isArray(value) ? value : value ? String(value).split(',') : fallback;
  const normalized = raw
    .map(item => {
      const days = Number(String(item).replace(/[^\d]/g, ''));
      return Number.isFinite(days) && days > 0 ? `${days}d` : '';
    })
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : fallback;
}

function holdingDays(start?: Date | string | null, end?: Date | string | null): number {
  if (!start) return 0;
  const startMoment = moment(start).tz('Asia/Shanghai');
  const endMoment = end ? moment(end).tz('Asia/Shanghai') : moment().tz('Asia/Shanghai');
  if (!startMoment.isValid() || !endMoment.isValid()) return 0;
  return Math.max(0, endMoment.diff(startMoment, 'days'));
}

function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function standardDeviation(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (valid.length <= 1) return 0;
  const mean = average(valid);
  const variance = average(valid.map(value => (value - mean) ** 2));
  return Math.sqrt(Math.max(0, variance));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeDateWindow(startDate: string, endDate: string): { start: Date; end: Date } {
  return {
    start: new Date(`${startDate}T00:00:00.000Z`),
    end: new Date(`${endDate}T23:59:59.999Z`),
  };
}

function modelToPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function buildPolicyExplainForOutcome(record: RecommendationTradeOutcome | any): any {
  const outcomePlain = modelToPlain<any>(record);
  const metadata = asPlainObject(outcomePlain?.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = paperTradingMetaForPortfolio(
    Object.keys(signalMetadata).length ? signalMetadata : metadata,
    outcomePlain?.portfolio_id
  );

  return buildTradePolicyExplain({
    outcome: outcomePlain,
    metadata,
    signalMetadata,
    paperTrading,
    strategyKey: strategyKeyFromOutcome(outcomePlain as RecommendationTradeOutcome),
  });
}

function sourceTypeLabel(value?: string): string {
  const labels: Record<string, string> = {
    quant_recommendation: '量化候选',
    tradingagents: 'TradingAgents',
    daily_screener: 'AI每日优选',
    manual_analysis: '手动分析',
  };
  return labels[String(value || '')] || value || '未标注';
}

function styleLabel(value?: string): string {
  const labels: Record<string, string> = {
    balanced: '均衡',
    momentum: '动量',
    value: '价值',
    low_risk: '低风险',
  };
  return labels[String(value || '')] || value || '未标注';
}

function riskLabel(value?: string): string {
  const labels: Record<string, string> = {
    low: '低风险',
    medium: '中风险',
    high: '高风险',
  };
  return labels[String(value || '')] || value || '未标注';
}

function agentSessionLabel(value?: string): string {
  const labels: Record<string, string> = {
    close: '尾盘/收盘',
    midday: '午盘',
    morning: '早盘',
  };
  return labels[String(value || '')] || value || '未标注';
}

export class RecommendationTradeOutcomeService {
  async refreshOutcomeBySignal(
    signal_id: number,
    options: { report_to_feishu?: boolean } = {}
  ): Promise<RecommendationTradeOutcome | null> {
    const signal = await AIInvestmentSignal.findByPk(signal_id);
    if (!signal) return null;

    const entries = paperTradingEntries(asPlainObject(signal.metadata));
    const latestPaperTrading = entries
      .filter(item => item.portfolio_id)
      .sort((a, b) =>
        String(b.executed_at || b.closed_at || '').localeCompare(
          String(a.executed_at || a.closed_at || '')
        )
      )[0];
    if (!latestPaperTrading?.portfolio_id) return null;

    const outcome = await this.upsertFromExecutedSignal(signal, {
      include_open: true,
      portfolio_id: Number(latestPaperTrading.portfolio_id),
    });

    if (outcome && options.report_to_feishu) {
      await feishuTaskReportService.reportRecommendationTradeOutcomes(
        await this.getDashboard({ portfolio_id: outcome.portfolio_id, include_open: true }),
        { record_type: '推荐交易收益闭环刷新' }
      );
    }

    return outcome;
  }

  async refreshPortfolioOutcomes(options: RecommendationTradeOutcomeRefreshOptions = {}): Promise<{
    portfolio_id: number;
    user_id: number;
    refreshed: number;
    created_or_updated: number;
    skipped: number;
    failed: number;
    outcomes: RecommendationTradeOutcome[];
    dashboard: RecommendationTradeOutcomeDashboard;
  }> {
    // ============= all_portfolios fan-out =============
    // 当 cron 配置 all_portfolios=true 时, 对每个 is_active=true portfolio 各跑一次
    // refreshPortfolioOutcomes 并聚合 counts. portfolio_name / portfolio_id 被忽略.
    // 这是 latest_price 永不刷新 bug 的修复关键路径.
    if (toBoolean(options.all_portfolios, false)) {
      const allPortfolios = await PaperTradingPortfolio.findAll({
        where: { is_active: true },
        order: [['id', 'ASC']],
      });
      const aggregated = {
        portfolio_id: 0,
        user_id: 0,
        refreshed: 0,
        created_or_updated: 0,
        skipped: 0,
        failed: 0,
        outcomes: [] as RecommendationTradeOutcome[],
        // dashboard 在 all_portfolios 模式下没有 single-portfolio 语义, 返回空 dashboard
        dashboard: {
          portfolio_id: 0,
          total_trades: 0,
          open_trades: 0,
          closed_trades: 0,
          total_unrealized_pnl: 0,
          total_realized_pnl: 0,
          total_pnl: 0,
          win_rate: 0,
          avg_total_pnl_pct: 0,
          avg_closed_return_pct: 0,
          avg_excess_return_pct: 0,
          excess_win_rate: 0,
          payoff_ratio: 0,
          profit_factor: 0,
          updated_at: new Date().toISOString(),
        } as unknown as RecommendationTradeOutcomeDashboard,
      };
      for (const port of allPortfolios) {
        try {
          const single = await this.refreshPortfolioOutcomes({
            ...options,
            all_portfolios: false,
            user_id: port.user_id,
            portfolio_id: port.id,
            portfolio_name: undefined,
            force_new_portfolio: false,
            // 关闭逐 portfolio 飞书通知, 避免 N 个 portfolio 一次推 N 条
            report_to_feishu: false,
          });
          aggregated.refreshed += single.refreshed;
          aggregated.created_or_updated += single.created_or_updated;
          aggregated.skipped += single.skipped;
          aggregated.failed += single.failed;
          aggregated.outcomes.push(...single.outcomes);
        } catch (error: any) {
          logger.warn(
            `refreshPortfolioOutcomes all_portfolios: portfolio ${port.id} (${port.name}) 失败: ${
              error?.message || error
            }`
          );
        }
      }
      logger.info(
        `refreshPortfolioOutcomes all_portfolios 完成: ${allPortfolios.length} portfolios, ` +
          `refreshed=${aggregated.refreshed} created_or_updated=${aggregated.created_or_updated} ` +
          `failed=${aggregated.failed}`
      );
      return aggregated;
    }

    const includeOpen = toBoolean(options.include_open, true);
    const limit = toPositiveInt(options.limit, 2000, 10000);
    const lookbackDays = toPositiveInt(options.lookback_days, 180, 3650);
    const portfolio = await this.resolvePortfolio(options);

    if (includeOpen) {
      await paperTradingAutomationService.syncLatestPricesAndSnapshot(portfolio.id);
    }

    const signalWhere: any = {};
    if (options.signal_id) signalWhere.id = options.signal_id;
    if (options.source_type && options.source_type !== 'all')
      signalWhere.source_type = options.source_type;
    if (options.agent_session) {
      signalWhere.metadata = { [Op.contains]: { agent_session: options.agent_session } };
    }
    if (lookbackDays > 0 && !options.signal_id) {
      signalWhere.signal_date = {
        [Op.gte]: moment().tz('Asia/Shanghai').subtract(lookbackDays, 'days').format('YYYY-MM-DD'),
      };
    }

    const candidateSignals = await AIInvestmentSignal.findAll({
      where: signalWhere,
      order: [
        ['updated_at', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
    });

    const signals = candidateSignals.filter(signal => {
      const paperTrading = paperTradingMetaForPortfolio(
        asPlainObject(signal.metadata),
        portfolio.id
      );
      const status = String(paperTrading.status || '');
      return (
        Number(paperTrading.portfolio_id) === Number(portfolio.id) &&
        ['executed', 'closing', 'closed'].includes(status)
      );
    });

    const outcomes: RecommendationTradeOutcome[] = [];
    let failed = 0;
    let skipped = 0;

    for (const signal of signals) {
      try {
        const outcome = await this.upsertFromExecutedSignal(signal, {
          include_open: includeOpen,
          portfolio_id: portfolio.id,
        });
        if (outcome) outcomes.push(outcome);
        else skipped++;
      } catch (error: any) {
        failed++;
        logger.warn(
          `刷新推荐交易收益闭环失败 signal#${signal.id} ${signal.symbol}: ${
            error?.message || error
          }`
        );
      }
    }

    const dashboard = await this.getDashboard({
      ...options,
      portfolio_id: portfolio.id,
      include_open: includeOpen,
      report_to_feishu: false,
    });

    const result = {
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      refreshed: signals.length,
      created_or_updated: outcomes.length,
      skipped,
      failed,
      outcomes,
      dashboard,
    };

    if (toBoolean(options.report_to_feishu, false)) {
      await feishuTaskReportService.reportRecommendationTradeOutcomes(dashboard, {
        record_type: '推荐交易收益闭环刷新',
      });
    }

    const loopRunIds = Array.from(
      new Set(
        outcomes
          .map(outcome => outcome.loop_run_id)
          .filter((value): value is string => Boolean(value))
      )
    );
    if (loopRunIds.length > 0) {
      await recommendationLoopPolicySnapshotService.refreshOutcomeMetrics({
        loop_run_ids: loopRunIds,
        limit: Math.max(loopRunIds.length, 1),
      });
    }

    return result;
  }

  async listOutcomes(options: RecommendationTradeOutcomeQueryOptions = {}) {
    const portfolio = await this.resolvePortfolio(options);
    const limit = toPositiveInt(options.limit, 50, 500);
    const offset = Math.max(0, Number(options.offset || 0));
    const where = this.buildOutcomeWhere({ ...options, portfolio_id: portfolio.id });

    const { rows, count } = await RecommendationTradeOutcome.findAndCountAll({
      where,
      order: [
        ['trade_status', 'ASC'],
        ['exit_date', 'DESC NULLS LAST'],
        ['entry_date', 'DESC NULLS LAST'],
        ['updated_at', 'DESC'],
      ] as any,
      limit,
      offset,
    });

    return {
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      rows,
      count,
      limit,
      offset,
      summary: this.buildSummary(rows),
    };
  }

  async getTrace(
    id_or_signal_id: number | string,
    options: RecommendationTradeOutcomeQueryOptions = {}
  ) {
    const portfolio = await this.resolvePortfolio(options);
    const idText = String(id_or_signal_id || '').trim();
    const idNumber = Number(idText);
    const baseWhere: any = { portfolio_id: portfolio.id };
    if (Number.isFinite(idNumber) && idNumber > 0) {
      baseWhere[Op.or] = [{ id: idNumber }, { signal_id: idNumber }];
    } else {
      baseWhere.source_id = idText;
    }

    let outcome = await RecommendationTradeOutcome.findOne({ where: baseWhere });
    if (!outcome && Number.isFinite(idNumber) && idNumber > 0) {
      const refreshed = await this.refreshOutcomeBySignal(idNumber).catch(error => {
        logger.warn(`按 signal_id 刷新推荐链路失败 ${idNumber}: ${error?.message || error}`);
        return null;
      });
      if (refreshed && Number(refreshed.portfolio_id) === Number(portfolio.id)) outcome = refreshed;
    }
    if (!outcome) return null;

    const signal = await AIInvestmentSignal.findByPk(outcome.signal_id);
    const metadata = asPlainObject(outcome.metadata);
    const signalMetadata = asPlainObject(metadata.signal_metadata || signal?.metadata);
    const paperTrading = paperTradingMetaForPortfolio(
      Object.keys(signalMetadata).length ? signalMetadata : metadata,
      outcome.portfolio_id
    );
    const strategyKey = strategyKeyFromOutcome(outcome);
    const tradeIds = [
      toOptionalNumber(outcome.entry_trade_id),
      toOptionalNumber(outcome.exit_trade_id),
    ].filter((value): value is number => Boolean(value));
    const trades = tradeIds.length
      ? await PaperTradingTrade.findAll({
          where: { id: { [Op.in]: tradeIds }, portfolio_id: portfolio.id },
          order: [['created_at', 'ASC']],
        })
      : [];
    const quantSignals = await QuantSignal.findAll({
      where: {
        symbol: outcome.symbol,
        trade_date: outcome.signal_date,
        ...(strategyKey && strategyKey !== 'unknown' ? { strategy_key: strategyKey } : {}),
      },
      order: [['score', 'DESC']],
      limit: 8,
    }).catch(() => []);
    const fusionAudits = await QuantFusionAudit.findAll({
      where: {
        symbol: outcome.symbol,
        signal_date: outcome.signal_date,
      },
      order: [
        ['final_score', 'DESC NULLS LAST'],
        ['created_at', 'DESC'],
      ] as any,
      limit: 8,
    }).catch(() => []);
    const taskLogs = await TaskExecutionLog.findAll({
      where: {
        started_at: {
          [Op.between]: [
            moment.tz(`${outcome.signal_date} 00:00`, 'YYYY-MM-DD HH:mm', 'Asia/Shanghai').toDate(),
            moment
              .tz(`${outcome.signal_date} 23:59:59`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai')
              .toDate(),
          ],
        },
        [Op.or]: [
          { task_name: { [Op.iLike]: '%量化%' } },
          { task_name: { [Op.iLike]: '%荐股%' } },
          { task_name: { [Op.iLike]: '%模拟盘%' } },
          { task_name: { [Op.iLike]: '%Agent%' } },
        ],
      },
      order: [['started_at', 'ASC']],
      limit: 20,
    }).catch(() => []);

    const outcomePlain = modelToPlain<any>(outcome);
    const signalPlain = modelToPlain<any>(signal);
    const tradesPlain = trades.map(trade => modelToPlain<any>(trade));
    const quantSignalPlain = quantSignals.map(item => modelToPlain<any>(item));
    const fusionAuditPlain = fusionAudits.map(item => modelToPlain<any>(item));
    const taskLogPlain = taskLogs.map(item => modelToPlain<any>(item));
    const policyExplain = buildTradePolicyExplain({
      outcome: outcomePlain,
      metadata,
      signalMetadata,
      paperTrading,
      strategyKey,
    });
    const traceId = outcome.signal_id ? `signal:${outcome.signal_id}` : `outcome:${outcome.id}`;
    const traceUrl = this.buildTraceUrl(outcome);
    const conclusion = this.buildTraceConclusion(outcome);
    const keyEvidence = this.buildTraceKeyEvidence({
      outcome,
      signal,
      metadata,
      signalMetadata,
      paperTrading,
      quantSignals,
      fusionAudits,
      trades,
      taskLogs,
      strategyKey,
    });
    const summary = this.buildTraceSummary({
      outcome,
      signal,
      metadata,
      signalMetadata,
      paperTrading,
      quantSignals,
      fusionAudits,
      taskLogs,
      strategyKey,
      traceUrl,
      traceId,
      conclusion,
      keyEvidence,
    });
    const decisionContext = this.buildTraceDecisionContext({
      outcome,
      metadata,
      signalMetadata,
      paperTrading,
      strategyKey,
      quantSignals,
      fusionAudits,
    });

    const steps = [
      {
        key: 'signal',
        title: '信号生成',
        status: signal ? 'finish' : 'warning',
        at: signal?.created_at || outcome.created_at,
        evidence: {
          signal_id: outcome.signal_id,
          source_type: outcome.source_type,
          source_id: outcome.source_id,
          decision: outcome.decision,
          score: outcome.score,
          current_price: signal?.current_price,
          rationale: signal?.rationale,
        },
      },
      {
        key: 'quant',
        title: '量化评分',
        status: quantSignals.length ? 'finish' : 'wait',
        at: quantSignals[0]?.created_at,
        evidence: quantSignals.map(item => ({
          id: item.id,
          strategy_key: item.strategy_key,
          signal: item.signal,
          score: item.score,
          confidence: item.confidence,
          entry_price: item.entry_price,
          reason: item.reason,
          risk_flags: item.risk_flags,
        })),
      },
      {
        key: 'agent',
        title: 'Agent/融合复核',
        status: fusionAudits.length || outcome.source_type === 'tradingagents' ? 'finish' : 'wait',
        at: fusionAudits[0]?.created_at,
        evidence: fusionAudits.map(item => ({
          id: item.id,
          quant_score: item.quant_score,
          agent_score: item.agent_score,
          final_score: item.final_score,
          final_decision: item.final_decision,
          risk_level: item.risk_level,
          current_price: item.current_price,
          rationale: item.rationale,
        })),
      },
      {
        key: 'risk',
        title: '风控放行',
        status: outcome.entry_price ? 'finish' : 'wait',
        at: outcome.entry_date,
        evidence: {
          risk_level: outcome.risk_level,
          position_pct: outcome.position_pct,
          strategy_key: strategyKey,
          environment_policy: metadata.environment_policy,
          paper_trading: paperTrading,
        },
      },
      {
        key: 'entry',
        title: '模拟买入',
        status: outcome.entry_trade_id ? 'finish' : 'wait',
        at: outcome.entry_date,
        evidence: trades
          .filter(trade => trade.direction === 'BUY')
          .map(trade => modelToPlain(trade)),
      },
      {
        key: 'exit',
        title: outcome.trade_status === 'closed' ? '卖出闭环' : '持仓跟踪',
        status: outcome.trade_status === 'closed' ? 'finish' : 'process',
        at: outcome.exit_date || outcome.updated_at,
        evidence:
          outcome.trade_status === 'closed'
            ? trades.filter(trade => trade.direction === 'SELL').map(trade => modelToPlain(trade))
            : {
                latest_price: outcome.latest_price,
                holding_days: outcome.holding_days,
                unrealized_pnl: outcome.unrealized_pnl,
                unrealized_pnl_pct: outcome.unrealized_pnl_pct,
              },
      },
    ];

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      trace_id: traceId,
      trace_url: traceUrl,
      outcome: outcomePlain,
      signal: signalPlain,
      trades: tradesPlain,
      quant_signals: quantSignalPlain,
      fusion_audits: fusionAuditPlain,
      task_logs: taskLogPlain,
      steps,
      summary,
      policy_explain: policyExplain,
      key_evidence: keyEvidence,
      decision_context: decisionContext,
      conclusion,
    };
  }

  async getDashboard(
    options: RecommendationTradeOutcomeQueryOptions = {}
  ): Promise<RecommendationTradeOutcomeDashboard> {
    const portfolio = await this.resolvePortfolio(options);
    const includeOpen = toBoolean(options.include_open, true);

    if (includeOpen) {
      try {
        await paperTradingAutomationService.syncLatestPricesAndSnapshot(portfolio.id);
      } catch (error: any) {
        logger.warn(`收益闭环看板刷新模拟盘快照失败: ${error?.message || error}`);
      }
    }

    const limit = toPositiveInt(options.limit, 2000, 10000);
    const where = this.buildOutcomeWhere({ ...options, portfolio_id: portfolio.id });
    if (!includeOpen) where.trade_status = 'closed';

    const outcomes = await RecommendationTradeOutcome.findAll({
      where,
      order: [
        ['trade_status', 'ASC'],
        ['exit_date', 'DESC NULLS LAST'],
        ['entry_date', 'DESC NULLS LAST'],
        ['updated_at', 'DESC'],
      ] as any,
      limit,
    });

    const summary = this.buildSummary(outcomes);
    const groups = {
      by_source_type: this.buildBuckets(outcomes, item => item.source_type, sourceTypeLabel),
      by_agent_session: this.buildBuckets(outcomes, item => item.agent_session, agentSessionLabel),
      by_style: this.buildBuckets(
        outcomes,
        item => item.recommendation_style,
        value => value || '未标注',
        'style'
      ),
      by_action: this.buildBuckets(
        outcomes,
        item => item.action_label || item.action,
        value => value || '未标注'
      ),
      by_risk_level: this.buildBuckets(outcomes, item => item.risk_level, riskLabel),
      by_industry: this.buildBuckets(
        outcomes,
        item => item.industry,
        value => value || '未分类'
      ),
      by_consensus: this.buildBuckets(
        outcomes,
        item => consensusGroupKey(item),
        consensusGroupLabel
      ),
      by_score_position_bucket: this.buildBuckets(
        outcomes,
        item => recommendationScorePositionKey(item.score, item.position_pct),
        recommendationScorePositionLabel,
        'score_position'
      ),
      by_strategy_key: this.buildBuckets(
        outcomes,
        item => strategyKeyFromOutcome(item),
        recommendationStrategyKeyLabel,
        'strategy_key'
      ),
      // Phase 5+: 按 root_cause 聚合 — 让用户看到"哪种亏损/盈利原因占主导"
      by_root_cause: this.buildBuckets(
        outcomes,
        item => (item as any).root_cause || 'unclassified',
        rootCauseLabel,
        'root_cause'
      ),
      by_market_regime: this.buildBuckets(
        outcomes,
        item => marketRegimeKey(item),
        marketRegimeLabel,
        'market_regime'
      ),
      by_industry_regime: this.buildBuckets(
        outcomes,
        item => industryRegimeKey(item),
        industryRegimeLabel,
        'industry_regime'
      ),
      by_environment_policy_version: this.buildBuckets(
        outcomes,
        item => environmentPolicyVersionKey(item),
        environmentPolicyVersionLabel,
        'environment_policy_version'
      ),
      by_environment_strategy_combo: this.buildBuckets(
        outcomes,
        item => environmentStrategyComboKey(item),
        environmentStrategyComboLabel,
        'environment_strategy_combo'
      ).sort(
        (a, b) =>
          Number(Boolean(b.takeover_ready)) - Number(Boolean(a.takeover_ready)) ||
          toNumber(b.capital_efficiency_score) - toNumber(a.capital_efficiency_score) ||
          toNumber(b.robust_score) - toNumber(a.robust_score) ||
          b.avg_excess_return_pct - a.avg_excess_return_pct
      ),
      by_resample: this.buildBuckets(
        outcomes,
        item => resampleGroupKey(item),
        resampleGroupLabel,
        'resample'
      ),
      by_candidate_tuning: this.buildBuckets(
        outcomes,
        item => candidateTuningKey(item),
        candidateTuningLabel,
        'candidate_tuning'
      ),
      by_budget_action: this.buildBuckets(
        outcomes,
        item => budgetActionKey(item),
        budgetActionLabel,
        'budget_action'
      ),
      by_budget_policy_action: this.buildBuckets(
        outcomes,
        item => budgetPolicyActionKey(item),
        budgetPolicyActionLabel,
        'budget_policy_action'
      ),
      by_budget_policy_version: this.buildBuckets(
        outcomes,
        item => budgetPolicyVersionKey(item),
        budgetPolicyVersionLabel,
        'budget_policy_version'
      ),
      by_budget_policy_rollback: this.buildBuckets(
        outcomes,
        item => budgetPolicyRollbackKey(item),
        budgetPolicyRollbackLabel,
        'budget_policy_rollback'
      ),
    };

    // Phase 5+: 策略 × 根因 交叉矩阵
    // 让用户看到 "multi_factor_alpha 这个策略的亏损主要是 catalyst_failed 还是 stop_loss_hit"
    // 健康策略应当 normal_thesis_played_out + take_profit_hit 占主导；
    // 如果某个策略的 root_cause 分布异常（e.g. 80% catalyst_failed），需要回看策略 thesis
    const crossStrategyRootCause = this.buildCrossStrategyRootCause(outcomes);

    const dashboard: RecommendationTradeOutcomeDashboard = {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      filters: {
        include_open: includeOpen,
        source_type: options.source_type || 'all',
        agent_session: options.agent_session || '',
        loop_run_id: options.loop_run_id || '',
        trade_status: options.trade_status || '',
        start_date: options.start_date || '',
        end_date: options.end_date || '',
        lookback_days: options.lookback_days || '',
      },
      summary,
      groups,
      cross_strategy_root_cause: crossStrategyRootCause,
      outcomes: outcomes.slice(0, 200).map(outcome => {
        const plain = modelToPlain<any>(outcome);
        return {
          ...plain,
          policy_explain: buildPolicyExplainForOutcome(plain),
        };
      }),
      feedback: this.buildFeedback(summary, groups),
    };

    if (toBoolean(options.report_to_feishu, false)) {
      await feishuTaskReportService.reportRecommendationTradeOutcomes(dashboard, {
        record_type: '推荐交易收益闭环看板',
      });
    }

    return dashboard;
  }

  async getOptimizationDashboard(options: RecommendationTradeOutcomeOptimizationOptions = {}) {
    const portfolio = await this.resolvePortfolio(options);
    const horizons = normalizeHorizonList(options.horizons);
    const lookbackDays = toPositiveInt(options.lookback_days, 180, 3650);
    const outcomeDashboard = await this.getDashboard({
      ...options,
      portfolio_id: portfolio.id,
      include_open: true,
      lookback_days: lookbackDays,
      limit: toPositiveInt(options.limit, 2000, 10000),
      report_to_feishu: false,
    });

    const outcomes = outcomeDashboard.outcomes.map(item => modelToPlain<any>(item));
    const signalIds = outcomes
      .map(item => Number(item.signal_id))
      .filter(value => Number.isFinite(value) && value > 0);
    const signals = signalIds.length
      ? await AIInvestmentSignal.findAll({
          where: { id: { [Op.in]: signalIds } },
          raw: true,
        })
      : [];
    const signalById = new Map<number, any>();
    signals.forEach((signal: any) => signalById.set(Number(signal.id), signal));

    const pathSamples = this.buildPathSamples(outcomes, signalById, horizons);
    const horizon_path = horizons.map(horizon => {
      const samples = pathSamples.filter(item => item.horizon === horizon);
      const wins = samples.filter(item => item.directional_return_pct > 0);
      const excessWins = samples.filter(item => Number(item.excess_return_pct || 0) > 0);
      return {
        horizon,
        horizon_days: Number(horizon.replace('d', '')),
        count: samples.length,
        completed_count: samples.length,
        avg_return_pct: roundNumber(average(samples.map(item => item.return_pct)), 4),
        avg_directional_return_pct: roundNumber(
          average(samples.map(item => item.directional_return_pct)),
          4
        ),
        avg_excess_return_pct: roundNumber(average(samples.map(item => item.excess_return_pct)), 4),
        win_rate: samples.length ? roundNumber((wins.length / samples.length) * 100, 2) : 0,
        excess_win_rate: samples.length
          ? roundNumber((excessWins.length / samples.length) * 100, 2)
          : 0,
        best_symbol: [...samples].sort(
          (a, b) => b.directional_return_pct - a.directional_return_pct
        )[0]?.symbol,
        worst_symbol: [...samples].sort(
          (a, b) => a.directional_return_pct - b.directional_return_pct
        )[0]?.symbol,
      };
    });

    const symbolPaths = this.buildSymbolPathSummaries(pathSamples, outcomes);
    const openOutcomes = outcomes.filter(item => item.trade_status !== 'closed');
    const closedOutcomes = outcomes.filter(item => item.trade_status === 'closed');
    const bestHorizon = [...horizon_path]
      .filter(item => item.count > 0)
      .sort(
        (a, b) =>
          b.avg_directional_return_pct - a.avg_directional_return_pct ||
          b.excess_win_rate - a.excess_win_rate ||
          b.count - a.count
      )[0];
    const currentHoldDays = roundNumber(
      average(openOutcomes.map(item => toNumber(item.holding_days))),
      2
    );
    const closedAvgHoldDays = roundNumber(
      average(closedOutcomes.map(item => toNumber(item.holding_days))),
      2
    );
    const recommendedMaxHoldDays = bestHorizon
      ? Math.max(5, Math.min(30, Number(bestHorizon.horizon_days || 10) * 2))
      : 20;
    const stopLossCandidates = closedOutcomes
      .map(item => Math.abs(toNumber(item.max_adverse_excursion_pct)))
      .filter(value => Number.isFinite(value) && value > 0);
    const takeProfitCandidates = closedOutcomes
      .map(item => toNumber(item.max_favorable_excursion_pct))
      .filter(value => Number.isFinite(value) && value > 0);
    const avgMfePct = average(takeProfitCandidates);
    const avgMaeAbsPct = average(stopLossCandidates);
    const weakOutcome =
      outcomeDashboard.summary.avg_closed_return_pct < 0 ||
      outcomeDashboard.summary.avg_excess_return_pct < -1 ||
      outcomeDashboard.summary.win_rate < 45 ||
      outcomeDashboard.summary.profit_factor < 0.9;
    const strongOutcome =
      outcomeDashboard.summary.avg_closed_return_pct > 2 &&
      outcomeDashboard.summary.avg_excess_return_pct > 0.8 &&
      outcomeDashboard.summary.win_rate >= 55 &&
      outcomeDashboard.summary.profit_factor >= 1.2;
    const adaptiveStopLoss = roundNumber(
      clamp(avgMaeAbsPct ? avgMaeAbsPct * (weakOutcome ? 0.85 : 1.1) : 7, 4, 10),
      2
    );
    const adaptiveTakeProfit = roundNumber(
      clamp(avgMfePct ? avgMfePct * (weakOutcome ? 0.72 : strongOutcome ? 0.9 : 0.82) : 14, 9, 22),
      2
    );
    const adaptiveTrailingActivation = roundNumber(
      clamp(avgMfePct ? avgMfePct * (weakOutcome ? 0.48 : strongOutcome ? 0.62 : 0.55) : 8, 5, 14),
      2
    );
    const adaptiveTrailingDrawdown = roundNumber(
      clamp(
        avgMaeAbsPct ? avgMaeAbsPct * (weakOutcome ? 0.55 : strongOutcome ? 0.75 : 0.65) : 4,
        2.5,
        7
      ),
      2
    );
    const adaptiveRisk = {
      recommended_max_hold_days: recommendedMaxHoldDays,
      recommended_stop_loss_pct: adaptiveStopLoss,
      recommended_take_profit_pct: adaptiveTakeProfit,
      recommended_trailing_activation_pct: adaptiveTrailingActivation,
      recommended_trailing_drawdown_pct: adaptiveTrailingDrawdown,
      current_open_avg_holding_days: currentHoldDays,
      closed_avg_holding_days: closedAvgHoldDays,
      best_horizon: bestHorizon || null,
      sample_count: closedOutcomes.length,
      confidence: roundNumber(clamp(closedOutcomes.length / 10, 0, 1), 2),
      mode: weakOutcome ? 'defensive' : strongOutcome ? 'growth' : 'balanced',
      reason: weakOutcome
        ? '闭环收益偏弱，建议收紧止损/止盈与移动止盈触发'
        : strongOutcome
        ? '闭环收益偏强，建议给强势标的更多收益空间'
        : '闭环收益中性，按 MFE/MAE 小幅校准风控参数',
    };

    const strategyComboGroups = outcomeDashboard.groups.by_strategy_key || [];
    const scorePositionGroups = outcomeDashboard.groups.by_score_position_bucket || [];
    const marketRegimeGroups = outcomeDashboard.groups.by_market_regime || [];
    const industryRegimeGroups = outcomeDashboard.groups.by_industry_regime || [];
    const environmentVersionGroups = outcomeDashboard.groups.by_environment_policy_version || [];
    const environmentStrategyComboGroups =
      outcomeDashboard.groups.by_environment_strategy_combo || [];
    const candidateTuningGroups = outcomeDashboard.groups.by_candidate_tuning || [];
    const budgetActionGroups = outcomeDashboard.groups.by_budget_action || [];
    const budgetPolicyActionGroups = outcomeDashboard.groups.by_budget_policy_action || [];
    const budgetPolicyVersionGroups = outcomeDashboard.groups.by_budget_policy_version || [];
    const budgetPolicyRollbackGroups = outcomeDashboard.groups.by_budget_policy_rollback || [];
    const environmentPolicy: any = this.buildEnvironmentLoopPolicy({
      market_regime_groups: marketRegimeGroups,
      industry_regime_groups: industryRegimeGroups,
      version_groups: environmentVersionGroups,
      weak_outcome: weakOutcome,
      strong_outcome: strongOutcome,
    });

    const policyDashboard = await recommendationLoopPolicySnapshotService
      .getDashboard({
        username: options.username,
        universe: 'market',
        limit: 120,
      } as any)
      .catch(error => {
        logger.warn(`读取策略版本优化建议失败: ${error?.message || error}`);
        return null;
      });
    const promotion = policyDashboard?.promotion || null;
    const nextPolicy = {
      recommended_style: promotion?.recommended_style || 'balanced',
      recommended_min_score:
        promotion?.recommended_min_score || outcomeDashboard.feedback.recommended_min_score,
      recommended_default_position_pct: promotion?.recommended_default_position_pct || 3,
      recommended_max_position_pct: promotion?.recommended_max_position_pct || 6,
      recommended_paper_trade_limit: promotion?.recommended_paper_trade_limit || 2,
      confidence: promotion?.confidence || 0,
      action: promotion?.action || 'collect_samples',
      reasons: Array.isArray(promotion?.reasons) ? promotion.reasons.slice(0, 4) : [],
      environment_position_multiplier: environmentPolicy.default_position_multiplier,
      environment_confidence: environmentPolicy.confidence,
      environment_blocked_segments: environmentPolicy.blocked_segments.slice(0, 5),
      environment_reduced_segments: environmentPolicy.reduced_segments.slice(0, 5),
      environment_boosted_segments: environmentPolicy.boosted_segments.slice(0, 5),
      recovered_environment_strategy_combos:
        environmentPolicy.recovered_environment_strategy_combos || [],
      extended_cooldown_environment_strategy_combos:
        environmentPolicy.extended_cooldown_environment_strategy_combos || [],
      resample_environment_strategy_combos:
        environmentPolicy.resample_environment_strategy_combos || [],
      candidate_tuning_reason: environmentPolicy.recovered_environment_strategy_combos?.[0]
        ? `下一轮候选源头优先恢复 ${environmentPolicy.recovered_environment_strategy_combos[0].label}`
        : environmentPolicy.extended_cooldown_environment_strategy_combos?.[0]
        ? `下一轮候选源头压低 ${environmentPolicy.extended_cooldown_environment_strategy_combos[0].label}`
        : environmentPolicy.resample_environment_strategy_combos?.[0]
        ? `下一轮候选源头小仓复采样 ${environmentPolicy.resample_environment_strategy_combos[0].label}`
        : '',
    };
    const topCandidateTuning = candidateTuningGroups
      .filter(item => item.key !== 'no_tuning' && item.closed_count > 0)
      .sort(
        (a, b) =>
          toNumber(b.capital_efficiency_score) - toNumber(a.capital_efficiency_score) ||
          b.avg_excess_return_pct - a.avg_excess_return_pct
      )[0];
    const budgetActionRankings = budgetActionGroups
      .filter(item => item.key !== 'no_budget_action')
      .sort(
        (a, b) =>
          toNumber(b.capital_efficiency_score) - toNumber(a.capital_efficiency_score) ||
          b.avg_excess_return_pct - a.avg_excess_return_pct ||
          b.closed_count - a.closed_count
      );
    const bestBudgetAction = budgetActionRankings.filter(item => item.closed_count > 0)[0];
    const weakBudgetAction = [...budgetActionRankings]
      .filter(item => item.closed_count > 0)
      .sort(
        (a, b) =>
          toNumber(a.capital_efficiency_score) - toNumber(b.capital_efficiency_score) ||
          a.avg_excess_return_pct - b.avg_excess_return_pct
      )[0];
    const budgetPolicyExecutionAudit =
      this.buildBudgetPolicyExecutionAudit(budgetPolicyActionGroups);
    const budgetPolicyRollbackAudit = this.buildBudgetPolicyRollbackAudit(
      budgetPolicyRollbackGroups
    );
    let budgetActionPolicy: any = this.buildBudgetActionPolicy(
      budgetActionRankings,
      budgetPolicyExecutionAudit
    );
    const rawBudgetPolicyVersion = this.buildBudgetPolicyVersionSnapshot({
      policy: budgetActionPolicy,
      audit: budgetPolicyExecutionAudit,
      version_groups: budgetPolicyVersionGroups,
      lookback_days: lookbackDays,
    });
    const budgetPolicyVersionGuard = this.buildBudgetPolicyVersionGuard(rawBudgetPolicyVersion);
    let budgetPolicyVersion: any = rawBudgetPolicyVersion;
    if (budgetPolicyVersionGuard.action === 'protective_downgrade') {
      budgetActionPolicy = this.applyBudgetPolicyVersionGuard(
        budgetActionPolicy,
        budgetPolicyVersionGuard
      );
      budgetPolicyVersion = this.buildBudgetPolicyVersionSnapshot({
        policy: budgetActionPolicy,
        audit: budgetPolicyExecutionAudit,
        version_groups: budgetPolicyVersionGroups,
        lookback_days: lookbackDays,
        guard: budgetPolicyVersionGuard,
        base_version: rawBudgetPolicyVersion,
      });
    }
    let budgetPolicyVersionIntelligence: any = null;
    try {
      budgetPolicyVersionIntelligence =
        await budgetPolicyVersionSnapshotService.getVersionIntelligence({
          current_version: budgetPolicyVersion,
          limit: 160,
          min_closed_count: 3,
        });
    } catch (error: any) {
      logger.warn(`读取预算权重持久化版本智能失败: ${error?.message || error}`);
    }
    let rollbackPlan = asPlainObject(budgetPolicyVersionIntelligence?.rollback_plan);
    rollbackPlan = this.applyBudgetPolicyRollbackAuditBlock(
      rollbackPlan,
      budgetPolicyRollbackAudit
    );
    if (rollbackPlan.apply) {
      budgetActionPolicy = this.applyBudgetPolicySnapshotRollback(budgetActionPolicy, rollbackPlan);
      budgetPolicyVersion = this.buildBudgetPolicyVersionSnapshot({
        policy: budgetActionPolicy,
        audit: budgetPolicyExecutionAudit,
        version_groups: budgetPolicyVersionGroups,
        lookback_days: lookbackDays,
        guard: {
          ...rollbackPlan,
          action: rollbackPlan.action,
          champion_version_id: rollbackPlan.source_version_id,
          reason: rollbackPlan.reason,
        },
        base_version: budgetPolicyVersion,
      });
      budgetPolicyVersionIntelligence =
        await budgetPolicyVersionSnapshotService.getVersionIntelligence({
          current_version: budgetPolicyVersion,
          limit: 160,
          min_closed_count: 3,
        });
    }
    budgetPolicyVersion = this.attachBudgetPolicyVersionGuard(
      budgetPolicyVersion,
      rollbackPlan.apply ? rollbackPlan : budgetPolicyVersionGuard,
      rawBudgetPolicyVersion
    );
    (budgetPolicyVersion as any).version_intelligence = budgetPolicyVersionIntelligence;
    (budgetPolicyVersion as any).rollback_plan = rollbackPlan;
    if (budgetPolicyVersionIntelligence) {
      (budgetPolicyVersionIntelligence as any).rollback_plan = rollbackPlan;
    }
    (budgetPolicyVersion as any).rollback_audit = budgetPolicyRollbackAudit;
    const budgetPolicyVersionSnapshot = await budgetPolicyVersionSnapshotService.recordVersion(
      budgetPolicyVersion,
      {
        username: options.username,
        source: 'autonomous_optimization_dashboard',
      }
    );
    if (budgetPolicyVersionSnapshot) {
      (budgetPolicyVersion as any).snapshot_record_id = budgetPolicyVersionSnapshot.id;
      (budgetPolicyVersion as any).snapshot_recorded_at = budgetPolicyVersionSnapshot.updated_at;
    }
    (budgetActionPolicy as any).version = budgetPolicyVersion;
    (budgetActionPolicy as any).version_id = budgetPolicyVersion.version_id;
    (budgetActionPolicy as any).version_hash = budgetPolicyVersion.version_hash;
    (environmentPolicy as any).budget_action_policy = budgetActionPolicy;
    (environmentPolicy as any).budget_policy_version = budgetPolicyVersion;
    (environmentPolicy as any).budget_policy_version_intelligence = budgetPolicyVersionIntelligence;
    (environmentPolicy as any).budget_policy_execution_audit = budgetPolicyExecutionAudit;
    (environmentPolicy as any).budget_policy_rollback_audit = budgetPolicyRollbackAudit;
    (environmentPolicy as any).budget_action_feedback_applied = Boolean(budgetActionPolicy.enabled);
    (environmentPolicy as any).budget_action_feedback_reason = budgetActionPolicy.reason;
    (nextPolicy as any).budget_action_policy = budgetActionPolicy;
    (nextPolicy as any).budget_action_reason = budgetActionPolicy.reason;
    (nextPolicy as any).budget_policy_version = budgetPolicyVersion;
    (nextPolicy as any).budget_policy_execution_audit = budgetPolicyExecutionAudit;
    (nextPolicy as any).budget_policy_rollback_audit = budgetPolicyRollbackAudit;
    const weakCandidateTuning = candidateTuningGroups
      .filter(item => item.key !== 'no_tuning' && item.closed_count > 0)
      .sort(
        (a, b) =>
          toNumber(a.capital_efficiency_score) - toNumber(b.capital_efficiency_score) ||
          a.avg_excess_return_pct - b.avg_excess_return_pct
      )[0];
    const enrichBudgetItem = (item: any): any => {
      const raw = asPlainObject(item);
      const action = raw.budget_action || raw.action;
      const fallbackMultiplier =
        raw.position_multiplier ??
        raw.resample_recovery_position_multiplier ??
        raw.resample_position_multiplier ??
        (action === 'boost' ? 1.08 : action === 'block' ? 0 : action === 'reduce' ? 0.55 : 0.72);
      return {
        ...raw,
        capital_efficiency_score: roundNumber(
          toNumber(
            raw.capital_efficiency_score,
            toNumber(raw.robust_score, 0) + toNumber(raw.avg_excess_return_pct, 0) * 2
          ),
          2
        ),
        budget_action:
          raw.budget_action ||
          (raw.resample_policy_action === 'extend_cooldown' || raw.action === 'block'
            ? 'pause'
            : raw.action === 'reduce'
            ? 'reduce'
            : raw.action === 'boost' || raw.resample_policy_action === 'recover_small'
            ? 'increase'
            : 'observe'),
        recommended_budget_multiplier: roundNumber(
          clamp(toNumber(fallbackMultiplier, 0.72), 0, 1.2),
          2
        ),
        budget_action_reason:
          raw.budget_action_reason ||
          raw.reason ||
          raw.resample_decision_reason ||
          raw.resample_reason ||
          raw.cooldown_reason ||
          '按闭环收益与资金效率动态分配预算',
      };
    };
    const uniqueBudgetItems = (items: any[]) => {
      const seen = new Set<string>();
      return items.map(enrichBudgetItem).filter(item => {
        const key = item.key || item.label;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const rankByCapitalEfficiency = (items: any[]) =>
      uniqueBudgetItems(items).sort(
        (a, b) =>
          toNumber(b.capital_efficiency_score) - toNumber(a.capital_efficiency_score) ||
          toNumber(b.avg_excess_return_pct) - toNumber(a.avg_excess_return_pct) ||
          toNumber(b.closed_count) - toNumber(a.closed_count)
      );
    const rankByWeakCapitalEfficiency = (items: any[]) =>
      uniqueBudgetItems(items).sort(
        (a, b) =>
          toNumber(a.recommended_budget_multiplier) - toNumber(b.recommended_budget_multiplier) ||
          toNumber(a.capital_efficiency_score) - toNumber(b.capital_efficiency_score) ||
          toNumber(a.avg_excess_return_pct) - toNumber(b.avg_excess_return_pct)
      );
    const capitalEfficiencyRankings = rankByCapitalEfficiency([
      ...environmentStrategyComboGroups.filter(
        item =>
          item.key &&
          !item.key.includes('env:unknown') &&
          !item.key.includes('strategy:unknown') &&
          item.closed_count > 0
      ),
      ...candidateTuningGroups.filter(item => item.key !== 'no_tuning' && item.closed_count > 0),
      ...strategyComboGroups.filter(item => item.key !== 'unknown' && item.closed_count > 0),
    ]).slice(0, 8);
    const strategyEvolution = {
      add_risk_budget: rankByCapitalEfficiency([
        ...(environmentPolicy.recovered_environment_strategy_combos || []),
        ...(environmentPolicy.boosted_segments || []),
        ...capitalEfficiencyRankings.filter(
          item =>
            item.budget_action === 'increase' ||
            (toNumber(item.capital_efficiency_score) >= 10 &&
              toNumber(item.avg_excess_return_pct) > 0.8)
        ),
      ]).slice(0, 5),
      reduce_risk_budget: rankByWeakCapitalEfficiency([
        ...(environmentPolicy.extended_cooldown_environment_strategy_combos || []),
        ...(environmentPolicy.blocked_segments || []),
        ...(environmentPolicy.reduced_segments || []),
        ...environmentStrategyComboGroups.filter(
          item => item.budget_action === 'pause' || item.budget_action === 'reduce'
        ),
      ]).slice(0, 5),
      observe: rankByCapitalEfficiency([
        ...(environmentPolicy.resample_environment_strategy_combos || []),
        ...(environmentPolicy.watch_segments || []),
        ...capitalEfficiencyRankings.filter(item => item.budget_action === 'observe'),
      ]).slice(0, 5),
      candidate_tuning_best: topCandidateTuning || null,
      candidate_tuning_weak: weakCandidateTuning || null,
      capital_efficiency_rankings: capitalEfficiencyRankings,
      budget_action_rankings: budgetActionRankings.slice(0, 8),
      best_budget_action: bestBudgetAction || null,
      weak_budget_action: weakBudgetAction || null,
      budget_action_policy: budgetActionPolicy,
      budget_policy_version: budgetPolicyVersion,
      budget_policy_execution_audit: budgetPolicyExecutionAudit,
      budget_policy_rollback_audit: budgetPolicyRollbackAudit,
    };

    const weakSegments = outcomeDashboard.feedback.weak_segments.slice(0, 4);
    const bestSegments = outcomeDashboard.feedback.best_segments.slice(0, 4);
    const bestStrategyCombo = strategyComboGroups
      .filter(segment => segment.key !== 'unknown' && segment.closed_count > 0)
      .sort(
        (a, b) =>
          toNumber(b.robust_score) - toNumber(a.robust_score) ||
          b.avg_excess_return_pct - a.avg_excess_return_pct ||
          b.excess_win_rate - a.excess_win_rate
      )[0];
    const weakStrategyCombo = strategyComboGroups
      .filter(segment => segment.key !== 'unknown' && segment.closed_count > 0)
      .sort(
        (a, b) =>
          toNumber(a.robust_score) - toNumber(b.robust_score) ||
          a.avg_excess_return_pct - b.avg_excess_return_pct ||
          a.excess_win_rate - b.excess_win_rate
      )[0];
    const killList = weakSegments
      .filter(segment => segment.closed_count >= 2 && segment.avg_excess_return_pct < -1)
      .map(segment => ({
        dimension: '收益片段',
        key: segment.key,
        label: segment.label,
        closed_count: segment.closed_count,
        avg_excess_return_pct: segment.avg_excess_return_pct,
        action: '下一轮降权或暂停自动跟单',
      }));
    const boostList = bestSegments
      .filter(segment => segment.closed_count >= 2 && segment.avg_excess_return_pct > 1)
      .map(segment => ({
        dimension: '收益片段',
        key: segment.key,
        label: segment.label,
        closed_count: segment.closed_count,
        avg_excess_return_pct: segment.avg_excess_return_pct,
        action: '下一轮优先保留小仓验证',
      }));

    const insights = [
      `自主模拟盘当前总盈亏 ${roundNumber(outcomeDashboard.summary.total_pnl, 2)}，闭环 ${
        outcomeDashboard.summary.closed_count
      }/${outcomeDashboard.summary.total_count} 笔，胜率 ${outcomeDashboard.summary.win_rate}%。`,
      bestHorizon
        ? `后验收益路径显示 ${bestHorizon.horizon} 当前更优，平均方向收益 ${bestHorizon.avg_directional_return_pct}%、超额胜率 ${bestHorizon.excess_win_rate}%。`
        : '收益路径样本不足，先继续让推荐进入小仓模拟盘沉淀样本。',
      `下一轮建议：${styleLabel(nextPolicy.recommended_style)} / 评分≥${
        nextPolicy.recommended_min_score
      } / 默认仓位 ${nextPolicy.recommended_default_position_pct}% / 跟单 ${
        nextPolicy.recommended_paper_trade_limit
      } 笔。`,
      killList[0]
        ? `需降权片段：${killList[0].label}，平均超额 ${killList[0].avg_excess_return_pct}%。`
        : '暂无明确需要永久剔除的片段，继续以收益闸门控制仓位。',
      bestStrategyCombo
        ? `参数组合冠军：${bestStrategyCombo.label}，稳健分 ${bestStrategyCombo.robust_score}，平均超额 ${bestStrategyCombo.avg_excess_return_pct}%、贝叶斯胜率 ${bestStrategyCombo.bayesian_win_rate}%。`
        : '',
      environmentStrategyComboGroups[0] &&
      !environmentStrategyComboGroups[0].key.includes('env:unknown') &&
      !environmentStrategyComboGroups[0].key.includes('strategy:unknown')
        ? `环境×策略冠军：${environmentStrategyComboGroups[0].label}，平均超额 ${environmentStrategyComboGroups[0].avg_excess_return_pct}%、闭环 ${environmentStrategyComboGroups[0].closed_count} 笔。`
        : '',
      environmentPolicy.blocked_segments[0]
        ? `环境闸门建议：暂停 ${environmentPolicy.blocked_segments[0].label}，原因 ${environmentPolicy.blocked_segments[0].reason}。`
        : environmentPolicy.reduced_segments[0]
        ? `环境闸门建议：${environmentPolicy.reduced_segments[0].label} 降至 ${environmentPolicy.reduced_segments[0].position_multiplier}x，小仓验证。`
        : environmentPolicy.boosted_segments[0]
        ? `环境闸门建议：优先小幅放大 ${environmentPolicy.boosted_segments[0].label}，倍率 ${environmentPolicy.boosted_segments[0].position_multiplier}x。`
        : '',
      environmentStrategyComboGroups.find(item => item.resample_recovery_ready)
        ? `复采样升降级：${
            environmentStrategyComboGroups.find(item => item.resample_recovery_ready)?.label
          } 复采样跑赢，下一轮解除冷却并以小仓恢复。`
        : environmentStrategyComboGroups.find(item => item.cooldown_extended)
        ? `复采样升降级：${
            environmentStrategyComboGroups.find(item => item.cooldown_extended)?.label
          } 复采样仍跑输，下一轮延长冷却。`
        : '',
      topCandidateTuning
        ? `候选源头调权回收：${topCandidateTuning.label} 闭环 ${topCandidateTuning.closed_count} 笔，平均超额 ${topCandidateTuning.avg_excess_return_pct}%。`
        : '',
      bestBudgetAction
        ? `预算动作回收：${bestBudgetAction.label} 当前效率 ${bestBudgetAction.capital_efficiency_score}、平均超额 ${bestBudgetAction.avg_excess_return_pct}%，后续按收益继续调仓。`
        : '',
      budgetActionPolicy.enabled && budgetActionPolicy.best_action
        ? `预算动作策略：${budgetActionPolicy.reason}`
        : '',
      budgetActionPolicy.audit_feedback_applied_count
        ? `预算审计反哺：${budgetActionPolicy.audit_feedback_reason}`
        : '',
      budgetPolicyVersion.enabled
        ? `预算权重版本：${budgetPolicyVersion.version_id}，指纹 ${budgetPolicyVersion.version_hash}。`
        : '',
      budgetPolicyVersion.underperformance_guard?.action === 'protective_downgrade'
        ? `预算权重保护：${budgetPolicyVersion.underperformance_guard.reason}`
        : '',
      budgetPolicyVersion.rollback_plan?.apply
        ? `预算版本回滚：${budgetPolicyVersion.rollback_plan.reason}`
        : '',
      budgetPolicyExecutionAudit.enabled
        ? `预算策略审计：${budgetPolicyExecutionAudit.reason}`
        : '',
      budgetPolicyRollbackAudit.enabled
        ? `预算版本回滚审计：${budgetPolicyRollbackAudit.reason}`
        : '',
    ].filter(Boolean);

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        initial_capital: toNumber(portfolio.initial_capital),
        total_value: toNumber(portfolio.total_value),
        current_cash: toNumber(portfolio.current_cash),
      },
      filters: {
        lookback_days: lookbackDays,
        horizons,
      },
      summary: outcomeDashboard.summary,
      feedback: outcomeDashboard.feedback,
      horizon_path,
      symbol_paths: symbolPaths,
      adaptive_risk: adaptiveRisk,
      next_policy: nextPolicy,
      strategy_evolution: strategyEvolution,
      segment_actions: {
        boost: boostList,
        reduce: killList,
      },
      strategy_combos: {
        best: bestStrategyCombo || null,
        weak: weakStrategyCombo || null,
        rankings: strategyComboGroups.slice(0, 8),
        score_position_rankings: scorePositionGroups.slice(0, 8),
      },
      environment_policy: environmentPolicy,
      market_environment: {
        market_regime_rankings: marketRegimeGroups.slice(0, 8),
        industry_regime_rankings: industryRegimeGroups.slice(0, 8),
        version_rankings: environmentVersionGroups
          .filter(item => item.key !== 'unknown')
          .slice(0, 10),
        strategy_combo_rankings: environmentStrategyComboGroups
          .filter(
            item =>
              item.key &&
              !item.key.includes('env:unknown') &&
              !item.key.includes('strategy:unknown')
          )
          .slice(0, 10),
        resample_summary: outcomeDashboard.groups.by_resample,
        candidate_tuning_rankings: outcomeDashboard.groups.by_candidate_tuning,
        budget_action_rankings: outcomeDashboard.groups.by_budget_action,
        budget_policy_action_rankings: outcomeDashboard.groups.by_budget_policy_action,
        budget_policy_version_rankings: outcomeDashboard.groups.by_budget_policy_version,
        budget_policy_rollback_rankings: outcomeDashboard.groups.by_budget_policy_rollback,
        resample_combo_rankings: environmentStrategyComboGroups
          .filter(item => toNumber(item.resample_closed_count, 0) > 0 || item.resample_decision)
          .sort(
            (a, b) =>
              toNumber(b.resample_avg_excess_return_pct, -999) -
                toNumber(a.resample_avg_excess_return_pct, -999) ||
              toNumber(b.resample_closed_count, 0) - toNumber(a.resample_closed_count, 0)
          )
          .slice(0, 8),
        policy: environmentPolicy,
      },
      policy_versions: policyDashboard
        ? {
            summary: policyDashboard.summary,
            promotion: policyDashboard.promotion,
            top_versions: (policyDashboard.rankings?.snapshots || []).slice(0, 5),
            top_strategy_combos: (policyDashboard.rankings?.by_strategy_key || []).slice(0, 5),
          }
        : null,
      insights,
    };
  }

  private buildBudgetActionPolicy(
    rankings: RecommendationTradeOutcomeBucket[] = [],
    executionAudit: any = {}
  ) {
    const auditByAction = new Map<string, any>();
    const auditExecutions = Array.isArray(executionAudit.executions)
      ? executionAudit.executions
      : [];
    for (const audit of auditExecutions) {
      const action = String(audit?.key || '').trim();
      if (action && !auditByAction.has(action)) {
        auditByAction.set(action, audit);
      }
    }
    const actions = rankings
      .filter(item => item.key && item.key !== 'no_budget_action')
      .map(item => {
        const key = normalizeBudgetActionKey(item.key);
        const closedCount = toNumber(item.closed_count, 0);
        const avgExcess = toNumber(item.avg_excess_return_pct, 0);
        const excessWinRate = toNumber(item.excess_win_rate, 0);
        const capitalEfficiency = toNumber(item.capital_efficiency_score, 0);
        const pnlPer10k = toNumber(item.pnl_per_10k, 0);
        const confidence = clamp(closedCount / 8, 0, 1);
        let action = 'collect_samples';
        let positionMultiplier =
          key === 'increase' ? 0.92 : key === 'observe' ? 0.88 : key === 'reduce' ? 0.78 : 0;
        let scoreAdjustment = 0;
        let allowEntry = key !== 'pause';
        let reason = `${item.label}闭环 ${closedCount} 笔，样本不足，先小仓收集验证`;
        if (key === 'pause' && closedCount < 2) {
          reason = `${item.label}闭环 ${closedCount} 笔，暂停动作尚未证明修复，继续禁止新仓`;
          scoreAdjustment = -2;
        }

        if (closedCount >= 2) {
          if (key === 'increase') {
            if (avgExcess >= 0.8 && capitalEfficiency >= 8 && excessWinRate >= 50) {
              action = 'scale_up';
              positionMultiplier = clamp(
                1.04 + Math.min(0.12, capitalEfficiency / 180),
                1.05,
                1.16
              );
              scoreAdjustment = 2;
              reason = `加预算动作已验证有效：超额 ${roundNumber(
                avgExcess,
                2
              )}%，效率 ${roundNumber(capitalEfficiency, 1)}`;
            } else if (avgExcess < 0 || capitalEfficiency < 0) {
              action = 'cap_increase';
              positionMultiplier = 0.82;
              scoreAdjustment = -2;
              reason = `加预算后表现未达标：超额 ${roundNumber(avgExcess, 2)}%，先限制放大`;
            } else {
              action = 'verify';
              positionMultiplier = 0.98;
              reason = `加预算动作仍在验证：超额 ${roundNumber(avgExcess, 2)}%，暂不继续放大`;
            }
          } else if (key === 'observe') {
            if (avgExcess >= 0.7 && capitalEfficiency >= 5 && excessWinRate >= 50) {
              action = 'promote_from_observe';
              positionMultiplier = 1.03;
              scoreAdjustment = 1;
              reason = `观察仓表现转强：超额 ${roundNumber(avgExcess, 2)}%，可升为常规小仓`;
            } else if (avgExcess <= -0.8 || capitalEfficiency <= -3) {
              action = 'sample_smaller';
              positionMultiplier = 0.76;
              scoreAdjustment = -1;
              reason = `观察仓仍偏弱：超额 ${roundNumber(avgExcess, 2)}%，缩小试错`;
            } else {
              action = 'keep_observe';
              positionMultiplier = 0.88;
              reason = `观察仓结论中性：超额 ${roundNumber(avgExcess, 2)}%，继续小仓验证`;
            }
          } else if (key === 'reduce') {
            if (avgExcess >= 0.4 && capitalEfficiency >= 0) {
              action = 'keep_defensive';
              positionMultiplier = 0.92;
              reason = `降权动作后风险改善：超额 ${roundNumber(avgExcess, 2)}%，维持防守仓`;
            } else {
              action = 'tighten_reduce';
              positionMultiplier = 0.72;
              scoreAdjustment = -1;
              reason = `降权对象仍跑输：超额 ${roundNumber(avgExcess, 2)}%，继续压低仓位`;
            }
          } else if (key === 'pause') {
            if (avgExcess >= 0.8 && capitalEfficiency >= 4) {
              action = 'reopen_small';
              positionMultiplier = 0.55;
              scoreAdjustment = 1;
              reason = `暂停池出现修复：超额 ${roundNumber(avgExcess, 2)}%，仅小仓重开`;
            } else {
              action = 'keep_paused';
              positionMultiplier = 0;
              scoreAdjustment = -3;
              allowEntry = false;
              reason = `暂停池未修复：超额 ${roundNumber(avgExcess, 2)}%，继续禁止新仓`;
            }
          }
        }
        const actionAudit = auditByAction.get(action);
        const auditVerdict = String(actionAudit?.verdict || '');
        const auditConfidence = toNumber(actionAudit?.confidence, 0);
        const auditScore = toNumber(actionAudit?.audit_score, 0);
        let auditMultiplierAdjustment = 1;
        let auditScoreAdjustment = 0;
        let audit_feedback_reason = '';
        let audit_feedback_applied = false;

        if (actionAudit) {
          audit_feedback_applied = true;
          if (auditVerdict === 'effective') {
            auditMultiplierAdjustment = clamp(
              1.03 + Math.min(0.09, Math.max(0, auditScore) / 180),
              1.03,
              1.12
            );
            auditScoreAdjustment = auditConfidence >= 0.35 ? 1 : 0;
            audit_feedback_reason = `执行审计有效，倍率再校准 ${roundNumber(
              auditMultiplierAdjustment,
              2
            )}x`;
          } else if (auditVerdict === 'ineffective') {
            auditMultiplierAdjustment = 0.72;
            auditScoreAdjustment = -2;
            audit_feedback_reason = `执行审计无效，自动降权 ${roundNumber(
              auditMultiplierAdjustment,
              2
            )}x`;
          } else {
            auditMultiplierAdjustment = 0.94;
            auditScoreAdjustment = -1;
            audit_feedback_reason = '执行审计仍中性，维持观察并轻微降温';
          }

          positionMultiplier = clamp(positionMultiplier * auditMultiplierAdjustment, 0, 1.2);
          scoreAdjustment += auditScoreAdjustment;

          if (auditVerdict === 'ineffective' && action === 'reopen_small') {
            action = 'keep_paused';
            positionMultiplier = 0;
            scoreAdjustment = Math.min(scoreAdjustment, -3);
            allowEntry = false;
            audit_feedback_reason = '小仓重开审计无效，回退为继续暂停';
          }

          reason = `${reason}；${audit_feedback_reason}`;
        }

        return {
          key,
          label: item.label || budgetActionLabel(key),
          action,
          closed_count: closedCount,
          tracked_count: toNumber(item.tracked_count ?? item.count, 0),
          avg_excess_return_pct: roundNumber(avgExcess, 4),
          excess_win_rate: roundNumber(excessWinRate, 2),
          capital_efficiency_score: roundNumber(capitalEfficiency, 2),
          pnl_per_10k: roundNumber(pnlPer10k, 2),
          confidence: roundNumber(confidence, 2),
          position_multiplier: roundNumber(positionMultiplier, 2),
          score_adjustment: scoreAdjustment,
          allow_entry: allowEntry,
          audit_feedback_applied,
          audit_feedback_reason,
          audit_verdict: auditVerdict || undefined,
          audit_score: actionAudit ? roundNumber(auditScore, 2) : undefined,
          audit_multiplier_adjustment: actionAudit
            ? roundNumber(auditMultiplierAdjustment, 2)
            : undefined,
          audit_score_adjustment: actionAudit ? auditScoreAdjustment : undefined,
          reason,
        };
      })
      .sort(
        (a, b) =>
          b.capital_efficiency_score - a.capital_efficiency_score ||
          b.avg_excess_return_pct - a.avg_excess_return_pct ||
          b.closed_count - a.closed_count
      );

    const closedActions = actions.filter(item => item.closed_count > 0);
    const bestAction = closedActions[0] || null;
    const weakAction =
      [...closedActions].sort(
        (a, b) =>
          a.capital_efficiency_score - b.capital_efficiency_score ||
          a.avg_excess_return_pct - b.avg_excess_return_pct
      )[0] || null;
    const totalClosed = actions.reduce((sum, item) => sum + item.closed_count, 0);
    const auditFeedbackAppliedCount = actions.filter(item => item.audit_feedback_applied).length;

    return {
      enabled: actions.length > 0,
      confidence: roundNumber(clamp(totalClosed / 18, 0, 1), 2),
      total_closed_count: totalClosed,
      audit_feedback_enabled: Boolean(executionAudit.enabled),
      audit_feedback_applied_count: auditFeedbackAppliedCount,
      audit_feedback_reason: auditFeedbackAppliedCount
        ? `已将 ${auditFeedbackAppliedCount} 条执行审计结论反哺到下一轮调分/调仓`
        : executionAudit.enabled
        ? '已有执行审计，但尚未匹配到可反哺的预算动作'
        : '执行审计样本不足，暂未反哺',
      actions,
      best_action: bestAction,
      weak_action: weakAction,
      reason: bestAction
        ? `最佳动作 ${bestAction.label}，效率 ${bestAction.capital_efficiency_score}、超额 ${
            bestAction.avg_excess_return_pct
          }%；最弱 ${weakAction?.label || '暂无'}，下一轮按动作后验自动调分调仓`
        : actions.length
        ? '预算动作已有样本但闭环不足，下一轮只做保守小仓验证'
        : '暂无预算动作收益回收样本',
      rules: [
        '加预算动作跑赢且资金效率达标：下一轮候选加分并小幅放大',
        '观察动作跑赢：升为常规小仓；观察跑输：缩小试错',
        '降权/暂停动作仍跑输：继续压仓或禁入；修复后仅小仓重开',
      ],
    };
  }

  private buildBudgetPolicyVersionSnapshot(options: {
    policy: any;
    audit: any;
    version_groups?: RecommendationTradeOutcomeBucket[];
    lookback_days?: number;
    guard?: any;
    base_version?: any;
  }) {
    const policy = asPlainObject(options.policy);
    const audit = asPlainObject(options.audit);
    const guard = asPlainObject(options.guard);
    const baseVersion = asPlainObject(options.base_version);
    const actions = Array.isArray(policy.actions) ? policy.actions : [];
    const actionWeights = actions.map((item: any) => ({
      key: item.key,
      action: item.action,
      allow_entry: item.allow_entry !== false,
      position_multiplier: roundNumber(item.position_multiplier, 2),
      score_adjustment: toNumber(item.score_adjustment, 0),
      audit_verdict: item.audit_verdict || '',
      audit_multiplier_adjustment: item.audit_multiplier_adjustment,
      audit_score_adjustment: item.audit_score_adjustment,
    }));
    const payload = {
      schema: 'budget_policy_weight_v1',
      action_weights: actionWeights,
      audit_feedback_applied_count: toNumber(policy.audit_feedback_applied_count, 0),
      audit_confidence: roundNumber(audit.confidence, 2),
      total_closed_count: toNumber(policy.total_closed_count, 0),
      lookback_days: toNumber(options.lookback_days, 0),
      underperformance_guard_action: guard.action || 'none',
      guarded_from_version_id: baseVersion.version_id || '',
    };
    const versionHash = shortHash(payload, 12);
    const versionId = `bpw_${versionHash}`;
    const versionGroups = (options.version_groups || [])
      .filter(item => item.key && item.key !== 'no_budget_policy_version')
      .sort(
        (a, b) =>
          toNumber(b.capital_efficiency_score) - toNumber(a.capital_efficiency_score) ||
          b.avg_excess_return_pct - a.avg_excess_return_pct ||
          b.closed_count - a.closed_count
      );
    const currentVersionOutcome =
      versionGroups.find(item => item.key === versionId || item.key === versionHash) || null;

    return {
      enabled: actionWeights.length > 0,
      schema: 'budget_policy_weight_v1',
      version_id: versionId,
      version_hash: versionHash,
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      lookback_days: toNumber(options.lookback_days, 0),
      action_count: actionWeights.length,
      action_weights: actionWeights,
      audit_feedback_applied_count: toNumber(policy.audit_feedback_applied_count, 0),
      audit_feedback_reason: policy.audit_feedback_reason,
      current_version_outcome: currentVersionOutcome,
      version_rankings: versionGroups.slice(0, 8),
      underperformance_guard: guard,
      guarded_from_version_id: baseVersion.version_id,
      guarded_from_version_hash: baseVersion.version_hash,
      reason: currentVersionOutcome
        ? `当前预算权重版本已有闭环 ${currentVersionOutcome.closed_count} 笔，平均超额 ${currentVersionOutcome.avg_excess_return_pct}%`
        : guard.action === 'protective_downgrade'
        ? `预算权重版本 ${versionId} 已应用保护降级，等待后续模拟盘验证`
        : `生成预算权重版本 ${versionId}，等待后续模拟盘成交验证`,
      payload,
    };
  }

  private buildBudgetPolicyVersionGuard(version: any) {
    const current = asPlainObject(version.current_version_outcome);
    const rankings = Array.isArray(version.version_rankings) ? version.version_rankings : [];
    const champion =
      rankings.find(
        (item: any) =>
          item?.key &&
          item.key !== version.version_id &&
          toNumber(item.closed_count, 0) >= 3 &&
          toNumber(item.capital_efficiency_score, -999) > 0 &&
          toNumber(item.avg_excess_return_pct, -999) > 0
      ) || null;
    const currentClosed = toNumber(current.closed_count, 0);
    const championEfficiency = toNumber(champion?.capital_efficiency_score, 0);
    const currentEfficiency = toNumber(current.capital_efficiency_score, 0);
    const championExcess = toNumber(champion?.avg_excess_return_pct, 0);
    const currentExcess = toNumber(current.avg_excess_return_pct, 0);
    const efficiencyGap = champion ? roundNumber(championEfficiency - currentEfficiency, 2) : 0;
    const excessGap = champion ? roundNumber(championExcess - currentExcess, 4) : 0;
    const currentUnderperforms =
      currentClosed >= 3 &&
      champion &&
      (efficiencyGap >= 6 || excessGap >= 1.2) &&
      (currentEfficiency < 0 || currentExcess < 0 || toNumber(current.excess_win_rate, 50) < 45);

    if (currentUnderperforms) {
      return {
        enabled: true,
        action: 'protective_downgrade',
        severity: efficiencyGap >= 10 || excessGap >= 2 ? 'high' : 'medium',
        champion_version_id: champion.key,
        champion_label: champion.label,
        champion_closed_count: champion.closed_count,
        champion_avg_excess_return_pct: champion.avg_excess_return_pct,
        champion_capital_efficiency_score: champion.capital_efficiency_score,
        current_version_id: version.version_id,
        current_closed_count: currentClosed,
        current_avg_excess_return_pct: current.avg_excess_return_pct,
        current_capital_efficiency_score: current.capital_efficiency_score,
        efficiency_gap: efficiencyGap,
        excess_gap: excessGap,
        multiplier_cap: 0.82,
        score_penalty: -1,
        reason: `当前版本闭环 ${currentClosed} 笔后跑输历史冠军 ${champion.key}，效率差 ${efficiencyGap}、超额差 ${excessGap}%，下一轮自动保护降级`,
      };
    }

    if (champion) {
      return {
        enabled: true,
        action: currentClosed > 0 ? 'compare' : 'collect_samples',
        severity: 'info',
        champion_version_id: champion.key,
        champion_label: champion.label,
        champion_closed_count: champion.closed_count,
        champion_avg_excess_return_pct: champion.avg_excess_return_pct,
        champion_capital_efficiency_score: champion.capital_efficiency_score,
        current_version_id: version.version_id,
        current_closed_count: currentClosed,
        efficiency_gap: efficiencyGap,
        excess_gap: excessGap,
        reason:
          currentClosed > 0
            ? `当前版本与历史冠军 ${champion.key} 对比中，暂未触发保护降级`
            : `历史冠军 ${champion.key} 已作为观察基准，当前版本等待成交闭环`,
      };
    }

    return {
      enabled: false,
      action: 'collect_samples',
      severity: 'info',
      current_version_id: version.version_id,
      current_closed_count: currentClosed,
      reason: '预算权重版本样本不足，先收集成交闭环',
    };
  }

  private applyBudgetPolicyVersionGuard(policy: any, guard: any) {
    const policyObject = asPlainObject(policy);
    const multiplierCap = clamp(toNumber(guard.multiplier_cap, 0.82), 0.4, 1);
    const scorePenalty = Math.min(0, toNumber(guard.score_penalty, -1));
    const actions = Array.isArray(policyObject.actions)
      ? policyObject.actions.map((item: any) => {
          const originalMultiplier = toNumber(item.position_multiplier, 1);
          const guardedMultiplier =
            originalMultiplier > 0
              ? roundNumber(Math.min(originalMultiplier, originalMultiplier * multiplierCap), 2)
              : 0;
          const guardedScoreAdjustment = Math.min(
            toNumber(item.score_adjustment, 0),
            toNumber(item.score_adjustment, 0) + scorePenalty
          );
          return {
            ...item,
            position_multiplier: guardedMultiplier,
            score_adjustment: guardedScoreAdjustment,
            version_guard_applied: true,
            version_guard_reason: guard.reason,
            reason: `${item.reason || ''}；预算版本保护：${guard.reason}`,
          };
        })
      : [];
    return {
      ...policyObject,
      actions,
      version_guard_applied: true,
      version_guard: guard,
      version_guard_reason: guard.reason,
      reason: `${policyObject.reason || '预算动作策略'}；${guard.reason}`,
    };
  }

  private applyBudgetPolicySnapshotRollback(policy: any, rollbackPlan: any) {
    const policyObject = asPlainObject(policy);
    const sourceWeights = Array.isArray(rollbackPlan.source_action_weights)
      ? rollbackPlan.source_action_weights
      : [];
    if (!sourceWeights.length) return policyObject;

    const sourceByKey = new Map<string, any>();
    for (const item of sourceWeights) {
      const key = normalizeBudgetActionKey(item?.key || item?.action);
      if (key && key !== 'no_budget_action' && !sourceByKey.has(key)) {
        sourceByKey.set(key, item);
      }
    }
    const blendWeight = clamp(toNumber(rollbackPlan.blend_weight, 1), 0.35, 1);
    const actions = Array.isArray(policyObject.actions)
      ? policyObject.actions.map((item: any) => {
          const key = normalizeBudgetActionKey(item?.key || item?.action);
          const source = sourceByKey.get(key);
          if (!source) return item;

          const currentMultiplier = toNumber(item.position_multiplier, 1);
          const sourceMultiplier = toNumber(source.position_multiplier, currentMultiplier);
          const currentScore = toNumber(item.score_adjustment, 0);
          const sourceScore = toNumber(source.score_adjustment, currentScore);
          const inheritedMultiplier = roundNumber(
            currentMultiplier * (1 - blendWeight) + sourceMultiplier * blendWeight,
            2
          );
          const inheritedScore = roundNumber(
            currentScore * (1 - blendWeight) + sourceScore * blendWeight,
            0
          );

          return {
            ...item,
            action: source.action || item.action,
            allow_entry: source.allow_entry !== false && item.allow_entry !== false,
            position_multiplier: inheritedMultiplier,
            score_adjustment: inheritedScore,
            snapshot_rollback_applied: true,
            snapshot_rollback_source_version_id: rollbackPlan.source_version_id,
            snapshot_rollback_source_snapshot_id: rollbackPlan.source_snapshot_id,
            snapshot_rollback_reason: rollbackPlan.reason,
            reason: `${item.reason || ''}；持久化版本回滚：继承 ${
              rollbackPlan.source_version_id
            } 权重 ${roundNumber(blendWeight * 100, 0)}%`,
          };
        })
      : [];

    return {
      ...policyObject,
      actions,
      snapshot_rollback_applied: true,
      snapshot_rollback_plan: rollbackPlan,
      snapshot_rollback_reason: rollbackPlan.reason,
      reason: `${policyObject.reason || '预算动作策略'}；${rollbackPlan.reason}`,
    };
  }

  private applyBudgetPolicyRollbackAuditBlock(rollbackPlan: any, rollbackAudit: any) {
    const plan = asPlainObject(rollbackPlan);
    if (!plan.apply) return plan;

    const weakRollback = asPlainObject(rollbackAudit?.weak_rollback);
    const weakSource = String(weakRollback.key || '').split(':')[1] || '';
    const sourceVersionId = String(plan.source_version_id || '').trim();
    const auditSaysIneffective =
      weakRollback.verdict === 'ineffective' &&
      sourceVersionId &&
      (weakSource === sourceVersionId || String(weakRollback.key || '').includes(sourceVersionId));

    if (!auditSaysIneffective) return plan;

    return {
      ...plan,
      apply: false,
      action: 'rollback_audit_blocked',
      blocked_by_rollback_audit: true,
      blocked_source_version_id: sourceVersionId,
      blocked_reason:
        weakRollback.reason || '历史回滚进入模拟盘后的真实收益审计无效，本轮不继续继承该冠军版本',
      original_action: plan.action,
      reason: `历史回滚审计无效，暂不继续继承 ${sourceVersionId}：${
        weakRollback.reason || '回滚后仍跑输'
      }`,
    };
  }

  private attachBudgetPolicyVersionGuard(version: any, guard: any, rawVersion: any) {
    const guardObject = asPlainObject(guard);
    const rawVersionObject = asPlainObject(rawVersion);
    return {
      ...version,
      underperformance_guard: guardObject,
      raw_version_id:
        rawVersionObject.version_id && rawVersionObject.version_id !== version.version_id
          ? rawVersionObject.version_id
          : undefined,
      raw_version_hash:
        rawVersionObject.version_hash && rawVersionObject.version_hash !== version.version_hash
          ? rawVersionObject.version_hash
          : undefined,
      comparison_champion_version_id: guardObject.champion_version_id,
      comparison_champion_label: guardObject.champion_label,
      comparison_efficiency_gap: guardObject.efficiency_gap,
      comparison_excess_gap: guardObject.excess_gap,
      rollback_source_version_id: guardObject.source_version_id,
      rollback_source_snapshot_id: guardObject.source_snapshot_id,
      rollback_action: guardObject.action,
    };
  }

  private buildBudgetPolicyExecutionAudit(rankings: RecommendationTradeOutcomeBucket[] = []) {
    const executions = rankings
      .filter(item => item.key && item.key !== 'no_policy_execution')
      .map(item => {
        const closedCount = toNumber(item.closed_count, 0);
        const avgExcess = toNumber(item.avg_excess_return_pct, 0);
        const capitalEfficiency = toNumber(item.capital_efficiency_score, 0);
        const excessWinRate = toNumber(item.excess_win_rate, 0);
        const pnlPer10k = toNumber(item.pnl_per_10k, 0);
        const score =
          capitalEfficiency + avgExcess * 2 + (excessWinRate - 50) * 0.12 + Math.log1p(closedCount);
        let verdict: 'effective' | 'watch' | 'ineffective' = 'watch';
        let next_action = '继续采样';
        let reason = `${item.label}闭环 ${closedCount} 笔，继续等待样本确认`;

        if (closedCount >= 2 && avgExcess >= 0.6 && capitalEfficiency >= 4 && excessWinRate >= 50) {
          verdict = 'effective';
          next_action = '保留并允许继续参与下一轮自动调权';
          reason = `执行后跑赢：超额 ${roundNumber(avgExcess, 2)}%，效率 ${roundNumber(
            capitalEfficiency,
            1
          )}`;
        } else if (closedCount >= 2 && (avgExcess <= -0.6 || capitalEfficiency < 0)) {
          verdict = 'ineffective';
          next_action = '下调该执行规则权重，必要时禁入';
          reason = `执行后跑输：超额 ${roundNumber(avgExcess, 2)}%，效率 ${roundNumber(
            capitalEfficiency,
            1
          )}`;
        } else if (closedCount >= 2) {
          reason = `执行效果中性：超额 ${roundNumber(avgExcess, 2)}%，暂不放大`;
        }

        return {
          key: item.key,
          label: item.label,
          closed_count: closedCount,
          tracked_count: toNumber(item.tracked_count ?? item.count, 0),
          avg_excess_return_pct: roundNumber(avgExcess, 4),
          excess_win_rate: roundNumber(excessWinRate, 2),
          capital_efficiency_score: roundNumber(capitalEfficiency, 2),
          pnl_per_10k: roundNumber(pnlPer10k, 2),
          confidence: roundNumber(clamp(closedCount / 10, 0, 1), 2),
          audit_score: roundNumber(score, 2),
          verdict,
          next_action,
          reason,
        };
      })
      .sort(
        (a, b) =>
          b.audit_score - a.audit_score ||
          b.avg_excess_return_pct - a.avg_excess_return_pct ||
          b.closed_count - a.closed_count
      );

    const effective = executions.filter(item => item.verdict === 'effective');
    const ineffective = executions.filter(item => item.verdict === 'ineffective');
    const best_execution = effective[0] || executions[0] || null;
    const weak_execution =
      ineffective[0] ||
      [...executions].sort(
        (a, b) =>
          a.audit_score - b.audit_score ||
          a.avg_excess_return_pct - b.avg_excess_return_pct ||
          b.closed_count - a.closed_count
      )[0] ||
      null;
    const closedCount = executions.reduce((sum, item) => sum + item.closed_count, 0);

    return {
      enabled: executions.length > 0,
      confidence: roundNumber(clamp(closedCount / 20, 0, 1), 2),
      total_closed_count: closedCount,
      effective_count: effective.length,
      ineffective_count: ineffective.length,
      executions,
      best_execution,
      weak_execution,
      reason: best_execution
        ? `最佳执行 ${best_execution.label}，超额 ${best_execution.avg_excess_return_pct}%、效率 ${
            best_execution.capital_efficiency_score
          }；弱项 ${weak_execution?.label || '暂无'}，后续按审计结果继续校准`
        : '预算动作自动策略尚未产生可审计成交',
    };
  }

  private buildBudgetPolicyRollbackAudit(rankings: RecommendationTradeOutcomeBucket[] = []) {
    const executions = rankings
      .filter(item => item.key && item.key !== 'no_budget_policy_rollback')
      .map(item => {
        const closedCount = toNumber(item.closed_count, 0);
        const avgExcess = toNumber(item.avg_excess_return_pct, 0);
        const capitalEfficiency = toNumber(item.capital_efficiency_score, 0);
        const excessWinRate = toNumber(item.excess_win_rate, 0);
        const pnlPer10k = toNumber(item.pnl_per_10k, 0);
        const rollbackScore =
          capitalEfficiency + avgExcess * 2 + (excessWinRate - 50) * 0.12 + Math.log1p(closedCount);
        let verdict: 'effective' | 'watch' | 'ineffective' = 'watch';
        let next_action = '继续采样，暂不改变冠军版本信任度';
        let reason = `${item.label}闭环 ${closedCount} 笔，继续等待回滚效果确认`;

        if (closedCount >= 2 && avgExcess >= 0.6 && capitalEfficiency >= 4 && excessWinRate >= 50) {
          verdict = 'effective';
          next_action = '继续信任该冠军版本/温启动策略';
          reason = `回滚后表现有效：超额 ${roundNumber(avgExcess, 2)}%，效率 ${roundNumber(
            capitalEfficiency,
            1
          )}`;
        } else if (
          closedCount >= 2 &&
          (avgExcess <= -0.8 || capitalEfficiency <= -3 || excessWinRate < 38)
        ) {
          verdict = 'ineffective';
          next_action = '降低该冠军版本信任度，下一轮避免继续回滚到该来源';
          reason = `回滚后仍跑输：超额 ${roundNumber(avgExcess, 2)}%，效率 ${roundNumber(
            capitalEfficiency,
            1
          )}`;
        } else if (closedCount >= 2) {
          reason = `回滚效果中性：超额 ${roundNumber(avgExcess, 2)}%，继续观察来源版本`;
        }

        return {
          key: item.key,
          label: item.label,
          closed_count: closedCount,
          tracked_count: toNumber(item.tracked_count ?? item.count, 0),
          avg_excess_return_pct: roundNumber(avgExcess, 4),
          excess_win_rate: roundNumber(excessWinRate, 2),
          capital_efficiency_score: roundNumber(capitalEfficiency, 2),
          pnl_per_10k: roundNumber(pnlPer10k, 2),
          confidence: roundNumber(clamp(closedCount / 10, 0, 1), 2),
          rollback_score: roundNumber(rollbackScore, 2),
          verdict,
          next_action,
          reason,
        };
      })
      .sort(
        (a, b) =>
          b.rollback_score - a.rollback_score ||
          b.avg_excess_return_pct - a.avg_excess_return_pct ||
          b.closed_count - a.closed_count
      );

    const effective = executions.filter(item => item.verdict === 'effective');
    const ineffective = executions.filter(item => item.verdict === 'ineffective');
    const best_rollback = effective[0] || executions[0] || null;
    const weak_rollback =
      ineffective[0] ||
      [...executions].sort(
        (a, b) =>
          a.rollback_score - b.rollback_score ||
          a.avg_excess_return_pct - b.avg_excess_return_pct ||
          b.closed_count - a.closed_count
      )[0] ||
      null;
    const closedCount = executions.reduce((sum, item) => sum + item.closed_count, 0);

    return {
      enabled: executions.length > 0,
      confidence: roundNumber(clamp(closedCount / 20, 0, 1), 2),
      total_closed_count: closedCount,
      effective_count: effective.length,
      ineffective_count: ineffective.length,
      executions,
      best_rollback,
      weak_rollback,
      reason: best_rollback
        ? `最佳回滚 ${best_rollback.label}，超额 ${best_rollback.avg_excess_return_pct}%、效率 ${
            best_rollback.capital_efficiency_score
          }；弱回滚 ${weak_rollback?.label || '暂无'}，后续按真实收益决定是否继续信任冠军版本`
        : '预算版本回滚尚未产生可审计成交',
    };
  }

  private buildEnvironmentLoopPolicy(options: {
    market_regime_groups: RecommendationTradeOutcomeBucket[];
    industry_regime_groups: RecommendationTradeOutcomeBucket[];
    version_groups?: RecommendationTradeOutcomeBucket[];
    weak_outcome: boolean;
    strong_outcome: boolean;
  }) {
    const marketGroups = options.market_regime_groups || [];
    const industryGroups = options.industry_regime_groups || [];
    const environmentGroups = [
      ...marketGroups.map(group => ({ ...group, dimension: group.dimension || 'market_regime' })),
      ...industryGroups.map(group => ({
        ...group,
        dimension: group.dimension || 'industry_regime',
      })),
    ].filter(group => group.key && group.key !== 'unknown' && group.closed_count > 0);

    const closedSamples = environmentGroups.reduce(
      (sum, group) => sum + toNumber(group.closed_count),
      0
    );
    const confidence = roundNumber(clamp(closedSamples / 24, 0, 1), 2);
    const defaultPositionMultiplier = options.weak_outcome
      ? 0.72
      : options.strong_outcome
      ? 1.04
      : 0.9;

    const normalizeSegment = (group: RecommendationTradeOutcomeBucket) => {
      const robustScore = toNumber(group.robust_score, 0);
      const avgExcess = toNumber(group.avg_excess_return_pct, 0);
      const riskAdjustedExcess = toNumber(group.risk_adjusted_excess_return_pct, avgExcess);
      const excessWinRate = toNumber(group.excess_win_rate, 0);
      const bayesianWinRate = toNumber(group.bayesian_win_rate, 50);
      const closedCount = toNumber(group.closed_count, 0);
      const sampleConfidence = toNumber(group.sample_confidence, clamp(closedCount / 10, 0, 1));

      let action = 'watch';
      let positionMultiplier = defaultPositionMultiplier;
      let reason = `样本 ${closedCount}，继续观察`;

      const shouldBlock =
        closedCount >= 3 &&
        (robustScore <= -6 || avgExcess <= -3 || riskAdjustedExcess <= -1.2 || excessWinRate < 30);
      const shouldReduce =
        closedCount >= 2 &&
        (robustScore <= -3 ||
          avgExcess < -1 ||
          riskAdjustedExcess < -0.8 ||
          bayesianWinRate < 45 ||
          excessWinRate < 40);
      const shouldBoost =
        closedCount >= 2 &&
        robustScore > 3 &&
        avgExcess > 1 &&
        riskAdjustedExcess > 0.5 &&
        bayesianWinRate >= 52 &&
        excessWinRate >= 50;

      if (shouldBlock) {
        action = 'block';
        positionMultiplier = 0;
        reason = `稳健分 ${roundNumber(robustScore, 2)}，平均超额 ${roundNumber(
          avgExcess,
          2
        )}%，暂停自动入场`;
      } else if (shouldReduce) {
        action = 'reduce';
        positionMultiplier = roundNumber(
          clamp(defaultPositionMultiplier * (sampleConfidence >= 0.6 ? 0.58 : 0.72), 0.35, 0.75),
          2
        );
        reason = `平均超额 ${roundNumber(avgExcess, 2)}%，贝叶斯胜率 ${roundNumber(
          bayesianWinRate,
          2
        )}%，降仓验证`;
      } else if (shouldBoost) {
        action = 'boost';
        positionMultiplier = roundNumber(
          clamp(defaultPositionMultiplier * (sampleConfidence >= 0.6 ? 1.14 : 1.06), 0.95, 1.15),
          2
        );
        reason = `平均超额 ${roundNumber(avgExcess, 2)}%，稳健分 ${roundNumber(
          robustScore,
          2
        )}，允许小幅放大`;
      }

      return {
        dimension: group.dimension,
        key: group.key,
        label: group.label,
        closed_count: closedCount,
        sample_confidence: roundNumber(sampleConfidence, 2),
        avg_excess_return_pct: roundNumber(avgExcess, 4),
        excess_win_rate: roundNumber(excessWinRate, 2),
        bayesian_win_rate: roundNumber(bayesianWinRate, 2),
        robust_score: roundNumber(robustScore, 4),
        risk_adjusted_excess_return_pct: roundNumber(riskAdjustedExcess, 4),
        capital_efficiency_score: group.capital_efficiency_score,
        pnl_per_10k: group.pnl_per_10k,
        avg_position_pct: group.avg_position_pct,
        excess_per_position_pct: group.excess_per_position_pct,
        budget_action: group.budget_action,
        budget_action_reason: group.budget_action_reason,
        recommended_budget_multiplier: group.recommended_budget_multiplier,
        action,
        position_multiplier: positionMultiplier,
        reason,
      };
    };

    const segments = environmentGroups.map(normalizeSegment).sort((a, b) => {
      const actionWeight: Record<string, number> = { block: 0, reduce: 1, watch: 2, boost: 3 };
      if (actionWeight[a.action] !== actionWeight[b.action]) {
        return actionWeight[a.action] - actionWeight[b.action];
      }
      return a.robust_score - b.robust_score;
    });
    const blockedSegments = segments.filter(segment => segment.action === 'block');
    const reducedSegments = segments.filter(segment => segment.action === 'reduce');
    const boostedSegments = segments
      .filter(segment => segment.action === 'boost')
      .sort(
        (a, b) =>
          b.robust_score - a.robust_score || b.avg_excess_return_pct - a.avg_excess_return_pct
      );
    const watchSegments = segments.filter(segment => segment.action === 'watch');

    return {
      enabled: true,
      confidence,
      closed_samples: closedSamples,
      default_position_multiplier: roundNumber(defaultPositionMultiplier, 2),
      blocked_segments: blockedSegments,
      reduced_segments: reducedSegments,
      boosted_segments: boostedSegments,
      watch_segments: watchSegments.slice(0, 8),
      version_rankings: (options.version_groups || [])
        .filter(group => group.key && group.key !== 'unknown')
        .slice(0, 8),
      rules: [
        '样本≥3且稳健分/超额收益显著转弱：暂停该环境自动入场',
        '样本≥2且平均超额或贝叶斯胜率偏弱：降仓小样本验证',
        '稳健分、平均超额、贝叶斯胜率均占优：仅小幅放大，不追高',
      ],
      reason: blockedSegments[0]
        ? `发现 ${blockedSegments.length} 个需暂停环境，优先保护本金`
        : reducedSegments[0]
        ? `发现 ${reducedSegments.length} 个需降仓环境，下一轮控制试错成本`
        : boostedSegments[0]
        ? `发现 ${boostedSegments.length} 个优势环境，可小幅放大验证`
        : '环境样本未出现显著优劣，维持保守仓位',
    };
  }

  async upsertFromExecutedSignal(
    signal: AIInvestmentSignal,
    options: { include_open?: boolean; portfolio_id?: number } = {}
  ): Promise<RecommendationTradeOutcome | null> {
    const metadata = asPlainObject(signal.metadata);
    const paperTrading = paperTradingMetaForPortfolio(metadata, options.portfolio_id);
    const strategyVariant = asPlainObject(metadata.strategy_variant);
    const strategyKey =
      metadata.strategy_key ||
      strategyVariant.strategy_key ||
      paperTrading.strategy_key ||
      asPlainObject(paperTrading.strategy_variant).strategy_key;
    const environmentPolicy = asPlainObject(
      paperTrading.environment_policy || metadata.environment_policy
    );
    const environmentPolicySnapshotId =
      environmentPolicy.external_policy_snapshot_id ||
      environmentPolicy.snapshot_id ||
      metadata.environment_policy_snapshot_id;
    const portfolio_id = Number(options.portfolio_id || paperTrading.portfolio_id);
    if (!portfolio_id || !paperTrading.trade_id) return null;

    const entryTrade = await PaperTradingTrade.findOne({
      where: { id: Number(paperTrading.trade_id), portfolio_id },
    });
    const exitTrade = paperTrading.sell_trade_id
      ? await PaperTradingTrade.findOne({
          where: { id: Number(paperTrading.sell_trade_id), portfolio_id },
        })
      : null;
    const stock = await Stock.findOne({ where: { symbol: normalizeSymbol(signal.symbol) } });
    const position =
      paperTrading.status !== 'closed'
        ? await PaperTradingPosition.findOne({
            where: { portfolio_id, symbol: normalizeSymbol(signal.symbol) },
          })
        : null;

    const entryPrice = roundNumber(
      toNumber(
        paperTrading.execute_price,
        toNumber(entryTrade?.execute_price, toNumber(signal.current_price))
      ),
      4
    );
    const exitPrice = exitTrade
      ? roundNumber(toNumber(paperTrading.exit_price, toNumber(exitTrade.execute_price)), 4)
      : undefined;
    const latestPrice = roundNumber(
      toNumber(
        position?.current_price,
        exitPrice ??
          toNumber(paperTrading.latest_price, toNumber(entryTrade?.execute_price, entryPrice))
      ),
      4
    );
    const quantity = Math.floor(
      toNumber(
        paperTrading.exit_quantity,
        toNumber(
          paperTrading.quantity,
          toNumber(exitTrade?.quantity, toNumber(entryTrade?.quantity))
        )
      )
    );
    if (!entryPrice || !quantity) return null;

    const entryAmount = roundNumber(
      toNumber(paperTrading.amount, toNumber(entryTrade?.amount, entryPrice * quantity)),
      2
    );
    const exitAmount = exitTrade
      ? roundNumber(
          toNumber(
            paperTrading.exit_amount,
            toNumber(exitTrade.amount, (exitPrice || 0) * quantity)
          ),
          2
        )
      : undefined;
    const totalCommission = roundNumber(
      toNumber(paperTrading.commission, toNumber(entryTrade?.commission)) +
        toNumber(paperTrading.exit_commission, toNumber(exitTrade?.commission)),
      2
    );
    const entryDate = dateOnly(
      paperTrading.executed_at || entryTrade?.created_at || signal.signal_date
    );
    const exitDate = exitTrade
      ? dateOnly(paperTrading.closed_at || exitTrade.created_at)
      : undefined;
    const tradeStatus = paperTrading.status === 'closed' || exitTrade ? 'closed' : 'open';
    const effectiveExitDate = exitDate || getChinaToday();
    const realizedPnl =
      tradeStatus === 'closed'
        ? roundNumber(
            toNumber(
              paperTrading.realized_pnl,
              toNumber(
                exitTrade?.realized_pnl,
                toNumber(exitAmount) - entryAmount - totalCommission
              )
            ),
            2
          )
        : 0;
    const realizedPnlPct =
      tradeStatus === 'closed'
        ? roundNumber(
            toNumber(
              paperTrading.realized_pnl_pct,
              exitPrice && entryPrice ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0
            ),
            4
          )
        : 0;
    const unrealizedPnl =
      tradeStatus === 'open'
        ? roundNumber(toNumber(position?.unrealized_pnl, (latestPrice - entryPrice) * quantity), 2)
        : 0;
    const unrealizedPnlPct =
      tradeStatus === 'open' && entryPrice > 0
        ? roundNumber(((latestPrice - entryPrice) / entryPrice) * 100, 4)
        : 0;
    const totalPnl = tradeStatus === 'closed' ? realizedPnl : unrealizedPnl;
    const totalPnlPct = tradeStatus === 'closed' ? realizedPnlPct : unrealizedPnlPct;
    const mfeMae = await this.computeExcursions({
      stock,
      entry_date: entryDate,
      exit_date: effectiveExitDate,
      entry_price: entryPrice,
    });
    const benchmark = await this.resolveBenchmark({
      symbol: signal.symbol,
      stock,
      entry_date: entryDate,
      exit_date: effectiveExitDate,
      total_pnl_pct: totalPnlPct,    });

    // Phase 5: 自动归类 root_cause
    // 输入收集 (有什么用什么，全部 optional)
    const signalMetadataForRc = asPlainObject(metadata.signal_metadata);
    const rootCauseInput: TradeRootCauseInput = {
      return_pct: totalPnlPct,
      holding_days: toNumber(
        paperTrading.holding_days,
        holdingDays(entryDate, exitDate || effectiveExitDate)
      ),
      exit_reason: paperTrading.exit_reason || null,
      entry_price: entryPrice,
      exit_price: exitPrice || latestPrice,
      market_regime_at_entry:
        asPlainObject(signalMetadataForRc.market_environment).market_regime ||
        asPlainObject(metadata.market_environment).market_regime ||
        null,
      // 卖出时 regime 在 outcome 没有持久化；先用 entry regime 兜底 (相同 = 不算 wrong_regime)
      market_regime_at_exit:
        asPlainObject(metadata.exit_market_environment).market_regime ||
        asPlainObject(signalMetadataForRc.market_environment).market_regime ||
        asPlainObject(metadata.market_environment).market_regime ||
        null,
      signal_catalyst:
        (metadata.signal_catalyst as string) ||
        (signal.source_type as string) ||
        null,
      max_drawdown_during_hold_pct:
        Math.abs(Number(mfeMae.max_adverse_excursion_pct) || 0) || undefined,
      // strategy_stop_loss_pct / strategy_max_holding_days / backtest_expected
      // 暂时不传 (后续可从 strategy_variant 或 latest_metrics 拉)
    };
    const rcResult = classifyTradeRootCause(rootCauseInput);

    // Phase 5+: 当 root_cause 属于 "可学习" 类别（亏损/wrong_entry/wrong_regime 等）
    // 时，自动生成结构化复盘 (5-bullet + suggestions + baseline 对比)。
    // tradePostmortemService.generate() 内部对 profit_take/unknown 返回 null，
    // 所以失败/盈利 trade 不会被强行生成空 postmortem。
    let postmortem: any = null;
    if (tradeStatus === 'closed') {
      try {
        postmortem = await tradePostmortemService.generate({
          strategy_key: strategyKey,
          root_cause: rcResult.root_cause,
          root_cause_label: rcResult.root_cause_label,
          symbol: normalizeSymbol(signal.symbol),
          total_pnl_pct: totalPnlPct,
          holding_days: Number(holdingDays || 0),
          entry_price: Number(entryPrice) || undefined,
          exit_price: Number(exitPrice) || undefined,
          max_drawdown_during_hold_pct:
            Math.abs(Number(mfeMae.max_adverse_excursion_pct) || 0) || undefined,
          market_regime_at_entry: rootCauseInput.market_regime_at_entry,
          market_regime_at_exit: rootCauseInput.market_regime_at_exit,
          signal_catalyst: rootCauseInput.signal_catalyst,
          exit_reason: rootCauseInput.exit_reason,
          signal_score: toOptionalNumber(signal.confidence_score),
          fetch_baseline: true,
        });
      } catch (pmErr: any) {
        // 失败不阻塞主流程
        logger.warn(`[postmortem] generate failed: ${pmErr?.message || pmErr}`);
      }
    }

    const payload: Record<string, any> = {
      portfolio_id,
      signal_id: signal.id,
      loop_run_id: signal.loop_run_id || metadata.loop_run_id || paperTrading.loop_run_id,
      source_type: signal.source_type,
      source_id: signal.source_id,
      symbol: normalizeSymbol(signal.symbol),
      name: signal.name || stock?.name || normalizeSymbol(signal.symbol),
      signal_date: signal.signal_date,
      decision: signal.normalized_decision || signal.decision,
      score: toOptionalNumber(signal.confidence_score),
      risk_level: signal.risk_level || metadata.risk_level,
      action: metadata.action,
      action_label: metadata.action_label,
      agent_session: metadata.agent_session,
      recommendation_style: metadata.style || metadata.recommendation_style,
      recommendation_source: metadata.universe || metadata.recommendation_source || metadata.source,
      industry: stock?.industry || metadata.industry,
      market: stock?.market || extractMarket(signal.symbol),
      trade_status: tradeStatus,
      entry_trade_id: toOptionalNumber(paperTrading.trade_id),
      exit_trade_id: toOptionalNumber(paperTrading.sell_trade_id),
      entry_date: entryDate,
      exit_date: exitDate,
      entry_price: entryPrice,
      exit_price: exitPrice,
      latest_price: latestPrice,
      quantity,
      position_pct: toOptionalNumber(
        paperTrading.target_position_pct ?? metadata.suggested_position_pct
      ),
      entry_amount: entryAmount,
      exit_amount: exitAmount,
      total_commission: totalCommission,
      realized_pnl: realizedPnl,
      realized_pnl_pct: realizedPnlPct,
      unrealized_pnl: unrealizedPnl,
      unrealized_pnl_pct: unrealizedPnlPct,
      total_pnl: roundNumber(totalPnl, 2),
      total_pnl_pct: roundNumber(totalPnlPct, 4),
      max_favorable_excursion_pct: mfeMae.max_favorable_excursion_pct,
      max_adverse_excursion_pct: mfeMae.max_adverse_excursion_pct,
      holding_days: toNumber(paperTrading.holding_days, holdingDays(entryDate, exitDate)),
      benchmark_code: benchmark?.benchmark_code,
      benchmark_name: benchmark?.benchmark_name,
      benchmark_return_pct: benchmark?.benchmark_return_pct,
      excess_return_pct:
        benchmark?.benchmark_return_pct !== undefined
          ? roundNumber(totalPnlPct - benchmark.benchmark_return_pct, 4)
          : undefined,
      exit_reason: paperTrading.exit_reason,
      exit_reason_label: paperTrading.exit_reason_label,
      // Phase 5: root cause 三件套
      root_cause: rcResult.root_cause,
      root_cause_label: rcResult.root_cause_label,
      root_cause_confidence: rcResult.confidence,
      metadata: {
        strategy_key: strategyKey,
        // Phase 5: 把 root cause 的 matched_rule + input snapshot 一起放 metadata，
        // 方便人工 review 时知道 classifier 是怎么判的
        root_cause_diagnostics: {
          matched_rule: rcResult.matched_rule,
          input_snapshot: rootCauseInput,
        },
        // Phase 5+: 5-bullet 复盘 (仅当 root_cause 属于可学习类别时存在)
        postmortem,
        strategy_variant: Object.keys(strategyVariant).length
          ? strategyVariant
          : asPlainObject(paperTrading.strategy_variant),
        strategy_bucket_label:
          metadata.strategy_bucket_label ||
          strategyVariant.strategy_bucket_label ||
          asPlainObject(paperTrading.strategy_variant).strategy_bucket_label,
        market_environment: metadata.market_environment || environmentPolicy.market_environment,
        environment_policy: environmentPolicy,
        environment_policy_snapshot_id: environmentPolicySnapshotId,
        environment_strategy_adjustment: metadata.environment_strategy_adjustment,
        environment_strategy_policy_label: metadata.environment_strategy_policy_label,
        environment_strategy_policy_action: metadata.environment_strategy_policy_action,
        environment_strategy_budget_action: metadata.environment_strategy_budget_action,
        environment_strategy_budget_reason: metadata.environment_strategy_budget_reason,
        environment_strategy_budget_multiplier: metadata.environment_strategy_budget_multiplier,
        strategy_budget_action:
          metadata.strategy_budget_action || paperTrading.strategy_budget_action,
        strategy_budget_label: metadata.strategy_budget_label || paperTrading.strategy_budget_label,
        strategy_budget_reason:
          metadata.strategy_budget_reason || paperTrading.strategy_budget_reason,
        strategy_budget_confidence:
          metadata.strategy_budget_confidence || paperTrading.strategy_budget_confidence,
        strategy_budget_discipline:
          metadata.strategy_budget_discipline || paperTrading.strategy_budget_discipline,
        entry_risk_guard_decision:
          metadata.entry_risk_guard_decision || paperTrading.entry_risk_guard_decision,
        execution_reality_decision:
          metadata.execution_reality_decision || paperTrading.execution_reality_decision,
        environment_strategy_budget_policy_action:
          metadata.environment_strategy_budget_policy_action,
        environment_strategy_budget_policy_reason:
          metadata.environment_strategy_budget_policy_reason,
        environment_strategy_budget_policy_score_adjustment:
          metadata.environment_strategy_budget_policy_score_adjustment,
        environment_strategy_budget_policy_multiplier:
          metadata.environment_strategy_budget_policy_multiplier,
        environment_strategy_budget_policy_version_id:
          metadata.environment_strategy_budget_policy_version_id,
        environment_strategy_budget_policy_version_hash:
          metadata.environment_strategy_budget_policy_version_hash,
        budget_policy_version_snapshot_id:
          metadata.budget_policy_version_snapshot_id ||
          paperTrading.budget_policy_version_snapshot_id,
        environment_strategy_budget_policy_version_guard_action:
          metadata.environment_strategy_budget_policy_version_guard_action,
        environment_strategy_budget_policy_version_guard_reason:
          metadata.environment_strategy_budget_policy_version_guard_reason,
        environment_strategy_budget_policy_version_guard_champion:
          metadata.environment_strategy_budget_policy_version_guard_champion,
        environment_strategy_budget_policy_rollback_action:
          metadata.environment_strategy_budget_policy_rollback_action ||
          paperTrading.environment_strategy_budget_policy_rollback_action,
        environment_strategy_budget_policy_rollback_source:
          metadata.environment_strategy_budget_policy_rollback_source ||
          paperTrading.environment_strategy_budget_policy_rollback_source,
        environment_strategy_budget_policy_rollback_snapshot_id:
          metadata.environment_strategy_budget_policy_rollback_snapshot_id ||
          paperTrading.environment_strategy_budget_policy_rollback_snapshot_id,
        environment_strategy_budget_policy_rollback_reason:
          metadata.environment_strategy_budget_policy_rollback_reason ||
          paperTrading.environment_strategy_budget_policy_rollback_reason,
        environment_strategy_capital_efficiency_score:
          metadata.environment_strategy_capital_efficiency_score,
        signal_metadata: metadata,
        paper_trading: paperTrading,
        benchmark,
        consensus: {
          consensus_count: toOptionalNumber(metadata.consensus_count),
          consensus_bonus: toOptionalNumber(metadata.consensus_bonus),
          original_score: toOptionalNumber(metadata.original_score),
          consensus_variants: Array.isArray(metadata.consensus_variants)
            ? metadata.consensus_variants
            : [],
          recommendation_tier: metadata.recommendation_tier,
          recommendation_tier_label: metadata.recommendation_tier_label,
        },
        refreshed_at: new Date().toISOString(),
        latest_position_id: position?.id,
        stock_id: stock?.id,
      },
    };

    const existing = await RecommendationTradeOutcome.findOne({
      where: { portfolio_id, signal_id: signal.id },
    });
    if (existing) {
      await existing.update(payload);
      // Phase 2+ Kelly: invalidate 缓存让下次 sizing 用最新统计
      strategyKellyStatsService.invalidateAll();
      return existing;
    }

    const created = await RecommendationTradeOutcome.create(payload as any);
    // Phase 2+ Kelly: invalidate 缓存让下次 sizing 用最新统计
    strategyKellyStatsService.invalidateAll();
    return created;
  }

  private async resolveBenchmark(params: {
    symbol: string;
    stock?: Stock | null;
    entry_date: string;
    exit_date: string;
    total_pnl_pct: number;
  }) {
    try {
      const benchmark = await benchmarkIndexService.getBenchmarkReturnForStock(
        params.symbol,
        params.entry_date,
        params.exit_date,
        { stock: params.stock, auto_sync: true }
      );
      return benchmark || null;
    } catch (error: any) {
      logger.warn(`推荐交易收益闭环基准收益计算失败 ${params.symbol}: ${error?.message || error}`);
      return null;
    }
  }

  private async computeExcursions(params: {
    stock?: Stock | null;
    entry_date: string;
    exit_date: string;
    entry_price: number;
  }): Promise<{ max_favorable_excursion_pct?: number; max_adverse_excursion_pct?: number }> {
    if (!params.stock?.id || !params.entry_price) return {};
    const { start, end } = safeDateWindow(params.entry_date, params.exit_date);
    const bars = await DailyBar.findAll({
      where: {
        stock_id: params.stock.id,
        time: { [Op.gte]: start, [Op.lte]: end },
      },
      order: [['time', 'ASC']],
      raw: true,
    });
    if (!bars.length) return {};

    let highest = params.entry_price;
    let lowest = params.entry_price;
    for (const bar of bars as any[]) {
      const high = toNumber(bar.high, params.entry_price);
      const low = toNumber(bar.low, params.entry_price);
      highest = Math.max(highest, high);
      lowest = Math.min(lowest, low);
    }

    return {
      max_favorable_excursion_pct: roundNumber(
        ((highest - params.entry_price) / params.entry_price) * 100,
        4
      ),
      max_adverse_excursion_pct: roundNumber(
        ((lowest - params.entry_price) / params.entry_price) * 100,
        4
      ),
    };
  }

  private async resolvePortfolio(
    options: Pick<
      RecommendationTradeOutcomeRefreshOptions,
      | 'user_id'
      | 'username'
      | 'portfolio_id'
      | 'portfolio_name'
      | 'initial_capital'
      | 'force_new_portfolio'
    >
  ): Promise<PaperTradingPortfolio> {
    if (options.portfolio_id) {
      const portfolio = await PaperTradingPortfolio.findByPk(options.portfolio_id);
      if (portfolio) return portfolio;
    }

    const user = await this.resolveUser(options.user_id, options.username);
    if (options.portfolio_name) {
      const namedPortfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id, name: options.portfolio_name },
        order: [['id', 'ASC']],
      });
      if (namedPortfolio) return namedPortfolio;
    }

    let portfolio: PaperTradingPortfolio | null = null;
    if (!options.portfolio_name) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id, is_active: true },
        order: [['id', 'ASC']],
      });
    }
    if (!portfolio) {
      portfolio = await paperTradingAutomationService.ensurePortfolio({
        user_id: user.id,
        username: user.username,
        name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new: options.force_new_portfolio,
      });
    }
    return portfolio;
  }

  private async resolveUser(user_id?: number, username?: string): Promise<User> {
    if (user_id) {
      const user = await User.findByPk(user_id);
      if (user) return user;
    }

    const preferredUsername = username || process.env.PAPER_TRADING_DEFAULT_USERNAME || 'stock';
    let user = await User.findOne({ where: { username: preferredUsername } });
    if (!user && preferredUsername !== 'stock') {
      user = await User.findOne({ where: { username: 'stock' } });
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
    if (!user) throw new Error('未找到可用于推荐交易收益闭环的用户');
    return user;
  }

  private buildOutcomeWhere(
    options: RecommendationTradeOutcomeQueryOptions & { portfolio_id: number }
  ) {
    const where: any = { portfolio_id: options.portfolio_id };
    if (options.trade_status && options.trade_status !== 'all')
      where.trade_status = options.trade_status;
    if (options.loop_run_id) where.loop_run_id = options.loop_run_id;
    if (options.source_type && options.source_type !== 'all')
      where.source_type = options.source_type;
    if (options.agent_session) where.agent_session = options.agent_session;
    if (options.signal_id) where.signal_id = options.signal_id;
    if (options.start_date || options.end_date) {
      where.entry_date = {};
      if (options.start_date) where.entry_date[Op.gte] = options.start_date;
      if (options.end_date) where.entry_date[Op.lte] = options.end_date;
    } else if (options.lookback_days) {
      where.entry_date = {
        [Op.gte]: moment()
          .tz('Asia/Shanghai')
          .subtract(toPositiveInt(options.lookback_days, 180, 3650), 'days')
          .format('YYYY-MM-DD'),
      };
    }
    return where;
  }

  private buildTraceConclusion(outcome: RecommendationTradeOutcome) {
    const pnlPct = toNumber(outcome.total_pnl_pct);
    const excessPct = toNumber(outcome.excess_return_pct);
    const status = outcome.trade_status === 'closed' ? '已闭环' : '持仓中';
    const action =
      pnlPct > 0 && excessPct >= 0
        ? '有效'
        : pnlPct > 0
        ? '绝对收益有效但跑输基准'
        : '暂未验证有效';
    return `${status}：${outcome.name || outcome.symbol} 收益 ${roundNumber(
      pnlPct,
      2
    )}%，超额 ${roundNumber(excessPct, 2)}%，推荐链路${action}。`;
  }

  private buildTraceUrl(outcome: RecommendationTradeOutcome): string {
    const baseUrl = String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');
    const id = outcome.signal_id || outcome.id;
    const path = `/signals/${id}/trace`;
    return baseUrl ? `${baseUrl}${path}` : path;
  }

  private buildTraceSummary(params: {
    outcome: RecommendationTradeOutcome;
    signal?: AIInvestmentSignal | null;
    metadata: Record<string, any>;
    signalMetadata: Record<string, any>;
    paperTrading: Record<string, any>;
    quantSignals: QuantSignal[];
    fusionAudits: QuantFusionAudit[];
    taskLogs: TaskExecutionLog[];
    strategyKey: string;
    traceUrl: string;
    traceId: string;
    conclusion: string;
    keyEvidence: any[];
  }): Record<string, any> {
    const {
      outcome,
      signal,
      metadata,
      signalMetadata,
      paperTrading,
      quantSignals,
      fusionAudits,
      taskLogs,
      strategyKey,
      traceUrl,
      traceId,
      conclusion,
      keyEvidence,
    } = params;
    const latestFusion = fusionAudits[0];
    const latestQuant = quantSignals[0];
    const env =
      asPlainObject(metadata.market_environment).market_regime ||
      asPlainObject(signalMetadata.market_environment).market_regime ||
      asPlainObject(asPlainObject(paperTrading.environment_policy).market_environment)
        .market_regime;

    return {
      trace_id: traceId,
      trace_url: traceUrl,
      outcome_id: outcome.id,
      signal_id: outcome.signal_id,
      loop_run_id: outcome.loop_run_id,
      symbol: outcome.symbol,
      name: outcome.name,
      source_type: outcome.source_type,
      source_label: sourceTypeLabel(outcome.source_type),
      source_id: outcome.source_id,
      task_name: taskLogs[0]?.task_name || signalMetadata.task_label || metadata.task_label,
      strategy_key: strategyKey,
      strategy_label: recommendationStrategyKeyLabel(strategyKey),
      agent_session:
        outcome.agent_session || signalMetadata.agent_session || metadata.agent_session,
      agent_session_label: agentSessionLabel(
        outcome.agent_session || signalMetadata.agent_session || metadata.agent_session
      ),
      signal_date: outcome.signal_date,
      entry_date: outcome.entry_date,
      exit_date: outcome.exit_date,
      signal_price: roundNumber(signal?.current_price),
      current_price: roundNumber(
        signal?.current_price || outcome.entry_price || outcome.latest_price
      ),
      entry_price: roundNumber(outcome.entry_price),
      latest_price: roundNumber(outcome.latest_price),
      exit_price: roundNumber(outcome.exit_price),
      quantity: outcome.quantity,
      position_pct: roundNumber(outcome.position_pct),
      decision: outcome.decision || signal?.normalized_decision || signal?.decision,
      action_label: outcome.action_label || signalMetadata.action_label || metadata.action_label,
      score: roundNumber(outcome.score ?? signal?.confidence_score),
      risk_level: outcome.risk_level || signal?.risk_level,
      risk_label: riskLabel(outcome.risk_level || signal?.risk_level),
      trade_status: outcome.trade_status,
      trade_status_label: outcome.trade_status === 'closed' ? '已平仓' : '持仓中',
      holding_days: toNumber(outcome.holding_days),
      total_pnl: roundNumber(outcome.total_pnl),
      total_pnl_pct: roundNumber(outcome.total_pnl_pct),
      realized_pnl: roundNumber(outcome.realized_pnl),
      unrealized_pnl: roundNumber(outcome.unrealized_pnl),
      excess_return_pct: roundNumber(outcome.excess_return_pct),
      benchmark_return_pct: roundNumber(outcome.benchmark_return_pct),
      max_favorable_excursion_pct: roundNumber(outcome.max_favorable_excursion_pct),
      max_adverse_excursion_pct: roundNumber(outcome.max_adverse_excursion_pct),
      exit_reason_label: outcome.exit_reason_label,
      conclusion,
      buy_reason: this.buildTraceBuyReason({
        outcome,
        signal,
        metadata,
        signalMetadata,
        quantSignals,
        fusionAudits,
      }),
      sell_or_hold_reason: this.buildTraceSellOrHoldReason({ outcome, paperTrading }),
      current_risk: this.buildTraceRiskSentence({
        outcome,
        metadata,
        signalMetadata,
        paperTrading,
      }),
      top_quant_strategy: latestQuant?.strategy_key,
      top_quant_score: roundNumber(latestQuant?.score),
      top_agent_decision: latestFusion?.final_decision,
      top_agent_score: roundNumber(latestFusion?.final_score),
      market_regime: env || 'unknown',
      market_regime_label: marketRegimeLabel(String(env || 'unknown')),
      key_evidence_count: keyEvidence.length,
    };
  }

  private buildTraceKeyEvidence(params: {
    outcome: RecommendationTradeOutcome;
    signal?: AIInvestmentSignal | null;
    metadata: Record<string, any>;
    signalMetadata: Record<string, any>;
    paperTrading: Record<string, any>;
    quantSignals: QuantSignal[];
    fusionAudits: QuantFusionAudit[];
    trades: PaperTradingTrade[];
    taskLogs: TaskExecutionLog[];
    strategyKey: string;
  }): any[] {
    const {
      outcome,
      signal,
      metadata,
      signalMetadata,
      paperTrading,
      quantSignals,
      fusionAudits,
      trades,
      taskLogs,
      strategyKey,
    } = params;
    const evidence: any[] = [];
    const push = (
      type: string,
      label: string,
      value: string,
      detail?: string,
      weight: 'high' | 'medium' | 'low' = 'medium'
    ) => {
      const safeValue = this.compactTraceText(value, 120);
      if (!safeValue) return;
      evidence.push({
        type,
        label,
        value: safeValue,
        detail: this.compactTraceText(detail, 160),
        weight,
      });
    };

    push(
      'price',
      '信号价格',
      `生成价 ${this.formatTracePrice(
        signal?.current_price || outcome.entry_price
      )}，买入价 ${this.formatTracePrice(outcome.entry_price)}，最新/卖出价 ${this.formatTracePrice(
        outcome.exit_price || outcome.latest_price
      )}`,
      '用于判断推荐时是否追高、后续盈亏是否由价格兑现。',
      'high'
    );
    push(
      'source',
      '推荐来源',
      `${sourceTypeLabel(outcome.source_type)}｜${outcome.source_id}`,
      taskLogs[0]?.task_name || signalMetadata.task_label || metadata.task_label,
      'high'
    );
    if (quantSignals[0]) {
      push(
        'quant',
        '量化命中',
        `${quantSignals[0].strategy_key} ${quantSignals[0].signal}，${roundNumber(
          quantSignals[0].score,
          1
        )}分`,
        quantSignals[0].reason,
        'high'
      );
    }
    if (fusionAudits[0]) {
      push(
        'agent',
        'Agent/融合复核',
        `最终 ${fusionAudits[0].final_decision || '--'}，${roundNumber(
          fusionAudits[0].final_score,
          1
        )}分`,
        fusionAudits[0].rationale,
        'high'
      );
    }
    push(
      'risk',
      '风控依据',
      this.buildTraceRiskSentence({ outcome, metadata, signalMetadata, paperTrading }),
      asPlainObject(metadata.environment_policy).reason ||
        asPlainObject(paperTrading.environment_policy).reason,
      'high'
    );
    const buyTrade = trades.find(trade => trade.direction === 'BUY');
    if (buyTrade) {
      push(
        'entry',
        '模拟买入',
        `${buyTrade.quantity}股｜执行价 ${this.formatTracePrice(
          buyTrade.execute_price
        )}｜金额 ${this.formatTraceMoney(buyTrade.amount)}`,
        buyTrade.created_at
          ? moment(buyTrade.created_at).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm')
          : '',
        'high'
      );
    }
    const sellTrade = trades.find(trade => trade.direction === 'SELL');
    if (sellTrade || outcome.trade_status === 'closed') {
      push(
        'exit',
        '卖出/闭环',
        `${outcome.exit_reason_label || '按模拟盘规则闭环'}｜收益 ${this.formatTracePercent(
          outcome.total_pnl_pct
        )}｜超额 ${this.formatTracePercent(outcome.excess_return_pct)}`,
        sellTrade
          ? `${sellTrade.quantity}股｜执行价 ${this.formatTracePrice(sellTrade.execute_price)}`
          : '',
        'high'
      );
    } else {
      push(
        'tracking',
        '持仓跟踪',
        `持有 ${toNumber(outcome.holding_days)} 天｜浮盈亏 ${this.formatTracePercent(
          outcome.unrealized_pnl_pct
        )}`,
        '继续观察止损、止盈、卖出信号与最长持有期。',
        'medium'
      );
    }
    push(
      'strategy',
      '参数组合',
      recommendationStrategyKeyLabel(strategyKey),
      styleLabel(outcome.recommendation_style),
      'medium'
    );

    return evidence.slice(0, 8);
  }

  private buildTraceDecisionContext(params: {
    outcome: RecommendationTradeOutcome;
    metadata: Record<string, any>;
    signalMetadata: Record<string, any>;
    paperTrading: Record<string, any>;
    strategyKey: string;
    quantSignals: QuantSignal[];
    fusionAudits: QuantFusionAudit[];
  }): Record<string, any> {
    const {
      outcome,
      metadata,
      signalMetadata,
      paperTrading,
      strategyKey,
      quantSignals,
      fusionAudits,
    } = params;
    const marketEnvironment =
      asPlainObject(metadata.market_environment).market_regime ||
      asPlainObject(signalMetadata.market_environment).market_regime ||
      'unknown';
    const industryEnvironment =
      asPlainObject(asPlainObject(metadata.market_environment).industry).regime ||
      asPlainObject(asPlainObject(signalMetadata.market_environment).industry).regime ||
      'unknown';

    return {
      data_dictionary: {
        signal_id: 'AI/量化推荐归档记录 ID',
        outcome_id: '推荐进入模拟盘后的收益闭环记录 ID',
        entry_trade_id: '模拟买入交易流水 ID',
        exit_trade_id: '模拟卖出交易流水 ID',
        quant_signals: '同一交易日、同一股票、同策略的量化原始信号',
        fusion_audits: '量化与 TradingAgents 融合后的复核记录',
        task_logs: '同日相关自动化任务日志',
      },
      market_environment: {
        market_regime: marketEnvironment,
        market_regime_label: marketRegimeLabel(String(marketEnvironment)),
        industry_regime: industryEnvironment,
        industry_label: industryRegimeLabel(String(industryEnvironment)),
      },
      strategy: {
        strategy_key: strategyKey,
        strategy_label: recommendationStrategyKeyLabel(strategyKey),
        style: outcome.recommendation_style || signalMetadata.style || metadata.style,
        style_label: styleLabel(
          outcome.recommendation_style || signalMetadata.style || metadata.style
        ),
      },
      risk: {
        risk_level: outcome.risk_level,
        risk_label: riskLabel(outcome.risk_level),
        position_pct: roundNumber(outcome.position_pct),
        stop_loss_pct: roundNumber(signalMetadata.stop_loss_pct || metadata.stop_loss_pct),
        take_profit_pct: roundNumber(signalMetadata.take_profit_pct || metadata.take_profit_pct),
        environment_policy: metadata.environment_policy || paperTrading.environment_policy || {},
      },
      evidence_counts: {
        quant_signals: quantSignals.length,
        fusion_audits: fusionAudits.length,
      },
    };
  }

  private buildTraceBuyReason(params: {
    outcome: RecommendationTradeOutcome;
    signal?: AIInvestmentSignal | null;
    metadata: Record<string, any>;
    signalMetadata: Record<string, any>;
    quantSignals: QuantSignal[];
    fusionAudits: QuantFusionAudit[];
  }): string {
    const { outcome, signal, metadata, signalMetadata, quantSignals, fusionAudits } = params;
    const reasons = [
      signalMetadata.recommendation_tier_label || metadata.recommendation_tier_label,
      signalMetadata.tier_reason || metadata.tier_reason,
      quantSignals[0]?.reason,
      fusionAudits[0]?.rationale,
      signal?.rationale,
      outcome.action_label,
      `评分 ${roundNumber(outcome.score ?? signal?.confidence_score, 1)}，风险 ${riskLabel(
        outcome.risk_level || signal?.risk_level
      )}`,
    ];
    return (
      this.compactTraceText(reasons.find(Boolean), 180) || '暂无明确买入理由，建议回看来源任务。'
    );
  }

  private buildTraceSellOrHoldReason(params: {
    outcome: RecommendationTradeOutcome;
    paperTrading: Record<string, any>;
  }): string {
    const { outcome, paperTrading } = params;
    if (outcome.trade_status === 'closed') {
      return (
        this.compactTraceText(outcome.exit_reason_label || paperTrading.exit_reason_label, 160) ||
        '已按模拟盘卖出/风控规则完成闭环。'
      );
    }
    return `仍在持仓，当前收益 ${this.formatTracePercent(
      outcome.total_pnl_pct ?? outcome.unrealized_pnl_pct
    )}，继续观察止损、止盈、卖出信号和最长持有期。`;
  }

  private buildTraceRiskSentence(params: {
    outcome: RecommendationTradeOutcome;
    metadata: Record<string, any>;
    signalMetadata: Record<string, any>;
    paperTrading: Record<string, any>;
  }): string {
    const { outcome, metadata, signalMetadata, paperTrading } = params;
    const environmentPolicy = asPlainObject(
      metadata.environment_policy ||
        signalMetadata.environment_policy ||
        paperTrading.environment_policy
    );
    const parts = [
      riskLabel(outcome.risk_level),
      outcome.position_pct !== undefined ? `仓位 ${roundNumber(outcome.position_pct, 2)}%` : '',
      environmentPolicy.action ? `环境动作 ${environmentPolicy.action}` : '',
      environmentPolicy.reason,
    ].filter(Boolean);
    return this.compactTraceText(parts.join('，'), 180) || '暂无风控明细。';
  }

  private compactTraceText(value: any, maxLength = 120): string {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
  }

  private formatTracePrice(value: any): string {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '--';
    return `¥${num.toFixed(2)}`;
  }

  private formatTraceMoney(value: any): string {
    const num = Number(value);
    if (!Number.isFinite(num)) return '--';
    return `¥${num.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
  }

  private formatTracePercent(value: any): string {
    const num = Number(value);
    if (!Number.isFinite(num)) return '--';
    const prefix = num > 0 ? '+' : '';
    return `${prefix}${num.toFixed(2)}%`;
  }

  private buildPathSamples(
    outcomes: any[],
    signalById: Map<number, any>,
    horizons: string[]
  ): any[] {
    const samples: any[] = [];
    for (const outcome of outcomes) {
      const signal = signalById.get(Number(outcome.signal_id));
      const forwardReturns = asPlainObject(signal?.forward_returns);
      const horizonMap = asPlainObject(forwardReturns.horizons);
      for (const horizon of horizons) {
        const item = asPlainObject(horizonMap[horizon]);
        if (item.status !== 'completed') continue;
        const returnPct = toNumber(item.return_pct, NaN);
        if (!Number.isFinite(returnPct)) continue;
        const decision = outcome.decision || signal?.normalized_decision || signal?.decision;
        const directionalReturn =
          item.directional_return_pct !== undefined
            ? toNumber(item.directional_return_pct)
            : ['sell', 'strong_sell'].includes(String(decision || '').toLowerCase())
            ? -returnPct
            : returnPct;
        samples.push({
          outcome_id: outcome.id,
          signal_id: outcome.signal_id,
          symbol: outcome.symbol,
          name: outcome.name,
          source_type: outcome.source_type,
          recommendation_style: outcome.recommendation_style,
          risk_level: outcome.risk_level,
          score: toNumber(outcome.score),
          signal_date: outcome.signal_date,
          entry_date: forwardReturns.entry_date || outcome.entry_date,
          entry_price: toNumber(forwardReturns.entry_price, toNumber(outcome.entry_price)),
          horizon,
          horizon_days: Number(horizon.replace('d', '')),
          exit_date: item.exit_date,
          exit_price: toNumber(item.exit_price),
          return_pct: roundNumber(returnPct, 4),
          directional_return_pct: roundNumber(directionalReturn, 4),
          excess_return_pct: roundNumber(toNumber(item.excess_return_pct, directionalReturn), 4),
          max_favorable_excursion_pct: roundNumber(toNumber(item.max_favorable_excursion_pct), 4),
          max_adverse_excursion_pct: roundNumber(toNumber(item.max_adverse_excursion_pct), 4),
          trade_status: outcome.trade_status,
          total_pnl_pct: toNumber(outcome.total_pnl_pct),
        });
      }
    }
    return samples;
  }

  private buildSymbolPathSummaries(pathSamples: any[], outcomes: any[]) {
    const grouped = new Map<string, any[]>();
    for (const sample of pathSamples) {
      if (!grouped.has(sample.symbol)) grouped.set(sample.symbol, []);
      grouped.get(sample.symbol)!.push(sample);
    }
    const outcomeBySymbol = new Map<string, any[]>();
    for (const outcome of outcomes) {
      if (!outcomeBySymbol.has(outcome.symbol)) outcomeBySymbol.set(outcome.symbol, []);
      outcomeBySymbol.get(outcome.symbol)!.push(outcome);
    }

    return [...grouped.entries()]
      .map(([symbol, samples]) => {
        const first = samples[0] || {};
        const symbolOutcomes = outcomeBySymbol.get(symbol) || [];
        const latestOutcome = [...symbolOutcomes].sort((a, b) =>
          String(b.entry_date || b.signal_date).localeCompare(String(a.entry_date || a.signal_date))
        )[0];
        const bestHorizon = [...samples].sort(
          (a, b) => b.directional_return_pct - a.directional_return_pct
        )[0];
        const worstHorizon = [...samples].sort(
          (a, b) => a.directional_return_pct - b.directional_return_pct
        )[0];
        return {
          symbol,
          name: first.name || latestOutcome?.name,
          latest_signal_date: latestOutcome?.signal_date || first.signal_date,
          trade_status: latestOutcome?.trade_status,
          score: latestOutcome?.score,
          count: samples.length,
          avg_directional_return_pct: roundNumber(
            average(samples.map(item => item.directional_return_pct)),
            4
          ),
          avg_excess_return_pct: roundNumber(
            average(samples.map(item => item.excess_return_pct)),
            4
          ),
          best_horizon: bestHorizon?.horizon,
          best_horizon_return_pct: bestHorizon?.directional_return_pct,
          worst_horizon: worstHorizon?.horizon,
          worst_horizon_return_pct: worstHorizon?.directional_return_pct,
          path: samples.sort((a, b) => a.horizon_days - b.horizon_days),
        };
      })
      .sort(
        (a, b) =>
          b.avg_directional_return_pct - a.avg_directional_return_pct ||
          b.avg_excess_return_pct - a.avg_excess_return_pct
      )
      .slice(0, 30);
  }

  private buildSummary(records: RecommendationTradeOutcome[]): RecommendationTradeOutcomeSummary {
    const plain = records.map(record => modelToPlain<any>(record));
    const closed = plain.filter(item => item.trade_status === 'closed');
    const open = plain.filter(item => item.trade_status !== 'closed');
    const wins = closed.filter(item => toNumber(item.realized_pnl) > 0);
    const losses = closed.filter(item => toNumber(item.realized_pnl) < 0);
    const excessWins = closed.filter(item => toNumber(item.excess_return_pct) > 0);
    const totalRealized = roundNumber(
      closed.reduce((sum, item) => sum + toNumber(item.realized_pnl), 0),
      2
    );
    const totalUnrealized = roundNumber(
      open.reduce((sum, item) => sum + toNumber(item.unrealized_pnl), 0),
      2
    );
    const winSum = wins.reduce((sum, item) => sum + toNumber(item.realized_pnl), 0);
    const lossSum = Math.abs(losses.reduce((sum, item) => sum + toNumber(item.realized_pnl), 0));
    const avgWinPct = average(wins.map(item => toNumber(item.realized_pnl_pct)));
    const avgLossPct = average(losses.map(item => toNumber(item.realized_pnl_pct)));
    const bestTrade = [...plain].sort(
      (a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct)
    )[0];
    const worstTrade = [...plain].sort(
      (a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct)
    )[0];

    return {
      total_count: plain.length,
      open_count: open.length,
      closed_count: closed.length,
      win_count: wins.length,
      loss_count: losses.length,
      excess_win_count: excessWins.length,
      total_realized_pnl: totalRealized,
      total_unrealized_pnl: totalUnrealized,
      total_pnl: roundNumber(totalRealized + totalUnrealized, 2),
      avg_total_pnl_pct: roundNumber(average(plain.map(item => toNumber(item.total_pnl_pct))), 4),
      avg_closed_return_pct: roundNumber(
        average(closed.map(item => toNumber(item.realized_pnl_pct))),
        4
      ),
      avg_excess_return_pct: roundNumber(
        average(closed.map(item => toNumber(item.excess_return_pct))),
        4
      ),
      win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
      excess_win_rate: closed.length
        ? roundNumber((excessWins.length / closed.length) * 100, 2)
        : 0,
      payoff_ratio:
        avgWinPct && avgLossPct
          ? roundNumber(avgWinPct / Math.abs(avgLossPct), 4)
          : wins.length > 0 && losses.length === 0
          ? 999
          : 0,
      profit_factor: lossSum > 0 ? roundNumber(winSum / lossSum, 4) : wins.length > 0 ? 999 : 0,
      avg_holding_days: roundNumber(average(plain.map(item => toNumber(item.holding_days))), 2),
      avg_mfe_pct: roundNumber(
        average(plain.map(item => toNumber(item.max_favorable_excursion_pct))),
        4
      ),
      avg_mae_pct: roundNumber(
        average(plain.map(item => toNumber(item.max_adverse_excursion_pct))),
        4
      ),
      open_exposure: roundNumber(
        open.reduce((sum, item) => sum + toNumber(item.latest_price) * toNumber(item.quantity), 0),
        2
      ),
      best_trade: bestTrade,
      worst_trade: worstTrade,
    };
  }

  /**
   * Phase 5+: 构造"策略 × 根因"交叉矩阵
   *
   * 对每个 strategy_key 单独按 root_cause 聚合，输出：
   *   - total_closed: 该策略闭环交易总数
   *   - by_root_cause[]: 每种 root_cause 的 count/pct/avg_return
   *     按 count desc 排序
   *
   * 只考虑 status='closed' 的 trade；最多取 top 10 个 strategy_key（按 closed_count 降序）
   * 避免 dashboard JSON 爆炸。
   */
  private buildCrossStrategyRootCause(
    outcomes: RecommendationTradeOutcome[]
  ): RecommendationTradeOutcomeDashboard['cross_strategy_root_cause'] {
    const closed = outcomes.filter(o => o.trade_status === 'closed');
    if (closed.length === 0) return [];

    // 1. 按 strategy_key 分组
    const byStrategy = new Map<string, RecommendationTradeOutcome[]>();
    for (const o of closed) {
      const key = strategyKeyFromOutcome(o) || 'unknown';
      if (!byStrategy.has(key)) byStrategy.set(key, []);
      byStrategy.get(key)!.push(o);
    }

    // 2. 取 top 10 strategy by closed_count desc
    const topStrategies = Array.from(byStrategy.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10);

    // 3. 对每个 strategy 内部按 root_cause 聚合
    return topStrategies.map(([strategyKey, rows]) => {
      const byRC = new Map<string, RecommendationTradeOutcome[]>();
      for (const r of rows) {
        const rc = String((r as any).root_cause || 'unclassified');
        if (!byRC.has(rc)) byRC.set(rc, []);
        byRC.get(rc)!.push(r);
      }
      const totalClosed = rows.length;
      const byRootCause = Array.from(byRC.entries())
        .map(([rc, rcRows]) => {
          const sumReturn = rcRows.reduce(
            (sum, r) => sum + Number(r.total_pnl_pct ?? r.realized_pnl_pct ?? 0),
            0
          );
          return {
            root_cause: rc,
            root_cause_label: rootCauseLabel(rc),
            count: rcRows.length,
            pct: (rcRows.length / totalClosed) * 100,
            avg_return_pct: rcRows.length > 0 ? sumReturn / rcRows.length : 0,
          };
        })
        .sort((a, b) => b.count - a.count);
      return {
        strategy_key: strategyKey,
        strategy_label: recommendationStrategyKeyLabel(strategyKey),
        total_closed: totalClosed,
        by_root_cause: byRootCause,
      };
    });
  }

  private buildBuckets(
    records: RecommendationTradeOutcome[],
    keySelector: (record: RecommendationTradeOutcome) => string | undefined | null,
    labelSelector: (key: string) => string,
    dimension = 'segment'
  ): RecommendationTradeOutcomeBucket[] {
    const grouped = new Map<string, RecommendationTradeOutcome[]>();
    for (const record of records) {
      const key = String(keySelector(record) || 'unknown');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(record);
    }

    return [...grouped.entries()]
      .map(([key, items]) => {
        const plain = items.map(item => modelToPlain<any>(item));
        const closed = plain.filter(item => item.trade_status === 'closed');
        const open = plain.filter(item => item.trade_status !== 'closed');
        const wins = closed.filter(item => toNumber(item.realized_pnl) > 0);
        const excessWins = closed.filter(item => toNumber(item.excess_return_pct) > 0);
        const consensusCounts = plain.map(item =>
          toNumber(asPlainObject(asPlainObject(item.metadata).signal_metadata).consensus_count, 0)
        );
        const consensusBonuses = plain.map(item =>
          toNumber(asPlainObject(asPlainObject(item.metadata).signal_metadata).consensus_bonus, 0)
        );
        const best = [...plain].sort(
          (a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct)
        )[0];
        const worst = [...plain].sort(
          (a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct)
        )[0];
        const winSum = closed
          .filter(item => toNumber(item.realized_pnl) > 0)
          .reduce((sum, item) => sum + toNumber(item.realized_pnl), 0);
        const lossSum = Math.abs(
          closed
            .filter(item => toNumber(item.realized_pnl) < 0)
            .reduce((sum, item) => sum + toNumber(item.realized_pnl), 0)
        );
        const totalPnl = roundNumber(
          plain.reduce((sum, item) => sum + toNumber(item.total_pnl), 0),
          2
        );
        const totalEntryAmount = roundNumber(
          plain.reduce((sum, item) => sum + Math.max(0, toNumber(item.entry_amount)), 0),
          2
        );
        const avgEntryAmount = roundNumber(
          average(plain.map(item => toNumber(item.entry_amount))),
          2
        );
        const avgPositionPct = roundNumber(
          average(plain.map(item => toNumber(item.position_pct))),
          4
        );
        const closedExcessReturns = closed.map(item => toNumber(item.excess_return_pct));
        const avgExcessReturn = roundNumber(average(closedExcessReturns), 4);
        const excessWinRate = closed.length ? (excessWins.length / closed.length) * 100 : 0;
        const bayesianWinRate = closed.length
          ? ((excessWins.length + 2) / (closed.length + 4)) * 100
          : 50;
        const sampleConfidence = clamp(closed.length / 12, 0, 1);
        const returnVolatility = standardDeviation(closedExcessReturns);
        const drawdownPenalty = Math.abs(
          Math.min(0, average(plain.map(item => toNumber(item.max_adverse_excursion_pct))))
        );
        const riskAdjustedExcess =
          avgExcessReturn - returnVolatility * 0.18 - drawdownPenalty * 0.12;
        const recentClosed = [...closed].sort((a, b) =>
          String(b.exit_date || b.entry_date || '').localeCompare(
            String(a.exit_date || a.entry_date || '')
          )
        );
        let recentLossStreak = 0;
        for (const item of recentClosed) {
          if (toNumber(item.excess_return_pct) < 0 || toNumber(item.realized_pnl) < 0) {
            recentLossStreak += 1;
          } else {
            break;
          }
        }
        const robustScore = roundNumber(
          riskAdjustedExcess * 7 +
            (bayesianWinRate - 50) * 0.26 +
            Math.log1p(closed.length) * 2.2 +
            Math.min(10, toNumber(winSum) / 5000) -
            Math.max(0, 3 - closed.length) * 3,
          2
        );
        const profitFactor =
          lossSum > 0 ? roundNumber(winSum / lossSum, 4) : wins.length > 0 ? 999 : 0;
        const pnlPer10k =
          totalEntryAmount > 0 ? roundNumber((totalPnl / totalEntryAmount) * 10000, 2) : 0;
        const excessPerPositionPct =
          avgPositionPct > 0 ? roundNumber(avgExcessReturn / avgPositionPct, 4) : 0;
        const capitalEfficiencyScore = roundNumber(
          robustScore +
            excessPerPositionPct * 3 +
            clamp(pnlPer10k / 120, -8, 8) +
            (profitFactor >= 999 ? 3 : clamp((profitFactor - 1) * 2.4, -4, 5)) +
            (sampleConfidence - 0.5) * 4 -
            drawdownPenalty * 0.35,
          2
        );
        const autoAction =
          closed.length < 3
            ? 'collect_samples'
            : robustScore >= 12 && riskAdjustedExcess > 0.6 && bayesianWinRate >= 53
            ? 'boost'
            : robustScore <= -6 || riskAdjustedExcess < -0.8 || bayesianWinRate < 45
            ? 'reduce'
            : 'hold';
        const cooldownActive =
          dimension === 'environment_strategy_combo' &&
          closed.length >= 3 &&
          (recentLossStreak >= 2 ||
            avgExcessReturn <= -1 ||
            riskAdjustedExcess <= -0.8 ||
            bayesianWinRate < 45 ||
            drawdownPenalty >= 6);
        const cooldownReason =
          dimension === 'environment_strategy_combo' && cooldownActive
            ? recentLossStreak >= 2
              ? `最近 ${recentLossStreak} 笔连续跑输，冷却观察`
              : avgExcessReturn <= -1
              ? `平均超额 ${avgExcessReturn}% 为负，冷却观察`
              : riskAdjustedExcess <= -0.8
              ? `风险调整超额 ${roundNumber(riskAdjustedExcess, 2)}% 偏弱，冷却观察`
              : bayesianWinRate < 45
              ? `贝叶斯胜率 ${roundNumber(bayesianWinRate, 2)}% 偏低，冷却观察`
              : `最大不利波动 ${roundNumber(drawdownPenalty, 2)}% 偏高，冷却观察`
            : undefined;
        const latestClosedDate = recentClosed[0]?.exit_date || recentClosed[0]?.entry_date;
        const daysSinceLatestClosed = latestClosedDate
          ? Math.max(0, moment().tz('Asia/Shanghai').diff(moment(latestClosedDate), 'days'))
          : 0;
        const cooldownDays = cooldownActive ? Math.min(20, 5 + recentLossStreak * 3) : undefined;
        const improvementSignal =
          dimension === 'environment_strategy_combo' &&
          cooldownActive &&
          recentLossStreak === 0 &&
          (riskAdjustedExcess > -0.2 || bayesianWinRate >= 48 || robustScore >= -1);
        const resampleTrades =
          dimension === 'environment_strategy_combo'
            ? plain.filter(item => isResampleOutcome(item))
            : [];
        const closedResampleTrades = resampleTrades.filter(item => item.trade_status === 'closed');
        const resampleWins = closedResampleTrades.filter(item => toNumber(item.total_pnl) > 0);
        const resampleExcessWins = closedResampleTrades.filter(
          item => toNumber(item.excess_return_pct) > 0
        );
        const resampleLossSum = Math.abs(
          closedResampleTrades
            .filter(item => toNumber(item.realized_pnl) < 0)
            .reduce((sum, item) => sum + toNumber(item.realized_pnl), 0)
        );
        const resampleWinSum = closedResampleTrades
          .filter(item => toNumber(item.realized_pnl) > 0)
          .reduce((sum, item) => sum + toNumber(item.realized_pnl), 0);
        const resampleAvgExcess = roundNumber(
          average(closedResampleTrades.map(item => toNumber(item.excess_return_pct))),
          4
        );
        const resampleClosedCount = closedResampleTrades.length;
        const resampleWinRate = resampleClosedCount
          ? roundNumber((resampleWins.length / resampleClosedCount) * 100, 2)
          : undefined;
        const resampleExcessWinRate = resampleClosedCount
          ? roundNumber((resampleExcessWins.length / resampleClosedCount) * 100, 2)
          : undefined;
        const resampleTotalPnl = resampleTrades.length
          ? roundNumber(
              resampleTrades.reduce((sum, item) => sum + toNumber(item.total_pnl), 0),
              2
            )
          : undefined;
        const resampleProfitFactor =
          resampleClosedCount && resampleLossSum > 0
            ? roundNumber(resampleWinSum / resampleLossSum, 4)
            : resampleClosedCount && resampleWins.length > 0
            ? 999
            : resampleClosedCount
            ? 0
            : undefined;
        const resampleDecision: RecommendationTradeOutcomeBucket['resample_decision'] =
          dimension === 'environment_strategy_combo' && resampleClosedCount >= 2
            ? resampleAvgExcess >= 0.8 && toNumber(resampleExcessWinRate, 0) >= 50
              ? 'promote'
              : resampleAvgExcess <= -0.8 || toNumber(resampleExcessWinRate, 100) < 35
              ? 'cooldown'
              : 'continue_sampling'
            : dimension === 'environment_strategy_combo' && resampleTrades.length > 0
            ? 'observe'
            : undefined;
        const resampleDecisionReason =
          resampleDecision === 'promote'
            ? `复采样 ${resampleClosedCount} 笔平均超额 ${resampleAvgExcess}%，可评估恢复常规采样`
            : resampleDecision === 'cooldown'
            ? `复采样 ${resampleClosedCount} 笔仍跑输，继续冷却并避免放大`
            : resampleDecision === 'continue_sampling'
            ? `复采样 ${resampleClosedCount} 笔结论未稳定，继续小仓观察`
            : resampleDecision === 'observe'
            ? '已有复采样持仓但尚未形成闭环，等待平仓验证'
            : undefined;
        const resampleRecoveryReady =
          dimension === 'environment_strategy_combo' && resampleDecision === 'promote';
        const cooldownExtended =
          dimension === 'environment_strategy_combo' && resampleDecision === 'cooldown';
        const cooldownExtensionDays = cooldownExtended
          ? Math.min(30, toNumber(cooldownDays, 5) + 7)
          : undefined;
        const cooldownExpiresAt =
          cooldownExtended && latestClosedDate
            ? moment(latestClosedDate)
                .tz('Asia/Shanghai')
                .add(toNumber(cooldownExtensionDays, 0), 'days')
                .format('YYYY-MM-DD')
            : undefined;
        const resampleRecoveryPositionMultiplier = resampleRecoveryReady ? 0.58 : undefined;
        const resamplePolicyAction: RecommendationTradeOutcomeBucket['resample_policy_action'] =
          resampleRecoveryReady
            ? 'recover_small'
            : cooldownExtended
            ? 'extend_cooldown'
            : resampleDecision === 'continue_sampling'
            ? 'continue_resample'
            : resampleDecision === 'observe'
            ? 'observe'
            : 'none';
        const resampleReady =
          dimension === 'environment_strategy_combo' &&
          cooldownActive &&
          !cooldownExtended &&
          !resampleRecoveryReady &&
          (daysSinceLatestClosed >= toNumber(cooldownDays, 999) || improvementSignal);
        const resampleReason = resampleReady
          ? improvementSignal
            ? '冷却组合出现改善信号，仅允许小仓复采样'
            : `冷却已满 ${cooldownDays} 天，仅允许小仓复采样`
          : undefined;
        const effectiveCooldownActive = cooldownActive && !resampleRecoveryReady;
        const effectiveCooldownDays = cooldownExtended ? cooldownExtensionDays : cooldownDays;
        const effectiveCooldownReason = cooldownExtended
          ? `${resampleDecisionReason}，延长冷却至 ${cooldownExpiresAt || '后续交易日'}`
          : cooldownReason;
        let budgetAction: RecommendationTradeOutcomeBucket['budget_action'] = 'observe';
        let recommendedBudgetMultiplier = closed.length < 2 ? 0.45 : 0.72;
        let budgetActionReason = `闭环样本 ${closed.length} 笔，先保持观察仓`;
        if (
          cooldownExtended ||
          (effectiveCooldownActive && (recentLossStreak >= 2 || avgExcessReturn <= -1.2))
        ) {
          budgetAction = 'pause';
          recommendedBudgetMultiplier = 0;
          budgetActionReason =
            effectiveCooldownReason ||
            `平均超额 ${avgExcessReturn}%、连续跑输 ${recentLossStreak} 笔，暂停预算`;
        } else if (
          effectiveCooldownActive ||
          capitalEfficiencyScore <= -4 ||
          avgExcessReturn <= -1 ||
          bayesianWinRate < 45
        ) {
          budgetAction = 'reduce';
          recommendedBudgetMultiplier = roundNumber(
            clamp(0.55 + Math.min(0, capitalEfficiencyScore) / 30, 0.28, 0.62),
            2
          );
          budgetActionReason =
            effectiveCooldownReason ||
            `资金效率 ${capitalEfficiencyScore}、平均超额 ${avgExcessReturn}%，降低试错成本`;
        } else if (
          resampleRecoveryReady ||
          (closed.length >= 3 &&
            capitalEfficiencyScore >= 10 &&
            avgExcessReturn >= 0.8 &&
            bayesianWinRate >= 52)
        ) {
          budgetAction = 'increase';
          recommendedBudgetMultiplier = roundNumber(
            clamp(1.06 + Math.min(0.14, capitalEfficiencyScore / 180), 1.08, 1.2),
            2
          );
          budgetActionReason = resampleRecoveryReady
            ? resampleDecisionReason || `复采样跑赢，资金效率 ${capitalEfficiencyScore}`
            : `单位资金效率 ${capitalEfficiencyScore}，平均超额 ${avgExcessReturn}%`;
        } else if (resampleReady || resampleDecision === 'continue_sampling') {
          budgetAction = 'observe';
          recommendedBudgetMultiplier = roundNumber(
            clamp(resampleReady ? 0.35 : 0.42, 0.25, 0.5),
            2
          );
          budgetActionReason =
            resampleReason || resampleDecisionReason || '复采样尚未稳定，小仓观察';
        } else {
          recommendedBudgetMultiplier = roundNumber(
            clamp(0.68 + capitalEfficiencyScore / 120, 0.45, 0.92),
            2
          );
          budgetActionReason = `资金效率 ${capitalEfficiencyScore}，等待更多闭环样本确认`;
        }
        return {
          key,
          label: labelSelector(key),
          count: plain.length,
          open_count: open.length,
          closed_count: closed.length,
          tracked_count: plain.length,
          win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
          excess_win_rate: roundNumber(excessWinRate, 2),
          avg_return_pct: roundNumber(
            average(closed.map(item => toNumber(item.realized_pnl_pct))),
            4
          ),
          avg_excess_return_pct: avgExcessReturn,
          total_pnl: totalPnl,
          profit_factor: profitFactor,
          avg_holding_days: roundNumber(average(plain.map(item => toNumber(item.holding_days))), 2),
          best_symbol: best?.symbol,
          best_name: best?.name,
          best_return_pct: best?.total_pnl_pct,
          worst_symbol: worst?.symbol,
          worst_name: worst?.name,
          worst_return_pct: worst?.total_pnl_pct,
          avg_consensus_count: roundNumber(average(consensusCounts), 2),
          avg_consensus_bonus: roundNumber(average(consensusBonuses), 2),
          dimension,
          auto_action: autoAction,
          confidence: roundNumber(sampleConfidence, 2),
          robust_score: robustScore,
          sample_confidence: roundNumber(sampleConfidence, 2),
          bayesian_win_rate: roundNumber(bayesianWinRate, 2),
          return_volatility_pct: roundNumber(returnVolatility, 4),
          drawdown_penalty: roundNumber(drawdownPenalty, 4),
          risk_adjusted_excess_return_pct: roundNumber(riskAdjustedExcess, 4),
          avg_position_pct: avgPositionPct,
          avg_entry_amount: avgEntryAmount,
          total_entry_amount: totalEntryAmount,
          pnl_per_10k: pnlPer10k,
          excess_per_position_pct: excessPerPositionPct,
          capital_efficiency_score: capitalEfficiencyScore,
          budget_action: budgetAction,
          budget_action_reason: budgetActionReason,
          recommended_budget_multiplier: recommendedBudgetMultiplier,
          takeover_ready:
            dimension === 'environment_strategy_combo' &&
            !effectiveCooldownActive &&
            !resampleRecoveryReady &&
            closed.length >= 3 &&
            sampleConfidence >= 0.25 &&
            robustScore >= 8 &&
            avgExcessReturn > 0.5 &&
            bayesianWinRate >= 52,
          takeover_reason:
            dimension === 'environment_strategy_combo'
              ? resampleRecoveryReady
                ? resampleDecisionReason
                : effectiveCooldownActive
                ? effectiveCooldownReason
                : closed.length < 3
                ? `闭环样本 ${closed.length}/3，不接管`
                : robustScore < 8
                ? `稳健分 ${robustScore}/8，不接管`
                : avgExcessReturn <= 0.5
                ? `平均超额 ${avgExcessReturn}% 不足，不接管`
                : bayesianWinRate < 52
                ? `贝叶斯胜率 ${roundNumber(bayesianWinRate, 2)}% 不足，不接管`
                : '满足样本、稳健分、超额收益和贝叶斯胜率，允许接管'
              : undefined,
          cooldown_active: effectiveCooldownActive,
          cooldown_reason: effectiveCooldownActive ? effectiveCooldownReason : undefined,
          recent_loss_streak:
            dimension === 'environment_strategy_combo' ? recentLossStreak : undefined,
          cooldown_days: effectiveCooldownActive ? effectiveCooldownDays : undefined,
          resample_ready: resampleReady,
          resample_reason: resampleReason,
          resample_position_multiplier: resampleReady ? 0.35 : undefined,
          resample_closed_count:
            dimension === 'environment_strategy_combo' ? resampleClosedCount : undefined,
          resample_avg_excess_return_pct:
            dimension === 'environment_strategy_combo' && resampleTrades.length
              ? resampleAvgExcess
              : undefined,
          resample_win_rate: resampleWinRate,
          resample_excess_win_rate: resampleExcessWinRate,
          resample_total_pnl: resampleTotalPnl,
          resample_profit_factor: resampleProfitFactor,
          resample_decision: resampleDecision,
          resample_decision_reason: resampleDecisionReason,
          resample_recovery_ready: resampleRecoveryReady,
          resample_recovery_position_multiplier: resampleRecoveryPositionMultiplier,
          cooldown_extended: cooldownExtended,
          cooldown_extension_days: cooldownExtensionDays,
          cooldown_expires_at: cooldownExpiresAt,
          resample_policy_action: resamplePolicyAction,
        };
      })
      .sort((a, b) => {
        if (b.robust_score !== a.robust_score) return b.robust_score - a.robust_score;
        if (b.closed_count !== a.closed_count) return b.closed_count - a.closed_count;
        if (b.avg_excess_return_pct !== a.avg_excess_return_pct) {
          return b.avg_excess_return_pct - a.avg_excess_return_pct;
        }
        return b.total_pnl - a.total_pnl;
      });
  }

  private buildFeedback(
    summary: RecommendationTradeOutcomeSummary,
    groups: RecommendationTradeOutcomeDashboard['groups']
  ): RecommendationTradeOutcomeDashboard['feedback'] {
    let recommendedMinScore = 72;
    if (summary.closed_count >= 5) {
      if (summary.avg_excess_return_pct < -1 || summary.excess_win_rate < 45)
        recommendedMinScore += 5;
      if (summary.avg_excess_return_pct > 2 && summary.excess_win_rate >= 55)
        recommendedMinScore -= 2;
      if (summary.profit_factor >= 1.6 && summary.win_rate >= 55) recommendedMinScore -= 1;
    }
    recommendedMinScore = Math.max(62, Math.min(88, recommendedMinScore));

    const positionMultiplier =
      summary.closed_count < 5
        ? 0.65
        : summary.avg_excess_return_pct > 2 && summary.excess_win_rate >= 55
        ? 1.15
        : summary.avg_excess_return_pct < -1 || summary.excess_win_rate < 45
        ? 0.55
        : 0.85;

    const riskGroups = groups.by_risk_level.filter(group =>
      ['low', 'medium', 'high'].includes(group.key)
    );
    const allowedRiskLevels = riskGroups
      .filter(
        group =>
          group.closed_count < 2 || group.avg_excess_return_pct >= 0 || group.excess_win_rate >= 50
      )
      .map(group => group.key);

    const allGroups = [
      ...groups.by_source_type,
      ...groups.by_agent_session,
      ...groups.by_style,
      ...groups.by_action,
      ...groups.by_consensus,
      ...groups.by_score_position_bucket,
      ...groups.by_strategy_key,
      ...groups.by_market_regime,
      ...groups.by_industry_regime,
      ...groups.by_industry,
    ];
    const bestSegments = allGroups
      .filter(group => group.closed_count > 0)
      .sort((a, b) => b.avg_excess_return_pct - a.avg_excess_return_pct)
      .slice(0, 5);
    const weakSegments = allGroups
      .filter(group => group.closed_count > 0)
      .sort((a, b) => a.avg_excess_return_pct - b.avg_excess_return_pct)
      .slice(0, 5);

    const insights: string[] = [];
    const nextActions: string[] = [];
    if (summary.closed_count === 0) {
      insights.push('暂无平仓样本，当前主要观察持仓浮盈亏和基准超额表现。');
      nextActions.push('继续让自动跟单积累样本，避免过早放大仓位。');
    } else {
      insights.push(
        `已闭环 ${summary.closed_count} 笔，胜率 ${summary.win_rate}%、超额胜率 ${summary.excess_win_rate}%、平均超额 ${summary.avg_excess_return_pct}%。`
      );
      if (summary.avg_excess_return_pct > 0) {
        insights.push('模拟交易相对基准取得正超额，当前选股/退出纪律具备继续放量验证的基础。');
      } else {
        insights.push('模拟交易尚未跑赢对应基准，需要收紧入场评分、降低仓位或优化退出条件。');
      }
      if (summary.avg_mae_pct < -6) {
        insights.push(
          `平均最大不利波动 ${summary.avg_mae_pct}%，持仓过程回撤偏大，止损/入场时点需优化。`
        );
      }
    }
    if (bestSegments[0]) {
      nextActions.push(
        `优先保留 ${bestSegments[0].label} 片段，平均超额 ${bestSegments[0].avg_excess_return_pct}% / 样本 ${bestSegments[0].closed_count}。`
      );
    }
    if (weakSegments[0] && weakSegments[0].avg_excess_return_pct < 0) {
      nextActions.push(
        `降低 ${weakSegments[0].label} 片段权重，平均超额 ${weakSegments[0].avg_excess_return_pct}%。`
      );
    }
    const consensusGroups = groups.by_consensus || [];
    const strongConsensus = consensusGroups
      .filter(group => group.key !== 'no_consensus' && group.closed_count > 0)
      .sort((a, b) => b.avg_excess_return_pct - a.avg_excess_return_pct)[0];
    const noConsensus = consensusGroups.find(group => group.key === 'no_consensus');
    if (strongConsensus) {
      const edge = roundNumber(
        strongConsensus.avg_excess_return_pct - toNumber(noConsensus?.avg_excess_return_pct),
        2
      );
      insights.push(
        `多策略共识组 ${strongConsensus.label} 平均超额 ${
          strongConsensus.avg_excess_return_pct
        }%，相对无显式共识 ${edge >= 0 ? '+' : ''}${edge} 个百分点。`
      );
      nextActions.push(
        edge >= 0
          ? `继续优先复核 ${strongConsensus.label} 标的，并保留共识加权进入模拟盘。`
          : `共识组尚未跑赢无共识样本，下一轮保持小仓验证，避免单纯因共识放大仓位。`
      );
    }
    nextActions.push(
      `下一轮自动跟单最低评分建议 ${recommendedMinScore}，仓位倍率 ${positionMultiplier}x。`
    );

    return {
      recommended_min_score: recommendedMinScore,
      position_multiplier: roundNumber(positionMultiplier, 2),
      allowed_risk_levels: allowedRiskLevels.length ? allowedRiskLevels : ['low', 'medium'],
      best_segments: bestSegments,
      weak_segments: weakSegments,
      insights,
      next_actions: nextActions,
    };
  }
}

export const recommendationTradeOutcomeService = new RecommendationTradeOutcomeService();
