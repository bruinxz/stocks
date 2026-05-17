import { Op } from 'sequelize';
import { QuantBacktestResult } from '../../models/QuantBacktestResult';
import { QuantBacktestTask } from '../../models/QuantBacktestTask';
import { QuantFusionAudit } from '../../models/QuantFusionAudit';
import { QuantSignal } from '../../models/QuantSignal';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { ScheduledTask } from '../../models/ScheduledTask';
import {
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
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
  const wins = closed.filter(item => toNumber(item.total_pnl) > 0 || toNumber(item.realized_pnl) > 0);
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
    const [latestBacktests, signalSummary, scheduleSummary, outcomeComparison] =
      await Promise.all([
        this.getLatestBacktests(),
        this.getSignalSummary(),
        this.getScheduleSummary(),
        this.getOutcomeComparison(options),
      ]);

    return {
      generated_at: new Date().toISOString(),
      indicator_catalog: this.getIndicatorCatalog(),
      latest_backtests: latestBacktests,
      signal_summary: signalSummary,
      schedule_summary: scheduleSummary,
      outcome_comparison: outcomeComparison,
      readiness: this.buildReadiness(signalSummary, latestBacktests, scheduleSummary),
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
    return {
      latest_task: latestTask ? modelToPlain(latestTask) : null,
      best_strategy: best,
      strategy_count: leaderboard.length,
      leaderboard,
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
      where: { type: 'QUANT_DAILY_PIPELINE' },
      order: [['cron_expression', 'ASC']],
    });
    return {
      quant_pipeline_task_count: tasks.length,
      tasks: tasks.map(task => ({
        id: task.id,
        name: task.name,
        cron_expression: task.cron_expression,
        is_active: task.is_active,
        last_run_at: task.last_run_at,
        last_run_status: task.last_run_status,
        parameters: {
          universe: task.parameters?.universe,
          strategy_keys: task.parameters?.strategy_keys,
          agent_session: task.parameters?.agent_session,
          submit_agent_analysis: task.parameters?.submit_agent_analysis,
          run_paper_trading: task.parameters?.run_paper_trading,
          paper_trade_limit: task.parameters?.paper_trade_limit,
          default_position_pct: task.parameters?.default_position_pct,
          max_position_pct: task.parameters?.max_position_pct,
        },
      })),
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
        families: families.sort((a, b) => b.total_count - a.total_count || b.total_pnl - a.total_pnl),
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

  private buildReadiness(signalSummary: any, backtests: any, schedule: any) {
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
    ];
    const readyCount = checks.filter(item => item.ok).length;
    return {
      score: roundNumber((readyCount / checks.length) * 100, 0),
      ready: readyCount === checks.length,
      checks,
      conclusion:
        readyCount === checks.length
          ? '量化指标、历史收益、开盘推荐、Agent融合和模拟盘验证链路均已具备。'
          : '链路已部分具备，仍需补齐历史跑分或等待明日开盘/Agent异步结果沉淀。',
    };
  }
}

export const quantPerformanceDashboardService = new QuantPerformanceDashboardService();
