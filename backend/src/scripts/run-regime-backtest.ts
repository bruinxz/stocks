#!/usr/bin/env node
/**
 * RegimeSegmentedBacktest CLI — US-040 分段市场环境回测报告
 *
 * Usage:
 *   # 对已完成的回测做分段（最常用模式）
 *   npm run run:regime-backtest -- --backtest-result-id=42
 *
 *   # 指定基准（默认 sh.000300）
 *   npm run run:regime-backtest -- --backtest-result-id=42 --benchmark=sh.000905
 *
 *   # dry-run 不写库（仅打印）
 *   npm run run:regime-backtest -- --backtest-result-id=42 --no-persist
 *
 *   # 查询历史：列出最近 30 个有 segments 的 run
 *   npm run run:regime-backtest -- --list
 *
 *   # 查看某 run 的全部 segments
 *   npm run run:regime-backtest -- --show=42
 *
 *   # 清理 N 天前的全部 segments
 *   npm run run:regime-backtest -- --cleanup-days=30
 *
 *   # 仅删除某 run 的 segments（保留父 QuantBacktestResult）
 *   npm run run:regime-backtest -- --delete-run=42
 *
 * 选项：
 *   --backtest-result-id=<n>  QuantBacktestResult.id（必填，除非 admin 模式）
 *   --benchmark=<symbol>      regime 检测基准（默认 sh.000300）
 *   --no-persist              不写库
 *   --no-replace              已有 run_id 段时不先 destroy（默认覆盖式重算）
 *   --list                    列出最近 30 个有 segments 的 run
 *   --show=<run_id>           展示指定 run 的全部 segments
 *   --delete-run=<run_id>     删除指定 run 的全部 segments
 *   --cleanup-days=<n>        删除 N 天前的所有 segments
 *
 * 退出码：
 *   0 = 成功
 *   2 = 严重错误（参数无效 / 找不到 backtest result / DB 失败）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { regimeSegmentedBacktest } from '../quant/backtest/RegimeSegmentedBacktest';

const program = new Command();

program
  .name('run-regime-backtest')
  .description('US-040 分段市场环境回测报告')
  .option(
    '--backtest-result-id <n>',
    '父 QuantBacktestResult.id（必填，除非 --list / --show / --delete-run / --cleanup-days）'
  )
  .option('--benchmark <symbol>', 'regime 检测基准（默认 sh.000300）', 'sh.000300')
  .option('--no-persist', '不写库（试跑模式）')
  .option('--no-replace', '已有 run_id 段时不先 destroy（默认 false = 覆盖式重算）')
  .option('--list', '列出最近 30 个有 segments 的 run')
  .option('--show <run_id>', '展示指定 run 的全部 segments')
  .option('--delete-run <run_id>', '删除指定 run 的全部 segments（保留父结果）')
  .option('--cleanup-days <n>', '删除 N 天前的所有 segments')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // ===== admin: --list =====
      if (opts.list) {
        const runs = await regimeSegmentedBacktest.listRecentRuns(30);
        if (!runs.length) {
          logger.info('[regime-backtest] 没有找到任何已分段的回测');
        } else {
          logger.info(`[regime-backtest] 最近 ${runs.length} 个已分段回测:`);
          for (const r of runs) {
            logger.info(
              `  run #${r.run_id} ${r.strategy_key} benchmark=${r.benchmark_symbol} ` +
                `segments=${r.segment_count} latest=${r.latest_created_at.toISOString()}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --show =====
      if (opts.show) {
        const runId = parseInt(opts.show, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[regime-backtest] --show 需要数字 id, 收到 '${opts.show}'`);
          process.exit(2);
        }
        const segs = await regimeSegmentedBacktest.getRunSegments(runId);
        if (!segs.length) {
          logger.info(`[regime-backtest] run #${runId} 没有 segments`);
          process.exit(0);
        }
        logger.info(`[regime-backtest] run #${runId} 全部 ${segs.length} 个 segments:`);
        for (const s of segs) {
          logger.info(
            `  #${s.segment_index} ${s.regime} ${s.start_date}..${s.end_date} ` +
              `days=${s.day_count} return=${s.return_pct}% ` +
              `sharpe=${s.sharpe ?? 'NaN'} dd=${s.drawdown_pct}% ` +
              `win_rate=${s.win_rate ?? 'NaN'} trades=${s.trade_count}`
          );
        }
        process.exit(0);
      }

      // ===== admin: --delete-run =====
      if (opts.deleteRun) {
        const runId = parseInt(opts.deleteRun, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[regime-backtest] --delete-run 需要数字 id, 收到 '${opts.deleteRun}'`);
          process.exit(2);
        }
        const result = await regimeSegmentedBacktest.deleteRun(runId);
        logger.info(`[regime-backtest] 删除 run #${runId}: ${result.deleted} segments`);
        process.exit(0);
      }

      // ===== admin: --cleanup-days =====
      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(`[regime-backtest] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`);
          process.exit(2);
        }
        const result = await regimeSegmentedBacktest.cleanupOlderThan(days);
        logger.info(`[regime-backtest] 清理 ${days} 天前: 删除 ${result.deleted} segments`);
        process.exit(0);
      }

      // ===== segment 主流程 =====
      if (!opts.backtestResultId) {
        logger.error('[regime-backtest] --backtest-result-id 必填');
        process.exit(2);
      }
      const resultId = parseInt(opts.backtestResultId, 10);
      if (!Number.isFinite(resultId) || resultId < 1) {
        logger.error(
          `[regime-backtest] --backtest-result-id 必须是 >= 1 的整数, 收到 '${opts.backtestResultId}'`
        );
        process.exit(2);
      }

      logger.info(
        `[regime-backtest] start: result_id=${resultId} benchmark=${opts.benchmark} persist=${
          opts.persist !== false
        }`
      );
      const t0 = Date.now();
      const out = await regimeSegmentedBacktest.segment(
        {
          quant_backtest_result_id: resultId,
          benchmark_symbol: opts.benchmark,
        },
        {
          persist: opts.persist !== false,
          replace_existing: opts.replace !== false,
        }
      );

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const s = out.summary;
      logger.info(
        `[regime-backtest] done in ${elapsed}s: segments=${s.total_segments} ` +
          `total_days=${s.total_days} range=${s.total_start_date}..${s.total_end_date} ` +
          `(${out.persisted_ids.length} rows persisted)`
      );
      logger.info(
        `[regime-backtest] segments_by_regime: bull=${s.segments_by_regime.bull} ` +
          `bear=${s.segments_by_regime.bear} range=${s.segments_by_regime.range} ` +
          `volatile=${s.segments_by_regime.volatile}`
      );
      logger.info(
        `[regime-backtest] avg_return_pct: ` +
          `bull=${s.avg_return_pct_by_regime.bull ?? 'NaN'} ` +
          `bear=${s.avg_return_pct_by_regime.bear ?? 'NaN'} ` +
          `range=${s.avg_return_pct_by_regime.range ?? 'NaN'} ` +
          `volatile=${s.avg_return_pct_by_regime.volatile ?? 'NaN'}`
      );
      logger.info(
        `[regime-backtest] avg_sharpe: ` +
          `bull=${s.avg_sharpe_by_regime.bull ?? 'NaN'} ` +
          `bear=${s.avg_sharpe_by_regime.bear ?? 'NaN'} ` +
          `range=${s.avg_sharpe_by_regime.range ?? 'NaN'} ` +
          `volatile=${s.avg_sharpe_by_regime.volatile ?? 'NaN'}`
      );
      // 打印每段
      logger.info('[regime-backtest] per-segment:');
      for (const seg of out.segments) {
        logger.info(
          `  #${seg.segment_index} ${seg.regime} ${seg.start_date}..${seg.end_date} ` +
            `days=${seg.day_count} ret=${seg.return_pct}% sharpe=${seg.sharpe ?? 'NaN'} ` +
            `dd=${seg.drawdown_pct}% win_rate=${seg.win_rate ?? 'NaN'} trades=${seg.trade_count}`
        );
      }
      process.exit(0);
    } catch (error) {
      logger.error(`[regime-backtest] FATAL: ${(error as Error).message}`);
      process.exit(2);
    }
  });

program.parse(process.argv);
