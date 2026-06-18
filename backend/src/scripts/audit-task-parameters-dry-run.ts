/**
 * audit-task-parameters-dry-run.ts — BETA-5 (2026-06-18, audit M-14)
 *
 * 巡检所有 enabled scheduled_tasks 中 STRATEGY_KILL_SWITCH_CHECK 类型且
 * parameters.dry_run === true 的任务行。
 *
 * 历史背景：Batch N 把 STRATEGY_KILL_SWITCH_CHECK 默认 dry_run 从 true 改成
 * false，但旧的 task_parameters 行可能仍显式 dry_run=true → kill switch 在
 * 该任务永远不真触发。
 *
 * 行为：
 *   1. 不修改任何配置 — 只读
 *   2. 找到符合条件的任务时输出到 stdout + 写一条 RiskAlert MEDIUM 让运维感知
 *   3. 退出码 0 = 巡检完成（找到 0 个或多个匹配项都算成功）
 *   4. 退出码 1 = 巡检本身失败 (DB 异常)
 *
 * 使用：
 *   - 手动: npx ts-node --transpile-only src/scripts/audit-task-parameters-dry-run.ts
 *   - 自动: SchedulerService.initializeScheduler() 在 boot 时调用一次（boot guard）
 */

import { ScheduledTask } from '../models/ScheduledTask';
import { logger } from '../utils/logger';

/** 需要巡检的"应该真跑"的 task type 白名单。未来要扩展只在此 array 加。 */
export const SHOULD_BE_LIVE_TASK_TYPES: ReadonlyArray<string> = ['STRATEGY_KILL_SWITCH_CHECK'];

export interface DryRunAuditMatch {
  task_id: number;
  task_name: string;
  task_type: string;
  cron_expression: string;
  dry_run_value: any;
  is_active: boolean;
}

export interface DryRunAuditResult {
  scanned_tasks: number;
  matches: DryRunAuditMatch[];
  alert_written: boolean;
  alert_id?: number;
  error?: string;
}

/**
 * 单纯函数（纯逻辑，无 DB）：判断单个 task 是否需要 audit。
 * 单测可注入合成 ScheduledTask plain row。
 */
export function shouldFlagDryRunTask(input: {
  type: string;
  is_active: boolean;
  parameters: any;
}): { flagged: boolean; dry_run_value?: any } {
  if (!input.is_active) return { flagged: false };
  if (!SHOULD_BE_LIVE_TASK_TYPES.includes(input.type)) return { flagged: false };
  const params = input.parameters || {};
  // 严格 === true，不算 truthy ('1' / 1 / 'true' 不触发 — 这些都是 ops 显式异
  // 常值,不算 "boot 时默认遗留" 范畴)
  if (params.dry_run === true) {
    return { flagged: true, dry_run_value: params.dry_run };
  }
  return { flagged: false };
}

/**
 * 主入口 — 扫所有 enabled tasks + 给匹配项写一条 RiskAlert MEDIUM。
 * dry_run=true 时不写 RiskAlert，只返回 matches。
 */
export async function auditTaskParametersDryRun(
  options: { dry_run?: boolean; user_id?: number } = {}
): Promise<DryRunAuditResult> {
  try {
    const tasks = await ScheduledTask.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'type', 'cron_expression', 'parameters', 'is_active'],
    });
    const matches: DryRunAuditMatch[] = [];
    for (const task of tasks) {
      const ok = shouldFlagDryRunTask({
        type: (task as any).type,
        is_active: (task as any).is_active,
        parameters: (task as any).parameters,
      });
      if (ok.flagged) {
        matches.push({
          task_id: Number((task as any).id),
          task_name: (task as any).name,
          task_type: (task as any).type,
          cron_expression: (task as any).cron_expression,
          dry_run_value: ok.dry_run_value,
          is_active: (task as any).is_active,
        });
      }
    }

    if (matches.length === 0) {
      logger.info(`[audit-task-parameters-dry-run] scanned=${tasks.length} matches=0`);
      return { scanned_tasks: tasks.length, matches: [], alert_written: false };
    }

    logger.warn(
      `[audit-task-parameters-dry-run] scanned=${tasks.length} matches=${matches.length}: ${matches
        .map(m => `${m.task_id}:${m.task_name}(type=${m.task_type})`)
        .join(', ')}`
    );

    if (options.dry_run) {
      return { scanned_tasks: tasks.length, matches, alert_written: false };
    }

    // 写一条 RiskAlert MEDIUM
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RiskAlert } = require('../models/RiskAlert');
      const alert = await RiskAlert.create({
        user_id: options.user_id || 1,
        symbol: 'SYSTEM:SCHEDULED_TASK_DRY_RUN_AUDIT',
        name: 'scheduled task dry_run 巡检',
        level: 'MEDIUM',
        rule_id: 'task_dry_run_audit',
        message:
          `📋 巡检到 ${matches.length} 个 enabled scheduled_task 显式 dry_run=true: ` +
          matches.map(m => `[${m.task_id}] ${m.task_name} (type=${m.task_type})`).join('; ') +
          '。运维需确认是否仍需 dry_run，或清零回到默认。',
        metadata: { matches },
      });
      return {
        scanned_tasks: tasks.length,
        matches,
        alert_written: true,
        alert_id: Number((alert as any).id),
      };
    } catch (alertErr: any) {
      logger.warn(
        `[audit-task-parameters-dry-run] RiskAlert.create failed: ${alertErr?.message || alertErr}`
      );
      return {
        scanned_tasks: tasks.length,
        matches,
        alert_written: false,
        error: alertErr?.message || String(alertErr),
      };
    }
  } catch (err: any) {
    logger.error(`[audit-task-parameters-dry-run] failed: ${err?.message || err}`);
    return {
      scanned_tasks: 0,
      matches: [],
      alert_written: false,
      error: err?.message || String(err),
    };
  }
}

// CLI: npx ts-node --transpile-only src/scripts/audit-task-parameters-dry-run.ts
if (require.main === module) {
  (async () => {
    const result = await auditTaskParametersDryRun();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.error ? 1 : 0);
  })();
}
