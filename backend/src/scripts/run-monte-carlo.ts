#!/usr/bin/env node
/**
 * MonteCarloStressTest CLI — US-043 蒙特卡洛压力测试
 *
 * Usage:
 *   # 对已完成的回测做 1000 次蒙特卡洛模拟（最常用模式）
 *   npm run run:monte-carlo -- --backtest-result-id=42
 *
 *   # 指定模拟次数（debug 用 100 / 大场景 5000）
 *   npm run run:monte-carlo -- --backtest-result-id=42 --simulations=5000
 *
 *   # 指定 seed 做敏感性分析（对比不同 seed 的稳健性）
 *   npm run run:monte-carlo -- --backtest-result-id=42 --seed=100
 *
 *   # dry-run 不写库（仅打印分布）
 *   npm run run:monte-carlo -- --backtest-result-id=42 --no-persist
 *
 *   # 查询历史：列出最近 30 个有 MC 结果的 base_run_id
 *   npm run run:monte-carlo -- --list
 *
 *   # 查看某 base_run_id 的全部 seeds 结果
 *   npm run run:monte-carlo -- --show=42
 *
 *   # 仅删除某 base_run_id 的全部 MC 结果（保留源 QuantBacktestResult）
 *   npm run run:monte-carlo -- --delete-run=42
 *
 *   # 清理 N 天前的全部 MC 结果
 *   npm run run:monte-carlo -- --cleanup-days=30
 *
 * 选项：
 *   --backtest-result-id=<n>  QuantBacktestResult.id（必填，除非 admin 模式）
 *   --simulations=<n>         模拟次数（默认 1000；范围 1..100_000）
 *   --seed=<n>                RNG seed（默认 42）
 *   --no-persist              不写库
 *   --list                    列出最近 30 个有 MC 结果的 run
 *   --show=<run_id>           展示指定 run 的全部 seeds 结果
 *   --delete-run=<run_id>     删除指定 run 的全部 MC 结果
 *   --cleanup-days=<n>        删除 N 天前的所有 MC 结果
 *
 * 退出码：
 *   0 = 成功
 *   2 = 严重错误（参数无效 / 找不到 backtest result / trades 不足 / DB 失败）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import {
  monteCarloStressTest,
  DEFAULT_SIMULATION_COUNT,
  DEFAULT_SEED,
  MAX_SIMULATION_COUNT,
  MIN_SIMULATION_COUNT,
} from '../quant/backtest/MonteCarloStressTest';

const program = new Command();

program
  .name('run-monte-carlo')
  .description('US-043 蒙特卡洛压力测试 — 对回测做交易重排稳健性分析')
  .option(
    '--backtest-result-id <n>',
    '父 QuantBacktestResult.id（必填，除非 --list / --show / --delete-run / --cleanup-days）'
  )
  .option(
    '--simulations <n>',
    `模拟次数（默认 ${DEFAULT_SIMULATION_COUNT}；范围 ${MIN_SIMULATION_COUNT}..${MAX_SIMULATION_COUNT}）`
  )
  .option('--seed <n>', `RNG seed（默认 ${DEFAULT_SEED}）`)
  .option('--no-persist', '不写库（试跑模式）')
  .option('--list', '列出最近 30 个有 MC 结果的 run')
  .option('--show <base_run_id>', '展示指定 run 的全部 seeds 结果')
  .option('--delete-run <base_run_id>', '删除指定 run 的全部 MC 结果（保留源结果）')
  .option('--cleanup-days <n>', '删除 N 天前的所有 MC 结果')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // ===== admin: --list =====
      if (opts.list) {
        const runs = await monteCarloStressTest.listRecentRuns(30);
        if (!runs.length) {
          logger.info('[monte-carlo] 没有找到任何已 MC 跑过的回测');
        } else {
          logger.info(`[monte-carlo] 最近 ${runs.length} 个已 MC 跑过的回测:`);
          for (const r of runs) {
            logger.info(
              `  base_run #${r.base_run_id} ${r.strategy_key} ` +
                `seeds=${r.seed_count} latest=${r.latest_computed_at.toISOString()}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --show =====
      if (opts.show) {
        const runId = parseInt(opts.show, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[monte-carlo] --show 需要数字 base_run_id, 收到 '${opts.show}'`);
          process.exit(2);
        }
        const rows = await monteCarloStressTest.getRunResults(runId);
        if (!rows.length) {
          logger.info(`[monte-carlo] base_run #${runId} 没有 MC 结果`);
          process.exit(0);
        }
        logger.info(`[monte-carlo] base_run #${runId} 全部 ${rows.length} 个 seed 结果:`);
        for (const r of rows) {
          logger.info(
            `  seed=${r.seed} strategy=${r.strategy_key} simulations=${r.simulation_count} ` +
              `trades=${r.trade_count} | return_p5=${r.return_p5 ?? 'NaN'}% ` +
              `return_p50=${r.return_p50 ?? 'NaN'}% return_p95=${r.return_p95 ?? 'NaN'}% | ` +
              `dd_p95=${r.drawdown_p95 ?? 'NaN'}% sharpe_p5=${r.sharpe_p5 ?? 'NaN'} | ` +
              `positive_ratio=${r.positive_simulation_ratio ?? 'NaN'} ` +
              `computed_at=${r.computed_at?.toISOString?.() ?? r.computed_at}`
          );
        }
        process.exit(0);
      }

      // ===== admin: --delete-run =====
      if (opts.deleteRun) {
        const runId = parseInt(opts.deleteRun, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[monte-carlo] --delete-run 需要数字 base_run_id, 收到 '${opts.deleteRun}'`);
          process.exit(2);
        }
        const result = await monteCarloStressTest.deleteRun(runId);
        logger.info(`[monte-carlo] 删除 base_run #${runId}: ${result.deleted} MC 结果`);
        process.exit(0);
      }

      // ===== admin: --cleanup-days =====
      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(`[monte-carlo] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`);
          process.exit(2);
        }
        const result = await monteCarloStressTest.cleanupOlderThan(days);
        logger.info(`[monte-carlo] 清理 ${days} 天前: 删除 ${result.deleted} MC 结果`);
        process.exit(0);
      }

      // ===== 主流程：run 蒙特卡洛 =====
      if (!opts.backtestResultId) {
        logger.error('[monte-carlo] --backtest-result-id 必填');
        process.exit(2);
      }
      const resultId = parseInt(opts.backtestResultId, 10);
      if (!Number.isFinite(resultId) || resultId < 1) {
        logger.error(
          `[monte-carlo] --backtest-result-id 必须是 >= 1 的整数, 收到 '${opts.backtestResultId}'`
        );
        process.exit(2);
      }

      const simulations = opts.simulations
        ? parseInt(opts.simulations, 10)
        : DEFAULT_SIMULATION_COUNT;
      if (!Number.isFinite(simulations) || simulations < MIN_SIMULATION_COUNT) {
        logger.error(
          `[monte-carlo] --simulations 必须 >= ${MIN_SIMULATION_COUNT}, 收到 '${opts.simulations}'`
        );
        process.exit(2);
      }
      if (simulations > MAX_SIMULATION_COUNT) {
        logger.error(
          `[monte-carlo] --simulations 必须 <= ${MAX_SIMULATION_COUNT}, 收到 '${opts.simulations}'`
        );
        process.exit(2);
      }
      const seed = opts.seed ? parseInt(opts.seed, 10) : DEFAULT_SEED;
      if (!Number.isFinite(seed)) {
        logger.error(`[monte-carlo] --seed 必须是整数, 收到 '${opts.seed}'`);
        process.exit(2);
      }

      logger.info(
        `[monte-carlo] start: base_run_id=${resultId} simulations=${simulations} seed=${seed} ` +
          `persist=${opts.persist !== false}`
      );
      const out = await monteCarloStressTest.run(
        { quant_backtest_result_id: resultId },
        {
          simulation_count: simulations,
          seed,
          persist: opts.persist !== false,
        }
      );

      const d = out.distribution;
      logger.info(
        `[monte-carlo] done: base_run_id=${out.base_run_id} seed=${out.seed} ` +
          `simulations=${out.simulation_count} trade_count=${d.trade_count} ` +
          `duration=${(out.duration_ms / 1000).toFixed(2)}s ` +
          `(${out.persisted_id !== null ? '1 row persisted' : 'in-memory only'})`
      );
      logger.info(
        `[monte-carlo] === 最终收益分布 ===\n` +
          `  return_p5  = ${d.return_p5 ?? 'NaN'}%  (5% 最差模拟最终收益)\n` +
          `  return_p50 = ${d.return_p50 ?? 'NaN'}%  (中位数)\n` +
          `  return_p95 = ${d.return_p95 ?? 'NaN'}%  (5% 最好模拟最终收益)\n` +
          `  return_mean = ${d.return_mean ?? 'NaN'}%  (均值)\n` +
          `  return_std  = ${d.return_std ?? 'NaN'}%  (波动)`
      );
      logger.info(
        `[monte-carlo] === 最大回撤 / 夏普分布 ===\n` +
          `  drawdown_p95   = ${d.drawdown_p95 ?? 'NaN'}%  (5% 概率回撤 ≥ 此值；正数)\n` +
          `  drawdown_mean  = ${d.drawdown_mean ?? 'NaN'}%  (回撤均值)\n` +
          `  sharpe_p5      = ${d.sharpe_p5 ?? 'NaN'}  (5% 分位下沿；策略稳健性参考)\n` +
          `  sharpe_mean    = ${d.sharpe_mean ?? 'NaN'}  (均值)`
      );
      logger.info(
        `[monte-carlo] === 诊断 ===\n` +
          `  positive_simulation_ratio = ${d.positive_simulation_ratio ?? 'NaN'} ` +
          `(N 次模拟里最终盈利的占比；远低于 0.5 = 策略靠少数高赢交易撑起)`
      );
      process.exit(0);
    } catch (error) {
      logger.error(`[monte-carlo] FATAL: ${(error as Error).message}`);
      process.exit(2);
    }
  });

program.parse(process.argv);
