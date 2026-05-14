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
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { User } from '../models/User';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { quantRecommendationService } from './QuantRecommendationService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';

export const DEFAULT_PAPER_TRADING_INITIAL_CAPITAL = 200000;

type AutoTradeStatus = 'executed' | 'planned' | 'skipped';
type RiskExitStatus = 'exited' | 'planned' | 'held' | 'skipped';
type RiskExitReason = 'stop_loss' | 'take_profit' | 'sell_signal' | 'max_hold_days';

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
  dry_run?: boolean;
  report_to_feishu?: boolean;
  signal_date_start?: string;
  signal_date_end?: string;
  signal_ids?: number[];
  ignore_profit_gate_for_forced_signals?: boolean;
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
  use_entry_risk_guard?: boolean;
  max_daily_new_positions?: number;
  max_daily_new_exposure_pct?: number;
  max_total_exposure_pct?: number;
  max_industry_exposure_pct?: number;
  min_avg_turnover_yuan?: number;
  cooldown_days_after_loss?: number;
  block_st?: boolean;
  block_limit_up?: boolean;
  block_limit_down?: boolean;
  block_suspended?: boolean;
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
  stop_loss_pct?: number;
  take_profit_pct?: number;
  original_score?: number;
  consensus_count?: number;
  consensus_bonus?: number;
  consensus_variants?: string[];
  recommendation_tier?: string;
  recommendation_tier_label?: string;
  trade_id?: number;
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
    min_avg_turnover_yuan: number;
    cooldown_days_after_loss: number;
    block_st: boolean;
    block_limit_up: boolean;
    block_limit_down: boolean;
    block_suspended: boolean;
    current_exposure_pct: number;
    today_buy_count: number;
    today_new_exposure_pct: number;
    remaining_daily_new_positions: number;
    remaining_daily_new_exposure_pct: number;
    risk_notes: string[];
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
}

interface EntryRiskGuardState {
  enabled: boolean;
  max_daily_new_positions: number;
  max_daily_new_exposure_pct: number;
  max_total_exposure_pct: number;
  max_industry_exposure_pct: number;
  min_avg_turnover_yuan: number;
  cooldown_days_after_loss: number;
  block_st: boolean;
  block_limit_up: boolean;
  block_limit_down: boolean;
  block_suspended: boolean;
  total_value: number;
  current_exposure_pct: number;
  today_buy_count: number;
  today_new_exposure_pct: number;
  staged_count: number;
  staged_exposure_pct: number;
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
  avg_turnover_yuan: number;
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
  limit?: number;
  enable_stop_loss?: boolean;
  enable_take_profit?: boolean;
  enable_sell_signals?: boolean;
  default_stop_loss_pct?: number;
  default_take_profit_pct?: number;
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
  signal_id?: number;
  source_signal_id?: number;
  sell_signal_id?: number;
  sell_signal_date?: string;
  sell_signal_score?: number;
  trade_id?: number;
  message?: string;
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
  snapshot?: PaperTradingSnapshotResult;
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

function normalizeSkipReasonCategory(reason?: string): string {
  const text = String(reason || '').trim();
  if (!text) return 'unknown';
  if (text.includes('已持有') || text.includes('重复加仓') || text.includes('执行过')) {
    return 'duplicate_or_existing_position';
  }
  if (text.includes('收益闸门') || text.includes('Profit')) return 'profit_gate';
  if (text.includes('收益闭环') || text.includes('降权片段')) return 'outcome_feedback';
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
    const default_position_pct = toNumber(options.default_position_pct, 5);
    const max_position_pct = toNumber(options.max_position_pct, 12);
    const min_trade_amount = toNumber(options.min_trade_amount, 3000);
    const entryRiskGuard = await this.resolveEntryRiskGuardPolicy({
      enabled: toBoolean(options.use_entry_risk_guard, true),
      portfolio_id: 0,
      total_value: 0,
      max_daily_new_positions: toPositiveInt(options.max_daily_new_positions, 3, 20),
      max_daily_new_exposure_pct: toNumber(options.max_daily_new_exposure_pct, 12),
      max_total_exposure_pct: toNumber(options.max_total_exposure_pct, 60),
      max_industry_exposure_pct: toNumber(options.max_industry_exposure_pct, 25),
      min_avg_turnover_yuan: toNumber(options.min_avg_turnover_yuan, 30000000),
      cooldown_days_after_loss: toPositiveInt(options.cooldown_days_after_loss, 12, 120),
      block_st: toBoolean(options.block_st, true),
      block_limit_up: toBoolean(options.block_limit_up, true),
      block_limit_down: toBoolean(options.block_limit_down, true),
      block_suspended: toBoolean(options.block_suspended, true),
    });
    const source_type = options.source_type || AISignalSourceType.QUANT_RECOMMENDATION;
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
        [Op.in]: [AISignalDecision.BUY, AISignalDecision.STRONG_BUY],
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

    const trades: PaperTradingAutoTradeItem[] = [];
    const skipped_items: PaperTradingAutoTradeItem[] = [];
    const seenSymbols = new Set<string>();
    let eligible = 0;
    const targetTradeCount = Math.min(limit, remainingSlots);

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

    for (const signal of signals) {
      const itemBase = this.buildTradeItemBase(signal);
      const symbol = normalizeSymbol(signal.symbol);
      const metadata = asPlainObject(signal.metadata);
      const paperTradingMeta = asPlainObject(metadata.paper_trading);
      const action = String(metadata.action || '').toLowerCase();
      const dataQuality = asPlainObject(metadata.data_quality);
      const dataQualityBucket = String(
        metadata.data_quality_bucket || dataQuality.bucket || 'unknown'
      ).toLowerCase();
      const dataQualityScore = Number(metadata.data_quality_score ?? dataQuality.score ?? 100);

      const skip = (reason: string) => {
        skipped_items.push({ ...itemBase, status: 'skipped', reason });
      };

      if (trades.length >= targetTradeCount) {
        break;
      }

      if (remainingSlots <= 0) {
        break;
      }

      if (!profitGatePolicy.allow_entries && !ignoreProfitGateForForcedSignals) {
        skip(`收益闸门未放行：${profitGatePolicy.reason || profitGatePolicy.gate_label}`);
        continue;
      }

      if (['critical'].includes(dataQualityBucket)) {
        skip(
          `Agent 数据质量严重不足（${Number.isFinite(dataQualityScore) ? dataQualityScore : '--'}分），禁止自动买入`
        );
        continue;
      }

      if (dataQualityBucket === 'low' && !signalIds.includes(signal.id)) {
        skip(
          `Agent 数据质量偏低（${Number.isFinite(dataQualityScore) ? dataQualityScore : '--'}分），需人工复核后再跟单`
        );
        continue;
      }

      if (!outcomeFeedbackPolicy.allow_entries) {
        skip(`收益闭环反哺未放行：${outcomeFeedbackPolicy.reason || '闭环样本质量不足'}`);
        continue;
      }

      if (seenSymbols.has(symbol)) {
        skip('同一标的已有更新的候选信号，本条旧信号跳过');
        continue;
      }
      seenSymbols.add(symbol);

      if (existingSymbols.has(symbol)) {
        skip('模拟盘已持有该标的，避免重复加仓');
        continue;
      }

      if (
        paperTradingMeta.status === 'executed' &&
        Number(paperTradingMeta.portfolio_id) === Number(portfolio.id)
      ) {
        skip('该信号已被当前模拟盘执行过');
        continue;
      }

      const riskLevel = normalizeRiskLevel(signal.risk_level);
      if (!allowedRiskLevels.has(riskLevel)) {
        skip(`风险等级 ${riskLevel || 'unknown'} 不在允许范围内`);
        continue;
      }

      if (action === 'avoid') {
        skip('候选交易纪律为暂不参与');
        continue;
      }
      if (require_action_buy && action !== 'buy') {
        skip(`候选交易纪律不是买入动作：${metadata.action_label || action || '未给出'}`);
        continue;
      }

      const blockedSegment = this.matchOutcomeBlockedSegment(signal, outcomeFeedbackPolicy);
      if (blockedSegment) {
        skip(
          `收益闭环降权片段 ${blockedSegment.label || blockedSegment.key} 暂停自动买入：平均超额 ${
            blockedSegment.avg_excess_return_pct ?? '--'
          }% / 样本 ${blockedSegment.closed_count ?? '--'}`
        );
        continue;
      }

      const marketProfile = await this.getEntryMarketProfile(symbol, {
        cooldown_days_after_loss: entryRiskGuard.cooldown_days_after_loss,
      });
      const preTradeRisk = this.evaluateEntryRiskGuard({
        guard: entryRiskGuard,
        profile: marketProfile,
        candidate_position_pct: 0,
      });
      if (!preTradeRisk.allowed) {
        skip(preTradeRisk.reasons.join('；'));
        continue;
      }

      const quote = await this.getLatestPrice(symbol, toNumber(signal.current_price, 0));
      if (!quote.price || quote.price <= 0) {
        skip('无法获取有效最新价格');
        continue;
      }

      const suggestedPct = clamp(
        toNumber(metadata.suggested_position_pct, default_position_pct),
        1,
        max_position_pct
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
            ? 0.75
            : 0.5;
      const gatedSuggestedPct = clamp(
        suggestedPct *
          profitGatePolicy.effective_position_multiplier *
          outcomePositionMultiplier *
          dataQualityPositionMultiplier,
        0,
        max_position_pct
      );
      const tradeRisk = this.evaluateEntryRiskGuard({
        guard: entryRiskGuard,
        profile: marketProfile,
        candidate_position_pct: gatedSuggestedPct,
      });
      if (!tradeRisk.allowed) {
        skip(tradeRisk.reasons.join('；'));
        continue;
      }
      if (gatedSuggestedPct <= 0) {
        skip(`收益闸门仓位倍率为 ${profitGatePolicy.effective_position_multiplier}，不执行买入`);
        continue;
      }
      const targetAmount = Math.min(totalValue * (gatedSuggestedPct / 100), availableCash * 0.98);
      if (targetAmount < min_trade_amount) {
        skip(`目标交易金额低于最小阈值 ${min_trade_amount}`);
        continue;
      }

      const execute_price = roundNumber(quote.price * (1 + this.slippageRate), 3);
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
        skip('可用资金不足以买入一手');
        continue;
      }

      eligible++;
      const tradePayload: PaperTradingAutoTradeItem = {
        ...itemBase,
        status: dry_run ? 'planned' : 'executed',
        action,
        action_label: metadata.action_label,
        quantity,
        latest_price: quote.price,
        execute_price,
        amount,
        commission,
        total_cost,
        target_position_pct: roundNumber(gatedSuggestedPct, 2),
        stop_loss_pct: toOptionalNumber(metadata.stop_loss_pct),
        take_profit_pct: toOptionalNumber(metadata.take_profit_pct),
        reason: [
          profitGatePolicy.enabled && profitGatePolicy.gate_label
            ? `收益闸门：${profitGatePolicy.gate_label}，倍率 ${profitGatePolicy.effective_position_multiplier}x`
            : '',
          outcomeFeedbackPolicy.enabled
            ? `交易收益闭环：样本 ${outcomeFeedbackPolicy.closed_samples}，仓位倍率 ${outcomeFeedbackPolicy.effective_position_multiplier}x`
            : '',
          dataQualityBucket && !['high', 'unknown'].includes(dataQualityBucket)
            ? `Agent数据质量：${dataQualityBucket}，仓位倍率 ${dataQualityPositionMultiplier}x`
            : '',
        ]
          .filter(Boolean)
          .join('；'),
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
          stop_loss_pct: tradePayload.stop_loss_pct,
          take_profit_pct: tradePayload.take_profit_pct,
          profit_gate: profitGatePolicy,
          outcome_feedback: outcomeFeedbackPolicy,
          entry_risk_guard: this.buildEntryRiskGuardPolicy(entryRiskGuard),
          entry_market_profile: marketProfile,
        });
        await this.refreshRecommendationTradeOutcome(signal.id);
      }

      availableCash = roundNumber(availableCash - total_cost, 2);
      this.commitEntryRiskGuardTrade(entryRiskGuard, {
        profile: marketProfile,
        target_position_pct: tradePayload.target_position_pct || 0,
        amount,
      });
      trades.push(tradePayload);
    }

    const snapshot = dry_run ? preSnapshot : await this.syncLatestPricesAndSnapshot(portfolio.id);

    const result: PaperTradingAutoResult = {
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      dry_run,
      source_type,
      scanned: signals.length,
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
      skip_reason_summary: summarizeSkippedItems(skipped_items),
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

    return {
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
            })),
          }
        : undefined,
      archive,
    };
  }

  async runRiskCheck(
    options: PaperTradingRiskCheckOptions = {}
  ): Promise<PaperTradingRiskCheckResult> {
    const dry_run = toBoolean(options.dry_run, false);
    const report_to_feishu = toBoolean(options.report_to_feishu, true);
    const limit = toPositiveInt(options.limit, 20, 100);
    const enableStopLoss = toBoolean(options.enable_stop_loss, true);
    const enableTakeProfit = toBoolean(options.enable_take_profit, true);
    const enableSellSignals = toBoolean(options.enable_sell_signals, true);
    const defaultStopLossPct = Math.abs(toNumber(options.default_stop_loss_pct, 7));
    const defaultTakeProfitPct = Math.abs(toNumber(options.default_take_profit_pct, 14));
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
      const paperTradingMeta = asPlainObject(signalMeta.paper_trading);
      const entryDate = paperTradingMeta.executed_at || position.created_at;
      const holdingDays = Math.max(0, moment().tz('Asia/Shanghai').diff(moment(entryDate), 'days'));
      const stopLossPct = Math.abs(
        toNumber(paperTradingMeta.stop_loss_pct ?? signalMeta.stop_loss_pct, defaultStopLossPct)
      );
      const takeProfitPct = Math.abs(
        toNumber(
          paperTradingMeta.take_profit_pct ?? signalMeta.take_profit_pct,
          defaultTakeProfitPct
        )
      );
      const quote = await this.getLatestPrice(symbol, toNumber(position.current_price, 0));
      const latestPrice = quote.price || toNumber(position.current_price, 0);
      const pnlPct = avgCost > 0 ? roundNumber(((latestPrice - avgCost) / avgCost) * 100, 4) : 0;

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
        source_signal_id: sourceSignal?.id,
      };

      const skip = (message: string) => {
        skippedItems.push({ ...baseItem, status: 'skipped', message });
      };

      if (exits.length >= limit) {
        break;
      }

      if (!quantity || quantity <= 0) {
        skip('持仓数量无效，跳过');
        continue;
      }

      if (!latestPrice || latestPrice <= 0 || !avgCost || avgCost <= 0) {
        skip('无法获取有效价格或成本，跳过');
        continue;
      }

      let exitReason: RiskExitReason | undefined;
      let sellSignal: AIInvestmentSignal | null = null;

      if (enableStopLoss && stopLossPct > 0 && pnlPct <= -stopLossPct) {
        exitReason = 'stop_loss';
      } else if (enableTakeProfit && takeProfitPct > 0 && pnlPct >= takeProfitPct) {
        exitReason = 'take_profit';
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

      if (!exitReason && maxHoldDays > 0 && holdingDays >= maxHoldDays) {
        exitReason = 'max_hold_days';
      }

      if (!exitReason) {
        heldItems.push({
          ...baseItem,
          status: 'held',
          message:
            pnlPct < 0
              ? `距离止损线还有 ${roundNumber(stopLossPct + pnlPct, 2)} 个百分点`
              : `距离止盈线还有 ${roundNumber(takeProfitPct - pnlPct, 2)} 个百分点`,
        });
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
          });
          await this.refreshRecommendationTradeOutcome(sourceSignal.id);
        }
      }

      exits.push(exitItem);
    }

    const snapshot = dry_run
      ? await this.syncLatestPricesAndSnapshot(portfolio.id)
      : await this.syncLatestPricesAndSnapshot(portfolio.id);

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
      snapshot,
    };

    if (report_to_feishu) {
      await feishuTaskReportService.reportPaperTradingRiskCheck(result, {
        record_type: dry_run ? '模拟盘风控预演' : '模拟盘风控退出',
      });
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

  private async getLatestPrice(
    symbol: string,
    fallbackPrice = 0
  ): Promise<{ price: number; name?: string; date?: string }> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const stock = await Stock.findOne({ where: { symbol: normalizedSymbol } });
    if (!stock) {
      return { price: roundNumber(fallbackPrice, 4), name: normalizedSymbol };
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
    };
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

    return (
      signals.find(signal => {
        const paperTrading = asPlainObject(asPlainObject(signal.metadata).paper_trading);
        return (
          Number(paperTrading.portfolio_id) === Number(portfolio_id) &&
          ['executed', 'closing', 'closed'].includes(String(paperTrading.status || ''))
        );
      }) || null
    );
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
      const { recommendationTradeOutcomeService } =
        await import('./RecommendationTradeOutcomeService');
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
      const blockedSegments =
        closedSamples >= options.min_closed_samples
          ? weakSegments
              .filter(
                (segment: any) =>
                  Number(segment.closed_count || 0) >= 2 &&
                  (Number(segment.avg_excess_return_pct || 0) <= -2 ||
                    Number(segment.excess_win_rate || 0) < 35)
              )
              .slice(0, 8)
          : [];
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
        preferred_segments: bestSegments.slice(0, 5),
        blocked_segments: blockedSegments,
        best_segments: bestSegments,
        weak_segments: weakSegments,
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
      min_avg_turnover_yuan: Math.max(0, options.min_avg_turnover_yuan),
      cooldown_days_after_loss: Math.max(0, options.cooldown_days_after_loss),
      block_st: options.block_st,
      block_limit_up: options.block_limit_up,
      block_limit_down: options.block_limit_down,
      block_suspended: options.block_suspended,
      total_value: totalValue,
      current_exposure_pct: 0,
      today_buy_count: 0,
      today_new_exposure_pct: 0,
      staged_count: 0,
      staged_exposure_pct: 0,
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

    const symbols = [...new Set(positions.map(position => normalizeSymbol(position.symbol)))];
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
      min_avg_turnover_yuan: roundNumber(guard.min_avg_turnover_yuan, 2),
      cooldown_days_after_loss: guard.cooldown_days_after_loss,
      block_st: guard.block_st,
      block_limit_up: guard.block_limit_up,
      block_limit_down: guard.block_limit_down,
      block_suspended: guard.block_suspended,
      current_exposure_pct: roundNumber(guard.current_exposure_pct, 2),
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
    const validTurnovers = (bars as any[])
      .slice(0, 20)
      .map(bar => toNumber(bar.turnover, 0))
      .filter(value => value > 0);
    const avgTurnover =
      validTurnovers.length > 0
        ? validTurnovers.reduce((sum, value) => sum + value, 0) / validTurnovers.length
        : 0;
    const name = stock?.name || normalizedSymbol;
    const latestChangePercent = toOptionalNumber(latest?.change_percent ?? stock?.change_percent);
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
      avg_turnover_yuan: roundNumber(avgTurnover, 2),
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

  private evaluateEntryRiskGuard(options: {
    guard: EntryRiskGuardState;
    profile: EntryMarketProfile;
    candidate_position_pct: number;
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

    if (candidatePct > 0) {
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
    }

    return { allowed: reasons.length === 0, reasons };
  }

  private commitEntryRiskGuardTrade(
    guard: EntryRiskGuardState,
    options: { profile: EntryMarketProfile; target_position_pct: number; amount: number }
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
  }

  private matchOutcomeBlockedSegment(
    signal: AIInvestmentSignal,
    policy?: PaperTradingAutoResult['outcome_feedback_policy']
  ): any | null {
    if (!policy?.enabled || !Array.isArray(policy.blocked_segments)) return null;
    const metadata = asPlainObject(signal.metadata);
    const candidates = [
      signal.source_type,
      metadata.agent_session,
      metadata.style || metadata.recommendation_style,
      metadata.action_label || metadata.action,
      signal.risk_level,
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
        return candidates.includes(key);
      }) || null
    );
  }

  private buildTradeItemBase(signal: AIInvestmentSignal): PaperTradingAutoTradeItem {
    const metadata = asPlainObject(signal.metadata);
    return {
      status: 'skipped',
      signal_id: signal.id,
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
    await signal.update({
      metadata: {
        ...metadata,
        paper_trading: {
          ...(metadata.paper_trading || {}),
          ...execution,
          loop_run_id,
          status: 'executed',
          executed_at: new Date().toISOString(),
          execution_source: 'paper_trading_auto_sync',
        },
      },
    });
  }

  private async markSignalClosed(signal: AIInvestmentSignal, exit: Record<string, any>) {
    const metadata = asPlainObject(signal.metadata);
    const loop_run_id =
      signal.loop_run_id ||
      metadata.loop_run_id ||
      asPlainObject(metadata.paper_trading).loop_run_id;
    await signal.update({
      metadata: {
        ...metadata,
        paper_trading: {
          ...(metadata.paper_trading || {}),
          ...exit,
          loop_run_id,
          status: 'closed',
          closed_at: new Date().toISOString(),
          close_source: 'paper_trading_risk_check',
        },
      },
    });
  }

  private async refreshRecommendationTradeOutcome(signal_id: number) {
    try {
      const { recommendationTradeOutcomeService } =
        await import('./RecommendationTradeOutcomeService');
      await recommendationTradeOutcomeService.refreshOutcomeBySignal(signal_id);
    } catch (error: any) {
      logger.warn(`推荐交易收益闭环刷新失败 signal#${signal_id}: ${error?.message || error}`);
    }
  }
}

export const paperTradingAutomationService = new PaperTradingAutomationService();
