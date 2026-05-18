import { QuantBacktestTask } from '../../models/QuantBacktestTask';
import { QuantBacktestResult } from '../../models/QuantBacktestResult';
import { QuantBacktestTrade } from '../../models/QuantBacktestTrade';
import { QuantBacktestOptions } from '../types/QuantTypes';
import { quantDataService } from './QuantDataService';
import { quantBacktestEngine } from '../engine/QuantBacktestEngine';
import { round } from '../engine/QuantMath';
import { quantBacktestQueue } from '../../jobs/quantBacktestQueue';
import { benchmarkIndexService } from '../../services/BenchmarkIndexService';
import { quantStrategyExperimentService } from './QuantStrategyExperimentService';
import { logger } from '../../utils/logger';
import { Op } from 'sequelize';

export class QuantBacktestService {
  private normalizeDateOnly(value: any): string {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }

  private parseTime(value: any): number {
    if (!value) return NaN;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : NaN;
  }

  private formatDuration(durationSeconds: number): string {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return '0秒';
    if (durationSeconds >= 3600) {
      return `${Math.floor(durationSeconds / 3600)}小时${Math.floor(
        (durationSeconds % 3600) / 60
      )}分`;
    }
    if (durationSeconds >= 60) {
      return `${Math.floor(durationSeconds / 60)}分${durationSeconds % 60}秒`;
    }
    return `${durationSeconds}秒`;
  }

  private getRuntimeParameters(task: QuantBacktestTask) {
    const parameters = task.parameters || {};
    const createdAt = this.parseTime(task.created_at);
    const updatedAt = this.parseTime(task.updated_at);
    const runStartedAt = this.parseTime(parameters.run_started_at);
    const runFinishedAt = this.parseTime(
      parameters.run_completed_at || parameters.run_failed_at || task.updated_at
    );
    const durationSeconds =
      Number.isFinite(runStartedAt) && Number.isFinite(runFinishedAt)
        ? Math.max(0, Math.round((runFinishedAt - runStartedAt) / 1000))
        : Number.isFinite(createdAt) && Number.isFinite(updatedAt)
          ? Math.max(0, Math.round((updatedAt - createdAt) / 1000))
          : 0;
    const queueWaitSeconds =
      Number.isFinite(createdAt) && Number.isFinite(runStartedAt)
        ? Math.max(0, Math.round((runStartedAt - createdAt) / 1000))
        : 0;
    return {
      parameters,
      run_started_at: parameters.run_started_at || null,
      run_finished_at: parameters.run_completed_at || parameters.run_failed_at || null,
      run_completed_at: parameters.run_completed_at || null,
      run_failed_at: parameters.run_failed_at || null,
      duration_seconds: durationSeconds,
      duration_label: this.formatDuration(durationSeconds),
      queue_wait_seconds: queueWaitSeconds,
      queue_wait_label: this.formatDuration(queueWaitSeconds),
    };
  }

  private getCleanBacktestOptions(task: QuantBacktestTask): QuantBacktestOptions {
    const parameters = task.parameters || {};
    const runtimeKeys = new Set([
      'queue_job_id',
      'retry_count',
      'retried_at',
      'run_started_at',
      'run_completed_at',
      'run_failed_at',
      'last_stage',
      'last_error',
      'scanned_stocks',
      'benchmark_return',
      'result_count',
      'best_strategy_key',
      'best_return_pct',
      'best_excess_return_pct',
    ]);
    const cleanParameters = Object.fromEntries(
      Object.entries(parameters).filter(([key]) => !runtimeKeys.has(key))
    );
    return this.withDefaultExecutionOptions({
      ...cleanParameters,
      task_name: task.task_name,
      universe: task.universe,
      strategy_keys: task.strategy_keys,
      symbols: task.symbols,
      start_date: this.normalizeDateOnly(task.start_date),
      end_date: this.normalizeDateOnly(task.end_date),
      initial_capital: Number(task.initial_capital || 200000),
      commission_rate: Number(task.commission_rate || 0.0003),
      slippage_rate: Number(task.slippage_rate || 0.0005),
    } as QuantBacktestOptions);
  }

  private buildTaskRunSummary(task: QuantBacktestTask, results: QuantBacktestResult[] = []) {
    const runtime = this.getRuntimeParameters(task);
    const sorted = [...results].sort(
      (a, b) => Number(b.total_return_pct || 0) - Number(a.total_return_pct || 0)
    );
    const best = sorted[0] || null;
    const worst = sorted[sorted.length - 1] || null;
    const completed = task.status === 'COMPLETED';
    const failed = task.status === 'FAILED';
    const strategyCount = Array.isArray(task.strategy_keys) ? task.strategy_keys.length : 0;
    return {
      task_id: task.id,
      status: task.status,
      progress: task.progress,
      universe: task.universe,
      start_date: this.normalizeDateOnly(task.start_date),
      end_date: this.normalizeDateOnly(task.end_date),
      range_label: `${this.normalizeDateOnly(task.start_date)} ~ ${this.normalizeDateOnly(
        task.end_date
      )}`,
      strategy_count: strategyCount,
      symbol_count: Array.isArray(task.symbols) ? task.symbols.length : 0,
      candidate_limit: Number((task.parameters || {}).candidate_limit || 0),
      initial_capital: Number(task.initial_capital || 0),
      run_started_at: runtime.run_started_at,
      run_finished_at: runtime.run_finished_at,
      run_completed_at: runtime.run_completed_at,
      run_failed_at: runtime.run_failed_at,
      duration_seconds: runtime.duration_seconds,
      duration_label: runtime.duration_label,
      queue_wait_seconds: runtime.queue_wait_seconds,
      queue_wait_label: runtime.queue_wait_label,
      last_stage: runtime.parameters.last_stage || null,
      retry_count: Number(runtime.parameters.retry_count || 0),
      last_error: runtime.parameters.last_error || task.error_message || null,
      scanned_stocks: Number(runtime.parameters.scanned_stocks || 0),
      benchmark_return_pct: Number(runtime.parameters.benchmark_return?.benchmark_return_pct || 0),
      best_strategy_key: best?.strategy_key || null,
      best_strategy_name: best?.strategy_name || null,
      best_return_pct: best ? round(Number(best.total_return_pct || 0), 4) : 0,
      best_excess_return_pct: best ? round(Number(best.excess_return_pct || 0), 4) : 0,
      best_max_drawdown_pct: best ? round(Number(best.max_drawdown_pct || 0), 4) : 0,
      best_sharpe_ratio: best ? round(Number(best.sharpe_ratio || 0), 4) : 0,
      best_trade_count: best ? Number(best.trade_count || 0) : 0,
      worst_strategy_key: worst?.strategy_key || null,
      worst_return_pct: worst ? round(Number(worst.total_return_pct || 0), 4) : 0,
      result_count: results.length,
      retryable: failed || ['QUEUED', 'RUNNING'].includes(String(task.status || '')),
      resumable: failed,
      conclusion: completed
        ? best
          ? `冠军 ${best.strategy_name || best.strategy_key}，总收益 ${round(
              Number(best.total_return_pct || 0),
              2
            )}%，超额 ${round(Number(best.excess_return_pct || 0), 2)}%。`
          : '跑分完成，但暂无策略结果。'
        : failed
          ? `跑分失败：${task.error_message || '未知错误'}。可以直接重试，系统会复用原始参数重新入队。`
          : `任务${task.status || '处理中'}，进度 ${task.progress || 0}%。`,
    };
  }

  private async enqueueExistingTask(task: QuantBacktestTask, options: QuantBacktestOptions) {
    const job = await quantBacktestQueue.add(
      { task_id: task.id, user_id: task.user_id, options },
      {
        jobId: `quant-backtest-task-${task.id}-retry-${Date.now()}`,
      }
    );
    await task.update({
      status: 'QUEUED',
      progress: 0,
      error_message: null,
      parameters: {
        ...(options as any),
        queue_job_id: job.id,
        retry_count: Number((task.parameters || {}).retry_count || 0) + 1,
        retried_at: new Date().toISOString(),
        last_stage: 'queued_retry',
      },
    } as any);
    return { task: await this.getBacktest(task.id), queue_job_id: job.id };
  }

  async createBacktestTask(options: QuantBacktestOptions, user_id?: number, asyncMode = true) {
    const normalizedOptions = this.withDefaultExecutionOptions(options);
    const task = await QuantBacktestTask.create({
      user_id,
      task_name: options.task_name || `量化策略跑分 ${options.start_date}~${options.end_date}`,
      universe: options.universe || 'market',
      strategy_keys: options.strategy_keys,
      symbols: options.symbols || [],
      start_date: options.start_date,
      end_date: options.end_date,
      initial_capital: options.initial_capital || 200000,
      commission_rate: options.commission_rate ?? 0.0003,
      slippage_rate: options.slippage_rate ?? 0.0005,
      status: asyncMode ? 'QUEUED' : 'RUNNING',
      progress: asyncMode ? 0 : 10,
      parameters: normalizedOptions,
    });

    if (!asyncMode) {
      return this.processBacktestTask(task.id, normalizedOptions, {
        user_id,
      });
    }

    const job = await quantBacktestQueue.add(
      { task_id: task.id, user_id, options: normalizedOptions },
      {
        jobId: `quant-backtest-task-${task.id}-${Date.now()}`,
      }
    );

    await task.update({
      parameters: {
        ...(normalizedOptions as any),
        queue_job_id: job.id,
      },
    });

    return {
      task: await this.getBacktest(task.id),
      queued: true,
      queue_job_id: job.id,
      summary: {
        scanned_stocks: 0,
        strategy_count: options.strategy_keys?.length || 0,
        best_strategy_key: null,
        best_return_pct: 0,
      },
    };
  }

  async runBacktest(options: QuantBacktestOptions, user_id?: number) {
    return this.createBacktestTask(options, user_id, false);
  }

  async processBacktestTask(
    task_id: number,
    options: QuantBacktestOptions,
    runtime: {
      user_id?: number;
      on_progress?: (progress: number) => Promise<void>;
    } = {}
  ) {
    const task = await QuantBacktestTask.findByPk(task_id);
    if (!task) throw new Error(`量化跑分任务不存在: ${task_id}`);

    const updateProgress = async (progress: number, status = 'RUNNING') => {
      await task.update({ status, progress });
      if (runtime.on_progress) await runtime.on_progress(progress);
    };

    try {
      await task.update({
        parameters: {
          ...(task.parameters || {}),
          run_started_at: new Date().toISOString(),
          last_stage: 'prepare_contexts',
        },
      } as any);
      await updateProgress(10);
      const contexts = await quantDataService.getContexts({
        universe: options.universe || 'market',
        user_id: runtime.user_id ?? task.user_id,
        symbols: options.symbols,
        start_date: options.start_date,
        end_date: options.end_date,
        warmup_days: 160,
        limit: options.candidate_limit || 120,
        include_realtime_quote: false,
      });
      await task.update({
        parameters: {
          ...(task.parameters || {}),
          scanned_stocks: contexts.length,
          last_stage: 'resolve_benchmark',
        },
      } as any);
      await updateProgress(35);
      const benchmarkReturn = await this.resolveBenchmarkReturn(options);
      await task.update({
        parameters: {
          ...(task.parameters || {}),
          benchmark_return: benchmarkReturn,
          last_stage: 'run_engine',
        },
      } as any);
      const results = quantBacktestEngine.run(contexts, options).map(result => ({
        ...result,
        benchmark_return_pct: benchmarkReturn?.benchmark_return_pct ?? 0,
        excess_return_pct: round(
          result.total_return_pct - Number(benchmarkReturn?.benchmark_return_pct || 0),
          4
        ),
        metrics: {
          ...result.metrics,
          benchmark: benchmarkReturn,
        },
      }));
      await updateProgress(70);
      await task.update({
        parameters: {
          ...(task.parameters || {}),
          result_count: results.length,
          last_stage: 'persist_results',
        },
      } as any);
      await QuantBacktestResult.destroy({ where: { task_id: task.id } });
      await QuantBacktestTrade.destroy({ where: { task_id: task.id } });
      for (const result of results) {
        await QuantBacktestResult.create({
          task_id: task.id,
          strategy_key: result.strategy_key,
          strategy_name: result.strategy_name,
          total_return_pct: result.total_return_pct,
          annual_return_pct: result.annual_return_pct,
          max_drawdown_pct: result.max_drawdown_pct,
          sharpe_ratio: result.sharpe_ratio,
          win_rate: result.win_rate,
          profit_factor: result.profit_factor,
          trade_count: result.trade_count,
          avg_holding_days: result.avg_holding_days,
          benchmark_return_pct: result.benchmark_return_pct,
          excess_return_pct: result.excess_return_pct,
          metrics_json: result.metrics,
          equity_curve_json: result.equity_curve,
          drawdown_curve_json: result.drawdown_curve,
        });
        for (const trade of result.trades) {
          await QuantBacktestTrade.create({ task_id: task.id, ...trade });
        }
      }
      const best = [...results].sort((a, b) => b.total_return_pct - a.total_return_pct)[0];
      await task.update({
        status: 'COMPLETED',
        progress: 100,
        error_message: null,
        parameters: {
          ...(task.parameters || {}),
          run_completed_at: new Date().toISOString(),
          last_stage: 'completed',
          scanned_stocks: contexts.length,
          result_count: results.length,
          best_strategy_key: best?.strategy_key,
          best_return_pct: round(best?.total_return_pct || 0, 4),
          best_excess_return_pct: round(best?.excess_return_pct || 0, 4),
        },
      } as any);
      const experimentResult = await quantStrategyExperimentService.recordBacktestTask(task.id);
      return {
        task: await this.getBacktest(task.id),
        summary: {
          scanned_stocks: contexts.length,
          strategy_count: results.length,
          best_strategy_key: best?.strategy_key,
          best_return_pct: round(best?.total_return_pct || 0, 2),
          benchmark_return_pct: round(benchmarkReturn?.benchmark_return_pct || 0, 2),
          best_excess_return_pct: round(best?.excess_return_pct || 0, 2),
          experiment_count: experimentResult.recorded,
        },
      };
    } catch (error: any) {
      await this.markTaskFailed(task.id, error);
      throw error;
    }
  }

  private withDefaultExecutionOptions(options: QuantBacktestOptions): QuantBacktestOptions {
    return {
      execution_timing: options.execution_timing || 'next_open',
      enable_t_plus_one: options.enable_t_plus_one !== false,
      lot_size: options.lot_size || 100,
      min_commission: options.min_commission ?? 5,
      stamp_tax_rate: options.stamp_tax_rate ?? 0.001,
      block_limit_up: options.block_limit_up !== false,
      block_limit_down: options.block_limit_down !== false,
      block_suspended: options.block_suspended !== false,
      min_turnover_yuan: options.min_turnover_yuan ?? 0,
      max_trade_amount_pct_of_turnover: options.max_trade_amount_pct_of_turnover ?? 1,
      dynamic_slippage: options.dynamic_slippage !== false,
      ...options,
    };
  }

  async markTaskFailed(task_id: number, error: any) {
    const task = await QuantBacktestTask.findByPk(task_id);
    if (!task) return;
    await task.update({
      status: 'FAILED',
      error_message: error?.message || String(error),
      progress: 100,
      parameters: {
        ...(task.parameters || {}),
        run_failed_at: new Date().toISOString(),
        last_error: error?.message || String(error),
      },
    } as any);
  }

  async listBacktests(user_id?: number, limit = 30) {
    const where: any = {};
    if (user_id) where.user_id = user_id;
    const tasks = await QuantBacktestTask.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Number(limit || 30), 100),
    });
    const taskIds = tasks.map(task => task.id);
    const results = taskIds.length
      ? await QuantBacktestResult.findAll({ where: { task_id: { [Op.in]: taskIds } } })
      : [];
    const resultsByTask = new Map<number, QuantBacktestResult[]>();
    for (const result of results) {
      if (!resultsByTask.has(result.task_id)) resultsByTask.set(result.task_id, []);
      resultsByTask.get(result.task_id)!.push(result);
    }
    return tasks.map(task => ({
      ...task.toJSON(),
      run_summary: this.buildTaskRunSummary(task, resultsByTask.get(task.id) || []),
    }));
  }

  async getBacktest(id: number) {
    const task = await QuantBacktestTask.findByPk(id);
    if (!task) return null;
    const results = await QuantBacktestResult.findAll({
      where: { task_id: id },
      order: [['total_return_pct', 'DESC']],
    });
    const trades = await QuantBacktestTrade.findAll({
      where: { task_id: id },
      order: [['buy_date', 'DESC']],
      limit: 500,
    });
    return {
      task: {
        ...task.toJSON(),
        run_summary: this.buildTaskRunSummary(task, results),
      },
      results,
      trades,
      run_summary: this.buildTaskRunSummary(task, results),
    };
  }

  async retryBacktest(id: number, user_id?: number) {
    const task = await QuantBacktestTask.findByPk(id);
    if (!task) throw new Error('跑分任务不存在');
    if (user_id && task.user_id && Number(task.user_id) !== Number(user_id)) {
      throw new Error('无权重试该跑分任务');
    }
    const currentStatus = String(task.status || '').toUpperCase();
    if (['QUEUED', 'RUNNING'].includes(currentStatus)) {
      return {
        task: await this.getBacktest(task.id),
        queued: false,
        message: '任务仍在队列或运行中，无需重复提交。',
      };
    }
    const normalizedOptions = this.getCleanBacktestOptions(task);
    return {
      ...(await this.enqueueExistingTask(task, normalizedOptions)),
      queued: true,
      message: '已按原参数重新入队。',
    };
  }

  private async resolveBenchmarkReturn(options: QuantBacktestOptions) {
    try {
      const benchmarkSymbol = options.benchmark_symbol || 'sh.000300';
      return await benchmarkIndexService.getBenchmarkReturnForStock(
        benchmarkSymbol,
        options.start_date,
        options.end_date,
        {
          data_source: 'tencent_only',
          auto_sync: true,
        }
      );
    } catch (error: any) {
      logger.warn(`量化跑分基准收益计算失败，降级为绝对收益: ${error?.message || error}`);
      return null;
    }
  }
}

export const quantBacktestService = new QuantBacktestService();
