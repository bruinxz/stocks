#!/usr/bin/env node
/**
 * 投资者问答 NLP 同步 CLI (US-060)
 *
 * 拉取 cninfo 互动易 per-stock 全部历史问答 → 启发式 / AI NLP 抽取主题 + 情绪 →
 * 按 ISO 周聚合 (week_start) → 落库 east_money_qa_topics.
 *
 * 定时建议: 每周一早晨 9:00 跑全市场, 增量补当周新增问题.
 *
 * Usage:
 *   npm run sync:qa-topics -- --stock=600519                       # 单只股票
 *   npm run sync:qa-topics -- --stocks=600519,000001               # 多只股票
 *   npm run sync:qa-topics -- --all                                # 全 A 股 (慢)
 *   npm run sync:qa-topics -- --all --since=2026-05-01             # 仅聚合该日之后的问答
 *   npm run sync:qa-topics -- --stock=600519 --with-ai             # AI 路径 (慢 + 贵)
 *   npm run sync:qa-topics -- --stock=600519 --dry-run             # 不写库
 *
 * 选项:
 *   --stock=<6-digit>           单只股票
 *   --stocks=<csv>              多只股票
 *   --all                       全 A 股 (仅 is_listed=true)
 *   --listed-before=<date>      与 --all 配合, 过滤上市日早于该日 (默认: 无)
 *   --limit=<n>                 单股拉取上限 (默认 200, max ~2000)
 *   --since=<YYYY-MM-DD>        仅聚合此日之后的问题
 *   --with-ai                   启用远端 AI 抽取 (默认 false 走启发式)
 *   --interval-ms=<n>           每只股票之间 sleep ms (默认 500, cninfo 限流)
 *   --dry-run                   跳过 DB 写入
 *   --continue-on-error         单股失败仍继续 (默认 true)
 *
 * 配套环境变量:
 *   STOCK_QA_TIMEOUT_MS        Python 子进程 timeout (默认 120_000)
 *   TRADING_AGENTS_URL         AI 远端 (默认 http://47.93.224.109:8000)
 *   PYTHON_PATH                python3 路径
 */

import { Command } from 'commander';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import '../models';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';
import { EastMoneyQATopicService, SyncStockOptions } from '../services/EastMoneyQATopicService';

const program = new Command();

program
  .name('sync-qa-topics')
  .description('投资者问答 NLP 主题 + 情绪同步 → east_money_qa_topics 表 (US-060)')
  .option('--stock <code>', '单只股票 6 位代码')
  .option('--stocks <codes>', '多只股票, 逗号分隔', (val: string) =>
    val
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )
  .option('--all', '全 A 股 (仅 stocks 表中 is_listed=true 的)', false)
  .option('--listed-before <date>', '与 --all 配合, 过滤上市日早于该日 (YYYY-MM-DD)')
  .option('--limit <n>', '单股拉取上限', (v: string) => parseInt(v, 10), 200)
  .option('--since <date>', '仅聚合此日之后的问题 (YYYY-MM-DD)')
  .option('--with-ai', '启用远端 AI 抽取 (默认 false 走启发式)', false)
  .option('--interval-ms <n>', '每只股票之间 sleep ms', (v: string) => parseInt(v, 10), 500)
  .option('--dry-run', '跳过 DB 写入', false)
  .option('--continue-on-error', '单股失败仍继续', true)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式 auto-build; 生产请走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new EastMoneyQATopicService();

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
        logger.info(`[sync-qa-topics] resolved ${stockCodes.length} stocks from DB`);
      } else {
        logger.error('Must provide --stock, --stocks, or --all');
        program.help({ error: true });
        return;
      }

      if (stockCodes.length === 0) {
        logger.warn('[sync-qa-topics] no stocks to sync after filtering');
        process.exit(0);
      }

      // 校验 --since 格式
      if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
        logger.error(`--since must be YYYY-MM-DD, got: ${opts.since}`);
        process.exit(1);
      }

      const syncOptions: SyncStockOptions = {
        limit: opts.limit,
        extract_with_ai: opts.withAi === true,
        dry_run: opts.dryRun === true,
        since_date: opts.since,
      };

      logger.info(
        `[sync-qa-topics] starting sync for ${stockCodes.length} stock(s) ` +
          `(limit=${syncOptions.limit}, ai=${syncOptions.extract_with_ai}, ` +
          `dry_run=${syncOptions.dry_run}, since=${syncOptions.since_date || 'none'})`
      );

      const result = await service.syncStocks(stockCodes, {
        ...syncOptions,
        continue_on_error: opts.continueOnError !== false,
        interval_ms: opts.intervalMs,
      });

      logger.info(
        `[sync-qa-topics] stocks=${result.total_stocks} ` +
          `succeeded=${result.succeeded} failed=${result.failed}`
      );

      // 紧凑 per-stock summary 上限 50 行
      if (result.details.length <= 50) {
        for (const d of result.details) {
          if (d.error) {
            logger.warn(`  - ${d.stock_code}: ERROR ${d.error}`);
          } else {
            logger.info(
              `  - ${d.stock_code}: fetched=${d.fetched} weeks=${d.weeks_aggregated} ` +
                `upserted=${d.rows_upserted} by_topic=${JSON.stringify(d.by_topic)}`
            );
          }
        }
      } else {
        // 大批量只显示失败
        for (const d of result.details) {
          if (d.error) logger.warn(`  - ${d.stock_code}: ERROR ${d.error}`);
        }
      }

      await sequelize.close();
      process.exit(result.failed > 0 && opts.continueOnError === false ? 1 : 0);
    } catch (error) {
      logger.error(`sync-qa-topics failed: ${(error as Error).message}`);
      try {
        await sequelize.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
  });

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const i = symbol.indexOf('.');
  return i < 0 ? symbol : symbol.slice(0, i);
}

program.parseAsync(process.argv);
