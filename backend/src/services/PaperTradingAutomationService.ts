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
import { quantRecommendationService } from './QuantRecommendationService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';

type AutoTradeStatus = 'executed' | 'planned' | 'skipped';
type RiskExitStatus = 'exited' | 'planned' | 'held' | 'skipped';
type RiskExitReason = 'stop_loss' | 'take_profit' | 'sell_signal' | 'max_hold_days';

export interface PaperTradingAutoOptions {
  user_id?: number;
  username?: string;
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
  use_attribution_feedback?: boolean;
  use_profit_gate?: boolean;
  profit_gate_horizon?: string;
  profit_gate_min_samples?: number;
  profit_gate_min_quality_score?: number;
  profit_gate_allow_deprioritized?: boolean;
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
    gate_action?: string;
    gate_label?: string;
    gate_severity?: string;
    position_multiplier: number;
    effective_position_multiplier: number;
    reason?: string;
    risk_notes?: string[];
  };
}

export interface PaperTradingRiskCheckOptions {
  user_id?: number;
  username?: string;
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
    } = {}
  ): Promise<PaperTradingPortfolio> {
    const user = await this.resolveUser(options.user_id, options.username);
    const user_id = user.id;

    let portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id, is_active: true },
      order: [['id', 'ASC']],
    });

    if (!portfolio) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id },
        order: [['id', 'ASC']],
      });
    }

    if (!portfolio) {
      const initial_capital = toNumber(options.initial_capital, 1000000);
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
    });
    const feedbackPolicy = await this.resolveAttributionFeedbackPolicy({
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
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
      limit: scan_limit,
    });
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

    if (!profitGatePolicy.allow_entries) {
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

    for (const signal of signals) {
      const itemBase = this.buildTradeItemBase(signal);
      const symbol = normalizeSymbol(signal.symbol);
      const metadata = asPlainObject(signal.metadata);
      const paperTradingMeta = asPlainObject(metadata.paper_trading);
      const action = String(metadata.action || '').toLowerCase();

      const skip = (reason: string) => {
        skipped_items.push({ ...itemBase, status: 'skipped', reason });
      };

      if (trades.length >= targetTradeCount) {
        break;
      }

      if (remainingSlots <= 0) {
        break;
      }

      if (!profitGatePolicy.allow_entries) {
        skip(`收益闸门未放行：${profitGatePolicy.reason || profitGatePolicy.gate_label}`);
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
      const gatedSuggestedPct = clamp(
        suggestedPct * profitGatePolicy.effective_position_multiplier,
        0,
        max_position_pct
      );
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
        reason:
          profitGatePolicy.enabled && profitGatePolicy.gate_label
            ? `收益闸门：${profitGatePolicy.gate_label}，倍率 ${profitGatePolicy.effective_position_multiplier}x`
            : undefined,
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
        });
        await this.refreshRecommendationTradeOutcome(signal.id);
      }

      availableCash = roundNumber(availableCash - total_cost, 2);
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
      const allowEntries = !(blockedBySamples || blockedByQuality || blockedByGate);
      const effectivePositionMultiplier = allowEntries
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
        reason:
          gate.reason || (allowEntries ? '收益闸门已放行' : '后验样本或质量分未达到自动跟单阈值'),
        risk_notes: dashboard.playbook?.risk_notes || [],
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
    await signal.update({
      metadata: {
        ...metadata,
        paper_trading: {
          ...(metadata.paper_trading || {}),
          ...execution,
          status: 'executed',
          executed_at: new Date().toISOString(),
          execution_source: 'paper_trading_auto_sync',
        },
      },
    });
  }

  private async markSignalClosed(signal: AIInvestmentSignal, exit: Record<string, any>) {
    const metadata = asPlainObject(signal.metadata);
    await signal.update({
      metadata: {
        ...metadata,
        paper_trading: {
          ...(metadata.paper_trading || {}),
          ...exit,
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
