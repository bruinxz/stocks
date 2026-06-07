#!/usr/bin/env node
/**
 * GridSearchOptimizer CLI — US-037 多维参数网格回测调优
 *
 * Usage:
 *   # 最简：跑 multi_factor_alpha 默认 demo 网格
 *   npm run run:grid-search -- \
 *     --strategy=multi_factor_alpha \
 *     --start=2025-01-01 --end=2025-12-31 \
 *     --grid='{"topN":[20,30,50],"industryNeutral":[true,false]}'
 *
 *   # 高级：指定 universe + 初始资金 + max_combos + 并发
 *   npm run run:grid-search -- \
 *     --strategy=ma_trend \
 *     --start=2024-01-01 --end=2024-12-31 \
 *     --grid='{"short_period":[5,8,10],"long_period":[20,30,50]}' \
 *     --capital=1000000 --max-combos=18 --concurrency=2
 *
 *   # 查询历史：列出已完成的 run
 *   npm run run:grid-search -- --list
 *   npm run run:grid-search -- --list --strategy=multi_factor_alpha
 *
 *   # 查看某个 run 的全部结果
 *   npm run run:grid-search -- --show=42
 *
 *   # 清理 N 天前的旧 run
 *   npm run run:grid-search -- --cleanup-days=30
 *
 * 选项：
 *   --strategy=<key>          必填（除非 --list / --show / --cleanup-days）
 *   --start=<YYYY-MM-DD>      回测起始日
 *   --end=<YYYY-MM-DD>        回测结束日
 *   --grid='<json>'           参数网格 JSON 字符串
 *   --capital=<n>             初始资金，默认 1,000,000
 *   --benchmark=<symbol>      基准代码，默认 sh.000300
 *   --universe=<scope>        股票池 'market'/'favorite'/'top100'（默认 market）
 *   --symbols=<csv>           显式股票列表（与 universe 二选一）
 *   --max-combos=<n>          最多跑的组合数，默认 256
 *   --concurrency=<n>         并发度，默认 1
 *   --w-sharpe=<n>            composite_score sharpe 权重（默认 1.0）
 *   --w-annual=<n>            composite_score 年化权重（默认 0.4）
 *   --w-drawdown=<n>          composite_score 回撤权重（默认 0.5）
 *   --no-persist              不写库（用于本地试跑 + 打印结果）
 *   --list                    列出最近 30 个 run
 *   --show=<run_id>           展示指定 run 的全部 results
 *   --cleanup-days=<n>        删除 N 天前的所有 run
 *
 * 退出码：
 *   0 = 成功
 *   1 = 至少有一个组合 backtest 失败但 run 整体成功
 *   2 = 严重错误（grid 解析失败 / strategy 未注册 / DB 失败）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { gridSearchOptimizer } from '../quant/backtest/GridSearchOptimizer';

const program = new Command();

program
  .name('run-grid-search')
  .description('US-037 多维参数 grid search 回测调优')
  .option('-s, --strategy <key>', '被优化的策略 key（StrategyRegistry 内）')
  .option('--start <date>', '回测起始日 YYYY-MM-DD')
  .option('--end <date>', '回测结束日 YYYY-MM-DD')
  .option('-g, --grid <json>', '参数网格 JSON 字符串 e.g. \'{"topN":[10,20]}\'')
  .option('--capital <n>', '初始资金（默认 1,000,000）', '1000000')
  .option('--benchmark <symbol>', '基准代码（默认 sh.000300）', 'sh.000300')
  .option('--universe <scope>', '股票池 market/favorite/top100', 'market')
  .option('--symbols <csv>', '显式股票列表（逗号分隔）')
  .option('--max-combos <n>', '最多跑的组合数（默认 256）', '256')
  .option('--concurrency <n>', '并发度（默认 1）', '1')
  .option('--w-sharpe <n>', 'sharpe 权重（默认 1.0）')
  .option('--w-annual <n>', '年化权重（默认 0.4）')
  .option('--w-drawdown <n>', '回撤权重（默认 0.5）')
  .option('--no-persist', '不写库（试跑模式）')
  .option('--list', '列出最近 30 个 run')
  .option('--show <run_id>', '展示指定 run 的全部 results')
  .option('--cleanup-days <n>', '删除 N 天前的所有 run')
  .option('--user-id <n>', '触发者 user_id（落库 OptimizationRun.created_by）')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // 三种 admin 模式：--list / --show / --cleanup-days
      if (opts.list) {
        const runs = await gridSearchOptimizer.listRuns({
          strategy_name: opts.strategy,
          limit: 30,
        });
        if (!runs.length) {
          logger.info('[grid-search] 没有找到任何 OptimizationRun');
        } else {
          logger.info(`[grid-search] 最近 ${runs.length} 个 OptimizationRun:`);
          for (const run of runs) {
            const finished = run.finished_at
              ? new Date(run.finished_at).toISOString()
              : '(running)';
            logger.info(
              `  #${run.id} ${run.strategy_name} status=${run.status} combos=${
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
          logger.error(`[grid-search] --show 需要数字 id, 收到 '${opts.show}'`);
          process.exit(2);
        }
        const results = await gridSearchOptimizer.getRunResults(runId);
        if (!results.length) {
          logger.info(`[grid-search] run #${runId} 没有 results`);
          process.exit(0);
        }
        logger.info(
          `[grid-search] run #${runId} 全部 ${results.length} 个 results (按 composite_score DESC):`
        );
        for (const r of results) {
          const params = JSON.stringify(r.params_json);
          if (r.status === 'failed') {
            logger.info(
              `  #${r.combo_index} status=failed params=${params} err=${r.error_message?.slice(
                0,
                80
              )}`
            );
          } else {
            logger.info(
              `  #${r.combo_index} score=${r.composite_score} sharpe=${r.sharpe} annual=${r.annual_return} dd=${r.max_drawdown} params=${params}`
            );
          }
        }
        process.exit(0);
      }

      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(`[grid-search] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`);
          process.exit(2);
        }
        const result = await gridSearchOptimizer.cleanupOlderThan(days);
        logger.info(
          `[grid-search] 清理 ${days} 天前的 run: 删除 ${result.deleted_runs} run + ${result.deleted_results} result`
        );
        process.exit(0);
      }

      // ===== optimize 主流程 =====
      if (!opts.strategy) {
        logger.error('[grid-search] --strategy 必填');
        process.exit(2);
      }
      if (!opts.start || !opts.end) {
        logger.error('[grid-search] --start 与 --end 必填');
        process.exit(2);
      }
      if (!opts.grid) {
        logger.error('[grid-search] --grid 必填，JSON 字符串');
        process.exit(2);
      }
      let paramGrid: Record<string, any[]>;
      try {
        paramGrid = JSON.parse(opts.grid);
      } catch (err) {
        logger.error(`[grid-search] --grid 解析失败: ${(err as Error).message}`);
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
        `[grid-search] start: strategy=${opts.strategy} range=${opts.start}..${opts.end} grid=${opts.grid}`
      );
      const t0 = Date.now();
      const out = await gridSearchOptimizer.optimize(
        {
          strategy_key: opts.strategy,
          param_grid: paramGrid,
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
          weights: Object.keys(weights).length ? weights : undefined,
          persist: opts.persist !== false,
          concurrency: Number(opts.concurrency || 1),
          max_combos: Number(opts.maxCombos || 256),
          user_id: opts.userId ? Number(opts.userId) : undefined,
        }
      );

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      logger.info(
        `[grid-search] done in ${elapsed}s: combos=${out.combos_run} failed=${
          out.failed_combos
        } run_id=${out.run?.id ?? 'in-memory'}`
      );
      if (out.best) {
        logger.info(
          `[grid-search] 🏆 best combo: composite=${out.best.composite_score} sharpe=${
            out.best.sharpe
          } annual=${out.best.annual_return} dd=${out.best.max_drawdown} params=${JSON.stringify(
            out.best.params_json
          )}`
        );
      } else {
        logger.warn('[grid-search] 没有成功的 combo');
      }
      // 打印 top-5
      const top5 = out.ranked.slice(0, 5);
      logger.info(`[grid-search] top ${top5.length}:`);
      for (const r of top5) {
        const params = JSON.stringify(r.params_json);
        if (r.status === 'failed') {
          logger.info(
            `  #${r.combo_index} status=failed params=${params} err=${r.error_message?.slice(
              0,
              80
            )}`
          );
        } else {
          logger.info(
            `  #${r.combo_index} score=${r.composite_score} sharpe=${r.sharpe} annual=${r.annual_return} dd=${r.max_drawdown} params=${params}`
          );
        }
      }

      process.exit(out.failed_combos > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`[grid-search] FATAL: ${(error as Error).message}`);
      process.exit(2);
    }
  });

program.parseAsync(process.argv);
