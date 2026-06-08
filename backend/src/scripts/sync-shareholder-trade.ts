#!/usr/bin/env node
/**
 * 股东增减持公告同步 CLI (US-090)
 *
 * Usage:
 *   npm run sync:shareholder-trade
 *   npm run sync:shareholder-trade -- --symbol=股东增持
 *   npm run sync:shareholder-trade -- --symbol=股东减持
 *
 * 选项:
 *   --symbol=<全部|股东增持|股东减持>  增减方向过滤, 默认 '全部'
 *
 * AKShare `stock_ggcg_em(symbol)` 是 real-time-only 快照端点 (无日期参数),
 * 单次调用返回 ~140k 行近 N 月全市场公告. 业务默认全跑一次, 通过
 * trade_direction 列分流查询; 'symbol=股东增持' / 'symbol=股东减持' 仅在需要
 * 单方向 backfill 时使用.
 *
 * 调度建议: 每日盘后 16:30 跑一次 '全部'; 同款 real-time-only 模式见
 * US-008 IndustryFlow / US-058 SnowballHotKeyword.
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { ShareholderTradeSyncService } from '../data/services/ShareholderTradeSyncService';
import { ShareholderTradeSymbol } from '../data/sources/ShareholderTradeClient';

const program = new Command();

program
  .name('sync-shareholder-trade')
  .description('股东增减持公告同步 (AKShare stock_ggcg_em real-time snapshot)')
  .option('--symbol <symbol>', '增减方向: 全部 | 股东增持 | 股东减持', '全部')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式自动建表 / alter; 生产应改走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const validSymbols: ShareholderTradeSymbol[] = ['全部', '股东增持', '股东减持'];
      const symbol = (opts.symbol || '全部') as ShareholderTradeSymbol;
      if (!validSymbols.includes(symbol)) {
        logger.error(`Invalid --symbol (expected 全部 / 股东增持 / 股东减持): ${opts.symbol}`);
        process.exit(1);
      }

      const service = new ShareholderTradeSyncService();
      const result = await service.syncSnapshot(symbol);

      logger.info(
        `[sync-shareholder-trade] symbol=${result.symbol} ` +
          `fetched=${result.fetched} upserted=${result.upserted} ` +
          `dedup_dropped=${result.dedup_dropped} ` +
          `dist=${JSON.stringify(result.shareholder_type_distribution)}`
      );

      if (result.error) {
        logger.error(`sync-shareholder-trade ERROR: ${result.error}`);
        process.exit(1);
      }
      process.exit(0);
    } catch (error) {
      logger.error(`sync-shareholder-trade failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
