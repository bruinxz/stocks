#!/usr/bin/env node
/**
 * 限售解禁日历同步 CLI (US-089)
 *
 * Usage:
 *   npm run sync:restricted-share -- --upcoming=30
 *   npm run sync:restricted-share -- --start=2026-06-01 --end=2026-06-30
 *   npm run sync:restricted-share -- --upcoming=7 --force
 *
 * 选项：
 *   --start=<YYYY-MM-DD>    日期范围起始 (含)，与 --end 配对
 *   --end=<YYYY-MM-DD>      日期范围结束 (含)，与 --start 配对
 *   --upcoming=<N>          同步今日 + 未来 N 天 (默认 30)
 *   --force                 覆盖已有数据，禁用断点续传
 *
 * AKShare `stock_restricted_release_detail_em` 一次返回日期范围内全市场
 * 所有解禁批次，效率比 per-stock queue 端点高 ~5000 倍 (单次调用 vs
 * 单股逐次调用)，故 CLI 围绕日期范围设计。
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { RestrictedShareSyncService } from '../data/services/RestrictedShareSyncService';

const program = new Command();

program
  .name('sync-restricted-share')
  .description('限售解禁日历同步 (AKShare stock_restricted_release_detail_em)')
  .option('--start <date>', '日期范围起始 YYYY-MM-DD (含)')
  .option('--end <date>', '日期范围结束 YYYY-MM-DD (含)')
  .option('--upcoming <days>', '同步今日 + 未来 N 天 (默认 30)', '30')
  .option('--force', '覆盖已有数据，禁用断点续传', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式自动建表/alter；生产应改走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new RestrictedShareSyncService();

      let ranges: Array<{ start_date: string; end_date: string }>;

      if (opts.start && opts.end) {
        ranges = [{ start_date: opts.start, end_date: opts.end }];
      } else {
        const days = Number.parseInt(String(opts.upcoming || '30'), 10);
        if (!Number.isInteger(days) || days < 1) {
          logger.error(`Invalid --upcoming (expected positive integer): ${opts.upcoming}`);
          process.exit(1);
        }
        const today = new Date();
        const start = today.toISOString().slice(0, 10);
        const end = new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10);
        ranges = [{ start_date: start, end_date: end }];
      }

      const result = await service.syncDateRanges(ranges, { skipExisting: !opts.force });
      logger.info(
        `[sync-restricted-share] ranges=${result.total_ranges} ` +
          `succeeded=${result.succeeded} skipped=${result.skipped} failed=${result.failed}`
      );
      for (const d of result.details) {
        if (d.error) {
          logger.warn(`  - ${d.start_date}..${d.end_date}: ERROR ${d.error}`);
        } else if (d.skipped) {
          logger.info(`  - ${d.start_date}..${d.end_date}: skipped (existing)`);
        } else {
          logger.info(`  - ${d.start_date}..${d.end_date}: upserted ${d.upserted}`);
        }
      }
      process.exit(result.failed > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`sync-restricted-share failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
