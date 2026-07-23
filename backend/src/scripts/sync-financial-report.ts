#!/usr/bin/env node

import { Command } from 'commander';
import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import '../models';
import { FinancialReportSyncService } from '../data/services/FinancialReportSyncService';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';

const program = new Command();

program
  .name('sync-financial-report')
  .description('按股票同步历史财务报告 (AKShare)')
  .option('--stock <code>', '单只 6 位股票代码')
  .option('--stocks <codes>', '逗号分隔股票代码')
  .option('--all', '批量同步最近已完成报告期的全市场业绩报表', false)
  .option('--report-period <date>', '全市场报告期，YYYYMMDD 或 YYYY-MM-DD')
  .option('--interval-ms <n>', '每只股票之间的间隔毫秒', '500')
  .option('--refresh-after-days <n>', '最近 N 天已刷新则断点跳过', '21')
  .option('--force', '覆盖已有股票，关闭断点跳过', false)
  .action(async options => {
    try {
      await sequelize.authenticate();
      if (process.env.DATA_CLI_SYNC_SCHEMA === 'true') {
        await sequelize.sync({ alter: true });
      }

      if (options.all || options.reportPeriod) {
        const reportPeriod = options.reportPeriod || resolveLatestMarketReportPeriod();
        const listedStockCount = await Stock.count({ where: { is_listed: true, type: 'stock' } });
        const minimumEffectiveStockCount = Math.max(500, Math.ceil(listedStockCount * 0.2));
        const result = await new FinancialReportSyncService().syncMarketPeriod(reportPeriod);
        const coverageRows = (await sequelize.query(
          `SELECT COUNT(DISTINCT fr.stock_code)::int AS effective_stock_count
             FROM financial_reports fr
             JOIN stocks stock
               ON RIGHT(stock.symbol, 6) = fr.stock_code
              AND stock.type = 'stock'
              AND stock.is_listed = TRUE
            WHERE fr.report_date = :report_period
              AND (fr.net_profit_yoy IS NOT NULL OR fr.revenue_yoy IS NOT NULL)`,
          {
            replacements: { report_period: result.report_period },
            type: QueryTypes.SELECT,
          }
        )) as Array<{ effective_stock_count: number }>;
        const eligibleEffectiveStockCount = Number(coverageRows[0]?.effective_stock_count || 0);
        const ok =
          !result.error &&
          !result.empty &&
          result.upserted > 0 &&
          eligibleEffectiveStockCount >= minimumEffectiveStockCount;
        const summary = {
          scenario: 'financial_report_sync',
          ok,
          mode: 'market_period',
          report_period: result.report_period,
          total_stocks: listedStockCount,
          succeeded: eligibleEffectiveStockCount,
          skipped: 0,
          empty: result.empty ? 1 : 0,
          failed: result.error ? 1 : 0,
          total_upserted: result.upserted,
          fetched: result.fetched,
          effective_stock_count: eligibleEffectiveStockCount,
          source_effective_stock_count: result.effective_stock_count,
          minimum_effective_stock_count: minimumEffectiveStockCount,
          error: result.error || null,
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
        if (!ok) {
          throw new Error(
            result.error ||
              `全市场财报有效覆盖 ${eligibleEffectiveStockCount}，低于 ${minimumEffectiveStockCount}`
          );
        }
        logger.info(
          `[sync-financial-report] period=${result.report_period} fetched=${result.fetched} ` +
            `effective=${eligibleEffectiveStockCount} upserted=${result.upserted}`
        );
        process.exit(0);
      }

      let stock_codes: string[] = [];
      if (options.stock) stock_codes = [String(options.stock).trim()];
      else if (options.stocks) {
        stock_codes = String(options.stocks)
          .split(',')
          .map(value => value.trim())
          .filter(Boolean);
      } else {
        throw new Error('必须提供 --stock、--stocks、--all 或 --report-period');
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

export function resolveLatestMarketReportPeriod(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error('无法解析当前上海日期');
  }
  if (month >= 11) return `${year}0930`;
  if (month >= 9) return `${year}0630`;
  if (month >= 5) return `${year}0331`;
  return `${year - 1}1231`;
}
