import cron, { ScheduledTask as CronScheduledTask } from 'node-cron';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { logger } from '../utils/logger';
import { LIVE_AUDIT_EVENT_TYPES } from '../live-trading/auditEvents';
import { dataUpdateQueue } from '../jobs/dataUpdateQueue';
import { aiPollingQueue } from '../jobs/aiPollingQueue';
import { aiAdvisorService } from './AIAdvisorService';
import { quantRecommendationService } from './QuantRecommendationService';
import { quantFusionService } from '../quant/engine/internal/QuantFusionService';
import { quantOpenWatchdogService } from '../quant/health/internal/QuantOpenWatchdogService';
import { quantStrategyFeedbackService } from '../quant/engine/internal/QuantStrategyFeedbackService';
import { quantStrategyParamVersionService } from '../quant/engine/internal/QuantStrategyParamVersionService';
import { quantDataService } from '../quant/engine/internal/QuantDataService';
import { realtimeQuoteService } from '../data/services/RealtimeQuoteService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { paperTradingAutomationService } from '../portfolio/internal/PaperTradingAutomationService';
import { paperTradingAttributionService } from '../portfolio/internal/PaperTradingAttributionService';
import { paperTradingPlanService } from '../portfolio/internal/PaperTradingPlanService';
import { paperTradingOrderIntentService } from '../portfolio/internal/PaperTradingOrderIntentService';
import { paperTradingTuningApplyService } from '../portfolio/internal/PaperTradingTuningApplyService';
import { trailingStopGuard } from '../portfolio/risk/TrailingStopGuard';
import { drawdownCircuitBreaker } from '../portfolio/risk/DrawdownCircuitBreaker';
import { marketRegimeAlertService } from '../portfolio/risk/MarketRegimeAlertService';
import { perStockStopLossGuard } from '../portfolio/risk/PerStockStopLossGuard';
import { dailyTradingDigestService } from './DailyTradingDigestService';
import { earningsForecastWatcher } from './EarningsForecastWatcher';
import { weeklyReviewReportService } from './WeeklyReviewReportService';
import { marketBriefService } from './MarketBriefService';
import { enhancedTradingJournalService } from './EnhancedTradingJournalService';
import { cleanupOldDataService } from './CleanupOldDataService';
import { benchmarkIndexService } from './BenchmarkIndexService';
import { automatedRecommendationLoopService } from './AutomatedRecommendationLoopService';
import { recommendationTradeOutcomeService } from './RecommendationTradeOutcomeService';
import { taskParameterAuditService } from './TaskParameterAuditService';
import { liveTradingService } from '../live-trading/services/LiveTradingService';
import { User } from '../models/User';
import { openingReadinessService } from './OpeningReadinessService';
import {
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
} from '../portfolio/internal/PaperTradingDashboardService';
import moment from 'moment-timezone';
import { Op } from 'sequelize';

type TaskRunStatus = 'SUCCESS' | 'FAILED' | 'RUNNING';
type TaskExecutionLogLike = TaskExecutionLog | null;

function compactRuntimeHealth(runtimeHealth: any) {
  if (!runtimeHealth) return null;
  return {
    status: runtimeHealth.status,
    score: runtimeHealth.score,
    conclusion: runtimeHealth.summary?.conclusion,
    risk_count: runtimeHealth.summary?.risk_count,
    warn_count: runtimeHealth.summary?.warn_count,
    factor_min_coverage_rate: runtimeHealth.summary?.factor_min_coverage_rate,
    factor_real_provider_rate: runtimeHealth.summary?.factor_real_provider_rate,
    factor_coverage_status: runtimeHealth.factor_coverage?.coverage_status,
    buy_gate: runtimeHealth.buy_gate || null,
    risk_checks: Array.isArray(runtimeHealth.checks)
      ? runtimeHealth.checks
          .filter((item: any) => item.status === 'risk' || item.status === 'warn')
          .slice(0, 6)
          .map((item: any) => ({
            key: item.key,
            label: item.label,
            status: item.status,
            metric: item.metric,
            conclusion: item.conclusion,
          }))
      : [],
  };
}

function buildQuantDailyPipelineLogSummary(
  result: any,
  agentSubmitted: number,
  agentFailed: number
) {
  const archive = result?.archive || {};
  const paper = result?.paper_trading || {};
  const generated = result?.generated || {};
  const runtimeHealth = compactRuntimeHealth(result?.runtime_health);
  return {
    scenario: 'quant_daily_pipeline',
    status: result?.status || 'completed',
    runtime_risk_blocked: Boolean(result?.runtime_risk_blocked),
    runtime_health: runtimeHealth,
    runtime_block_reason: result?.runtime_risk_blocked
      ? runtimeHealth?.conclusion || result?.message || '量化运行时存在风险项，本轮未执行买入。'
      : null,
    trade_date: result?.trade_date,
    scanned_stocks: generated?.scanned_stocks,
    signal_count: generated?.signal_count,
    archived_signal_count: archive?.total,
    agent_submitted: agentSubmitted,
    agent_failed: agentFailed,
    paper_executed: paper?.executed,
    paper_planned: paper?.planned,
    paper_skipped: paper?.skipped,
    message: result?.message,
  };
}

function buildQuantParamMaintenanceLogSummary(result: any) {
  const create = result?.create || {};
  const refresh = result?.refresh || {};
  const lifecycle = result?.lifecycle || {};
  const lifecycleSummary = lifecycle?.lifecycle?.summary || lifecycle?.summary || {};
  const activeScan = result?.active_scan_params || {};
  const activeSummary = activeScan?.summary || {};
  const promoted = Number(lifecycleSummary.promotion_count || 0);
  const degraded = Number(lifecycleSummary.degradation_count || 0);
  const rolledBack = Number(lifecycleSummary.rollback_count || 0);
  const applied = Number(lifecycle?.applied || 0);
  const completed = Number(refresh?.completed || 0);
  const pending = Number(refresh?.pending || 0);
  const noData = Number(refresh?.no_data || 0);
  const created = Number(create?.created || 0);
  const updated = Number(create?.updated || 0);
  return {
    scenario: 'quant_param_maintenance',
    status: result?.status || 'completed',
    trade_date: result?.trade_date,
    signal_window: result?.signal_window,
    horizons: create?.horizons || result?.horizons,
    created_validations: created,
    updated_validations: updated,
    refreshed_validations: Number(refresh?.refreshed || 0),
    completed_validations: completed,
    pending_validations: pending,
    no_data_validations: noData,
    lifecycle_applied: applied,
    lifecycle_promotion_count: promoted,
    lifecycle_degradation_count: degraded,
    lifecycle_rollback_count: rolledBack,
    active_adopted_strategy_count: Number(activeSummary.adopted_strategy_count || 0),
    active_champion_count: Number(activeSummary.champion_count || 0),
    active_candidate_count: Number(activeSummary.active_candidate_count || 0),
    message:
      applied > 0
        ? `参数后验维护完成：应用 ${applied} 个生命周期动作（推广 ${promoted}、降级 ${degraded}、回滚 ${rolledBack}）。`
        : `参数后验维护完成：新增 ${created} 条、更新 ${updated} 条，完成收益 ${completed} 条，待完成 ${pending} 条。`,
  };
}

function buildLiveShadowAutopilotLogSummary(result: any, outcomes: any) {
  const runSummary = result?.summary || {};
  const outcomeSummary = outcomes?.summary || {};
  const skipped = Boolean(result?.skipped);
  const readiness = result?.readiness || {};
  return {
    scenario: 'live_shadow_autopilot',
    status: skipped ? 'skipped' : 'completed',
    mode: result?.mode || 'shadow_only',
    skipped,
    skip_reason: result?.reason || '',
    readiness_status: readiness?.status,
    readiness_conclusion: readiness?.conclusion,
    selected_count: Number(runSummary.selected_count || 0),
    shadow_executed_count: Number(runSummary.shadow_executed_count || 0),
    blocked_count: Number(runSummary.blocked_count || 0),
    real_order_submitted: Number(runSummary.real_order_submitted || 0),
    outcome_trade_count: Number(outcomeSummary.shadow_trade_count || 0),
    outcome_evaluated_count: Number(outcomeSummary.evaluated_count || 0),
    outcome_win_rate_pct: outcomeSummary.win_rate_pct,
    outcome_avg_latest_return_pct: outcomeSummary.avg_latest_return_pct,
    outcome_total_latest_pnl: outcomeSummary.total_latest_pnl,
    paper_baseline_avg_return_pct: outcomeSummary.baseline?.paper_trading?.avg_latest_return_pct,
    paper_baseline_win_rate_pct: outcomeSummary.baseline?.paper_trading?.win_rate_pct,
    signal_baseline_avg_return_pct: outcomeSummary.baseline?.signal_forward_returns?.avg_return_pct,
    baseline_since: outcomeSummary.baseline?.since,
    budget_action: outcomeSummary.budget_decision?.action,
    budget_label: outcomeSummary.budget_decision?.label,
    budget_recommended_limit: outcomeSummary.budget_decision?.recommended_limit,
    budget_reason: outcomeSummary.budget_decision?.reason,
    message:
      outcomeSummary.conclusion ||
      runSummary.conclusion ||
      '无人影子执行完成；真实券商委托提交数为 0。',
  };
}

function buildLiveShadowWeeklyReviewLogSummary(outcomes: any) {
  const summary = outcomes?.summary || {};
  return {
    scenario: 'live_shadow_weekly_review',
    status: 'completed',
    shadow_trade_count: Number(summary.shadow_trade_count || 0),
    evaluated_count: Number(summary.evaluated_count || 0),
    open_count: Number(summary.open_count || 0),
    win_rate_pct: summary.win_rate_pct,
    avg_latest_return_pct: summary.avg_latest_return_pct,
    total_latest_pnl: summary.total_latest_pnl,
    real_order_submitted: Number(summary.real_order_submitted || 0),
    paper_baseline_avg_return_pct: summary.baseline?.paper_trading?.avg_latest_return_pct,
    signal_baseline_avg_return_pct: summary.baseline?.signal_forward_returns?.avg_return_pct,
    baseline_since: summary.baseline?.since,
    budget_action: summary.budget_decision?.action,
    budget_label: summary.budget_decision?.label,
    budget_recommended_limit: summary.budget_decision?.recommended_limit,
    budget_reason: summary.budget_decision?.reason,
    message: summary.conclusion || summary.budget_decision?.reason || '影子执行周度复盘完成。',
  };
}

function buildRealtimeQuoteSyncLogSummary(result: any, persistence: any, options: any = {}) {
  return {
    scenario: 'realtime_quote_sync',
    status: result?.persisted_count > 0 ? 'completed' : 'empty',
    source: options.source || 'auto',
    universe: options.universe || 'market',
    requested_count: result?.requested_count || 0,
    batch_count: result?.batch_count || 0,
    persisted_count: result?.persisted_count || 0,
    updated_stock_count: result?.updated_stock_count || 0,
    latest_quote_time: result?.latest_quote_time || persistence?.latest_quote_time || null,
    freshness_status: persistence?.freshness_status || 'unknown',
    latest_trade_date_symbol_count: persistence?.latest_trade_date_symbol_count || 0,
    is_fresh: Boolean(persistence?.is_fresh),
    message:
      result?.persisted_count > 0
        ? `实时行情快照已刷新 ${result.persisted_count} 条，覆盖 ${
            persistence?.latest_trade_date_symbol_count || 0
          } 只股票。`
        : '实时行情快照未写入，请检查 AKShare/腾讯行情源连通性。',
  };
}

class SchedulerService {
  private activeTasks: Map<number, CronScheduledTask> = new Map();

  async initialize() {
    try {
      await this.reconcileStaleRunningTasks();

      const tasks = await ScheduledTask.findAll({ where: { is_active: true } });
      logger.info(`Found ${tasks.length} active scheduled tasks`);

      for (const task of tasks) {
        this.scheduleTask(task);
      }
    } catch (error) {
      logger.error('Failed to initialize scheduler:', error);
    }
  }

  private scheduleTask(task: ScheduledTask) {
    if (this.activeTasks.has(task.id)) {
      this.activeTasks.get(task.id)?.stop();
      this.activeTasks.delete(task.id);
    }

    if (!cron.validate(task.cron_expression)) {
      logger.error(`Invalid cron expression for task ${task.id}: ${task.cron_expression}`);
      return;
    }

    const scheduledJob = cron.schedule(
      task.cron_expression,
      async () => {
        logger.info(`Executing scheduled task: ${task.name} (${task.type})`);
        try {
          await this._executeTaskLogic(task, false);
        } catch (error) {
          logger.error(`Scheduled task ${task.id} (${task.name}) execution failed:`, error);
        }
      },
      {
        timezone: 'Asia/Shanghai',
      }
    );

    this.activeTasks.set(task.id, scheduledJob);
    logger.info(
      `Scheduled task ${task.id} (${task.name}) registered with cron: ${task.cron_expression}`
    );
  }

  private getChinaDate(): string {
    return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
  }

  private getDateDaysAgo(days: number): string {
    return moment().tz('Asia/Shanghai').subtract(days, 'days').format('YYYY-MM-DD');
  }

  private toPositiveInt(value: any, fallback: number, max?: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    const normalized = Math.floor(parsed);
    return max ? Math.min(normalized, max) : normalized;
  }

  private getParameterValue(parameters: any, snakeKey: string, camelKey?: string) {
    if (parameters?.[snakeKey] !== undefined) return parameters[snakeKey];
    if (camelKey && parameters?.[camelKey] !== undefined) return parameters[camelKey];
    return undefined;
  }

  private resolvePortfolioParams(parameters: any) {
    return {
      portfolio_name:
        parameters.portfolio_name ||
        parameters.portfolioName ||
        (parameters.use_autonomous_portfolio || parameters.useAutonomousPortfolio
          ? AUTONOMOUS_PORTFOLIO_NAME
          : undefined),
      initial_capital:
        parameters.initial_capital !== undefined
          ? Number(parameters.initial_capital)
          : parameters.initialCapital !== undefined
          ? Number(parameters.initialCapital)
          : parameters.use_autonomous_portfolio || parameters.useAutonomousPortfolio
          ? DEFAULT_AUTONOMOUS_INITIAL_CAPITAL
          : undefined,
      force_new_portfolio:
        parameters.force_new_portfolio !== undefined
          ? Boolean(parameters.force_new_portfolio)
          : parameters.forceNewPortfolio !== undefined
          ? Boolean(parameters.forceNewPortfolio)
          : false,
    };
  }

  private patchMissingParameters(
    existingParameters: Record<string, any> | null | undefined,
    defaultParameters: Record<string, any> | null | undefined,
    keys: string[]
  ): Record<string, any> | null {
    const params = existingParameters || {};
    const defaults = defaultParameters || {};
    const nextParams = { ...params };

    for (const key of keys) {
      if (nextParams[key] === undefined && defaults[key] !== undefined) {
        nextParams[key] = defaults[key];
      }
    }

    return JSON.stringify(nextParams) !== JSON.stringify(params) ? nextParams : null;
  }

  private patchAutonomousPortfolioParameters(task: ScheduledTask, taskData: any) {
    const autonomousTaskNames = new Set([
      '全市场荐股闭环',
      '推荐信号模拟盘跟单',
      'Agent尾盘建议模拟盘跟单',
      '模拟盘风控退出检查',
      '模拟盘收益归因报告',
      '推荐交易收益闭环刷新',
      '模拟盘交易计划报告',
    ]);
    if (!autonomousTaskNames.has(taskData.name)) return null;

    return this.patchMissingParameters(task.parameters, taskData.parameters, [
      'username',
      'use_autonomous_portfolio',
      'portfolio_name',
      'initial_capital',
    ]);
  }

  private async markTaskFinished(
    task: ScheduledTask,
    status: TaskRunStatus,
    executionLog?: TaskExecutionLogLike,
    error?: any
  ) {
    const error_message = error?.message || (error ? String(error) : undefined);
    await task.update({ last_run_status: status });

    if (!executionLog) return;

    const patch: any = {
      status: status === 'SUCCESS' ? 'COMPLETED' : status === 'FAILED' ? 'FAILED' : 'IN_PROGRESS',
    };

    if (status !== 'RUNNING') {
      patch.completed_at = new Date();
    }
    if (error_message) {
      patch.error_message = error_message;
    }

    await executionLog.update(patch);

    const parameters = task.parameters || {};
    const shouldReportToFeishu =
      parameters.report_to_feishu !== false && parameters.reportToFeishu !== false;
    if (status !== 'RUNNING' && shouldReportToFeishu) {
      await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
        record_type: status === 'FAILED' ? '定时任务失败' : '定时任务完成',
        error,
      });
    }
  }

  private async safeUpdateExecutionLog(
    executionLog: TaskExecutionLogLike,
    patch: Record<string, any>
  ) {
    if (!executionLog) return;
    try {
      await executionLog.update(patch);
    } catch (error: any) {
      logger.warn(`更新定时任务执行日志失败，已降级继续执行: ${error.message}`);
    }
  }

  private async createExecutionLog(
    task: ScheduledTask,
    timestamp: Date,
    isManual: boolean
  ): Promise<TaskExecutionLogLike> {
    try {
      return await TaskExecutionLog.create({
        task_id: task.id,
        task_name: task.name + (isManual ? ' (手动执行)' : ''),
        status: 'IN_PROGRESS',
        started_at: timestamp,
      });
    } catch (error: any) {
      logger.error(`创建定时任务执行日志失败，任务仍将继续执行: ${task.id} (${task.name})`, error);
      return null;
    }
  }

  private async enqueueDataUpdateJob(
    task: ScheduledTask,
    executionLog: TaskExecutionLogLike,
    queueName: 'daily_update' | 'new_stocks_sync' | 'bulk_sync_custom' | 'data_quality_scan',
    data: any,
    jobPrefix: string,
    isManual: boolean
  ) {
    const job = await dataUpdateQueue.add(queueName, data, {
      jobId: `${jobPrefix}-${isManual ? 'manual-' : ''}task-${task.id}${
        executionLog?.id ? `-log-${executionLog.id}` : '-no-log'
      }-${Date.now()}`,
    });

    await this.safeUpdateExecutionLog(executionLog, {
      status: 'IN_PROGRESS',
      total_items: 1,
      completed_items: 0,
      failed_items: 0,
      error_message: null,
    });

    logger.info(`定时任务 ${task.id} (${task.name}) 已投递到 data-update 队列`, {
      queueName,
      jobId: job.id,
      data,
    });

    return job;
  }

  private async _executeTaskLogic(task: ScheduledTask, isManual = false) {
    const timestamp = new Date();
    await task.update({ last_run_at: timestamp, last_run_status: 'RUNNING' });

    const executionLog = await this.createExecutionLog(task, timestamp, isManual);

    try {
      const parameters = task.parameters || {};
      const portfolioParams = this.resolvePortfolioParams(parameters);
      const today = this.getChinaDate();

      // 节假日感知 — 工作日 cron 触发但今天是节假日 → 跳过
      // (CLEANUP_OLD_DATA / WEEKLY_REVIEW_EMAIL / 等周末 / 跨日 cron 不受影响, 它们的 cron 表达式本身就允许周末)
      // (isManual=true 用户手动触发时不跳过, 允许补跑)
      const requireTradingDay = (parameters as any).require_trading_day !== false;
      if (!isManual && requireTradingDay) {
        const { isAShareTradeDay, explainNonTradeDay } = require('../utils/tradingCalendar');
        const isWeekdayCron = /\* \* 1-5$/.test(task.cron_expression || '');
        // 只对 1-5 (周一到周五) 类型 cron 加节假日 guard
        if (isWeekdayCron && !isAShareTradeDay(timestamp)) {
          const reason = explainNonTradeDay(timestamp) || 'A 股节假日';
          logger.info(
            `[trading-calendar] task=${task.name} type=${task.type} 跳过 — 今天是 ${reason}`
          );
          await this.safeUpdateExecutionLog(executionLog, {
            success_count: 0,
            failed_count: 0,
            total_items: 0,
            result_summary: { skipped: true, reason: reason, scenario: 'non_trading_day' },
          });
          await this.markTaskFinished(task, 'SUCCESS');
          return { success: true, message: `skipped: ${reason}` };
        }
      }

      if (task.type === 'DAILY_UPDATE') {
        await this.enqueueDataUpdateJob(
          task,
          executionLog,
          'daily_update',
          {
            type: 'daily_update',
            date: today,
            forceUpdate: Boolean(parameters.force_update || parameters.forceUpdate || isManual),
            max_stocks: this.toPositiveInt(
              parameters.max_stocks || parameters.maxStocks,
              300,
              2000
            ),
            execution_log_id: executionLog?.id,
            scheduled_task_id: task.id,
          },
          'dailyUpdate',
          isManual
        );
      } else if (task.type === 'SYNC_ALL_STOCKS') {
        await this.enqueueDataUpdateJob(
          task,
          executionLog,
          'new_stocks_sync',
          {
            type: 'new_stocks_sync',
            date: today,
            execution_log_id: executionLog?.id,
            scheduled_task_id: task.id,
          },
          'syncAllStocks',
          isManual
        );
      } else if (task.type === 'SYNC_HISTORY') {
        const symbols = Array.isArray(parameters.symbols) ? parameters.symbols : undefined;
        const marketFilters = Array.isArray(parameters.marketFilters)
          ? parameters.marketFilters
          : Array.isArray(parameters.market_filters)
          ? parameters.market_filters
          : undefined;
        const syncAllStocks =
          parameters.syncAllStocks !== undefined
            ? Boolean(parameters.syncAllStocks)
            : parameters.sync_all_stocks !== undefined
            ? Boolean(parameters.sync_all_stocks)
            : !symbols?.length && !marketFilters?.length;

        await this.enqueueDataUpdateJob(
          task,
          executionLog,
          'bulk_sync_custom',
          {
            type: 'bulk_sync_custom',
            date: today,
            symbols,
            marketFilters,
            syncAllStocks,
            start_date:
              parameters.start_date ||
              parameters.startDate ||
              this.getDateDaysAgo(this.toPositiveInt(parameters.lookback_days, 10, 3650)),
            end_date: parameters.end_date || parameters.endDate || today,
            dataSource: parameters.dataSource || parameters.data_source || 'auto',
            concurrency: this.toPositiveInt(parameters.concurrency, 2, 10),
            batch_limit: this.toPositiveInt(
              this.getParameterValue(parameters, 'batch_limit', 'batchLimit'),
              200,
              6000
            ),
            lag_days_threshold: this.toPositiveInt(
              this.getParameterValue(parameters, 'lag_days_threshold', 'lagDaysThreshold'),
              0,
              3650
            ),
            stale_first:
              this.getParameterValue(parameters, 'stale_first', 'staleFirst') !== undefined
                ? Boolean(this.getParameterValue(parameters, 'stale_first', 'staleFirst'))
                : true,
            include_no_data:
              this.getParameterValue(parameters, 'include_no_data', 'includeNoData') !== undefined
                ? Boolean(this.getParameterValue(parameters, 'include_no_data', 'includeNoData'))
                : undefined,
            execution_log_id: executionLog?.id,
            scheduled_task_id: task.id,
          },
          'syncHistory',
          isManual
        );
      } else if (task.type === 'DATA_QUALITY_SCAN') {
        await this.enqueueDataUpdateJob(
          task,
          executionLog,
          'data_quality_scan',
          {
            type: 'data_quality_scan',
            date: today,
            scope: parameters.scope || 'market',
            lookback_days: this.toPositiveInt(parameters.lookback_days, 180, 3650),
            limit: this.toPositiveInt(parameters.limit, 200, 2000),
            execution_log_id: executionLog?.id,
            scheduled_task_id: task.id,
          },
          'dataQualityScan',
          isManual
        );
      } else if (task.type === 'REALTIME_QUOTE_SYNC') {
        const rawSymbols = Array.isArray(parameters.symbols)
          ? parameters.symbols
          : Array.isArray(parameters.stock_symbols)
          ? parameters.stock_symbols
          : undefined;
        const limit = this.toPositiveInt(
          parameters.limit || parameters.quote_sync_limit || parameters.max_stocks,
          360,
          1500
        );
        const source = parameters.source || parameters.data_source || 'auto';
        const universe = parameters.universe === 'favorites' ? 'favorites' : 'market';
        const batchSize = this.toPositiveInt(
          parameters.batch_size || parameters.batchSize,
          300,
          500
        );
        const stocks = rawSymbols?.length
          ? []
          : await quantDataService.getStocks({
              universe,
              user_id: parameters.user_id,
              limit,
            });
        const targetSymbols = rawSymbols?.length
          ? rawSymbols.map((symbol: any) => String(symbol || '').trim()).filter(Boolean)
          : stocks.map(stock => stock.symbol);

        const result = await realtimeQuoteService.syncQuotesForSymbols(targetSymbols, {
          source,
          batch_size: batchSize,
        });
        const persistence = await realtimeQuoteService.getPersistenceSummary().catch(error => ({
          persisted: false,
          freshness_status: 'unknown',
          error: error?.message || String(error),
        }));
        const failedCount = Math.max(
          0,
          Number(result.requested_count || 0) - Number(result.persisted_count || 0)
        );
        const allFailed =
          Number(result.requested_count || 0) > 0 && Number(result.persisted_count || 0) === 0;
        const resultSummary = buildRealtimeQuoteSyncLogSummary(result, persistence, {
          source,
          universe,
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.requested_count,
          completed_items: result.persisted_count,
          failed_items: failedCount,
          status: allFailed ? 'FAILED' : 'COMPLETED',
          completed_at: new Date(),
          error_message: allFailed ? resultSummary.message : null,
          result_summary: resultSummary,
        });

        if (allFailed) {
          throw new Error(resultSummary.message);
        }

        logger.info(
          `实时行情快照刷新完成。请求 ${result.requested_count}，落盘 ${
            result.persisted_count
          }，更新股票 ${result.updated_stock_count}，最新 ${result.latest_quote_time || '-'}`
        );
      } else if (task.type === 'QUANT_PARAM_MAINTENANCE') {
        const tradeDate = parameters.trade_date || parameters.tradeDate || today;
        const lookbackDays = this.toPositiveInt(
          parameters.lookback_days || parameters.lookbackDays,
          14,
          365
        );
        const signalStartDate =
          parameters.start_date ||
          parameters.startDate ||
          moment(tradeDate).subtract(lookbackDays, 'days').format('YYYY-MM-DD');
        const signalEndDate = parameters.end_date || parameters.endDate || tradeDate;
        const rawSignals = Array.isArray(parameters.signal)
          ? parameters.signal
          : Array.isArray(parameters.signals)
          ? parameters.signals
          : ['buy', 'watch'];
        const strategyKeys = Array.isArray(parameters.strategy_keys)
          ? parameters.strategy_keys
          : Array.isArray(parameters.strategyKeys)
          ? parameters.strategyKeys
          : undefined;
        const horizons = Array.isArray(parameters.horizons)
          ? parameters.horizons.map((item: any) => this.toPositiveInt(item, 1, 60)).filter(Boolean)
          : [1, 3, 5, 10];
        const create = await quantStrategyParamVersionService.createPendingValidationsFromSignals({
          start_date: signalStartDate,
          end_date: signalEndDate,
          strategy_keys: strategyKeys,
          horizons,
          limit: this.toPositiveInt(parameters.limit, 1000, 10000),
          signal: rawSignals.map((item: any) => String(item || '').trim()).filter(Boolean),
        });
        const refresh = await quantStrategyParamVersionService.refreshValidationReturns({
          limit: this.toPositiveInt(
            parameters.refresh_limit || parameters.refreshLimit,
            3000,
            20000
          ),
          include_completed:
            parameters.include_completed !== undefined
              ? Boolean(parameters.include_completed)
              : parameters.includeCompleted !== undefined
              ? Boolean(parameters.includeCompleted)
              : false,
          auto_sync_benchmark:
            parameters.auto_sync_benchmark !== undefined
              ? Boolean(parameters.auto_sync_benchmark)
              : parameters.autoSyncBenchmark !== undefined
              ? Boolean(parameters.autoSyncBenchmark)
              : false,
        });
        const lifecycle = await quantStrategyParamVersionService.evaluateAndApplyLifecycle({
          dry_run:
            parameters.dry_run_lifecycle !== undefined
              ? Boolean(parameters.dry_run_lifecycle)
              : parameters.dryRunLifecycle !== undefined
              ? Boolean(parameters.dryRunLifecycle)
              : false,
          policy: parameters.lifecycle_policy || parameters.lifecyclePolicy,
          limit: this.toPositiveInt(
            parameters.lifecycle_limit || parameters.lifecycleLimit,
            5000,
            20000
          ),
        });
        const activeScanParams = await quantStrategyParamVersionService.getActiveParamsForScan({
          include_grid_search: true,
          include_experiment: true,
        });
        const result = {
          status: 'completed',
          generated_at: new Date().toISOString(),
          trade_date: tradeDate,
          signal_window: { start_date: signalStartDate, end_date: signalEndDate },
          horizons,
          create,
          refresh,
          lifecycle,
          active_scan_params: activeScanParams,
          message: lifecycle?.applied
            ? `参数后验维护完成，已应用 ${lifecycle.applied} 个推广/降级/回滚动作。`
            : `参数后验维护完成，新增 ${create.created} 条验证样本，完成 ${refresh.completed} 条收益刷新。`,
        };
        const resultSummary = buildQuantParamMaintenanceLogSummary(result);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: Number(create.scanned || 0) + Number(refresh.refreshed || 0),
          completed_items:
            Number(create.created || 0) +
            Number(create.updated || 0) +
            Number(refresh.completed || 0),
          failed_items: Number(refresh.no_data || 0),
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: resultSummary,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: parameters.record_type || parameters.recordType || '量化参数后验维护',
            task_type: 'QUANT_PARAM_MAINTENANCE',
            result: resultSummary,
          });
        }

        logger.info(
          `量化参数后验维护完成。新增 ${create.created}，更新 ${create.updated}，完成收益 ${refresh.completed}，生命周期应用 ${lifecycle.applied}`
        );
      } else if (task.type === 'QUANT_DAILY_PIPELINE') {
        await quantStrategyFeedbackService.refreshWeights({
          snapshot_date: today,
          lookback_days: this.toPositiveInt(
            parameters.strategy_weight_lookback_days || parameters.strategyWeightLookbackDays,
            365,
            3650
          ),
        });

        const result = await quantFusionService.runDailyPipeline({
          username: parameters.username || 'stock',
          trade_date: parameters.trade_date || parameters.tradeDate || today,
          target_date: parameters.target_date || parameters.targetDate || today,
          universe: parameters.universe === 'favorites' ? 'favorites' : 'market',
          symbols: Array.isArray(parameters.symbols) ? parameters.symbols : undefined,
          strategy_keys: Array.isArray(parameters.strategy_keys)
            ? parameters.strategy_keys
            : Array.isArray(parameters.strategyKeys)
            ? parameters.strategyKeys
            : undefined,
          lookback_days: this.toPositiveInt(
            parameters.lookback_days || parameters.lookbackDays,
            180,
            3650
          ),
          candidate_limit: this.toPositiveInt(
            parameters.candidate_limit || parameters.candidateLimit,
            180,
            1000
          ),
          refresh_realtime_quotes:
            parameters.refresh_realtime_quotes !== undefined
              ? Boolean(parameters.refresh_realtime_quotes)
              : parameters.refreshRealtimeQuotes !== undefined
              ? Boolean(parameters.refreshRealtimeQuotes)
              : true,
          sync_factors_before_scan:
            parameters.sync_factors_before_scan !== undefined
              ? Boolean(parameters.sync_factors_before_scan)
              : parameters.syncFactorsBeforeScan !== undefined
              ? Boolean(parameters.syncFactorsBeforeScan)
              : true,
          factor_sync_scope:
            parameters.factor_sync_scope || parameters.factorSyncScope || parameters.universe,
          factor_sync_limit: this.toPositiveInt(
            parameters.factor_sync_limit || parameters.factorSyncLimit,
            Math.max(Number(parameters.candidate_limit || parameters.candidateLimit || 220), 360),
            1500
          ),
          factor_provider: parameters.factor_provider || parameters.factorProvider || 'auto',
          factor_sync_skip_if_coverage_rate_gte: Number(
            parameters.factor_sync_skip_if_coverage_rate_gte ??
              parameters.factorSyncSkipIfCoverageRateGte ??
              92
          ),
          factor_sync_skip_if_real_provider_rate_gte: Number(
            parameters.factor_sync_skip_if_real_provider_rate_gte ??
              parameters.factorSyncSkipIfRealProviderRateGte ??
              65
          ),
          quote_sync_limit: this.toPositiveInt(
            parameters.quote_sync_limit || parameters.quoteSyncLimit,
            Math.max(Number(parameters.candidate_limit || parameters.candidateLimit || 220), 360),
            1000
          ),
          realtime_quote_source:
            parameters.realtime_quote_source || parameters.realtimeQuoteSource || 'auto',
          min_score: Number(parameters.min_score || parameters.minScore || 55),
          archive_limit: this.toPositiveInt(
            parameters.archive_limit || parameters.archiveLimit,
            30,
            200
          ),
          max_industry_candidates: this.toPositiveInt(
            parameters.max_industry_candidates || parameters.maxIndustryCandidates,
            4,
            20
          ),
          max_strategy_candidates: this.toPositiveInt(
            parameters.max_strategy_candidates || parameters.maxStrategyCandidates,
            8,
            30
          ),
          submit_agent_analysis:
            parameters.submit_agent_analysis !== undefined
              ? Boolean(parameters.submit_agent_analysis)
              : parameters.submitAgentAnalysis !== undefined
              ? Boolean(parameters.submitAgentAnalysis)
              : true,
          agent_max_count: this.toPositiveInt(
            parameters.agent_max_count || parameters.agentMaxCount,
            5,
            20
          ),
          agent_min_score: Number(parameters.agent_min_score || parameters.agentMinScore || 72),
          agent_paper_trade_min_score: Number(
            parameters.agent_paper_trade_min_score ||
              parameters.agentPaperTradeMinScore ||
              Math.min(Number(parameters.agent_min_score || parameters.agentMinScore || 72), 54)
          ),
          agent_session: parameters.agent_session || parameters.agentSession || 'close',
          agent_auto_paper_trade:
            parameters.agent_auto_paper_trade !== undefined
              ? Boolean(parameters.agent_auto_paper_trade)
              : parameters.agentAutoPaperTrade !== undefined
              ? Boolean(parameters.agentAutoPaperTrade)
              : true,
          run_paper_trading:
            parameters.run_paper_trading !== undefined
              ? Boolean(parameters.run_paper_trading)
              : parameters.runPaperTrading !== undefined
              ? Boolean(parameters.runPaperTrading)
              : true,
          dry_run:
            parameters.dry_run !== undefined
              ? Boolean(parameters.dry_run)
              : parameters.dryRun !== undefined
              ? Boolean(parameters.dryRun)
              : false,
          paper_trade_limit: this.toPositiveInt(
            parameters.paper_trade_limit || parameters.paperTradeLimit,
            3,
            20
          ),
          paper_trade_scan_limit: this.toPositiveInt(
            parameters.paper_trade_scan_limit || parameters.paperTradeScanLimit,
            80,
            300
          ),
          max_positions: this.toPositiveInt(
            parameters.max_positions || parameters.maxPositions,
            8,
            30
          ),
          default_position_pct: Number(
            parameters.default_position_pct || parameters.defaultPositionPct || 5
          ),
          max_position_pct: Number(parameters.max_position_pct || parameters.maxPositionPct || 10),
          min_trade_amount: Number(
            parameters.min_trade_amount || parameters.minTradeAmount || 3000
          ),
          use_entry_risk_guard:
            parameters.use_entry_risk_guard !== undefined
              ? Boolean(parameters.use_entry_risk_guard)
              : parameters.useEntryRiskGuard !== undefined
              ? Boolean(parameters.useEntryRiskGuard)
              : undefined,
          max_daily_new_positions:
            parameters.max_daily_new_positions ?? parameters.maxDailyNewPositions,
          max_daily_new_exposure_pct:
            parameters.max_daily_new_exposure_pct ?? parameters.maxDailyNewExposurePct,
          max_total_exposure_pct:
            parameters.max_total_exposure_pct ?? parameters.maxTotalExposurePct,
          max_industry_exposure_pct:
            parameters.max_industry_exposure_pct ?? parameters.maxIndustryExposurePct,
          min_cash_reserve_pct: parameters.min_cash_reserve_pct ?? parameters.minCashReservePct,
          max_portfolio_drawdown_pct:
            parameters.max_portfolio_drawdown_pct ?? parameters.maxPortfolioDrawdownPct,
          max_single_stock_volatility_pct:
            parameters.max_single_stock_volatility_pct ?? parameters.maxSingleStockVolatilityPct,
          max_position_correlation:
            parameters.max_position_correlation ?? parameters.maxPositionCorrelation,
          max_portfolio_var_pct: parameters.max_portfolio_var_pct ?? parameters.maxPortfolioVarPct,
          min_avg_turnover_yuan: parameters.min_avg_turnover_yuan ?? parameters.minAvgTurnoverYuan,
          cooldown_days_after_loss:
            parameters.cooldown_days_after_loss ?? parameters.cooldownDaysAfterLoss,
          use_experiment_params:
            parameters.use_experiment_params !== undefined
              ? Boolean(parameters.use_experiment_params)
              : parameters.useExperimentParams !== undefined
              ? Boolean(parameters.useExperimentParams)
              : true,
          experiment_param_policy:
            parameters.experiment_param_policy || parameters.experimentParamPolicy,
          block_limit_up:
            parameters.block_limit_up !== undefined
              ? Boolean(parameters.block_limit_up)
              : parameters.blockLimitUp !== undefined
              ? Boolean(parameters.blockLimitUp)
              : undefined,
          block_limit_down:
            parameters.block_limit_down !== undefined
              ? Boolean(parameters.block_limit_down)
              : parameters.blockLimitDown !== undefined
              ? Boolean(parameters.blockLimitDown)
              : undefined,
          block_suspended:
            parameters.block_suspended !== undefined
              ? Boolean(parameters.block_suspended)
              : parameters.blockSuspended !== undefined
              ? Boolean(parameters.blockSuspended)
              : undefined,
          block_buy_on_runtime_risk:
            parameters.block_buy_on_runtime_risk !== undefined
              ? Boolean(parameters.block_buy_on_runtime_risk)
              : parameters.blockBuyOnRuntimeRisk !== undefined
              ? Boolean(parameters.blockBuyOnRuntimeRisk)
              : true,
          ...portfolioParams,
          task_label: task.name,
          execution_log_id: executionLog?.id,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          notify_to_feishu_bot:
            parameters.notify_to_feishu_bot !== undefined
              ? Boolean(parameters.notify_to_feishu_bot)
              : parameters.notifyToFeishuBot !== undefined
              ? Boolean(parameters.notifyToFeishuBot)
              : true,
          params_by_strategy: parameters.params_by_strategy || parameters.paramsByStrategy,
        });

        const agentSubmitted = Array.isArray(result.agent_analysis?.submitted)
          ? result.agent_analysis.submitted.length
          : 0;
        const agentFailed = Array.isArray(result.agent_analysis?.failed)
          ? result.agent_analysis.failed.length
          : 0;
        const runtimeRiskBlocked = Boolean(result.runtime_risk_blocked);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items:
            agentSubmitted > 0 ? agentSubmitted + agentFailed : result.archive?.total || 0,
          completed_items: agentSubmitted > 0 ? 0 : result.archive?.total || 0,
          failed_items: agentFailed,
          status: agentSubmitted > 0 ? 'IN_PROGRESS' : 'COMPLETED',
          completed_at: agentSubmitted > 0 ? null : new Date(),
          error_message: runtimeRiskBlocked
            ? result.runtime_health?.summary?.conclusion ||
              result.message ||
              '量化运行时存在风险项，本轮只归档观察信号，不执行模拟买入。'
            : null,
          result_summary: buildQuantDailyPipelineLogSummary(result, agentSubmitted, agentFailed),
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportQuantDailyPipeline(result, {
            record_type:
              parameters.record_type ||
              parameters.recordType ||
              (agentSubmitted > 0 ? `${task.name}已提交Agent复核` : `${task.name}完成`),
            task_type: 'QUANT_DAILY_PIPELINE',
          });
        }

        logger.info(
          `量化策略扫描闭环完成。归档 ${
            result.archive?.total || 0
          }，Agent提交 ${agentSubmitted}，模拟盘 ${
            result.paper_trading?.executed ?? result.paper_trading?.planned ?? 0
          }`
        );
      } else if (task.type === 'QUANT_OPEN_WATCHDOG') {
        const result = await quantOpenWatchdogService.check({
          trade_date: parameters.trade_date || parameters.tradeDate || today,
          target_task_name: parameters.target_task_name || parameters.targetTaskName,
          expected_after_time: parameters.expected_after_time || parameters.expectedAfterTime,
          latest_allowed_minutes: this.toPositiveInt(
            parameters.latest_allowed_minutes || parameters.latestAllowedMinutes,
            15,
            180
          ),
          min_quant_signals: this.toPositiveInt(
            parameters.min_quant_signals || parameters.minQuantSignals,
            1,
            1000
          ),
          min_archived_signals: this.toPositiveInt(
            parameters.min_archived_signals || parameters.minArchivedSignals,
            1,
            1000
          ),
          require_fresh_quote:
            parameters.require_fresh_quote !== undefined
              ? Boolean(parameters.require_fresh_quote)
              : parameters.requireFreshQuote !== undefined
              ? Boolean(parameters.requireFreshQuote)
              : true,
          freshness_max_minutes: this.toPositiveInt(
            parameters.freshness_max_minutes || parameters.freshnessMaxMinutes,
            60,
            24 * 60
          ),
        });
        const issueCount = Array.isArray(result.issues) ? result.issues.length : 0;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 6,
          completed_items: result.status === 'healthy' ? 6 : Math.max(0, 6 - issueCount),
          failed_items: result.status === 'critical' ? Math.max(issueCount, 1) : 0,
          status: result.status === 'critical' ? 'FAILED' : 'COMPLETED',
          completed_at: new Date(),
          error_message:
            result.status === 'critical'
              ? (result.issues || []).map((issue: any) => issue.message).join('；')
              : null,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportQuantOpenWatchdog(result, {
            record_type: parameters.record_type || parameters.recordType || task.name,
            task_type: 'QUANT_OPEN_WATCHDOG',
          });
        }

        if (result.status === 'critical') {
          logger.error(`量化开盘链路看门狗发现关键异常: ${result.conclusion}`, {
            issues: result.issues,
          });
          throw new Error(result.conclusion || '量化开盘链路看门狗发现关键异常');
        } else {
          logger.info(`量化开盘链路看门狗完成: ${result.status} - ${result.conclusion}`);
        }
      } else if (task.type === 'BENCHMARK_INDEX_SYNC') {
        const lookbackDays = this.toPositiveInt(
          parameters.lookback_days || parameters.lookbackDays,
          180,
          3650
        );
        const startDate =
          parameters.start_date ||
          parameters.startDate ||
          moment(today).subtract(lookbackDays, 'days').format('YYYY-MM-DD');
        const endDate = parameters.end_date || parameters.endDate || today;
        const result = await benchmarkIndexService.syncBenchmarkIndices(startDate, endDate, {
          symbols: Array.isArray(parameters.symbols) ? parameters.symbols : undefined,
          data_source: parameters.data_source || parameters.dataSource || 'tencent_only',
          concurrency: this.toPositiveInt(parameters.concurrency, 2, 5),
        });
        const entries = Object.entries(result);
        const inserted = entries.reduce(
          (sum, [, count]) => (Number(count) > 0 ? sum + Number(count) : sum),
          0
        );
        const failed = entries.filter(([, count]) => Number(count) < 0).length;

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: entries.length,
          completed_items: entries.length - failed,
          failed_items: failed,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: failed > 0 ? `${failed} 个基准指数同步失败，详见结果摘要` : null,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: '基准指数行情同步',
            task_type: 'BENCHMARK_INDEX_SYNC',
            result: {
              sync_window: { start_date: startDate, end_date: endDate },
              data_source: parameters.data_source || parameters.dataSource || 'tencent_only',
              inserted_records: inserted,
              total: entries.length,
              failed,
              details: result,
            },
          });
        }

        logger.info(
          `基准指数行情同步完成。指数 ${entries.length}，失败 ${failed}，写入/尝试 ${inserted} 条`
        );
      } else if (task.type === 'LIVE_SHADOW_AUTOPILOT') {
        const username = parameters.username || 'stock';
        const user = await User.findOne({ where: { username } });
        if (!user) throw new Error(`未找到影子执行用户：${username}`);
        const userId = Number((user as any).id);
        const requireReadiness =
          parameters.require_opening_readiness !== undefined
            ? Boolean(parameters.require_opening_readiness)
            : parameters.requireOpeningReadiness !== undefined
            ? Boolean(parameters.requireOpeningReadiness)
            : true;
        const allowDegraded =
          parameters.allow_degraded_readiness !== undefined
            ? Boolean(parameters.allow_degraded_readiness)
            : parameters.allowDegradedReadiness !== undefined
            ? Boolean(parameters.allowDegradedReadiness)
            : true;
        const readiness = requireReadiness
          ? await openingReadinessService.getReadiness({
              user_id: userId,
              username,
              trade_date: parameters.trade_date || parameters.tradeDate || today,
              factor_limit: this.toPositiveInt(
                parameters.factor_limit || parameters.factorLimit,
                220,
                1000
              ),
              use_cache: parameters.use_cache !== false && parameters.useCache !== false,
              cache_ttl_ms: this.toPositiveInt(
                parameters.cache_ttl_ms || parameters.cacheTtlMs,
                90_000,
                5 * 60 * 1000
              ),
            })
          : null;
        const readinessBlocked =
          readiness &&
          (readiness.status === 'blocked' || (!allowDegraded && readiness.status !== 'ready'));
        let result: any;
        if (readinessBlocked) {
          result = {
            generated_at: new Date().toISOString(),
            mode: 'shadow_only',
            skipped: true,
            reason: readiness?.conclusion || '开盘就绪门禁未通过，本轮不生成新的影子成交样本。',
            readiness: readiness
              ? {
                  status: readiness.status,
                  status_label: readiness.status_label,
                  conclusion: readiness.conclusion,
                  buy_gate: readiness.buy_gate,
                }
              : null,
            summary: {
              selected_count: 0,
              shadow_executed_count: 0,
              blocked_count: 0,
              real_order_submitted: 0,
              conclusion:
                readiness?.conclusion || '开盘就绪门禁未通过，本轮不生成新的影子成交样本。',
            },
          };
        } else {
          result = await liveTradingService.runShadowAutopilot(userId, {
            limit: this.toPositiveInt(parameters.limit || parameters.shadow_limit, 2, 10),
            source: parameters.source || task.name || 'scheduled_live_shadow_autopilot',
            dry_run:
              parameters.dry_run !== undefined
                ? Boolean(parameters.dry_run)
                : parameters.dryRun !== undefined
                ? Boolean(parameters.dryRun)
                : false,
          });
          result.readiness = readiness
            ? {
                status: readiness.status,
                status_label: readiness.status_label,
                conclusion: readiness.conclusion,
                buy_gate: readiness.buy_gate,
              }
            : null;
        }
        const outcomes = await liveTradingService.getShadowAutopilotOutcomes(userId, {
          limit: this.toPositiveInt(parameters.outcome_limit || parameters.outcomeLimit, 30, 100),
          horizons: Array.isArray(parameters.horizons)
            ? parameters.horizons.map((item: any) => Number(item)).filter(Number.isFinite)
            : [1, 3, 5],
        });
        const resultSummary = buildLiveShadowAutopilotLogSummary(result, outcomes);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: Number(result.summary?.selected_count || 0),
          completed_items: Number(result.summary?.shadow_executed_count || 0),
          failed_items: Number(result.summary?.blocked_count || 0),
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: resultSummary,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: parameters.record_type || parameters.recordType || '无人影子执行收益闭环',
            task_type: 'LIVE_SHADOW_AUTOPILOT',
            result: resultSummary,
          });
        }

        logger.info(
          `无人影子执行定时任务完成。影子成交 ${
            result.summary?.shadow_executed_count || 0
          }，真实提交 ${result.summary?.real_order_submitted || 0}，闭环样本 ${
            outcomes.summary?.shadow_trade_count || 0
          }`
        );
      } else if (task.type === 'LIVE_SHADOW_WEEKLY_REVIEW') {
        const username = parameters.username || 'stock';
        const user = await User.findOne({ where: { username } });
        if (!user) throw new Error(`未找到影子执行用户：${username}`);
        const shadowTask = await ScheduledTask.findOne({
          where: { type: 'LIVE_SHADOW_AUTOPILOT', is_active: true },
          order: [['id', 'ASC']],
        });
        const outcomes = await liveTradingService.getShadowAutopilotOutcomes(
          Number((user as any).id),
          {
            limit: this.toPositiveInt(parameters.outcome_limit || parameters.outcomeLimit, 80, 200),
            horizons: Array.isArray(parameters.horizons)
              ? parameters.horizons.map((item: any) => Number(item)).filter(Number.isFinite)
              : [1, 3, 5],
          }
        );
        const resultSummary: any = buildLiveShadowWeeklyReviewLogSummary(outcomes);
        if (shadowTask && outcomes.summary?.budget_decision) {
          const beforeParameters = { ...((shadowTask as any).parameters || {}) };
          const recommendedLimit = this.toPositiveInt(
            outcomes.summary.budget_decision.recommended_limit,
            Number(beforeParameters.limit || 2),
            10
          );
          const suggestedParameters = {
            ...beforeParameters,
            limit: recommendedLimit,
            shadow_budget_advice: {
              generated_at: new Date().toISOString(),
              source_task_id: Number(task.id),
              action: outcomes.summary.budget_decision.action,
              label: outcomes.summary.budget_decision.label,
              reason: outcomes.summary.budget_decision.reason,
              current_limit: Number(beforeParameters.limit || 0),
              recommended_limit: recommendedLimit,
              applied: false,
              note: '仅记录候选补丁，不自动修改定时任务参数。',
            },
          };
          const changedKeys = taskParameterAuditService.buildChangedKeys(
            beforeParameters,
            suggestedParameters,
            ['limit', 'shadow_budget_advice']
          );
          if (changedKeys.length > 0) {
            await taskParameterAuditService.record({
              task: shadowTask,
              event_type: LIVE_AUDIT_EVENT_TYPES.SHADOW_BUDGET_SUGGESTION,
              before_parameters: beforeParameters,
              after_parameters: suggestedParameters,
              changed_keys: changedKeys,
              metadata: {
                source: 'live_shadow_weekly_review',
                review_task_id: Number(task.id),
                outcome_summary: resultSummary,
                auto_applied: false,
              },
            });
          }
          resultSummary.suggested_task_patch = {
            target_task_id: Number((shadowTask as any).id),
            target_task_name: (shadowTask as any).name,
            changed_keys: changedKeys,
            before_limit: beforeParameters.limit,
            suggested_limit: recommendedLimit,
            auto_applied: false,
          };
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: Number(outcomes.summary?.shadow_trade_count || 0),
          completed_items: Number(outcomes.summary?.evaluated_count || 0),
          failed_items: 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: resultSummary,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: parameters.record_type || parameters.recordType || '影子执行周度复盘',
            task_type: 'LIVE_SHADOW_WEEKLY_REVIEW',
            result: resultSummary,
          });
        }

        logger.info(
          `影子执行周度复盘完成。样本 ${outcomes.summary?.shadow_trade_count || 0}，已评估 ${
            outcomes.summary?.evaluated_count || 0
          }，建议 ${outcomes.summary?.budget_decision?.label || '-'}`
        );
      } else if (task.type === 'SIGNAL_PERFORMANCE_REFRESH') {
        const commonPerformanceParams = {
          source_type: parameters.source_type || parameters.sourceType,
          agent_session: parameters.agent_session || parameters.agentSession,
          task_label: parameters.task_label || parameters.taskLabel,
          symbol: parameters.symbol,
          decision: parameters.decision,
          start_date: parameters.start_date || parameters.startDate,
          end_date: parameters.end_date || parameters.endDate,
          horizon: parameters.horizon,
          record_type: parameters.record_type || parameters.recordType,
          limit: this.toPositiveInt(parameters.limit, 500, 5000),
        };
        let repairResult: any = null;
        if (parameters.auto_repair_missing_data || parameters.autoRepairMissingData) {
          repairResult = await aiInvestmentSignalService.repairAndVerifySignals({
            ...commonPerformanceParams,
            data_source: parameters.data_source || parameters.dataSource || 'tencent_only',
            lookback_days: this.toPositiveInt(parameters.lookback_days, 15, 3650),
            sync_concurrency: this.toPositiveInt(parameters.sync_concurrency, 2, 5),
          });
          if (parameters.report_repair_to_feishu !== false) {
            await feishuTaskReportService.reportSignalVerificationRepair(repairResult, {
              record_type: `${
                parameters.record_type || parameters.recordType || '推荐绩效'
              }数据修复`,
            });
          }
        }

        const result = await aiInvestmentSignalService.refreshPerformance({
          ...commonPerformanceParams,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
        });
        (result as any).repair = repairResult;

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.verification.total,
          completed_items: result.verification.verified,
          failed_items: Number(result.verification.no_data || 0),
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `推荐绩效刷新完成。扫描 ${result.verification.total}，已完成 ${result.verification.verified}，等待 ${result.verification.pending}，无数据 ${result.verification.no_data}`
        );
      } else if (task.type === 'SIGNAL_QUALITY_DAILY_REPORT') {
        const result = await aiInvestmentSignalService.getSignalQualityReport({
          source_type: parameters.source_type || parameters.sourceType,
          agent_session: parameters.agent_session || parameters.agentSession,
          task_label: parameters.task_label || parameters.taskLabel,
          symbol: parameters.symbol,
          decision: parameters.decision,
          start_date: parameters.start_date || parameters.startDate,
          end_date: parameters.end_date || parameters.endDate,
          horizon: parameters.horizon || '5d',
          lookback_days: this.toPositiveInt(parameters.lookback_days, 30, 3650),
          min_samples: this.toPositiveInt(parameters.min_samples, 5, 100),
          limit: this.toPositiveInt(parameters.limit, 5000, 10000),
          auto_repair_missing_data:
            parameters.auto_repair_missing_data !== undefined
              ? Boolean(parameters.auto_repair_missing_data)
              : parameters.autoRepairMissingData !== undefined
              ? Boolean(parameters.autoRepairMissingData)
              : true,
          data_source: parameters.data_source || parameters.dataSource || 'tencent_only',
          repair_lookback_days: this.toPositiveInt(
            parameters.repair_lookback_days || parameters.repairLookbackDays,
            this.toPositiveInt(parameters.lookback_days, 30, 3650),
            3650
          ),
          sync_concurrency: this.toPositiveInt(
            parameters.sync_concurrency || parameters.syncConcurrency,
            2,
            5
          ),
          verify_before_report:
            parameters.verify_before_report !== undefined
              ? Boolean(parameters.verify_before_report)
              : parameters.verifyBeforeReport !== undefined
              ? Boolean(parameters.verifyBeforeReport)
              : true,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          record_type: parameters.record_type || parameters.recordType || '信号质量日报',
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.overview.total_signals,
          completed_items: result.overview.completed_samples,
          failed_items: Number(result.overview.no_data_signals || 0),
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `信号质量日报完成。信号 ${result.overview.total_signals}，完成样本 ${result.overview.completed_samples}，质量分 ${result.overview.quality_score}`
        );
      } else if (task.type === 'PAPER_TRADING_AUTO_SYNC') {
        const result = await paperTradingAutomationService.runAutoSync({
          username: parameters.username,
          ...portfolioParams,
          source_type: parameters.source_type || parameters.sourceType,
          limit: this.toPositiveInt(parameters.limit, 5, 20),
          scan_limit: this.toPositiveInt(
            this.getParameterValue(parameters, 'scan_limit', 'scanLimit'),
            80,
            500
          ),
          min_score: Number(parameters.min_score || parameters.minScore || 72),
          max_positions: this.toPositiveInt(
            this.getParameterValue(parameters, 'max_positions', 'maxPositions'),
            8,
            30
          ),
          default_position_pct: Number(
            parameters.default_position_pct || parameters.defaultPositionPct || 5
          ),
          max_position_pct: Number(parameters.max_position_pct || parameters.maxPositionPct || 12),
          min_trade_amount: Number(
            parameters.min_trade_amount || parameters.minTradeAmount || 3000
          ),
          allowed_risk_levels: parameters.allowed_risk_levels ||
            parameters.allowedRiskLevels || ['low', 'medium'],
          require_action_buy:
            parameters.require_action_buy !== undefined
              ? Boolean(parameters.require_action_buy)
              : parameters.requireActionBuy !== undefined
              ? Boolean(parameters.requireActionBuy)
              : true,
          dry_run:
            parameters.dry_run !== undefined
              ? Boolean(parameters.dry_run)
              : parameters.dryRun !== undefined
              ? Boolean(parameters.dryRun)
              : false,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          refresh_recommendations:
            parameters.refresh_recommendations !== undefined
              ? Boolean(parameters.refresh_recommendations)
              : parameters.refreshRecommendations !== undefined
              ? Boolean(parameters.refreshRecommendations)
              : true,
          universe: parameters.universe === 'market' ? 'market' : 'favorites',
          style: ['balanced', 'momentum', 'value', 'low_risk'].includes(parameters.style)
            ? parameters.style
            : 'balanced',
          candidate_limit: this.toPositiveInt(
            parameters.candidate_limit || parameters.candidateLimit,
            20,
            50
          ),
          lookback_days: this.toPositiveInt(
            parameters.lookback_days || parameters.lookbackDays,
            120,
            3650
          ),
          verify_signals:
            parameters.verify_signals !== undefined
              ? Boolean(parameters.verify_signals)
              : parameters.verifySignals !== undefined
              ? Boolean(parameters.verifySignals)
              : false,
          use_attribution_feedback:
            parameters.use_attribution_feedback !== undefined
              ? Boolean(parameters.use_attribution_feedback)
              : parameters.useAttributionFeedback !== undefined
              ? Boolean(parameters.useAttributionFeedback)
              : true,
          use_profit_gate:
            parameters.use_profit_gate !== undefined
              ? Boolean(parameters.use_profit_gate)
              : parameters.useProfitGate !== undefined
              ? Boolean(parameters.useProfitGate)
              : true,
          profit_gate_horizon:
            parameters.profit_gate_horizon || parameters.profitGateHorizon || '5d',
          profit_gate_min_samples: this.toPositiveInt(
            parameters.profit_gate_min_samples || parameters.profitGateMinSamples,
            5,
            100
          ),
          profit_gate_min_quality_score: Number(
            parameters.profit_gate_min_quality_score || parameters.profitGateMinQualityScore || 45
          ),
          profit_gate_allow_deprioritized:
            parameters.profit_gate_allow_deprioritized !== undefined
              ? Boolean(parameters.profit_gate_allow_deprioritized)
              : parameters.profitGateAllowDeprioritized !== undefined
              ? Boolean(parameters.profitGateAllowDeprioritized)
              : false,
          profit_gate_allow_sampling:
            parameters.profit_gate_allow_sampling !== undefined
              ? Boolean(parameters.profit_gate_allow_sampling)
              : parameters.profitGateAllowSampling !== undefined
              ? Boolean(parameters.profitGateAllowSampling)
              : true,
          profit_gate_sampling_multiplier: Number(
            parameters.profit_gate_sampling_multiplier ||
              parameters.profitGateSamplingMultiplier ||
              0.35
          ),
          use_outcome_feedback:
            parameters.use_outcome_feedback !== undefined
              ? Boolean(parameters.use_outcome_feedback)
              : parameters.useOutcomeFeedback !== undefined
              ? Boolean(parameters.useOutcomeFeedback)
              : true,
          outcome_feedback_min_closed_samples: this.toPositiveInt(
            parameters.outcome_feedback_min_closed_samples ||
              parameters.outcomeFeedbackMinClosedSamples,
            5,
            100
          ),
          outcome_feedback_lookback_days: this.toPositiveInt(
            parameters.outcome_feedback_lookback_days || parameters.outcomeFeedbackLookbackDays,
            365,
            3650
          ),
          outcome_feedback_limit: this.toPositiveInt(
            parameters.outcome_feedback_limit || parameters.outcomeFeedbackLimit,
            2000,
            10000
          ),
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned,
          completed_items: result.executed || result.planned,
          failed_items: result.skipped,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘自动跟单完成。扫描 ${result.scanned}，成交 ${result.executed}，预演 ${result.planned}，跳过 ${result.skipped}`
        );
      } else if (task.type === 'PAPER_TRADING_RISK_CHECK') {
        const result = await paperTradingAutomationService.runRiskCheck({
          username: parameters.username,
          ...portfolioParams,
          dry_run:
            parameters.dry_run !== undefined
              ? Boolean(parameters.dry_run)
              : parameters.dryRun !== undefined
              ? Boolean(parameters.dryRun)
              : false,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          limit: this.toPositiveInt(parameters.limit, 20, 100),
          enable_stop_loss:
            parameters.enable_stop_loss !== undefined
              ? Boolean(parameters.enable_stop_loss)
              : parameters.enableStopLoss !== undefined
              ? Boolean(parameters.enableStopLoss)
              : true,
          enable_take_profit:
            parameters.enable_take_profit !== undefined
              ? Boolean(parameters.enable_take_profit)
              : parameters.enableTakeProfit !== undefined
              ? Boolean(parameters.enableTakeProfit)
              : true,
          enable_trailing_take_profit:
            parameters.enable_trailing_take_profit !== undefined
              ? Boolean(parameters.enable_trailing_take_profit)
              : parameters.enableTrailingTakeProfit !== undefined
              ? Boolean(parameters.enableTrailingTakeProfit)
              : true,
          enable_sell_signals:
            parameters.enable_sell_signals !== undefined
              ? Boolean(parameters.enable_sell_signals)
              : parameters.enableSellSignals !== undefined
              ? Boolean(parameters.enableSellSignals)
              : true,
          use_adaptive_risk_policy:
            parameters.use_adaptive_risk_policy !== undefined
              ? Boolean(parameters.use_adaptive_risk_policy)
              : parameters.useAdaptiveRiskPolicy !== undefined
              ? Boolean(parameters.useAdaptiveRiskPolicy)
              : true,
          adaptive_risk_lookback_days: this.toPositiveInt(
            parameters.adaptive_risk_lookback_days || parameters.adaptiveRiskLookbackDays,
            180,
            3650
          ),
          adaptive_risk_min_closed_samples: this.toPositiveInt(
            parameters.adaptive_risk_min_closed_samples || parameters.adaptiveRiskMinClosedSamples,
            5,
            100
          ),
          adaptive_risk_override_signal_params:
            parameters.adaptive_risk_override_signal_params !== undefined
              ? Boolean(parameters.adaptive_risk_override_signal_params)
              : parameters.adaptiveRiskOverrideSignalParams !== undefined
              ? Boolean(parameters.adaptiveRiskOverrideSignalParams)
              : false,
          default_stop_loss_pct: Number(
            parameters.default_stop_loss_pct || parameters.defaultStopLossPct || 7
          ),
          default_take_profit_pct: Number(
            parameters.default_take_profit_pct || parameters.defaultTakeProfitPct || 14
          ),
          trailing_activation_pct: Number(
            parameters.trailing_activation_pct || parameters.trailingActivationPct || 8
          ),
          trailing_drawdown_pct: Number(
            parameters.trailing_drawdown_pct || parameters.trailingDrawdownPct || 4
          ),
          max_hold_days: Number(parameters.max_hold_days || parameters.maxHoldDays || 0),
          min_sell_signal_score: Number(
            parameters.min_sell_signal_score || parameters.minSellSignalScore || 60
          ),
          sell_signal_source_type:
            parameters.sell_signal_source_type || parameters.sellSignalSourceType || 'all',
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.checked,
          completed_items: result.exited || result.planned,
          failed_items: result.skipped,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘风控检查完成。检查 ${result.checked}，退出 ${result.exited}，预演 ${result.planned}，继续持有 ${result.held}`
        );
      } else if (task.type === 'PAPER_TRADING_TRAILING_STOP_UPDATE') {
        // US-048 — 每日收盘后定时任务：刷新所有用户的持仓 highest_price
        // 与 trailing_stop_price。`user_id` 参数可选；不传 = 扫描所有有
        // PaperTradingPortfolio 的用户。
        const targetUserId = parameters.user_id || parameters.userId;
        const result = await trailingStopGuard.updatePositionsAfterClose({
          user_id: targetUserId ? Number(targetUserId) : undefined,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.total_positions,
          completed_items: result.updated_positions,
          failed_items: result.skipped_positions,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_trailing_stop_update',
            scanned_users: result.scanned_users,
            total_positions: result.total_positions,
            updated_positions: result.updated_positions,
            skipped_positions: result.skipped_positions,
            per_user_errors: result.per_user
              .filter(u => u.error)
              .map(u => ({ user_id: u.user_id, error: u.error })),
          },
        });
        logger.info(
          `追踪止损刷新完成。扫描用户 ${result.scanned_users}，` +
            `持仓 ${result.total_positions}，更新 ${result.updated_positions}，` +
            `跳过 ${result.skipped_positions}`
        );
      } else if (task.type === 'PAPER_TRADING_TRAILING_STOP_CHECK') {
        // US-048 — 次日开盘前定时任务：检查 prev_close ≤ trailing_stop_price
        // 触发 SELL 信号，写 RiskAlert(level='HIGH')。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const result = await trailingStopGuard.evaluateNextDayTriggers({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.total_positions,
          completed_items: result.triggered_positions,
          failed_items: result.per_user_errors.length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_trailing_stop_check',
            scanned_users: result.scanned_users,
            total_positions: result.total_positions,
            triggered_positions: result.triggered_positions,
            dry_run: dryRun,
            per_user_errors: result.per_user_errors,
            triggers: result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              prev_close: t.prev_close,
              highest_price: t.highest_price,
              trailing_stop_price: t.trailing_stop_price,
              effective_pct: t.effective_pct,
            })),
          },
        });
        logger.info(
          `追踪止损检查完成。扫描用户 ${result.scanned_users}，` +
            `持仓 ${result.total_positions}，触发 ${result.triggered_positions}` +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_DRAWDOWN_BREAKER_CHECK') {
        // US-049 — 每日收盘后定时任务：评估所有用户的组合回撤等级
        // (LEVEL_1 / LEVEL_2 / LEVEL_3) 并触发对应风控动作（暂停 24h /
        // 减仓 50% / 清仓）。`user_id` 参数可选；不传 = 扫描所有有
        // PaperTradingPortfolio 的用户。`dry_run` 让 UI dashboard 能
        // "预演今日 trigger" 不写 RiskAlert / paused_until。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const lookbackDays =
          parameters.lookback_days !== undefined
            ? Number(parameters.lookback_days)
            : parameters.lookbackDays !== undefined
            ? Number(parameters.lookbackDays)
            : undefined;
        const result = await drawdownCircuitBreaker.evaluateAfterClose({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
          lookback_days: lookbackDays,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.triggered_users,
          failed_items: result.per_user.filter(u => u.error).length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_drawdown_breaker_check',
            scanned_users: result.scanned_users,
            triggered_users: result.triggered_users,
            dry_run: dryRun,
            triggers: result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              quantity: t.quantity,
              gain_ratio: t.gain_ratio,
              reason: t.reason,
            })),
            per_user_summary: result.per_user.map(u => ({
              user_id: u.user_id,
              level: u.level,
              drawdown_pct: u.drawdown_pct,
              peak_value: u.peak_value,
              current_value: u.current_value,
              paused_until: u.paused_until,
              error: u.error,
            })),
          },
        });
        logger.info(
          `组合回撤熔断评估完成。扫描用户 ${result.scanned_users}，` +
            `触发 ${result.triggered_users}` +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_MARKET_REGIME_CHECK') {
        // US-050 — 每日开盘后定时任务：扫描上证指数(默认)的市场环境信号
        // (DROP_3D MEDIUM / DROP_20D HIGH / DEATH_CROSS MEDIUM) 并给所有
        // 有 PaperTradingPortfolio 的用户写一条 RiskAlert（每信号一行）。
        // `user_id` 参数可选；不传 = 扫描所有用户。`dry_run` 让 UI dashboard
        // 能"预演今日 trigger" 不写 RiskAlert。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const lookbackDays =
          parameters.lookback_days !== undefined
            ? Number(parameters.lookback_days)
            : parameters.lookbackDays !== undefined
            ? Number(parameters.lookbackDays)
            : undefined;
        const result = await marketRegimeAlertService.evaluateAfterOpen({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
          lookback_days: lookbackDays,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.alerted_users,
          failed_items: result.per_user.filter(u => u.error).length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_market_regime_check',
            scanned_users: result.scanned_users,
            alerted_users: result.alerted_users,
            dry_run: dryRun,
            benchmark_symbol: result.status.benchmark_symbol,
            as_of: result.status.as_of,
            return_3d_pct: result.status.return_3d_pct,
            return_20d_pct: result.status.return_20d_pct,
            cross_signal: result.status.cross_signal,
            alerts: result.status.alerts.map(a => ({
              type: a.type,
              level: a.level,
              symbol: a.symbol,
            })),
            per_user_summary: result.per_user.map(u => ({
              user_id: u.user_id,
              alerts_written: u.alerts_written,
              error: u.error,
            })),
          },
        });
        logger.info(
          `市场环境预警评估完成。扫描用户 ${result.scanned_users}，` +
            `触发告警 ${result.alerted_users}，` +
            `信号 [${result.status.alerts.map(a => a.type).join(',') || '无'}]` +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK') {
        // US-051 — 每日收盘后定时任务：扫描所有持仓，若 (close - avg_cost) /
        // avg_cost ≤ -effective_pct（默认 -7%）触发 RiskAlert(level='HIGH',
        // symbol=持仓 symbol)；若一个用户的触发数 ≥ Math.ceil(open_count * 0.5)
        // 额外写一行 RiskAlert(symbol='SYSTEM:PER_STOCK_STOP_LOSS_MASS') 标识
        // 组合级 LEVEL_2 群体止损事件。`user_id` 参数可选；不传 = 扫描所有用户。
        // `dry_run` 让 UI dashboard "预演今日 trigger" 不写 RiskAlert。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const result = await perStockStopLossGuard.evaluateAfterClose({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.triggered_users,
          failed_items: result.per_user.filter(u => u.error).length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_per_stock_stop_loss_check',
            scanned_users: result.scanned_users,
            triggered_users: result.triggered_users,
            dry_run: dryRun,
            triggers: result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              quantity: t.quantity,
              loss_ratio: t.loss_ratio,
              effective_pct: t.effective_pct,
              today_close: t.today_close,
              avg_cost: t.avg_cost,
            })),
            per_user_summary: result.per_user.map(u => ({
              user_id: u.user_id,
              level: u.level,
              open_positions_count: u.open_positions_count,
              triggered_count: u.triggered_count,
              mass_message: u.mass_message,
              error: u.error,
            })),
          },
        });
        logger.info(
          `每股止损评估完成。扫描用户 ${result.scanned_users}，` +
            `触发用户 ${result.triggered_users}，` +
            `总 trigger ${result.triggers.length}` +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'STRATEGY_KILL_SWITCH_CHECK') {
        // Phase 4+ 策略熔断监控 — 评估每个策略的 kill_switch_metric (定义在
        // edge_hypothesis 内)；低于 kill_switch_threshold 触发自动 enabled=false。
        // `dry_run` 参数默认 true（保守），生产 cron 应配 dry_run=false 让熔断真正生效。
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : true; // 默认 dry_run 避免运维误关
        const { strategyKillSwitchMonitor } = require('../services/StrategyKillSwitchMonitor');
        const result = await strategyKillSwitchMonitor.evaluateAll({ dry_run: dryRun });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.total_strategies,
          completed_items: result.evaluated,
          failed_items: result.errors.length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'strategy_kill_switch_check',
            total_strategies: result.total_strategies,
            evaluated: result.evaluated,
            triggered: result.triggered,
            skipped_no_kill_switch: result.skipped_no_kill_switch,
            skipped_disabled: result.skipped_disabled,
            skipped_insufficient_data: result.skipped_insufficient_data,
            dry_run: dryRun,
            triggered_strategies: result.evaluations
              .filter((e: any) => e.triggered)
              .map((e: any) => ({
                strategy_key: e.strategy_key,
                metric: e.metric,
                threshold: e.threshold,
                observed: e.observed_value,
                reason: e.reason,
              })),
          },
        });
        logger.info(
          `策略熔断评估完成。总策略 ${result.total_strategies}，` +
            `评估 ${result.evaluated}，触发 ${result.triggered}` +
            (dryRun ? '（dry-run，未真正禁用）' : '（已自动 disable）')
        );
      } else if (task.type === 'EQUITY_CURVE_GOVERNOR_DAILY_EVAL') {
        // Sprint 3: 资金曲线 Governor 每日评估 — 对所有 portfolio 评估 5 档健康度。
        // 默认 persist=true，写入 EquityCurveGovernorState，触发档位切换告警。
        const {
          equityCurveGovernorService,
        } = require('../services/governor/EquityCurveGovernorService');
        const result = await equityCurveGovernorService.evaluateAll({
          persist: parameters.persist !== false,
          as_of_date: parameters.as_of_date || parameters.asOfDate,
        });
        const byTier = result.reduce((acc: Record<string, number>, r: any) => {
          acc[r.tier] = (acc[r.tier] || 0) + 1;
          return acc;
        }, {});
        const changed = result.filter((r: any) => r.tier_changed).length;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.length,
          completed_items: result.length,
          failed_items: 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'equity_curve_governor_daily_eval',
            evaluated: result.length,
            by_tier: byTier,
            tier_changed: changed,
            results_sample: result.slice(0, 5).map((r: any) => ({
              portfolio_id: r.portfolio_id,
              tier: r.tier,
              multiplier: r.kelly_multiplier,
              trigger_reason: r.trigger_reason,
            })),
          },
        });
        logger.info(
          `资金曲线 Governor 评估完成。已评估 ${result.length} 个 portfolio, ` +
            `档位分布: ${JSON.stringify(byTier)}, ` +
            `档位切换 ${changed} 个`
        );
      } else if (task.type === 'RESEARCH_INTEGRITY_BATCH_AUDIT') {
        // Sprint 1A: ResearchIntegrity 周批量审计 — 扫描近 N 天完成的 QuantBacktestResult，
        // 对每个跑 audit (DSR / PBO / OOS decay)，FAIL 的 strategy 推到 ops 关注列表。
        const {
          researchIntegrityService,
        } = require('../services/research/ResearchIntegrityService');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { QuantBacktestResult } = require('../models/QuantBacktestResult');
        const sinceDays = this.toPositiveInt(parameters.since_days || parameters.sinceDays, 7, 90);
        const cutoff = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
        const { Op } = require('sequelize');
        const results = await QuantBacktestResult.findAll({
          where: { created_at: { [Op.gte]: cutoff } },
          order: [['created_at', 'DESC']],
          limit: 200,
        });
        let audited = 0;
        const verdictDist: Record<string, number> = { PASS: 0, WARN: 0, FAIL: 0, INSUFFICIENT: 0 };
        const failedStrategies: Array<{ strategy_key: string; verdict: string; reason: string }> =
          [];
        for (const r of results) {
          try {
            const equity = Array.isArray(r.equity_curve_json) ? r.equity_curve_json : [];
            const audit = await researchIntegrityService.auditBacktest(
              {
                backtest_id: r.id,
                source: 'quant_backtest_result',
                strategy_key: r.strategy_key,
                observed_sharpe:
                  r.sharpe_ratio !== null && r.sharpe_ratio !== undefined
                    ? Number(r.sharpe_ratio)
                    : null,
                num_trials: 1,
                sample_length: equity.length,
              },
              { persist: true }
            );
            audited += 1;
            verdictDist[audit.verdict] = (verdictDist[audit.verdict] || 0) + 1;
            if (audit.verdict === 'FAIL') {
              failedStrategies.push({
                strategy_key: r.strategy_key,
                verdict: audit.verdict,
                reason: audit.summary_message,
              });
            }
          } catch (err: any) {
            logger.warn(
              `[research-integrity-batch] audit failed for backtest ${r.id}: ${err?.message}`
            );
          }
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: results.length,
          completed_items: audited,
          failed_items: results.length - audited,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'research_integrity_batch_audit',
            since_days: sinceDays,
            total_backtests: results.length,
            audited,
            verdict_distribution: verdictDist,
            failed_strategies: failedStrategies.slice(0, 20),
          },
        });
        logger.info(
          `ResearchIntegrity 周批量审计完成: 扫描 ${results.length} 个 backtest, 审计 ${audited}, ` +
            `verdict 分布: ${JSON.stringify(verdictDist)}, FAIL 策略: ${failedStrategies.length}`
        );
      } else if (task.type === 'PAPER_TRADING_ATTRIBUTION_REPORT') {
        const result = await paperTradingAttributionService.getAttribution({
          username: parameters.username,
          ...portfolioParams,
          include_open:
            parameters.include_open !== undefined
              ? Boolean(parameters.include_open)
              : parameters.includeOpen !== undefined
              ? Boolean(parameters.includeOpen)
              : true,
          source_type: parameters.source_type || parameters.sourceType,
          start_date: parameters.start_date || parameters.startDate,
          end_date: parameters.end_date || parameters.endDate,
          limit: this.toPositiveInt(parameters.limit, 2000, 10000),
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.summary.executed_signals,
          completed_items: result.summary.closed_count,
          failed_items: result.summary.near_stop_loss_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘收益归因完成。闭环 ${result.summary.closed_count}，持仓 ${result.summary.open_count}，胜率 ${result.summary.win_rate}%`
        );
      } else if (task.type === 'RECOMMENDATION_TRADE_OUTCOME_REFRESH') {
        const result = await recommendationTradeOutcomeService.refreshPortfolioOutcomes({
          username: parameters.username || 'stock',
          ...portfolioParams,
          include_open:
            parameters.include_open !== undefined
              ? Boolean(parameters.include_open)
              : parameters.includeOpen !== undefined
              ? Boolean(parameters.includeOpen)
              : true,
          lookback_days: this.toPositiveInt(
            parameters.lookback_days || parameters.lookbackDays,
            180,
            3650
          ),
          source_type: parameters.source_type || parameters.sourceType,
          agent_session: parameters.agent_session || parameters.agentSession,
          limit: this.toPositiveInt(parameters.limit, 2000, 10000),
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.refreshed,
          completed_items: result.created_or_updated,
          failed_items: result.failed,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.failed > 0 ? `${result.failed} 条收益闭环刷新失败` : null,
        });

        logger.info(
          `推荐交易收益闭环刷新完成。刷新 ${result.refreshed}，写入 ${result.created_or_updated}，闭环 ${result.dashboard.summary.closed_count}，总盈亏 ${result.dashboard.summary.total_pnl}`
        );
      } else if (task.type === 'PAPER_TRADING_DAILY_PLAN') {
        const result = await paperTradingPlanService.generatePlan({
          username: parameters.username,
          ...portfolioParams,
          include_entries:
            parameters.include_entries !== undefined
              ? Boolean(parameters.include_entries)
              : parameters.includeEntries !== undefined
              ? Boolean(parameters.includeEntries)
              : true,
          include_exits:
            parameters.include_exits !== undefined
              ? Boolean(parameters.include_exits)
              : parameters.includeExits !== undefined
              ? Boolean(parameters.includeExits)
              : true,
          include_monitor:
            parameters.include_monitor !== undefined
              ? Boolean(parameters.include_monitor)
              : parameters.includeMonitor !== undefined
              ? Boolean(parameters.includeMonitor)
              : true,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          source_type: parameters.source_type || parameters.sourceType,
          limit: this.toPositiveInt(parameters.limit, 30, 100),
          entry_limit: this.toPositiveInt(parameters.entry_limit || parameters.entryLimit, 3, 20),
          scan_limit: this.toPositiveInt(
            this.getParameterValue(parameters, 'scan_limit', 'scanLimit'),
            80,
            500
          ),
          min_score: Number(parameters.min_score || parameters.minScore || 72),
          max_positions: this.toPositiveInt(
            this.getParameterValue(parameters, 'max_positions', 'maxPositions'),
            8,
            30
          ),
          default_position_pct: Number(
            parameters.default_position_pct || parameters.defaultPositionPct || 5
          ),
          max_position_pct: Number(parameters.max_position_pct || parameters.maxPositionPct || 10),
          min_trade_amount: Number(
            parameters.min_trade_amount || parameters.minTradeAmount || 3000
          ),
          allowed_risk_levels: parameters.allowed_risk_levels ||
            parameters.allowedRiskLevels || ['low', 'medium'],
          use_attribution_feedback:
            parameters.use_attribution_feedback !== undefined
              ? Boolean(parameters.use_attribution_feedback)
              : parameters.useAttributionFeedback !== undefined
              ? Boolean(parameters.useAttributionFeedback)
              : true,
          use_profit_gate:
            parameters.use_profit_gate !== undefined
              ? Boolean(parameters.use_profit_gate)
              : parameters.useProfitGate !== undefined
              ? Boolean(parameters.useProfitGate)
              : true,
          profit_gate_horizon:
            parameters.profit_gate_horizon || parameters.profitGateHorizon || '5d',
          profit_gate_min_samples: this.toPositiveInt(
            parameters.profit_gate_min_samples || parameters.profitGateMinSamples,
            5,
            100
          ),
          profit_gate_min_quality_score: Number(
            parameters.profit_gate_min_quality_score || parameters.profitGateMinQualityScore || 45
          ),
          profit_gate_allow_deprioritized:
            parameters.profit_gate_allow_deprioritized !== undefined
              ? Boolean(parameters.profit_gate_allow_deprioritized)
              : parameters.profitGateAllowDeprioritized !== undefined
              ? Boolean(parameters.profitGateAllowDeprioritized)
              : false,
          profit_gate_allow_sampling:
            parameters.profit_gate_allow_sampling !== undefined
              ? Boolean(parameters.profit_gate_allow_sampling)
              : parameters.profitGateAllowSampling !== undefined
              ? Boolean(parameters.profitGateAllowSampling)
              : true,
          profit_gate_sampling_multiplier: Number(
            parameters.profit_gate_sampling_multiplier ||
              parameters.profitGateSamplingMultiplier ||
              0.35
          ),
          use_outcome_feedback:
            parameters.use_outcome_feedback !== undefined
              ? Boolean(parameters.use_outcome_feedback)
              : parameters.useOutcomeFeedback !== undefined
              ? Boolean(parameters.useOutcomeFeedback)
              : true,
          outcome_feedback_min_closed_samples: this.toPositiveInt(
            parameters.outcome_feedback_min_closed_samples ||
              parameters.outcomeFeedbackMinClosedSamples,
            5,
            100
          ),
          outcome_feedback_lookback_days: this.toPositiveInt(
            parameters.outcome_feedback_lookback_days || parameters.outcomeFeedbackLookbackDays,
            365,
            3650
          ),
          outcome_feedback_limit: this.toPositiveInt(
            parameters.outcome_feedback_limit || parameters.outcomeFeedbackLimit,
            2000,
            10000
          ),
          enable_stop_loss:
            parameters.enable_stop_loss !== undefined
              ? Boolean(parameters.enable_stop_loss)
              : parameters.enableStopLoss !== undefined
              ? Boolean(parameters.enableStopLoss)
              : true,
          enable_take_profit:
            parameters.enable_take_profit !== undefined
              ? Boolean(parameters.enable_take_profit)
              : parameters.enableTakeProfit !== undefined
              ? Boolean(parameters.enableTakeProfit)
              : true,
          enable_trailing_take_profit:
            parameters.enable_trailing_take_profit !== undefined
              ? Boolean(parameters.enable_trailing_take_profit)
              : parameters.enableTrailingTakeProfit !== undefined
              ? Boolean(parameters.enableTrailingTakeProfit)
              : true,
          enable_sell_signals:
            parameters.enable_sell_signals !== undefined
              ? Boolean(parameters.enable_sell_signals)
              : parameters.enableSellSignals !== undefined
              ? Boolean(parameters.enableSellSignals)
              : true,
          use_adaptive_risk_policy:
            parameters.use_adaptive_risk_policy !== undefined
              ? Boolean(parameters.use_adaptive_risk_policy)
              : parameters.useAdaptiveRiskPolicy !== undefined
              ? Boolean(parameters.useAdaptiveRiskPolicy)
              : true,
          adaptive_risk_lookback_days: this.toPositiveInt(
            parameters.adaptive_risk_lookback_days || parameters.adaptiveRiskLookbackDays,
            180,
            3650
          ),
          adaptive_risk_min_closed_samples: this.toPositiveInt(
            parameters.adaptive_risk_min_closed_samples || parameters.adaptiveRiskMinClosedSamples,
            5,
            100
          ),
          adaptive_risk_override_signal_params:
            parameters.adaptive_risk_override_signal_params !== undefined
              ? Boolean(parameters.adaptive_risk_override_signal_params)
              : parameters.adaptiveRiskOverrideSignalParams !== undefined
              ? Boolean(parameters.adaptiveRiskOverrideSignalParams)
              : false,
          default_stop_loss_pct: Number(
            parameters.default_stop_loss_pct || parameters.defaultStopLossPct || 7
          ),
          default_take_profit_pct: Number(
            parameters.default_take_profit_pct || parameters.defaultTakeProfitPct || 14
          ),
          trailing_activation_pct: Number(
            parameters.trailing_activation_pct || parameters.trailingActivationPct || 8
          ),
          trailing_drawdown_pct: Number(
            parameters.trailing_drawdown_pct || parameters.trailingDrawdownPct || 4
          ),
          max_hold_days: Number(parameters.max_hold_days || parameters.maxHoldDays || 20),
          min_sell_signal_score: Number(
            parameters.min_sell_signal_score || parameters.minSellSignalScore || 60
          ),
          sell_signal_source_type:
            parameters.sell_signal_source_type || parameters.sellSignalSourceType || 'all',
        });

        const hindsightRefresh = await paperTradingOrderIntentService
          .refreshHindsightSnapshots({
            username: parameters.username,
            ...portfolioParams,
            lookback_days: this.toPositiveInt(
              parameters.order_intent_hindsight_lookback_days ||
                parameters.orderIntentHindsightLookbackDays,
              60,
              3650
            ),
            limit: this.toPositiveInt(
              parameters.order_intent_hindsight_limit || parameters.orderIntentHindsightLimit,
              800,
              5000
            ),
            refresh_hindsight: Boolean(
              parameters.order_intent_hindsight_force_refresh ||
                parameters.orderIntentHindsightForceRefresh
            ),
          })
          .catch((error: any) => {
            logger.warn(`订单意图后验快照刷新失败，交易计划继续完成: ${error?.message || error}`);
            return null;
          });
        const shouldCaptureCanarySnapshot =
          parameters.capture_canary_snapshot !== undefined
            ? Boolean(parameters.capture_canary_snapshot)
            : parameters.captureCanarySnapshot !== undefined
            ? Boolean(parameters.captureCanarySnapshot)
            : true;
        const canarySnapshot = shouldCaptureCanarySnapshot
          ? await paperTradingTuningApplyService
              .getCanaryStatus({
                username: parameters.username,
                user_id: parameters.user_id || parameters.userId,
                limit: 5,
              })
              .catch((error: any) => {
                logger.warn(
                  `Canary 评审快照自动沉淀失败，交易计划继续完成: ${error?.message || error}`
                );
                return null;
              })
          : null;

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.summary.action_count,
          completed_items: result.summary.action_count,
          failed_items: result.summary.urgent_count,
          result_summary: {
            scenario: 'paper_trading_daily_plan',
            action_count: result.summary.action_count,
            urgent_count: result.summary.urgent_count,
            entry_count: result.summary.entry_count,
            exit_count: result.summary.exit_count,
            order_intent_hindsight_refresh: hindsightRefresh
              ? {
                  refreshed_count: hindsightRefresh.refreshed_count,
                  evaluated_count: hindsightRefresh.summary?.evaluated_count,
                  persisted_snapshot_count: hindsightRefresh.summary?.persisted_snapshot_count,
                  cache_hit_count: hindsightRefresh.summary?.cache_hit_count,
                  cache_miss_count: hindsightRefresh.summary?.cache_miss_count,
                }
              : null,
            canary_snapshot_capture: canarySnapshot?.active
              ? {
                  snapshot_id: canarySnapshot.snapshot_capture?.snapshot_id,
                  action: canarySnapshot.review?.action,
                  action_label: canarySnapshot.review?.action_label,
                  review_score: canarySnapshot.review?.review_score,
                  ready_for_review: canarySnapshot.review?.ready_for_review,
                  closed_count: canarySnapshot.review?.metrics?.closed_count,
                  avg_excess_return_pct: canarySnapshot.review?.metrics?.avg_excess_return_pct,
                  drawdown_guard_passed: canarySnapshot.review?.drawdown_guard?.passed,
                }
              : {
                  captured: false,
                  reason: canarySnapshot?.summary?.conclusion || '暂无正在观察的 Canary 调参。',
                },
          },
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘交易计划完成。动作 ${result.summary.action_count}，紧急 ${
            result.summary.urgent_count
          }，入场 ${result.summary.entry_count}，退出 ${result.summary.exit_count}，后验快照 ${
            hindsightRefresh?.refreshed_count ?? 0
          }，Canary快照 ${canarySnapshot?.snapshot_capture?.snapshot_id || '无'}`
        );
      } else if (task.type === 'PAPER_TRADING_DAILY_DIGEST') {
        // US-063 — 每日收盘后 (默认 15:30) 给所有 notification_channels.feishu.daily_digest=true
        // 的用户发飞书 interactive card 日报（PnL / 新增 BUY/SELL / 明日候选）。
        // `user_id` 可选；不传 = 扫所有 is_active=true 用户。`dry_run`=true 让 ops 预演 payload
        // 不真发 webhook。`per_strategy_limit` 控制明日候选 cap（默认 5）。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const perStrategyLimit =
          parameters.per_strategy_limit !== undefined
            ? Number(parameters.per_strategy_limit)
            : parameters.perStrategyLimit !== undefined
            ? Number(parameters.perStrategyLimit)
            : undefined;
        const perDirectionTradeLimit =
          parameters.per_direction_trade_limit !== undefined
            ? Number(parameters.per_direction_trade_limit)
            : parameters.perDirectionTradeLimit !== undefined
            ? Number(parameters.perDirectionTradeLimit)
            : undefined;
        const digestResult = await dailyTradingDigestService.sendDigests({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          trade_date: parameters.trade_date || parameters.tradeDate,
          dry_run: dryRun,
          per_strategy_limit: perStrategyLimit,
          per_direction_trade_limit: perDirectionTradeLimit,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: digestResult.scanned_users,
          completed_items: digestResult.sent_count,
          failed_items: digestResult.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_daily_digest',
            trade_date: digestResult.trade_date,
            scanned_users: digestResult.scanned_users,
            sent_count: digestResult.sent_count,
            skipped_count: digestResult.skipped_count,
            failed_count: digestResult.failed_count,
            dry_run: dryRun,
            per_user_summary: digestResult.per_user.map(u => ({
              user_id: u.user_id,
              username: u.username,
              status: u.status,
              sent: u.sent,
              skip_reason: u.skip_reason,
              error: u.error,
            })),
          },
        });
        logger.info(
          `当日交易日报推送完成。扫描用户 ${digestResult.scanned_users}，` +
            `已发 ${digestResult.sent_count}，跳过 ${digestResult.skipped_count}，` +
            `失败 ${digestResult.failed_count}` +
            (dryRun ? '（dry-run，未实际推送）' : '')
        );
      } else if (task.type === 'EARNINGS_FORECAST_WATCH') {
        // US-064 — 业绩预告即时提醒。`mode` 参数控制走持仓即时 (held) 还是自选
        // 盘后汇总 (watchlist)，缺省 = 'both' (持仓 + 自选都跑)。
        // `user_id` 可选 (扫单用户)；`dry_run`=true 仅预演不推送。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const recentDays =
          parameters.recent_days !== undefined
            ? Number(parameters.recent_days)
            : parameters.recentDays !== undefined
            ? Number(parameters.recentDays)
            : undefined;
        const mode = String(parameters.mode || 'both').toLowerCase();
        const runHeld = mode === 'both' || mode === 'held';
        const runWatchlist = mode === 'both' || mode === 'watchlist';

        const heldResult = runHeld
          ? await earningsForecastWatcher.scanHeldStocks({
              user_id: targetUserId ? Number(targetUserId) : undefined,
              trade_date: parameters.trade_date || parameters.tradeDate,
              dry_run: dryRun,
              recent_days: recentDays,
            })
          : null;
        const watchlistResult = runWatchlist
          ? await earningsForecastWatcher.scanWatchlistStocks({
              user_id: targetUserId ? Number(targetUserId) : undefined,
              trade_date: parameters.trade_date || parameters.tradeDate,
              dry_run: dryRun,
              recent_days: recentDays,
            })
          : null;

        const totalSent = (heldResult?.sent_count ?? 0) + (watchlistResult?.sent_count ?? 0);
        const totalSkipped =
          (heldResult?.skipped_count ?? 0) + (watchlistResult?.skipped_count ?? 0);
        const totalFailed = (heldResult?.failed_count ?? 0) + (watchlistResult?.failed_count ?? 0);
        const totalScanned = Math.max(
          heldResult?.scanned_users ?? 0,
          watchlistResult?.scanned_users ?? 0
        );

        await this.safeUpdateExecutionLog(executionLog, {
          total_items:
            (heldResult?.scanned_forecasts ?? 0) + (watchlistResult?.scanned_forecasts ?? 0),
          completed_items: totalSent,
          failed_items: totalFailed,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'earnings_forecast_watch',
            mode,
            trade_date: heldResult?.trade_date || watchlistResult?.trade_date,
            scanned_users: totalScanned,
            held: heldResult
              ? {
                  scanned_forecasts: heldResult.scanned_forecasts,
                  sent_count: heldResult.sent_count,
                  skipped_count: heldResult.skipped_count,
                  failed_count: heldResult.failed_count,
                  events: heldResult.per_event.map(e => ({
                    event_id: e.event_id,
                    symbol: e.symbol,
                    user_id: e.user_id,
                    status: e.status,
                    sent: e.sent,
                    error: e.error,
                    skip_reason: e.skip_reason,
                  })),
                }
              : null,
            watchlist: watchlistResult
              ? {
                  scanned_forecasts: watchlistResult.scanned_forecasts,
                  sent_count: watchlistResult.sent_count,
                  skipped_count: watchlistResult.skipped_count,
                  failed_count: watchlistResult.failed_count,
                  per_user: watchlistResult.per_user.map(u => ({
                    event_id: u.event_id,
                    user_id: u.user_id,
                    forecast_count: u.forecast_count,
                    status: u.status,
                    sent: u.sent,
                    error: u.error,
                    skip_reason: u.skip_reason,
                  })),
                }
              : null,
            dry_run: dryRun,
          },
        });
        logger.info(
          `业绩预告推送完成。mode=${mode}，已发 ${totalSent}，跳过 ${totalSkipped}，失败 ${totalFailed}` +
            (dryRun ? '（dry-run，未实际推送）' : '')
        );
      } else if (task.type === 'WEEKLY_REVIEW_EMAIL') {
        // US-065 — 每周一 08:00 发上周复盘邮件（HTML, SMTP via env）。
        // `user_id` 可选 (扫单用户)；`dry_run`=true 仅预演不推送；
        // `reference_date` 覆盖基准日（默认 = 上海时区当天）；
        // `upcoming_lookahead_days` 关注事件向后看天数（默认 7）。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const lookahead =
          parameters.upcoming_lookahead_days !== undefined
            ? Number(parameters.upcoming_lookahead_days)
            : parameters.upcomingLookaheadDays !== undefined
            ? Number(parameters.upcomingLookaheadDays)
            : undefined;
        const weeklyResult = await weeklyReviewReportService.sendWeeklyReviewReports({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          reference_date: parameters.reference_date || parameters.referenceDate,
          dry_run: dryRun,
          upcoming_lookahead_days: lookahead,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: weeklyResult.scanned_users,
          completed_items: weeklyResult.sent_count,
          failed_items: weeklyResult.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'weekly_review_email',
            week_start: weeklyResult.week.start_date,
            week_end: weeklyResult.week.end_date,
            week_id: weeklyResult.week.week_id,
            scanned_users: weeklyResult.scanned_users,
            sent_count: weeklyResult.sent_count,
            skipped_count: weeklyResult.skipped_count,
            failed_count: weeklyResult.failed_count,
            dry_run: dryRun,
            per_user_summary: weeklyResult.per_user.map(u => ({
              user_id: u.user_id,
              username: u.username,
              status: u.status,
              sent: u.sent,
              email_used: u.email_used,
              skip_reason: u.skip_reason,
              error: u.error,
            })),
          },
        });
        logger.info(
          `上周复盘邮件推送完成。week=${weeklyResult.week.start_date}~${weeklyResult.week.end_date}，` +
            `扫描用户 ${weeklyResult.scanned_users}，已发 ${weeklyResult.sent_count}，` +
            `跳过 ${weeklyResult.skipped_count}，失败 ${weeklyResult.failed_count}` +
            (dryRun ? '（dry-run，未实际推送）' : '')
        );
      } else if (task.type === 'MARKET_BRIEF_GENERATE') {
        // US-073 — 每个交易日 08:30 生成「AI 大盘速读」当日卡片。
        // 5 维数据：沪深300 上日收盘 / 今日开盘 / 北向资金 / 涨停数 / AI 一句话观点。
        // 写入 market_briefs 表（一日一行 UPSERT），前端 TodayWorkspace 顶部
        // GET /api/ai/market-brief/today 直接读取。
        const tradeDate = parameters.trade_date || parameters.tradeDate || undefined;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const skipAI =
          parameters.skip_ai !== undefined
            ? Boolean(parameters.skip_ai)
            : parameters.skipAi !== undefined
            ? Boolean(parameters.skipAi)
            : false;
        const briefResult = await marketBriefService.computeAndPersist({
          trade_date: tradeDate,
          dry_run: dryRun,
          skip_ai: skipAI,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 5,
          completed_items:
            briefResult.status === 'failed' ? 0 : briefResult.status === 'partial' ? 3 : 5,
          failed_items:
            briefResult.status === 'failed' ? 5 : briefResult.status === 'partial' ? 2 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'market_brief_generate',
            trade_date: briefResult.trade_date,
            status: briefResult.status,
            persisted: briefResult.persisted,
            dry_run: briefResult.dry_run,
            nlp_engine: briefResult.nlp_engine,
            ai_view_chars: briefResult.ai_view ? briefResult.ai_view.length : 0,
            prev_close: briefResult.prev_close,
            today_open: briefResult.today_open,
            open_change_pct: briefResult.open_change_pct,
            northbound_net_amount: briefResult.northbound_net_amount,
            limit_up_count: briefResult.limit_up_count,
            message: briefResult.message,
          },
        });
        logger.info(
          `AI 大盘速读生成完成。trade_date=${briefResult.trade_date} status=${briefResult.status} ` +
            `engine=${briefResult.nlp_engine || '—'} persisted=${briefResult.persisted}` +
            (dryRun ? '（dry-run，未写表）' : '')
        );
      } else if (task.type === 'ENHANCED_TRADING_JOURNAL_GENERATE') {
        // US-087 — 每个交易日 15:30 收盘后批量生成增强版 AI 复盘日记。
        // 5 段 markdown 输出：## 今日战报 / ## 操作复盘 / ## 市场观察 / ## 明日策略 / ## 风险提醒。
        // 写入 trading_journals 表（保留 user_notes 不动）。
        // `user_id` 缺省 = 扫所有 is_active 用户；`overwrite_hand_edited`=true 让 admin force-regen。
        // `dry_run`=true 让 ops 预演 markdown 不实际写表。
        const targetUserId = parameters.user_id || parameters.userId;
        const journalDryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const overwriteHandEdited =
          parameters.overwrite_hand_edited !== undefined
            ? Boolean(parameters.overwrite_hand_edited)
            : parameters.overwriteHandEdited !== undefined
            ? Boolean(parameters.overwriteHandEdited)
            : false;
        const journalSkipAI =
          parameters.skip_ai !== undefined
            ? Boolean(parameters.skip_ai)
            : parameters.skipAi !== undefined
            ? Boolean(parameters.skipAi)
            : false;
        const journalResult = await enhancedTradingJournalService.generateForAll({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          trade_date: parameters.trade_date || parameters.tradeDate,
          dry_run: journalDryRun,
          overwrite_hand_edited: overwriteHandEdited,
          skip_ai: journalSkipAI,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: journalResult.scanned_users,
          completed_items: journalResult.generated_count + journalResult.partial_count,
          failed_items: journalResult.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'enhanced_trading_journal_generate',
            trade_date: journalResult.trade_date,
            scanned_users: journalResult.scanned_users,
            generated_count: journalResult.generated_count,
            partial_count: journalResult.partial_count,
            skipped_count: journalResult.skipped_count,
            failed_count: journalResult.failed_count,
            dry_run: journalDryRun,
            per_user_summary: journalResult.per_user.map(u => ({
              user_id: u.user_id,
              username: u.username,
              status: u.status,
              persisted: u.persisted,
              saved_row_id: u.saved_row_id,
              skip_reason: u.skip_reason,
              error: u.error,
            })),
          },
        });
        logger.info(
          `AI 复盘日记生成完成。trade_date=${journalResult.trade_date} 扫描用户 ${journalResult.scanned_users}，` +
            `生成 ${journalResult.generated_count}，部分 ${journalResult.partial_count}，` +
            `跳过 ${journalResult.skipped_count}，失败 ${journalResult.failed_count}` +
            (journalDryRun ? '（dry-run，未实际写表）' : '')
        );
      } else if (task.type === 'AUTO_RECOMMENDATION_LOOP') {
        const result = await automatedRecommendationLoopService.run({
          username: parameters.username || 'stock',
          ...portfolioParams,
          universe: parameters.universe === 'favorites' ? 'favorites' : 'market',
          style: ['balanced', 'momentum', 'value', 'low_risk'].includes(parameters.style)
            ? parameters.style
            : 'balanced',
          candidate_limit: this.toPositiveInt(parameters.candidate_limit, 30, 100),
          candidate_pool_limit: this.toPositiveInt(parameters.candidate_pool_limit, 360, 1000),
          lookback_days: this.toPositiveInt(parameters.lookback_days, 120, 360),
          min_bars: this.toPositiveInt(parameters.min_bars, 35, 120),
          exclude_st:
            parameters.exclude_st !== undefined
              ? Boolean(parameters.exclude_st)
              : parameters.excludeSt !== undefined
              ? Boolean(parameters.excludeSt)
              : true,
          min_market_cap_yi:
            parameters.min_market_cap_yi !== undefined
              ? Number(parameters.min_market_cap_yi)
              : parameters.minMarketCapYi !== undefined
              ? Number(parameters.minMarketCapYi)
              : 30,
          archive_limit: this.toPositiveInt(parameters.archive_limit, 30, 100),
          verify_signals:
            parameters.verify_signals !== undefined
              ? Boolean(parameters.verify_signals)
              : parameters.verifySignals !== undefined
              ? Boolean(parameters.verifySignals)
              : true,
          run_paper_trading:
            parameters.run_paper_trading !== undefined
              ? Boolean(parameters.run_paper_trading)
              : parameters.runPaperTrading !== undefined
              ? Boolean(parameters.runPaperTrading)
              : true,
          dry_run:
            parameters.dry_run !== undefined
              ? Boolean(parameters.dry_run)
              : parameters.dryRun !== undefined
              ? Boolean(parameters.dryRun)
              : false,
          paper_trade_limit: this.toPositiveInt(parameters.paper_trade_limit, 3, 20),
          paper_trade_scan_limit: this.toPositiveInt(parameters.paper_trade_scan_limit, 150, 500),
          min_score: Number(parameters.min_score || parameters.minScore || 72),
          max_positions: this.toPositiveInt(parameters.max_positions, 8, 30),
          default_position_pct: Number(
            parameters.default_position_pct || parameters.defaultPositionPct || 5
          ),
          max_position_pct: Number(parameters.max_position_pct || parameters.maxPositionPct || 10),
          min_trade_amount: Number(
            parameters.min_trade_amount || parameters.minTradeAmount || 3000
          ),
          use_outcome_feedback:
            parameters.use_outcome_feedback !== undefined
              ? Boolean(parameters.use_outcome_feedback)
              : parameters.useOutcomeFeedback !== undefined
              ? Boolean(parameters.useOutcomeFeedback)
              : true,
          use_policy_version_feedback:
            parameters.use_policy_version_feedback !== undefined
              ? Boolean(parameters.use_policy_version_feedback)
              : parameters.usePolicyVersionFeedback !== undefined
              ? Boolean(parameters.usePolicyVersionFeedback)
              : true,
          policy_version_lookback_limit: this.toPositiveInt(
            parameters.policy_version_lookback_limit || parameters.policyVersionLookbackLimit,
            120,
            1000
          ),
          use_strategy_experiment_feedback:
            parameters.use_strategy_experiment_feedback !== undefined
              ? Boolean(parameters.use_strategy_experiment_feedback)
              : parameters.useStrategyExperimentFeedback !== undefined
              ? Boolean(parameters.useStrategyExperimentFeedback)
              : true,
          strategy_experiment_min_quality_delta: Number(
            parameters.strategy_experiment_min_quality_delta ||
              parameters.strategyExperimentMinQualityDelta ||
              4
          ),
          strategy_experiment_limit: this.toPositiveInt(
            parameters.strategy_experiment_limit || parameters.strategyExperimentLimit,
            12,
            50
          ),
          strategy_experiment_pool_limit: this.toPositiveInt(
            parameters.strategy_experiment_pool_limit || parameters.strategyExperimentPoolLimit,
            240,
            1000
          ),
          outcome_feedback_lookback_days: this.toPositiveInt(
            parameters.outcome_feedback_lookback_days || parameters.outcomeFeedbackLookbackDays,
            365,
            3650
          ),
          outcome_feedback_min_closed_samples: this.toPositiveInt(
            parameters.outcome_feedback_min_closed_samples ||
              parameters.outcomeFeedbackMinClosedSamples,
            5,
            100
          ),
          use_profit_gate:
            parameters.use_profit_gate !== undefined
              ? Boolean(parameters.use_profit_gate)
              : parameters.useProfitGate !== undefined
              ? Boolean(parameters.useProfitGate)
              : true,
          profit_gate_horizon:
            parameters.profit_gate_horizon || parameters.profitGateHorizon || '5d',
          profit_gate_min_samples: this.toPositiveInt(
            parameters.profit_gate_min_samples || parameters.profitGateMinSamples,
            5,
            100
          ),
          profit_gate_min_quality_score: Number(
            parameters.profit_gate_min_quality_score || parameters.profitGateMinQualityScore || 45
          ),
          use_entry_risk_guard:
            parameters.use_entry_risk_guard !== undefined
              ? Boolean(parameters.use_entry_risk_guard)
              : parameters.useEntryRiskGuard !== undefined
              ? Boolean(parameters.useEntryRiskGuard)
              : true,
          max_daily_new_positions: this.toPositiveInt(
            parameters.max_daily_new_positions || parameters.maxDailyNewPositions,
            3,
            20
          ),
          max_daily_new_exposure_pct: Number(
            parameters.max_daily_new_exposure_pct || parameters.maxDailyNewExposurePct || 12
          ),
          max_total_exposure_pct: Number(
            parameters.max_total_exposure_pct || parameters.maxTotalExposurePct || 60
          ),
          max_industry_exposure_pct: Number(
            parameters.max_industry_exposure_pct || parameters.maxIndustryExposurePct || 25
          ),
          min_cash_reserve_pct: Number(
            parameters.min_cash_reserve_pct || parameters.minCashReservePct || 8
          ),
          max_portfolio_drawdown_pct: Number(
            parameters.max_portfolio_drawdown_pct || parameters.maxPortfolioDrawdownPct || 12
          ),
          max_single_stock_volatility_pct: Number(
            parameters.max_single_stock_volatility_pct ||
              parameters.maxSingleStockVolatilityPct ||
              7
          ),
          max_position_correlation: Number(
            parameters.max_position_correlation || parameters.maxPositionCorrelation || 0.82
          ),
          max_portfolio_var_pct: Number(
            parameters.max_portfolio_var_pct || parameters.maxPortfolioVarPct || 10
          ),
          min_avg_turnover_yuan: Number(
            parameters.min_avg_turnover_yuan || parameters.minAvgTurnoverYuan || 30000000
          ),
          cooldown_days_after_loss: this.toPositiveInt(
            parameters.cooldown_days_after_loss || parameters.cooldownDaysAfterLoss,
            12,
            120
          ),
          block_limit_up:
            parameters.block_limit_up !== undefined
              ? Boolean(parameters.block_limit_up)
              : parameters.blockLimitUp !== undefined
              ? Boolean(parameters.blockLimitUp)
              : true,
          block_limit_down:
            parameters.block_limit_down !== undefined
              ? Boolean(parameters.block_limit_down)
              : parameters.blockLimitDown !== undefined
              ? Boolean(parameters.blockLimitDown)
              : true,
          block_suspended:
            parameters.block_suspended !== undefined
              ? Boolean(parameters.block_suspended)
              : parameters.blockSuspended !== undefined
              ? Boolean(parameters.blockSuspended)
              : true,
          agent_auto_paper_trade:
            parameters.agent_auto_paper_trade !== undefined
              ? Boolean(parameters.agent_auto_paper_trade)
              : parameters.agentAutoPaperTrade !== undefined
              ? Boolean(parameters.agentAutoPaperTrade)
              : true,
          agent_only_auto_paper_trade:
            parameters.agent_only_auto_paper_trade !== undefined
              ? Boolean(parameters.agent_only_auto_paper_trade)
              : parameters.agentOnlyAutoPaperTrade !== undefined
              ? Boolean(parameters.agentOnlyAutoPaperTrade)
              : true,
          agent_only_paper_trade_min_score: Number(
            parameters.agent_only_paper_trade_min_score ||
              parameters.agentOnlyPaperTradeMinScore ||
              parameters.agent_min_score ||
              parameters.agentMinScore ||
              72
          ),
          agent_only_paper_trade_max_positions: this.toPositiveInt(
            parameters.agent_only_paper_trade_max_positions ||
              parameters.agentOnlyPaperTradeMaxPositions ||
              parameters.max_positions ||
              parameters.maxPositions,
            8,
            30
          ),
          agent_only_paper_trade_default_position_pct: Number(
            parameters.agent_only_paper_trade_default_position_pct ||
              parameters.agentOnlyPaperTradeDefaultPositionPct ||
              4
          ),
          agent_only_paper_trade_max_position_pct: Number(
            parameters.agent_only_paper_trade_max_position_pct ||
              parameters.agentOnlyPaperTradeMaxPositionPct ||
              8
          ),
          agent_only_paper_trade_min_trade_amount: Number(
            parameters.agent_only_paper_trade_min_trade_amount ||
              parameters.agentOnlyPaperTradeMinTradeAmount ||
              parameters.min_trade_amount ||
              parameters.minTradeAmount ||
              3000
          ),
          submit_agent_analysis:
            parameters.submit_agent_analysis !== undefined
              ? Boolean(parameters.submit_agent_analysis)
              : parameters.submitAgentAnalysis !== undefined
              ? Boolean(parameters.submitAgentAnalysis)
              : true,
          agent_max_count: this.toPositiveInt(parameters.agent_max_count, 5, 10),
          agent_min_score: Number(parameters.agent_min_score || parameters.agentMinScore || 72),
          agent_session: parameters.agent_session || parameters.agentSession || 'close',
          target_date: parameters.target_date || parameters.targetDate || today,
          task_label: task.name,
          execution_log_id: executionLog?.id,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          record_type: parameters.record_type || parameters.recordType || '全市场荐股闭环',
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.generated?.total_candidates || 0,
          completed_items: result.generated?.analyzed_candidates || 0,
          failed_items: result.paper_trading?.skipped || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `全市场荐股闭环完成。候选 ${result.generated?.analyzed_candidates}/${
            result.generated?.total_candidates
          }，归档 ${result.archive?.total}，模拟盘 ${
            result.paper_trading?.executed ?? result.paper_trading?.planned ?? 0
          }`
        );
      } else if (task.type === 'AI_DAILY_SCREENER') {
        logger.info('触发 AI_DAILY_SCREENER 任务，使用多因子候选池进行 TradingAgents 深度分析...');

        const candidateLimit = Math.min(
          Number(parameters.candidate_limit || parameters.limit || 10),
          30
        );
        const universe = parameters.universe === 'market' ? 'market' : 'favorites';
        const style = ['balanced', 'momentum', 'value', 'low_risk'].includes(parameters.style)
          ? parameters.style
          : 'balanced';
        const targetDate = parameters.target_date || today;

        const candidateResult = await quantRecommendationService.generateRecommendations({
          universe,
          style,
          limit: candidateLimit,
          lookback_days: Number(parameters.lookback_days || 120),
          candidate_pool_limit: this.toPositiveInt(parameters.candidate_pool_limit, 240, 1000),
          exclude_st:
            parameters.exclude_st !== undefined
              ? Boolean(parameters.exclude_st)
              : parameters.excludeSt !== undefined
              ? Boolean(parameters.excludeSt)
              : true,
          min_market_cap_yi:
            parameters.min_market_cap_yi !== undefined
              ? Number(parameters.min_market_cap_yi)
              : parameters.minMarketCapYi !== undefined
              ? Number(parameters.minMarketCapYi)
              : 30,
          include_trend: false,
        });

        const candidates = candidateResult.recommendations;
        let count = 0;
        let failed = 0;

        await this.safeUpdateExecutionLog(executionLog, { total_items: candidates.length });

        for (const candidate of candidates) {
          try {
            const res = await aiAdvisorService.analyzeStock(candidate.symbol, targetDate, true);
            if (res && res.task_id) {
              await aiPollingQueue.add(
                {
                  taskId: res.task_id,
                  symbol: candidate.symbol,
                  name: candidate.name,
                  executionLogId: executionLog?.id,
                  taskLabel: task.name,
                  quant_score: candidate.score,
                  quant_factors: candidate.factors,
                  quant_reasons: candidate.reasons,
                  quant_warnings: candidate.warnings,
                  data_quality_score: candidate.data_quality_score,
                  data_quality_bucket: candidate.data_quality_bucket,
                  data_quality: candidate.data_quality,
                  recommendation_style: style,
                  recommendation_source: universe,
                  agent_session: parameters.agent_session,
                },
                {
                  jobId: `ai-poll-${isManual ? 'manual-' : ''}${
                    executionLog?.id ? `log-${executionLog.id}` : `task-${task.id}-no-log`
                  }-${res.task_id}`,
                  attempts: 10,
                  backoff: { type: 'fixed', delay: 3 * 60 * 1000 },
                }
              );
              count++;
            }
          } catch (err: any) {
            logger.error(`提交股票 ${candidate.symbol} 的 AI 分析任务失败:`, err);
            failed++;
          }
        }

        logger.info(
          `AI_DAILY_SCREENER 候选任务提交完成，候选池 ${candidateResult.analyzed_candidates}/${candidateResult.total_candidates}，成功提交 ${count} 个异步分析任务`
        );

        // 状态保留为 IN_PROGRESS，由 bull worker 来更新为 COMPLETED 或 FAILED
        await this.safeUpdateExecutionLog(executionLog, { failed_items: failed });
        // 如果没有成功提交的任务，说明已经结束了
        if (count === 0) {
          await this.safeUpdateExecutionLog(executionLog, {
            status: 'COMPLETED',
            completed_at: new Date(),
          });
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: 'AI定时任务完成',
            task_type: 'AI_DAILY_SCREENER',
            result: { message: '无候选股票成功提交 AI 分析任务', submitted: count, failed },
          });
        }
      } else if (task.type === 'CLEANUP_OLD_DATA') {
        // US-097 — 每周日凌晨 3 点跑旧数据清理:
        //   - quant_backtest_tasks + cascade results/trades (默认 90 天)
        //   - data_update_logs (默认 180 天)
        //   - task_execution_logs (默认 180 天)
        //   - risk_alerts where is_read=true (默认 30 天)
        // 默认 dry_run=false (scheduler 触发是为了真正清理); 手动 CLI 默认
        // dry_run=true (CLI 必须 --confirm 才执行).
        // 白名单 whitelist_strategies 跳过 strategy_keys 交集非空的 backtest task.
        const dryRunForCleanup =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const cleanupResult = await cleanupOldDataService.cleanup({
          backtestRetentionDays:
            parameters.backtest_retention_days ?? parameters.backtestRetentionDays,
          logRetentionDays: parameters.log_retention_days ?? parameters.logRetentionDays,
          alertRetentionDays: parameters.alert_retention_days ?? parameters.alertRetentionDays,
          whitelistStrategies: Array.isArray(parameters.whitelist_strategies)
            ? parameters.whitelist_strategies
            : Array.isArray(parameters.whitelistStrategies)
            ? parameters.whitelistStrategies
            : [],
          dryRun: dryRunForCleanup,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: cleanupResult.targets.length,
          completed_items: cleanupResult.targets.length - cleanupResult.errors.length,
          failed_items: cleanupResult.errors.length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message:
            cleanupResult.errors.length > 0
              ? `${cleanupResult.errors.length} target(s) failed: ${cleanupResult.errors.join(
                  ', '
                )}`
              : null,
          result_summary: {
            scenario: 'cleanup_old_data',
            as_of: cleanupResult.as_of,
            mode: cleanupResult.mode,
            total_count: cleanupResult.total_count,
            total_cascade_count: cleanupResult.total_cascade_count,
            whitelist_skipped_total: cleanupResult.whitelist_skipped_total,
            errors: cleanupResult.errors,
            targets: cleanupResult.targets.map(t => ({
              target: t.target,
              count: t.count,
              cascade_count: t.cascade_count,
              cutoff: t.cutoff,
              executed: t.executed,
              whitelist_skipped: t.whitelist_skipped,
              error: t.error,
            })),
          },
        });
        logger.info(
          `[CLEANUP_OLD_DATA] mode=${cleanupResult.mode} total_count=${cleanupResult.total_count} ` +
            `total_cascade=${cleanupResult.total_cascade_count} ` +
            `whitelist_skipped=${cleanupResult.whitelist_skipped_total} errors=${cleanupResult.errors.length}`
        );
      } else if (task.type === 'EXTRA_DIMS_SYNC') {
        // 新维度同步 — 走 child_process 调用 sync:extra-dims CLI 复用既有逻辑
        const dims: string[] = Array.isArray(parameters.dims)
          ? parameters.dims
          : ['macro', 'qvix', 'block'];
        const blockDays: number = this.toPositiveInt(parameters.block_days, 7, 60);
        const results: Record<string, string> = {};
        const { spawnSync } = require('child_process');
        const path = require('path');
        const scriptPath = path.resolve(__dirname, '..', 'scripts', 'sync-extra-dims.ts');
        for (const dim of dims) {
          const args = [
            'node_modules/.bin/ts-node',
            '--transpile-only',
            scriptPath,
            `--dim=${dim}`,
          ];
          if (dim === 'block') {
            const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
            const start = moment()
              .tz('Asia/Shanghai')
              .subtract(blockDays, 'days')
              .format('YYYY-MM-DD');
            args.push(`--start=${start}`, `--end=${today}`);
          }
          const t0 = Date.now();
          const r = spawnSync('/usr/bin/node', args, {
            cwd: path.resolve(__dirname, '..', '..'),
            encoding: 'utf-8',
            timeout: 10 * 60_000,
            maxBuffer: 64 * 1024 * 1024,
          });
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          if (r.status === 0) {
            results[dim] = `OK ${elapsed}s`;
            logger.info(`[EXTRA_DIMS_SYNC] ${dim} OK ${elapsed}s`);
          } else {
            results[dim] = `FAIL status=${r.status} ${(r.stderr || '').substring(0, 200)}`;
            logger.warn(`[EXTRA_DIMS_SYNC] ${dim} FAIL status=${r.status}`);
          }
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: dims.length,
          success_count: Object.values(results).filter(v => v.startsWith('OK')).length,
          failed_count: Object.values(results).filter(v => !v.startsWith('OK')).length,
          result_summary: { scenario: 'extra_dims_sync', dims, results },
        });
        logger.info(`[EXTRA_DIMS_SYNC] done: ${JSON.stringify(results)}`);
      } else if (task.type === 'FACTOR_SCORE_COMPUTE') {
        // Sprint 40 (你提的优先级 #1): 每日盘后 factor_scores 生成任务.
        // 之前只有 FACTOR_IC_COMPUTE 没有 FACTOR_SCORE_COMPUTE — IC 算的前提是
        // factor_scores 表已生成. 现在加这个 task, cron 配比 IC 早 30 分钟,
        // 确保 IC 跑时 factor_scores 已就位.
        //
        // 调 compute-factors.ts CLI; date 默认今天, factors 空跑全部 20 个.
        const { spawnSync } = require('child_process');
        const path = require('path');
        const scriptPath = path.resolve(__dirname, '..', 'scripts', 'compute-factors.ts');
        const date: string =
          parameters.date ||
          parameters.trade_date ||
          moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const factorNames: string[] = Array.isArray(parameters.factor_names)
          ? parameters.factor_names
          : Array.isArray(parameters.factors)
          ? parameters.factors
          : [];
        const args = [
          'node_modules/.bin/ts-node',
          '--transpile-only',
          scriptPath,
          `--date=${date}`,
        ];
        if (factorNames.length) args.push(`--factors=${factorNames.join(',')}`);
        // 默认 skip 仅在数据缺失时拖整流程的几个事件因子 (用户可在 task params 里 override)
        const skipFactors: string[] = Array.isArray(parameters.skip) ? parameters.skip : [];
        if (skipFactors.length) args.push(`--skip=${skipFactors.join(',')}`);
        const t0 = Date.now();
        const r = spawnSync('/usr/bin/node', args, {
          cwd: path.resolve(__dirname, '..', '..'),
          encoding: 'utf-8',
          timeout: 30 * 60_000, // 20 个 factor × 上千股, 给 30 min 上限
          maxBuffer: 128 * 1024 * 1024,
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const ok = r.status === 0;
        if (ok) {
          logger.info(
            `[FACTOR_SCORE_COMPUTE] done in ${elapsed}s for date=${date} factors=${
              factorNames.length || 'all'
            }`
          );
        } else {
          logger.warn(
            `[FACTOR_SCORE_COMPUTE] failed status=${r.status} after ${elapsed}s: ${(
              r.stderr || ''
            ).substring(0, 200)}`
          );
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: factorNames.length || 1,
          success_count: ok ? factorNames.length || 1 : 0,
          failed_count: ok ? 0 : 1,
          result_summary: {
            scenario: 'factor_score_compute',
            date,
            factor_names: factorNames,
            skip: skipFactors,
            elapsed_seconds: Number(elapsed),
            ok,
          },
        });
      } else if (task.type === 'COMPOSITE_REBALANCE') {
        // Sprint 41-A: 组合级策略 (multi_factor_alpha / ensemble_strategy) 的真实
        // BUY/SELL/HOLD 调仓任务. 读最新一日 QuantSignal (raw_factors.target_portfolio_size>0
        // 标记的 composite-level signals), 对每个 portfolio + 每个 composite strategy
        // 调 CompositeRebalanceService.rebalance() 算 plan.
        //
        // 安全配置 (与 PaperTradingAutomationService 默认值保持一致):
        //   - dry_run 默认 true (只产 plan + persist=true 写 OrderIntent 留审计;
        //     真下单需要单独 cron 或人工审批触发, 避免组合级调仓首次上线就大额洗仓)
        //   - max_per_position_pct=0.12 / max_industry_pct=0.25 / max_daily_turnover_pct=0.4
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          compositeRebalanceService,
          COMPOSITE_REBALANCE_STRATEGY_KEYS,
        } = require('../portfolio/internal/CompositeRebalanceService');
        const { QuantSignal } = require('../models/QuantSignal');
        const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */

        const tradeDate: string =
          parameters.trade_date ||
          parameters.date ||
          moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const dryRun: boolean = parameters.dry_run !== false; // 默认 true
        const persist: boolean = parameters.persist !== false; // 默认 true (审计需要)
        const targetUsername: string = parameters.username || 'stock';

        // 取所有 composite-level signals 当日的 target_portfolio
        const signals = await QuantSignal.findAll({
          where: {
            trade_date: tradeDate,
            strategy_key: { [Op.in]: COMPOSITE_REBALANCE_STRATEGY_KEYS as string[] },
          },
          attributes: ['strategy_key', 'symbol', 'raw_factors'],
        });

        // 按 strategy_key 聚合 target_portfolio (信号本身的 symbol 集合即等于 target)
        const targetByStrategy = new Map<string, string[]>();
        for (const sig of signals as any[]) {
          const arr = targetByStrategy.get(sig.strategy_key) || [];
          arr.push(sig.symbol);
          targetByStrategy.set(sig.strategy_key, arr);
        }

        if (targetByStrategy.size === 0) {
          logger.info(`[COMPOSITE_REBALANCE] ${tradeDate} 无 composite-level signals, 跳过`);
          await this.safeUpdateExecutionLog(executionLog, {
            total_items: 0,
            success_count: 0,
            failed_count: 0,
            result_summary: {
              scenario: 'composite_rebalance',
              trade_date: tradeDate,
              ok: true,
              no_signals: true,
            },
          });
        } else {
          // 找目标 portfolio (优先名为 stock 的 user 的 autonomous portfolio)
          let portfolioId: number | undefined = parameters.portfolio_id;
          if (!portfolioId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { User } = require('../models/User');
              const user = await User.findOne({ where: { username: targetUsername } });
              if (user) {
                const portfolio = await PaperTradingPortfolio.findOne({
                  where: { user_id: (user as any).id },
                  order: [['created_at', 'ASC']],
                });
                portfolioId = portfolio ? (portfolio as any).id : undefined;
              }
            } catch (error: any) {
              logger.warn(
                `[COMPOSITE_REBALANCE] 自动解析 portfolio 失败 (username=${targetUsername}): ${
                  error?.message || error
                }`
              );
            }
          }

          if (!portfolioId) {
            logger.warn(
              `[COMPOSITE_REBALANCE] 找不到 portfolio (username=${targetUsername}, portfolio_id 未配), 跳过`
            );
            await this.safeUpdateExecutionLog(executionLog, {
              total_items: targetByStrategy.size,
              success_count: 0,
              failed_count: targetByStrategy.size,
              result_summary: {
                scenario: 'composite_rebalance',
                trade_date: tradeDate,
                ok: false,
                error: 'portfolio_not_found',
              },
            });
          } else {
            const t0 = Date.now();
            const results: any[] = [];
            for (const [strategyKey, targets] of targetByStrategy) {
              try {
                const result = await compositeRebalanceService.rebalance({
                  portfolio_id: portfolioId,
                  strategy_key: strategyKey,
                  target_portfolio: targets,
                  trade_date: tradeDate,
                  options: {
                    dryRun,
                    persist,
                  },
                });
                results.push({
                  strategy_key: strategyKey,
                  target_count: result.diagnostics.target_count,
                  orders_buy: result.orders.filter((o: any) => o.side === 'BUY').length,
                  orders_sell: result.orders.filter((o: any) => o.side === 'SELL').length,
                  orders_hold: result.orders.filter((o: any) => o.side === 'HOLD').length,
                  filtered_sells: result.filtered_sells.length,
                  capped_per_position: result.capped_per_position_orders,
                  capped_industry: result.capped_industry_orders,
                  capped_turnover: result.capped_turnover_orders,
                  turnover_pct: result.diagnostics.total_turnover_pct,
                  persisted: result.persisted,
                });
                logger.info(
                  `[COMPOSITE_REBALANCE] ${strategyKey} portfolio=${portfolioId}: ${result.diagnostics.message}`
                );
              } catch (error: any) {
                logger.warn(
                  `[COMPOSITE_REBALANCE] ${strategyKey} portfolio=${portfolioId} 失败 (fail-open): ${
                    error?.message || error
                  }`
                );
                results.push({ strategy_key: strategyKey, error: error?.message || String(error) });
              }
            }
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            await this.safeUpdateExecutionLog(executionLog, {
              total_items: results.length,
              success_count: results.filter(r => !r.error).length,
              failed_count: results.filter(r => r.error).length,
              result_summary: {
                scenario: 'composite_rebalance',
                trade_date: tradeDate,
                portfolio_id: portfolioId,
                dry_run: dryRun,
                persist,
                elapsed_seconds: Number(elapsed),
                results,
              },
            });
          }
        }
      } else if (task.type === 'FACTOR_IC_COMPUTE') {
        // Phase 3: 每日因子 IC 计算 — 走 child_process 调用 compute-factor-ic CLI
        // 默认跑过去 90 天 + 默认 forwardDays=[1,5,10,20,60]，覆盖 5 个时间窗口的衰减分析
        const { spawnSync } = require('child_process');
        const path = require('path');
        const scriptPath = path.resolve(__dirname, '..', 'scripts', 'compute-factor-ic.ts');
        const lookbackDays: number = this.toPositiveInt(parameters.lookback_days, 90, 365);
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const start = moment()
          .tz('Asia/Shanghai')
          .subtract(lookbackDays, 'days')
          .format('YYYY-MM-DD');
        const factorNames: string[] = Array.isArray(parameters.factor_names)
          ? parameters.factor_names
          : []; // 空 → CLI 跑全部
        const args = [
          'node_modules/.bin/ts-node',
          '--transpile-only',
          scriptPath,
          `--start=${start}`,
          `--end=${today}`,
        ];
        if (factorNames.length) args.push(`--factors=${factorNames.join(',')}`);
        const t0 = Date.now();
        const r = spawnSync('/usr/bin/node', args, {
          cwd: path.resolve(__dirname, '..', '..'),
          encoding: 'utf-8',
          timeout: 30 * 60_000, // IC 计算可能跑 5-15 分钟
          maxBuffer: 128 * 1024 * 1024,
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const ok = r.status === 0;
        if (ok) {
          logger.info(
            `[FACTOR_IC_COMPUTE] done in ${elapsed}s for ${
              factorNames.length || 'all'
            } factors over ${start}..${today}`
          );
        } else {
          logger.warn(
            `[FACTOR_IC_COMPUTE] failed status=${r.status} after ${elapsed}s: ${(
              r.stderr || ''
            ).substring(0, 200)}`
          );
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: factorNames.length || 1,
          success_count: ok ? factorNames.length || 1 : 0,
          failed_count: ok ? 0 : 1,
          result_summary: {
            scenario: 'factor_ic_compute',
            lookback_days: lookbackDays,
            range: `${start}..${today}`,
            factor_names: factorNames,
            elapsed_seconds: Number(elapsed),
            exit_status: r.status,
          },
        });
      } else if (task.type === 'DRAGON_TIGER_SYNC') {
        // 龙虎榜独立 cron — 收盘后 16:30 拉今日（如有上榜）
        const { spawnSync } = require('child_process');
        const path = require('path');
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const start = parameters.start || today;
        const end = parameters.end || today;
        const scriptPath = path.resolve(__dirname, '..', 'scripts', 'sync-dragon-tiger.ts');
        const args = [
          'node_modules/.bin/ts-node',
          '--transpile-only',
          scriptPath,
          `--start=${start}`,
          `--end=${end}`,
        ];
        const t0 = Date.now();
        const r = spawnSync('/usr/bin/node', args, {
          cwd: path.resolve(__dirname, '..', '..'),
          encoding: 'utf-8',
          timeout: 10 * 60_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const ok = r.status === 0;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 1,
          success_count: ok ? 1 : 0,
          failed_count: ok ? 0 : 1,
          result_summary: {
            scenario: 'dragon_tiger_sync',
            start,
            end,
            elapsed_s: elapsed,
            status: r.status,
          },
        });
        logger.info(`[DRAGON_TIGER_SYNC] ${start}~${end} ${ok ? 'OK' : 'FAIL'} ${elapsed}s`);
      } else if (task.type === 'PAPER_TRADING_DAILY_SNAPSHOT') {
        // 收盘后给所有 paper_trading_portfolio 生成日 snapshot
        // 让"昨日盈亏 / 当月收益 / 最大回撤" 能正常显示历史
        const {
          paperTradingAutomationService,
        } = require('../portfolio/internal/PaperTradingAutomationService');
        const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
        const portfolios = await PaperTradingPortfolio.findAll({
          where: { is_active: true },
          attributes: ['id', 'user_id'],
          raw: true,
        });
        let ok = 0,
          failed = 0;
        for (const p of portfolios as any[]) {
          try {
            await paperTradingAutomationService.syncLatestPricesAndSnapshot(p.id);
            ok++;
          } catch (e: any) {
            logger.warn(
              `[PAPER_TRADING_DAILY_SNAPSHOT] portfolio=${p.id} FAIL: ${e?.message || e}`
            );
            failed++;
          }
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: portfolios.length,
          success_count: ok,
          failed_count: failed,
          result_summary: {
            scenario: 'paper_trading_daily_snapshot',
            total: portfolios.length,
            ok,
            failed,
          },
        });
        logger.info(`[PAPER_TRADING_DAILY_SNAPSHOT] ${ok}/${portfolios.length} OK`);
      } else {
        throw new Error(`Unsupported task type: ${task.type}`);
      }

      await this.markTaskFinished(task, 'SUCCESS');
      return { success: true, message: 'Task executed successfully' };
    } catch (error: any) {
      logger.error(`Error executing task ${task.name}:`, error);
      await this.markTaskFinished(task, 'FAILED', executionLog, error);
      throw error;
    }
  }

  async executeTask(id: number) {
    const task = await ScheduledTask.findByPk(id);
    if (!task) throw new Error('Task not found');

    logger.info(`Manually triggering task ${task.id} (${task.name})`);
    return await this._executeTaskLogic(task, true);
  }

  async applyLiveShadowBudgetSuggestion(
    options: {
      audit_id?: number;
      dry_run?: boolean;
      operator?: { user_id?: number; username?: string };
    } = {}
  ) {
    const dryRun = options.dry_run !== false;
    const audit = options.audit_id
      ? await taskParameterAuditService
          .list({
            event_type: LIVE_AUDIT_EVENT_TYPES.SHADOW_BUDGET_SUGGESTION,
            limit: 100,
            watched_only: false,
          })
          .then(rows => rows.find((row: any) => Number(row.id) === Number(options.audit_id)))
      : await taskParameterAuditService
          .list({
            event_type: LIVE_AUDIT_EVENT_TYPES.SHADOW_BUDGET_SUGGESTION,
            limit: 1,
            watched_only: false,
          })
          .then(rows => rows[0] as any);

    if (!audit) throw new Error('未找到影子预算候选补丁');
    if (audit.event_type !== 'live_shadow_budget_suggestion') {
      throw new Error('只能应用影子预算候选补丁');
    }

    const task = await ScheduledTask.findOne({
      where: { id: Number((audit as any).task_id), type: 'LIVE_SHADOW_AUTOPILOT' },
    });
    if (!task) throw new Error('目标影子执行任务不存在或类型不匹配');

    const beforeParameters = { ...((task as any).parameters || {}) };
    const suggested = { ...((audit as any).after_parameters || {}) };
    const recommendedLimit = Number(suggested.limit);
    if (!Number.isInteger(recommendedLimit) || recommendedLimit < 1 || recommendedLimit > 10) {
      throw new Error(`影子预算 limit 必须在 1-10 之间，当前建议为 ${suggested.limit}`);
    }

    const afterParameters = {
      ...beforeParameters,
      limit: recommendedLimit,
      shadow_budget_advice: {
        ...(suggested.shadow_budget_advice || {}),
        applied: !dryRun,
        applied_at: dryRun ? undefined : new Date().toISOString(),
        applied_by: dryRun ? undefined : options.operator?.username || options.operator?.user_id,
        source_audit_id: Number((audit as any).id),
      },
    };
    const changedKeys = taskParameterAuditService.buildChangedKeys(
      beforeParameters,
      afterParameters,
      ['limit', 'shadow_budget_advice']
    );
    const result = {
      dry_run: dryRun,
      applied: false,
      audit_id: Number((audit as any).id),
      target_task_id: Number((task as any).id),
      target_task_name: (task as any).name,
      current_limit: Number(beforeParameters.limit || 0),
      suggested_limit: recommendedLimit,
      changed_keys: changedKeys,
      before_parameters: beforeParameters,
      suggested_parameters: afterParameters,
      message: changedKeys.length
        ? dryRun
          ? `影子预算候选补丁可应用：limit ${beforeParameters.limit ?? '-'} → ${recommendedLimit}。`
          : `影子预算候选补丁已应用：limit ${beforeParameters.limit ?? '-'} → ${recommendedLimit}。`
        : '影子预算任务参数已与候选补丁一致，无需更新。',
    };

    if (!dryRun && changedKeys.length > 0) {
      await task.update({ parameters: afterParameters });
      await taskParameterAuditService.record({
        task,
        event_type: LIVE_AUDIT_EVENT_TYPES.SHADOW_BUDGET_APPLIED,
        before_parameters: beforeParameters,
        after_parameters: afterParameters,
        changed_keys: changedKeys,
        operator: options.operator,
        metadata: {
          source: 'live_shadow_budget_suggestion_apply',
          source_audit_id: Number((audit as any).id),
          real_order_submitted: 0,
          note: '仅应用影子执行任务预算参数，不触发真实券商委托。',
        },
      });
      await this.reloadTask(Number((task as any).id));
      result.applied = true;
    }

    return result;
  }

  async reloadTask(taskId: number) {
    const task = await ScheduledTask.findByPk(taskId);
    if (!task) return;

    if (task.is_active) {
      this.scheduleTask(task);
    } else {
      if (this.activeTasks.has(task.id)) {
        this.activeTasks.get(task.id)?.stop();
        this.activeTasks.delete(task.id);
        logger.info(`Stopped scheduled task ${task.id}`);
      }
    }
  }

  async getAllTasks() {
    return await ScheduledTask.findAll({ order: [['id', 'ASC']] });
  }

  async reconcileStaleRunningTasks() {
    const staleBefore = moment().subtract(6, 'hours').toDate();
    const [taskCount, logCount] = await Promise.all([
      ScheduledTask.update(
        { last_run_status: 'FAILED' },
        {
          where: {
            last_run_status: 'RUNNING',
            last_run_at: { [Op.lt]: staleBefore },
          },
        }
      ),
      TaskExecutionLog.update(
        {
          status: 'FAILED',
          completed_at: new Date(),
          error_message: '任务长时间处于运行中，系统启动时自动标记为失败',
        },
        {
          where: {
            status: 'IN_PROGRESS',
            started_at: { [Op.lt]: staleBefore },
          },
        }
      ),
    ]);

    const updatedTasks = Array.isArray(taskCount) ? taskCount[0] : taskCount;
    const updatedLogs = Array.isArray(logCount) ? logCount[0] : logCount;
    if (updatedTasks || updatedLogs) {
      logger.warn(
        `Reconciled stale scheduler states. tasks=${updatedTasks || 0}, logs=${updatedLogs || 0}`
      );
    }
  }

  async ensureDefaultTasks() {
    const defaultTasks = [
      {
        name: '每日行情增量同步',
        type: 'DAILY_UPDATE',
        cron_expression: '10 17 * * 1-5',
        is_active: true,
        parameters: {
          force_update: false,
          max_stocks: 300,
        },
      },
      {
        name: '全量股票日线同步',
        type: 'SYNC_HISTORY',
        cron_expression: '0 18 * * 1-5',
        is_active: true,
        parameters: {
          syncAllStocks: true,
          lookback_days: 10,
          dataSource: 'tencent_only',
          concurrency: 5,
          batch_limit: 300,
          lag_days_threshold: 0,
          stale_first: true,
        },
      },
      {
        name: '基准指数行情同步',
        type: 'BENCHMARK_INDEX_SYNC',
        cron_expression: '5 15 * * 1-5',
        is_active: true,
        parameters: {
          lookback_days: 180,
          data_source: 'tencent_only',
          concurrency: 2,
          report_to_feishu: true,
        },
      },
      {
        name: '实盘影子执行闭环',
        type: 'LIVE_SHADOW_AUTOPILOT',
        cron_expression: '58 9 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          limit: 2,
          outcome_limit: 30,
          horizons: [1, 3, 5],
          source: 'scheduled_open_shadow_autopilot',
          require_opening_readiness: true,
          allow_degraded_readiness: true,
          factor_limit: 220,
          cache_ttl_ms: 90_000,
          dry_run: false,
          report_to_feishu: true,
          notify_to_feishu_bot: false,
          record_type: '实盘影子执行闭环',
        },
      },
      {
        name: '影子执行周度复盘',
        type: 'LIVE_SHADOW_WEEKLY_REVIEW',
        cron_expression: '20 16 * * 5',
        is_active: true,
        parameters: {
          username: 'stock',
          outcome_limit: 80,
          horizons: [1, 3, 5],
          report_to_feishu: true,
          notify_to_feishu_bot: false,
          record_type: '影子执行周度复盘',
        },
      },
      {
        name: '量化参数后验维护',
        type: 'QUANT_PARAM_MAINTENANCE',
        cron_expression: '45 16 * * 1-5',
        is_active: true,
        parameters: {
          lookback_days: 21,
          horizons: [1, 3, 5, 10],
          signal: ['buy', 'watch'],
          limit: 1500,
          refresh_limit: 5000,
          lifecycle_limit: 5000,
          auto_sync_benchmark: false,
          dry_run_lifecycle: false,
          report_to_feishu: true,
          notify_to_feishu_bot: false,
          record_type: '量化参数后验维护',
        },
      },
      {
        name: '实时行情快照刷新',
        type: 'REALTIME_QUOTE_SYNC',
        cron_expression: '5,25 9,10,13,14 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'market',
          limit: 360,
          source: 'auto',
          batch_size: 300,
          report_to_feishu: false,
          notify_to_feishu_bot: false,
          record_type: '实时行情快照刷新',
        },
      },
      {
        name: '量化策略全市场扫描',
        type: 'QUANT_DAILY_PIPELINE',
        cron_expression: '32 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          strategy_keys: [
            'multi_factor_ranking',
            'relative_strength_momentum',
            'ma_trend',
            'volume_price_confirmation',
            'low_volatility_quality',
            // Sprint 40 #2: 组合级策略 (generateSignals 入口) 加入每日 pipeline.
            // QuantSignalService 内部识别这两个 key,跳过 per-stock evaluate loop,
            // 单独调它们的 generateSignals(date) 把 target_portfolio 转成 QuantSignal
            // 行入库,让 archive / agent / paper trading 闸门像消费其他 5 个 per-stock
            // 策略一样消费它们的信号. 用 dist 分位映射 score 到 [60,95] 保证稳定进闸门.
            'multi_factor_alpha',
            'ensemble_strategy',
          ],
          lookback_days: 180,
          candidate_limit: 220,
          refresh_realtime_quotes: true,
          sync_factors_before_scan: true,
          factor_sync_scope: 'market',
          factor_sync_limit: 360,
          factor_provider: 'auto',
          factor_sync_skip_if_coverage_rate_gte: 92,
          factor_sync_skip_if_real_provider_rate_gte: 65,
          quote_sync_limit: 360,
          realtime_quote_source: 'auto',
          min_score: 70,
          archive_limit: 20,
          max_industry_candidates: 3,
          max_strategy_candidates: 5,
          submit_agent_analysis: true,
          agent_max_count: 5,
          agent_min_score: 76,
          agent_paper_trade_min_score: 68,
          agent_session: 'close',
          agent_auto_paper_trade: true,
          run_paper_trading: true,
          dry_run: false,
          paper_trade_limit: 2,
          paper_trade_scan_limit: 100,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          strategy_weight_lookback_days: 365,
          use_entry_risk_guard: true,
          max_daily_new_positions: 2,
          max_daily_new_exposure_pct: 8,
          max_total_exposure_pct: 60,
          max_industry_exposure_pct: 25,
          min_cash_reserve_pct: 8,
          max_portfolio_drawdown_pct: 12,
          max_single_stock_volatility_pct: 7,
          max_position_correlation: 0.82,
          max_portfolio_var_pct: 10,
          min_avg_turnover_yuan: 30000000,
          cooldown_days_after_loss: 12,
          use_experiment_params: true,
          experiment_param_policy: {
            min_rank_score: 8,
            min_excess_return_pct: 0,
            min_trade_count: 1,
            max_drawdown_pct: 35,
            min_stable_count: 1,
          },
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          block_buy_on_runtime_risk: true,
          risk_threshold_stability_min_consecutive_same_action: 2,
          risk_threshold_stability_min_actionable_samples: 2,
          risk_threshold_stability_min_protected_runs: 3,
          risk_threshold_stability_tighten_min_delta_pct: 0.5,
          risk_threshold_stability_relax_max_delta_pct: -0.8,
          risk_threshold_field_stability_min_consecutive_same_action: 2,
          risk_threshold_field_min_confidence: 0.45,
          risk_threshold_field_min_sample_count: 3,
          risk_threshold_field_min_triggered_count: 1,
          report_to_feishu: true,
          notify_to_feishu_bot: true,
          record_type: '量化策略全市场扫描',
        },
      },
      {
        name: '量化策略开盘机会扫描',
        type: 'QUANT_DAILY_PIPELINE',
        cron_expression: '35 9 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          strategy_keys: [
            'multi_factor_ranking',
            'relative_strength_momentum',
            'ma_trend',
            'volume_price_confirmation',
            'low_volatility_quality',
            // Sprint 40 #2: 组合级策略也加入开盘扫描. 这俩策略 evaluate() 是 hold,
            // 真入口 generateSignals(date) 由 QuantSignalService 内部 dispatcher 调用,
            // 输出转 QuantSignalResult 拼回主 signals 数组共享 archive/paper trading 闸门.
            'multi_factor_alpha',
            'ensemble_strategy',
          ],
          lookback_days: 180,
          candidate_limit: 220,
          refresh_realtime_quotes: true,
          sync_factors_before_scan: true,
          factor_sync_scope: 'market',
          factor_sync_limit: 360,
          factor_provider: 'auto',
          factor_sync_skip_if_coverage_rate_gte: 92,
          factor_sync_skip_if_real_provider_rate_gte: 65,
          quote_sync_limit: 360,
          realtime_quote_source: 'auto',
          min_score: 70,
          archive_limit: 20,
          max_industry_candidates: 3,
          max_strategy_candidates: 5,
          submit_agent_analysis: true,
          agent_max_count: 5,
          agent_min_score: 76,
          agent_paper_trade_min_score: 68,
          agent_session: 'open',
          agent_auto_paper_trade: true,
          run_paper_trading: true,
          dry_run: false,
          paper_trade_limit: 2,
          paper_trade_scan_limit: 100,
          max_positions: 8,
          default_position_pct: 4,
          max_position_pct: 8,
          min_trade_amount: 3000,
          strategy_weight_lookback_days: 365,
          use_entry_risk_guard: true,
          max_daily_new_positions: 2,
          max_daily_new_exposure_pct: 8,
          max_total_exposure_pct: 60,
          max_industry_exposure_pct: 25,
          min_cash_reserve_pct: 8,
          max_portfolio_drawdown_pct: 12,
          max_single_stock_volatility_pct: 7,
          max_position_correlation: 0.82,
          max_portfolio_var_pct: 10,
          min_avg_turnover_yuan: 30000000,
          cooldown_days_after_loss: 12,
          use_experiment_params: true,
          experiment_param_policy: {
            min_rank_score: 8,
            min_excess_return_pct: 0,
            min_trade_count: 1,
            max_drawdown_pct: 35,
            min_stable_count: 1,
          },
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          block_buy_on_runtime_risk: true,
          risk_threshold_stability_min_consecutive_same_action: 2,
          risk_threshold_stability_min_actionable_samples: 2,
          risk_threshold_stability_min_protected_runs: 3,
          risk_threshold_stability_tighten_min_delta_pct: 0.5,
          risk_threshold_stability_relax_max_delta_pct: -0.8,
          risk_threshold_field_stability_min_consecutive_same_action: 2,
          risk_threshold_field_min_confidence: 0.45,
          risk_threshold_field_min_sample_count: 3,
          risk_threshold_field_min_triggered_count: 1,
          report_to_feishu: true,
          notify_to_feishu_bot: true,
          record_type: '量化策略开盘机会扫描',
        },
      },
      {
        name: '量化开盘链路看门狗',
        type: 'QUANT_OPEN_WATCHDOG',
        cron_expression: '55 9 * * 1-5',
        is_active: true,
        parameters: {
          target_task_name: '量化策略开盘机会扫描',
          expected_after_time: '09:35',
          latest_allowed_minutes: 15,
          min_quant_signals: 1,
          min_archived_signals: 1,
          require_fresh_quote: true,
          freshness_max_minutes: 75,
          report_to_feishu: true,
          notify_to_feishu_bot: true,
          record_type: '量化开盘链路看门狗',
        },
      },
      {
        name: 'AI优选-早盘分析',
        type: 'AI_DAILY_SCREENER',
        cron_expression: '0 9 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'favorites',
          style: 'balanced',
          candidate_limit: 10,
          lookback_days: 120,
        },
      },
      {
        name: 'AI优选-午盘分析',
        type: 'AI_DAILY_SCREENER',
        cron_expression: '30 12 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'favorites',
          style: 'balanced',
          candidate_limit: 10,
          lookback_days: 120,
        },
      },
      {
        name: 'AI优选-收盘分析',
        type: 'AI_DAILY_SCREENER',
        cron_expression: '30 14 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'favorites',
          style: 'balanced',
          candidate_limit: 10,
          lookback_days: 120,
          agent_session: 'close',
        },
      },
      {
        name: '全市场AI机会扫描',
        type: 'AI_DAILY_SCREENER',
        cron_expression: '35 14 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'market',
          style: 'balanced',
          candidate_limit: 8,
          lookback_days: 120,
          agent_session: 'close',
        },
      },
      {
        name: '全市场荐股闭环',
        type: 'AUTO_RECOMMENDATION_LOOP',
        cron_expression: '45 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          style: 'balanced',
          candidate_limit: 30,
          candidate_pool_limit: 360,
          lookback_days: 120,
          min_bars: 35,
          exclude_st: true,
          min_market_cap_yi: 30,
          archive_limit: 30,
          verify_signals: true,
          run_paper_trading: true,
          dry_run: false,
          paper_trade_limit: 3,
          paper_trade_scan_limit: 150,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          use_outcome_feedback: true,
          use_policy_version_feedback: true,
          policy_version_lookback_limit: 120,
          use_strategy_experiment_feedback: true,
          strategy_experiment_min_quality_delta: 4,
          strategy_experiment_limit: 12,
          strategy_experiment_pool_limit: 240,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_min_closed_samples: 5,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          use_entry_risk_guard: true,
          max_daily_new_positions: 3,
          max_daily_new_exposure_pct: 12,
          max_total_exposure_pct: 60,
          max_industry_exposure_pct: 25,
          min_cash_reserve_pct: 8,
          max_portfolio_drawdown_pct: 12,
          max_single_stock_volatility_pct: 7,
          max_position_correlation: 0.82,
          max_portfolio_var_pct: 10,
          risk_threshold_stability_min_consecutive_same_action: 2,
          risk_threshold_stability_min_actionable_samples: 2,
          risk_threshold_stability_min_protected_runs: 3,
          risk_threshold_stability_tighten_min_delta_pct: 0.5,
          risk_threshold_stability_relax_max_delta_pct: -0.8,
          risk_threshold_field_stability_min_consecutive_same_action: 2,
          risk_threshold_field_min_confidence: 0.45,
          risk_threshold_field_min_sample_count: 3,
          risk_threshold_field_min_triggered_count: 1,
          min_avg_turnover_yuan: 30000000,
          cooldown_days_after_loss: 12,
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          agent_auto_paper_trade: true,
          agent_only_paper_trade_min_score: 45,
          submit_agent_analysis: true,
          agent_max_count: 5,
          agent_min_score: 72,
          agent_session: 'close',
          report_to_feishu: true,
          record_type: '全市场荐股闭环',
        },
      },
      {
        name: '推荐绩效后验刷新',
        type: 'SIGNAL_PERFORMANCE_REFRESH',
        cron_expression: '20 15 * * 1-5',
        is_active: true,
        parameters: {
          limit: 500,
          report_to_feishu: true,
        },
      },
      {
        name: 'Agent尾盘建议收益追踪',
        type: 'SIGNAL_PERFORMANCE_REFRESH',
        cron_expression: '25 15 * * 1-5',
        is_active: true,
        parameters: {
          source_type: 'tradingagents',
          agent_session: 'close',
          horizon: '5d',
          limit: 1000,
          record_type: 'Agent尾盘建议收益追踪',
          auto_repair_missing_data: true,
          data_source: 'tencent_only',
          lookback_days: 15,
          sync_concurrency: 2,
          report_to_feishu: true,
        },
      },
      {
        name: '信号质量日报',
        type: 'SIGNAL_QUALITY_DAILY_REPORT',
        cron_expression: '30 16 * * 1-5',
        is_active: true,
        parameters: {
          horizon: '5d',
          lookback_days: 30,
          min_samples: 5,
          limit: 5000,
          auto_repair_missing_data: true,
          data_source: 'tencent_only',
          repair_lookback_days: 30,
          sync_concurrency: 2,
          verify_before_report: true,
          report_to_feishu: true,
          record_type: '信号质量日报',
        },
      },
      {
        name: '推荐信号模拟盘跟单',
        type: 'PAPER_TRADING_AUTO_SYNC',
        cron_expression: '40 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          refresh_recommendations: true,
          universe: 'favorites',
          style: 'balanced',
          candidate_limit: 20,
          lookback_days: 120,
          source_type: 'quant_recommendation',
          limit: 3,
          scan_limit: 100,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          allowed_risk_levels: ['low', 'medium'],
          require_action_buy: true,
          use_attribution_feedback: true,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          profit_gate_allow_deprioritized: false,
          profit_gate_allow_sampling: true,
          profit_gate_sampling_multiplier: 0.35,
          use_outcome_feedback: true,
          outcome_feedback_min_closed_samples: 5,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_limit: 2000,
          dry_run: false,
          report_to_feishu: true,
        },
      },
      {
        name: 'Agent尾盘建议模拟盘跟单',
        type: 'PAPER_TRADING_AUTO_SYNC',
        cron_expression: '42 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          refresh_recommendations: false,
          source_type: 'tradingagents',
          agent_session: 'close',
          limit: 2,
          scan_limit: 80,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 4,
          max_position_pct: 8,
          min_trade_amount: 3000,
          allowed_risk_levels: ['low', 'medium'],
          require_action_buy: false,
          use_attribution_feedback: true,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          profit_gate_allow_deprioritized: false,
          profit_gate_allow_sampling: true,
          profit_gate_sampling_multiplier: 0.35,
          use_outcome_feedback: true,
          outcome_feedback_min_closed_samples: 5,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_limit: 2000,
          dry_run: false,
          report_to_feishu: true,
        },
      },
      {
        name: '模拟盘风控退出检查',
        type: 'PAPER_TRADING_RISK_CHECK',
        cron_expression: '50 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          limit: 30,
          enable_stop_loss: true,
          enable_take_profit: true,
          enable_trailing_take_profit: true,
          enable_sell_signals: true,
          use_adaptive_risk_policy: true,
          adaptive_risk_lookback_days: 180,
          adaptive_risk_min_closed_samples: 5,
          adaptive_risk_override_signal_params: false,
          default_stop_loss_pct: 7,
          default_take_profit_pct: 14,
          trailing_activation_pct: 8,
          trailing_drawdown_pct: 4,
          max_hold_days: 20,
          min_sell_signal_score: 60,
          sell_signal_source_type: 'all',
          dry_run: false,
          report_to_feishu: true,
        },
      },
      {
        name: '模拟盘收益归因报告',
        type: 'PAPER_TRADING_ATTRIBUTION_REPORT',
        cron_expression: '5 16 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          include_open: true,
          limit: 2000,
          report_to_feishu: true,
        },
      },
      {
        name: '推荐交易收益闭环刷新',
        type: 'RECOMMENDATION_TRADE_OUTCOME_REFRESH',
        cron_expression: '2 16 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          include_open: true,
          lookback_days: 180,
          limit: 2000,
          report_to_feishu: true,
        },
      },
      {
        name: '模拟盘交易计划报告',
        type: 'PAPER_TRADING_DAILY_PLAN',
        cron_expression: '10 16 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          include_entries: true,
          include_exits: true,
          include_monitor: true,
          source_type: 'quant_recommendation',
          limit: 30,
          entry_limit: 3,
          scan_limit: 100,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          allowed_risk_levels: ['low', 'medium'],
          use_attribution_feedback: true,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          profit_gate_allow_deprioritized: false,
          profit_gate_allow_sampling: true,
          profit_gate_sampling_multiplier: 0.35,
          use_outcome_feedback: true,
          outcome_feedback_min_closed_samples: 5,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_limit: 2000,
          enable_stop_loss: true,
          enable_take_profit: true,
          enable_trailing_take_profit: true,
          enable_sell_signals: true,
          use_adaptive_risk_policy: true,
          adaptive_risk_lookback_days: 180,
          adaptive_risk_min_closed_samples: 5,
          adaptive_risk_override_signal_params: false,
          default_stop_loss_pct: 7,
          default_take_profit_pct: 14,
          trailing_activation_pct: 8,
          trailing_drawdown_pct: 4,
          max_hold_days: 20,
          min_sell_signal_score: 60,
          sell_signal_source_type: 'all',
          report_to_feishu: true,
          capture_canary_snapshot: true,
        },
      },
      {
        // US-063 — 每个交易日 15:30 给所有 notification_channels.feishu.daily_digest=true
        // 的用户发飞书 interactive card 日报。
        name: '飞书当日交易日报',
        type: 'PAPER_TRADING_DAILY_DIGEST',
        cron_expression: '30 15 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          per_strategy_limit: 5,
          per_direction_trade_limit: 3,
        },
      },
      {
        // US-064 — 业绩预告即时提醒（持仓 path）。每 15 分钟跑一次仅扫持仓股，
        // 命中即时推送（dedup buffer 防重复）。
        name: '业绩预告持仓即时提醒',
        type: 'EARNINGS_FORECAST_WATCH',
        cron_expression: '*/15 9-15 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          mode: 'held',
          recent_days: 7,
        },
      },
      {
        // US-064 — 业绩预告自选股盘后汇总（watchlist path）。每个交易日 15:35
        // 跑一次（晚 daily-digest 5min），单 user 一条 digest card 汇总所有
        // 自选股当日新预告。
        name: '业绩预告自选盘后汇总',
        type: 'EARNINGS_FORECAST_WATCH',
        cron_expression: '35 15 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          mode: 'watchlist',
          recent_days: 7,
        },
      },
      {
        // US-065 — 每周一 08:00 给所有 notification_channels.email.weekly_review=true
        // 的用户发上周 (周一-周日) 策略复盘 HTML 邮件 (PnL / 行业贡献 / 关注事件 /
        // AI 周观点)。SMTP 通过 SMTP_HOST/PORT/USER/PASS/SECURE/FROM env 配置。
        name: '邮件周度策略复盘',
        type: 'WEEKLY_REVIEW_EMAIL',
        cron_expression: '0 8 * * 1',
        is_active: true,
        parameters: {
          dry_run: false,
          upcoming_lookahead_days: 7,
        },
      },
      {
        // US-073 — 每个交易日 08:30 (开盘前 30 分钟) 生成「AI 大盘速读」当日卡片。
        // 5 维数据：沪深300 上日收盘 / 今日开盘 / 北向资金 / 涨停数 / AI 一句话观点。
        // 写入 market_briefs 表（一日一行 UPSERT），前端 TodayWorkspace 顶部
        // GET /api/ai/market-brief/today 直接读取；首次访问 / cron miss 时会
        // 通过 getTodayBrief 触发懒求值兜底。
        name: 'AI 大盘速读日度生成',
        type: 'MARKET_BRIEF_GENERATE',
        cron_expression: '30 8 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          skip_ai: false,
        },
      },
      {
        // US-087 — 每个交易日 15:40 收盘后批量生成增强版 AI 复盘日记。
        // 5 段 markdown 输出（今日战报 / 操作复盘 / 市场观察 / 明日策略 / 风险提醒），
        // 写入 trading_journals 表，保留用户已追加的 user_notes 不动。
        // 默认 overwrite_hand_edited=false 不覆盖用户手编版本。
        // 时间晚于 daily_digest (15:30) 与 earnings_forecast watchlist (15:35)，
        // 让 journal 能反映当日已生成的 digest / 业绩告警状态。
        name: 'AI 复盘日记日度生成',
        type: 'ENHANCED_TRADING_JOURNAL_GENERATE',
        cron_expression: '40 15 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          overwrite_hand_edited: false,
          skip_ai: false,
        },
      },
      {
        // US-097 — 每周日凌晨 3 点清理 90 天前回测 / 180 天前日志 / 30 天前已读告警。
        // dry_run=false → scheduler 触发是为了真正删 (CLI 手动入口默认 dry-run + --confirm 才删).
        // whitelist_strategies 默认 [] (不豁免); 维护者可加 'multi_factor_alpha' 等保留长期对照样本.
        name: '旧数据清理',
        type: 'CLEANUP_OLD_DATA',
        cron_expression: '0 3 * * 0',
        is_active: true,
        parameters: {
          backtest_retention_days: 90,
          log_retention_days: 180,
          alert_retention_days: 30,
          whitelist_strategies: [],
          dry_run: false,
          report_to_feishu: true,
        },
      },
      {
        // 新维度数据同步（宏观/期权波动率/大宗交易）
        // 每个交易日盘后 16:30 跑，足够覆盖当日宏观/QVIX 更新
        // fund 维度需要 --year 参数，单独手动 / 季报披露后跑
        name: '新维度数据同步',
        type: 'EXTRA_DIMS_SYNC',
        cron_expression: '30 16 * * 1-5',
        is_active: true,
        parameters: {
          dims: ['macro', 'qvix', 'block'],
          block_days: 7,
        },
      },
      {
        // Sprint 40 (优先级 #1): 每日盘后 factor_scores 生成 — 必须早于 IC.
        // 17:30 = daily_bar sync 完成 + 龙虎榜 (16:45) 完成之后, IC (19:00) 之前.
        name: '每日因子分数计算',
        type: 'FACTOR_SCORE_COMPUTE',
        cron_expression: '30 17 * * 1-5',
        is_active: true,
        parameters: {
          // date 默认今日 (Asia/Shanghai), 空跑全部 20 个 factor
        },
      },
      {
        // Sprint 41-A: 组合级策略真实调仓 — 必须晚于 QUANT_DAILY_PIPELINE (15:32)
        // 给 composite-level signals 落库的时间, 默认 dry_run=true + persist=true
        // 让运维先看 plan 再决定是否切真下单 (改 task params dry_run=false).
        // 17:50 = FACTOR_SCORE (17:30) 后 20 分钟, FACTOR_IC (19:00) 之前.
        name: '组合级策略真实调仓 (composite rebalance)',
        type: 'COMPOSITE_REBALANCE',
        cron_expression: '50 17 * * 1-5',
        is_active: true,
        parameters: {
          // trade_date 默认今日 (Asia/Shanghai)
          username: 'stock',
          dry_run: true, // 默认 dry-run, 运维确认后改 false
          persist: true, // 默认 persist plan 留审计
        },
      },
      {
        // Phase 3: 每日因子 IC 自动计算 — 周一到周五盘后 19:00 (各 sync 跑完之后)
        // 默认 lookback 90 天 + 全部 18 个因子 + 5 个 forward 窗口 (1/5/10/20/60)
        // 跑完后 UI FactorWorkspace 因子卡 + LabWorkspace 都能拉到最新 IC 数据
        // CPU 占用：~10-15 分钟（取决于因子数 + 横截面大小）
        name: '因子 IC 自动计算',
        type: 'FACTOR_IC_COMPUTE',
        cron_expression: '0 19 * * 1-5',
        is_active: true,
        parameters: {
          lookback_days: 90,
          factor_names: [], // 空 = 跑全部已注册因子
        },
      },
      {
        // 龙虎榜独立 cron — 收盘后 16:45 拉今日上榜
        // 沪深交易所通常 16:00 前披露，留 45min buffer
        name: '龙虎榜同步',
        type: 'DRAGON_TIGER_SYNC',
        cron_expression: '45 16 * * 1-5',
        is_active: true,
        parameters: {},
      },
      {
        // 模拟盘日 snapshot — 每个交易日 16:00 跑
        // 让"昨日盈亏 / 当月收益 / 最大回撤"等指标能正常显示历史曲线
        name: '模拟盘日 snapshot',
        type: 'PAPER_TRADING_DAILY_SNAPSHOT',
        cron_expression: '0 16 * * 1-5',
        is_active: true,
        parameters: {},
      },
    ];

    for (const taskData of defaultTasks) {
      const [task, created] = await ScheduledTask.findOrCreate({
        where: { name: taskData.name },
        defaults: taskData,
      });

      const patch: any = {};
      if (!task.cron_expression) patch.cron_expression = taskData.cron_expression;
      if (!task.type) patch.type = taskData.type;
      if (!task.parameters && taskData.parameters) patch.parameters = taskData.parameters;
      if (task.is_active === null || task.is_active === undefined)
        patch.is_active = taskData.is_active;

      const autonomousParamsPatch = this.patchAutonomousPortfolioParameters(task, taskData);
      if (autonomousParamsPatch) {
        patch.parameters = autonomousParamsPatch;
      }

      if (taskData.name === '全量股票日线同步') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        const hasExplicitScope =
          Array.isArray(params.symbols) ||
          Array.isArray(params.marketFilters) ||
          Array.isArray(params.market_filters) ||
          params.syncAllStocks !== undefined ||
          params.sync_all_stocks !== undefined;
        if (!hasExplicitScope) {
          nextParams.syncAllStocks = true;
        }
        for (const key of [
          'batch_limit',
          'lag_days_threshold',
          'stale_first',
          'include_no_data',
          'dataSource',
          'concurrency',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === 'Agent尾盘建议收益追踪') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'auto_repair_missing_data',
          'data_source',
          'lookback_days',
          'sync_concurrency',
          'agent_session',
          'source_type',
          'horizon',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === '信号质量日报') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'horizon',
          'lookback_days',
          'min_samples',
          'limit',
          'auto_repair_missing_data',
          'data_source',
          'repair_lookback_days',
          'sync_concurrency',
          'verify_before_report',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'QUANT_PARAM_MAINTENANCE') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'lookback_days',
          'horizons',
          'signal',
          'limit',
          'refresh_limit',
          'lifecycle_limit',
          'auto_sync_benchmark',
          'dry_run_lifecycle',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'REALTIME_QUOTE_SYNC') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'universe',
          'limit',
          'source',
          'batch_size',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'LIVE_SHADOW_AUTOPILOT') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'username',
          'limit',
          'outcome_limit',
          'horizons',
          'source',
          'require_opening_readiness',
          'allow_degraded_readiness',
          'factor_limit',
          'cache_ttl_ms',
          'dry_run',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'LIVE_SHADOW_WEEKLY_REVIEW') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'username',
          'outcome_limit',
          'horizons',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'QUANT_DAILY_PIPELINE') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'username',
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'universe',
          'strategy_keys',
          'lookback_days',
          'candidate_limit',
          'refresh_realtime_quotes',
          'sync_factors_before_scan',
          'factor_sync_scope',
          'factor_sync_limit',
          'factor_provider',
          'factor_sync_skip_if_coverage_rate_gte',
          'factor_sync_skip_if_real_provider_rate_gte',
          'quote_sync_limit',
          'realtime_quote_source',
          'min_score',
          'archive_limit',
          'max_industry_candidates',
          'max_strategy_candidates',
          'submit_agent_analysis',
          'agent_max_count',
          'agent_min_score',
          'agent_paper_trade_min_score',
          'agent_session',
          'agent_auto_paper_trade',
          'run_paper_trading',
          'dry_run',
          'paper_trade_limit',
          'paper_trade_scan_limit',
          'max_positions',
          'default_position_pct',
          'max_position_pct',
          'min_trade_amount',
          'strategy_weight_lookback_days',
          'use_entry_risk_guard',
          'max_daily_new_positions',
          'max_daily_new_exposure_pct',
          'max_total_exposure_pct',
          'max_industry_exposure_pct',
          'min_cash_reserve_pct',
          'max_portfolio_drawdown_pct',
          'max_single_stock_volatility_pct',
          'max_position_correlation',
          'max_portfolio_var_pct',
          'min_avg_turnover_yuan',
          'cooldown_days_after_loss',
          'use_experiment_params',
          'experiment_param_policy',
          'block_limit_up',
          'block_limit_down',
          'block_suspended',
          'block_buy_on_runtime_risk',
          'risk_threshold_stability_min_consecutive_same_action',
          'risk_threshold_stability_min_actionable_samples',
          'risk_threshold_stability_min_protected_runs',
          'risk_threshold_stability_tighten_min_delta_pct',
          'risk_threshold_stability_relax_max_delta_pct',
          'risk_threshold_field_stability_min_consecutive_same_action',
          'risk_threshold_field_min_confidence',
          'risk_threshold_field_min_sample_count',
          'risk_threshold_field_min_triggered_count',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (
          Number(nextParams.quote_sync_limit || 0) <
          Number((taskData.parameters as any).quote_sync_limit || 0)
        ) {
          nextParams.quote_sync_limit = (taskData.parameters as any).quote_sync_limit;
        }
        if (
          Number(nextParams.factor_sync_limit || 0) <
          Number((taskData.parameters as any).factor_sync_limit || 0)
        ) {
          nextParams.factor_sync_limit = (taskData.parameters as any).factor_sync_limit;
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'QUANT_OPEN_WATCHDOG') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'target_task_name',
          'expected_after_time',
          'latest_allowed_minutes',
          'min_quant_signals',
          'min_archived_signals',
          'require_fresh_quote',
          'freshness_max_minutes',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === '全市场荐股闭环') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'username',
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'universe',
          'style',
          'candidate_limit',
          'candidate_pool_limit',
          'lookback_days',
          'min_bars',
          'exclude_st',
          'min_market_cap_yi',
          'archive_limit',
          'verify_signals',
          'run_paper_trading',
          'dry_run',
          'paper_trade_limit',
          'paper_trade_scan_limit',
          'min_score',
          'max_positions',
          'default_position_pct',
          'max_position_pct',
          'min_trade_amount',
          'use_outcome_feedback',
          'use_policy_version_feedback',
          'policy_version_lookback_limit',
          'use_strategy_experiment_feedback',
          'strategy_experiment_min_quality_delta',
          'strategy_experiment_limit',
          'strategy_experiment_pool_limit',
          'outcome_feedback_lookback_days',
          'outcome_feedback_min_closed_samples',
          'use_profit_gate',
          'profit_gate_horizon',
          'profit_gate_min_samples',
          'profit_gate_min_quality_score',
          'use_entry_risk_guard',
          'max_daily_new_positions',
          'max_daily_new_exposure_pct',
          'max_total_exposure_pct',
          'max_industry_exposure_pct',
          'min_cash_reserve_pct',
          'max_portfolio_drawdown_pct',
          'max_single_stock_volatility_pct',
          'max_position_correlation',
          'max_portfolio_var_pct',
          'risk_threshold_stability_min_consecutive_same_action',
          'risk_threshold_stability_min_actionable_samples',
          'risk_threshold_stability_min_protected_runs',
          'risk_threshold_stability_tighten_min_delta_pct',
          'risk_threshold_stability_relax_max_delta_pct',
          'risk_threshold_field_stability_min_consecutive_same_action',
          'risk_threshold_field_min_confidence',
          'risk_threshold_field_min_sample_count',
          'risk_threshold_field_min_triggered_count',
          'min_avg_turnover_yuan',
          'cooldown_days_after_loss',
          'block_limit_up',
          'block_limit_down',
          'block_suspended',
          'agent_auto_paper_trade',
          'agent_only_paper_trade_min_score',
          'submit_agent_analysis',
          'agent_max_count',
          'agent_min_score',
          'agent_session',
          'report_to_feishu',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (
        taskData.name === '推荐信号模拟盘跟单' ||
        taskData.name === 'Agent尾盘建议模拟盘跟单' ||
        taskData.name === '模拟盘交易计划报告'
      ) {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'use_profit_gate',
          'profit_gate_horizon',
          'profit_gate_min_samples',
          'profit_gate_min_quality_score',
          'profit_gate_allow_deprioritized',
          'profit_gate_allow_sampling',
          'profit_gate_sampling_multiplier',
          'use_outcome_feedback',
          'outcome_feedback_min_closed_samples',
          'outcome_feedback_lookback_days',
          'outcome_feedback_limit',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === '推荐交易收益闭环刷新') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'include_open',
          'lookback_days',
          'limit',
          'report_to_feishu',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === '模拟盘风控退出检查' || taskData.name === '模拟盘收益归因报告') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'limit',
          'include_open',
          'enable_stop_loss',
          'enable_take_profit',
          'enable_trailing_take_profit',
          'enable_sell_signals',
          'use_adaptive_risk_policy',
          'adaptive_risk_lookback_days',
          'adaptive_risk_min_closed_samples',
          'adaptive_risk_override_signal_params',
          'default_stop_loss_pct',
          'default_take_profit_pct',
          'trailing_activation_pct',
          'trailing_drawdown_pct',
          'max_hold_days',
          'min_sell_signal_score',
          'sell_signal_source_type',
          'dry_run',
          'report_to_feishu',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (Object.keys(patch).length > 0) {
        await task.update(patch);
      }

      if (created) {
        logger.info(`Default scheduled task created: ${taskData.name}`);
      }
    }
  }

  async createTask(data: any, auditContext: any = {}) {
    const task = await ScheduledTask.create(data);
    await taskParameterAuditService.record({
      task,
      event_type: 'task_created',
      before_parameters: {},
      after_parameters: task.parameters || {},
      changed_keys: Object.keys(task.parameters || {}),
      operator: auditContext.operator,
      metadata: {
        source: auditContext.source || 'scheduler_service',
      },
    });
    if (task.is_active) {
      this.scheduleTask(task);
    }
    return task;
  }

  async updateTask(id: number, data: any, auditContext: any = {}) {
    const task = await ScheduledTask.findByPk(id);
    if (!task) throw new Error('Task not found');

    const beforeParameters = { ...(task.parameters || {}) };
    await task.update(data);
    const afterParameters = { ...(task.parameters || {}) };
    const changedKeys = taskParameterAuditService.buildChangedKeys(
      beforeParameters,
      afterParameters,
      auditContext.changed_keys
    );
    if (changedKeys.length > 0) {
      await taskParameterAuditService.record({
        task,
        event_type:
          auditContext.event_type ||
          taskParameterAuditService.inferEventType(changedKeys, 'task_updated'),
        before_parameters: beforeParameters,
        after_parameters: afterParameters,
        changed_keys: changedKeys,
        source_loop_run_id: auditContext.source_loop_run_id,
        operator: auditContext.operator,
        metadata: {
          source: auditContext.source || 'scheduler_service',
          updated_fields: Object.keys(data || {}),
          ...(auditContext.metadata || {}),
        },
      });
    }
    await this.reloadTask(id);
    return task;
  }

  async deleteTask(id: number) {
    const task = await ScheduledTask.findByPk(id);
    if (task) {
      if (this.activeTasks.has(id)) {
        this.activeTasks.get(id)?.stop();
        this.activeTasks.delete(id);
      }
      await task.destroy();
    }
  }
}

export const schedulerService = new SchedulerService();
