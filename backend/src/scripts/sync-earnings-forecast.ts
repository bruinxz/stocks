#!/usr/bin/env node
/**
 * 业绩预告日度同步 CLI (US-013)
 *
 * Usage:
 *   npm run sync:earnings-forecast -- --report-period=2024-09-30
 *   npm run sync:earnings-forecast -- --report-period=2024-09-30,2024-12-31
 *   npm run sync:earnings-forecast -- --year=2024            # 当年 4 个季度
 *   npm run sync:earnings-forecast -- --year=2024 --force    # 覆盖已有数据
 *
 * 选项：
 *   --report-period=<YYYY-MM-DD[,YYYY-MM-DD,...]>  一个或多个报告期末日期
 *   --year=<YYYY>                                  指定年份的 4 个季度末
 *   --force                                        覆盖已有数据，禁用断点续传
 *
 * 注意：报告期必须是 4 个季度末之一（03-31 / 06-30 / 09-30 / 12-31）。
 * 其他日期 AKShare 返回空 dataframe，写一条警告但不算 error。
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { EarningsForecastSyncService } from '../data/services/EarningsForecastSyncService';

const program = new Command();

program
  .name('sync-earnings-forecast')
  .description('业绩预告同步 (AKShare stock_yjyg_em)')
  .option(
    '--report-period <periods>',
    '报告期末日期（YYYY-MM-DD，多个用逗号分隔）',
    (val: string) =>
      val
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
  )
  .option('--year <year>', '指定年份的 4 个季度末（与 --report-period 互斥）')
  .option('--force', '覆盖已有数据，禁用断点续传', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式自动建表/alter；生产应改走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new EarningsForecastSyncService();

      let periods: string[] | undefined;
      if (opts.reportPeriod && opts.reportPeriod.length) {
        periods = opts.reportPeriod as string[];
      } else if (opts.year) {
        const year = String(opts.year);
        if (!/^\d{4}$/.test(year)) {
          logger.error(`Invalid --year (expected YYYY): ${year}`);
          process.exit(1);
        }
        periods = [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`];
      }

      if (!periods || periods.length === 0) {
        logger.error('Must provide either --report-period or --year');
        program.help({ error: true });
        return;
      }

      const result = await service.syncReportPeriods(periods, { skipExisting: !opts.force });
      logger.info(
        `[sync-earnings-forecast] periods=${result.total_periods} ` +
          `succeeded=${result.succeeded} skipped=${result.skipped} failed=${result.failed}`
      );
      for (const d of result.details) {
        if (d.error) {
          logger.warn(`  - ${d.report_period}: ERROR ${d.error}`);
        } else if (d.skipped) {
          logger.info(`  - ${d.report_period}: skipped (existing)`);
        } else {
          logger.info(
            `  - ${d.report_period}: upserted ${d.upserted} (surprise=${d.surprise_count})`
          );
        }
      }
      process.exit(result.failed > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`sync-earnings-forecast failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
