#!/usr/bin/env node
/**
 * 因子相关性矩阵 CLI — US-042
 *
 * Usage:
 *   # 全注册表因子两两相关，默认窗口
 *   npm run compute:factor-correlation -- --start=2024-01-01 --end=2026-06-05
 *
 *   # 指定一批因子
 *   npm run compute:factor-correlation -- --factors=value,quality,momentum --start=2024-01-01 --end=2026-06-05
 *
 *   # 自定义共线性阈值（AC 默认 0.7）
 *   npm run compute:factor-correlation -- --start=2024-01-01 --end=2026-06-05 --threshold=0.8
 *
 *   # 把 redundant pair 写入所有 admin 用户的 RiskAlert
 *   npm run compute:factor-correlation -- --start=2024-01-01 --end=2026-06-05 --alert-admin
 *
 *   # dry-run 不写库
 *   npm run compute:factor-correlation -- --start=2024-01-01 --end=2026-06-05 --no-persist
 *
 *   # 查询历史：列出最近 30 条相关性结果
 *   npm run compute:factor-correlation -- --list
 *
 *   # 列出当前所有 redundant pair
 *   npm run compute:factor-correlation -- --list-redundant
 *
 *   # 查看某因子参与的全部 pair
 *   npm run compute:factor-correlation -- --show=value
 *
 *   # 清理 N 天前的相关性结果
 *   npm run compute:factor-correlation -- --cleanup-days=30
 *
 * 选项：
 *   --factors=<csv>           因子名列表（逗号分隔；不传 = 注册表全部）
 *   --start=<YYYY-MM-DD>      聚合区间起始（除 admin 模式必填）
 *   --end=<YYYY-MM-DD>        聚合区间结束（除 admin 模式必填）
 *   --threshold=<f>           共线性阈值（默认 0.7）
 *   --alert-admin             把 redundant pair 写入所有 admin user 的 RiskAlert
 *   --no-persist              dry-run 不写库
 *   --list                    列出最近 30 条相关性结果
 *   --list-redundant          列出当前所有 redundant pair
 *   --show=<factor_name>      展示某因子参与的全部 pair
 *   --cleanup-days=<n>        删除 N 天前的相关性结果
 *
 * 退出码：
 *   0 = 成功
 *   1 = 部分失败但有结果
 *   2 = 严重错误（参数无效 / DB 失败 / 因子未注册）
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { factorCorrelationReport, factorRegistry } from '../quant/factors';
// import-time 副作用：每个因子文件 register 到 factorRegistry
import '../quant/factors/library';
import { User } from '../models/User';

const program = new Command();

program
  .name('compute-factor-correlation')
  .description('US-042 因子两两相关性矩阵与共线性诊断')
  .option('--factors <csv>', '因子名列表（逗号分隔；不传 = 注册表全部）')
  .option('--start <date>', '聚合区间起始 (YYYY-MM-DD)')
  .option('--end <date>', '聚合区间结束 (YYYY-MM-DD)')
  .option('--threshold <f>', '共线性阈值（默认 0.7）')
  .option('--alert-admin', '把 redundant pair 写入所有 admin user 的 RiskAlert')
  .option('--no-persist', 'dry-run 不写库')
  .option('--list', '列出最近 30 条相关性结果')
  .option('--list-redundant', '列出当前所有 redundant pair')
  .option('--show <factor_name>', '展示某因子参与的全部 pair')
  .option('--cleanup-days <n>', '删除 N 天前的相关性结果')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      // ===== admin: --list =====
      if (opts.list) {
        const rows = await factorCorrelationReport.getResults({ limit: 30 });
        if (!rows.length) {
          logger.info('[factor-corr] 没有找到任何相关性结果');
        } else {
          logger.info(`[factor-corr] 最近 ${rows.length} 条相关性结果:`);
          for (const r of rows) {
            const corrStr = r.correlation === null ? 'NaN' : Number(r.correlation).toFixed(4);
            const flag = r.is_redundant ? ' [REDUNDANT]' : '';
            logger.info(
              `  ${r.factor_a} vs ${r.factor_b} ` +
                `[${r.period_start}..${r.period_end}] ` +
                `corr=${corrStr}${flag} ` +
                `n=${r.sample_count} avg_univ=${r.universe_avg_size} ` +
                `at=${r.computed_at.toISOString()}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --list-redundant =====
      if (opts.listRedundant) {
        const rows = await factorCorrelationReport.getResults({
          is_redundant: true,
          limit: 200,
        });
        if (!rows.length) {
          logger.info('[factor-corr] 当前没有 redundant pair（|corr| > 0.7）');
        } else {
          logger.info(`[factor-corr] 当前 ${rows.length} 个 redundant pair:`);
          for (const r of rows) {
            const corrStr = r.correlation === null ? 'NaN' : Number(r.correlation).toFixed(4);
            logger.info(
              `  ${r.factor_a} vs ${r.factor_b} ` +
                `[${r.period_start}..${r.period_end}] corr=${corrStr} ` +
                `n=${r.sample_count} at=${r.computed_at.toISOString()}`
            );
          }
        }
        process.exit(0);
      }

      // ===== admin: --show =====
      if (opts.show) {
        const rows = await factorCorrelationReport.getResults({ factor_name: opts.show });
        if (!rows.length) {
          logger.info(`[factor-corr] 因子 "${opts.show}" 没有相关性结果`);
          process.exit(0);
        }
        // 按 |corr| 降序排（高相关在前）
        rows.sort((a, b) => {
          const ca = a.correlation === null ? 0 : Math.abs(Number(a.correlation));
          const cb = b.correlation === null ? 0 : Math.abs(Number(b.correlation));
          return cb - ca;
        });
        logger.info(`[factor-corr] 因子 "${opts.show}" 参与的 ${rows.length} 对相关:`);
        for (const r of rows) {
          const corrStr = r.correlation === null ? 'NaN' : Number(r.correlation).toFixed(4);
          const other = r.factor_a === opts.show ? r.factor_b : r.factor_a;
          const flag = r.is_redundant ? ' [REDUNDANT]' : '';
          logger.info(
            `  vs ${other} [${r.period_start}..${r.period_end}] ` +
              `corr=${corrStr}${flag} n=${r.sample_count}`
          );
        }
        process.exit(0);
      }

      // ===== admin: --cleanup-days =====
      if (opts.cleanupDays) {
        const days = parseInt(opts.cleanupDays, 10);
        if (!Number.isFinite(days) || days < 1) {
          logger.error(`[factor-corr] --cleanup-days 必须 >= 1, 收到 '${opts.cleanupDays}'`);
          process.exit(2);
        }
        const deleted = await factorCorrelationReport.cleanupOlderThan(days);
        logger.info(`[factor-corr] 清理 ${days} 天前: 删除 ${deleted} 行`);
        process.exit(0);
      }

      // ===== 主流程 generate =====
      if (!opts.start || !opts.end) {
        logger.error('[factor-corr] --start 与 --end 必填（除 admin 模式）');
        process.exit(2);
      }

      // 解析 factor list
      let factorNames: string[];
      if (opts.factors) {
        factorNames = parseList(opts.factors);
      } else {
        factorNames = factorRegistry.listNames();
        if (!factorNames.length) {
          logger.error(
            '[factor-corr] FactorRegistry 为空，无法运行（请先确认 library 已被 import）'
          );
          process.exit(2);
        }
        logger.info(`[factor-corr] 跑注册表全部 ${factorNames.length} 个因子的两两相关`);
      }

      if (factorNames.length < 2) {
        logger.error('[factor-corr] 至少需要 2 个因子才能算两两相关，收到 1 个');
        process.exit(2);
      }

      // 校验因子在 registry
      for (const name of factorNames) {
        if (!factorRegistry.has(name)) {
          logger.error(
            `[factor-corr] 因子 "${name}" 未注册. ` +
              `Known: ${factorRegistry.listNames().join(', ')}`
          );
          process.exit(2);
        }
      }

      // 解析 threshold
      let threshold: number | undefined;
      if (opts.threshold) {
        const parsed = parseFloat(opts.threshold);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          logger.error(`[factor-corr] --threshold 必须在 [0, 1] 区间，收到 '${opts.threshold}'`);
          process.exit(2);
        }
        threshold = parsed;
      }

      // 解析 alert-admin
      let alertUserIds: number[] = [];
      if (opts.alertAdmin) {
        const admins = (await User.findAll({
          where: { role: 'admin' },
          attributes: ['id'],
          raw: true,
        })) as unknown as Array<{ id: number }>;
        alertUserIds = admins.map(a => a.id).filter(Boolean);
        logger.info(
          `[factor-corr] --alert-admin 启用，将向 ${alertUserIds.length} 个 admin 用户发告警`
        );
        if (!alertUserIds.length) {
          logger.warn(
            '[factor-corr] 没有找到 role=admin 的用户，redundant pair 仍会标记但不发告警'
          );
        }
      }

      const persist = opts.persist !== false;
      const t0 = Date.now();

      try {
        const out = await factorCorrelationReport.generate(
          {
            factor_names: factorNames,
            start_date: opts.start,
            end_date: opts.end,
          },
          {
            persist,
            redundancy_threshold: threshold,
            alert_user_ids: alertUserIds,
          }
        );

        const redundantPairs = out.pair_results.filter(p => p.is_redundant);
        logger.info(
          `[factor-corr] all done in ${out.duration_ms}ms, ` +
            `pairs=${out.pair_results.length} redundant=${redundantPairs.length} ` +
            `upserted=${out.upserted_count} alerts=${out.alert_count}`
        );

        // 显示每个 pair 的统计
        for (const p of out.pair_results) {
          const s = p.statistics;
          const meanStr = s.correlation_mean === null ? 'NaN' : s.correlation_mean.toFixed(4);
          const stdStr = s.correlation_std === null ? 'NaN' : s.correlation_std.toFixed(4);
          const flag = p.is_redundant ? ' [REDUNDANT]' : '';
          logger.info(
            `  ${p.factor_a} vs ${p.factor_b} ` +
              `[${p.period_start}..${p.period_end}] ` +
              `mean=${meanStr} std=${stdStr}${flag} ` +
              `n=${s.sample_count} avg_univ=${s.universe_avg_size}`
          );
        }

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        logger.info(`[factor-corr] total CLI time ${elapsed}s`);

        // 退出码：有结果就 0；无结果（pair_results 全 sample_count=0）→ 1
        if (out.pair_results.some(p => p.statistics.sample_count > 0)) {
          process.exit(0);
        }
        logger.warn(`[factor-corr] 所有 pair 都 sample_count=0（可能 factor_scores 表为空）`);
        process.exit(1);
      } catch (error) {
        logger.error(`[factor-corr] generate FAILED: ${(error as Error).message}`);
        process.exit(2);
      }
    } catch (error) {
      logger.error(`[factor-corr] FATAL: ${(error as Error).message}`);
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
