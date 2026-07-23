#!/usr/bin/env node

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { FinancialReportSyncService } from '../data/services/FinancialReportSyncService';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';
import { normalizeSymbol } from '../utils/stockSymbol';

const program = new Command();

program
  .name('sync-financial-report')
  .description('按股票同步历史财务报告 (AKShare)')
  .option('--stock <code>', '单只 6 位股票代码')
  .option('--stocks <codes>', '逗号分隔股票代码')
  .option('--all', '同步全部已上市 A 股', false)
  .option('--interval-ms <n>', '每只股票之间的间隔毫秒', '500')
  .option('--refresh-after-days <n>', '最近 N 天已刷新则断点跳过', '21')
  .option('--force', '覆盖已有股票，关闭断点跳过', false)
  .action(async options => {
    try {
      await sequelize.authenticate();
      if (process.env.DATA_CLI_SYNC_SCHEMA === 'true') {
        await sequelize.sync({ alter: true });
      }

      let stock_codes: string[] = [];
      if (options.stock) stock_codes = [String(options.stock).trim()];
      else if (options.stocks) {
        stock_codes = String(options.stocks)
          .split(',')
          .map(value => value.trim())
          .filter(Boolean);
      } else if (options.all) {
        const stocks = await Stock.findAll({
          attributes: ['symbol'],
          where: { is_listed: true, type: 'stock' },
          order: [['symbol', 'ASC']],
        });
        stock_codes = stocks.map(stock => normalizeSymbol(stock.symbol).replace(/^\D+/, ''));
      } else {
        throw new Error('必须提供 --stock、--stocks 或 --all');
      }
      stock_codes = [...new Set(stock_codes.filter(code => /^\d{6}$/.test(code)))];
      if (stock_codes.length === 0) throw new Error('没有可同步的有效股票代码');

      const result = await new FinancialReportSyncService().syncStocks(stock_codes, {
        skip_existing: !options.force,
        interval_ms: Number(options.intervalMs),
        refresh_after_days: Number(options.refreshAfterDays),
      });
      const ok =
        result.failed === 0 &&
        (result.total_upserted > 0 || result.skipped === result.total_stocks);
      const summary = { scenario: 'financial_report_sync', ok, ...result };
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      logger.info(
        `[sync-financial-report] stocks=${result.total_stocks} upserted=${result.total_upserted} ` +
          `skipped=${result.skipped} empty=${result.empty} failed=${result.failed}`
      );
      process.exit(ok ? 0 : 1);
    } catch (error) {
      logger.error(`sync-financial-report failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
