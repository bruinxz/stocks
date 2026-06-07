#!/usr/bin/env node
/**
 * 市场情绪量化指数 CLI (US-057)
 *
 * 把 MarketSentimentIndexService 跑成 cron 任务: 每日收盘后 (~16:30) 计算并
 * 写入 `market_sentiment_indices` 表; 前端 GET 端点直接读 DB。
 *
 * Usage:
 *   npm run sync:market-sentiment                              # 当日, 默认 60 lookback
 *   npm run sync:market-sentiment -- --date=2026-06-04         # 指定日
 *   npm run sync:market-sentiment -- --lookback-days=90
 *   npm run sync:market-sentiment -- --dry-run                 # 不写表
 *   npm run sync:market-sentiment -- --backfill=2026-05-01,2026-06-04   # 回填日期范围
 *
 * 选项:
 *   --date=<YYYY-MM-DD>           单日 (默认今日)
 *   --lookback-days=<n>           lookback 窗口 (默认 60)
 *   --min-observations=<n>        z-score 最少样本数 (默认 5)
 *   --sigmoid-scale=<n>           归一化曲度 (默认 30)
 *   --dry-run                     不写表, 仅打印结果
 *   --backfill=<start,end>        回填模式: 逐日重算 [start..end] 范围 (含)
 *
 * 数据特性:
 *   - 4 维度并发 fetch (涨停 / 跌停 / 北向日总 / 融资日总 / 问答热度日总);
 *   - 任一维度失败用 fallback 不阻塞其他, status 自动降级到 'partial';
 *   - 写库 upsert PK=trade_date, idempotent reruns 安全;
 *   - 回填模式逐日串行执行 (与 Python 调用 throttle 自然吻合)。
 *
 * 配套环境变量:
 *   MARGIN_BALANCE_TIMEOUT_MS    Python 子进程 timeout (默认 60_000)
 *   LIMIT_DOWN_TIMEOUT_MS        同上
 *   PYTHON_PATH                  python3 路径
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { MarketSentimentIndexService } from '../services/MarketSentimentIndexService';

const program = new Command();

program
  .name('sync-market-sentiment')
  .description('计算市场情绪量化指数 → market_sentiment_indices 表 (US-057)')
  .option('--date <YYYY-MM-DD>', '单日 (默认今日)')
  .option('--lookback-days <n>', 'lookback 窗口', (v: string) => parseInt(v, 10), 60)
  .option('--min-observations <n>', 'z-score 最少样本数', (v: string) => parseInt(v, 10), 5)
  .option('--sigmoid-scale <n>', '归一化曲度', (v: string) => parseInt(v, 10), 30)
  .option('--dry-run', '不写表, 仅打印结果', false)
  .option(
    '--backfill <range>',
    '回填模式: 逐日重算 [start..end] 范围 (start,end 用逗号分隔, 含两端)'
  )
  .option('--interval-ms <n>', '回填模式下日间 sleep ms', (v: string) => parseInt(v, 10), 200)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new MarketSentimentIndexService();

      // === backfill 模式 ===
      if (opts.backfill) {
        const parts = String(opts.backfill)
          .split(',')
          .map(s => s.trim());
        if (parts.length !== 2) {
          throw new Error('--backfill 必须形如 2026-05-01,2026-06-04');
        }
        const [start, end] = parts;
        const dates = expandDateRange(start, end);
        logger.info(`Backfill 模式: ${dates.length} 个日期 ${start} → ${end}`);

        let okCount = 0;
        let failedCount = 0;
        for (const d of dates) {
          try {
            const result = await service.computeAndPersist({
              trade_date: d,
              lookback_days: opts.lookbackDays,
              min_observations: opts.minObservations,
              sigmoid_scale: opts.sigmoidScale,
              dry_run: Boolean(opts.dryRun),
            });
            const indexFmt = result.index_value.toFixed(1);
            logger.info(
              `[${d}] index=${indexFmt} status=${result.status} persisted=${result.persisted}`
            );
            okCount++;
          } catch (error) {
            failedCount++;
            logger.error(`[${d}] FAILED: ${(error as Error).message}`);
          }
          if (opts.intervalMs > 0) {
            await sleep(opts.intervalMs);
          }
        }
        logger.info(`Backfill complete: ${okCount} ok, ${failedCount} failed`);
      } else {
        // === 单日模式 ===
        const result = await service.computeAndPersist({
          trade_date: opts.date,
          lookback_days: opts.lookbackDays,
          min_observations: opts.minObservations,
          sigmoid_scale: opts.sigmoidScale,
          dry_run: Boolean(opts.dryRun),
        });
        logger.info(JSON.stringify(result, null, 2));
      }

      await sequelize.close();
      process.exit(0);
    } catch (error) {
      logger.error(`市场情绪指数计算失败: ${(error as Error).message}`);
      try {
        await sequelize.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
  });

function expandDateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const dStart = new Date(`${start}T00:00:00Z`);
  const dEnd = new Date(`${end}T00:00:00Z`);
  if (
    !Number.isFinite(dStart.getTime()) ||
    !Number.isFinite(dEnd.getTime()) ||
    dEnd.getTime() < dStart.getTime()
  ) {
    throw new Error(`Invalid backfill range: ${start} ~ ${end}`);
  }
  const cur = new Date(dStart);
  while (cur.getTime() <= dEnd.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

program.parseAsync(process.argv).catch(err => {
  logger.error(`Unexpected CLI error: ${err.message}`);
  process.exit(1);
});
