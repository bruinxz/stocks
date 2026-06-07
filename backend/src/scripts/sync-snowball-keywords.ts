#!/usr/bin/env node
/**
 * 雪球热词同步 CLI (US-058)
 *
 * 把 SnowballHotKeywordSyncService 跑成 cron 任务: 每日收盘后 (~16:00) 抓取
 * 雪球关注度排行榜并落库; 前端 GET 端点直接读 DB。
 *
 * Usage:
 *   npm run sync:snowball-keywords                              # 当日, symbol=最热门
 *   npm run sync:snowball-keywords -- --date=2026-06-04         # 指定日 (打标签)
 *   npm run sync:snowball-keywords -- --symbol=本周新增
 *   npm run sync:snowball-keywords -- --limit=500
 *   npm run sync:snowball-keywords -- --backfill=2026-06-01,2026-06-04
 *   npm run sync:snowball-keywords -- --force                   # 覆盖已存在的当日数据
 *
 * 选项:
 *   --date=<YYYY-MM-DD>           单日 (默认今日)
 *   --symbol=<最热门|本周新增>      雪球榜口径 (默认 '最热门')
 *   --limit=<n>                   返回行数上限 (默认 200)
 *   --baseline-lookback=<n>       baseline 回看自然日数 (默认 14)
 *   --backfill=<start,end>        回填模式: 逐日重算 [start..end] 范围 (含)
 *   --force                       覆盖已存在 (默认 skipExisting=true)
 *   --interval-ms=<n>             backfill 日间间隔 ms (默认 3000)
 *
 * 数据特性 (与 US-008 IndustryFlow 同款 real-time-only):
 *   - AKShare `stock_hot_follow_xq` 无日期参数, 返回 "now" 的关注度;
 *   - --date / --backfill 中的日期只是给行打标签, 内容仍是当下快照;
 *   - 服务层在盘后 16:00 调度, 当天的热度数据贴当天 trade_date 即可。
 *
 * 配套环境变量:
 *   SNOWBALL_KEYWORD_TIMEOUT_MS    Python 子进程 timeout (默认 120_000)
 *   SNOWBALL_KEYWORD_SKIP_EXISTING 0 表示 backfill 时不跳过已存在 (默认 1)
 *   PYTHON_PATH                    python3 路径
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import {
  SnowballHotKeywordSyncService,
  SyncDateOptions,
  sleep as syncSleep,
} from '../data/services/SnowballHotKeywordSyncService';
import { SnowballSymbol } from '../data/sources/SnowballHotKeywordClient';

const program = new Command();

program
  .name('sync-snowball-keywords')
  .description('同步雪球热词榜 → snowball_hot_keywords 表 (US-058)')
  .option('--date <YYYY-MM-DD>', '单日 (默认今日)')
  .option('--symbol <最热门|本周新增>', '雪球榜口径', '最热门')
  .option('--limit <n>', '返回行数上限', (v: string) => parseInt(v, 10), 200)
  .option('--baseline-lookback <n>', 'baseline 回看自然日数', (v: string) => parseInt(v, 10), 14)
  .option('--backfill <range>', '回填模式: 逐日重算 [start..end] 范围 (start,end 用逗号分隔)')
  .option('--force', '覆盖已存在 (默认 skipExisting=true)', false)
  .option('--interval-ms <n>', 'backfill 日间间隔 ms', (v: string) => parseInt(v, 10), 3000)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new SnowballHotKeywordSyncService();
      const symbol = ((opts.symbol as string) || '最热门') as SnowballSymbol;
      const syncOptions: SyncDateOptions = {
        symbol,
        limit: opts.limit,
        baselineLookbackDays: opts.baselineLookback,
      };

      if (opts.backfill) {
        // === backfill 模式 ===
        const parts = String(opts.backfill)
          .split(',')
          .map(s => s.trim());
        if (parts.length !== 2) {
          throw new Error('--backfill 必须形如 2026-06-01,2026-06-04');
        }
        const [start, end] = parts;
        const result = await service.syncRange(start, end, {
          ...syncOptions,
          skipExisting: !opts.force,
          intervalMs: opts.intervalMs,
        });
        logger.info(
          `Backfill ${start} → ${end} (symbol=${symbol}): ` +
            `${result.succeeded} ok, ${result.skipped} skipped, ${result.failed} failed`
        );
        for (const d of result.details) {
          if (d.skipped) {
            logger.info(`[${d.trade_date}] skipped (existing)`);
          } else if (d.error) {
            logger.error(`[${d.trade_date}] FAILED: ${d.error}`);
          } else {
            logger.info(
              `[${d.trade_date}] ${d.upserted} rows, ${d.new_keywords_count} new ` +
                `(baseline=${d.baseline_trade_date || 'none'})`
            );
          }
        }
      } else {
        // === 单日模式 ===
        const date = opts.date || todayIso();
        const result = await service.syncDate(date, syncOptions);
        logger.info(JSON.stringify(result, null, 2));
      }

      await sequelize.close();
      process.exit(0);
    } catch (error) {
      logger.error(`雪球热词同步失败: ${(error as Error).message}`);
      try {
        await sequelize.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
  });

program.parseAsync(process.argv);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 引入 sleep 防 linter 未使用警告 (CLI 仅 backfill 用到, syncSleep 已通过 syncRange 内调用)
void syncSleep;
