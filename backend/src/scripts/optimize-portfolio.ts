#!/usr/bin/env node
/**
 * PortfolioOptimizer CLI — US-044 多策略组合优化
 *
 * Usage:
 *   # 对 N 个已完成回测求解最优组合权重（最常用模式）
 *   npm run optimize:portfolio -- --backtest-result-ids=42,43,44
 *
 *   # 指定单策略权重上限（默认 0.4 = 40%）
 *   npm run optimize:portfolio -- --backtest-result-ids=42,43,44 --max-weight=0.5
 *
 *   # 用 trailing 60 日窗口求解（only most recent 60 common trading days）
 *   npm run optimize:portfolio -- --backtest-result-ids=42,43,44 --lookback-days=60
 *
 *   # 跑等权基线对比（不做迭代）
 *   npm run optimize:portfolio -- --backtest-result-ids=42,43,44 --solver=equal_weight
 *
 *   # dry-run 不写库（仅打印权重）
 *   npm run optimize:portfolio -- --backtest-result-ids=42,43,44 --no-persist
 *
 *   # 查询历史：列出最近 30 个组合优化结果
 *   npm run optimize:portfolio -- --list
 *
 *   # 查看某 portfolio_result_id 的完整详情
 *   npm run optimize:portfolio -- --show=42
 *
 *   # 删除某 portfolio_result_id
 *   npm run optimize:portfolio -- --delete-run=42
 *
 *   # 清理 N 天前的所有 portfolio 结果
 *   npm run optimize:portfolio -- --cleanup-days=30
 *
 * 选项：
 *   --backtest-result-ids=<csv>  逗号分隔 QuantBacktestResult.id 列表（≥ 2 个）
 *   --max-weight=<n>             单策略权重上限（默认 0.4）
 *   --min-weight=<n>             单策略权重下限（默认 0）
 *   --solver=<x>                 projected_gradient / equal_weight（默认 projected_gradient）
 *   --lookback-days=<n>          求解所用 trailing 窗口（默认全部）
 *   --learning-rate=<n>          PGA 学习率（默认 0.001）
 *   --max-iterations=<n>         PGA 最大迭代数（默认 5000）
 *   --tolerance=<n>              PGA 收敛 tolerance（默认 1e-6）
 *   --random-restarts=<n>        PGA 随机起点数量（默认 2 + 1 equal_weight）
 *   --seed=<n>                   RNG seed（默认 42）
 *   --notes=<str>                自由文本备注
 *   --no-persist                 不写库
 *   --list                       列出最近 30 个组合优化结果
 *   --show=<id>                  展示指定 id 的详情
 *   --delete-run=<id>            删除指定 id 的结果
 *   --cleanup-days=<n>           删除 N 天前的所有结果
 *
 * 退出码：
 *   0 = 成功
 *   2 = 严重错误（参数无效 / 找不到 backtest result / 无可行解 / DB 失败）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import {
  portfolioOptimizer,
  DEFAULT_MAX_WEIGHT,
  DEFAULT_MIN_WEIGHT,
  DEFAULT_LEARNING_RATE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOLERANCE,
  DEFAULT_RANDOM_RESTARTS,
  DEFAULT_SEED,
  PortfolioOptimizerSolver,
} from '../quant/backtest/PortfolioOptimizer';

const program = new Command();

program
  .name('optimize-portfolio')
  .description('US-044 多策略组合优化 — 求解最优权重组合最大化夏普')
  .option(
    '--backtest-result-ids <csv>',
    '逗号分隔 QuantBacktestResult.id 列表（必填，除非 --list / --show / --delete-run / --cleanup-days）'
  )
  .option('--max-weight <n>', `单策略权重上限（默认 ${DEFAULT_MAX_WEIGHT}）`)
  .option('--min-weight <n>', `单策略权重下限（默认 ${DEFAULT_MIN_WEIGHT}）`)
  .option('--solver <x>', 'projected_gradient / equal_weight（默认 projected_gradient）')
  .option('--lookback-days <n>', '求解所用 trailing 窗口（默认全部）')
  .option('--learning-rate <n>', `PGA 学习率（默认 ${DEFAULT_LEARNING_RATE}）`)
  .option('--max-iterations <n>', `PGA 最大迭代数（默认 ${DEFAULT_MAX_ITERATIONS}）`)
  .option('--tolerance <n>', `PGA 收敛 tolerance（默认 ${DEFAULT_TOLERANCE}）`)
  .option(
    '--random-restarts <n>',
    `PGA 随机起点数量（默认 ${DEFAULT_RANDOM_RESTARTS} + 1 equal_weight）`
  )
  .option('--seed <n>', `RNG seed（默认 ${DEFAULT_SEED}）`)
  .option('--notes <str>', '自由文本备注')
  .option('--no-persist', '不写库（试跑模式）')
  .option('--list', '列出最近 30 个组合优化结果')
  .option('--show <id>', '展示指定 portfolio_result_id 的详情')
  .option('--delete-run <id>', '删除指定 portfolio_result_id')
  .option('--cleanup-days <n>', '删除 N 天前的所有 portfolio 结果')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // ===== admin: --list =====
      if (opts.list) {
        const runs = await portfolioOptimizer.listRecentRuns(30);
        if (!runs.length) {
          logger.info('[portfolio-optimizer] 没有找到任何已优化过的组合');
        } else {
          logger.info(`[portfolio-optimizer] 最近 ${runs.length} 个组合优化结果:`);
          for (const r of runs) {
            const wStr = r.weights
              .map((w, i) => `${r.strategy_keys[i]}=${(w * 100).toFixed(1)}%`)
              .join(' ');
            logger.info(
              `  #${r.persisted_id} solver=${r.solver} converged=${r.converged} ` +
                `sharpe=${r.sharpe} annual=${r.annual_return}% max_dd=${r.max_drawdown}% | ${wStr}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --show =====
      if (opts.show) {
        const runId = parseInt(opts.show, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[portfolio-optimizer] --show 需要数字 id, 收到 '${opts.show}'`);
          process.exit(2);
        }
        const row = await portfolioOptimizer.getRun(runId);
        if (!row) {
          logger.info(`[portfolio-optimizer] portfolio_result #${runId} 未找到`);
          process.exit(0);
        }
        logger.info(`[portfolio-optimizer] portfolio_result #${runId}:`);
        logger.info(
          `  solver=${row.solver} converged=${row.converged} iterations=${row.iterations}`
        );
        logger.info(
          `  max_weight=${row.max_weight} min_weight=${row.min_weight} lookback=${
            row.lookback_days ?? 'all'
          }`
        );
        logger.info(
          `  period=${row.period_start ?? '?'}..${row.period_end ?? '?'} ` +
            `days=${row.daily_return_count}`
        );
        logger.info(
          `  sharpe=${row.sharpe} annual=${row.annual_return}% max_dd=${row.max_drawdown}%`
        );
        logger.info(`  weights:`);
        for (let i = 0; i < row.strategy_keys.length; i += 1) {
          logger.info(`    ${row.strategy_keys[i]} = ${(row.weights[i] * 100).toFixed(2)}%`);
        }
        if (row.notes) logger.info(`  notes: ${row.notes}`);
        logger.info(`  computed_at=${row.computed_at.toISOString()}`);
        process.exit(0);
      }

      // ===== admin: --delete-run =====
      if (opts.deleteRun) {
        const runId = parseInt(opts.deleteRun, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[portfolio-optimizer] --delete-run 需要数字 id, 收到 '${opts.deleteRun}'`);
          process.exit(2);
        }
        const result = await portfolioOptimizer.deleteRun(runId);
        logger.info(`[portfolio-optimizer] 删除 portfolio_result #${runId}: ${result.deleted} row`);
        process.exit(0);
      }

      // ===== admin: --cleanup-days =====
      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(
            `[portfolio-optimizer] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`
          );
          process.exit(2);
        }
        const result = await portfolioOptimizer.cleanupOlderThan(days);
        logger.info(
          `[portfolio-optimizer] 清理 ${days} 天前: 删除 ${result.deleted} portfolio 结果`
        );
        process.exit(0);
      }

      // ===== 主流程：求解组合优化 =====
      if (!opts.backtestResultIds) {
        logger.error('[portfolio-optimizer] --backtest-result-ids 必填');
        process.exit(2);
      }
      const ids = opts.backtestResultIds
        .split(',')
        .map((s: string) => parseInt(s.trim(), 10))
        .filter((n: number) => Number.isFinite(n) && n >= 1);
      if (ids.length < 2) {
        logger.error(
          `[portfolio-optimizer] 至少需要 2 个 backtest-result-ids, 实际解析 ${ids.length} 个: '${opts.backtestResultIds}'`
        );
        process.exit(2);
      }

      const maxWeight = opts.maxWeight ? Number(opts.maxWeight) : DEFAULT_MAX_WEIGHT;
      const minWeight = opts.minWeight ? Number(opts.minWeight) : DEFAULT_MIN_WEIGHT;
      const solver = (opts.solver as PortfolioOptimizerSolver) || 'projected_gradient';
      if (solver !== 'projected_gradient' && solver !== 'equal_weight') {
        logger.error(
          `[portfolio-optimizer] --solver 必须是 projected_gradient / equal_weight, 收到 '${solver}'`
        );
        process.exit(2);
      }
      const lookbackDays = opts.lookbackDays ? parseInt(opts.lookbackDays, 10) : null;
      const learningRate = opts.learningRate ? Number(opts.learningRate) : DEFAULT_LEARNING_RATE;
      const maxIterations = opts.maxIterations
        ? parseInt(opts.maxIterations, 10)
        : DEFAULT_MAX_ITERATIONS;
      const tolerance = opts.tolerance ? Number(opts.tolerance) : DEFAULT_TOLERANCE;
      const randomRestarts = opts.randomRestarts
        ? parseInt(opts.randomRestarts, 10)
        : DEFAULT_RANDOM_RESTARTS;
      const seed = opts.seed ? parseInt(opts.seed, 10) : DEFAULT_SEED;

      if (
        !Number.isFinite(maxWeight) ||
        !Number.isFinite(minWeight) ||
        !Number.isFinite(learningRate) ||
        !Number.isFinite(maxIterations) ||
        !Number.isFinite(tolerance) ||
        !Number.isFinite(randomRestarts) ||
        !Number.isFinite(seed)
      ) {
        logger.error('[portfolio-optimizer] 数值参数解析失败');
        process.exit(2);
      }

      logger.info(
        `[portfolio-optimizer] start: ids=${ids.join(',')} solver=${solver} ` +
          `max_weight=${maxWeight} min_weight=${minWeight} ` +
          `lookback=${lookbackDays ?? 'all'} seed=${seed} persist=${opts.persist !== false}`
      );
      const out = await portfolioOptimizer.optimize(
        { quant_backtest_result_ids: ids, notes: opts.notes },
        {
          max_weight: maxWeight,
          min_weight: minWeight,
          solver,
          learning_rate: learningRate,
          max_iterations: maxIterations,
          tolerance,
          random_restarts: randomRestarts,
          seed,
          lookback_days: lookbackDays,
          persist: opts.persist !== false,
        }
      );

      logger.info(
        `[portfolio-optimizer] done in ${(out.duration_ms / 1000).toFixed(2)}s ` +
          `(persisted_id=${out.persisted_id ?? 'in-memory'})`
      );
      logger.info(`[portfolio-optimizer] === 最优权重 ===`);
      for (let i = 0; i < out.strategy_keys.length; i += 1) {
        logger.info(`  ${out.strategy_keys[i]} = ${(out.weights[i] * 100).toFixed(2)}%`);
      }
      logger.info(`[portfolio-optimizer] === 组合指标 ===`);
      logger.info(`  annual_return = ${out.annual_return ?? 'NaN'}%`);
      logger.info(`  sharpe        = ${out.sharpe ?? 'NaN'}`);
      logger.info(`  max_drawdown  = ${out.max_drawdown ?? 'NaN'}%`);
      logger.info(
        `  solver=${out.solver} converged=${out.converged} iterations=${out.iterations} ` +
          `daily_returns=${out.daily_return_count}`
      );
      logger.info(
        `  period=${out.period_start ?? '?'}..${out.period_end ?? '?'} ` +
          `lookback=${out.lookback_days ?? 'all'}`
      );
      process.exit(0);
    } catch (error) {
      logger.error(`[portfolio-optimizer] FATAL: ${(error as Error).message}`);
      process.exit(2);
    }
  });

program.parse(process.argv);
