#!/usr/bin/env node
/**
 * 旧数据清理 CLI (US-097)
 *
 * Usage:
 *   # dry-run (默认) — 只打印将清理的条数, 不删
 *   npm run cleanup:old-data
 *
 *   # 真正执行 — 必须显式 --confirm
 *   npm run cleanup:old-data -- --confirm
 *
 *   # 自定义阈值 + 白名单
 *   npm run cleanup:old-data -- \
 *     --backtest-days=60 \
 *     --log-days=90 \
 *     --alert-days=14 \
 *     --whitelist-strategy=multi_factor_alpha \
 *     --whitelist-strategy=dragon_head \
 *     --confirm
 *
 * 选项:
 *   --backtest-days=<N>            回测保留天数 (默认 90)
 *   --log-days=<N>                 日志保留天数 (默认 180, 同时管 data_update_logs +
 *                                  task_execution_logs)
 *   --alert-days=<N>               已读告警保留天数 (默认 30)
 *   --whitelist-strategy=<key>     白名单策略 key (可重复; 若 backtest task 的
 *                                  strategy_keys 与白名单交集非空 → 跳过该 task)
 *   --confirm                      真正执行 DELETE; 不传 = dry-run
 *
 * 数据规模 / 调度:
 *   - 默认调度: scheduler 每周日凌晨 3 点 (cron '0 3 * * 0'), 见
 *     SchedulerService.CLEANUP_OLD_DATA. CLI 是手动 ops 入口.
 *   - 阻塞规模: 估算 100 万行/年 (15+ daily scheduled task × 200+ trading days
 *     × N backtest jobs). 默认阈值清完 ~70% 旧数据.
 *
 * 安全:
 *   - **默认 dry-run** (与 US-086 RebalanceEngine 同款); 必须 `--confirm`
 *     才删. 防止手动误触 (如 `npm run cleanup:old-data` 不带任何 flag
 *     的本能调用导致大批量 DELETE).
 *   - **失败隔离**: 单 target 失败不阻塞其他 target (DB 锁 / FK 异常 / 临时
 *     连接问题), 最后 exit code 反映"是否有任一 target 失败".
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { CleanupOldDataService } from '../services/CleanupOldDataService';

const program = new Command();

function collectWhitelist(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .name('cleanup-old-data')
  .description('清理旧回测 / 旧日志 / 旧告警 (US-097). 默认 dry-run; 必须 --confirm 才真正 DELETE.')
  .option('--backtest-days <days>', '回测保留天数 (默认 90)', '90')
  .option('--log-days <days>', '日志保留天数 (默认 180)', '180')
  .option('--alert-days <days>', '已读告警保留天数 (默认 30)', '30')
  .option(
    '--whitelist-strategy <key>',
    '白名单策略 key (可重复); strategy_keys 与白名单交集非空的 backtest task 跳过',
    collectWhitelist,
    [] as string[]
  )
  .option('--confirm', '真正执行 DELETE; 不传 = dry-run', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();

      const dryRun = !opts.confirm;
      const service = new CleanupOldDataService();
      const result = await service.cleanup({
        backtestRetentionDays: opts.backtestDays,
        logRetentionDays: opts.logDays,
        alertRetentionDays: opts.alertDays,
        whitelistStrategies: opts.whitelistStrategy,
        dryRun,
      });

      // 打印总览
      console.log('');
      console.log(`╔═══════════════════════════════════════════════════════════╗`);
      console.log(`║  cleanup-old-data — ${result.mode.padEnd(38)}║`);
      console.log(`╚═══════════════════════════════════════════════════════════╝`);
      console.log(`as_of=${result.as_of}`);
      console.log('');

      // 打印每个 target
      for (const t of result.targets) {
        const status = t.error ? '❌' : t.executed ? '✓' : '·';
        const cascadeStr = t.cascade_count > 0 ? ` (cascade=${t.cascade_count})` : '';
        const whitelistStr =
          t.whitelist_skipped > 0 ? ` (whitelist_skipped=${t.whitelist_skipped})` : '';
        console.log(
          `  ${status} ${t.target.padEnd(28)} cutoff=${t.cutoff}  count=${
            t.count
          }${cascadeStr}${whitelistStr}`
        );
        if (t.error) {
          console.log(`      error: ${t.error}`);
        }
      }

      console.log('');
      console.log(`总计 主表 ${result.total_count} 行 + cascade ${result.total_cascade_count} 行`);
      if (result.whitelist_skipped_total > 0) {
        console.log(`白名单豁免: ${result.whitelist_skipped_total} 个 task`);
      }
      console.log('');

      if (dryRun) {
        console.log('⚠️  这是 dry-run, 没有真正 DELETE. 要执行请加 --confirm.');
      } else {
        console.log('✓  已执行清理.');
      }

      if (result.errors.length > 0) {
        console.error(`\n❌ ${result.errors.length} 个 target 失败:`);
        for (const e of result.errors) console.error(`   - ${e}`);
        process.exit(2);
      }

      process.exit(0);
    } catch (error) {
      logger.error(`cleanup-old-data failed: ${(error as Error).message}`);
      console.error(`fatal: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
