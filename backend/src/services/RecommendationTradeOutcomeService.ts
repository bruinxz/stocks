import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { AIInvestmentSignal } from '../models/AIInvestmentSignal';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { User } from '../models/User';
import { benchmarkIndexService } from './BenchmarkIndexService';
import { paperTradingAutomationService } from './PaperTradingAutomationService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { recommendationLoopPolicySnapshotService } from './RecommendationLoopPolicySnapshotService';
import { normalizeSymbol, extractMarket } from '../utils/stockSymbol';
import { logger } from '../utils/logger';

export interface RecommendationTradeOutcomeRefreshOptions {
  user_id?: number;
  username?: string;
  portfolio_id?: number;
  loop_run_id?: string;
  include_open?: boolean;
  lookback_days?: number;
  source_type?: string;
  agent_session?: string;
  signal_id?: number;
  limit?: number;
  report_to_feishu?: boolean;
}

export interface RecommendationTradeOutcomeQueryOptions
  extends RecommendationTradeOutcomeRefreshOptions {
  trade_status?: string;
  start_date?: string;
  end_date?: string;
  offset?: number;
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
  };
  outcomes: RecommendationTradeOutcome[];
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

function dateOnly(value?: Date | string | null): string {
  if (!value) return getChinaToday();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return moment(date).tz('Asia/Shanghai').format('YYYY-MM-DD');
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

function sourceTypeLabel(value?: string): string {
  const labels: Record<string, string> = {
    quant_recommendation: '量化候选',
    tradingagents: 'TradingAgents',
    daily_screener: 'AI每日优选',
    manual_analysis: '手动分析',
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

    const paperTrading = asPlainObject(asPlainObject(signal.metadata).paper_trading);
    if (!paperTrading.portfolio_id) return null;

    const outcome = await this.upsertFromExecutedSignal(signal, {
      include_open: true,
      portfolio_id: Number(paperTrading.portfolio_id),
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
      const paperTrading = asPlainObject(asPlainObject(signal.metadata).paper_trading);
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
        value => value || '未标注'
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
    };

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
      outcomes: outcomes.slice(0, 200),
      feedback: this.buildFeedback(summary, groups),
    };

    if (toBoolean(options.report_to_feishu, false)) {
      await feishuTaskReportService.reportRecommendationTradeOutcomes(dashboard, {
        record_type: '推荐交易收益闭环看板',
      });
    }

    return dashboard;
  }

  async upsertFromExecutedSignal(
    signal: AIInvestmentSignal,
    options: { include_open?: boolean; portfolio_id?: number } = {}
  ): Promise<RecommendationTradeOutcome | null> {
    const metadata = asPlainObject(signal.metadata);
    const paperTrading = asPlainObject(metadata.paper_trading);
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
      total_pnl_pct: totalPnlPct,
    });

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
      metadata: {
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
      return existing;
    }

    return RecommendationTradeOutcome.create(payload as any);
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
    options: Pick<RecommendationTradeOutcomeRefreshOptions, 'user_id' | 'username' | 'portfolio_id'>
  ): Promise<PaperTradingPortfolio> {
    if (options.portfolio_id) {
      const portfolio = await PaperTradingPortfolio.findByPk(options.portfolio_id);
      if (portfolio) return portfolio;
    }

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

  private buildBuckets(
    records: RecommendationTradeOutcome[],
    keySelector: (record: RecommendationTradeOutcome) => string | undefined | null,
    labelSelector: (key: string) => string
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
        return {
          key,
          label: labelSelector(key),
          count: plain.length,
          open_count: open.length,
          closed_count: closed.length,
          win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
          excess_win_rate: closed.length
            ? roundNumber((excessWins.length / closed.length) * 100, 2)
            : 0,
          avg_return_pct: roundNumber(
            average(closed.map(item => toNumber(item.realized_pnl_pct))),
            4
          ),
          avg_excess_return_pct: roundNumber(
            average(closed.map(item => toNumber(item.excess_return_pct))),
            4
          ),
          total_pnl: roundNumber(
            plain.reduce((sum, item) => sum + toNumber(item.total_pnl), 0),
            2
          ),
          profit_factor: lossSum > 0 ? roundNumber(winSum / lossSum, 4) : wins.length > 0 ? 999 : 0,
          avg_holding_days: roundNumber(average(plain.map(item => toNumber(item.holding_days))), 2),
          best_symbol: best?.symbol,
          best_name: best?.name,
          best_return_pct: best?.total_pnl_pct,
          worst_symbol: worst?.symbol,
          worst_name: worst?.name,
          worst_return_pct: worst?.total_pnl_pct,
          avg_consensus_count: roundNumber(average(consensusCounts), 2),
          avg_consensus_bonus: roundNumber(average(consensusBonuses), 2),
        };
      })
      .sort((a, b) => {
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
