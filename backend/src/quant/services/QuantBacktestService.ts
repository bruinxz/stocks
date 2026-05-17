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

export class QuantBacktestService {
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
      await updateProgress(35);
      const benchmarkReturn = await this.resolveBenchmarkReturn(options);
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
      await task.update({ status: 'COMPLETED', progress: 100, error_message: null });
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
    });
  }

  async listBacktests(user_id?: number, limit = 30) {
    const where: any = {};
    if (user_id) where.user_id = user_id;
    return QuantBacktestTask.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Number(limit || 30), 100),
    });
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
    return { task, results, trades };
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
