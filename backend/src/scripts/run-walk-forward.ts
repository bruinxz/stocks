#!/usr/bin/env node
/**
 * WalkForwardValidator CLI — US-039 滚动 walk-forward 验证
 *
 * Usage:
 *   # 最简：跑 multi_factor_alpha 12 个月 train + 3 个月 test 滚动
 *   npm run run:walk-forward -- \
 *     --strategy=multi_factor_alpha \
 *     --start=2023-01-01 --end=2025-12-31 \
 *     --train-months=12 --test-months=3 \
 *     --grid='{"topN":[20,30,50],"industryNeutral":[true,false]}'
 *
 *   # 高级：指定 universe + 初始资金 + train 阶段并发
 *   npm run run:walk-forward -- \
 *     --strategy=ma_trend \
 *     --start=2022-01-01 --end=2025-06-30 \
 *     --train-months=18 --test-months=6 \
 *     --grid='{"short_period":[5,8,10],"long_period":[20,30,50]}' \
 *     --capital=1000000 --train-concurrency=2
 *
 *   # 查询历史：列出已完成的 walk-forward run
 *   npm run run:walk-forward -- --list
 *   npm run run:walk-forward -- --list --strategy=multi_factor_alpha
 *
 *   # 查看某个 run 的全部 windows
 *   npm run run:walk-forward -- --show=42
 *
 *   # 清理 N 天前的旧 run + 关联 windows + train runs
 *   npm run run:walk-forward -- --cleanup-days=30
 *
 * 选项：
 *   --strategy=<key>          必填（除非 --list / --show / --cleanup-days）
 *   --start=<YYYY-MM-DD>      总区间起始日
 *   --end=<YYYY-MM-DD>        总区间结束日
 *   --train-months=<n>        train 窗口月数（默认 12）
 *   --test-months=<n>         test 窗口月数（默认 3）
 *   --grid='<json>'           参数网格 JSON 字符串（同 GridSearchOptimizer）
 *   --capital=<n>             初始资金，默认 1,000,000
 *   --benchmark=<symbol>      基准代码，默认 sh.000300
 *   --universe=<scope>        股票池 'market'/'favorite'/'top100'（默认 market）
 *   --symbols=<csv>           显式股票列表（与 universe 二选一）
 *   --train-concurrency=<n>   train 阶段 grid 内并发度，默认 1
 *   --max-combos=<n>          train 阶段最多跑的组合数，默认 256
 *   --w-sharpe=<n>            composite_score sharpe 权重（默认 1.0）
 *   --w-annual=<n>            composite_score 年化权重（默认 0.4）
 *   --w-drawdown=<n>          composite_score 回撤权重（默认 0.5）
 *   --no-persist              不写库（用于本地试跑 + 打印结果）
 *   --no-persist-train        不写 train 阶段 OptimizationRun/Results
 *   --list                    列出最近 30 个 run
 *   --show=<run_id>           展示指定 run 的全部 windows
 *   --cleanup-days=<n>        删除 N 天前的所有 run（含 train 阶段子 runs）
 *
 * 退出码：
 *   0 = 成功
 *   1 = 至少有一个窗口 train 或 test 失败但 run 整体跑完
 *   2 = 严重错误（grid 解析失败 / strategy 未注册 / 总区间不足 / DB 失败）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { walkForwardValidator } from '../quant/backtest/WalkForwardValidator';

const program = new Command();

program
  .name('run-walk-forward')
  .description('US-039 滚动 walk-forward 验证')
  .option('-s, --strategy <key>', '被验证的策略 key（StrategyRegistry 内）')
  .option('--start <date>', '总区间起始日 YYYY-MM-DD')
  .option('--end <date>', '总区间结束日 YYYY-MM-DD')
  .option('--train-months <n>', 'train 窗口月数（默认 12）', '12')
  .option('--test-months <n>', 'test 窗口月数（默认 3）', '3')
  .option('-g, --grid <json>', '参数网格 JSON 字符串 e.g. \'{"topN":[10,20]}\'')
  .option('--capital <n>', '初始资金（默认 1,000,000）', '1000000')
  .option('--benchmark <symbol>', '基准代码（默认 sh.000300）', 'sh.000300')
  .option('--universe <scope>', '股票池 market/favorite/top100', 'market')
  .option('--symbols <csv>', '显式股票列表（逗号分隔）')
  .option('--train-concurrency <n>', 'train 阶段 grid 内并发度（默认 1）', '1')
  .option('--max-combos <n>', 'train 阶段最多跑的组合数（默认 256）', '256')
  .option('--w-sharpe <n>', 'sharpe 权重（默认 1.0）')
  .option('--w-annual <n>', '年化权重（默认 0.4）')
  .option('--w-drawdown <n>', '回撤权重（默认 0.5）')
  .option('--no-persist', '不写库（试跑模式）')
  .option('--no-persist-train', '不写 train 阶段子 OptimizationRun/Results（节省 DB 写入）')
  .option('--list', '列出最近 30 个 walk-forward run')
  .option('--show <run_id>', '展示指定 run 的全部 windows')
  .option('--cleanup-days <n>', '删除 N 天前的所有 walk-forward run')
  .option('--user-id <n>', '触发者 user_id（落库 OptimizationRun.created_by）')
  // Phase 1: 新增选项
  .option('--scheme <type>', 'rolling 或 cpcv (Phase 1; 默认 rolling)', 'rolling')
  .option('--cpcv-n <n>', 'CPCV 总分区数 (scheme=cpcv 时；默认 6)', '6')
  .option('--cpcv-k <n>', 'CPCV 每路径 test 组数 (默认 2 → C(6,2)=15 paths)', '2')
  .option('--purge-days <n>', 'purging label_horizon_days (默认 0=关闭；推荐 5)', '0')
  .option('--embargo-days <n>', 'embargo 天数 (默认 0=关闭；推荐 2)', '0')
  .option('--optimizer <type>', 'grid_search 或 bayesian (默认 grid_search)', 'grid_search')
  .option('--bounds <json>', 'optimizer=bayesian 时的 param_bounds JSON e.g. \'{"topN":{"min":10,"max":50,"integer":true}}\'')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // ===== admin: --list =====
      if (opts.list) {
        const runs = await walkForwardValidator.listRuns({
          strategy_name: opts.strategy,
          limit: 30,
        });
        if (!runs.length) {
          logger.info('[walk-forward] 没有找到任何 walk-forward 类型的 OptimizationRun');
        } else {
          logger.info(`[walk-forward] 最近 ${runs.length} 个 walk-forward run:`);
          for (const run of runs) {
            const finished = run.finished_at
              ? new Date(run.finished_at).toISOString()
              : '(running)';
            logger.info(
              `  #${run.id} ${run.strategy_name} status=${run.status} windows=${
                run.completed_combos
              }/${run.total_combos} failed=${run.failed_combos} best_window=${
                run.best_result_id || '-'
              } finished=${finished}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --show =====
      if (opts.show) {
        const runId = parseInt(opts.show, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[walk-forward] --show 需要数字 id, 收到 '${opts.show}'`);
          process.exit(2);
        }
        const windows = await walkForwardValidator.getRunWindows(runId);
        if (!windows.length) {
          logger.info(`[walk-forward] run #${runId} 没有 windows`);
          process.exit(0);
        }
        logger.info(`[walk-forward] run #${runId} 全部 ${windows.length} 个 windows:`);
        for (const w of windows) {
          const params = JSON.stringify(w.best_params_json);
          if (w.status !== 'completed') {
            logger.info(
              `  #${w.window_index} status=${w.status} train=${w.train_start_date}..${
                w.train_end_date
              } test=${w.test_start_date}..${w.test_end_date} err=${w.error_message?.slice(0, 80)}`
            );
          } else {
            logger.info(
              `  #${w.window_index} train=${w.train_start_date}..${w.train_end_date} ` +
                `test=${w.test_start_date}..${w.test_end_date} ` +
                `train_sharpe=${w.train_sharpe} test_sharpe=${w.test_sharpe} ` +
                `test_return=${w.test_return} test_dd=${w.test_drawdown} best=${params}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --cleanup-days =====
      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(`[walk-forward] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`);
          process.exit(2);
        }
        const result = await walkForwardValidator.cleanupOlderThan(days);
        logger.info(
          `[walk-forward] 清理 ${days} 天前: 删除 ${result.deleted_runs} run + ${result.deleted_windows} window + ` +
            `${result.deleted_train_runs} train_run + ${result.deleted_train_results} train_result`
        );
        process.exit(0);
      }

      // ===== validate 主流程 =====
      if (!opts.strategy) {
        logger.error('[walk-forward] --strategy 必填');
        process.exit(2);
      }
      if (!opts.start || !opts.end) {
        logger.error('[walk-forward] --start 与 --end 必填');
        process.exit(2);
      }

      // Phase 1: 校验 scheme + optimizer + 互斥参数
      const scheme = String(opts.scheme || 'rolling').toLowerCase();
      if (!['rolling', 'cpcv'].includes(scheme)) {
        logger.error(`[walk-forward] --scheme 必须 rolling 或 cpcv，收到 '${opts.scheme}'`);
        process.exit(2);
      }
      const optimizerType = String(opts.optimizer || 'grid_search').toLowerCase();
      if (!['grid_search', 'bayesian'].includes(optimizerType)) {
        logger.error(`[walk-forward] --optimizer 必须 grid_search 或 bayesian，收到 '${opts.optimizer}'`);
        process.exit(2);
      }

      let paramGrid: Record<string, any[]> | undefined;
      let paramBounds: Record<string, { min: number; max: number; integer?: boolean }> | undefined;

      if (optimizerType === 'grid_search') {
        if (!opts.grid) {
          logger.error('[walk-forward] --grid 必填 (optimizer=grid_search)，JSON 字符串');
          process.exit(2);
        }
        try {
          paramGrid = JSON.parse(opts.grid);
        } catch (err) {
          logger.error(`[walk-forward] --grid 解析失败: ${(err as Error).message}`);
          process.exit(2);
        }
      } else {
        // bayesian
        if (!opts.bounds) {
          logger.error('[walk-forward] --bounds 必填 (optimizer=bayesian)，JSON 字符串');
          process.exit(2);
        }
        try {
          paramBounds = JSON.parse(opts.bounds);
        } catch (err) {
          logger.error(`[walk-forward] --bounds 解析失败: ${(err as Error).message}`);
          process.exit(2);
        }
      }

      const trainMonths = parseInt(opts.trainMonths || '12', 10);
      const testMonths = parseInt(opts.testMonths || '3', 10);
      if (!Number.isFinite(trainMonths) || trainMonths < 1) {
        logger.error(`[walk-forward] --train-months 必须 >= 1, 收到 '${opts.trainMonths}'`);
        process.exit(2);
      }
      if (!Number.isFinite(testMonths) || testMonths < 1) {
        logger.error(`[walk-forward] --test-months 必须 >= 1, 收到 '${opts.testMonths}'`);
        process.exit(2);
      }

      // Phase 1: purging config
      const purgeDays = parseInt(opts.purgeDays || '0', 10);
      const embargoDays = parseInt(opts.embargoDays || '0', 10);
      const purging =
        purgeDays > 0 || embargoDays > 0
          ? { label_horizon_days: purgeDays, embargo_days: embargoDays }
          : null;

      // Phase 1: cpcv config
      const cpcvN = parseInt(opts.cpcvN || '6', 10);
      const cpcvK = parseInt(opts.cpcvK || '2', 10);
      const cpcvConfig = { n_groups: cpcvN, k_test_groups: cpcvK };

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
        `[walk-forward] start: strategy=${opts.strategy} range=${opts.start}..${opts.end} ` +
          `scheme=${scheme} optimizer=${optimizerType} ` +
          `train=${trainMonths}m test=${testMonths}m ` +
          `purging=${purging ? `label_h=${purgeDays}/embargo=${embargoDays}` : 'OFF'} ` +
          (optimizerType === 'grid_search' ? `grid=${opts.grid}` : `bounds=${opts.bounds}`)
      );
      const t0 = Date.now();
      const out = await walkForwardValidator.validate(
        {
          strategy_key: opts.strategy,
          param_grid: paramGrid,
          param_bounds: paramBounds,
          base_config: {
            initial_capital: Number(opts.capital || 1_000_000),
            benchmark_symbol: opts.benchmark,
            universe: opts.universe as any,
            symbols,
          },
          train_months: trainMonths,
          test_months: testMonths,
          start_date: opts.start,
          end_date: opts.end,
          // Phase 1 新参数
          scheme: scheme as any,
          optimizer_type: optimizerType as any,
          purging,
          cpcv: scheme === 'cpcv' ? cpcvConfig : undefined,
        },
        {
          weights: Object.keys(weights).length ? weights : undefined,
          persist: opts.persist !== false,
          persist_train: opts.persistTrain !== false,
          train_concurrency: Number(opts.trainConcurrency || 1),
          max_combos: Number(opts.maxCombos || 256),
          user_id: opts.userId ? Number(opts.userId) : undefined,
        }
      );

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const s = out.summary;
      logger.info(
        `[walk-forward] done in ${elapsed}s: windows=${s.total_windows} completed=${
          s.completed_windows
        } failed=${s.failed_windows} run_id=${out.run?.id ?? 'in-memory'}`
      );
      logger.info(
        `[walk-forward] summary: mean_test_sharpe=${s.mean_test_sharpe?.toFixed(3) ?? 'NaN'} ` +
          `std=${s.std_test_sharpe?.toFixed(3) ?? 'NaN'} ` +
          `[min=${s.min_test_sharpe?.toFixed(3) ?? 'NaN'} max=${
            s.max_test_sharpe?.toFixed(3) ?? 'NaN'
          }] ` +
          `mean_test_return=${s.mean_test_return?.toFixed(3) ?? 'NaN'} ` +
          `mean_test_drawdown=${s.mean_test_drawdown?.toFixed(3) ?? 'NaN'} ` +
          `win_ratio=${s.win_ratio?.toFixed(3) ?? 'NaN'} decay=${
            s.out_of_sample_decay?.toFixed(3) ?? 'NaN'
          }`
      );
      // Phase 1: 单独一行展示过拟合诊断指标
      logger.info(
        `[walk-forward] overfit metrics: DSR=${s.dsr?.toFixed(3) ?? 'NaN'} ` +
          `PBO=${s.pbo?.toFixed(3) ?? 'NaN'} verdict=${s.verdict ?? 'INSUFFICIENT'} ` +
          `(total_test_days=${s.total_test_days ?? 0} num_trials=${s.num_trials ?? 0})`
      );
      if (s.verdict === 'PASS') {
        logger.info(`[walk-forward] ✅ verdict PASS — 策略通过过拟合检测，可推进 promotion`);
      } else if (s.verdict === 'FAIL') {
        logger.warn(`[walk-forward] ❌ verdict FAIL — 大概率过拟合，不建议 promote`);
      } else {
        logger.info(`[walk-forward] ⚠ verdict INSUFFICIENT — 样本不足，再多跑几轮`);
      }
      if (out.best_window) {
        logger.info(
          `[walk-forward] 🏆 best window #${out.best_window.window_index}: ` +
            `test_sharpe=${out.best_window.test_sharpe} test_return=${out.best_window.test_return} ` +
            `test_dd=${out.best_window.test_drawdown} ` +
            `train=${out.best_window.train_start_date}..${out.best_window.train_end_date} ` +
            `test=${out.best_window.test_start_date}..${out.best_window.test_end_date} ` +
            `params=${JSON.stringify(out.best_window.best_params_json)}`
        );
      } else {
        logger.warn('[walk-forward] 没有成功的窗口');
      }
      // 打印每个窗口的简要
      logger.info('[walk-forward] per-window:');
      for (const w of out.windows) {
        const params = JSON.stringify(w.best_params_json);
        if (w.status !== 'completed') {
          logger.info(
            `  #${w.window_index} status=${w.status} train=${w.train_start_date}..${
              w.train_end_date
            } err=${w.error_message?.slice(0, 60)}`
          );
        } else {
          logger.info(
            `  #${w.window_index} train_sh=${w.train_sharpe} test_sh=${w.test_sharpe} ` +
              `test_ret=${w.test_return} test_dd=${w.test_drawdown} params=${params}`
          );
        }
      }

      process.exit(out.summary.failed_windows > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`[walk-forward] FATAL: ${(error as Error).message}`);
      process.exit(2);
    }
  });

program.parseAsync(process.argv);
