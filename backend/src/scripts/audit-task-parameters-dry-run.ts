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
 *   2. 找到符合条件的任务时：
 *      a. 输出到 stdout（CLI mode）+ logger.warn
 *      b. 写一条 RiskAlert MEDIUM 让运维感知（DB channel）
 *      c. **US-003 扩展**：若 OPS_ALERT_FEISHU_WEBHOOK 已配置，再异步推一条
 *         text 消息到飞书 ops 群（webhook channel），fire-and-forget。两个
 *         channel 互不阻塞——任一失败不会污染另一个，整体也不会 throw。
 *   3. 退出码 0 = 巡检完成（找到 0 个或多个匹配项都算成功）
 *   4. 退出码 1 = 巡检本身失败 (DB 异常)
 *
 * 使用：
 *   - 手动: npx ts-node --transpile-only src/scripts/audit-task-parameters-dry-run.ts
 *   - 自动: SchedulerService.initializeScheduler() 在 boot 时调用一次（boot guard）
 *
 * 设计原则：
 *   - 所有"判定逻辑"提纯成 pure function 方便单测注入：
 *       shouldFlagDryRunTask        — 单条 task row 是否命中
 *       buildOpsAlertText           — matches[] → 给运维看的 plain-text 摘要
 *       buildOpsAlertChannelPlan    — env + opts → 决定本次跑要走哪些 channel
 *   - 默认通道 = ['risk_alert']；额外通道由 caller 显式启用（也支持 env 默认）。
 *   - 任何 channel 失败只在 result 里记 errors，不 throw。
 */

import { ScheduledTask } from '../models/ScheduledTask';
import { logger } from '../utils/logger';
import { createHash } from 'crypto';
import { feishuNotificationService } from '../services/FeishuNotificationService';

/** 需要巡检的"应该真跑"的 task type 白名单。未来要扩展只在此 array 加。 */
export const SHOULD_BE_LIVE_TASK_TYPES: ReadonlyArray<string> = ['STRATEGY_KILL_SWITCH_CHECK'];

/** 支持的告警 channel 名（与 result.alerts[] 的 key 一一对应）。 */
export const DRY_RUN_AUDIT_CHANNELS = Object.freeze(['risk_alert', 'feishu_ops'] as const);
export type DryRunAuditChannel = (typeof DRY_RUN_AUDIT_CHANNELS)[number];

export interface DryRunAuditMatch {
  task_id: number;
  task_name: string;
  task_type: string;
  cron_expression: string;
  dry_run_value: any;
  is_active: boolean;
}

export interface DryRunAuditChannelResult {
  channel: DryRunAuditChannel;
  attempted: boolean;
  success: boolean;
  skipped?: boolean;
  ref_id?: number | string;
  error?: string;
  message?: string;
}

export interface DryRunAuditResult {
  scanned_tasks: number;
  matches: DryRunAuditMatch[];
  /** US-003: 多通道结果集合（按 channel 名顺序）。 */
  alerts: DryRunAuditChannelResult[];
  /** Back-compat：等价于 alerts 中 risk_alert.success（旧 caller / 单测仍读）。 */
  alert_written: boolean;
  alert_id?: number;
  error?: string;
}

export interface AuditTaskParametersDryRunOptions {
  /** 仅采集 matches、不写任何 alert（让 UI 预览或 CI dry-run 自检）。 */
  dry_run?: boolean;
  /** 写 RiskAlert 时挂在哪个 user_id 下。 */
  user_id?: number;
  /**
   * 启用的告警通道。未传 → 默认 ['risk_alert']（向后兼容）。
   * 传 [] → 一个 channel 都不跑（等价于 dry_run，但保留 matches 输出）。
   * 传 ['risk_alert','feishu_ops'] → 两个都跑。
   * 含未知 channel 名 → 静默丢弃（不抛错；让 caller 配错不挂 boot）。
   */
  channels?: DryRunAuditChannel[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — DB / env / network 全部注入式)
// ---------------------------------------------------------------------------

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
 * matches[] → 给运维群看的 plain-text 摘要。
 * - 至多列 5 个 task name 防消息超长；剩余在尾部 `+N more` 概括。
 * - 不含 timestamp（caller 想加自己拼），让本函数纯可比对。
 * 单测必覆盖。
 */
export function buildOpsAlertText(matches: DryRunAuditMatch[], scanned: number): string {
  if (!matches.length) {
    return `📋 dry_run 巡检: 扫描 ${scanned} 个 task, 0 命中.`;
  }
  const maxList = 5;
  const head = matches.slice(0, maxList);
  const tail = matches.length - head.length;
  const lines = [
    `📋 dry_run 巡检告警: ${matches.length}/${scanned} 个 enabled scheduled_task 显式 dry_run=true:`,
  ];
  for (const m of head) {
    lines.push(
      `  • [${m.task_id}] ${m.task_name} (type=${m.task_type}, cron=${m.cron_expression})`
    );
  }
  if (tail > 0) lines.push(`  ... +${tail} more`);
  lines.push('运维需确认是否仍需 dry_run, 或清零回到默认.');
  return lines.join('\n');
}

/**
 * 解析 env + opts → 本次跑实际启用的 channel 列表。
 * 规则：
 *   - opts.channels 显式传入 → 取其交集（去重 + 过滤未知 channel 名）。
 *   - opts.channels 未传 → 默认 ['risk_alert']；若 env OPS_ALERT_FEISHU_WEBHOOK 配置
 *     且非空 → 自动追加 'feishu_ops'（让 ops 一行 env 就能开第二通道，无需改代码）。
 *   - opts.dry_run=true → 强制返回空数组（caller 在外层短路）。
 * 单测必覆盖每条路径。
 */
export function buildOpsAlertChannelPlan(
  opts: AuditTaskParametersDryRunOptions = {},
  env: Record<string, string | undefined> = process.env as any
): DryRunAuditChannel[] {
  if (opts.dry_run) return [];
  if (opts.channels) {
    const seen = new Set<DryRunAuditChannel>();
    for (const c of opts.channels) {
      if ((DRY_RUN_AUDIT_CHANNELS as ReadonlyArray<string>).includes(c)) {
        seen.add(c as DryRunAuditChannel);
      }
    }
    return Array.from(seen);
  }
  const plan: DryRunAuditChannel[] = ['risk_alert'];
  const feishu = String(env.OPS_ALERT_FEISHU_WEBHOOK || '').trim();
  if (feishu) plan.push('feishu_ops');
  return plan;
}

// ---------------------------------------------------------------------------
// Channel adapters
// ---------------------------------------------------------------------------

/** 注入式 RiskAlert.create wrapper —— 让单测 fake，不用 mock 整个 model。 */
type RiskAlertCreator = (row: any) => Promise<any>;
/** 注入式飞书 webhook poster —— 让单测 fake，不真发 HTTP。 */
type FeishuWebhookPoster = (
  url: string,
  body: any
) => Promise<{ success: boolean; message?: string }>;

async function defaultRiskAlertCreator(row: any): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RiskAlert } = require('../models/RiskAlert');
  return RiskAlert.create(row);
}

async function defaultFeishuWebhookPoster(
  _url: string,
  body: any
): Promise<{ success: boolean; message?: string }> {
  try {
    const text = String(body?.content?.text || '');
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 32);
    const result = await feishuNotificationService.enqueueAndDeliver({
      idempotency_key: `task-parameter-audit:${digest}`,
      topic_key: 'task-parameter-audit',
      audience: 'ops',
      kind: 'task_parameter_audit',
      severity: 'WARN',
      title: '定时任务 dry_run 参数巡检',
      payload: body,
    });
    return { success: result.success, message: result.message };
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * 主入口 — 扫所有 enabled tasks + 给匹配项写 RiskAlert (+可选其他通道)。
 *
 * dry_run=true 时不写任何 alert，只返回 matches。
 * channels 控制本次启用哪些通道（默认 risk_alert，env 配 feishu webhook 时自动追加）。
 */
export async function auditTaskParametersDryRun(
  options: AuditTaskParametersDryRunOptions = {},
  /** 测试钩子 — caller 不应在生产传入。 */
  injectables: {
    riskAlertCreator?: RiskAlertCreator;
    feishuWebhookPoster?: FeishuWebhookPoster;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<DryRunAuditResult> {
  const env = injectables.env || (process.env as any);
  const riskAlertCreator = injectables.riskAlertCreator || defaultRiskAlertCreator;
  const feishuWebhookPoster = injectables.feishuWebhookPoster || defaultFeishuWebhookPoster;

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
      return {
        scanned_tasks: tasks.length,
        matches: [],
        alerts: [],
        alert_written: false,
      };
    }

    logger.warn(
      `[audit-task-parameters-dry-run] scanned=${tasks.length} matches=${matches.length}: ${matches
        .map(m => `${m.task_id}:${m.task_name}(type=${m.task_type})`)
        .join(', ')}`
    );

    const channels = buildOpsAlertChannelPlan(options, env);
    if (channels.length === 0) {
      // dry_run=true 或 caller 显式禁用所有 channel —— 返回 matches 不写任何 alert.
      return {
        scanned_tasks: tasks.length,
        matches,
        alerts: [],
        alert_written: false,
      };
    }

    const alerts: DryRunAuditChannelResult[] = [];
    let alertId: number | undefined;
    let riskAlertSuccess = false;

    // 顺序而非并行：channel 数量极少 (1-2) + 内部都 try-catch fail-OPEN，
    // 顺序更易调试 + 失败日志按通道分块更清晰。
    for (const ch of channels) {
      if (ch === 'risk_alert') {
        try {
          const alert = await riskAlertCreator({
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
          const id = Number((alert as any)?.id);
          if (Number.isFinite(id)) alertId = id;
          riskAlertSuccess = true;
          alerts.push({
            channel: 'risk_alert',
            attempted: true,
            success: true,
            ref_id: Number.isFinite(id) ? id : undefined,
          });
        } catch (alertErr: any) {
          logger.warn(
            `[audit-task-parameters-dry-run] RiskAlert.create failed: ${
              alertErr?.message || alertErr
            }`
          );
          alerts.push({
            channel: 'risk_alert',
            attempted: true,
            success: false,
            error: alertErr?.message || String(alertErr),
          });
        }
      } else if (ch === 'feishu_ops') {
        const url = String(env.OPS_ALERT_FEISHU_WEBHOOK || '').trim();
        if (!url) {
          alerts.push({
            channel: 'feishu_ops',
            attempted: false,
            success: false,
            skipped: true,
            message: 'OPS_ALERT_FEISHU_WEBHOOK 未配置, skip',
          });
          continue;
        }
        try {
          const text = buildOpsAlertText(matches, tasks.length);
          const r = await feishuWebhookPoster(url, { msg_type: 'text', content: { text } });
          alerts.push({
            channel: 'feishu_ops',
            attempted: true,
            success: r.success,
            message: r.message,
          });
          if (!r.success) {
            logger.warn(
              `[audit-task-parameters-dry-run] feishu_ops webhook failed: ${r.message || 'unknown'}`
            );
          }
        } catch (postErr: any) {
          // defaultFeishuWebhookPoster 已 fail-OPEN 不 throw；这里兜底 caller 传入
          // 的自定义 poster 抛 sync error 的极端情况。
          logger.warn(
            `[audit-task-parameters-dry-run] feishu_ops post threw: ${postErr?.message || postErr}`
          );
          alerts.push({
            channel: 'feishu_ops',
            attempted: true,
            success: false,
            error: postErr?.message || String(postErr),
          });
        }
      }
    }

    return {
      scanned_tasks: tasks.length,
      matches,
      alerts,
      alert_written: riskAlertSuccess,
      alert_id: alertId,
    };
  } catch (err: any) {
    logger.error(`[audit-task-parameters-dry-run] failed: ${err?.message || err}`);
    return {
      scanned_tasks: 0,
      matches: [],
      alerts: [],
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
