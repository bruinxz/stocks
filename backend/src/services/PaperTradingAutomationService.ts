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

export interface PaperTradingAutoOptions {
  user_id?: number;
  username?: string;
  source_type?: string;
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
}

export interface PaperTradingAutoSyncOptions extends PaperTradingAutoOptions {
  refresh_recommendations?: boolean;
  universe?: 'favorites' | 'market';
  style?: 'balanced' | 'momentum' | 'value' | 'low_risk';
  candidate_limit?: number;
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
    const min_score = toNumber(options.min_score, 72);
    const max_positions = toPositiveInt(options.max_positions, 8, 30);
    const default_position_pct = toNumber(options.default_position_pct, 5);
    const max_position_pct = toNumber(options.max_position_pct, 12);
    const min_trade_amount = toNumber(options.min_trade_amount, 3000);
    const source_type = options.source_type || AISignalSourceType.QUANT_RECOMMENDATION;
    const require_action_buy = toBoolean(
      options.require_action_buy,
      source_type === AISignalSourceType.QUANT_RECOMMENDATION
    );
    const allowedRiskLevels = new Set(
      (options.allowed_risk_levels?.length
        ? options.allowed_risk_levels
        : ['low', 'medium', '']
      ).map(normalizeRiskLevel)
    );

    const portfolio = await this.ensurePortfolio({
      user_id: options.user_id,
      username: options.username,
    });
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
      const targetAmount = Math.min(totalValue * (suggestedPct / 100), availableCash * 0.98);
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
        target_position_pct: suggestedPct,
        stop_loss_pct: toOptionalNumber(metadata.stop_loss_pct),
        take_profit_pct: toOptionalNumber(metadata.take_profit_pct),
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
          target_position_pct: suggestedPct,
          stop_loss_pct: tradePayload.stop_loss_pct,
          take_profit_pct: tradePayload.take_profit_pct,
        });
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
}

export const paperTradingAutomationService = new PaperTradingAutomationService();
