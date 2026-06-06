#!/usr/bin/env node
/**
 * 龙虎榜每日营业部明细同步 CLI
 *
 * Usage:
 *   npm run sync:dragon-tiger -- --date=2026-06-05
 *   npm run sync:dragon-tiger -- --start=2026-06-01 --end=2026-06-05
 *   npm run sync:dragon-tiger -- --start=2026-06-01 --end=2026-06-05 --force
 *
 * 选项：
 *   --date=<YYYY-MM-DD>     只同步单日（与 --start/--end 互斥）
 *   --start=<YYYY-MM-DD>    范围起点（含）
 *   --end=<YYYY-MM-DD>      范围终点（含）
 *   --force                 覆盖已有数据，禁用断点续传
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { DragonTigerSyncService } from '../data/services/DragonTigerSyncService';

const program = new Command();

program
  .name('sync-dragon-tiger')
  .description('龙虎榜每日营业部明细入库 (AKShare stock_lhb_detail_em + stock_lhb_stock_detail_em)')
  .option('--date <date>', '同步单日 (YYYY-MM-DD)')
  .option('--start <start>', '范围起点 (YYYY-MM-DD, 含)')
  .option('--end <end>', '范围终点 (YYYY-MM-DD, 含)')
  .option('--force', '覆盖已有数据，禁用断点续传', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式自动建表/alter；生产应改走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new DragonTigerSyncService();

      if (opts.date) {
        const result = await service.syncDate(opts.date);
        logger.info(
          `[sync-dragon-tiger] day=${result.trade_date} fetched=${result.fetched} upserted=${result.upserted} famous_hits=${result.famous_hits}`
        );
        if (result.error) {
          logger.error(`[sync-dragon-tiger] error: ${result.error}`);
          process.exit(1);
        }
        process.exit(0);
      }

      if (opts.start && opts.end) {
        const result = await service.syncRange(opts.start, opts.end, {
          skipExisting: !opts.force,
        });
        logger.info(
          `[sync-dragon-tiger] range=${result.start}..${result.end} days=${result.total_days} succeeded=${result.succeeded} skipped=${result.skipped} failed=${result.failed}`
        );
        for (const d of result.details) {
          if (d.error) {
            logger.warn(`  - ${d.trade_date}: ERROR ${d.error}`);
          } else if (d.skipped) {
            logger.info(`  - ${d.trade_date}: skipped (existing)`);
          } else {
            logger.info(`  - ${d.trade_date}: upserted ${d.upserted} (famous_yz=${d.famous_hits})`);
          }
        }
        process.exit(result.failed > 0 ? 1 : 0);
      }

      logger.error('Must provide either --date or both --start and --end');
      program.help({ error: true });
    } catch (error) {
      logger.error(`sync-dragon-tiger failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
