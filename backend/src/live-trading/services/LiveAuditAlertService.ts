import { logger } from '../../utils/logger';
import { formatEast8Readable } from '../../utils/timezone';
import {
  FeishuNotificationService,
  buildWindowedFeishuIdempotencyKey,
  feishuNotificationService,
} from '../../services/FeishuNotificationService';

/** 实盘 audit 实时告警。所有消息先写统一 outbox，仅投递到实盘专用群。 */
export interface AuditAlertPayload {
  event_type: string;
  severity?: string;
  message: string;
  user_id?: number;
  account_id?: number;
  order_id?: number;
  draft_id?: number;
  metadata?: Record<string, any>;
}

const ALERT_LEVELS = new Set(['critical', 'error', 'warning']);
const CRITICAL_LEVELS = new Set(['critical', 'error']);
const DEDUP_WINDOW_MS = 60_000;
let notifications: FeishuNotificationService = feishuNotificationService;

function bucketKey(payload: AuditAlertPayload): string {
  const code = String(payload.metadata?.reason_code || 'unknown');
  return `${payload.event_type}:${code}`;
}

function severityEmoji(severity?: string): string {
  switch (String(severity || '').toLowerCase()) {
    case 'critical':
      return '🚨';
    case 'error':
      return '❌';
    case 'warning':
      return '⚠️';
    default:
      return 'ℹ️';
  }
}

export function formatLiveAuditAlertText(payload: AuditAlertPayload): string {
  const lines = [
    `${severityEmoji(payload.severity)} 实盘 ${payload.severity || 'info'} | ${payload.event_type}`,
    payload.message,
  ];
  const context: string[] = [];
  if (payload.user_id) context.push(`user=${payload.user_id}`);
  if (payload.account_id) context.push(`account=${payload.account_id}`);
  if (payload.order_id) context.push(`order=${payload.order_id}`);
  if (payload.draft_id) context.push(`draft=${payload.draft_id}`);
  if (context.length > 0) lines.push(`ctx: ${context.join(', ')}`);
  if (payload.metadata && Object.keys(payload.metadata).length > 0) {
    try {
      lines.push(`metadata: ${JSON.stringify(payload.metadata).slice(0, 500)}`);
    } catch {
      lines.push('metadata: [unserializable metadata]');
    }
  }
  lines.push(`time: ${formatEast8Readable(new Date())}`);
  return lines.join('\n');
}

function buildIdempotencyKey(payload: AuditAlertPayload, nowMs: number): string {
  const topic = `live-audit:${bucketKey(payload)}`;
  const entity = payload.order_id
    ? `order:${payload.order_id}`
    : payload.draft_id
    ? `draft:${payload.draft_id}`
    : payload.account_id && payload.metadata?.audit_id
    ? `account:${payload.account_id}:audit:${payload.metadata.audit_id}`
    : null;
  return entity
    ? `${topic}:${entity}`
    : buildWindowedFeishuIdempotencyKey(topic, nowMs, DEDUP_WINDOW_MS);
}

/** 主入口保持 fire-and-forget；落库或外网异常都不会传染实盘审计主链。 */
export function sendLiveAuditAlert(payload: AuditAlertPayload): void {
  if (!payload?.event_type) return;
  const severity = String(payload.severity || '').toLowerCase();
  if (!ALERT_LEVELS.has(severity)) return;
  const includeWarning =
    String(process.env.LIVE_ALERT_INCLUDE_WARNING || '').toLowerCase() === 'true';
  if (!CRITICAL_LEVELS.has(severity) && !includeWarning) return;
  if (String(process.env.DISABLE_LIVE_ALERT || '').toLowerCase() === 'true') return;

  const nowMs = Date.now();
  const topic = `live-audit:${bucketKey(payload)}`;
  void notifications
    .enqueueAndDeliver({
      idempotency_key: buildIdempotencyKey(payload, nowMs),
      topic_key: topic,
      audience: 'live',
      kind: 'live_audit_alert',
      severity: severity.toUpperCase(),
      title: `实盘 ${severity} · ${payload.event_type}`,
      payload: {
        msg_type: 'text',
        content: { text: formatLiveAuditAlertText(payload) },
      },
      correlation_id:
        (payload.metadata?.audit_id && String(payload.metadata.audit_id)) ||
        (payload.order_id && `order_id=${payload.order_id}`) ||
        (payload.draft_id && `draft_id=${payload.draft_id}`) ||
        null,
      metadata: {
        event_type: payload.event_type,
        reason_code: payload.metadata?.reason_code || null,
      },
    })
    .catch(error => {
      logger.warn(`[live-alert] enqueue failed: ${error?.message || error}`);
    });
}

/** 单测注入点。 */
export function __setLiveAuditNotificationServiceForTests(
  service?: FeishuNotificationService
): void {
  notifications = service || feishuNotificationService;
}

/** 向后兼容旧测试 helper；持久化幂等已不再依赖进程内状态。 */
export function __resetAuditAlertForTests(): void {
  notifications = feishuNotificationService;
}
