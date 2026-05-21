import { Op } from 'sequelize';
import { QuantBacktestResult } from '../../models/QuantBacktestResult';
import { QuantBacktestTask } from '../../models/QuantBacktestTask';
import { QuantFusionAudit } from '../../models/QuantFusionAudit';
import { QuantSignal } from '../../models/QuantSignal';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { ScheduledTask } from '../../models/ScheduledTask';
import { TaskExecutionLog } from '../../models/TaskExecutionLog';
import { quantStrategyExperimentService } from './QuantStrategyExperimentService';
import { quantStrategyParamVersionService } from './QuantStrategyParamVersionService';
import { quantDataFreshnessService } from './QuantDataFreshnessService';
import { quantRuntimeHealthService } from './QuantRuntimeHealthService';
import { realtimeQuoteService } from '../../data/services/RealtimeQuoteService';
import {
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  PARAM_EXPERIMENT_PORTFOLIO_NAME,
  PAPER_PORTFOLIO_FAMILIES,
} from '../../services/PaperTradingDashboardService';
import { recommendationTradeOutcomeService } from '../../services/RecommendationTradeOutcomeService';
import { strategyRegistry } from '../engine/StrategyRegistry';

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const parsed = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(parsed * base) / base;
}

function modelToPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function dateDaysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function sourceFamily(outcome: any): {
  key: 'pure_quant' | 'agent_fusion' | 'agent_only' | 'ai_daily' | 'other';
  label: string;
  description: string;
} {
  const metadata = asPlainObject(outcome.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const strategyVariant = asPlainObject(signalMetadata.strategy_variant);
  const sourceType = String(outcome.source_type || '').toLowerCase();
  const isQuantAgent =
    Boolean(signalMetadata.quant_fusion_audit_id) ||
    Boolean(signalMetadata.quant_framework_signal) ||
    strategyVariant.source === 'quant_framework' ||
    Boolean(signalMetadata.quant_data_quality_score) ||
    Boolean(signalMetadata.strategy_key);

  if (sourceType === 'quant_recommendation') {
    return {
      key: 'pure_quant',
      label: '纯量化指标',
      description: '由量化指标/多策略共识直接归档并进入模拟盘的小仓验证。',
    };
  }
  if (sourceType === 'tradingagents' && isQuantAgent) {
    return {
      key: 'agent_fusion',
      label: '量化 + Agent融合',
      description: '量化候选先筛选，再由 TradingAgents 复核后进入模拟盘。',
    };
  }
  if (sourceType === 'tradingagents') {
    return {
      key: 'agent_only',
      label: 'Agent独立研判',
      description: 'TradingAgents 独立输出的深度投研信号。',
    };
  }
  if (sourceType === 'daily_screener') {
    return {
      key: 'ai_daily',
      label: 'AI每日优选',
      description: 'AI每日优选/收藏池分析产生的候选。',
    };
  }
  return {
    key: 'other',
    label: '其他信号',
    description: '其他来源进入模拟盘的信号。',
  };
}

function summarizeOutcomeGroup(key: string, label: string, description: string, rows: any[]) {
  const closed = rows.filter(item => item.trade_status === 'closed');
  const open = rows.filter(item => item.trade_status !== 'closed');
  const wins = closed.filter(
    item => toNumber(item.total_pnl) > 0 || toNumber(item.realized_pnl) > 0
  );
  const excessWins = closed.filter(item => toNumber(item.excess_return_pct) > 0);
  const best = [...rows].sort((a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct))[0];
  const worst = [...rows].sort((a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct))[0];
  const totalPnl = rows.reduce((sum, item) => sum + toNumber(item.total_pnl), 0);
  return {
    key,
    label,
    description,
    total_count: rows.length,
    open_count: open.length,
    closed_count: closed.length,
    win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
    excess_win_rate: closed.length ? roundNumber((excessWins.length / closed.length) * 100, 2) : 0,
    avg_return_pct: closed.length
      ? roundNumber(
          closed.reduce((sum, item) => sum + toNumber(item.total_pnl_pct), 0) / closed.length,
          4
        )
      : 0,
    avg_excess_return_pct: closed.length
      ? roundNumber(
          closed.reduce((sum, item) => sum + toNumber(item.excess_return_pct), 0) / closed.length,
          4
        )
      : 0,
    total_pnl: roundNumber(totalPnl, 2),
    best_symbol: best?.symbol,
    best_name: best?.name,
    best_return_pct: best ? roundNumber(best.total_pnl_pct, 4) : undefined,
    worst_symbol: worst?.symbol,
    worst_name: worst?.name,
    worst_return_pct: worst ? roundNumber(worst.total_pnl_pct, 4) : undefined,
  };
}

function normalizeStringArray(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map(item => String(item || '').trim()).filter(item => item && item !== 'unknown')
    ),
  ];
}

function paramVersionKeysFromOutcome(outcome: any): string[] {
  const metadata = asPlainObject(outcome.metadata);
  const strategyVariant = asPlainObject(metadata.strategy_variant);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const signalVariant = asPlainObject(signalMetadata.strategy_variant);
  const signalFactors = asPlainObject(signalMetadata.factors);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const paperVariant = asPlainObject(paperTrading.strategy_variant);
  const candidates = [
    ...normalizeStringArray(strategyVariant.param_version_keys),
    ...normalizeStringArray(signalVariant.param_version_keys),
    ...normalizeStringArray(signalFactors.param_version_keys),
    ...normalizeStringArray(paperVariant.param_version_keys),
    strategyVariant.param_version_key,
    signalVariant.param_version_key,
    signalMetadata.param_version_key,
    signalFactors.param_version_key,
    paperVariant.param_version_key,
  ]
    .map(item => String(item || '').trim())
    .filter(item => item && item !== 'unknown');

  return [...new Set(candidates)];
}

function strategyKeysFromOutcomeMetadata(outcome: any): string[] {
  const metadata = asPlainObject(outcome.metadata);
  const strategyVariant = asPlainObject(metadata.strategy_variant);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const signalVariant = asPlainObject(signalMetadata.strategy_variant);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const paperVariant = asPlainObject(paperTrading.strategy_variant);
  return [
    ...new Set(
      [
        metadata.strategy_key,
        strategyVariant.strategy_key,
        signalMetadata.strategy_key,
        signalVariant.strategy_key,
        paperTrading.strategy_key,
        paperVariant.strategy_key,
        ...normalizeStringArray(strategyVariant.strategy_keys),
        ...normalizeStringArray(signalVariant.strategy_keys),
        ...normalizeStringArray(paperVariant.strategy_keys),
      ]
        .map(item => String(item || '').trim())
        .filter(Boolean)
    ),
  ];
}

function summarizeParamTradeAttributionRow(versionKey: string, rows: any[]) {
  const closed = rows.filter(item => item.trade_status === 'closed');
  const open = rows.filter(item => item.trade_status !== 'closed');
  const wins = closed.filter(item => toNumber(item.total_pnl) > 0);
  const excessWins = closed.filter(item => toNumber(item.excess_return_pct) > 0);
  const avgReturn = closed.length
    ? closed.reduce((sum, item) => sum + toNumber(item.total_pnl_pct), 0) / closed.length
    : 0;
  const avgExcess = closed.length
    ? closed.reduce((sum, item) => sum + toNumber(item.excess_return_pct), 0) / closed.length
    : 0;
  const totalPnl = rows.reduce((sum, item) => sum + toNumber(item.total_pnl), 0);
  const best = [...rows].sort((a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct))[0];
  const worst = [...rows].sort((a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct))[0];
  const strategyKeys = [
    ...new Set(rows.flatMap(item => strategyKeysFromOutcomeMetadata(item)).filter(Boolean)),
  ];
  const rankScore = roundNumber(
    avgExcess * 1.25 +
      (closed.length ? (wins.length / closed.length) * 100 - 50 : 0) * 0.08 +
      Math.min(8, closed.length * 1.2),
    4
  );

  return {
    param_version_key: versionKey,
    strategy_keys: strategyKeys,
    total_count: rows.length,
    open_count: open.length,
    closed_count: closed.length,
    win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
    excess_win_rate: closed.length ? roundNumber((excessWins.length / closed.length) * 100, 2) : 0,
    avg_return_pct: roundNumber(avgReturn, 4),
    avg_excess_return_pct: roundNumber(avgExcess, 4),
    total_pnl: roundNumber(totalPnl, 2),
    rank_score: rankScore,
    best_symbol: best?.symbol,
    best_name: best?.name,
    best_return_pct: best ? roundNumber(best.total_pnl_pct, 4) : undefined,
    worst_symbol: worst?.symbol,
    worst_name: worst?.name,
    worst_return_pct: worst ? roundNumber(worst.total_pnl_pct, 4) : undefined,
  };
}

export class QuantPerformanceDashboardService {
  getIndicatorCatalog() {
    const indicatorCatalog = [
      {
        key: 'trend_ma',
        name: '均线趋势',
        indicators: ['SMA5/10/20/60', 'EMA', '价格-均线偏离', '均线斜率'],
        purpose: '判断右侧趋势结构是否成立，避免在下降趋势里盲目低吸。',
        strategies: ['ma_trend', 'multi_factor_ranking', 'low_volatility_quality'],
      },
      {
        key: 'macd',
        name: 'MACD 动能',
        indicators: ['DIF', 'DEA', 'Histogram', '柱状图改善'],
        purpose: '确认中短期趋势启动和动能延续。',
        strategies: ['macd_trend'],
      },
      {
        key: 'relative_strength',
        name: '相对强弱/动量',
        indicators: ['5/10/20/60日收益', '相对强弱排序', '动量过热惩罚'],
        purpose: '从全市场自动发现主线强势股，同时过滤短期极端追高。',
        strategies: ['relative_strength_momentum', 'multi_factor_ranking'],
      },
      {
        key: 'mean_reversion',
        name: '均值回归',
        indicators: ['RSI', 'BOLL中轨/上下轨', '距离下轨', '短线反弹'],
        purpose: '识别强势股回调或震荡市低吸修复机会。',
        strategies: ['rsi_reversion', 'bollinger_reversion'],
      },
      {
        key: 'breakout_volatility',
        name: '突破与波动保护',
        indicators: ['N日新高', 'ATR', 'ATR止损', '突破前涨幅'],
        purpose: '捕捉启动型突破，并用 ATR 保护回撤。',
        strategies: ['breakout_atr'],
      },
      {
        key: 'money_flow',
        name: '资金流/量价确认',
        indicators: ['成交量均量比', '换手率', 'OBV', 'MFI', '成交额'],
        purpose: '确认上涨是否有资金承接，过滤无量上涨和情绪化放量。',
        strategies: ['volume_price_confirmation', 'multi_factor_ranking'],
      },
      {
        key: 'trend_strength',
        name: '趋势强度',
        indicators: ['ADX', '+DI', '-DI', 'DMI方向'],
        purpose: '识别趋势强度和方向，区分健康上行与下行趋势加速。',
        strategies: ['volume_price_confirmation', 'multi_factor_ranking'],
      },
      {
        key: 'oscillator',
        name: '摆动/过热',
        indicators: ['CCI', 'KDJ/Stochastic', 'MFI过热', 'RSI超买超卖'],
        purpose: '约束追高和低吸时点，避免在过热区扩大仓位。',
        strategies: ['multi_factor_ranking', 'rsi_reversion'],
      },
      {
        key: 'risk_quality',
        name: '风险质量',
        indicators: ['20日波动率', '60日最大回撤', '夏普代理', '流动性门槛'],
        purpose: '筛掉持仓体验差、回撤过深或流动性不足的标的。',
        strategies: ['low_volatility_quality', 'multi_factor_ranking'],
      },
      {
        key: 'valuation',
        name: '估值压力',
        indicators: ['PE(TTM/动态)', 'PB', '总市值', 'ST/退市过滤'],
        purpose: '为多因子策略加入基本估值压力约束，避免极端估值拥挤。',
        strategies: ['multi_factor_ranking', 'low_volatility_quality'],
      },
    ];

    const strategyDefinitions = strategyRegistry.list().map(strategy => ({
      ...strategy,
      indicator_groups: indicatorCatalog
        .filter(group => group.strategies.includes(strategy.strategy_key))
        .map(group => group.key),
    }));

    return {
      indicator_count: indicatorCatalog.reduce((sum, group) => sum + group.indicators.length, 0),
      group_count: indicatorCatalog.length,
      strategy_count: strategyDefinitions.length,
      groups: indicatorCatalog,
      strategies: strategyDefinitions,
    };
  }

  async getDashboard(options: { user_id?: number; username?: string } = {}) {
    const [
      latestBacktests,
      signalSummary,
      scheduleSummary,
      outcomeComparison,
      dataQuality,
      strategyExperiments,
      experimentParamSuggestions,
      paramValidation,
      portfolioFamilies,
      paramTradeAttribution,
      dataFreshness,
      runtimeHealth,
      runtimeDiscipline,
    ] = await Promise.all([
      this.getLatestBacktests(),
      this.getSignalSummary(),
      this.getScheduleSummary(),
      this.getOutcomeComparison(options),
      this.getDataQualityCenter(),
      quantStrategyExperimentService.getExperimentSummary({ limit: 50 }),
      quantStrategyExperimentService.getParamsByStrategySuggestion({ limit: 300 }),
      quantStrategyParamVersionService.getDashboard({ limit: 1200 }),
      this.getPortfolioFamilyComparison(options),
      this.getParamExperimentTradeAttribution(options),
      quantDataFreshnessService.getSnapshot(),
      quantRuntimeHealthService.getHealth(options),
      this.getRuntimeDisciplineSummary(),
    ]);

    return {
      generated_at: new Date().toISOString(),
      indicator_catalog: this.getIndicatorCatalog(),
      latest_backtests: latestBacktests,
      signal_summary: signalSummary,
      schedule_summary: scheduleSummary,
      outcome_comparison: outcomeComparison,
      data_quality_center: dataQuality,
      data_freshness: dataFreshness,
      runtime_health: runtimeHealth,
      runtime_discipline: runtimeDiscipline,
      strategy_experiments: strategyExperiments,
      experiment_param_suggestions: experimentParamSuggestions,
      param_validation_dashboard: {
        ...paramValidation,
        trade_attribution: paramTradeAttribution,
      },
      portfolio_family_comparison: portfolioFamilies,
      readiness: this.buildReadiness(
        signalSummary,
        latestBacktests,
        scheduleSummary,
        dataQuality,
        dataFreshness,
        runtimeHealth
      ),
    };
  }

  private async getLatestBacktests() {
    const results = await QuantBacktestResult.findAll({
      order: [['created_at', 'DESC']],
      limit: 500,
    });
    const taskIds = [...new Set(results.map(item => Number(item.task_id)).filter(Boolean))];
    const tasks = taskIds.length
      ? await QuantBacktestTask.findAll({ where: { id: { [Op.in]: taskIds } } })
      : [];
    const taskById = new Map(tasks.map(task => [Number(task.id), task]));
    const latestByStrategy = new Map<string, any>();
    for (const result of results) {
      const key = result.strategy_key;
      if (latestByStrategy.has(key)) continue;
      const task = taskById.get(Number(result.task_id));
      latestByStrategy.set(key, {
        strategy_key: result.strategy_key,
        strategy_name: result.strategy_name,
        task_id: result.task_id,
        task_name: task?.task_name,
        start_date: task?.start_date,
        end_date: task?.end_date,
        total_return_pct: roundNumber(result.total_return_pct, 4),
        benchmark_return_pct: roundNumber(result.benchmark_return_pct, 4),
        excess_return_pct: roundNumber(result.excess_return_pct, 4),
        annual_return_pct: roundNumber(result.annual_return_pct, 4),
        max_drawdown_pct: roundNumber(result.max_drawdown_pct, 4),
        sharpe_ratio: roundNumber(result.sharpe_ratio, 4),
        win_rate: roundNumber(result.win_rate, 4),
        profit_factor: roundNumber(result.profit_factor, 4),
        trade_count: result.trade_count,
        avg_holding_days: roundNumber(result.avg_holding_days, 2),
        created_at: result.created_at,
      });
    }

    const leaderboard = [...latestByStrategy.values()].sort(
      (a, b) => toNumber(b.excess_return_pct) - toNumber(a.excess_return_pct)
    );
    const best = leaderboard[0] || null;
    const latestTask = await QuantBacktestTask.findOne({
      where: { status: 'COMPLETED' },
      order: [['created_at', 'DESC']],
    });
    const completedTasks = await QuantBacktestTask.findAll({
      where: { status: 'COMPLETED' },
      order: [['created_at', 'DESC']],
      limit: 200,
    });
    const finishedAtValues = results
      .map(item => new Date(item.created_at as any).getTime())
      .filter(item => Number.isFinite(item));
    const resultCount = results.length;
    const tradeCount = results.reduce((sum, item) => sum + toNumber(item.trade_count), 0);
    const avgTotalReturn = resultCount
      ? results.reduce((sum, item) => sum + toNumber(item.total_return_pct), 0) / resultCount
      : 0;
    const avgExcessReturn = resultCount
      ? results.reduce((sum, item) => sum + toNumber(item.excess_return_pct), 0) / resultCount
      : 0;
    const profitableCount = results.filter(item => toNumber(item.total_return_pct) > 0).length;
    const topResults = [...results]
      .sort((a, b) => toNumber(b.total_return_pct) - toNumber(a.total_return_pct))
      .slice(0, 10)
      .map(result => ({
        strategy_key: result.strategy_key,
        strategy_name: result.strategy_name,
        task_id: result.task_id,
        task_name: taskById.get(Number(result.task_id))?.task_name,
        total_return_pct: roundNumber(result.total_return_pct, 4),
        excess_return_pct: roundNumber(result.excess_return_pct, 4),
        max_drawdown_pct: roundNumber(result.max_drawdown_pct, 4),
        sharpe_ratio: roundNumber(result.sharpe_ratio, 4),
        trade_count: result.trade_count,
        created_at: result.created_at,
      }));
    return {
      latest_task: latestTask ? modelToPlain(latestTask) : null,
      best_strategy: best,
      strategy_count: leaderboard.length,
      leaderboard,
      overview: {
        completed_task_count: completedTasks.length,
        result_count: resultCount,
        trade_count: tradeCount,
        avg_total_return_pct: roundNumber(avgTotalReturn, 4),
        avg_excess_return_pct: roundNumber(avgExcessReturn, 4),
        positive_result_count: profitableCount,
        positive_result_rate: resultCount
          ? roundNumber((profitableCount / resultCount) * 100, 2)
          : 0,
        best_total_return_pct: topResults[0]?.total_return_pct ?? 0,
        best_strategy_key: topResults[0]?.strategy_key || null,
        latest_result_at: finishedAtValues.length
          ? new Date(Math.max(...finishedAtValues)).toISOString()
          : null,
        latest_task_range: latestTask
          ? `${latestTask.start_date || '-'} ~ ${latestTask.end_date || '-'}`
          : null,
      },
      top_results: topResults,
    };
  }

  private async getSignalSummary() {
    const latestQuantDate = (
      await QuantSignal.findOne({
        order: [
          ['trade_date', 'DESC'],
          ['score', 'DESC'],
        ],
      })
    )?.trade_date;
    const latestFusionDate = (
      await QuantFusionAudit.findOne({
        order: [
          ['signal_date', 'DESC'],
          ['final_score', 'DESC'],
        ],
      })
    )?.signal_date;

    const [quantSignals, fusionAudits] = await Promise.all([
      latestQuantDate
        ? QuantSignal.findAll({ where: { trade_date: latestQuantDate }, limit: 5000 })
        : Promise.resolve([]),
      latestFusionDate
        ? QuantFusionAudit.findAll({ where: { signal_date: latestFusionDate }, limit: 5000 })
        : Promise.resolve([]),
    ]);

    return {
      latest_quant_trade_date: latestQuantDate || null,
      latest_fusion_signal_date: latestFusionDate || null,
      quant_signal_count: quantSignals.length,
      quant_buy_count: quantSignals.filter(item => item.signal === 'buy').length,
      quant_watch_count: quantSignals.filter(item => item.signal === 'watch').length,
      quant_avg_score: roundNumber(
        quantSignals.reduce((sum, item) => sum + toNumber(item.score), 0) /
          Math.max(quantSignals.length, 1),
        2
      ),
      fusion_count: fusionAudits.length,
      fusion_buy_count: fusionAudits.filter(item => item.final_decision === 'buy').length,
      fusion_watch_count: fusionAudits.filter(item => item.final_decision === 'watch').length,
      fusion_avg_score: roundNumber(
        fusionAudits.reduce((sum, item) => sum + toNumber(item.final_score), 0) /
          Math.max(fusionAudits.length, 1),
        2
      ),
    };
  }

  private async getScheduleSummary() {
    const tasks = await ScheduledTask.findAll({
      where: {
        type: { [Op.in]: ['QUANT_DAILY_PIPELINE', 'QUANT_OPEN_WATCHDOG', 'REALTIME_QUOTE_SYNC'] },
      },
      order: [['cron_expression', 'ASC']],
    });
    return {
      quant_pipeline_task_count: tasks.filter(task => task.type === 'QUANT_DAILY_PIPELINE').length,
      watchdog_task_count: tasks.filter(task => task.type === 'QUANT_OPEN_WATCHDOG').length,
      quote_sync_task_count: tasks.filter(task => task.type === 'REALTIME_QUOTE_SYNC').length,
      tasks: await Promise.all(
        tasks.map(async task => {
          const latestLog = await TaskExecutionLog.findOne({
            where: { task_id: task.id },
            order: [['started_at', 'DESC']],
          });
          return {
            id: task.id,
            name: task.name,
            type: task.type,
            cron_expression: task.cron_expression,
            is_active: task.is_active,
            last_run_at: task.last_run_at,
            last_run_status: task.last_run_status,
            latest_log: latestLog
              ? {
                  id: latestLog.id,
                  status: latestLog.status,
                  started_at: latestLog.started_at,
                  completed_at: latestLog.completed_at,
                  total_items: latestLog.total_items,
                  completed_items: latestLog.completed_items,
                  failed_items: latestLog.failed_items,
                  error_message: latestLog.error_message,
                }
              : null,
            parameters: {
              target_task_name: task.parameters?.target_task_name,
              expected_after_time: task.parameters?.expected_after_time,
              latest_allowed_minutes: task.parameters?.latest_allowed_minutes,
              min_quant_signals: task.parameters?.min_quant_signals,
              min_archived_signals: task.parameters?.min_archived_signals,
              freshness_max_minutes: task.parameters?.freshness_max_minutes,
              universe: task.parameters?.universe,
              limit: task.parameters?.limit,
              source: task.parameters?.source,
              batch_size: task.parameters?.batch_size,
              factor_sync_limit: task.parameters?.factor_sync_limit,
              quote_sync_limit: task.parameters?.quote_sync_limit,
              realtime_quote_source: task.parameters?.realtime_quote_source,
              strategy_keys: task.parameters?.strategy_keys,
              agent_session: task.parameters?.agent_session,
              submit_agent_analysis: task.parameters?.submit_agent_analysis,
              run_paper_trading: task.parameters?.run_paper_trading,
              paper_trade_limit: task.parameters?.paper_trade_limit,
              default_position_pct: task.parameters?.default_position_pct,
              max_position_pct: task.parameters?.max_position_pct,
            },
          };
        })
      ),
    };
  }

  private async getRuntimeDisciplineSummary() {
    const logs = await TaskExecutionLog.findAll({
      where: {
        started_at: { [Op.gte]: dateDaysAgo(14) },
      },
      order: [['started_at', 'DESC']],
      limit: 300,
    }).catch(() => [] as TaskExecutionLog[]);

    const quantLogs = logs
      .map(log => {
        const summary = asPlainObject((log as any).result_summary);
        return { log, summary };
      })
      .filter(item => item.summary.scenario === 'quant_daily_pipeline');
    const blocked = quantLogs.filter(item => Boolean(item.summary.runtime_risk_blocked));
    const completed = quantLogs.filter(item => item.log.status === 'COMPLETED');
    const latest = quantLogs[0] || null;
    const latestBlocked = blocked[0] || null;
    const reasonCounts = blocked.reduce<Record<string, number>>((acc, item) => {
      const reason = String(
        item.summary.runtime_block_reason ||
          item.summary.runtime_health?.conclusion ||
          item.summary.message ||
          '运行时风险阻断'
      ).slice(0, 120);
      acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {});

    const topReasons = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    const mapRecord = (item: { log: TaskExecutionLog; summary: Record<string, any> }) => ({
      log_id: item.log.id,
      task_id: item.log.task_id,
      task_name: item.log.task_name,
      status: item.log.status,
      started_at: item.log.started_at,
      completed_at: item.log.completed_at,
      runtime_risk_blocked: Boolean(item.summary.runtime_risk_blocked),
      runtime_block_reason: item.summary.runtime_block_reason || null,
      runtime_health: item.summary.runtime_health || null,
      trade_date: item.summary.trade_date,
      scanned_stocks: item.summary.scanned_stocks,
      signal_count: item.summary.signal_count,
      archived_signal_count: item.summary.archived_signal_count,
      agent_submitted: item.summary.agent_submitted,
      paper_executed: item.summary.paper_executed,
      paper_planned: item.summary.paper_planned,
      paper_skipped: item.summary.paper_skipped,
      message: item.summary.message,
    });

    return {
      generated_at: new Date().toISOString(),
      window_days: 14,
      summary: {
        quant_run_count: quantLogs.length,
        completed_run_count: completed.length,
        blocked_count: blocked.length,
        blocked_rate_pct: roundNumber((blocked.length / Math.max(quantLogs.length, 1)) * 100, 2),
        latest_blocked_at: latestBlocked?.log.started_at || null,
        latest_run_at: latest?.log.started_at || null,
        latest_run_blocked: Boolean(latest?.summary.runtime_risk_blocked),
        conclusion:
          blocked.length > 0
            ? `近 14 天量化运行 ${quantLogs.length} 次，其中 ${blocked.length} 次因运行时风险只观察不买入。`
            : quantLogs.length > 0
            ? `近 14 天量化运行 ${quantLogs.length} 次，暂无运行时风险阻断买入。`
            : '近 14 天暂无量化任务执行摘要，等待下一次定时任务沉淀。',
      },
      top_reasons: topReasons,
      latest: latest ? mapRecord(latest) : null,
      latest_blocked: latestBlocked ? mapRecord(latestBlocked) : null,
      recent_runs: quantLogs.slice(0, 8).map(mapRecord),
    };
  }

  private async getDataQualityCenter() {
    const quotePersistence = await realtimeQuoteService.getPersistenceSummary();
    const latestTask = await QuantBacktestTask.findOne({
      where: { status: 'COMPLETED' },
      order: [['created_at', 'DESC']],
    });
    const latestResults = latestTask
      ? await QuantBacktestResult.findAll({
          where: { task_id: latestTask.id },
          order: [['excess_return_pct', 'DESC']],
          limit: 20,
        })
      : [];
    const executionDiagnostics = latestResults
      .map(result => ({
        strategy_key: result.strategy_key,
        strategy_name: result.strategy_name,
        execution_diagnostics: asPlainObject(result.metrics_json).execution_diagnostics,
      }))
      .filter(item => item.execution_diagnostics);
    const warningCount = executionDiagnostics.reduce((sum, item) => {
      const diagnostics = item.execution_diagnostics || {};
      return (
        sum +
        toNumber(diagnostics.blocked_buy_count) +
        toNumber(diagnostics.blocked_sell_count) +
        toNumber(diagnostics.suspended_bar_count)
      );
    }, 0);
    return {
      quote_persistence: quotePersistence,
      latest_backtest_task_id: latestTask?.id || null,
      latest_backtest_task_name: latestTask?.task_name || null,
      execution_diagnostics: executionDiagnostics,
      summary: {
        realtime_persisted: Boolean(quotePersistence.persisted),
        realtime_fresh: Boolean(quotePersistence.is_fresh),
        diagnostics_strategy_count: executionDiagnostics.length,
        execution_warning_count: warningCount,
      },
    };
  }

  private async getOutcomeComparison(options: { user_id?: number; username?: string }) {
    try {
      const dashboard = await recommendationTradeOutcomeService.getDashboard({
        user_id: options.user_id,
        username: options.username,
        portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
        initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
        include_open: true,
        limit: 5000,
      });
      const outcomes = (dashboard.outcomes || []).map(item =>
        modelToPlain<RecommendationTradeOutcome>(item)
      );
      const grouped = new Map<string, { label: string; description: string; rows: any[] }>();
      for (const outcome of outcomes) {
        const family = sourceFamily(outcome);
        if (!grouped.has(family.key)) {
          grouped.set(family.key, {
            label: family.label,
            description: family.description,
            rows: [],
          });
        }
        grouped.get(family.key)!.rows.push(outcome);
      }
      const families = [...grouped.entries()].map(([key, value]) =>
        summarizeOutcomeGroup(key, value.label, value.description, value.rows)
      );
      const ensureKeys = [
        sourceFamily({ source_type: 'quant_recommendation', metadata: {} }),
        {
          key: 'agent_fusion' as const,
          label: '量化 + Agent融合',
          description: '量化候选先筛选，再由 TradingAgents 复核后进入模拟盘。',
        },
      ];
      for (const family of ensureKeys) {
        if (!families.some(item => item.key === family.key)) {
          families.push(summarizeOutcomeGroup(family.key, family.label, family.description, []));
        }
      }
      return {
        portfolio_id: dashboard.portfolio_id,
        summary: dashboard.summary,
        by_source_type: dashboard.groups.by_source_type,
        by_strategy_key: dashboard.groups.by_strategy_key.slice(0, 12),
        families: families.sort(
          (a, b) => b.total_count - a.total_count || b.total_pnl - a.total_pnl
        ),
      };
    } catch (error: any) {
      return {
        error: error?.message || String(error),
        summary: null,
        by_source_type: [],
        by_strategy_key: [],
        families: [],
      };
    }
  }

  private async getPortfolioFamilyComparison(options: { user_id?: number; username?: string }) {
    try {
      const userWhere = options.user_id ? { user_id: options.user_id } : {};
      const portfolios = await PaperTradingPortfolio.findAll({
        where: {
          name: { [Op.in]: PAPER_PORTFOLIO_FAMILIES.map(item => item.name) },
          ...userWhere,
        },
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
              open_position_count: 0,
              trade_count: 0,
              outcome_count: 0,
              closed_outcome_count: 0,
              win_rate: 0,
              avg_closed_return_pct: 0,
            };
          }
          const [positions, trades, outcomes] = await Promise.all([
            PaperTradingPosition.findAll({ where: { portfolio_id: portfolio.id }, raw: true }),
            PaperTradingTrade.findAll({ where: { portfolio_id: portfolio.id }, raw: true }),
            RecommendationTradeOutcome.findAll({
              where: { portfolio_id: portfolio.id },
              limit: 2000,
              raw: true,
            }) as any,
          ]);
          const initialCapital = toNumber(
            portfolio.initial_capital,
            DEFAULT_AUTONOMOUS_INITIAL_CAPITAL
          );
          const totalValue = toNumber(portfolio.total_value, initialCapital);
          const positionValue = positions.reduce(
            (sum: number, item: any) => sum + toNumber(item.market_value),
            0
          );
          const closed = outcomes.filter((item: any) => item.trade_status === 'closed');
          const wins = closed.filter((item: any) => toNumber(item.total_pnl) > 0);
          return {
            ...family,
            portfolio_id: portfolio.id,
            exists: true,
            initial_capital: roundNumber(initialCapital, 2),
            total_value: roundNumber(totalValue, 2),
            current_cash: roundNumber(portfolio.current_cash, 2),
            position_value: roundNumber(positionValue, 2),
            total_pnl: roundNumber(totalValue - initialCapital, 2),
            total_return_pct:
              initialCapital > 0
                ? roundNumber(((totalValue - initialCapital) / initialCapital) * 100, 4)
                : 0,
            open_position_count: positions.length,
            trade_count: trades.length,
            outcome_count: outcomes.length,
            closed_outcome_count: closed.length,
            win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
            avg_closed_return_pct: closed.length
              ? roundNumber(
                  closed.reduce((sum: number, item: any) => sum + toNumber(item.total_pnl_pct), 0) /
                    closed.length,
                  4
                )
              : 0,
          };
        })
      );
      const champion = [...rows].sort(
        (a, b) => toNumber(b.total_return_pct) - toNumber(a.total_return_pct)
      )[0];
      return {
        generated_at: new Date().toISOString(),
        families: rows,
        summary: {
          family_count: rows.length,
          active_family_count: rows.filter(item => item.exists).length,
          champion,
          conclusion: champion?.exists
            ? `当前模拟账户冠军为 ${champion.label}，总收益 ${champion.total_return_pct}%。`
            : '独立模拟账户已定义，等待下一次量化/Agent 扫描自动建仓后沉淀收益。',
        },
      };
    } catch (error: any) {
      return {
        error: error?.message || String(error),
        families: [],
        summary: null,
      };
    }
  }

  private async getParamExperimentTradeAttribution(options: {
    user_id?: number;
    username?: string;
  }) {
    try {
      const userWhere = options.user_id ? { user_id: options.user_id } : {};
      const portfolios = await PaperTradingPortfolio.findAll({
        where: {
          name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
          ...userWhere,
        },
        order: [['id', 'DESC']],
        limit: 5,
      });
      const portfolioIds = portfolios.map(item => Number(item.id)).filter(Boolean);
      if (!portfolioIds.length) {
        return {
          generated_at: new Date().toISOString(),
          portfolio_name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
          portfolio_ids: [],
          rows: [],
          summary: {
            portfolio_count: 0,
            attributed_version_count: 0,
            outcome_count: 0,
            closed_count: 0,
            conclusion: '参数实验盘尚未建仓，下一次量化扫描会用小仓位承接候选参数验证。',
          },
        };
      }

      const outcomes = (await RecommendationTradeOutcome.findAll({
        where: { portfolio_id: { [Op.in]: portfolioIds } },
        order: [
          ['entry_date', 'DESC'],
          ['id', 'DESC'],
        ],
        limit: 3000,
        raw: true,
      })) as any[];
      const grouped = new Map<string, any[]>();
      for (const outcome of outcomes) {
        const keys = paramVersionKeysFromOutcome(outcome);
        for (const key of keys.length ? keys : ['unknown']) {
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key)!.push(outcome);
        }
      }
      const rows = [...grouped.entries()]
        .map(([key, items]) => summarizeParamTradeAttributionRow(key, items))
        .sort((a, b) => {
          if (b.closed_count !== a.closed_count) return b.closed_count - a.closed_count;
          return toNumber(b.rank_score) - toNumber(a.rank_score);
        });
      const attributedRows = rows.filter(item => item.param_version_key !== 'unknown');
      const champion =
        attributedRows.find(item => item.closed_count > 0) || attributedRows[0] || null;
      const closedCount = outcomes.filter(item => item.trade_status === 'closed').length;

      return {
        generated_at: new Date().toISOString(),
        portfolio_name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
        portfolio_ids: portfolioIds,
        rows,
        summary: {
          portfolio_count: portfolioIds.length,
          attributed_version_count: attributedRows.length,
          outcome_count: outcomes.length,
          closed_count: closedCount,
          champion,
          conclusion: champion
            ? `参数实验盘当前领先版本为 ${champion.param_version_key}，交易均超额 ${champion.avg_excess_return_pct}%（闭环 ${champion.closed_count} 笔）。`
            : outcomes.length
            ? '参数实验盘已有交易，但暂未识别到参数版本键；后续新信号会自动补齐归因。'
            : '参数实验盘已存在，等待候选参数小仓交易沉淀收益。',
        },
      };
    } catch (error: any) {
      return {
        error: error?.message || String(error),
        portfolio_name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
        portfolio_ids: [],
        rows: [],
        summary: {
          portfolio_count: 0,
          attributed_version_count: 0,
          outcome_count: 0,
          closed_count: 0,
          conclusion: '参数实验盘交易归因读取失败，请检查模拟盘收益闭环表。',
        },
      };
    }
  }

  private buildReadiness(
    signalSummary: any,
    backtests: any,
    schedule: any,
    dataQuality: any,
    dataFreshness?: any,
    runtimeHealth?: any
  ) {
    const checks = [
      {
        key: 'indicator_catalog',
        ok: this.getIndicatorCatalog().group_count >= 8,
        label: '指标族完整',
      },
      {
        key: 'historical_backtest',
        ok: Number(backtests.strategy_count || 0) > 0,
        label: '历史收益可见',
      },
      {
        key: 'quant_signal',
        ok: Number(signalSummary.quant_signal_count || 0) > 0,
        label: '量化信号已跑通',
      },
      {
        key: 'agent_fusion',
        ok: Number(signalSummary.fusion_count || 0) > 0,
        label: 'Agent融合已有结果',
      },
      {
        key: 'open_schedule',
        ok: (schedule.tasks || []).some(
          (task: any) =>
            task.is_active &&
            String(task.name || '').includes('开盘') &&
            task.parameters?.submit_agent_analysis !== false &&
            task.parameters?.run_paper_trading !== false
        ),
        label: '开盘自动推荐已启用',
      },
      {
        key: 'open_watchdog',
        ok: (schedule.tasks || []).some(
          (task: any) => task.is_active && task.type === 'QUANT_OPEN_WATCHDOG'
        ),
        label: '开盘看门狗已启用',
      },
      {
        key: 'realtime_quote_persistence',
        ok: Boolean(dataQuality?.summary?.realtime_persisted),
        label: '实时行情已落盘',
      },
      {
        key: 'data_freshness',
        ok: dataFreshness?.status !== 'risk',
        label: '闭环无关键风险',
      },
      {
        key: 'runtime_health',
        ok: runtimeHealth?.status !== 'risk',
        label: '运行时健康',
      },
    ];
    const readyCount = checks.filter(item => item.ok).length;
    return {
      score: roundNumber((readyCount / checks.length) * 100, 0),
      ready: readyCount === checks.length,
      checks,
      conclusion:
        readyCount === checks.length
          ? '量化指标、历史收益、开盘推荐、Agent融合、模拟盘验证和运行时健康均已具备。'
          : '链路已部分具备，仍需补齐历史跑分或等待明日开盘/Agent异步结果沉淀。',
    };
  }
}

export const quantPerformanceDashboardService = new QuantPerformanceDashboardService();
