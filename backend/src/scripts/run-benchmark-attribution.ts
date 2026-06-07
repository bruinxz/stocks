#!/usr/bin/env node
/**
 * BenchmarkAttributionService CLI — US-045 基准比较与超额收益拆解
 *
 * Usage:
 *   # 对已完成的回测做基准归因（默认 HS300 + CSI500 + CSI1000）
 *   npm run run:benchmark-attribution -- --backtest-result-id=42
 *
 *   # 自定义基准列表（,分隔；其他基准代码：sh.000001 上证 / sz.399006 创业板 / sh.000688 科创50）
 *   npm run run:benchmark-attribution -- --backtest-result-id=42 --benchmarks=sh.000300,sz.399006
 *
 *   # dry-run 不写库（仅打印分布）
 *   npm run run:benchmark-attribution -- --backtest-result-id=42 --no-persist
 *
 *   # 查询历史：列出最近 30 个归因结果（按 created_at 倒序）
 *   npm run run:benchmark-attribution -- --list
 *
 *   # 查看某 run_id 的全部基准归因结果
 *   npm run run:benchmark-attribution -- --show=42
 *
 *   # 删除某 run_id 的全部基准归因
 *   npm run run:benchmark-attribution -- --delete-run=42
 *
 *   # 清理 N 天前的全部基准归因结果
 *   npm run run:benchmark-attribution -- --cleanup-days=30
 *
 * 退出码：
 *   0 = 成功
 *   2 = 严重错误（参数无效 / 找不到 backtest result / DB 失败）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import {
  benchmarkAttributionService,
  DEFAULT_BENCHMARK_SYMBOLS,
} from '../quant/performance/BenchmarkAttributionService';

const program = new Command();

program
  .name('run-benchmark-attribution')
  .description('US-045 基准归因 — 对回测做 CAPM alpha/beta + 超额收益 + 信息比率拆解')
  .option(
    '--backtest-result-id <n>',
    '父 QuantBacktestResult.id（必填，除非 --list / --show / --delete-run / --cleanup-days）'
  )
  .option(
    '--benchmarks <csv>',
    `自定义基准列表（,分隔；默认 ${DEFAULT_BENCHMARK_SYMBOLS.join(',')} = HS300/CSI500/CSI1000）`
  )
  .option('--no-persist', '不写库（试跑模式）')
  .option('--list', '列出最近 30 个归因结果（按 created_at 倒序）')
  .option('--show <run_id>', '展示指定 run_id 的全部基准归因结果')
  .option('--delete-run <run_id>', '删除指定 run_id 的全部基准归因')
  .option('--cleanup-days <n>', '删除 N 天前的所有基准归因结果')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // ===== admin: --list =====
      if (opts.list) {
        const rows = await benchmarkAttributionService.listRecentRuns(30);
        if (!rows.length) {
          logger.info('[benchmark-attribution] 没有找到任何归因结果');
        } else {
          logger.info(`[benchmark-attribution] 最近 ${rows.length} 个归因结果:`);
          for (const r of rows) {
            logger.info(
              `  id=${r.id} run_id=${r.run_id} ${r.strategy_key} ${r.benchmark_symbol} ` +
                `period=${r.period_start}..${r.period_end} alpha=${
                  r.alpha_annual_pct ?? 'NaN'
                }% beta=${r.beta ?? 'NaN'} IR=${r.information_ratio ?? 'NaN'}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --show =====
      if (opts.show) {
        const runId = parseInt(opts.show, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[benchmark-attribution] --show 需要数字 run_id, 收到 '${opts.show}'`);
          process.exit(2);
        }
        const rows = await benchmarkAttributionService.getResultsForRun(runId);
        if (!rows.length) {
          logger.info(`[benchmark-attribution] run_id #${runId} 没有归因结果`);
          process.exit(0);
        }
        logger.info(`[benchmark-attribution] run_id #${runId} 全部 ${rows.length} 个基准:`);
        for (const r of rows) {
          logger.info(
            `  ${r.benchmark_symbol} (${r.benchmark_name ?? 'N/A'}): ` +
              `alpha_annual=${r.alpha_annual_pct ?? 'NaN'}% beta=${r.beta ?? 'NaN'} ` +
              `IR=${r.information_ratio ?? 'NaN'} excess_return=${
                r.excess_return_pct ?? 'NaN'
              }% excess_dd=${r.excess_drawdown_pct ?? 'NaN'}% r²=${r.r_squared ?? 'NaN'} ` +
              `samples=${r.sample_count}`
          );
        }
        process.exit(0);
      }

      // ===== admin: --delete-run =====
      if (opts.deleteRun) {
        const runId = parseInt(opts.deleteRun, 10);
        if (!Number.isFinite(runId)) {
          logger.error(
            `[benchmark-attribution] --delete-run 需要数字 run_id, 收到 '${opts.deleteRun}'`
          );
          process.exit(2);
        }
        const result = await benchmarkAttributionService.deleteRunByRunId(runId);
        logger.info(`[benchmark-attribution] 删除 run_id #${runId}: ${result.deleted} 行基准归因`);
        process.exit(0);
      }

      // ===== admin: --cleanup-days =====
      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(
            `[benchmark-attribution] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`
          );
          process.exit(2);
        }
        const result = await benchmarkAttributionService.cleanupOlderThan(days);
        logger.info(`[benchmark-attribution] 清理 ${days} 天前: 删除 ${result.deleted} 行基准归因`);
        process.exit(0);
      }

      // ===== 主流程：跑归因 =====
      if (!opts.backtestResultId) {
        logger.error('[benchmark-attribution] --backtest-result-id 必填');
        process.exit(2);
      }
      const resultId = parseInt(opts.backtestResultId, 10);
      if (!Number.isFinite(resultId) || resultId < 1) {
        logger.error(
          `[benchmark-attribution] --backtest-result-id 必须是 >= 1 的整数, 收到 '${opts.backtestResultId}'`
        );
        process.exit(2);
      }

      const benchmarks = opts.benchmarks
        ? String(opts.benchmarks)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : undefined;

      logger.info(
        `[benchmark-attribution] start: run_id=${resultId} benchmarks=${(
          benchmarks || DEFAULT_BENCHMARK_SYMBOLS
        ).join(',')} persist=${opts.persist !== false}`
      );

      const out = await benchmarkAttributionService.computeAttribution(
        {
          quant_backtest_result_id: resultId,
          benchmark_symbols: benchmarks,
        },
        { persist: opts.persist !== false, source: 'cli' }
      );

      logger.info(
        `[benchmark-attribution] done: run_id=${out.run_id} strategy=${out.strategy_key} ` +
          `attributions=${out.attributions.length} duration=${(out.duration_ms / 1000).toFixed(2)}s`
      );

      for (const a of out.attributions) {
        logger.info(
          `[benchmark-attribution] === ${a.benchmark_symbol} (${a.benchmark_name ?? 'N/A'}) ===`
        );
        if (a.error) {
          logger.warn(`  错误: ${a.error}`);
        }
        logger.info(
          `  alpha_annual = ${a.alpha_annual_pct ?? 'NaN'}%  (年化 alpha；正值=跑赢基准)\n` +
            `  beta         = ${a.beta ?? 'NaN'}  (1=同步 / >1=放大 / <1=防御性)\n` +
            `  information_ratio = ${a.information_ratio ?? 'NaN'}  (IR>0.5 值得继续 / >1 优秀)\n` +
            `  excess_return = ${a.excess_return_pct ?? 'NaN'}%  (策略累计 - 基准累计)\n` +
            `  excess_drawdown = ${a.excess_drawdown_pct ?? 'NaN'}%  (相对基准的最大相对回撤)\n` +
            `  r_squared = ${a.r_squared ?? 'NaN'}  (接近 1 = 策略基本就是基准 + alpha)\n` +
            `  samples = ${a.sample_count}  (对齐后日收益数)\n` +
            `  strategy_return = ${a.strategy_return_pct ?? 'NaN'}%  (策略整段累计)\n` +
            `  benchmark_return = ${a.benchmark_return_pct ?? 'NaN'}%  (基准整段累计)\n` +
            `  period = ${a.period_start ?? 'N/A'} .. ${a.period_end ?? 'N/A'}`
        );
      }
      process.exit(0);
    } catch (error) {
      logger.error(`[benchmark-attribution] FATAL: ${(error as Error).message}`);
      process.exit(2);
    }
  });

program.parse(process.argv);
