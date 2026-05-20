import cron, { ScheduledTask as CronScheduledTask } from 'node-cron';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { logger } from '../utils/logger';
import { dataUpdateQueue } from '../jobs/dataUpdateQueue';
import { aiPollingQueue } from '../jobs/aiPollingQueue';
import { aiAdvisorService } from './AIAdvisorService';
import { quantRecommendationService } from './QuantRecommendationService';
import { quantFusionService } from '../quant/services/QuantFusionService';
import { quantOpenWatchdogService } from '../quant/services/QuantOpenWatchdogService';
import { quantStrategyFeedbackService } from '../quant/services/QuantStrategyFeedbackService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { paperTradingAutomationService } from './PaperTradingAutomationService';
import { paperTradingAttributionService } from './PaperTradingAttributionService';
import { paperTradingPlanService } from './PaperTradingPlanService';
import { benchmarkIndexService } from './BenchmarkIndexService';
import { automatedRecommendationLoopService } from './AutomatedRecommendationLoopService';
import { recommendationTradeOutcomeService } from './RecommendationTradeOutcomeService';
import { taskParameterAuditService } from './TaskParameterAuditService';
import {
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  QUANT_ONLY_PORTFOLIO_NAME,
} from './PaperTradingDashboardService';
import moment from 'moment-timezone';
import { Op } from 'sequelize';

type TaskRunStatus = 'SUCCESS' | 'FAILED' | 'RUNNING';
type TaskExecutionLogLike = TaskExecutionLog | null;

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

    if (status !== 'RUNNING') {
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

  private async _executeTaskLogic(task: ScheduledTask, isManual: boolean = false) {
    const timestamp = new Date();
    await task.update({ last_run_at: timestamp, last_run_status: 'RUNNING' });

    const executionLog = await this.createExecutionLog(task, timestamp, isManual);

    try {
      const parameters = task.parameters || {};
      const portfolioParams = this.resolvePortfolioParams(parameters);
      const today = this.getChinaDate();

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
          username: parameters.username || 'lym',
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
            parameters.candidate_limit || parameters.candidateLimit || 220,
            1500
          ),
          factor_sync_skip_if_coverage_rate_gte: Number(
            parameters.factor_sync_skip_if_coverage_rate_gte ??
              parameters.factorSyncSkipIfCoverageRateGte ??
              92
          ),
          quote_sync_limit: this.toPositiveInt(
            parameters.quote_sync_limit || parameters.quoteSyncLimit,
            parameters.candidate_limit || parameters.candidateLimit || 220,
            1000
          ),
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
        await this.safeUpdateExecutionLog(executionLog, {
          total_items:
            agentSubmitted > 0 ? agentSubmitted + agentFailed : result.archive?.total || 0,
          completed_items: agentSubmitted > 0 ? 0 : result.archive?.total || 0,
          failed_items: agentFailed,
          status: agentSubmitted > 0 ? 'IN_PROGRESS' : 'COMPLETED',
          completed_at: agentSubmitted > 0 ? null : new Date(),
          error_message: null,
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
          username: parameters.username || 'lym',
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

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.summary.action_count,
          completed_items: result.summary.action_count,
          failed_items: result.summary.urgent_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘交易计划完成。动作 ${result.summary.action_count}，紧急 ${result.summary.urgent_count}，入场 ${result.summary.entry_count}，退出 ${result.summary.exit_count}`
        );
      } else if (task.type === 'AUTO_RECOMMENDATION_LOOP') {
        const result = await automatedRecommendationLoopService.run({
          username: parameters.username || 'lym',
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
        name: '量化策略全市场扫描',
        type: 'QUANT_DAILY_PIPELINE',
        cron_expression: '32 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'lym',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          strategy_keys: [
            'multi_factor_ranking',
            'relative_strength_momentum',
            'ma_trend',
            'macd_trend',
            'breakout_atr',
            'volume_price_confirmation',
            'low_volatility_quality',
          ],
          lookback_days: 180,
          candidate_limit: 220,
          refresh_realtime_quotes: true,
          quote_sync_limit: 220,
          min_score: 55,
          archive_limit: 30,
          max_industry_candidates: 4,
          max_strategy_candidates: 8,
          submit_agent_analysis: true,
          agent_max_count: 5,
          agent_min_score: 72,
          agent_session: 'close',
          agent_auto_paper_trade: true,
          run_paper_trading: true,
          dry_run: false,
          paper_trade_limit: 3,
          paper_trade_scan_limit: 100,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          strategy_weight_lookback_days: 365,
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
          username: 'lym',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          strategy_keys: [
            'multi_factor_ranking',
            'relative_strength_momentum',
            'ma_trend',
            'macd_trend',
            'breakout_atr',
            'volume_price_confirmation',
            'low_volatility_quality',
          ],
          lookback_days: 180,
          candidate_limit: 220,
          refresh_realtime_quotes: true,
          quote_sync_limit: 220,
          min_score: 55,
          archive_limit: 30,
          max_industry_candidates: 4,
          max_strategy_candidates: 8,
          submit_agent_analysis: true,
          agent_max_count: 5,
          agent_min_score: 72,
          agent_session: 'open',
          agent_auto_paper_trade: true,
          run_paper_trading: true,
          dry_run: false,
          paper_trade_limit: 3,
          paper_trade_scan_limit: 100,
          max_positions: 8,
          default_position_pct: 4,
          max_position_pct: 8,
          min_trade_amount: 3000,
          strategy_weight_lookback_days: 365,
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
          username: 'lym',
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
          username: 'lym',
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
          username: 'lym',
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
          username: 'lym',
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
          username: 'lym',
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
          username: 'lym',
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
          username: 'lym',
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
        },
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
          'quote_sync_limit',
          'min_score',
          'archive_limit',
          'max_industry_candidates',
          'max_strategy_candidates',
          'submit_agent_analysis',
          'agent_max_count',
          'agent_min_score',
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
