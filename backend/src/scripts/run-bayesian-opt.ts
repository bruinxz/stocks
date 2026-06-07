#!/usr/bin/env node
/**
 * BayesianOptimizer CLI — US-038 高斯过程 + EI 贝叶斯参数搜索
 *
 * Usage:
 *   # 最简：跑 multi_factor_alpha 30 iter 默认 bounds
 *   npm run run:bayesian-opt -- \
 *     --strategy=multi_factor_alpha \
 *     --start=2025-01-01 --end=2025-12-31 \
 *     --bounds='{"topN":{"min":10,"max":50,"integer":true},"stopLossPct":{"min":-15,"max":-3}}'
 *
 *   # 高级：自定义 iter / init-points / exploration / 并发
 *   npm run run:bayesian-opt -- \
 *     --strategy=dragon_head_momentum \
 *     --start=2024-01-01 --end=2024-12-31 \
 *     --bounds='{"maxPositions":{"min":3,"max":10,"integer":true},"stopLossPct":{"min":-12,"max":-3}}' \
 *     --iterations=40 --init-points=8 --xi=0.05 --seed=2026
 *
 *   # 查询历史：列出已完成的 bayesian run
 *   npm run run:bayesian-opt -- --list
 *   npm run run:bayesian-opt -- --list --strategy=multi_factor_alpha
 *
 *   # 查看某个 run 的全部结果
 *   npm run run:bayesian-opt -- --show=42
 *
 *   # 清理 N 天前的旧 run
 *   npm run run:bayesian-opt -- --cleanup-days=30
 *
 * 选项：
 *   --strategy=<key>          必填（除非 --list / --show / --cleanup-days）
 *   --start=<YYYY-MM-DD>      回测起始日
 *   --end=<YYYY-MM-DD>        回测结束日
 *   --bounds='<json>'         参数边界 JSON, 形如 `{"topN":{"min":10,"max":50,"integer":true}}`
 *   --iterations=<n>          总采样次数（含 init_points），默认 30
 *   --init-points=<n>         初始拟随机均匀采样次数，默认 max(5, 2*D)
 *   --xi=<n>                  EI exploration factor，默认 0.01
 *   --length-scale=<n>        RBF kernel length scale（归一化空间），默认 0.3
 *   --jitter=<n>              GP 协方差矩阵对角线 jitter，默认 1e-6
 *   --seed=<n>                随机种子（同 seed 完全可复现），默认 42
 *   --capital=<n>             初始资金，默认 1,000,000
 *   --benchmark=<symbol>      基准代码，默认 sh.000300
 *   --universe=<scope>        股票池 'market'/'favorite'/'top100'（默认 market）
 *   --symbols=<csv>           显式股票列表（与 universe 二选一）
 *   --max-iterations=<n>      安全上限，默认 200
 *   --w-sharpe=<n>            composite_score sharpe 权重（默认 1.0）
 *   --w-annual=<n>            composite_score 年化权重（默认 0.4）
 *   --w-drawdown=<n>          composite_score 回撤权重（默认 0.5）
 *   --no-persist              不写库（用于本地试跑 + 打印结果）
 *   --list                    列出最近 30 个 bayesian run（不显示 grid_search）
 *   --show=<run_id>           展示指定 run 的全部 results
 *   --cleanup-days=<n>        删除 N 天前的所有 bayesian run
 *
 * 退出码：
 *   0 = 成功
 *   1 = 至少有一次 iter 失败但 run 整体成功
 *   2 = 严重错误（bounds 解析失败 / strategy 未注册 / DB 失败）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { bayesianOptimizer, ParamBounds } from '../quant/backtest/BayesianOptimizer';

const program = new Command();

program
  .name('run-bayesian-opt')
  .description('US-038 贝叶斯 (高斯过程 + EI) 参数搜索回测调优')
  .option('-s, --strategy <key>', '被优化的策略 key（StrategyRegistry 内）')
  .option('--start <date>', '回测起始日 YYYY-MM-DD')
  .option('--end <date>', '回测结束日 YYYY-MM-DD')
  .option(
    '-b, --bounds <json>',
    '参数边界 JSON 字符串 e.g. \'{"topN":{"min":10,"max":50,"integer":true}}\''
  )
  .option('--iterations <n>', '总采样次数（含 init_points）', '30')
  .option('--init-points <n>', '初始拟随机均匀采样次数（默认 max(5, 2*D)）')
  .option('--xi <n>', 'EI exploration factor', '0.01')
  .option('--length-scale <n>', 'RBF kernel length scale', '0.3')
  .option('--jitter <n>', 'GP 协方差 jitter', '1e-6')
  .option('--seed <n>', '随机种子', '42')
  .option('--capital <n>', '初始资金（默认 1,000,000）', '1000000')
  .option('--benchmark <symbol>', '基准代码（默认 sh.000300）', 'sh.000300')
  .option('--universe <scope>', '股票池 market/favorite/top100', 'market')
  .option('--symbols <csv>', '显式股票列表（逗号分隔）')
  .option('--max-iterations <n>', '安全上限 iter 数', '200')
  .option('--w-sharpe <n>', 'sharpe 权重（默认 1.0）')
  .option('--w-annual <n>', '年化权重（默认 0.4）')
  .option('--w-drawdown <n>', '回撤权重（默认 0.5）')
  .option('--no-persist', '不写库（试跑模式）')
  .option('--list', '列出最近 30 个 bayesian run')
  .option('--show <run_id>', '展示指定 run 的全部 results')
  .option('--cleanup-days <n>', '删除 N 天前的所有 bayesian run')
  .option('--user-id <n>', '触发者 user_id（落库 OptimizationRun.created_by）')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // 三种 admin 模式：--list / --show / --cleanup-days
      if (opts.list) {
        const runs = await bayesianOptimizer.listRuns({
          strategy_name: opts.strategy,
          limit: 30,
        });
        if (!runs.length) {
          logger.info('[bayesian] 没有找到任何 Bayesian OptimizationRun');
        } else {
          logger.info(`[bayesian] 最近 ${runs.length} 个 Bayesian OptimizationRun:`);
          for (const run of runs) {
            const finished = run.finished_at
              ? new Date(run.finished_at).toISOString()
              : '(running)';
            logger.info(
              `  #${run.id} ${run.strategy_name} status=${run.status} iter=${
                run.completed_combos
              }/${run.total_combos} failed=${run.failed_combos} best=${
                run.best_result_id || '-'
              } finished=${finished}`
            );
          }
        }
        process.exit(0);
      }

      if (opts.show) {
        const runId = parseInt(opts.show, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[bayesian] --show 需要数字 id, 收到 '${opts.show}'`);
          process.exit(2);
        }
        const results = await bayesianOptimizer.getRunResults(runId);
        if (!results.length) {
          logger.info(`[bayesian] run #${runId} 没有 results`);
          process.exit(0);
        }
        logger.info(
          `[bayesian] run #${runId} 全部 ${results.length} 个 iter (按 composite_score DESC):`
        );
        for (const r of results) {
          const params = JSON.stringify(r.params_json);
          if (r.status === 'failed') {
            logger.info(
              `  iter #${r.combo_index} status=failed params=${params} err=${r.error_message?.slice(
                0,
                80
              )}`
            );
          } else {
            logger.info(
              `  iter #${r.combo_index} score=${r.composite_score} sharpe=${r.sharpe} annual=${r.annual_return} dd=${r.max_drawdown} params=${params}`
            );
          }
        }
        process.exit(0);
      }

      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(`[bayesian] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`);
          process.exit(2);
        }
        const result = await bayesianOptimizer.cleanupOlderThan(days);
        logger.info(
          `[bayesian] 清理 ${days} 天前的 bayesian run: 删除 ${result.deleted_runs} run + ${result.deleted_results} result`
        );
        process.exit(0);
      }

      // ===== optimize 主流程 =====
      if (!opts.strategy) {
        logger.error('[bayesian] --strategy 必填');
        process.exit(2);
      }
      if (!opts.start || !opts.end) {
        logger.error('[bayesian] --start 与 --end 必填');
        process.exit(2);
      }
      if (!opts.bounds) {
        logger.error('[bayesian] --bounds 必填，JSON 字符串');
        process.exit(2);
      }
      let paramBounds: ParamBounds;
      try {
        paramBounds = JSON.parse(opts.bounds);
      } catch (err) {
        logger.error(`[bayesian] --bounds 解析失败: ${(err as Error).message}`);
        process.exit(2);
      }

      const symbols = opts.symbols
        ? String(opts.symbols)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : undefined;

      const weights: Record<string, number> = {};
      if (opts.wSharpe !== undefined) weights.sharpe = Number(opts.wSharpe);
      if (opts.wAnnual !== undefined) weights.annual = Number(opts.wAnnual);
      if (opts.wDrawdown !== undefined) weights.drawdown = Number(opts.wDrawdown);

      logger.info(
        `[bayesian] start: strategy=${opts.strategy} range=${opts.start}..${opts.end} bounds=${opts.bounds} iter=${opts.iterations}`
      );
      const t0 = Date.now();
      const out = await bayesianOptimizer.optimize(
        {
          strategy_key: opts.strategy,
          param_bounds: paramBounds,
          base_config: {
            start_date: opts.start,
            end_date: opts.end,
            initial_capital: Number(opts.capital || 1_000_000),
            benchmark_symbol: opts.benchmark,
            universe: opts.universe as any,
            symbols,
          },
        },
        {
          iterations: Number(opts.iterations || 30),
          init_points: opts.initPoints ? Number(opts.initPoints) : undefined,
          exploration_xi: Number(opts.xi || 0.01),
          kernel_length_scale: Number(opts.lengthScale || 0.3),
          kernel_jitter: Number(opts.jitter || 1e-6),
          seed: Number(opts.seed || 42),
          weights: Object.keys(weights).length ? weights : undefined,
          persist: opts.persist !== false,
          max_iterations: Number(opts.maxIterations || 200),
          user_id: opts.userId ? Number(opts.userId) : undefined,
        }
      );

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      logger.info(
        `[bayesian] done in ${elapsed}s: iter=${out.iterations_run} (init=${
          out.init_iterations
        }, ei=${out.ei_iterations}) failed=${out.failed_iterations} run_id=${
          out.run?.id ?? 'in-memory'
        }`
      );
      if (out.best) {
        logger.info(
          `[bayesian] 🏆 best: composite=${out.best.composite_score} sharpe=${
            out.best.sharpe
          } annual=${out.best.annual_return} dd=${out.best.max_drawdown} params=${JSON.stringify(
            out.best.params_json
          )}`
        );
      } else {
        logger.warn('[bayesian] 没有成功的 iter');
      }
      // 打印 top-5
      const top5 = out.ranked.slice(0, 5);
      logger.info(`[bayesian] top ${top5.length}:`);
      for (const r of top5) {
        const params = JSON.stringify(r.params_json);
        if (r.status === 'failed') {
          logger.info(
            `  iter #${r.combo_index} status=failed params=${params} err=${r.error_message?.slice(
              0,
              80
            )}`
          );
        } else {
          logger.info(
            `  iter #${r.combo_index} score=${r.composite_score} sharpe=${r.sharpe} annual=${r.annual_return} dd=${r.max_drawdown} params=${params}`
          );
        }
      }

      process.exit(out.failed_iterations > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`[bayesian] FATAL: ${(error as Error).message}`);
      process.exit(2);
    }
  });

program.parseAsync(process.argv);
