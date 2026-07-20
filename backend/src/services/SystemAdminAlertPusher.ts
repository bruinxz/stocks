/**
 * 系统级飞书通知兼容入口。
 *
 * 旧实现直接 POST webhook，并把去重状态放在进程内 Map；发送失败也会进入去重，
 * 导致“既没送达、又一小时不再尝试”。现在所有调用先写
 * feishu_notification_outbox，再由统一投递器即时发送/持久化重试。
 */
import { randomBytes } from 'crypto';
import { logger } from '../utils/logger';
import { formatEast8Readable } from '../utils/timezone';
import {
  FeishuAudience,
  FeishuNotificationService,
  buildWindowedFeishuIdempotencyKey,
  feishuNotificationService,
} from './FeishuNotificationService';

export type SystemAdminAlertLevel = 'INFO' | 'WARN' | 'HIGH' | 'CRITICAL' | 'SUCCESS';

export interface SystemAdminAlertInput {
  dedup_key: string;
  level: SystemAdminAlertLevel;
  title: string;
  body_markdown: string;
  triggered_at?: string;
  trace_id?: string;
  deeplink?: string;
  caller_alert_id?: number;
  /** 精确业务事件幂等键；incident / 日报等应优先使用。 */
  idempotency_key?: string;
  /** 缺省 ops；业务摘要必须显式传 business，实盘告警传 live。 */
  audience?: FeishuAudience;
  recipient_user_id?: number;
  kind?: string;
}

export interface SystemAdminAlertPushResult {
  pushed: boolean;
  deduped: boolean;
  outbox_id?: number;
  status?: string;
  feishu: { attempted: boolean; success: boolean; message?: string };
  /** 兼容旧返回结构；系统告警邮件旁路已删除，邮件报告仍由专用邮件服务负责。 */
  email: {
    attempted: boolean;
    success_count: number;
    failed_count: number;
    skipped: boolean;
    message?: string;
  };
}

export interface SystemAdminAlertPusherOptions {
  now_ms?: number;
  skip_dedup?: boolean;
  dedup_window_ms?: number;
  notification_service?: FeishuNotificationService;
}

export function buildSystemAdminAlertCard(input: SystemAdminAlertInput): {
  msg_type: 'interactive';
  card: any;
} {
  const level = String(input.level || 'INFO').toUpperCase();
  const headerTemplate =
    level === 'CRITICAL' || level === 'HIGH'
      ? 'red'
      : level === 'WARN'
      ? 'orange'
      : level === 'SUCCESS'
      ? 'green'
      : 'blue';
  const elements: any[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: truncateLarkMd(input.body_markdown || '_无详情_', 2000) },
    },
  ];
  if (input.deeplink) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看详情 →' },
          type: 'primary',
          url: input.deeplink,
        },
      ],
    });
  }
  const triggeredAt = input.triggered_at || formatEast8Readable(new Date());
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `触发时间: ${triggeredAt}${input.trace_id ? ` · ${input.trace_id}` : ''}`,
      },
    ],
  });
  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: headerTemplate,
        title: { tag: 'plain_text', content: input.title || `[${level}] 系统通知` },
      },
      elements,
    },
  };
}

export async function pushSystemAdminAlert(
  input: SystemAdminAlertInput,
  options: SystemAdminAlertPusherOptions = {}
): Promise<SystemAdminAlertPushResult> {
  const nowMs = Number.isFinite(options.now_ms) ? Number(options.now_ms) : Date.now();
  const windowMs = Number.isFinite(options.dedup_window_ms)
    ? Number(options.dedup_window_ms)
    : Number(process.env.SYSTEM_ALERT_DEDUP_WINDOW_MS || 60 * 60 * 1000);
  const idempotencyKey =
    input.idempotency_key ||
    (options.skip_dedup
      ? `${input.dedup_key}:nonce:${nowMs}:${randomBytes(4).toString('hex')}`
      : buildWindowedFeishuIdempotencyKey(input.dedup_key, nowMs, windowMs));
  const service = options.notification_service || feishuNotificationService;
  try {
    const delivery = await service.enqueueAndDeliver({
      idempotency_key: idempotencyKey,
      topic_key: input.dedup_key,
      audience: input.audience || 'ops',
      recipient_user_id: input.recipient_user_id || null,
      kind: input.kind || 'system_admin_alert',
      severity: input.level,
      title: input.title,
      payload: buildSystemAdminAlertCard(input),
      correlation_id: input.trace_id || null,
      metadata: {
        caller_alert_id: input.caller_alert_id || null,
      },
    });
    return {
      pushed: delivery.success,
      deduped: delivery.deduped === true,
      outbox_id: delivery.outbox_id,
      status: delivery.status,
      feishu: {
        attempted: !delivery.skipped,
        success: delivery.success,
        message: delivery.message,
      },
      email: {
        attempted: false,
        success_count: 0,
        failed_count: 0,
        skipped: true,
        message: '系统告警邮件旁路已删除；飞书 outbox 是本入口唯一通道',
      },
    };
  } catch (error: any) {
    logger.warn(
      `[SystemAdminAlert] enqueue failed (dedup_key=${input.dedup_key}): ${error?.message || error}`
    );
    return {
      pushed: false,
      deduped: false,
      feishu: { attempted: false, success: false, message: error?.message || String(error) },
      email: {
        attempted: false,
        success_count: 0,
        failed_count: 0,
        skipped: true,
        message: '系统告警邮件旁路已删除',
      },
    };
  }
}

export function pushSystemAdminAlertFireAndForget(input: SystemAdminAlertInput): void {
  void pushSystemAdminAlert(input).catch(error => {
    logger.warn(
      `[SystemAdminAlert] fire-and-forget unexpected error (${input.dedup_key}): ${
        error?.message || error
      }`
    );
  });
}

function truncateLarkMd(value: string, max: number): string {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
