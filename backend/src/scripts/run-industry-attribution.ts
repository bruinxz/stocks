#!/usr/bin/env node
/**
 * IndustryAttributionService CLI — US-046 分行业归因分析
 *
 * Usage:
 *   # 对已完成的回测做行业归因（按 Stock.industry 分组）
 *   npm run run:industry-attribution -- --backtest-result-id=42
 *
 *   # dry-run 不写库（仅打印分布）
 *   npm run run:industry-attribution -- --backtest-result-id=42 --no-persist
 *
 *   # 查询历史：列出最近 30 个归因结果（按 created_at 倒序）
 *   npm run run:industry-attribution -- --list
 *
 *   # 查看某 run_id 的全部行业归因结果
 *   npm run run:industry-attribution -- --show=42
 *
 *   # 删除某 run_id 的全部行业归因
 *   npm run run:industry-attribution -- --delete-run=42
 *
 *   # 清理 N 天前的全部行业归因结果
 *   npm run run:industry-attribution -- --cleanup-days=30
 *
 * 退出码：
 *   0 = 成功
 *   2 = 严重错误（参数无效 / 找不到 backtest result / DB 失败）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { industryAttributionService } from '../quant/performance/IndustryAttributionService';

const program = new Command();

program
  .name('run-industry-attribution')
  .description(
    'US-046 行业归因 — 按 Stock.industry 拆解策略 contribution / win_rate / avg_hold_days'
  )
  .option(
    '--backtest-result-id <n>',
    '父 QuantBacktestResult.id（必填，除非 --list / --show / --delete-run / --cleanup-days）'
  )
  .option('--no-persist', '不写库（试跑模式）')
  .option('--list', '列出最近 30 个归因结果（按 created_at 倒序）')
  .option('--show <run_id>', '展示指定 run_id 的全部行业归因结果')
  .option('--delete-run <run_id>', '删除指定 run_id 的全部行业归因')
  .option('--cleanup-days <n>', '删除 N 天前的所有行业归因结果')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // ===== admin: --list =====
      if (opts.list) {
        const rows = await industryAttributionService.listRecentRuns(30);
        if (!rows.length) {
          logger.info('[industry-attribution] 没有找到任何归因结果');
        } else {
          logger.info(`[industry-attribution] 最近 ${rows.length} 个归因结果:`);
          for (const r of rows) {
            logger.info(
              `  id=${r.id} run_id=${r.run_id} ${r.strategy_key} ${r.industry_name} ` +
                `period=${r.period_start}..${r.period_end} contribution=${
                  r.contribution_pct
                }% trades=${r.trade_count} win_rate=${
                  r.win_rate === null || r.win_rate === undefined
                    ? 'N/A'
                    : (Number(r.win_rate) * 100).toFixed(2) + '%'
                }`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --show =====
      if (opts.show) {
        const runId = parseInt(opts.show, 10);
        if (!Number.isFinite(runId)) {
          logger.error(`[industry-attribution] --show 需要数字 run_id, 收到 '${opts.show}'`);
          process.exit(2);
        }
        const rows = await industryAttributionService.getResultsForRun(runId);
        if (!rows.length) {
          logger.info(`[industry-attribution] run_id #${runId} 没有归因结果`);
          process.exit(0);
        }
        logger.info(`[industry-attribution] run_id #${runId} 全部 ${rows.length} 个行业:`);
        let totalContribution = 0;
        for (const r of rows) {
          totalContribution += Number(r.contribution_pct);
          logger.info(
            `  ${r.industry_name}: contribution=${r.contribution_pct}% pnl=${r.total_pnl} ` +
              `trades=${r.trade_count} (W ${r.winning_count} / L ${r.losing_count}) ` +
              `win_rate=${
                r.win_rate === null || r.win_rate === undefined
                  ? 'N/A'
                  : (Number(r.win_rate) * 100).toFixed(2) + '%'
              } avg_hold=${r.avg_hold_days ?? 'N/A'}天`
          );
        }
        logger.info(`  ─────`);
        logger.info(
          `  TOTAL contribution = ${totalContribution.toFixed(4)}% (近似 = 策略总收益率)`
        );
        process.exit(0);
      }

      // ===== admin: --delete-run =====
      if (opts.deleteRun) {
        const runId = parseInt(opts.deleteRun, 10);
        if (!Number.isFinite(runId)) {
          logger.error(
            `[industry-attribution] --delete-run 需要数字 run_id, 收到 '${opts.deleteRun}'`
          );
          process.exit(2);
        }
        const result = await industryAttributionService.deleteRunByRunId(runId);
        logger.info(`[industry-attribution] 删除 run_id #${runId}: ${result.deleted} 行行业归因`);
        process.exit(0);
      }

      // ===== admin: --cleanup-days =====
      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(
            `[industry-attribution] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`
          );
          process.exit(2);
        }
        const result = await industryAttributionService.cleanupOlderThan(days);
        logger.info(`[industry-attribution] 清理 ${days} 天前: 删除 ${result.deleted} 行行业归因`);
        process.exit(0);
      }

      // ===== 主流程：跑归因 =====
      if (!opts.backtestResultId) {
        logger.error('[industry-attribution] --backtest-result-id 必填');
        process.exit(2);
      }
      const resultId = parseInt(opts.backtestResultId, 10);
      if (!Number.isFinite(resultId) || resultId < 1) {
        logger.error(
          `[industry-attribution] --backtest-result-id 必须是 >= 1 的整数, 收到 '${opts.backtestResultId}'`
        );
        process.exit(2);
      }

      logger.info(
        `[industry-attribution] start: run_id=${resultId} persist=${opts.persist !== false}`
      );

      const out = await industryAttributionService.computeAttribution(
        { quant_backtest_result_id: resultId },
        { persist: opts.persist !== false, source: 'cli' }
      );

      logger.info(
        `[industry-attribution] done: run_id=${out.run_id} strategy=${out.strategy_key} ` +
          `industries=${out.attributions.length} total_contribution=${out.total_contribution_pct}% ` +
          `duration=${(out.duration_ms / 1000).toFixed(2)}s`
      );

      if (out.attributions.length === 0) {
        logger.warn(
          '[industry-attribution] 无任何已完成 trade — 可能：回测期内无成交，或全部 trade 未平仓'
        );
        process.exit(0);
      }

      logger.info('[industry-attribution] === 行业贡献明细（按 |contribution| 降序） ===');
      for (const a of out.attributions) {
        const arrow = a.contribution_pct > 0 ? '↑' : a.contribution_pct < 0 ? '↓' : '·';
        logger.info(
          `  ${arrow} ${a.industry_name}: contribution=${a.contribution_pct}%  pnl=${a.total_pnl}\n` +
            `      trades=${a.trade_count} (W ${a.winning_count} / L ${a.losing_count}) ` +
            `win_rate=${
              a.win_rate === null ? 'N/A' : (a.win_rate * 100).toFixed(2) + '%'
            } avg_hold=${a.avg_hold_days ?? 'N/A'}天 volume=${a.total_volume}`
        );
      }
      process.exit(0);
    } catch (error) {
      logger.error(`[industry-attribution] FATAL: ${(error as Error).message}`);
      process.exit(2);
    }
  });

program.parse(process.argv);
