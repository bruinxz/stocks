#!/usr/bin/env node
/**
 * 融资融券明细同步 CLI (US-091)
 *
 * Usage:
 *   npm run sync:margin-trading -- --date=2026-06-05
 *   npm run sync:margin-trading -- --start=2026-06-01 --end=2026-06-05
 *   npm run sync:margin-trading -- --start=2026-06-01 --end=2026-06-05 --force
 *
 * 选项:
 *   --date=<YYYY-MM-DD>      同步单日 (与 --start/--end 互斥)
 *   --start=<YYYY-MM-DD>     范围起点 (含)
 *   --end=<YYYY-MM-DD>       范围终点 (含)
 *   --force                  覆盖已有数据, 禁用断点续传
 *
 * AKShare `stock_margin_detail_szse(date)` + `stock_margin_detail_sse(date)`:
 * 按日检索, 单日返回 ~4000 行 (两交易所合计). Python helper 内合并到统一 schema.
 *
 * 调度建议: 每日盘后 17:30 跑前一交易日 (T+1 数据可用). 同款 daily sync 模式
 * 见 US-005 NorthboundHolding / US-007 LimitUpStock.
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { MarginTradingSyncService } from '../data/services/MarginTradingSyncService';

const program = new Command();

program
  .name('sync-margin-trading')
  .description('融资融券明细同步 (AKShare stock_margin_detail_szse / sse, 合并到 per-stock 表)')
  .option('--date <date>', '同步单日 (YYYY-MM-DD)')
  .option('--start <start>', '范围起点 (YYYY-MM-DD, 含)')
  .option('--end <end>', '范围终点 (YYYY-MM-DD, 含)')
  .option('--force', '覆盖已有数据, 禁用断点续传', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式自动建表/alter; 生产应改走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new MarginTradingSyncService();

      if (opts.date) {
        const result = await service.syncDate(opts.date);
        logger.info(
          `[sync-margin-trading] day=${result.trade_date} fetched=${result.fetched} ` +
            `upserted=${result.upserted} (SZSE=${result.by_exchange.SZSE} ` +
            `SSE=${result.by_exchange.SSE} szse_repay_imputed=${result.szse_repay_imputed})`
        );
        if (result.error) {
          logger.error(`[sync-margin-trading] error: ${result.error}`);
          process.exit(1);
        }
        process.exit(0);
      }

      if (opts.start && opts.end) {
        const result = await service.syncRange(opts.start, opts.end, {
          skipExisting: !opts.force,
        });
        logger.info(
          `[sync-margin-trading] range=${result.start}..${result.end} days=${result.total_days} ` +
            `succeeded=${result.succeeded} skipped=${result.skipped} failed=${result.failed}`
        );
        for (const d of result.details) {
          if (d.error) {
            logger.warn(`  - ${d.trade_date}: ERROR ${d.error}`);
          } else if (d.skipped) {
            logger.info(`  - ${d.trade_date}: skipped (existing)`);
          } else {
            logger.info(
              `  - ${d.trade_date}: upserted ${d.upserted} ` +
                `(SZSE=${d.by_exchange.SZSE} SSE=${d.by_exchange.SSE} ` +
                `szse_repay_imputed=${d.szse_repay_imputed})`
            );
          }
        }
        process.exit(result.failed > 0 ? 1 : 0);
      }

      logger.error('Must provide either --date or both --start and --end');
      program.help({ error: true });
    } catch (error) {
      logger.error(`sync-margin-trading failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
