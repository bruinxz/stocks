#!/usr/bin/env node
/**
 * PR-N (2026-06-29) backfill-missing-bars CLI
 *
 * 部署后手动跑一次, 把 PR-J 揭示的"sh.688/sz.001/sz.301 板块永远 sync 不到"
 * 的存量空洞一次补齐. 之后 DAILY_UPDATE (max_stocks=2000) 会自然维护.
 *
 * Usage:
 *   # 补 sh.688 板块过去 30 天
 *   npx ts-node --transpile-only backend/src/scripts/backfill-missing-bars.ts --board=688 --since=2026-05-29
 *
 *   # 补 sz.001 / sz.301 板块过去 60 天
 *   npx ts-node --transpile-only backend/src/scripts/backfill-missing-bars.ts --board=001,301 --since=2026-04-30
 *
 *   # 补指定 11 只存储模块股
 *   npx ts-node --transpile-only backend/src/scripts/backfill-missing-bars.ts \
 *     --symbols=sh.688008,sh.688123 --since=2026-04-30
 *
 *   # dry-run 列出会被补的 symbol (不调 akshare)
 *   npx ts-node --transpile-only backend/src/scripts/backfill-missing-bars.ts --board=688 --dry-run
 *
 * Flags:
 *   --board=<prefix-csv>  按板块前缀过滤 (688 / 001 / 301 / 30 / 60 / bj; csv 多板)
 *   --symbols=<csv>       直接指定 symbol 列表 (优先级高于 --board)
 *   --since=YYYY-MM-DD    回填起点日期 (默认 today - 30 天)
 *   --until=YYYY-MM-DD    回填终点日期 (默认 today)
 *   --concurrency=<N>     并发同步股数 (默认 3, 上限 10)
 *   --interval-ms=<N>     每股间最小间隔 ms (默认 300, 让 akshare 不挂)
 *   --provider=<name>     历史行情源 (默认 auto; 系统补洞推荐 tencent_only)
 *   --dry-run             仅列出会被补的 symbol 不实际调 akshare
 *
 * 退出码:
 *   0 = 全部成功 (或 dry-run 走完)
 *   1 = 至少一只 stock 同步失败
 */

import { Command } from 'commander';
import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { logger } from '../utils/logger';
import sequelize from '../config/database';
import '../models';

const program = new Command();

program
  .name('backfill-missing-bars')
  .description('PR-N: 按板块/symbol 列表回填缺失 daily_bars 历史数据')
  .option('--board <prefixes>', '板块前缀 csv (e.g. "688,30,001"). 不传则需 --symbols.')
  .option('--symbols <list>', '股票 symbol csv (e.g. "sh.688008,sh.688123"). 高优于 --board.')
  .option('--since <date>', '起点日期 YYYY-MM-DD, 默认 today-30d')
  .option('--until <date>', '终点日期 YYYY-MM-DD, 默认 today')
  .option('--concurrency <n>', '并发同步股数 (默认 3)', '3')
  .option('--interval-ms <n>', '每股间最小间隔 ms (默认 300)', '300')
  .option('--provider <name>', '历史行情源 (默认 auto)', 'auto')
  .option('--dry-run', 'dry-run 仅列出 symbol 不调 akshare')
  .action(async opts => {
    let exitCode = 0;
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: false });
      }

      const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
      const since =
        opts.since || moment().tz('Asia/Shanghai').subtract(30, 'days').format('YYYY-MM-DD');
      const until = opts.until || today;
      const concurrency = Math.min(Math.max(parseInt(opts.concurrency, 10) || 3, 1), 10);
      const intervalMs = Math.max(parseInt(opts.intervalMs, 10) || 300, 100);
      const provider = String(opts.provider || 'auto').trim() || 'auto';
      const dryRun = Boolean(opts.dryRun);

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');

      // 1) 解析目标 symbol 列表
      let symbols: string[] = [];
      if (opts.symbols) {
        symbols = String(opts.symbols)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        logger.info(`[backfill] 使用显式 --symbols: ${symbols.length} 只`);
      } else if (opts.board) {
        const prefixes = String(opts.board)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        const orConds: any[] = [];
        for (const p of prefixes) {
          if (p === '688' || p === '689') {
            orConds.push({ symbol: { [Op.like]: `sh.${p}%` } });
          } else if (p === '30' || p === '301' || p === '300' || p === '302') {
            orConds.push({ symbol: { [Op.like]: `sz.${p}%` } });
          } else if (p === '001' || p === '002' || p === '003') {
            orConds.push({ symbol: { [Op.like]: `sz.${p}%` } });
          } else if (p === '60' || p === '600' || p === '601' || p === '603' || p === '605') {
            orConds.push({ symbol: { [Op.like]: `sh.${p}%` } });
          } else if (p === '00' || p === '000') {
            orConds.push({ symbol: { [Op.like]: `sz.${p}%` } });
          } else if (p === 'bj' || p === '8' || p === '9') {
            orConds.push({ symbol: { [Op.like]: `bj.%` } });
          } else {
            orConds.push({ symbol: { [Op.like]: `${p}%` } });
          }
        }
        const rows: Array<{ symbol: string }> = await Stock.findAll({
          attributes: ['symbol'],
          where: { is_listed: true, [Op.or]: orConds },
          raw: true,
        });
        symbols = rows.map(r => String(r.symbol || '')).filter(Boolean);
        logger.info(
          `[backfill] 板块前缀 ${prefixes.join(',')} 匹配 ${symbols.length} 只 listed stock`
        );
      } else {
        throw new Error('必须传 --board 或 --symbols 其一');
      }

      if (symbols.length === 0) {
        logger.warn('[backfill] 0 个 symbol 待回填, 退出.');
        process.exit(0);
        return;
      }

      if (dryRun) {
        console.log(
          `[backfill] DRY-RUN: 将回填 ${symbols.length} 只 stock, 区间 ${since} → ${until}`
        );
        symbols.slice(0, 50).forEach(s => console.log(`  - ${s}`));
        if (symbols.length > 50) console.log(`  ... 还有 ${symbols.length - 50} 只`);
        process.exit(0);
        return;
      }

      // 2) 实际回填 — 复用 DataSyncService.syncStockHistory upsert 语义.
      const { DataSyncService } = await import('../data/services/DataSyncService');
      const dataSyncService = new DataSyncService();

      let okCount = 0;
      let failCount = 0;
      let skipCount = 0;
      let totalInserted = 0;

      for (let i = 0; i < symbols.length; i += concurrency) {
        const batch = symbols.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map(async symbol => {
            try {
              const inserted = await dataSyncService.syncStockHistory(
                symbol,
                since,
                until,
                provider
              );
              return { symbol, inserted, error: null };
            } catch (err: any) {
              return { symbol, inserted: -1, error: err?.message || String(err) };
            }
          })
        );
        for (const r of results) {
          if (r.inserted > 0) {
            okCount += 1;
            totalInserted += r.inserted;
          } else if (r.inserted === 0) {
            skipCount += 1;
          } else {
            failCount += 1;
            exitCode = 1;
            logger.warn(`[backfill] ${r.symbol} failed: ${r.error}`);
          }
        }
        logger.info(
          `[backfill] progress ${Math.min(i + concurrency, symbols.length)}/${symbols.length} ` +
            `(ok=${okCount} skip=${skipCount} fail=${failCount} inserted=${totalInserted})`
        );
        if (i + concurrency < symbols.length) {
          await new Promise(r => setTimeout(r, intervalMs));
        }
      }

      logger.info(
        `[backfill] DONE — total=${symbols.length} ok=${okCount} skip=${skipCount} fail=${failCount} inserted=${totalInserted}`
      );
      process.exit(exitCode);
    } catch (err: any) {
      logger.error(`[backfill] FATAL: ${err?.message || err}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
