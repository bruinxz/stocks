#!/usr/bin/env node
/**
 * KOL 观点聚合 CLI (US-056)
 *
 * 把 KOLAggregatorService 跑成 cron 任务：把"行业大 V / 券商 / 媒体 / 集体市场"
 * 对收藏股票（或全 A 股）的最新观点聚合到 `kol_opinions` 表, 前端 GET 端点
 * 直接读 DB, 不再触发 fetch。
 *
 * Usage:
 *   npm run sync:kol-opinions -- --stock=600519
 *   npm run sync:kol-opinions -- --stocks=600519,000001
 *   npm run sync:kol-opinions -- --all                       # 全 A 股 is_listed
 *   npm run sync:kol-opinions -- --favorites                 # 仅用户收藏股票
 *   npm run sync:kol-opinions -- --stock=600519 --limit=15 --lookback-days=30
 *   npm run sync:kol-opinions -- --stock=600519 --dry-run    # 不写库
 *
 * 选项:
 *   --stock=<6-digit>             单只股票
 *   --stocks=<csv>                多只股票 (逗号分隔)
 *   --all                         全 A 股 (stocks.is_listed=true)
 *   --favorites                   仅用户收藏 (FavoriteStock 表去重)
 *   --limit=<n>                   每股聚合行数上限 (默认 10, 范围 1-50)
 *   --lookback-days=<n>           lookback 窗口 (默认 90)
 *   --interval-ms=<n>             股票间 sleep (默认 300ms, AKShare 限流)
 *   --dry-run                     不写 KOLOpinion 表
 *
 * 数据特性:
 *   - 每股 ~3 来源并发 fetch + dedupe + sort + slice → upsert 到 KOLOpinion;
 *   - 任一来源失败用 [] fallback, 不阻塞其他来源;
 *   - 写库是 idempotent 的 (3-tuple PK + updateOnDuplicate);
 *   - --favorites 模式下 KOLOpinion 表会跟用户关注列表演变。
 *
 * 配套环境变量:
 *   KOL_AGGREGATOR_TIMEOUT_MS    单 Python 子进程 timeout (默认 60_000)
 *   PYTHON_PATH                  python3 路径
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { Stock } from '../models/Stock';
import { FavoriteStock } from '../models/FavoriteStock';
import { logger } from '../utils/logger';
import { KOLAggregatorService } from '../services/KOLAggregatorService';

const program = new Command();

program
  .name('sync-kol-opinions')
  .description('KOL 观点聚合 (券商研报 + 个股新闻 + 热门概念代理) → kol_opinions 表')
  .option('--stock <code>', '单只股票 6 位代码')
  .option('--stocks <codes>', '多只股票, 逗号分隔', (val: string) =>
    val
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )
  .option('--all', '全 A 股 (stocks.is_listed=true)', false)
  .option('--favorites', '仅用户收藏 (FavoriteStock 表去重)', false)
  .option('--limit <n>', '每股聚合行数上限', (v: string) => parseInt(v, 10), 10)
  .option('--lookback-days <n>', '回看窗口', (v: string) => parseInt(v, 10), 90)
  .option('--interval-ms <n>', '股票间 sleep ms', (v: string) => parseInt(v, 10), 300)
  .option('--dry-run', '不写 KOLOpinion 表', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new KOLAggregatorService();

      // === 解析股票列表 ===
      let stockCodes: string[] = [];
      if (opts.stock) {
        stockCodes = [String(opts.stock).trim()];
      } else if (opts.stocks && (opts.stocks as string[]).length) {
        stockCodes = opts.stocks as string[];
      } else if (opts.favorites) {
        const rows = (await FavoriteStock.findAll({
          attributes: ['symbol'],
          raw: true,
        })) as unknown as Array<{ symbol: string }>;
        stockCodes = Array.from(
          new Set(rows.map(r => stripSuffix(r.symbol)).filter(c => /^\d{6}$/.test(c)))
        );
        logger.info(`[sync-kol-opinions] resolved ${stockCodes.length} favorites from DB`);
      } else if (opts.all) {
        const rows = (await Stock.findAll({
          attributes: ['symbol'],
          where: { is_listed: true },
          raw: true,
        })) as unknown as Array<{ symbol: string }>;
        stockCodes = rows.map(r => stripSuffix(r.symbol)).filter(c => /^\d{6}$/.test(c));
        logger.info(`[sync-kol-opinions] resolved ${stockCodes.length} listed stocks from DB`);
      } else {
        logger.error('Must provide one of --stock / --stocks / --favorites / --all');
        program.help({ error: true });
        return;
      }

      if (stockCodes.length === 0) {
        logger.warn('[sync-kol-opinions] no stocks resolved, exiting');
        process.exit(0);
      }

      logger.info(
        `[sync-kol-opinions] aggregating for ${stockCodes.length} stock(s) ` +
          `(limit=${opts.limit}, lookback=${opts.lookbackDays}d, ` +
          `dry-run=${opts.dryRun ? 'YES' : 'NO'}, interval=${opts.intervalMs}ms)`
      );

      const summary = await service.aggregateForStocks(stockCodes, {
        limit: opts.limit,
        lookbackDays: opts.lookbackDays,
        dryRun: opts.dryRun,
        intervalMs: opts.intervalMs,
      });

      logger.info(
        `[sync-kol-opinions] total=${summary.total} ` +
          `succeeded=${summary.succeeded} failed=${summary.failed}`
      );

      if (summary.details.length <= 50) {
        for (const d of summary.details) {
          if (d.error) {
            logger.warn(`  - ${d.stock_code}: ERROR ${d.error}`);
          } else {
            const bs = d.by_source;
            logger.info(
              `  - ${d.stock_code}: ${d.total_collected} opinions ` +
                `(research=${bs.research_report}, news=${bs.east_money_news}, ` +
                `concept=${bs.xq_hot_concept}) persisted=${d.persisted}`
            );
          }
        }
      } else {
        for (const d of summary.details) {
          if (d.error) logger.warn(`  - ${d.stock_code}: ERROR ${d.error}`);
        }
      }

      process.exit(summary.failed > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`sync-kol-opinions failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const i = symbol.indexOf('.');
  return i < 0 ? symbol : symbol.slice(0, i);
}

program.parseAsync(process.argv);
