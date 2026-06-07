#!/usr/bin/env node
/**
 * 因子 IC 报告 CLI — US-041 IC 衰减分析入口
 *
 * Usage:
 *   # 单因子，多窗口（AC 默认 1/5/10/20/60）
 *   npm run compute:factor-ic -- --factor=value --start=2024-01-01 --end=2026-06-05
 *
 *   # 单因子，自定义窗口
 *   npm run compute:factor-ic -- --factor=quality --start=2025-01-01 --end=2026-06-05 --windows=1,5,20
 *
 *   # 多因子（逗号分隔），跑所有 5 个窗口
 *   npm run compute:factor-ic -- --factors=value,quality,momentum --start=2024-01-01 --end=2026-06-05
 *
 *   # 全部因子（不传 --factor/--factors）
 *   npm run compute:factor-ic -- --start=2024-01-01 --end=2026-06-05
 *
 *   # dry-run 不写库
 *   npm run compute:factor-ic -- --factor=value --start=2024-01-01 --end=2026-06-05 --no-persist
 *
 *   # 查询历史：列出最近 30 条 IC 结果
 *   npm run compute:factor-ic -- --list
 *
 *   # 查看某因子全部窗口对比
 *   npm run compute:factor-ic -- --show=value
 *
 *   # 清理 N 天前的 IC 结果
 *   npm run compute:factor-ic -- --cleanup-days=30
 *
 * 选项：
 *   --factor=<name>           单因子（与 --factors 互斥）
 *   --factors=<csv>           多因子逗号分隔（与 --factor 互斥）
 *   --start=<YYYY-MM-DD>      聚合区间起始（除 admin 模式必填）
 *   --end=<YYYY-MM-DD>        聚合区间结束（除 admin 模式必填）
 *   --windows=<csv>           lookForward 列表（默认 AC 指定 1,5,10,20,60）
 *   --universe=<csv>          限定股票池（无市场前缀，逗号分隔）
 *   --no-persist              dry-run 不写库
 *   --list                    列出最近 30 条 IC 结果
 *   --show=<factor_name>      展示某因子全部窗口对比
 *   --cleanup-days=<n>        删除 N 天前的 IC 结果
 *
 * 退出码：
 *   0 = 成功
 *   1 = 部分因子失败但有结果
 *   2 = 严重错误（参数无效 / DB 失败 / 因子未注册）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { factorICReport, factorRegistry } from '../quant/factors';
// import-time 副作用：每个因子文件 register 到 factorRegistry
import '../quant/factors/library';

const program = new Command();

program
  .name('compute-factor-ic')
  .description('US-041 因子 IC 报告与 IC 衰减分析')
  .option('--factor <name>', '单因子名（与 --factors 互斥）')
  .option('--factors <csv>', '多因子名逗号分隔（与 --factor 互斥；不传 = 注册表全部）')
  .option('--start <date>', '聚合区间起始 (YYYY-MM-DD)')
  .option('--end <date>', '聚合区间结束 (YYYY-MM-DD)')
  .option('--windows <csv>', 'lookForward 列表（默认 1,5,10,20,60）')
  .option('--universe <codes>', '限定股票池（无市场前缀逗号分隔）')
  .option('--no-persist', 'dry-run 不写库')
  .option('--list', '列出最近 30 条 IC 结果')
  .option('--show <factor_name>', '展示某因子全部 lookForward 窗口对比')
  .option('--cleanup-days <n>', '删除 N 天前的 IC 结果')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // ===== admin: --list =====
      if (opts.list) {
        const rows = await factorICReport.getResults({ limit: 30 });
        if (!rows.length) {
          logger.info('[factor-ic] 没有找到任何 IC 结果');
        } else {
          logger.info(`[factor-ic] 最近 ${rows.length} 条 IC 结果:`);
          for (const r of rows) {
            const meanStr = r.ic_mean === null ? 'NaN' : Number(r.ic_mean).toFixed(4);
            const irStr = r.ic_ir === null ? 'NaN' : Number(r.ic_ir).toFixed(4);
            const posStr =
              r.ic_positive_ratio === null
                ? 'NaN'
                : (Number(r.ic_positive_ratio) * 100).toFixed(1) + '%';
            logger.info(
              `  ${r.factor_name} lf=${r.look_forward_days}d ` +
                `[${r.period_start}..${r.period_end}] ` +
                `mean=${meanStr} ir=${irStr} pos=${posStr} ` +
                `n=${r.sample_count} avg_univ=${r.universe_avg_size} ` +
                `at=${r.computed_at.toISOString()}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --show =====
      if (opts.show) {
        const rows = await factorICReport.getResults({ factor_name: opts.show });
        if (!rows.length) {
          logger.info(`[factor-ic] 因子 "${opts.show}" 没有 IC 结果`);
          process.exit(0);
        }
        // 按 lookForward 排序方便看衰减
        rows.sort((a, b) => {
          if (a.period_end !== b.period_end) {
            return a.period_end > b.period_end ? -1 : 1;
          }
          return a.look_forward_days - b.look_forward_days;
        });
        logger.info(`[factor-ic] 因子 "${opts.show}" 共 ${rows.length} 条 IC 结果:`);
        for (const r of rows) {
          const meanStr = r.ic_mean === null ? 'NaN' : Number(r.ic_mean).toFixed(4);
          const stdStr = r.ic_std === null ? 'NaN' : Number(r.ic_std).toFixed(4);
          const irStr = r.ic_ir === null ? 'NaN' : Number(r.ic_ir).toFixed(4);
          const posStr =
            r.ic_positive_ratio === null
              ? 'NaN'
              : (Number(r.ic_positive_ratio) * 100).toFixed(1) + '%';
          logger.info(
            `  lf=${r.look_forward_days}d [${r.period_start}..${r.period_end}] ` +
              `mean=${meanStr} std=${stdStr} ir=${irStr} pos=${posStr} ` +
              `n=${r.sample_count} avg_univ=${r.universe_avg_size}`
          );
        }
        process.exit(0);
      }

      // ===== admin: --cleanup-days =====
      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(`[factor-ic] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`);
          process.exit(2);
        }
        const deleted = await factorICReport.cleanupOlderThan(days);
        logger.info(`[factor-ic] 清理 ${days} 天前: 删除 ${deleted} 行`);
        process.exit(0);
      }

      // ===== 主流程 generate =====
      if (!opts.start || !opts.end) {
        logger.error('[factor-ic] --start 与 --end 必填（除 admin 模式）');
        process.exit(2);
      }

      // 解析 factor list
      let factorNames: string[];
      if (opts.factor && opts.factors) {
        logger.error('[factor-ic] --factor 与 --factors 互斥，请只用一个');
        process.exit(2);
      }
      if (opts.factor) {
        factorNames = [opts.factor];
      } else if (opts.factors) {
        factorNames = parseList(opts.factors);
      } else {
        // 不传 = 注册表全部
        factorNames = factorRegistry.listNames();
        if (!factorNames.length) {
          logger.error('[factor-ic] FactorRegistry 为空，无法运行（请先确认 library 已被 import）');
          process.exit(2);
        }
        logger.info(`[factor-ic] 跑注册表全部 ${factorNames.length} 个因子`);
      }

      // 校验因子在 registry
      for (const name of factorNames) {
        if (!factorRegistry.has(name)) {
          logger.error(
            `[factor-ic] 因子 "${name}" 未注册. ` +
              `Known: ${factorRegistry.listNames().join(', ')}`
          );
          process.exit(2);
        }
      }

      // 解析 windows
      let lookForwardList: number[] | undefined;
      if (opts.windows) {
        const parsed = parseList(opts.windows)
          .map(s => parseInt(s, 10))
          .filter(n => Number.isInteger(n) && n >= 1);
        if (!parsed.length) {
          logger.error(`[factor-ic] --windows 解析失败: '${opts.windows}'`);
          process.exit(2);
        }
        lookForwardList = parsed;
      }

      // 解析 universe
      const universe = parseList(opts.universe);

      const persist = opts.persist !== false;
      let totalSucceeded = 0;
      let totalFailed = 0;
      let totalUpserted = 0;
      const t0 = Date.now();

      for (const name of factorNames) {
        try {
          const out = await factorICReport.generate(
            {
              factor_name: name,
              start_date: opts.start,
              end_date: opts.end,
              look_forward_days_list: lookForwardList,
              universe: universe.length ? universe : undefined,
            },
            { persist }
          );
          totalSucceeded += 1;
          totalUpserted += out.upserted_count;

          logger.info(
            `[factor-ic] ${name} done in ${out.duration_ms}ms, ` +
              `windows=${out.results_by_window.length} upserted=${out.upserted_count}`
          );
          for (const w of out.results_by_window) {
            const s = w.statistics;
            const meanStr = s.ic_mean === null ? 'NaN' : s.ic_mean.toFixed(4);
            const stdStr = s.ic_std === null ? 'NaN' : s.ic_std.toFixed(4);
            const irStr = s.ic_ir === null ? 'NaN' : s.ic_ir.toFixed(4);
            const posStr =
              s.ic_positive_ratio === null ? 'NaN' : (s.ic_positive_ratio * 100).toFixed(1) + '%';
            logger.info(
              `  lf=${w.look_forward_days}d [${w.period_start}..${w.period_end}] ` +
                `mean=${meanStr} std=${stdStr} ir=${irStr} pos=${posStr} ` +
                `n=${s.sample_count} avg_univ=${s.universe_avg_size}`
            );
          }
        } catch (error) {
          totalFailed += 1;
          logger.error(`[factor-ic] ${name} FAILED: ${(error as Error).message}`);
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      logger.info(
        `[factor-ic] all done in ${elapsed}s, factors=${factorNames.length} ` +
          `succeeded=${totalSucceeded} failed=${totalFailed} upserted=${totalUpserted}`
      );

      // 退出码：全成功 0；有部分失败但有结果 1；全失败 2
      if (totalFailed === 0) process.exit(0);
      if (totalSucceeded > 0) process.exit(1);
      process.exit(2);
    } catch (error) {
      logger.error(`[factor-ic] FATAL: ${(error as Error).message}`);
      process.exit(2);
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
