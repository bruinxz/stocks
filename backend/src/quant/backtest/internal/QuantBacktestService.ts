import { QuantBacktestTask } from '../../../models/QuantBacktestTask';
import { QuantBacktestResult } from '../../../models/QuantBacktestResult';
import { QuantBacktestTrade } from '../../../models/QuantBacktestTrade';
import { QuantBacktestOptions } from '../../types/QuantTypes';
import { quantDataService } from '../../engine/internal/QuantDataService';
import { quantBacktestEngine } from './QuantBacktestEngine';
import { round } from '../../engine/QuantMath';
import { quantBacktestQueue } from '../../../jobs/quantBacktestQueue';
import { benchmarkIndexService } from '../../../services/BenchmarkIndexService';
import { quantStrategyExperimentService } from '../../engine/internal/QuantStrategyExperimentService';
import { quantStrategyService } from '../../engine/internal/QuantStrategyService';
import { logger } from '../../../utils/logger';
import { Op } from 'sequelize';

function maxSegmentDrawdown(curve: any[]): number {
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const point of curve) {
    const value = Number(point?.total_value || 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    peak = Math.max(peak, value);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, ((peak - value) / peak) * 100);
    }
  }
  return maxDrawdown;
}

function pctNumber(value: any): string {
  return Number.isFinite(Number(value)) ? `${round(Number(value), 2)}%` : '--';
}

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

  private buildValidationSplitPlan(
    start_date: string,
    end_date: string,
    split: QuantBacktestOptions['validation_split'] = {}
  ) {
    const startMs = this.parseTime(start_date);
    const endMs = this.parseTime(end_date);
    const dayMs = 24 * 60 * 60 * 1000;
    const totalDays =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(1, Math.round((endMs - startMs) / dayMs) + 1)
        : 1;
    const trainPct = Math.min(Math.max(Number(split?.train_pct ?? 60), 10), 90);
    const validationPct = Math.min(Math.max(Number(split?.validation_pct ?? 20), 5), 60);
    const normalizedValidationPct = Math.min(validationPct, Math.max(5, 95 - trainPct));
    const testPct = Math.max(0, 100 - trainPct - normalizedValidationPct);
    const trainDays = Math.max(1, Math.floor(totalDays * (trainPct / 100)));
    const validationDays = Math.max(1, Math.floor(totalDays * (normalizedValidationPct / 100)));
    const trainEnd = new Date(startMs + (trainDays - 1) * dayMs);
    const validationStart = new Date(startMs + trainDays * dayMs);
    const validationEnd = new Date(
      Math.min(endMs, startMs + (trainDays + validationDays - 1) * dayMs)
    );
    const testStart = new Date(Math.min(endMs, validationEnd.getTime() + dayMs));
    return {
      enabled: split?.enabled !== false,
      method: 'chronological_train_validation_test',
      train_pct: trainPct,
      validation_pct: normalizedValidationPct,
      test_pct: testPct,
      train_start_date: this.normalizeDateOnly(start_date),
      train_end_date: this.normalizeDateOnly(split?.train_end_date || trainEnd),
      validation_start_date: this.normalizeDateOnly(
        split?.validation_start_date || validationStart
      ),
      validation_end_date: this.normalizeDateOnly(split?.validation_end_date || validationEnd),
      test_start_date: this.normalizeDateOnly(split?.test_start_date || testStart),
      test_end_date: this.normalizeDateOnly(end_date),
      note: '按时间顺序切分，避免训练/调参结果直接使用未来测试样本；当前先沉淀分区指标，后续参数网格搜索将优先以验证集排序、测试集验收。',
    };
  }

  private dateInRange(date: string, start?: string, end?: string): boolean {
    if (!date) return false;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  }

  private computeSegmentMetrics(
    result: any,
    start_date?: string,
    end_date?: string,
    benchmarkReturnPct = 0
  ) {
    const curve = Array.isArray(result.equity_curve) ? result.equity_curve : [];
    const segmentCurve = curve.filter((point: any) =>
      this.dateInRange(String(point.date || ''), start_date, end_date)
    );
    const trades = Array.isArray(result.trades)
      ? result.trades.filter((trade: any) =>
          this.dateInRange(String(trade.buy_date || trade.sell_date || ''), start_date, end_date)
        )
      : [];
    if (!segmentCurve.length) {
      return {
        start_date,
        end_date,
        sample_days: 0,
        total_return_pct: 0,
        benchmark_return_pct: 0,
        excess_return_pct: -round(benchmarkReturnPct, 4),
        max_drawdown_pct: 0,
        trade_count: 0,
        win_rate: 0,
      };
    }

    const startValue = Number(segmentCurve[0].total_value || 0);
    const endValue = Number(segmentCurve[segmentCurve.length - 1].total_value || 0);
    const totalReturnPct =
      startValue > 0 ? round(((endValue - startValue) / startValue) * 100, 4) : 0;
    const wins = trades.filter((trade: any) => Number(trade.pnl || 0) > 0).length;
    const segmentBenchmarkPct = round(
      benchmarkReturnPct * (segmentCurve.length / Math.max(curve.length, 1)),
      4
    );

    return {
      start_date: segmentCurve[0].date,
      end_date: segmentCurve[segmentCurve.length - 1].date,
      sample_days: segmentCurve.length,
      total_return_pct: totalReturnPct,
      benchmark_return_pct: segmentBenchmarkPct,
      excess_return_pct: round(totalReturnPct - segmentBenchmarkPct, 4),
      max_drawdown_pct: round(maxSegmentDrawdown(segmentCurve), 4),
      trade_count: trades.length,
      win_rate: trades.length ? round((wins / trades.length) * 100, 4) : 0,
    };
  }

  private attachValidationMetrics(result: any, splitPlan: Record<string, any>) {
    const benchmarkReturnPct = Number(result.benchmark_return_pct || 0);
    const segments = {
      train: this.computeSegmentMetrics(
        result,
        splitPlan.train_start_date,
        splitPlan.train_end_date,
        benchmarkReturnPct
      ),
      validation: this.computeSegmentMetrics(
        result,
        splitPlan.validation_start_date,
        splitPlan.validation_end_date,
        benchmarkReturnPct
      ),
      test: this.computeSegmentMetrics(
        result,
        splitPlan.test_start_date,
        splitPlan.test_end_date,
        benchmarkReturnPct
      ),
    };
    const generalizationGap = round(
      Number(segments.validation.excess_return_pct || 0) -
        Number(segments.test.excess_return_pct || 0),
      4
    );
    const passed =
      Number(segments.validation.excess_return_pct || 0) >= 0 &&
      Number(segments.test.excess_return_pct || 0) >= -3 &&
      Math.abs(generalizationGap) <= 15;

    return {
      split_plan: splitPlan,
      segments,
      generalization_gap_pct: generalizationGap,
      verdict: passed ? 'passed' : 'watch',
      conclusion: passed
        ? '验证集与测试集未明显失真，可进入小仓模拟观察。'
        : '验证/测试表现存在落差，暂不建议直接放大，需要继续采样或调参。',
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

  private buildGridSearchValues(
    strategy_key: string,
    baseParams: Record<string, any>,
    overrides: Record<string, any> = {}
  ): Array<Record<string, any>> {
    const explicitGrid = overrides[strategy_key] || overrides.default || null;
    const sourceGrid =
      explicitGrid ||
      {
        ma_trend: {
          short_period: [5, 8, 10],
          long_period: [20, 30],
        },
        macd_trend: {
          fast_period: [10, 12],
          slow_period: [24, 26, 30],
        },
        rsi_reversion: {
          oversold: [30, 35, 40],
          overbought: [68, 72],
        },
        bollinger_reversion: {
          period: [18, 20],
          multiplier: [1.8, 2, 2.2],
        },
        relative_strength_momentum: {
          short_window: [15, 20],
          long_window: [50, 60, 80],
        },
        breakout_atr: {
          breakout_window: [15, 20, 30],
          volume_ratio: [1.1, 1.25, 1.5],
        },
        multi_factor_ranking: {
          min_avg_turnover_yuan: [10000000, 20000000, 40000000],
        },
        low_volatility_quality: {
          max_volatility20: [3.5, 4.2, 5],
          max_drawdown60: [14, 18, 22],
        },
        volume_price_confirmation: {
          min_volume_ratio: [1.02, 1.08, 1.18],
          max_return20: [30, 38, 45],
        },
      }[strategy_key] ||
      {};

    const entries = Object.entries(sourceGrid).filter(([, values]) => Array.isArray(values));
    if (!entries.length) return [{ ...baseParams }];

    const combos: Array<Record<string, any>> = [{ ...baseParams }];
    for (const [key, rawValues] of entries) {
      const values = (rawValues as any[]).slice(0, 6);
      const next: Array<Record<string, any>> = [];
      for (const combo of combos) {
        for (const value of values) {
          next.push({ ...combo, [key]: value });
        }
      }
      combos.splice(0, combos.length, ...next.slice(0, 24));
    }
    return combos;
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
        ? `跑分失败：${
            task.error_message || '未知错误'
          }。可以直接重试，系统会复用原始参数重新入队。`
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

  async createWalkForwardBacktests(
    options: QuantBacktestOptions & {
      windows?: number;
      window_days?: number;
      step_days?: number;
      max_parallel?: number;
      parent_task_name?: string;
    },
    user_id?: number
  ) {
    const windows = Math.min(Math.max(Number(options.windows || 3), 1), 8);
    const windowDays = Math.min(Math.max(Number(options.window_days || 180), 60), 720);
    const stepDays = Math.min(Math.max(Number(options.step_days || 60), 20), windowDays);
    const endMs = this.parseTime(options.end_date);
    const dayMs = 24 * 60 * 60 * 1000;
    const ranges = Array.from({ length: windows })
      .map((_, index) => {
        const windowEnd = new Date(endMs - index * stepDays * dayMs);
        const windowStart = new Date(windowEnd.getTime() - (windowDays - 1) * dayMs);
        return {
          index: windows - index,
          start_date: this.normalizeDateOnly(windowStart),
          end_date: this.normalizeDateOnly(windowEnd),
        };
      })
      .reverse();
    const strategyKeys = await quantStrategyService.resolveStrategyKeys(options.strategy_keys);
    const defaultParams = await quantStrategyService.getDefaultParamsByStrategy(strategyKeys);
    const tasks = [];
    for (const range of ranges) {
      const task = await this.createBacktestTask(
        {
          ...options,
          task_name: `${options.parent_task_name || options.task_name || '滚动验证'} W${
            range.index
          } ${range.start_date}~${range.end_date}`,
          strategy_keys: strategyKeys,
          params_by_strategy: {
            ...defaultParams,
            ...(options.params_by_strategy || {}),
          },
          start_date: range.start_date,
          end_date: range.end_date,
        },
        user_id,
        true
      );
      tasks.push(task);
    }

    return {
      generated_at: new Date().toISOString(),
      mode: 'walk_forward',
      windows,
      window_days: windowDays,
      step_days: stepDays,
      max_parallel: Math.min(Math.max(Number(options.max_parallel || 1), 1), 3),
      ranges,
      tasks,
      message: `已创建 ${tasks.length} 个滚动验证任务；建议并发不超过 1-2，避免数据源压力过高。`,
    };
  }

  async createParameterGridBacktests(
    options: QuantBacktestOptions & {
      grid?: Record<string, Record<string, any[]>>;
      max_tasks?: number;
      parent_task_name?: string;
    },
    user_id?: number
  ) {
    const strategyKeys = await quantStrategyService.resolveStrategyKeys(options.strategy_keys);
    const defaultParams = await quantStrategyService.getDefaultParamsByStrategy(strategyKeys);
    const maxTasks = Math.min(Math.max(Number(options.max_tasks || 18), 1), 48);
    const tasks = [];
    let generated = 0;
    const groupId = `qgrid_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

    for (const strategy_key of strategyKeys) {
      const baseParams = {
        ...(defaultParams[strategy_key] || {}),
        ...((options.params_by_strategy || {})[strategy_key] || {}),
      };
      const combos = this.buildGridSearchValues(strategy_key, baseParams, options.grid);
      for (let index = 0; index < combos.length && generated < maxTasks; index++) {
        const params = combos[index];
        const task = await this.createBacktestTask(
          {
            ...options,
            task_name: `${
              options.parent_task_name || options.task_name || '参数网格搜索'
            } ${strategy_key} #${index + 1}`,
            strategy_keys: [strategy_key],
            params_by_strategy: {
              [strategy_key]: params,
            },
            grid_search: {
              group_id: groupId,
              strategy_key,
              grid_index: index + 1,
              params,
              parent_task_name: options.parent_task_name || options.task_name || '参数网格搜索',
              ranking_rule: 'validation_verdict > test_excess > total_return > drawdown',
            },
          },
          user_id,
          true
        );
        tasks.push({
          ...task,
          strategy_key,
          grid_index: index + 1,
          params,
        });
        generated++;
      }
      if (generated >= maxTasks) break;
    }

    return {
      generated_at: new Date().toISOString(),
      mode: 'parameter_grid',
      group_id: groupId,
      max_tasks: maxTasks,
      generated_tasks: tasks.length,
      strategy_keys: strategyKeys,
      tasks,
      ranking_rule:
        '任务完成后按 validation.verdict、测试集超额、总收益、最大回撤综合筛选；当前先创建可追踪队列任务，后续补自动汇总榜。',
      message: `已创建 ${tasks.length} 个参数网格跑分任务，默认并发受队列保护。`,
    };
  }

  async summarizeParameterGridSearch(
    options: { user_id?: number; group_id?: string; limit?: number } = {}
  ) {
    const taskWhere: any = {};
    if (options.user_id) taskWhere.user_id = options.user_id;
    const recentTasks = await QuantBacktestTask.findAll({
      where: taskWhere,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(options.limit || 300), 50), 1000),
    });
    const gridTasks = recentTasks.filter(task => {
      const groupId = (task.parameters || {}).grid_search?.group_id;
      return groupId && (!options.group_id || groupId === options.group_id);
    });
    const taskIds = gridTasks.map(task => task.id);
    const results = taskIds.length
      ? await QuantBacktestResult.findAll({ where: { task_id: { [Op.in]: taskIds } } })
      : [];
    const resultsByTask = new Map<number, QuantBacktestResult[]>();
    for (const result of results) {
      if (!resultsByTask.has(result.task_id)) resultsByTask.set(result.task_id, []);
      resultsByTask.get(result.task_id)!.push(result);
    }

    const groups = new Map<string, any>();
    for (const task of gridTasks) {
      const grid = (task.parameters || {}).grid_search || {};
      const groupId = grid.group_id;
      if (!groups.has(groupId)) {
        groups.set(groupId, {
          group_id: groupId,
          parent_task_name: grid.parent_task_name || '参数网格搜索',
          created_at: task.created_at,
          total_tasks: 0,
          completed_tasks: 0,
          failed_tasks: 0,
          running_tasks: 0,
          candidates: [],
        });
      }
      const group = groups.get(groupId);
      group.created_at =
        new Date(task.created_at) > new Date(group.created_at) ? task.created_at : group.created_at;
      group.total_tasks += 1;
      if (task.status === 'COMPLETED') group.completed_tasks += 1;
      if (task.status === 'FAILED') group.failed_tasks += 1;
      if (['QUEUED', 'RUNNING'].includes(String(task.status || ''))) group.running_tasks += 1;

      const taskResults = resultsByTask.get(task.id) || [];
      const bestResult = [...taskResults].sort(
        (a, b) => Number(b.total_return_pct || 0) - Number(a.total_return_pct || 0)
      )[0];
      const validation = (bestResult?.metrics_json as any)?.validation || {};
      const testExcess = Number(validation?.segments?.test?.excess_return_pct || 0);
      const validationExcess = Number(validation?.segments?.validation?.excess_return_pct || 0);
      const rankScore = bestResult
        ? round(
            (validation.verdict === 'passed' ? 20 : 0) +
              testExcess * 1.4 +
              validationExcess * 0.6 +
              Number(bestResult.total_return_pct || 0) * 0.25 -
              Math.abs(Number(bestResult.max_drawdown_pct || 0)) * 0.35,
            4
          )
        : -9999;
      group.candidates.push({
        task_id: task.id,
        task_name: task.task_name,
        status: task.status,
        progress: task.progress,
        strategy_key: grid.strategy_key || bestResult?.strategy_key || task.strategy_keys?.[0],
        grid_index: grid.grid_index,
        params:
          grid.params || (task.parameters || {}).params_by_strategy?.[grid.strategy_key] || {},
        total_return_pct: bestResult ? Number(bestResult.total_return_pct || 0) : null,
        excess_return_pct: bestResult ? Number(bestResult.excess_return_pct || 0) : null,
        max_drawdown_pct: bestResult ? Number(bestResult.max_drawdown_pct || 0) : null,
        trade_count: bestResult ? Number(bestResult.trade_count || 0) : null,
        validation_verdict: validation.verdict || null,
        validation_excess_return_pct: validationExcess,
        test_excess_return_pct: testExcess,
        rank_score: rankScore,
        error_message: task.error_message || null,
      });
    }

    const summaries = [...groups.values()]
      .map(group => {
        const ranked = [...group.candidates].sort((a, b) => b.rank_score - a.rank_score);
        const best = ranked.find(item => item.status === 'COMPLETED') || ranked[0] || null;
        return {
          ...group,
          best,
          candidates: ranked.slice(0, 12),
          conclusion: best
            ? `当前冠军 ${best.strategy_key} #${best.grid_index || '-'}，总收益 ${pctNumber(
                best.total_return_pct
              )}，测试超额 ${pctNumber(best.test_excess_return_pct)}，验证结论 ${
                best.validation_verdict || '待完成'
              }。`
            : '参数网格任务尚未产生结果。',
        };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return {
      generated_at: new Date().toISOString(),
      group_count: summaries.length,
      groups: summaries,
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
      const validationSplit = this.buildValidationSplitPlan(
        options.start_date,
        options.end_date,
        options.validation_split
      );
      await task.update({
        parameters: {
          ...(task.parameters || {}),
          benchmark_return: benchmarkReturn,
          validation_split: validationSplit,
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
      const resultsWithValidation = results.map(result => {
        const validation = this.attachValidationMetrics(result, validationSplit);
        return {
          ...result,
          metrics: {
            ...result.metrics,
            validation,
          },
          validation,
        };
      });
      await updateProgress(70);
      await task.update({
        parameters: {
          ...(task.parameters || {}),
          result_count: resultsWithValidation.length,
          last_stage: 'persist_results',
        },
      } as any);
      await QuantBacktestResult.destroy({ where: { task_id: task.id } });
      await QuantBacktestTrade.destroy({ where: { task_id: task.id } });
      const createdResultIds: number[] = [];
      for (const result of resultsWithValidation) {
        const createdResult = await QuantBacktestResult.create({
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
          rejected_orders_json: result.rejected_orders || [],
        });
        createdResultIds.push(createdResult.id);
        for (const trade of result.trades) {
          await QuantBacktestTrade.create({ task_id: task.id, ...trade });
        }
      }
      const best = [...resultsWithValidation].sort(
        (a, b) => b.total_return_pct - a.total_return_pct
      )[0];
      await task.update({
        status: 'COMPLETED',
        progress: 100,
        error_message: null,
        parameters: {
          ...(task.parameters || {}),
          run_completed_at: new Date().toISOString(),
          last_stage: 'completed',
          scanned_stocks: contexts.length,
          result_count: resultsWithValidation.length,
          best_strategy_key: best?.strategy_key,
          best_return_pct: round(best?.total_return_pct || 0, 4),
          best_excess_return_pct: round(best?.excess_return_pct || 0, 4),
          best_validation_verdict: best?.validation?.verdict,
        },
      } as any);
      const experimentResult = await quantStrategyExperimentService.recordBacktestTask(task.id);

      // US-045 hook: fire-and-forget 触发基准归因（HS300 / CSI500 / CSI1000）。
      // 异步不 await — 单次回测完成不应被归因耗时阻塞；归因失败也不影响回测主流程。
      // 走 setImmediate 让 task.update('COMPLETED') 已完全 flush 后再开始。
      if (createdResultIds.length > 0) {
        setImmediate(() => {
          this.triggerBenchmarkAttributionAsync(createdResultIds, task.id);
        });
      }

      // US-046 hook: 同款 fire-and-forget 触发行业归因（按行业拆解 contribution / win_rate）。
      // 与 US-045 并列；同一 createdResultIds 各跑一次 per result。
      if (createdResultIds.length > 0) {
        setImmediate(() => {
          this.triggerIndustryAttributionAsync(createdResultIds, task.id);
        });
      }

      return {
        task: await this.getBacktest(task.id),
        summary: {
          scanned_stocks: contexts.length,
          strategy_count: resultsWithValidation.length,
          best_strategy_key: best?.strategy_key,
          best_return_pct: round(best?.total_return_pct || 0, 2),
          benchmark_return_pct: round(benchmarkReturn?.benchmark_return_pct || 0, 2),
          best_excess_return_pct: round(best?.excess_return_pct || 0, 2),
          best_validation_verdict: best?.validation?.verdict,
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
      validation_split: {
        enabled: true,
        train_pct: 60,
        validation_pct: 20,
        test_pct: 20,
        ...(options.validation_split || {}),
      },
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

  /**
   * US-016：回测对比 API。给定 2-4 个已完成回测的 task_id，输出每个 task 的
   * 元数据 + 每个策略的核心指标 + 净值曲线，前端用 recharts 叠加绘图。
   *
   * 这是只读的聚合查询，不触发任何回测执行；调用方应自行筛选已完成 (status=COMPLETED) 的任务。
   */
  async compareBacktests(taskIds: number[]) {
    if (!Array.isArray(taskIds) || taskIds.length < 2) {
      throw new Error('至少需要 2 个回测任务才能对比');
    }
    if (taskIds.length > 4) {
      throw new Error('最多支持同时对比 4 个回测任务');
    }
    const uniqueIds = Array.from(new Set(taskIds.map(id => Number(id)))).filter(Boolean);
    const tasks = await QuantBacktestTask.findAll({
      where: { id: { [Op.in]: uniqueIds } },
      order: [['created_at', 'DESC']],
    });
    const results = uniqueIds.length
      ? await QuantBacktestResult.findAll({ where: { task_id: { [Op.in]: uniqueIds } } })
      : [];
    const resultsByTask = new Map<number, QuantBacktestResult[]>();
    for (const result of results) {
      if (!resultsByTask.has(result.task_id)) resultsByTask.set(result.task_id, []);
      resultsByTask.get(result.task_id)!.push(result);
    }

    const items = tasks.map(task => {
      const taskResults = resultsByTask.get(task.id) || [];
      const sortedResults = [...taskResults].sort(
        (a, b) => Number(b.total_return_pct || 0) - Number(a.total_return_pct || 0)
      );
      const best = sortedResults[0];
      return {
        task_id: task.id,
        task_name: task.task_name,
        status: task.status,
        start_date: this.normalizeDateOnly(task.start_date),
        end_date: this.normalizeDateOnly(task.end_date),
        universe: task.universe,
        strategy_keys: task.strategy_keys || [],
        initial_capital: Number(task.initial_capital || 0),
        run_summary: this.buildTaskRunSummary(task, taskResults),
        // 每个策略的核心 KPI（前端 KPI 表格列）
        strategy_results: sortedResults.map(r => ({
          strategy_key: r.strategy_key,
          strategy_name: r.strategy_name,
          total_return_pct: Number(r.total_return_pct || 0),
          annual_return_pct: Number(r.annual_return_pct || 0),
          excess_return_pct: Number(r.excess_return_pct || 0),
          benchmark_return_pct: Number(r.benchmark_return_pct || 0),
          max_drawdown_pct: Number(r.max_drawdown_pct || 0),
          sharpe_ratio: Number(r.sharpe_ratio || 0),
          win_rate: Number(r.win_rate || 0),
          profit_factor: Number(r.profit_factor || 0),
          trade_count: Number(r.trade_count || 0),
          avg_holding_days: Number(r.avg_holding_days || 0),
          // 换手率：metrics_json 中查找；不存在则 fallback 到 trade_count / 持仓上限近似
          turnover_rate: Number(
            (r.metrics_json as any)?.turnover_rate ??
              (r.metrics_json as any)?.execution_diagnostics?.turnover_rate ??
              0
          ),
        })),
        // 冠军策略的净值曲线（用于前端叠加绘图）
        best_strategy_key: best?.strategy_key || null,
        best_strategy_name: best?.strategy_name || null,
        best_equity_curve: (best?.equity_curve_json as any[]) || [],
      };
    });

    // 同时计算"任务×策略"维度的对比表（行=策略，列=任务），方便前端构建对比表
    const allStrategyKeys = new Set<string>();
    items.forEach(item => item.strategy_results.forEach(r => allStrategyKeys.add(r.strategy_key)));
    const strategy_comparison = Array.from(allStrategyKeys).map(strategy_key => {
      const cells = items.map(item => {
        const found = item.strategy_results.find(r => r.strategy_key === strategy_key);
        return {
          task_id: item.task_id,
          present: Boolean(found),
          total_return_pct: found?.total_return_pct ?? null,
          excess_return_pct: found?.excess_return_pct ?? null,
          max_drawdown_pct: found?.max_drawdown_pct ?? null,
          sharpe_ratio: found?.sharpe_ratio ?? null,
          win_rate: found?.win_rate ?? null,
          turnover_rate: found?.turnover_rate ?? null,
          trade_count: found?.trade_count ?? null,
        };
      });
      return { strategy_key, cells };
    });

    return {
      items,
      strategy_comparison,
      task_count: items.length,
      missing_task_ids: uniqueIds.filter(id => !items.find(item => item.task_id === id)),
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

  /**
   * US-045 hook：异步触发对每个 QuantBacktestResult 的基准归因计算（HS300 / CSI500 / CSI1000）。
   * Fire-and-forget — 错误隔离不抛错以免污染回测主流程；失败只写 warning 日志。
   */
  private triggerBenchmarkAttributionAsync(result_ids: number[], task_id: number): void {
    // lazy require — 避免顶层 import 让本服务测试 boot 整个 performance 子系统的代价
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const benchmarkModule = require('../../performance/BenchmarkAttributionService');
    const { benchmarkAttributionService } = benchmarkModule;
    Promise.all(
      result_ids.map(async result_id => {
        try {
          await benchmarkAttributionService.computeAttribution(
            { quant_backtest_result_id: result_id },
            { persist: true, source: 'backtest_hook' }
          );
        } catch (err) {
          logger.warn(
            `[backtest-hook] benchmark attribution failed for result #${result_id} (task #${task_id}): ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      })
    ).catch(err => {
      logger.warn(
        `[backtest-hook] benchmark attribution batch failed (task #${task_id}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }

  /**
   * US-046 hook：异步触发对每个 QuantBacktestResult 的行业归因计算。
   * Fire-and-forget — 与 US-045 同款错误隔离 + lazy require 模式；失败只写 warning。
   */
  private triggerIndustryAttributionAsync(result_ids: number[], task_id: number): void {
    // lazy require — 同 triggerBenchmarkAttributionAsync 范式
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const industryModule = require('../../performance/IndustryAttributionService');
    const { industryAttributionService } = industryModule;
    Promise.all(
      result_ids.map(async result_id => {
        try {
          await industryAttributionService.computeAttribution(
            { quant_backtest_result_id: result_id },
            { persist: true, source: 'backtest_hook' }
          );
        } catch (err) {
          logger.warn(
            `[backtest-hook] industry attribution failed for result #${result_id} (task #${task_id}): ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      })
    ).catch(err => {
      logger.warn(
        `[backtest-hook] industry attribution batch failed (task #${task_id}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }
}

export const quantBacktestService = new QuantBacktestService();
