#!/usr/bin/env node
/**
 * 行业资金流与板块强度每日同步 CLI
 *
 * Usage:
 *   npm run sync:industry-flow -- --date=2026-06-05
 *   npm run sync:industry-flow -- --start=2026-06-01 --end=2026-06-05
 *   npm run sync:industry-flow -- --start=2026-06-01 --end=2026-06-05 --force
 *
 * 选项：
 *   --date=<YYYY-MM-DD>     只同步单日（与 --start/--end 互斥）
 *   --start=<YYYY-MM-DD>    范围起点（含）
 *   --end=<YYYY-MM-DD>      范围终点（含）
 *   --force                 覆盖已有数据，禁用断点续传
 *
 * 提示：AKShare 的板块资金流接口是**实时快照**，不能拉历史。
 * 应当每日盘后调度 `--date=$(today)` 同步当日数据。
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { IndustrySyncService } from '../data/services/IndustrySyncService';

const program = new Command();

program
  .name('sync-industry-flow')
  .description(
    '行业资金流与板块强度入库 (AKShare stock_sector_fund_flow_rank + stock_board_industry_name_em + stock_board_industry_cons_em)'
  )
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

      const service = new IndustrySyncService();

      if (opts.date) {
        const result = await service.syncDate(opts.date);
        logger.info(
          `[sync-industry-flow] day=${result.trade_date} fetched=${result.fetched} upserted=${result.upserted} with_limit_ups=${result.industries_with_limit_ups} with_leader=${result.industries_with_leader}`
        );
        if (result.error) {
          logger.error(`[sync-industry-flow] error: ${result.error}`);
          process.exit(1);
        }
        process.exit(0);
      }

      if (opts.start && opts.end) {
        const result = await service.syncRange(opts.start, opts.end, {
          skipExisting: !opts.force,
        });
        logger.info(
          `[sync-industry-flow] range=${result.start}..${result.end} days=${result.total_days} succeeded=${result.succeeded} skipped=${result.skipped} failed=${result.failed}`
        );
        for (const d of result.details) {
          if (d.error) {
            logger.warn(`  - ${d.trade_date}: ERROR ${d.error}`);
          } else if (d.skipped) {
            logger.info(`  - ${d.trade_date}: skipped (existing)`);
          } else {
            logger.info(
              `  - ${d.trade_date}: upserted ${d.upserted} (with_limit_ups=${d.industries_with_limit_ups}, with_leader=${d.industries_with_leader})`
            );
          }
        }
        process.exit(result.failed > 0 ? 1 : 0);
      }

      logger.error('Must provide either --date or both --start and --end');
      program.help({ error: true });
    } catch (error) {
      logger.error(`sync-industry-flow failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
