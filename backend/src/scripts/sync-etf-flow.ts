#!/usr/bin/env node
/**
 * 行业 ETF 资金流同步 CLI (US-092)
 *
 * Usage:
 *   npm run sync:etf-flow -- --date=2026-06-05
 *   npm run sync:etf-flow -- --start=2026-06-01 --end=2026-06-05
 *   npm run sync:etf-flow -- --start=2026-06-01 --end=2026-06-05 --force
 *
 * 选项:
 *   --date=<YYYY-MM-DD>      同步单日 (与 --start/--end 互斥)
 *   --start=<YYYY-MM-DD>     范围起点 (含)
 *   --end=<YYYY-MM-DD>       范围终点 (含)
 *   --force                  覆盖已有数据, 禁用断点续传
 *
 * 数据源:
 *   - `fund_etf_fund_daily_em()`  全市场 ETF 日度净值 + 基金份额 (一次性)
 *   - `fund_etf_hist_em(symbol)`  per-ETF 历史日行情 (close + 成交额)
 *
 * 入库范围: 仅 `constants/etfIndustry.ts` 内的 30+ 主流行业 ETF;
 *   net_inflow 由 TS 服务层 day-to-day diff 推算 = (share_count[T] -
 *   share_count[T-1]) × nav[T] (与 US-091 同款 identity 反推模式).
 *
 * 调度建议: 每日盘后 17:30 跑前一交易日 (T+1 数据可用).
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { ETFFlowSyncService } from '../data/services/ETFFlowSyncService';

const program = new Command();

program
  .name('sync-etf-flow')
  .description(
    '行业 ETF 资金流入流出同步 (AKShare fund_etf_fund_daily_em + fund_etf_hist_em, 白名单 30+ ETF)'
  )
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

      const service = new ETFFlowSyncService();

      if (opts.date) {
        const result = await service.syncDate(opts.date);
        logger.info(
          `[sync-etf-flow] day=${result.trade_date} fetched=${result.fetched} ` +
            `upserted=${result.upserted} (net_inflow_imputed=${result.net_inflow_imputed} ` +
            `filtered_out=${result.filtered_out})`
        );
        if (result.error) {
          logger.error(`[sync-etf-flow] error: ${result.error}`);
          process.exit(1);
        }
        process.exit(0);
      }

      if (opts.start && opts.end) {
        const result = await service.syncRange(opts.start, opts.end, {
          skipExisting: !opts.force,
        });
        logger.info(
          `[sync-etf-flow] range=${result.start}..${result.end} days=${result.total_days} ` +
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
                `(net_inflow_imputed=${d.net_inflow_imputed} filtered_out=${d.filtered_out})`
            );
          }
        }
        process.exit(result.failed > 0 ? 1 : 0);
      }

      logger.error('Must provide either --date or both --start and --end');
      program.help({ error: true });
    } catch (error) {
      logger.error(`sync-etf-flow failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
