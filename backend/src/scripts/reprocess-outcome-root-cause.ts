/**
 * reprocess-outcome-root-cause — 历史 outcome 的 root_cause 回填脚本
 *
 * 背景: Phase 5 接入只让**新写入** outcome 自动填 root_cause；历史已存的几千行
 *      outcome 行 root_cause 还是 NULL。本脚本扫描这些行，用同一个
 *      classifyTradeRootCause() 回填，让聚合仪表盘有完整数据。
 *
 * 用法:
 *   cd backend
 *   npm run script:reprocess-root-cause -- --dry-run        # 预览，不写库
 *   npm run script:reprocess-root-cause -- --batch=500       # 真跑，每批 500 行
 *   npm run script:reprocess-root-cause -- --portfolio-id=N  # 仅某个组合
 *   npm run script:reprocess-root-cause -- --since=2025-01-01 # 仅 >= 该日期
 *   npm run script:reprocess-root-cause -- --include-existing # 覆盖已有 root_cause
 *
 * 退出码: 0=success / 1=部分失败 / 2=hard error
 */

import { Command } from 'commander';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import {
  classifyTradeRootCause,
  TradeRootCauseInput,
} from '../services/TradeRootCauseClassifier';

const program = new Command();
program
  .name('reprocess-outcome-root-cause')
  .description('Phase 5 历史 outcome root_cause 回填脚本')
  .option('--dry-run', '预览，不写库')
  .option('--batch <n>', '每批处理多少行 (默认 500)', '500')
  .option('--portfolio-id <n>', '仅处理某个 portfolio')
  .option('--since <date>', '仅处理 entry_date >= 此日期 (YYYY-MM-DD)')
  .option('--include-existing', '覆盖已有 root_cause (默认仅填 NULL)')
  .action(async opts => {
    try {
      await sequelize.authenticate();
      logger.info('[reprocess-root-cause] DB connected');

      const batch = Math.min(Math.max(parseInt(opts.batch || '500', 10), 1), 5000);
      const dryRun = Boolean(opts.dryRun);

      // 构造 where
      const where: Record<string, any> = {};
      if (!opts.includeExisting) {
        where.root_cause = { [Op.is]: null };
      }
      if (opts.portfolioId) {
        const pid = parseInt(opts.portfolioId, 10);
        if (Number.isFinite(pid)) where.portfolio_id = pid;
      }
      if (opts.since) {
        where.entry_date = { [Op.gte]: String(opts.since) };
      }

      const total = await RecommendationTradeOutcome.count({ where });
      logger.info(
        `[reprocess-root-cause] 候选 outcome 行数: ${total} ` +
          `(dryRun=${dryRun}, batch=${batch}, include_existing=${Boolean(opts.includeExisting)})`
      );

      if (total === 0) {
        logger.info('[reprocess-root-cause] 没有可处理的行，退出');
        process.exit(0);
      }

      let processed = 0;
      let updated = 0;
      let failed = 0;
      const byRootCause: Record<string, number> = {};

      while (processed < total) {
        const rows = await RecommendationTradeOutcome.findAll({
          where,
          order: [['id', 'ASC']],
          limit: batch,
          offset: processed,
        });
        if (rows.length === 0) break;

        for (const row of rows) {
          try {
            const metadata = (row.metadata as any) || {};
            const signalMetadata = (metadata.signal_metadata as any) || {};

            const totalPnlPct = Number(
              (row as any).total_pnl_pct ?? row.realized_pnl_pct ?? 0
            );

            const input: TradeRootCauseInput = {
              return_pct: totalPnlPct,
              holding_days: Number(row.holding_days || 0),
              exit_reason: row.exit_reason || null,
              entry_price: Number((row as any).entry_price) || undefined,
              exit_price: Number((row as any).exit_price) || undefined,
              market_regime_at_entry:
                (signalMetadata.market_environment as any)?.market_regime ||
                (metadata.market_environment as any)?.market_regime ||
                null,
              market_regime_at_exit:
                (metadata.exit_market_environment as any)?.market_regime ||
                (signalMetadata.market_environment as any)?.market_regime ||
                (metadata.market_environment as any)?.market_regime ||
                null,
              signal_catalyst:
                (metadata.signal_catalyst as string) ||
                (row.source_type as string) ||
                null,
              max_drawdown_during_hold_pct:
                Math.abs(Number(row.max_adverse_excursion_pct || 0)) || undefined,
            };

            const result = classifyTradeRootCause(input);
            byRootCause[result.root_cause] = (byRootCause[result.root_cause] || 0) + 1;

            if (!dryRun) {
              await row.update({
                root_cause: result.root_cause,
                root_cause_label: result.root_cause_label,
                root_cause_confidence: result.confidence,
                metadata: {
                  ...metadata,
                  root_cause_diagnostics: {
                    matched_rule: result.matched_rule,
                    input_snapshot: input,
                    reprocessed_at: new Date().toISOString(),
                  },
                },
              });
            }
            updated++;
          } catch (err: any) {
            failed++;
            logger.warn(
              `[reprocess-root-cause] FAIL row#${row.id}: ${err?.message || err}`
            );
          }
        }

        processed += rows.length;
        if (processed % (batch * 4) === 0 || processed >= total) {
          logger.info(
            `[reprocess-root-cause] 进度 ${processed}/${total} (${(
              (processed / total) *
              100
            ).toFixed(1)}%) updated=${updated} failed=${failed}`
          );
        }
      }

      logger.info(
        `[reprocess-root-cause] done: processed=${processed} updated=${updated} ` +
          `failed=${failed} dry_run=${dryRun}`
      );
      logger.info(`[reprocess-root-cause] 按 root_cause 分布:`);
      const sortedCauses = Object.entries(byRootCause).sort((a, b) => b[1] - a[1]);
      for (const [cause, count] of sortedCauses) {
        const pct = ((count / processed) * 100).toFixed(1);
        logger.info(`  ${cause.padEnd(20)} ${count.toString().padStart(6)} (${pct}%)`);
      }

      process.exit(failed > 0 ? 1 : 0);
    } catch (error: any) {
      logger.error(`[reprocess-root-cause] FATAL: ${error?.message || error}`);
      process.exit(2);
    }
  });

program.parseAsync(process.argv);
