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

export const HISTORICAL_PIT_REPLAY_SOURCE = 'historical_pit_replay@1.0.0';
export const HISTORICAL_PIT_FACTORS = [
  'quality',
  'growth',
  'value',
  'momentum',
  'gradual_breakout',
  'low_vol',
] as const;

program
  .name('compute-factors')
  .description('按交易日批量计算因子并入库 (factor_scores)')
  .option('--date <date>', '目标交易日 (YYYY-MM-DD)，不得晚于全市场行情水位')
  .option('--factors <names>', '逗号分隔的因子名列表；不传 = 注册表全部')
  .option('--skip <names>', '逗号分隔的因子黑名单')
  .option('--universe <codes>', '逗号分隔的股票代码列表（无市场前缀）；不传 = 全 A 股 active')
  .option('--lookback <n>', '回看天数（默认 250）')
  .option(
    '--historical-pit-replay',
    '按历史上市范围重建六维 PIT 截面，并保留实际入库时间与历史信息截止时刻'
  )
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
      let universe = parseList(opts.universe);
      const lookbackDays = opts.lookback ? parseInt(opts.lookback, 10) : undefined;
      const historicalPitReplay = opts.historicalPitReplay === true;

      if (historicalPitReplay) {
        if (universe.length > 0 || skipFactors.length > 0) {
          throw new Error('历史 PIT 重放不允许自定义 universe 或 skip，避免产生不完整截面');
        }
        const requested = new Set(factorNames);
        if (
          requested.size !== HISTORICAL_PIT_FACTORS.length ||
          HISTORICAL_PIT_FACTORS.some(name => !requested.has(name))
        ) {
          throw new Error(`历史 PIT 重放必须完整计算: ${HISTORICAL_PIT_FACTORS.join(',')}`);
        }
        universe = await loadHistoricalUniverse(tradeDate);
      }

      const result = await factorPipeline.runForDate(tradeDate, factorNames, {
        universe: universe.length ? universe : undefined,
        skipFactors,
        lookbackDays,
        source: historicalPitReplay ? HISTORICAL_PIT_REPLAY_SOURCE : 'pipeline',
        pit_replay_as_of_utc: historicalPitReplay ? new Date(`${tradeDate}T07:05:00.000Z`) : null,
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

      const minimumHistoricalCoverage = Math.max(500, Math.ceil(result.universe_size * 0.2));
      const incompleteHistoricalFactors = historicalPitReplay
        ? result.factor_results
            .filter(
              factor =>
                factor.error || factor.skipped || factor.effective < minimumHistoricalCoverage
            )
            .map(factor => factor.factor_name)
        : [];
      const ok =
        result.total_failed === 0 &&
        result.total_upserted > 0 &&
        totalEffective > 0 &&
        incompleteHistoricalFactors.length === 0;

      process.stdout.write(
        `${JSON.stringify({
          scenario: historicalPitReplay ? 'historical_pit_factor_replay' : 'factor_score_compute',
          ok,
          market_watermark: marketWatermark,
          total_effective: totalEffective,
          ...(historicalPitReplay
            ? {
                source: HISTORICAL_PIT_REPLAY_SOURCE,
                pit_replay_as_of_utc: `${tradeDate}T07:05:00.000Z`,
                minimum_effective_per_factor: minimumHistoricalCoverage,
                incomplete_factors: incompleteHistoricalFactors,
              }
            : {}),
          ...result,
        })}\n`
      );

      process.exit(ok ? 0 : 1);
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

async function loadHistoricalUniverse(asOfDate: string): Promise<string[]> {
  const rows = await sequelize.query<{ stock_code: string }>(
    `SELECT DISTINCT RIGHT(symbol, 6) AS stock_code
       FROM stocks
      WHERE type = 'stock'
        AND listing_date IS NOT NULL
        AND listing_date <= :as_of_date
        AND (delisting_date IS NULL OR delisting_date > :as_of_date)
        AND RIGHT(symbol, 6) ~ '^[0-9]{6}$'
      ORDER BY stock_code`,
    { replacements: { as_of_date: asOfDate }, type: QueryTypes.SELECT }
  );
  if (rows.length < 500) {
    throw new Error(`历史 PIT 股票范围异常: ${asOfDate} 仅 ${rows.length} 只`);
  }
  return rows.map(row => row.stock_code);
}

program.parseAsync(process.argv);
