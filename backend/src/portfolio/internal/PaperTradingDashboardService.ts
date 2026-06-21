import { Op } from 'sequelize';
import moment from 'moment-timezone';
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../../models/AIInvestmentSignal';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../../models/PaperTradingSnapshot';
import { PaperTradingOrderIntent } from '../../models/PaperTradingOrderIntent';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { paperTradingAutomationService } from './PaperTradingAutomationService';
import { recommendationTradeOutcomeService } from '../../services/RecommendationTradeOutcomeService';
import { paperTradingOrderIntentService } from './PaperTradingOrderIntentService';
import {
  AGENT_ONLY_PORTFOLIO_NAME,
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  PAPER_PORTFOLIO_FAMILIES,
  PARAM_EXPERIMENT_PORTFOLIO_NAME,
  PAPER_PORTFOLIO_EXPERIMENT_FAMILIES,
  QUANT_AGENT_FUSION_PORTFOLIO_NAME,
  QUANT_ONLY_PORTFOLIO_NAME,
} from './PaperTradingPortfolioFamilies';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { logger } from '../../utils/logger';

export {
  AGENT_ONLY_PORTFOLIO_NAME,
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  PAPER_PORTFOLIO_FAMILIES,
  PARAM_EXPERIMENT_PORTFOLIO_NAME,
  PAPER_PORTFOLIO_EXPERIMENT_FAMILIES,
  QUANT_AGENT_FUSION_PORTFOLIO_NAME,
  QUANT_ONLY_PORTFOLIO_NAME,
} from './PaperTradingPortfolioFamilies';

type TrackingStatus =
  | 'candidate'
  | 'watch'
  | 'sell_signal'
  | 'open'
  | 'closed'
  | 'skipped'
  | 'not_traded';

type PortfolioFamilyRunStatus =
  | 'not_created'
  | 'ready_empty'
  | 'signaled_blocked'
  | 'active'
  | 'traded_flat';

export interface PaperTradingDashboardOptions {
  portfolio_id?: number;
  user_id?: number;
  username?: string;
  lookback_days?: number;
  limit?: number;
  source_type?: string;
  status?: string;
  include_family_summary?: boolean;
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const normalized = Math.floor(num);
  return max ? Math.min(normalized, max) : normalized;
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function modelToPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function getChinaToday(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function sourceTypeLabel(value?: string): string {
  const labels: Record<string, string> = {
    [AISignalSourceType.QUANT_RECOMMENDATION]: '全市场量化候选',
    [AISignalSourceType.TRADING_AGENTS]: 'TradingAgents 深度复核',
    [AISignalSourceType.DAILY_SCREENER]: 'AI每日优选',
    [AISignalSourceType.MANUAL_ANALYSIS]: '人工分析',
    [AISignalSourceType.ANALYSIS_ENGINE]: '多维分析引擎',
  };
  return labels[String(value || '')] || value || '未知来源';
}

function decisionLabel(value?: string): string {
  const labels: Record<string, string> = {
    [AISignalDecision.STRONG_BUY]: '强买',
    [AISignalDecision.BUY]: '买入',
    [AISignalDecision.HOLD]: '观察',
    [AISignalDecision.SELL]: '卖出',
    [AISignalDecision.STRONG_SELL]: '强卖',
    [AISignalDecision.UNKNOWN]: '未知',
  };
  return labels[String(value || '')] || value || '未知';
}

function commandFromSignal(signal: AIInvestmentSignal, metadata: Record<string, any>) {
  const decision = signal.normalized_decision || signal.decision;
  const action = String(metadata.action || '').toLowerCase();
  if ([AISignalDecision.SELL, AISignalDecision.STRONG_SELL].includes(decision as any)) {
    return {
      command: 'sell',
      command_label: decision === AISignalDecision.STRONG_SELL ? '强制卖出' : '卖出/退出',
    };
  }
  if (
    [AISignalDecision.BUY, AISignalDecision.STRONG_BUY].includes(decision as any) ||
    action === 'buy'
  ) {
    return {
      command: 'buy',
      command_label: decision === AISignalDecision.STRONG_BUY ? '强买/建仓' : '买入/试仓',
    };
  }
  if (action === 'avoid') return { command: 'avoid', command_label: '回避' };
  return { command: 'watch', command_label: '观察' };
}

function latestForwardReturn(signal: any) {
  const horizons = signal.forward_returns?.horizons || {};
  const priority = ['1d', '3d', '5d', '10d', '20d'];
  for (const key of priority) {
    const item = horizons[key];
    if (item?.status === 'completed') {
      return {
        horizon: key,
        status: item.status,
        return_pct: roundNumber(item.directional_return_pct ?? item.return_pct, 4),
        raw_return_pct: roundNumber(item.return_pct, 4),
        exit_date: item.exit_date,
      };
    }
  }
  const pendingKey = priority.find(key => horizons[key]?.status);
  return pendingKey
    ? { horizon: pendingKey, status: horizons[pendingKey].status, return_pct: undefined }
    : undefined;
}

function trackingStatus(params: {
  signal: AIInvestmentSignal;
  metadata: Record<string, any>;
  paperTrading: Record<string, any>;
  outcome?: any;
}): TrackingStatus {
  const { signal, metadata, paperTrading, outcome } = params;
  const decision = signal.normalized_decision || signal.decision;
  if (outcome?.trade_status === 'closed' || paperTrading.status === 'closed') return 'closed';
  if (outcome?.trade_status === 'open' || paperTrading.status === 'executed') return 'open';
  if (paperTrading.status === 'skipped') return 'skipped';
  if ([AISignalDecision.SELL, AISignalDecision.STRONG_SELL].includes(decision as any)) {
    return 'sell_signal';
  }
  const action = String(metadata.action || '').toLowerCase();
  if (
    action === 'buy' ||
    [AISignalDecision.BUY, AISignalDecision.STRONG_BUY].includes(decision as any)
  ) {
    return 'candidate';
  }
  if (action === 'watch' || decision === AISignalDecision.HOLD) return 'watch';
  return 'not_traded';
}

function statusLabel(status: TrackingStatus): string {
  const labels: Record<TrackingStatus, string> = {
    candidate: '待跟单候选',
    watch: '观察中',
    sell_signal: '卖出信号',
    open: '模拟持仓中',
    closed: '已闭环结算',
    skipped: '已跳过',
    not_traded: '未交易',
  };
  return labels[status] || status;
}

function portfolioFamilyByName(name?: string) {
  return PAPER_PORTFOLIO_FAMILIES.find(item => item.name === name) || null;
}

function normalizeTrade(trade: any, family?: Record<string, any> | null) {
  return {
    ...trade,
    execute_price: toNumber(trade.execute_price),
    quantity: toNumber(trade.quantity),
    amount: toNumber(trade.amount),
    commission: toNumber(trade.commission),
    realized_pnl: trade.realized_pnl === null ? null : toNumber(trade.realized_pnl),
    account_key: family?.key,
    account_label: family?.label,
    account_name: family?.name,
  };
}

function orderIntentStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    planned: '计划',
    executed: '成交',
    rejected: '拦截',
    skipped: '跳过',
    held: '持有',
  };
  return labels[String(status || '')] || status || '未知';
}

function orderIntentReasonLabel(category?: string): string {
  const labels: Record<string, string> = {
    executed: '已成交',
    planned: '计划买入',
    risk_hold: '风控持有',
    profit_gate: '收益闸门',
    outcome_feedback: '收益反哺',
    data_quality: '数据质量',
    execution_reality: '交易可执行性',
    risk_level: '风险等级',
    trade_discipline: '交易纪律',
    capital_or_lot_size: '资金/手数',
    market_data: '行情数据',
    position_limit: '持仓上限',
    stale_signal: '旧信号',
    other: '其他',
    unknown: '未归类',
  };
  return labels[String(category || '')] || category || '未归类';
}

function buildFamilyDefaultReason(family: (typeof PAPER_PORTFOLIO_FAMILIES)[number]): string {
  if (family.key === 'agent_only') {
    return '独立 Agent 对照盘已初始化；当前 TradingAgents 深度复核优先写入「量化+Agent融合盘」，该账户用于后续独立 Agent 跟单对照。';
  }
  if (family.key === 'quant_agent_fusion') {
    return '等待量化候选提交 TradingAgents 并轮询完成；只有 Agent 复核通过且风控放行后才会建仓。';
  }
  if (family.key === 'param_experiment') {
    return '参数实验盘只承接 A/B 参数生命周期中的晋级/观察样本，小仓验证触发后才会出现持仓。';
  }
  if (family.key === 'quant_only') {
    return '等待量化扫描产生买入候选，并通过行情、仓位、风控和资金手数校验。';
  }
  if (PAPER_PORTFOLIO_EXPERIMENT_FAMILIES.some(item => item.key === family.key)) {
    return `${family.label}已就绪；只接收该策略族的独立小仓样本，等待下一轮量化扫描建仓或记录拒单原因。`;
  }
  return '综合盘已就绪；有信号但被资金/风控/旧信号去重拦截时，不会生成模拟交易。';
}

function buildFamilyRunStatus(params: {
  exists: boolean;
  positions: any[];
  trades: any[];
  intentSummary?: any;
}): { run_status: PortfolioFamilyRunStatus; run_status_label: string } {
  if (!params.exists) return { run_status: 'not_created', run_status_label: '未初始化' };
  if (params.positions.length > 0) return { run_status: 'active', run_status_label: '持仓运行中' };
  if ((params.intentSummary?.executed_count || 0) > 0 || params.trades.length > 0) {
    return { run_status: 'traded_flat', run_status_label: '已交易空仓' };
  }
  if (
    (params.intentSummary?.rejected_count || 0) > 0 ||
    (params.intentSummary?.skipped_count || 0) > 0
  ) {
    return { run_status: 'signaled_blocked', run_status_label: '有信号未成交' };
  }
  return { run_status: 'ready_empty', run_status_label: '已就绪待信号' };
}

export class PaperTradingDashboardService {
  async getAutonomousDashboard(options: PaperTradingDashboardOptions = {}) {
    const portfolio = await this.ensureAutonomousPortfolio(options);
    await this.ensurePortfolioFamilies(options);
    const preSyncFamilySummary = await this.getPortfolioFamilySummary(options);
    const syncTargets = [
      portfolio.id,
      ...preSyncFamilySummary.families
        .map(item => Number(item.portfolio_id))
        .filter(value => Number.isFinite(value) && value > 0),
    ];
    await Promise.all([...new Set(syncTargets)].map(id => this.safeSyncSnapshot(id)));
    const familySummary = await this.getPortfolioFamilySummary(options);
    await portfolio.reload();

    const trackingOptions = {
      ...options,
      portfolio_id: portfolio.id,
      limit: Math.min(toPositiveInt(options.limit, 30, 200), 80),
      lookback_days: toPositiveInt(options.lookback_days, 30, 3650),
    };

    const activeFamilyIds = familySummary.families
      .filter(item => item.exists && Number(item.open_position_count || 0) > 0)
      .map(item => Number(item.portfolio_id))
      .filter(value => Number.isFinite(value) && value > 0);
    const tradeFamilyIds = familySummary.families
      .filter(item => item.exists && Number(item.trade_count || 0) > 0)
      .map(item => Number(item.portfolio_id))
      .filter(value => Number.isFinite(value) && value > 0);
    const familyByPortfolioId = new Map(
      familySummary.families
        .filter(item => item.portfolio_id)
        .map(item => [Number(item.portfolio_id), item])
    );

    const [
      positions,
      recentTrades,
      allSellTrades,
      snapshots,
      outcomeDashboard,
      tracking,
      familyIntentHindsight,
      allOpenPositions,
      familyRecentTrades,
    ] = await Promise.all([
      PaperTradingPosition.findAll({
        where: { portfolio_id: portfolio.id },
        order: [['market_value', 'DESC']],
        raw: true,
      }) as any,
      PaperTradingTrade.findAll({
        where: { portfolio_id: portfolio.id },
        order: [['created_at', 'DESC']],
        limit: 40,
        raw: true,
      }) as any,
      PaperTradingTrade.findAll({
        where: { portfolio_id: portfolio.id, direction: 'SELL' },
        order: [['created_at', 'DESC']],
        limit: 5000,
        raw: true,
      }) as any,
      this.getRecentSnapshots(portfolio.id),
      recommendationTradeOutcomeService
        .getDashboard({ portfolio_id: portfolio.id, include_open: true, limit: 2000 })
        .catch(error => {
          logger.warn(`自主模拟盘收益闭环看板读取失败: ${error?.message || error}`);
          return null;
        }),
      this.getRecommendationTracking(trackingOptions).catch(error => {
        logger.warn(`自主模拟盘推荐追踪读取失败: ${error?.message || error}`);
        return null;
      }),
      paperTradingOrderIntentService
        .getFamilyHindsightDashboard({
          user_id: options.user_id,
          username: options.username,
          lookback_days: toPositiveInt(options.lookback_days, 30, 3650),
          limit: 2000,
        })
        .catch(error => {
          logger.warn(`策略账户拒单后验读取失败: ${error?.message || error}`);
          return null;
        }),
      activeFamilyIds.length
        ? (PaperTradingPosition.findAll({
            where: { portfolio_id: { [Op.in]: activeFamilyIds } },
            order: [['market_value', 'DESC']],
            raw: true,
          }) as any)
        : [],
      tradeFamilyIds.length
        ? (PaperTradingTrade.findAll({
            where: { portfolio_id: { [Op.in]: tradeFamilyIds } },
            order: [['created_at', 'DESC']],
            limit: 60,
            raw: true,
          }) as any)
        : [],
    ]);

    const initialCapital = toNumber(portfolio.initial_capital, DEFAULT_AUTONOMOUS_INITIAL_CAPITAL);
    const currentCash = toNumber(portfolio.current_cash, initialCapital);
    const totalValue = toNumber(portfolio.total_value, initialCapital);
    const positionValue = positions.reduce(
      (sum: number, item: any) => sum + toNumber(item.market_value),
      0
    );
    const realizedPnl = allSellTrades.reduce(
      (sum: number, item: any) => sum + toNumber(item.realized_pnl),
      0
    );
    const unrealizedPnl = positions.reduce(
      (sum: number, item: any) => sum + toNumber(item.unrealized_pnl),
      0
    );
    const totalPnl = totalValue - initialCapital;
    const closedCount = Number(outcomeDashboard?.summary?.closed_count || 0);
    const winRate = Number(outcomeDashboard?.summary?.win_rate || 0);

    const normalizePosition = (position: any, family?: Record<string, any> | null) => {
      const marketValue = toNumber(position.market_value);
      const avgCost = toNumber(position.avg_cost);
      const currentPrice = toNumber(position.current_price);
      const quantity = toNumber(position.quantity);
      const unrealized = toNumber(position.unrealized_pnl);
      const accountTotalValue = toNumber(family?.total_value, totalValue);
      return {
        ...position,
        quantity,
        avg_cost: avgCost,
        current_price: currentPrice,
        market_value: roundNumber(marketValue, 2),
        unrealized_pnl: roundNumber(unrealized, 2),
        unrealized_pnl_pct:
          avgCost > 0 ? roundNumber(((currentPrice - avgCost) / avgCost) * 100, 4) : 0,
        weight_pct:
          accountTotalValue > 0 ? roundNumber((marketValue / accountTotalValue) * 100, 2) : 0,
        account_key: family?.key,
        account_label: family?.label,
        account_name: family?.name,
      };
    };

    const autonomousFamily = portfolioFamilyByName(portfolio.name);
    const normalizedPositions = positions.map((position: any) =>
      normalizePosition(position, autonomousFamily)
    );
    const normalizedAllOpenPositions = (allOpenPositions as any[]).map((position: any) =>
      normalizePosition(position, familyByPortfolioId.get(Number(position.portfolio_id)))
    );

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio: modelToPlain(portfolio),
      summary: {
        initial_capital: roundNumber(initialCapital, 2),
        total_value: roundNumber(totalValue, 2),
        current_cash: roundNumber(currentCash, 2),
        position_value: roundNumber(positionValue, 2),
        cash_pct: totalValue > 0 ? roundNumber((currentCash / totalValue) * 100, 2) : 0,
        exposure_pct: totalValue > 0 ? roundNumber((positionValue / totalValue) * 100, 2) : 0,
        total_pnl: roundNumber(totalPnl, 2),
        total_return_pct:
          initialCapital > 0 ? roundNumber((totalPnl / initialCapital) * 100, 4) : 0,
        realized_pnl: roundNumber(realizedPnl, 2),
        unrealized_pnl: roundNumber(unrealizedPnl, 2),
        open_position_count: positions.length,
        trade_count: recentTrades.length,
        tracked_recommendation_count: tracking?.summary?.total_signals || 0,
        closed_recommendation_count: closedCount,
        win_rate: winRate,
        excess_win_rate: Number(outcomeDashboard?.summary?.excess_win_rate || 0),
        avg_closed_return_pct: Number(outcomeDashboard?.summary?.avg_closed_return_pct || 0),
      },
      positions: normalizedPositions,
      recent_trades: recentTrades.map((trade: any) => normalizeTrade(trade, autonomousFamily)),
      all_open_positions: normalizedAllOpenPositions,
      all_recent_trades: (familyRecentTrades as any[]).map((trade: any) =>
        normalizeTrade(trade, familyByPortfolioId.get(Number(trade.portfolio_id)))
      ),
      portfolio_family_summary: familySummary,
      family_order_intent_hindsight: familyIntentHindsight,
      equity_curve: snapshots.map((item: any) => {
        const total = toNumber(item.total_value, initialCapital);
        return {
          ...item,
          total_value: roundNumber(total, 2),
          current_cash: roundNumber(item.current_cash, 2),
          position_value: roundNumber(item.position_value, 2),
          total_return_pct:
            initialCapital > 0
              ? roundNumber(((total - initialCapital) / initialCapital) * 100, 4)
              : 0,
        };
      }),
      recommendation_tracking: tracking
        ? {
            summary: tracking.summary,
            daily_groups: tracking.daily_groups.slice(0, 10),
            items: tracking.items.slice(0, 12),
          }
        : null,
      outcome_dashboard: outcomeDashboard
        ? {
            summary: outcomeDashboard.summary,
            feedback: outcomeDashboard.feedback,
            groups: outcomeDashboard.groups,
          }
        : null,
      guardrails: {
        initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
        position_sizing: '默认单票 5%，收益闸门/数据质量/风险守门会自动降仓或跳过',
        sell_rule: '出现止损、止盈、最长持有期或新的卖出信号时，模拟盘会结算收益',
        capital_rule: '仅做模拟盘闭环，不代表真实下单；所有收益用于反向优化推荐策略',
      },
    };
  }

  async getRecommendationTracking(options: PaperTradingDashboardOptions = {}) {
    // Batch G (2026-06-17): portfolio_id 路径必须带 user_id 校验防越权.
    // ensureAutonomousPortfolio 内部按 user_id 路由 (autonomous 盘按 user 命名), 安全.
    let portfolio: PaperTradingPortfolio | null = null;
    if (options.portfolio_id) {
      const userId = Number(options.user_id);
      if (!Number.isFinite(userId) || userId <= 0) {
        const err: any = new Error('user_id required when passing portfolio_id');
        err.statusCode = 400;
        throw err;
      }
      portfolio = await PaperTradingPortfolio.findOne({
        where: { id: options.portfolio_id, user_id: userId },
      });
      if (!portfolio) {
        const err: any = new Error('未找到模拟盘或无权访问');
        err.statusCode = 404;
        err.code = 'PORTFOLIO_NOT_FOUND_OR_FORBIDDEN';
        throw err;
      }
    } else {
      portfolio = await this.ensureAutonomousPortfolio(options);
    }
    if (!portfolio) throw new Error(`自主模拟盘不存在: ${options.portfolio_id}`);
    const limit = toPositiveInt(options.limit, 200, 1000);
    const lookbackDays = toPositiveInt(options.lookback_days, 60, 3650);
    const startDate = moment()
      .tz('Asia/Shanghai')
      .subtract(lookbackDays, 'days')
      .format('YYYY-MM-DD');

    const where: any = {
      signal_date: { [Op.gte]: startDate, [Op.lte]: getChinaToday() },
      source_type: {
        [Op.in]: [
          AISignalSourceType.QUANT_RECOMMENDATION,
          AISignalSourceType.TRADING_AGENTS,
          AISignalSourceType.DAILY_SCREENER,
        ],
      },
    };
    if (options.source_type && options.source_type !== 'all') {
      where.source_type = options.source_type;
    }

    const signals = await AIInvestmentSignal.findAll({
      where,
      order: [
        ['signal_date', 'DESC'],
        ['confidence_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
    });
    const signalIds = signals.map(signal => signal.id);
    const outcomes = signalIds.length
      ? await RecommendationTradeOutcome.findAll({
          where: { portfolio_id: portfolio.id, signal_id: { [Op.in]: signalIds } },
          raw: true,
        })
      : [];
    const outcomeBySignalId = new Map<number, any>();
    outcomes.forEach((outcome: any) => outcomeBySignalId.set(Number(outcome.signal_id), outcome));

    const items = signals
      .map(signal => {
        const metadata = asPlainObject(signal.metadata);
        const paperTrading = asPlainObject(metadata.paper_trading);
        const outcome = outcomeBySignalId.get(Number(signal.id));
        const status = trackingStatus({ signal, metadata, paperTrading, outcome });
        const command = commandFromSignal(signal, metadata);
        const forward = latestForwardReturn(signal);
        const dataQuality = asPlainObject(metadata.data_quality);
        const dataQualityScore =
          metadata.data_quality_score !== undefined || dataQuality.score !== undefined
            ? toNumber(metadata.data_quality_score ?? dataQuality.score)
            : undefined;
        return {
          signal_id: signal.id,
          source_type: signal.source_type,
          source_label: sourceTypeLabel(signal.source_type),
          source_id: signal.source_id,
          loop_run_id: signal.loop_run_id || metadata.loop_run_id || paperTrading.loop_run_id,
          symbol: normalizeSymbol(signal.symbol),
          name: signal.name,
          signal_date: signal.signal_date,
          decision: signal.normalized_decision || signal.decision,
          decision_label: decisionLabel(signal.normalized_decision || signal.decision),
          command: command.command,
          command_label: command.command_label,
          score: toNumber(signal.confidence_score),
          risk_level: signal.risk_level,
          action: metadata.action,
          action_label: metadata.action_label,
          recommendation_tier: metadata.recommendation_tier,
          recommendation_tier_label: metadata.recommendation_tier_label,
          data_quality_bucket: metadata.data_quality_bucket || dataQuality.bucket || 'unknown',
          data_quality_score: dataQualityScore,
          status,
          status_label: statusLabel(status),
          paper_trading: paperTrading,
          outcome,
          entry_date: outcome?.entry_date || paperTrading.executed_at?.slice?.(0, 10),
          exit_date: outcome?.exit_date || paperTrading.closed_at?.slice?.(0, 10),
          entry_price: toNumber(
            outcome?.entry_price ?? paperTrading.execute_price ?? signal.current_price
          ),
          exit_price: outcome?.exit_price
            ? toNumber(outcome.exit_price)
            : toNumber(paperTrading.exit_price, 0) || undefined,
          latest_price: toNumber(
            outcome?.latest_price ?? paperTrading.latest_price ?? signal.current_price
          ),
          quantity: toNumber(outcome?.quantity ?? paperTrading.quantity),
          simulated_pnl: roundNumber(outcome?.total_pnl ?? paperTrading.realized_pnl ?? 0, 2),
          simulated_pnl_pct: roundNumber(
            outcome?.total_pnl_pct ?? paperTrading.realized_pnl_pct ?? 0,
            4
          ),
          realized_pnl: roundNumber(outcome?.realized_pnl ?? paperTrading.realized_pnl ?? 0, 2),
          unrealized_pnl: roundNumber(outcome?.unrealized_pnl ?? 0, 2),
          holding_days: toNumber(outcome?.holding_days ?? paperTrading.holding_days),
          exit_reason: outcome?.exit_reason || paperTrading.exit_reason,
          exit_reason_label: outcome?.exit_reason_label || paperTrading.exit_reason_label,
          forward_return: forward,
          rationale: signal.rationale,
          warnings: Array.isArray(metadata.warnings) ? metadata.warnings.slice(0, 3) : [],
          reasons: Array.isArray(metadata.reasons) ? metadata.reasons.slice(0, 3) : [],
          created_at: signal.created_at,
        };
      })
      .filter(
        item => !options.status || options.status === 'all' || item.status === options.status
      );

    const dailyMap = new Map<string, any[]>();
    for (const item of items) {
      if (!dailyMap.has(item.signal_date)) dailyMap.set(item.signal_date, []);
      dailyMap.get(item.signal_date)!.push(item);
    }
    const dailyGroups = [...dailyMap.entries()].map(([date, records]) => ({
      date,
      total: records.length,
      buy_count: records.filter(item => item.command === 'buy').length,
      sell_count: records.filter(item => item.command === 'sell').length,
      open_count: records.filter(item => item.status === 'open').length,
      closed_count: records.filter(item => item.status === 'closed').length,
      simulated_pnl: roundNumber(
        records.reduce((sum, item) => sum + toNumber(item.simulated_pnl), 0),
        2
      ),
      top_symbols: records.slice(0, 5).map(item => ({
        symbol: item.symbol,
        name: item.name,
        command: item.command_label,
        score: item.score,
        status: item.status_label,
      })),
    }));

    const closed = items.filter(item => item.status === 'closed');
    const open = items.filter(item => item.status === 'open');
    const buy = items.filter(item => item.command === 'buy');
    const sell = items.filter(item => item.command === 'sell');
    const wins = closed.filter(item => toNumber(item.simulated_pnl) > 0);

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio: modelToPlain(portfolio),
      filters: {
        start_date: startDate,
        end_date: getChinaToday(),
        lookback_days: lookbackDays,
        source_type: options.source_type || 'all',
        status: options.status || 'all',
        limit,
      },
      summary: {
        total_signals: items.length,
        buy_signals: buy.length,
        sell_signals: sell.length,
        open_count: open.length,
        closed_count: closed.length,
        watch_count: items.filter(item => item.status === 'watch').length,
        candidate_count: items.filter(item => item.status === 'candidate').length,
        total_simulated_pnl: roundNumber(
          items.reduce((sum, item) => sum + toNumber(item.simulated_pnl), 0),
          2
        ),
        avg_simulated_pnl_pct: closed.length
          ? roundNumber(
              closed.reduce((sum, item) => sum + toNumber(item.simulated_pnl_pct), 0) /
                closed.length,
              4
            )
          : 0,
        win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
      },
      daily_groups: dailyGroups,
      items,
    };
  }

  async getPortfolioFamilySummary(options: PaperTradingDashboardOptions = {}) {
    const where: any = {
      name: { [Op.in]: PAPER_PORTFOLIO_FAMILIES.map(item => item.name) },
    };
    if (options.user_id) where.user_id = options.user_id;

    const portfolios = await PaperTradingPortfolio.findAll({
      where,
      order: [['id', 'ASC']],
    });
    const latestByName = new Map<string, PaperTradingPortfolio>();
    for (const portfolio of portfolios) {
      latestByName.set(portfolio.name, portfolio);
    }

    const rows = await Promise.all(
      PAPER_PORTFOLIO_FAMILIES.map(async family => {
        const portfolio = latestByName.get(family.name);
        if (!portfolio) {
          return {
            ...family,
            portfolio_id: null,
            exists: false,
            initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
            total_value: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
            current_cash: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
            position_value: 0,
            total_pnl: 0,
            total_return_pct: 0,
            cash_pct: 100,
            exposure_pct: 0,
            open_position_count: 0,
            trade_count: 0,
            outcome_count: 0,
            closed_outcome_count: 0,
            open_outcome_count: 0,
            win_rate: 0,
            avg_closed_return_pct: 0,
            latest_trade_at: null,
            latest_intent_at: null,
            last_activity_at: null,
            run_status: 'not_created',
            run_status_label: '未初始化',
            empty_reason: buildFamilyDefaultReason(family),
            diagnostics: {
              is_initialized: false,
              has_positions: false,
              has_trades: false,
              has_order_intents: false,
              primary_blocker: null,
              latest_intent_reason: null,
              default_hint: buildFamilyDefaultReason(family),
            },
            recent_intent_summary: this.summarizeOrderIntents([]),
          };
        }

        const [positions, trades, outcomes, recentIntents] = await Promise.all([
          PaperTradingPosition.findAll({ where: { portfolio_id: portfolio.id }, raw: true }),
          PaperTradingTrade.findAll({ where: { portfolio_id: portfolio.id }, raw: true }),
          RecommendationTradeOutcome.findAll({
            where: { portfolio_id: portfolio.id },
            limit: 5000,
            raw: true,
          }) as any,
          PaperTradingOrderIntent.findAll({
            where: { portfolio_id: portfolio.id },
            order: [['created_at', 'DESC']],
            limit: 500,
            raw: true,
          }) as any,
        ]);
        const intentSummary = this.summarizeOrderIntents(recentIntents as any[]);
        const runStatus = buildFamilyRunStatus({
          exists: true,
          positions,
          trades,
          intentSummary,
        });
        const initialCapital = toNumber(
          portfolio.initial_capital,
          DEFAULT_AUTONOMOUS_INITIAL_CAPITAL
        );
        const totalValue = toNumber(portfolio.total_value, initialCapital);
        const currentCash = toNumber(portfolio.current_cash, initialCapital);
        const positionValue = positions.reduce(
          (sum: number, item: any) => sum + toNumber(item.market_value),
          0
        );
        const closed = (outcomes as any[]).filter((item: any) => item.trade_status === 'closed');
        const open = (outcomes as any[]).filter((item: any) => item.trade_status !== 'closed');
        const wins = closed.filter((item: any) => toNumber(item.total_pnl) > 0);
        const latestTradeAt = trades
          .map((trade: any) => String(trade.created_at || ''))
          .sort()
          .pop();
        const dominantIntentReason = intentSummary.top_reason_categories?.[0];
        const latestIntent = intentSummary.latest_intent;
        const emptyReason =
          positions.length > 0
            ? `当前持有 ${positions.length} 只股票，账户正常运行。`
            : trades.length > 0
            ? '账户有历史交易但当前空仓，可能已触发卖出、止盈/止损或等待下一轮信号。'
            : intentSummary.total > 0
            ? `账户已收到 ${intentSummary.total} 条订单意图但暂无成交，主要被「${
                dominantIntentReason?.label || '风控/交易纪律'
              }」拦截；最近原因：${latestIntent?.reason_text || '暂无明细'}。`
            : buildFamilyDefaultReason(family);

        return {
          ...family,
          portfolio_id: portfolio.id,
          exists: true,
          initial_capital: roundNumber(initialCapital, 2),
          total_value: roundNumber(totalValue, 2),
          current_cash: roundNumber(currentCash, 2),
          position_value: roundNumber(positionValue, 2),
          total_pnl: roundNumber(totalValue - initialCapital, 2),
          total_return_pct:
            initialCapital > 0
              ? roundNumber(((totalValue - initialCapital) / initialCapital) * 100, 4)
              : 0,
          cash_pct: totalValue > 0 ? roundNumber((currentCash / totalValue) * 100, 2) : 0,
          exposure_pct: totalValue > 0 ? roundNumber((positionValue / totalValue) * 100, 2) : 0,
          open_position_count: positions.length,
          trade_count: trades.length,
          outcome_count: (outcomes as any[]).length,
          closed_outcome_count: closed.length,
          open_outcome_count: open.length,
          win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
          avg_closed_return_pct: closed.length
            ? roundNumber(
                closed.reduce((sum: number, item: any) => sum + toNumber(item.total_pnl_pct), 0) /
                  closed.length,
                4
              )
            : 0,
          latest_trade_at: latestTradeAt || null,
          latest_intent_at: intentSummary.latest_intent_at,
          last_activity_at: latestTradeAt || intentSummary.latest_intent_at || portfolio.updated_at,
          run_status: runStatus.run_status,
          run_status_label: runStatus.run_status_label,
          empty_reason: emptyReason,
          diagnostics: {
            is_initialized: true,
            has_positions: positions.length > 0,
            has_trades: trades.length > 0,
            has_order_intents: intentSummary.total > 0,
            primary_blocker: dominantIntentReason || null,
            latest_intent_reason: latestIntent?.reason_text || null,
            default_hint: buildFamilyDefaultReason(family),
          },
          recent_intent_summary: intentSummary,
        };
      })
    );

    const activeRows = rows.filter(item => item.exists);
    const openPositionCount = rows.reduce(
      (sum, item) => sum + toNumber(item.open_position_count),
      0
    );
    const totalPositionValue = rows.reduce((sum, item) => sum + toNumber(item.position_value), 0);
    const totalPnl = rows.reduce((sum, item) => sum + toNumber(item.total_pnl), 0);
    const champion = [...activeRows].sort(
      (a, b) => toNumber(b.total_return_pct) - toNumber(a.total_return_pct)
    )[0];
    const mostActive = [...activeRows].sort(
      (a, b) => toNumber(b.open_position_count) - toNumber(a.open_position_count)
    )[0];

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      families: rows,
      summary: {
        family_count: rows.length,
        active_family_count: activeRows.length,
        open_position_count: openPositionCount,
        total_position_value: roundNumber(totalPositionValue, 2),
        total_pnl: roundNumber(totalPnl, 2),
        champion,
        most_active: mostActive,
        conclusion:
          openPositionCount > 0
            ? `当前共有 ${openPositionCount} 只模拟持仓，主要分布在 ${
                mostActive?.label || '独立账户'
              }。`
            : '当前所有模拟账户暂无持仓，等待下一轮自动扫描建仓。',
      },
    };
  }

  private async ensureAutonomousPortfolio(options: PaperTradingDashboardOptions) {
    const existing = await PaperTradingPortfolio.findOne({
      where: {
        name: AUTONOMOUS_PORTFOLIO_NAME,
        ...(options.user_id ? { user_id: options.user_id } : {}),
      },
      order: [['id', 'ASC']],
    });
    if (existing) return existing;

    return paperTradingAutomationService.ensurePortfolio({
      user_id: options.user_id,
      username: options.username,
      initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
      name: AUTONOMOUS_PORTFOLIO_NAME,
      force_new: true,
    });
  }

  private async ensurePortfolioFamilies(options: PaperTradingDashboardOptions) {
    await Promise.all(
      PAPER_PORTFOLIO_FAMILIES.map(family =>
        paperTradingAutomationService.ensurePortfolio({
          user_id: options.user_id,
          username: options.username,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          name: family.name,
          force_new: true,
        })
      )
    );
  }

  private summarizeOrderIntents(intents: any[]) {
    const summary = {
      total: intents.length,
      planned_count: 0,
      executed_count: 0,
      rejected_count: 0,
      skipped_count: 0,
      held_count: 0,
      latest_intent_at: null as string | null,
      latest_intent: null as any,
      top_statuses: [] as Array<{ status: string; label: string; count: number }>,
      top_reason_categories: [] as Array<{ category: string; label: string; count: number }>,
      recent_examples: [] as Array<Record<string, any>>,
    };
    const statusCounts = new Map<string, number>();
    const categoryCounts = new Map<string, number>();
    const sorted = [...intents].sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );

    for (const intent of sorted) {
      const status = String(intent.status || 'unknown');
      const category = String(intent.reason_category || 'unknown');
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      if (status === 'planned') summary.planned_count += 1;
      if (status === 'executed') summary.executed_count += 1;
      if (status === 'rejected') summary.rejected_count += 1;
      if (status === 'skipped') summary.skipped_count += 1;
      if (status === 'held') summary.held_count += 1;
    }

    const latest = sorted[0];
    if (latest) {
      summary.latest_intent_at = latest.created_at || null;
      summary.latest_intent = {
        id: latest.id,
        symbol: latest.symbol,
        name: latest.name,
        side: latest.side,
        status: latest.status,
        status_label: orderIntentStatusLabel(latest.status),
        reason_category: latest.reason_category,
        reason_label: orderIntentReasonLabel(latest.reason_category),
        reason_text: latest.reason_text,
        reference_price: latest.reference_price ? toNumber(latest.reference_price) : undefined,
        amount: latest.amount ? toNumber(latest.amount) : undefined,
        created_at: latest.created_at,
      };
    }

    summary.top_statuses = [...statusCounts.entries()]
      .map(([status, count]) => ({ status, label: orderIntentStatusLabel(status), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    summary.top_reason_categories = [...categoryCounts.entries()]
      .map(([category, count]) => ({ category, label: orderIntentReasonLabel(category), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    summary.recent_examples = sorted.slice(0, 5).map(intent => ({
      id: intent.id,
      symbol: intent.symbol,
      name: intent.name,
      side: intent.side,
      status: intent.status,
      status_label: orderIntentStatusLabel(intent.status),
      reason_category: intent.reason_category,
      reason_label: orderIntentReasonLabel(intent.reason_category),
      reason_text: intent.reason_text,
      reference_price: intent.reference_price ? toNumber(intent.reference_price) : undefined,
      amount: intent.amount ? toNumber(intent.amount) : undefined,
      created_at: intent.created_at,
    }));
    return summary;
  }

  private async safeSyncSnapshot(portfolio_id: number) {
    try {
      return await paperTradingAutomationService.syncLatestPricesAndSnapshot(portfolio_id);
    } catch (error: any) {
      logger.warn(`自主模拟盘快照刷新失败: ${error?.message || error}`);
      return null;
    }
  }

  private async getRecentSnapshots(portfolio_id: number) {
    const snapshots = await PaperTradingSnapshot.findAll({
      where: { portfolio_id },
      order: [['date', 'DESC']],
      limit: 260,
      raw: true,
    });
    return snapshots.reverse();
  }
}

export const paperTradingDashboardService = new PaperTradingDashboardService();
