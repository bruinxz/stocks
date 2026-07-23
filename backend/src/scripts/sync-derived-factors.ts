#!/usr/bin/env node
/**
 * 派生因子同步 CLI — Plan A (东方财富免费源) 主线命脉数据入口
 *
 * 背景 (2026-07 重构 Signal-First + Core-Satellite):
 *   Core 70% = ETF 因子轮动, 打分读 stock_valuation_factors / stock_fundamental_factors /
 *   stock_money_flow_factors 三张表 (经 ETF→成分股展开后横截面 z-score)。若这三张表为空,
 *   ETFFactorService 判 data_incomplete=true → total_score=-Infinity → ETFRankingService 全部
 *   过滤 → Core 腿空仓。故这三张表必须有稳定的定时写入源。
 *
 *   `stockFactorService.syncDerivedFactors` 此前只能经 MarketController 的 HTTP 端点手动触发,
 *   既无 CLI 也无 cron。本脚本补齐 CLI 入口, 供 SchedulerService(DERIVED_FACTOR_SYNC 任务)
 *   与运维手动/部署首刷调用。
 *
 * 数据源 (Plan A):
 *   provider=eastmoney — 纯 TS HTTP 客户端 (EastMoneyClient), 无需 Python/akshare/token。
 *   落 PE/PB/市值/换手率/主力净流入 (真实) + roe/gross_margin (弱代理) → 三张因子表。
 *   provider=auto — Tushare(若配置 token) → eastmoney → local_derived 依次兜底。
 *
 * Usage:
 *   npm run sync:derived-factors                          # provider=auto, 全市场
 *   npm run sync:derived-factors -- --provider=auto
 *   npm run sync:derived-factors -- --limit=6000
 *   npm run sync:derived-factors -- --as-of=2026-07-03
 *   npm run sync:derived-factors -- --symbols=600519,000001,510300
 *   npm run sync:derived-factors -- --skip-if-coverage-gte=95   # 覆盖率达标即跳过重复落盘
 *
 * 选项:
 *   --provider=<eastmoney|baostock|tushare|local_derived|auto>  默认 eastmoney
 *   --scope=<market|favorites|custom>                  默认 market
 *   --symbols=<code,code,...>                          自定义股票池 (带市场前缀或纯6位皆可)
 *   --limit=<n>                                         全市场落盘上限, 默认 6000 (覆盖全 A 股)
 *   --as-of=<YYYY-MM-DD>                                因子日期标签, 默认今日
 *   --user-id=<n>                                       scope=favorites 时用
 *   --skip-if-coverage-gte=<pct>                        覆盖率≥阈值则跳过 (缩短重复落盘)
 *   --skip-if-real-provider-gte=<pct>                   真实源占比≥阈值则跳过 (默认服务内 65)
 *
 * 退出码: 0 = 成功 (含 skipped); 1 = 异常。
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { stockFactorService } from '../data/services/StockFactorService';

const program = new Command();

program
  .name('sync-derived-factors')
  .description('派生因子(估值/质量/资金流)入库 — 默认自动多源并以本地日线兜底')
  .option('--provider <name>', '数据源: eastmoney|baostock|tushare|local_derived|auto', 'auto')
  .option('--scope <scope>', '范围: market|favorites|custom', 'market')
  .option('--symbols <codes>', '逗号分隔股票代码 (自定义股票池)')
  .option('--limit <n>', '全市场落盘上限', '6000')
  .option('--as-of <date>', '因子日期标签 (YYYY-MM-DD), 默认今日')
  .option('--user-id <n>', 'scope=favorites 时的用户 id')
  .option('--skip-if-coverage-gte <pct>', '覆盖率≥阈值则跳过重复落盘')
  .option('--skip-if-real-provider-gte <pct>', '真实源占比≥阈值则跳过')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // schema 变更必须显式授权；普通数据同步不能顺带 alter 整个业务库。
      if (process.env.FACTOR_CLI_SYNC_SCHEMA === 'true') {
        await sequelize.sync({ alter: true });
      }

      const symbols = parseList(opts.symbols);
      const provider = String(opts.provider || 'auto') as any;
      const scope = symbols.length ? 'custom' : (String(opts.scope || 'market') as any);

      const result = await stockFactorService.syncDerivedFactors({
        provider,
        scope,
        symbols: symbols.length ? symbols : undefined,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
        as_of: opts.asOf || undefined,
        user_id: opts.userId ? parseInt(opts.userId, 10) : undefined,
        skip_if_coverage_rate_gte:
          opts.skipIfCoverageGte !== undefined ? Number(opts.skipIfCoverageGte) : undefined,
        skip_if_real_provider_rate_gte:
          opts.skipIfRealProviderGte !== undefined ? Number(opts.skipIfRealProviderGte) : undefined,
      });

      const summary = {
        scenario: 'derived_factor_sync',
        ok: true,
        provider,
        scope,
        skipped: Boolean((result as any).skipped),
        requested_stock_count: Number((result as any).requested_stock_count || 0),
        processed_stock_count: Number((result as any).processed_stock_count || 0),
        upserts: (result as any).upserts || {},
        provider_results: (result as any).provider_results || {},
        duration_ms: Number((result as any).duration_ms || 0),
      };
      const totalUpserts = Object.values(summary.upserts).reduce<number>(
        (sum: number, value: any) => sum + Number(value || 0),
        0
      );
      if (!summary.skipped && summary.requested_stock_count > 0 && totalUpserts <= 0) {
        const providerErrors = Object.entries(summary.provider_results).flatMap(
          ([name, providerResult]: [string, any]) =>
            (providerResult?.errors || []).map((error: unknown) => `${name}: ${String(error)}`)
        );
        throw new Error(
          `因子同步零落盘，拒绝记录假成功${
            providerErrors.length ? `：${providerErrors.slice(0, 5).join(' | ')}` : ''
          }`
        );
      }

      if ((result as any).skipped) {
        logger.info(
          `[sync-derived-factors] SKIPPED — ${(result as any).skip_reason || '覆盖率已达标'}`
        );
      } else {
        const u = (result as any).upserts || {};
        logger.info(
          `[sync-derived-factors] provider=${provider} scope=${scope} ` +
            `requested=${(result as any).requested_stock_count} ` +
            `processed=${(result as any).processed_stock_count} ` +
            `upserts: valuation=${u.valuation || 0} money_flow=${u.money_flow || 0} ` +
            `fundamental=${u.fundamental || 0} duration=${(result as any).duration_ms}ms`
        );
      }
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      process.exit(0);
    } catch (error) {
      logger.error(`sync-derived-factors failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

program.parseAsync(process.argv);
