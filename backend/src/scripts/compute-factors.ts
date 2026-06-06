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
 *   --date=<YYYY-MM-DD>            目标交易日（必填）
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
  .requiredOption('--date <date>', '目标交易日 (YYYY-MM-DD)')
  .option('--factors <names>', '逗号分隔的因子名列表；不传 = 注册表全部')
  .option('--skip <names>', '逗号分隔的因子黑名单')
  .option('--universe <codes>', '逗号分隔的股票代码列表（无市场前缀）；不传 = 全 A 股 active')
  .option('--lookback <n>', '回看天数（默认 250）')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      // 开发模式自动建表/alter；生产应改走 migration
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const factorNames = parseList(opts.factors);
      const skipFactors = parseList(opts.skip);
      const universe = parseList(opts.universe);
      const lookbackDays = opts.lookback ? parseInt(opts.lookback, 10) : undefined;

      const result = await factorPipeline.runForDate(opts.date, factorNames, {
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

      process.exit(result.total_failed > 0 ? 1 : 0);
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

program.parseAsync(process.argv);
