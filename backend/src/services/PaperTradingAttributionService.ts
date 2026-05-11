import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { AIInvestmentSignal, AISignalSourceType } from '../models/AIInvestmentSignal';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { User } from '../models/User';
import { normalizeSymbol } from '../utils/stockSymbol';
import { paperTradingAutomationService } from './PaperTradingAutomationService';
import { feishuTaskReportService } from './FeishuTaskReportService';

export interface PaperTradingAttributionOptions {
  user_id?: number;
  username?: string;
  include_open?: boolean;
  source_type?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  report_to_feishu?: boolean;
}

export interface PaperTradingClosedAttributionItem {
  status: 'closed';
  signal_id: number;
  source_type: string;
  source_id: string;
  signal_date: string;
  symbol: string;
  name?: string;
  decision?: string;
  score?: number;
  risk_level?: string;
  rating?: string;
  action?: string;
  action_label?: string;
  entry_trade_id?: number;
  exit_trade_id?: number;
  entry_price: number;
  exit_price: number;
  quantity: number;
  entry_amount: number;
  exit_amount: number;
  realized_pnl: number;
  realized_pnl_pct: number;
  holding_days: number;
  exit_reason?: string;
  exit_reason_label?: string;
  executed_at?: string;
  closed_at?: string;
}

export interface PaperTradingOpenAttributionItem {
  status: 'open';
  signal_id?: number;
  source_type: string;
  source_id?: string;
  signal_date?: string;
  symbol: string;
  name?: string;
  decision?: string;
  score?: number;
  risk_level?: string;
  rating?: string;
  action?: string;
  action_label?: string;
  entry_trade_id?: number;
  entry_price: number;
  current_price: number;
  quantity: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  holding_days: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  distance_to_stop_loss_pct?: number;
  distance_to_take_profit_pct?: number;
  risk_state: 'near_stop_loss' | 'approaching_take_profit' | 'profitable' | 'loss' | 'neutral';
  executed_at?: string;
}

export interface PaperTradingAttributionBucket {
  key: string;
  label: string;
  count: number;
  closed_count: number;
  open_count: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  avg_return_pct: number;
  win_rate: number;
  avg_holding_days: number;
  best_symbol?: string;
  best_name?: string;
  best_return_pct?: number;
  worst_symbol?: string;
  worst_name?: string;
  worst_return_pct?: number;
}

export interface PaperTradingAttributionResult {
  portfolio_id: number;
  user_id: number;
  generated_at: string;
  include_open: boolean;
  summary: {
    executed_signals: number;
    closed_count: number;
    open_count: number;
    orphan_open_count: number;
    win_count: number;
    loss_count: number;
    total_realized_pnl: number;
    total_unrealized_pnl: number;
    total_pnl: number;
    avg_return_pct: number;
    win_rate: number;
    avg_holding_days: number;
    avg_win_pct: number;
    avg_loss_pct: number;
    payoff_ratio: number;
    profit_factor: number;
    open_exposure: number;
    open_exposure_pct: number;
    near_stop_loss_count: number;
    best_trade?: PaperTradingClosedAttributionItem;
    worst_trade?: PaperTradingClosedAttributionItem;
    largest_open_loss?: PaperTradingOpenAttributionItem;
    closest_stop_loss?: PaperTradingOpenAttributionItem;
  };
  groups: {
    by_source_type: PaperTradingAttributionBucket[];
    by_risk_level: PaperTradingAttributionBucket[];
    by_action: PaperTradingAttributionBucket[];
    by_rating: PaperTradingAttributionBucket[];
    by_exit_reason: PaperTradingAttributionBucket[];
    by_score_bucket: PaperTradingAttributionBucket[];
  };
  closed_trades: PaperTradingClosedAttributionItem[];
  open_positions: PaperTradingOpenAttributionItem[];
  feedback: {
    recommended_min_score: number;
    recommended_allowed_risk_levels: string[];
    preferred_source_type?: string;
    preferred_action?: string;
    strongest_bucket?: string;
    weakest_bucket?: string;
    insights: string[];
    next_actions: string[];
  };
}

type AttributionRecord = PaperTradingClosedAttributionItem | PaperTradingOpenAttributionItem;

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toOptionalNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
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

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const normalized = Math.floor(num);
  return max ? Math.min(normalized, max) : normalized;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function formatChinaDateTime(value?: Date | string | null): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return moment(date).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
}

function holdingDays(start?: Date | string | null, end?: Date | string | null): number {
  if (!start) return 0;
  const startMoment = moment(start).tz('Asia/Shanghai');
  const endMoment = end ? moment(end).tz('Asia/Shanghai') : moment().tz('Asia/Shanghai');
  if (!startMoment.isValid() || !endMoment.isValid()) return 0;
  return Math.max(0, endMoment.diff(startMoment, 'days'));
}

function scoreBucket(score?: number): string {
  if (score === undefined || score === null || !Number.isFinite(Number(score))) return 'unknown';
  if (score >= 85) return '85+';
  if (score >= 75) return '75-84';
  if (score >= 65) return '65-74';
  if (score >= 55) return '55-64';
  return '<55';
}

function riskState(params: {
  unrealized_pnl_pct: number;
  distance_to_stop_loss_pct?: number;
  distance_to_take_profit_pct?: number;
}): PaperTradingOpenAttributionItem['risk_state'] {
  if (params.distance_to_stop_loss_pct !== undefined && params.distance_to_stop_loss_pct <= 2) {
    return 'near_stop_loss';
  }
  if (params.distance_to_take_profit_pct !== undefined && params.distance_to_take_profit_pct <= 2) {
    return 'approaching_take_profit';
  }
  if (params.unrealized_pnl_pct > 0) return 'profitable';
  if (params.unrealized_pnl_pct < 0) return 'loss';
  return 'neutral';
}

export class PaperTradingAttributionService {
  async getAttribution(
    options: PaperTradingAttributionOptions = {}
  ): Promise<PaperTradingAttributionResult> {
    const includeOpen = toBoolean(options.include_open, true);
    const limit = toPositiveInt(options.limit, 2000, 10000);
    const portfolio = await this.resolvePortfolio(options);

    if (includeOpen) {
      await paperTradingAutomationService.syncLatestPricesAndSnapshot(portfolio.id);
      await portfolio.reload();
    }

    const signalWhere: any = {};
    if (options.source_type && options.source_type !== 'all') {
      signalWhere.source_type = options.source_type;
    }
    if (options.start_date || options.end_date) {
      signalWhere.signal_date = {};
      if (options.start_date) signalWhere.signal_date[Op.gte] = options.start_date;
      if (options.end_date) signalWhere.signal_date[Op.lte] = options.end_date;
    }

    const allSignals = await AIInvestmentSignal.findAll({
      where: signalWhere,
      order: [
        ['updated_at', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
    });

    const signals = allSignals.filter(signal => {
      const paperTrading = asPlainObject(asPlainObject(signal.metadata).paper_trading);
      return (
        Number(paperTrading.portfolio_id) === Number(portfolio.id) &&
        ['executed', 'closed'].includes(String(paperTrading.status || ''))
      );
    });

    const tradeIds = [
      ...new Set(
        signals
          .flatMap(signal => {
            const meta = asPlainObject(asPlainObject(signal.metadata).paper_trading);
            return [toOptionalNumber(meta.trade_id), toOptionalNumber(meta.sell_trade_id)];
          })
          .filter((id): id is number => Boolean(id))
      ),
    ];

    const trades = tradeIds.length
      ? await PaperTradingTrade.findAll({
          where: {
            portfolio_id: portfolio.id,
            id: { [Op.in]: tradeIds },
          },
        })
      : [];
    const tradeMap = new Map<number, PaperTradingTrade>();
    trades.forEach(trade => tradeMap.set(trade.id, trade));

    const positions = includeOpen
      ? await PaperTradingPosition.findAll({ where: { portfolio_id: portfolio.id } })
      : [];
    const positionMap = new Map<string, PaperTradingPosition>();
    positions.forEach(position => positionMap.set(normalizeSymbol(position.symbol), position));

    const closedTrades: PaperTradingClosedAttributionItem[] = [];
    const openPositions: PaperTradingOpenAttributionItem[] = [];
    const linkedOpenSymbols = new Set<string>();

    for (const signal of signals) {
      const metadata = asPlainObject(signal.metadata);
      const paperTrading = asPlainObject(metadata.paper_trading);
      const symbol = normalizeSymbol(signal.symbol);
      const entryTrade = paperTrading.trade_id ? tradeMap.get(Number(paperTrading.trade_id)) : null;
      const exitTrade = paperTrading.sell_trade_id
        ? tradeMap.get(Number(paperTrading.sell_trade_id))
        : null;

      if (paperTrading.status === 'closed') {
        const entryPrice = toNumber(
          paperTrading.execute_price,
          toNumber(entryTrade?.execute_price)
        );
        const exitPrice = toNumber(paperTrading.exit_price, toNumber(exitTrade?.execute_price));
        const quantity = toNumber(
          paperTrading.exit_quantity,
          toNumber(
            paperTrading.quantity,
            toNumber(exitTrade?.quantity, toNumber(entryTrade?.quantity))
          )
        );
        const entryAmount = toNumber(
          paperTrading.amount,
          entryPrice && quantity
            ? roundNumber(entryPrice * quantity, 2)
            : toNumber(entryTrade?.amount)
        );
        const exitAmount = toNumber(
          paperTrading.exit_amount,
          exitPrice && quantity ? roundNumber(exitPrice * quantity, 2) : toNumber(exitTrade?.amount)
        );
        const realizedPnl = roundNumber(
          toNumber(
            paperTrading.realized_pnl,
            toNumber(exitTrade?.realized_pnl, exitAmount - entryAmount)
          ),
          2
        );
        const realizedPnlPct = roundNumber(
          toNumber(
            paperTrading.realized_pnl_pct,
            entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0
          ),
          4
        );
        const executedAt = paperTrading.executed_at || entryTrade?.created_at;
        const closedAt = paperTrading.closed_at || exitTrade?.created_at;

        closedTrades.push({
          status: 'closed',
          signal_id: signal.id,
          source_type: signal.source_type,
          source_id: signal.source_id,
          signal_date: signal.signal_date,
          symbol,
          name: signal.name,
          decision: signal.normalized_decision || signal.decision,
          score: toOptionalNumber(signal.confidence_score),
          risk_level: signal.risk_level || metadata.risk_level,
          rating: metadata.rating,
          action: metadata.action,
          action_label: metadata.action_label,
          entry_trade_id: toOptionalNumber(paperTrading.trade_id),
          exit_trade_id: toOptionalNumber(paperTrading.sell_trade_id),
          entry_price: roundNumber(entryPrice, 4),
          exit_price: roundNumber(exitPrice, 4),
          quantity,
          entry_amount: roundNumber(entryAmount, 2),
          exit_amount: roundNumber(exitAmount, 2),
          realized_pnl: realizedPnl,
          realized_pnl_pct: realizedPnlPct,
          holding_days: toNumber(paperTrading.holding_days, holdingDays(executedAt, closedAt)),
          exit_reason: paperTrading.exit_reason,
          exit_reason_label: paperTrading.exit_reason_label,
          executed_at: formatChinaDateTime(executedAt),
          closed_at: formatChinaDateTime(closedAt),
        });
        continue;
      }

      if (!includeOpen) continue;

      const position = positionMap.get(symbol);
      if (!position) continue;
      linkedOpenSymbols.add(symbol);
      openPositions.push(
        this.buildOpenAttributionItem({
          signal,
          position,
          metadata,
          paperTrading,
          source_type: signal.source_type,
        })
      );
    }

    if (includeOpen) {
      for (const position of positions) {
        const symbol = normalizeSymbol(position.symbol);
        if (linkedOpenSymbols.has(symbol)) continue;
        openPositions.push(
          this.buildOpenAttributionItem({
            position,
            metadata: {},
            paperTrading: {},
            source_type: 'manual_trade',
          })
        );
      }
    }

    closedTrades.sort((a, b) => String(b.closed_at || '').localeCompare(String(a.closed_at || '')));
    openPositions.sort(
      (a, b) =>
        toNumber(a.distance_to_stop_loss_pct, 999) - toNumber(b.distance_to_stop_loss_pct, 999)
    );

    const result = this.buildResult({
      portfolio,
      include_open: includeOpen,
      closed_trades: closedTrades,
      open_positions: openPositions,
      executed_signals: signals.length,
    });

    if (toBoolean(options.report_to_feishu, false)) {
      await feishuTaskReportService.reportPaperTradingAttribution(result, {
        record_type: '模拟盘收益归因',
      });
    }

    return result;
  }

  async reportAttribution(options: PaperTradingAttributionOptions = {}) {
    return this.getAttribution({
      ...options,
      include_open: options.include_open ?? true,
      report_to_feishu: true,
    });
  }

  private async resolvePortfolio(
    options: Pick<PaperTradingAttributionOptions, 'user_id' | 'username'>
  ): Promise<PaperTradingPortfolio> {
    const user = await this.resolveUser(options.user_id, options.username);
    let portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id: user.id, is_active: true },
      order: [['id', 'ASC']],
    });
    if (!portfolio) {
      portfolio = await paperTradingAutomationService.ensurePortfolio({
        user_id: user.id,
        username: user.username,
      });
    }
    return portfolio;
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
    if (!user) throw new Error('未找到可用于模拟盘归因的用户');
    return user;
  }

  private buildOpenAttributionItem(params: {
    signal?: AIInvestmentSignal;
    position: PaperTradingPosition;
    metadata: Record<string, any>;
    paperTrading: Record<string, any>;
    source_type: string;
  }): PaperTradingOpenAttributionItem {
    const { signal, position, metadata, paperTrading, source_type } = params;
    const avgCost = toNumber(position.avg_cost);
    const currentPrice = toNumber(position.current_price);
    const quantity = toNumber(position.quantity);
    const unrealizedPnl = roundNumber(position.unrealized_pnl, 2);
    const unrealizedPnlPct =
      avgCost > 0 ? roundNumber(((currentPrice - avgCost) / avgCost) * 100, 4) : 0;
    const stopLossPct = toOptionalNumber(paperTrading.stop_loss_pct ?? metadata.stop_loss_pct);
    const takeProfitPct = toOptionalNumber(
      paperTrading.take_profit_pct ?? metadata.take_profit_pct
    );
    const distanceToStopLoss =
      stopLossPct !== undefined
        ? roundNumber(unrealizedPnlPct + Math.abs(stopLossPct), 4)
        : undefined;
    const distanceToTakeProfit =
      takeProfitPct !== undefined
        ? roundNumber(Math.abs(takeProfitPct) - unrealizedPnlPct, 4)
        : undefined;
    const executedAt = paperTrading.executed_at || position.created_at;

    return {
      status: 'open',
      signal_id: signal?.id,
      source_type,
      source_id: signal?.source_id,
      signal_date: signal?.signal_date,
      symbol: normalizeSymbol(position.symbol),
      name: signal?.name || position.name,
      decision: signal?.normalized_decision || signal?.decision,
      score: toOptionalNumber(signal?.confidence_score),
      risk_level: signal?.risk_level || metadata.risk_level,
      rating: metadata.rating,
      action: metadata.action,
      action_label: metadata.action_label,
      entry_trade_id: toOptionalNumber(paperTrading.trade_id),
      entry_price: roundNumber(toNumber(paperTrading.execute_price, avgCost), 4),
      current_price: roundNumber(currentPrice, 4),
      quantity,
      market_value: roundNumber(position.market_value, 2),
      unrealized_pnl: unrealizedPnl,
      unrealized_pnl_pct: unrealizedPnlPct,
      holding_days: holdingDays(executedAt),
      stop_loss_pct: stopLossPct,
      take_profit_pct: takeProfitPct,
      distance_to_stop_loss_pct: distanceToStopLoss,
      distance_to_take_profit_pct: distanceToTakeProfit,
      risk_state: riskState({
        unrealized_pnl_pct: unrealizedPnlPct,
        distance_to_stop_loss_pct: distanceToStopLoss,
        distance_to_take_profit_pct: distanceToTakeProfit,
      }),
      executed_at: formatChinaDateTime(executedAt),
    };
  }

  private buildResult(params: {
    portfolio: PaperTradingPortfolio;
    include_open: boolean;
    closed_trades: PaperTradingClosedAttributionItem[];
    open_positions: PaperTradingOpenAttributionItem[];
    executed_signals: number;
  }): PaperTradingAttributionResult {
    const { portfolio, include_open, closed_trades, open_positions } = params;
    const wins = closed_trades.filter(item => item.realized_pnl > 0);
    const losses = closed_trades.filter(item => item.realized_pnl < 0);
    const totalRealizedPnl = roundNumber(
      closed_trades.reduce((sum, item) => sum + toNumber(item.realized_pnl), 0),
      2
    );
    const totalUnrealizedPnl = roundNumber(
      open_positions.reduce((sum, item) => sum + toNumber(item.unrealized_pnl), 0),
      2
    );
    const winSum = wins.reduce((sum, item) => sum + item.realized_pnl, 0);
    const lossSum = Math.abs(losses.reduce((sum, item) => sum + item.realized_pnl, 0));
    const avgWinPct = average(wins.map(item => item.realized_pnl_pct));
    const avgLossPct = average(losses.map(item => item.realized_pnl_pct));
    const bestTrade = [...closed_trades].sort((a, b) => b.realized_pnl_pct - a.realized_pnl_pct)[0];
    const worstTrade = [...closed_trades].sort(
      (a, b) => a.realized_pnl_pct - b.realized_pnl_pct
    )[0];
    const openExposure = roundNumber(
      open_positions.reduce((sum, item) => sum + toNumber(item.market_value), 0),
      2
    );
    const totalValue = Math.max(toNumber(portfolio.total_value), 1);
    const largestOpenLoss = [...open_positions].sort(
      (a, b) => a.unrealized_pnl_pct - b.unrealized_pnl_pct
    )[0];
    const closestStopLoss = [...openPositionsWithStop(open_positions)].sort(
      (a, b) =>
        toNumber(a.distance_to_stop_loss_pct, 999) - toNumber(b.distance_to_stop_loss_pct, 999)
    )[0];

    const records: AttributionRecord[] = [...closed_trades, ...open_positions];
    const groups = {
      by_source_type: this.buildBuckets(records, record => record.source_type, sourceTypeLabel),
      by_risk_level: this.buildBuckets(records, record => record.risk_level, riskLevelLabel),
      by_action: this.buildBuckets(
        records,
        record => record.action_label || record.action,
        value => value || '未标注'
      ),
      by_rating: this.buildBuckets(
        records,
        record => record.rating,
        value => value || '未标注'
      ),
      by_exit_reason: this.buildBuckets(
        closed_trades,
        record =>
          (record as PaperTradingClosedAttributionItem).exit_reason_label ||
          (record as PaperTradingClosedAttributionItem).exit_reason,
        value => value || '未退出'
      ),
      by_score_bucket: this.buildBuckets(
        records,
        record => scoreBucket(record.score),
        value => `评分 ${value}`
      ),
    };

    const summary = {
      executed_signals: params.executed_signals,
      closed_count: closed_trades.length,
      open_count: open_positions.length,
      orphan_open_count: open_positions.filter(item => !item.signal_id).length,
      win_count: wins.length,
      loss_count: losses.length,
      total_realized_pnl: totalRealizedPnl,
      total_unrealized_pnl: totalUnrealizedPnl,
      total_pnl: roundNumber(totalRealizedPnl + totalUnrealizedPnl, 2),
      avg_return_pct: roundNumber(average(closed_trades.map(item => item.realized_pnl_pct)), 4),
      win_rate:
        closed_trades.length > 0 ? roundNumber((wins.length / closed_trades.length) * 100, 2) : 0,
      avg_holding_days: roundNumber(average(closed_trades.map(item => item.holding_days)), 2),
      avg_win_pct: roundNumber(avgWinPct, 4),
      avg_loss_pct: roundNumber(avgLossPct, 4),
      payoff_ratio:
        avgWinPct && avgLossPct
          ? roundNumber(avgWinPct / Math.abs(avgLossPct), 4)
          : wins.length > 0 && losses.length === 0
            ? 999
            : 0,
      profit_factor: lossSum > 0 ? roundNumber(winSum / lossSum, 4) : wins.length > 0 ? 999 : 0,
      open_exposure: openExposure,
      open_exposure_pct: roundNumber((openExposure / totalValue) * 100, 2),
      near_stop_loss_count: open_positions.filter(item => item.risk_state === 'near_stop_loss')
        .length,
      best_trade: bestTrade,
      worst_trade: worstTrade,
      largest_open_loss: largestOpenLoss,
      closest_stop_loss: closestStopLoss,
    };

    return {
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      include_open,
      summary,
      groups,
      closed_trades: closed_trades.slice(0, 100),
      open_positions: open_positions.slice(0, 100),
      feedback: this.buildFeedback(summary, groups),
    };
  }

  private buildBuckets(
    records: AttributionRecord[],
    keySelector: (record: AttributionRecord) => string | undefined | null,
    labelSelector: (key: string) => string
  ): PaperTradingAttributionBucket[] {
    const grouped = new Map<string, AttributionRecord[]>();
    for (const record of records) {
      const key = String(keySelector(record) || 'unknown');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(record);
    }

    return [...grouped.entries()]
      .map(([key, items]) => {
        const closed = items.filter(
          (item): item is PaperTradingClosedAttributionItem => item.status === 'closed'
        );
        const open = items.filter(
          (item): item is PaperTradingOpenAttributionItem => item.status === 'open'
        );
        const wins = closed.filter(item => item.realized_pnl > 0);
        const best = [...closed].sort((a, b) => b.realized_pnl_pct - a.realized_pnl_pct)[0];
        const worst = [...closed].sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct)[0];
        return {
          key,
          label: labelSelector(key),
          count: items.length,
          closed_count: closed.length,
          open_count: open.length,
          total_realized_pnl: roundNumber(
            closed.reduce((sum, item) => sum + item.realized_pnl, 0),
            2
          ),
          total_unrealized_pnl: roundNumber(
            open.reduce((sum, item) => sum + item.unrealized_pnl, 0),
            2
          ),
          avg_return_pct: roundNumber(average(closed.map(item => item.realized_pnl_pct)), 4),
          win_rate: closed.length > 0 ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
          avg_holding_days: roundNumber(average(closed.map(item => item.holding_days)), 2),
          best_symbol: best?.symbol,
          best_name: best?.name,
          best_return_pct: best?.realized_pnl_pct,
          worst_symbol: worst?.symbol,
          worst_name: worst?.name,
          worst_return_pct: worst?.realized_pnl_pct,
        };
      })
      .sort((a, b) => {
        if (b.closed_count !== a.closed_count) return b.closed_count - a.closed_count;
        if (b.avg_return_pct !== a.avg_return_pct) return b.avg_return_pct - a.avg_return_pct;
        return b.count - a.count;
      });
  }

  private buildFeedback(
    summary: PaperTradingAttributionResult['summary'],
    groups: PaperTradingAttributionResult['groups']
  ): PaperTradingAttributionResult['feedback'] {
    let recommendedMinScore = 72;
    if (summary.closed_count >= 3) {
      if (summary.avg_return_pct < -1 || summary.win_rate < 45) recommendedMinScore += 5;
      if (summary.avg_return_pct > 2 && summary.win_rate >= 55) recommendedMinScore -= 2;
    }

    const riskGroups = groups.by_risk_level.filter(group =>
      ['low', 'medium', 'high'].includes(group.key)
    );
    const recommendedRiskLevels = riskGroups
      .filter(group => group.closed_count < 2 || group.avg_return_pct >= 0 || group.win_rate >= 50)
      .map(group => group.key);
    const safeRiskLevels =
      recommendedRiskLevels.length > 0 ? recommendedRiskLevels : ['low', 'medium'];

    const bestSource = groups.by_source_type
      .filter(group => group.closed_count > 0)
      .sort((a, b) => b.avg_return_pct - a.avg_return_pct)[0];
    const bestAction = groups.by_action
      .filter(group => group.closed_count > 0)
      .sort((a, b) => b.avg_return_pct - a.avg_return_pct)[0];
    const bestScoreBucket = groups.by_score_bucket
      .filter(group => group.closed_count > 0)
      .sort((a, b) => b.avg_return_pct - a.avg_return_pct)[0];
    const worstBucket = groups.by_score_bucket
      .filter(group => group.closed_count > 0)
      .sort((a, b) => a.avg_return_pct - b.avg_return_pct)[0];

    const insights: string[] = [];
    const nextActions: string[] = [];

    if (summary.closed_count === 0) {
      insights.push('模拟盘尚未形成已平仓样本，当前重点是积累闭环交易，不宜过早调参。');
      nextActions.push(
        '继续执行每日 15:40 自动跟单与 15:50 风控退出，至少积累 5 笔闭环后再扩大仓位。'
      );
    } else {
      insights.push(
        `已闭环 ${summary.closed_count} 笔，胜率 ${summary.win_rate}% ，平均收益 ${summary.avg_return_pct}%。`
      );
      if (summary.best_trade) {
        insights.push(
          `最佳样本是 ${summary.best_trade.name || summary.best_trade.symbol}，收益 ${summary.best_trade.realized_pnl_pct}%。`
        );
      }
      if (summary.worst_trade && summary.worst_trade.realized_pnl_pct < 0) {
        insights.push(
          `最大拖累是 ${summary.worst_trade.name || summary.worst_trade.symbol}，收益 ${summary.worst_trade.realized_pnl_pct}%，后续需复盘入场条件。`
        );
      }
      if (bestSource) {
        insights.push(
          `当前收益最好的信号来源是 ${bestSource.label}，平均收益 ${bestSource.avg_return_pct}%。`
        );
      }
      if (bestScoreBucket) {
        insights.push(
          `${bestScoreBucket.label} 桶的闭环表现最好，建议优先观察这一评分区间的候选。`
        );
      }
      nextActions.push(`下一轮自动跟单建议最低评分调整为 ${recommendedMinScore} 分。`);
      nextActions.push(`允许风险等级建议为：${safeRiskLevels.map(riskLevelLabel).join('、')}。`);
    }

    if (summary.open_count > 0) {
      insights.push(
        `当前仍持有 ${summary.open_count} 只，敞口 ${summary.open_exposure_pct}% ，浮动盈亏 ¥${summary.total_unrealized_pnl}。`
      );
    }
    if (summary.near_stop_loss_count > 0) {
      nextActions.push(
        `有 ${summary.near_stop_loss_count} 只接近止损线，建议优先触发风控预演并人工复核。`
      );
    }
    if (summary.closest_stop_loss) {
      nextActions.push(
        `${summary.closest_stop_loss.name || summary.closest_stop_loss.symbol} 距离止损线约 ${
          summary.closest_stop_loss.distance_to_stop_loss_pct
        } 个百分点，是当前最需要盯盘的持仓。`
      );
    }

    return {
      recommended_min_score: recommendedMinScore,
      recommended_allowed_risk_levels: safeRiskLevels,
      preferred_source_type: bestSource?.key,
      preferred_action: bestAction?.key,
      strongest_bucket: bestScoreBucket?.label,
      weakest_bucket: worstBucket?.label,
      insights,
      next_actions: nextActions,
    };
  }
}

function openPositionsWithStop(items: PaperTradingOpenAttributionItem[]) {
  return items.filter(item => item.distance_to_stop_loss_pct !== undefined);
}

function sourceTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    [AISignalSourceType.QUANT_RECOMMENDATION]: '量化推荐',
    [AISignalSourceType.TRADING_AGENTS]: 'TradingAgents',
    [AISignalSourceType.DAILY_SCREENER]: 'AI每日优选',
    [AISignalSourceType.MANUAL_ANALYSIS]: '人工分析',
    manual_trade: '手动交易',
    unknown: '未标注来源',
  };
  return labels[value] || value || '未标注来源';
}

function riskLevelLabel(value: string): string {
  const labels: Record<string, string> = {
    low: '低风险',
    medium: '中风险',
    high: '高风险',
    unknown: '未标注风险',
  };
  return labels[value] || value || '未标注风险';
}

export const paperTradingAttributionService = new PaperTradingAttributionService();
