#!/usr/bin/env node
/**
 * 公告 NLP 同步 CLI (US-059)
 *
 * 拉取 AKShare 当日全市场公告 → 启发式 / AI NLP 抽取 → 落库 announcement_summaries.
 * 定时建议: 每日盘后 17:00 跑当日 (放在收盘后让 AKShare 接口数据更稳定).
 *
 * Usage:
 *   npm run sync:announcements                                     # 当日, symbol=全部, 启发式
 *   npm run sync:announcements -- --date=2026-06-06                # 指定日
 *   npm run sync:announcements -- --symbol=重大事项                 # 仅同步重大事项
 *   npm run sync:announcements -- --with-ai                        # 调远端 AI (慢 + 贵)
 *   npm run sync:announcements -- --backfill=2026-06-01,2026-06-05 # 区间回填
 *   npm run sync:announcements -- --dry-run                        # 不写库, 只看 NLP 抽取结果
 *
 * 选项:
 *   --date=<YYYY-MM-DD>       单日 (默认今日)
 *   --symbol=<...>            东财预过滤类型 (默认 '全部'); 可选 '重大事项' / '财务报告' /
 *                             '融资公告' / '风险提示' / '资产重组' / '信息变更' / '持股变动'
 *   --with-ai                 启用远端 AI 抽取 (默认 false 走启发式; AI 路径每条 30s+)
 *   --backfill=<start,end>    回填模式: 逐日 [start..end] 闭区间
 *   --force                   覆盖已存在 (默认 skipExisting=true)
 *   --interval-ms=<n>         backfill 日间间隔 ms (默认 5000)
 *   --dry-run                 跳过 DB 写入
 *
 * 配套环境变量:
 *   ANNOUNCEMENT_TIMEOUT_MS  Python 子进程 timeout (默认 180_000)
 *   TradingAgents 由本机 stocks-tradingagents.service 提供 (127.0.0.1:8000)
 *   PYTHON_PATH              python3 路径
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import {
  AnnouncementNLPService,
  SyncDateOptions,
  sleep as syncSleep,
} from '../services/AnnouncementNLPService';
import { AnnouncementSymbol } from '../data/sources/AnnouncementClient';

const program = new Command();

program
  .name('sync-announcements')
  .description('同步公司公告 + AI NLP 抽取 → announcement_summaries 表 (US-059)')
  .option('--date <YYYY-MM-DD>', '单日 (默认今日)')
  .option(
    '--symbol <type>',
    "东财预过滤类型 (默认 '全部'); 可选: 重大事项/财务报告/融资公告/风险提示/资产重组/信息变更/持股变动",
    '全部'
  )
  .option('--with-ai', '启用远端 AI 抽取 (默认 false 走启发式)', false)
  .option('--backfill <range>', '回填模式: 逐日重算 [start..end] 范围 (start,end 用逗号分隔)')
  .option('--force', '覆盖已存在 (默认 skipExisting=true)', false)
  .option('--interval-ms <n>', 'backfill 日间间隔 ms', (v: string) => parseInt(v, 10), 5000)
  .option('--dry-run', '跳过 DB 写入', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const service = new AnnouncementNLPService();
      const symbol = ((opts.symbol as string) || '全部') as AnnouncementSymbol;
      const syncOptions: SyncDateOptions = {
        symbol,
        extract_with_ai: opts.withAi === true,
        dry_run: opts.dryRun === true,
      };

      if (opts.backfill) {
        // === backfill 模式 ===
        const parts = String(opts.backfill)
          .split(',')
          .map(s => s.trim());
        if (parts.length !== 2) {
          throw new Error('--backfill 必须形如 2026-06-01,2026-06-05');
        }
        const [start, end] = parts;
        const result = await service.syncRange(start, end, {
          ...syncOptions,
          skipExisting: !opts.force,
          intervalMs: opts.intervalMs,
        });
        logger.info(
          `Backfill ${start} → ${end} (symbol=${symbol}, ai=${opts.withAi === true}): ` +
            `${result.succeeded} ok, ${result.skipped} skipped, ${result.failed} failed`
        );
        for (const d of result.details) {
          if (d.skipped) {
            logger.info(`[${d.announce_date}] skipped (existing)`);
          } else if (d.error) {
            logger.error(`[${d.announce_date}] FAILED: ${d.error}`);
          } else {
            logger.info(
              `[${d.announce_date}] ${d.upserted} rows ` +
                `(sentiment=${JSON.stringify(d.by_sentiment)}, status=${JSON.stringify(
                  d.by_status
                )})`
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
      logger.error(`公告 NLP 同步失败: ${(error as Error).message}`);
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

// 防 linter 未使用警告 (syncSleep 已通过 service.syncRange 内部调用)
void syncSleep;
