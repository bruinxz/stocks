#!/usr/bin/env node
/**
 * 北向资金日度持股同步 CLI
 *
 * Usage:
 *   npm run sync:northbound -- --date=2026-06-05
 *   npm run sync:northbound -- --start=2026-06-01 --end=2026-06-05
 *   npm run sync:northbound -- --start=2026-06-01 --end=2026-06-05 --force
 *
 * 选项：
 *   --date=<YYYY-MM-DD>      只同步单日（与 --start/--end 互斥）
 *   --start=<YYYY-MM-DD>     范围起点（含）
 *   --end=<YYYY-MM-DD>       范围终点（含）
 *   --force                  覆盖已有数据，禁用断点续传
 *   --market=<北向|沪股通|深股通>  AKShare 通道，默认 "北向"
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { NorthboundSyncService } from '../data/services/NorthboundSyncService';

const program = new Command();

program
  .name('sync-northbound')
  .description('北向资金日度持股入库 (AKShare stock_hsgt_hold_stock_em)')
  .option('--date <date>', '同步单日 (YYYY-MM-DD)')
  .option('--start <start>', '范围起点 (YYYY-MM-DD, 含)')
  .option('--end <end>', '范围终点 (YYYY-MM-DD, 含)')
  .option('--force', '覆盖已有数据，禁用断点续传', false)
  .option('--market <market>', '通道 (北向|沪股通|深股通)', '北向')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式自动建表/alter；生产应改走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new NorthboundSyncService();
      const market = opts.market as '北向' | '沪股通' | '深股通';

      if (opts.date) {
        const result = await service.syncDate(opts.date, { market });
        logger.info(
          `[sync-northbound] day=${result.trade_date} fetched=${result.fetched} upserted=${result.upserted}`
        );
        if (result.error) {
          logger.error(`[sync-northbound] error: ${result.error}`);
          process.exit(1);
        }
        process.exit(0);
      }

      if (opts.start && opts.end) {
        const result = await service.syncRange(opts.start, opts.end, {
          skipExisting: !opts.force,
          market,
        });
        logger.info(
          `[sync-northbound] range=${result.start}..${result.end} days=${result.total_days} succeeded=${result.succeeded} skipped=${result.skipped} failed=${result.failed}`
        );
        // 详情打印有助于在 ops 日志里复盘哪一天失败
        for (const d of result.details) {
          if (d.error) {
            logger.warn(`  - ${d.trade_date}: ERROR ${d.error}`);
          } else if (d.skipped) {
            logger.info(`  - ${d.trade_date}: skipped (existing)`);
          } else {
            logger.info(`  - ${d.trade_date}: upserted ${d.upserted}`);
          }
        }
        process.exit(result.failed > 0 ? 1 : 0);
      }

      logger.error('Must provide either --date or both --start and --end');
      program.help({ error: true });
    } catch (error) {
      logger.error(`sync-northbound failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
