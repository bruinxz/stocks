#!/usr/bin/env node
/**
 * 指数成份股同步 CLI (US-020)
 *
 * Usage:
 *   npm run sync:index-components -- --index=000852 --date=2026-06-05
 *   npm run sync:index-components -- --indexes=000300,000852,000905 --date=2026-06-05
 *   npm run sync:index-components -- --indexes=000852 --date=2026-06-05 --force
 *
 * 选项：
 *   --index=<code>           同步单个指数（与 --indexes 互斥）
 *   --indexes=<code,code,..> 同步多个指数（逗号分隔）
 *   --date=<YYYY-MM-DD>      stamp 日期（必填；AKShare 只返回当前成份，date 是标签）
 *   --force                  覆盖已有数据，禁用断点续传
 *
 * 常用指数：
 *   000016 上证 50 / 000300 沪深 300 / 000852 中证 1000 / 000905 中证 500
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { IndexComponentSyncService } from '../data/services/IndexComponentSyncService';

const program = new Command();

program
  .name('sync-index-components')
  .description('指数成份股入库 (AKShare index_stock_cons_sina)')
  .option('--index <code>', '单个指数代码 (6 位，如 000852)')
  .option('--indexes <codes>', '多个指数代码，逗号分隔 (如 000300,000852,000905)')
  .option('--date <date>', 'stamp 日期 (YYYY-MM-DD)')
  .option('--force', '覆盖已有数据，禁用断点续传', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      if (!opts.date) {
        logger.error('Must provide --date');
        program.help({ error: true });
        return;
      }

      const indexCodes: string[] = opts.indexes
        ? String(opts.indexes)
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : opts.index
        ? [String(opts.index).trim()]
        : [];

      if (indexCodes.length === 0) {
        logger.error('Must provide either --index or --indexes');
        program.help({ error: true });
        return;
      }

      // 简单 6 位数字校验，截断脏输入
      for (const code of indexCodes) {
        if (!/^\d{6}$/.test(code)) {
          logger.error(`Invalid index code: ${code} (must be 6 digits)`);
          process.exit(1);
        }
      }

      const service = new IndexComponentSyncService();
      const result = await service.syncIndexes(indexCodes, opts.date, {
        skipExisting: !opts.force,
      });
      logger.info(
        `[sync-index-components] date=${result.trade_date} indexes=${result.total_indexes} succeeded=${result.succeeded} skipped=${result.skipped} failed=${result.failed}`
      );
      for (const d of result.details) {
        if (d.error) {
          logger.warn(`  - ${d.index_code}: ERROR ${d.error}`);
        } else if (d.skipped) {
          logger.info(`  - ${d.index_code}: skipped (existing)`);
        } else {
          logger.info(`  - ${d.index_code}: upserted ${d.upserted}`);
        }
      }
      process.exit(result.failed > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`sync-index-components failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
