#!/usr/bin/env node
/**
 * 分红派息历史同步 CLI (US-022)
 *
 * Usage:
 *   npm run sync:dividend-history -- --stock=600519
 *   npm run sync:dividend-history -- --stocks=600519,000001,000002
 *   npm run sync:dividend-history -- --all                          # 全 A 股（慢）
 *   npm run sync:dividend-history -- --all --force                  # 覆盖已有
 *   npm run sync:dividend-history -- --listed-before=2023-01-01     # 只同步 2023 年前上市的
 *
 * 选项：
 *   --stock=<6-digit>          单只股票
 *   --stocks=<csv>             多只股票
 *   --all                      全 A 股（仅 is_listed=true 的 stocks 行）
 *   --listed-before=<YYYY-MM-DD>  与 --all 配合，限定上市日早于该日（过滤新股）
 *   --interval-ms=<n>          每只股票之间 sleep ms（默认 200，AKShare 限流友好）
 *   --force                    覆盖已有数据，禁用断点续传
 *
 * 数据特性：
 *   - 按股票同步而非按交易日（每只股票通常 10-30 条历史记录）
 *   - 派息率 (yield_pct) 在 TS 服务里计算（需 DailyBar），缺数据时 NULL
 *   - skip-existing 检查点：已有任意一条 dividend_history 的股票跳过整批
 */

import { Command } from 'commander';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import '../models';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';
import { DividendHistorySyncService } from '../data/services/DividendHistorySyncService';

const program = new Command();

program
  .name('sync-dividend-history')
  .description('分红派息历史同步 (AKShare stock_history_dividend_detail)')
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

      const service = new DividendHistorySyncService();

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
        logger.info(`[sync-dividend-history] resolved ${stockCodes.length} stocks from DB`);
      } else {
        logger.error('Must provide --stock, --stocks, or --all');
        program.help({ error: true });
        return;
      }

      if (stockCodes.length === 0) {
        logger.warn('[sync-dividend-history] no stocks to sync after filtering');
        process.exit(0);
      }

      logger.info(
        `[sync-dividend-history] starting sync for ${stockCodes.length} stock(s) ` +
          `(interval=${opts.intervalMs}ms, force=${opts.force ? 'YES' : 'NO'})`
      );

      const result = await service.syncStocks(stockCodes, {
        skipExisting: !opts.force,
        intervalMs: opts.intervalMs,
      });

      logger.info(
        `[sync-dividend-history] stocks=${result.total_stocks} ` +
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
            logger.info(
              `  - ${d.stock_code}: upserted ${d.upserted} (yield_filled=${d.yield_filled})`
            );
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
      logger.error(`sync-dividend-history failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const s = symbol.trim();
  if (!s) return '';
  const i = s.indexOf('.');
  if (i < 0) return s;
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  // 前缀格式 (sh./sz./bj.) — 2 字母 alpha + 数字
  if (/^[a-zA-Z]{2}$/.test(before)) return after;
  // 后缀格式 (.SH/.SZ/.BJ)
  return before;
}

program.parseAsync(process.argv);
