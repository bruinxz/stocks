#!/usr/bin/env node
/**
 * 个股情绪同步 CLI (US-034)
 *
 * Usage:
 *   npm run sync:stock-sentiment -- --stock=600519
 *   npm run sync:stock-sentiment -- --stocks=600519,000001,000002
 *   npm run sync:stock-sentiment -- --all                          # 全 A 股（慢）
 *   npm run sync:stock-sentiment -- --all --force                  # 覆盖已有
 *   npm run sync:stock-sentiment -- --listed-before=2024-06-01     # 跳过新股
 *
 * 选项：
 *   --stock=<6-digit>           单只股票
 *   --stocks=<csv>              多只股票
 *   --all                       全 A 股（仅 is_listed=true 的 stocks 行）
 *   --listed-before=<YYYY-MM-DD>  与 --all 配合，限定上市日早于该日。
 *                               EastMoneyQAFactor 因子需要 ≥ 30 日历史数据，
 *                               新股拉了用不上 → 建议过滤 IPO 不足 60 日的股票。
 *   --interval-ms=<n>           每只股票之间 sleep ms（默认 200）
 *   --force                     覆盖已有数据，禁用断点续传
 *
 * 数据特性：
 *   - 按股票同步而非按交易日（每只股票约 365 行历史人气快照）
 *   - skip-existing 检查点：已有任意一条 stock_sentiment 的股票跳过整批
 *   - 全量重拉是 idempotent 的（复合 PK + updateOnDuplicate）
 *   - Python helper 已在源端 dedup 同股同日重复行（seen_dates: set）
 *
 * 配套环境变量：
 *   EAST_MONEY_QA_TIMEOUT_MS         默认 90000 (90s)
 *   STOCK_SENTIMENT_SKIP_EXISTING    =0 等价于 --force
 */

import { Command } from 'commander';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import '../models';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';
import { StockSentimentSyncService } from '../data/services/StockSentimentSyncService';

const program = new Command();

program
  .name('sync-stock-sentiment')
  .description('个股情绪 / 散户人气同步 (AKShare stock_hot_rank_detail_em)')
  .option('--stock <code>', '单只股票 6 位代码')
  .option('--stocks <codes>', '多只股票，逗号分隔', (val: string) =>
    val
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )
  .option('--all', '全 A 股（仅 stocks 表中 is_listed=true 的）', false)
  .option('--listed-before <date>', '与 --all 配合，过滤上市日早于该日（YYYY-MM-DD）')
  .option('--interval-ms <n>', '每只股票之间 sleep ms', (v: string) => parseInt(v, 10), 200)
  .option('--force', '覆盖已有数据，禁用断点续传', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式自动建表/alter；生产应改走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new StockSentimentSyncService();

      // === 解析股票列表 ===
      let stockCodes: string[] = [];
      if (opts.stock) {
        stockCodes = [String(opts.stock).trim()];
      } else if (opts.stocks && (opts.stocks as string[]).length) {
        stockCodes = opts.stocks as string[];
      } else if (opts.all) {
        const where: Record<string, unknown> = { is_listed: true };
        if (opts.listedBefore) {
          where.listing_date = { [Op.lt]: opts.listedBefore };
        }
        const rows = (await Stock.findAll({
          attributes: ['symbol'],
          where,
          raw: true,
        })) as unknown as Array<{ symbol: string }>;
        stockCodes = rows.map(r => stripSuffix(r.symbol)).filter(code => /^\d{6}$/.test(code));
        logger.info(`[sync-stock-sentiment] resolved ${stockCodes.length} stocks from DB`);
      } else {
        logger.error('Must provide --stock, --stocks, or --all');
        program.help({ error: true });
        return;
      }

      if (stockCodes.length === 0) {
        logger.warn('[sync-stock-sentiment] no stocks to sync after filtering');
        process.exit(0);
      }

      logger.info(
        `[sync-stock-sentiment] starting sync for ${stockCodes.length} stock(s) ` +
          `(interval=${opts.intervalMs}ms, force=${opts.force ? 'YES' : 'NO'})`
      );

      const result = await service.syncStocks(stockCodes, {
        skipExisting: !opts.force,
        intervalMs: opts.intervalMs,
      });

      logger.info(
        `[sync-stock-sentiment] stocks=${result.total_stocks} ` +
          `succeeded=${result.succeeded} skipped=${result.skipped} failed=${result.failed}`
      );

      // print a compact per-stock summary for ≤ 50 stocks; otherwise just totals
      if (result.details.length <= 50) {
        for (const d of result.details) {
          if (d.error) {
            logger.warn(`  - ${d.stock_code}: ERROR ${d.error}`);
          } else if (d.skipped) {
            logger.info(`  - ${d.stock_code}: skipped (existing)`);
          } else {
            logger.info(`  - ${d.stock_code}: upserted ${d.upserted}`);
          }
        }
      } else {
        // failures only for large batches
        for (const d of result.details) {
          if (d.error) logger.warn(`  - ${d.stock_code}: ERROR ${d.error}`);
        }
      }

      process.exit(result.failed > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`sync-stock-sentiment failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const i = symbol.indexOf('.');
  return i < 0 ? symbol : symbol.slice(0, i);
}

program.parseAsync(process.argv);
