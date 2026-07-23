#!/usr/bin/env node
/**
 * 因子计算 CLI — US-009 因子 pipeline 入口
 *
 * Usage:
 *   npm run compute:factors -- --date=2026-06-05
 *   npm run compute:factors -- --date=2026-06-05 --factors=value,quality,momentum
 *   npm run compute:factors -- --date=2026-06-05 --factors=value --universe=600519,000001
 *   npm run compute:factors -- --date=2026-06-05 --skip=dragontiger
 *
 * 选项：
 *   --date=<YYYY-MM-DD>            目标交易日（缺省 = 全市场 80% 覆盖的最新交易日）
 *   --factors=<a,b,c>              逗号分隔的因子名列表；不传 = 跑注册表全部因子
 *   --skip=<a,b>                   黑名单（即使在 --factors 中也跳过）
 *   --universe=<code1,code2,…>     自定义股票池（无市场前缀，例如 600519,000001）
 *                                  不传 = 全 A 股活跃股
 *   --lookback=<n>                 透传给因子的回看天数（默认 250）
 *
 * 退出码：0 = 全部成功；1 = 有任一因子失败（已写库的因子仍保留）。
 *
 * 备注：US-009 仅落地基础设施。US-010 在 backend/src/quant/factors/library/
 * 添加 8 个具体因子后，本 CLI 会自然跑出实际数据。在因子库为空时，本脚本
 * 仍能运行（输出 factors=0 upserted=0），证明基础设施可用。
 */

import { Command } from 'commander';
import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { factorPipeline } from '../quant/factors';
// import-time 副作用：每个因子文件 register 到 factorRegistry
import '../quant/factors/library';

const program = new Command();

program
  .name('compute-factors')
  .description('按交易日批量计算因子并入库 (factor_scores)')
  .option('--date <date>', '目标交易日 (YYYY-MM-DD)，不得晚于全市场行情水位')
  .option('--factors <names>', '逗号分隔的因子名列表；不传 = 注册表全部')
  .option('--skip <names>', '逗号分隔的因子黑名单')
  .option('--universe <codes>', '逗号分隔的股票代码列表（无市场前缀）；不传 = 全 A 股 active')
  .option('--lookback <n>', '回看天数（默认 250）')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // schema 变更必须显式授权；普通数据命令不能顺带 alter 整个业务库。
      if (process.env.FACTOR_CLI_SYNC_SCHEMA === 'true') {
        await sequelize.sync({ alter: true });
      }

      const marketWatermark = await loadAShareMarketWatermark();
      if (!marketWatermark) {
        throw new Error('全市场行情覆盖不足，无法确定可信的因子交易日');
      }
      const tradeDate = String(opts.date || marketWatermark);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
        throw new Error(`无效因子交易日: ${tradeDate}`);
      }
      if (tradeDate > marketWatermark) {
        throw new Error(
          `拒绝生成假新鲜因子：请求 ${tradeDate}，全市场行情水位仅到 ${marketWatermark}`
        );
      }

      const factorNames = parseList(opts.factors);
      const skipFactors = parseList(opts.skip);
      const universe = parseList(opts.universe);
      const lookbackDays = opts.lookback ? parseInt(opts.lookback, 10) : undefined;

      const result = await factorPipeline.runForDate(tradeDate, factorNames, {
        universe: universe.length ? universe : undefined,
        skipFactors,
        lookbackDays,
      });

      logger.info(
        `[compute-factors] date=${result.trade_date} universe=${result.universe_size} ` +
          `factors=${result.factor_results.length} upserted=${result.total_upserted} ` +
          `failed=${result.total_failed}`
      );
      for (const f of result.factor_results) {
        if (f.skipped) {
          logger.info(`  - ${f.factor_name}: SKIPPED`);
        } else if (f.error) {
          logger.warn(
            `  - ${f.factor_name}: ERROR ${f.error} (fetched=${f.fetched}, effective=${f.effective})`
          );
        } else {
          logger.info(
            `  - ${f.factor_name}: upserted=${f.upserted} (fetched=${f.fetched}, effective=${f.effective})`
          );
        }
      }
      const totalEffective = result.factor_results.reduce(
        (sum, factor) => sum + Number(factor.effective || 0),
        0
      );

      process.stdout.write(
        `${JSON.stringify({
          scenario: 'factor_score_compute',
          ok: result.total_failed === 0 && result.total_upserted > 0 && totalEffective > 0,
          market_watermark: marketWatermark,
          total_effective: totalEffective,
          ...result,
        })}\n`
      );

      process.exit(
        result.total_failed > 0 || result.total_upserted <= 0 || totalEffective <= 0 ? 1 : 0
      );
    } catch (error) {
      logger.error(`compute-factors failed: ${(error as Error).message}`);
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

async function loadAShareMarketWatermark(): Promise<string | null> {
  const [row] = await sequelize.query<{ trade_date: string | Date | null }>(
    `WITH listed AS (
       SELECT COUNT(*)::numeric AS total
         FROM stocks
        WHERE is_listed = TRUE AND type = 'stock'
     ), coverage AS (
       SELECT bar.time::date AS trade_date,
              COUNT(DISTINCT bar.stock_id)::numeric AS covered
         FROM daily_bars bar
         JOIN stocks stock ON stock.id = bar.stock_id
        WHERE stock.is_listed = TRUE
          AND stock.type = 'stock'
          AND bar.time >= CURRENT_DATE - INTERVAL '365 days'
        GROUP BY bar.time::date
     )
     SELECT coverage.trade_date
       FROM coverage CROSS JOIN listed
      WHERE listed.total > 0
        AND coverage.covered >= CEIL(listed.total * 0.80)
      ORDER BY coverage.trade_date DESC
      LIMIT 1`,
    { type: QueryTypes.SELECT }
  );
  if (!row?.trade_date) return null;
  if (typeof row.trade_date === 'string') return row.trade_date.slice(0, 10);
  return row.trade_date.toISOString().slice(0, 10);
}

program.parseAsync(process.argv);
