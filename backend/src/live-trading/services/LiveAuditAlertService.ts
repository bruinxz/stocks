import axios from 'axios';
import { logger } from '../../utils/logger';

/**
 * 实盘 audit 实时告警。
 *
 * 上线 launch-helper：critical / error 级别 audit 不能只落 PG 等人翻；
 * 5 秒内推送到飞书"实盘告警"专用群，配合 §1.7 可观测性 checklist。
 *
 * 设计：
 *   - 接收方：env LIVE_ALERT_FEISHU_WEBHOOK；缺省即静默
 *     （不复用 FEISHU_RECOMMENDATION_BOT_WEBHOOK 避免淹没在日常推送里）
 *   - 投递：异步 fire-and-forget；调用方 audit 主流程不会因为 webhook 慢/挂掉而 hang
 *   - 防风暴：60s 内同一 event_type + reason_code 只发 1 条；超量计数后追发一条 summary
 *   - 失败容错：webhook 调用异常仅打日志，不抛
 *
 * 触发点：LiveTradingService.audit() 包装；以及 KillSwitchService 直接调
 */

interface AuditAlertPayload {
  event_type: string;
  severity?: string;
  message: string;
  user_id?: number;
  account_id?: number;
  order_id?: number;
  draft_id?: number;
  metadata?: Record<string, any>;
}

interface DedupBucket {
  count: number;
  lastSentAt: number;
  windowEndsAt: number;
  suppressed: number;
}

const ALERT_LEVELS = new Set(['critical', 'error', 'warning']);
const CRITICAL_LEVELS = new Set(['critical', 'error']);
const DEDUP_WINDOW_MS = 60_000;
const SUMMARY_FLUSH_DELAY_MS = 65_000;

const buckets = new Map<string, DedupBucket>();
const pendingSummaryTimers = new Map<string, NodeJS.Timeout>();

let httpAgent: ReturnType<typeof axios.create> | null = null;
function getHttp() {
  if (!httpAgent) {
    httpAgent = axios.create({
      timeout: Number(process.env.LIVE_ALERT_WEBHOOK_TIMEOUT_MS || 5000),
    });
  }
  return httpAgent;
}

function getWebhookUrl(): string {
  return String(
    process.env.LIVE_ALERT_FEISHU_WEBHOOK || process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || ''
  ).trim();
}

function isEnabled(): boolean {
  if (String(process.env.DISABLE_LIVE_ALERT || '').toLowerCase() === 'true') return false;
  return Boolean(getWebhookUrl());
}

function bucketKey(payload: AuditAlertPayload): string {
  const code = String(payload.metadata?.reason_code || '');
  return `${payload.event_type}|${code}`;
}

function severityEmoji(sev?: string): string {
  switch ((sev || '').toLowerCase()) {
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

function formatAlertText(payload: AuditAlertPayload): string {
  const lines = [
    `${severityEmoji(payload.severity)} 实盘 ${payload.severity || 'info'} | ${payload.event_type}`,
    payload.message,
  ];
  const ctx: string[] = [];
  if (payload.user_id) ctx.push(`user=${payload.user_id}`);
  if (payload.account_id) ctx.push(`account=${payload.account_id}`);
  if (payload.order_id) ctx.push(`order=${payload.order_id}`);
  if (payload.draft_id) ctx.push(`draft=${payload.draft_id}`);
  if (ctx.length) lines.push(`ctx: ${ctx.join(', ')}`);
  if (payload.metadata && Object.keys(payload.metadata).length) {
    let metaStr;
    try {
      metaStr = JSON.stringify(payload.metadata).slice(0, 500);
    } catch {
      metaStr = '[unserializable metadata]';
    }
    lines.push(`metadata: ${metaStr}`);
  }
  lines.push(`time: ${new Date().toISOString()}`);
  return lines.join('\n');
}

async function postToFeishu(text: string): Promise<void> {
  const url = getWebhookUrl();
  if (!url) return;
  try {
    await getHttp().post(url, {
      msg_type: 'text',
      content: { text },
    });
  } catch (err: any) {
    logger.warn('[live-alert] feishu webhook 推送失败:', err?.message || err);
  }
}

function scheduleSummary(key: string): void {
  if (pendingSummaryTimers.has(key)) return;
  const timer = setTimeout(() => {
    pendingSummaryTimers.delete(key);
    const bucket = buckets.get(key);
    if (!bucket || bucket.suppressed === 0) return;
    const summary = `📊 实盘告警合并：${key} 在过去 ${Math.round(
      DEDUP_WINDOW_MS / 1000
    )}s 内被抑制 ${bucket.suppressed} 条（已发 ${bucket.count}）`;
    bucket.suppressed = 0;
    void postToFeishu(summary);
  }, SUMMARY_FLUSH_DELAY_MS);
  timer.unref?.();
  pendingSummaryTimers.set(key, timer);
}

/**
 * 主入口：异步告警。调用方不应 await（避免 audit 链路被外网慢调用阻塞）。
 */
export function sendLiveAuditAlert(payload: AuditAlertPayload): void {
  if (!payload || !payload.event_type) return;
  const sev = String(payload.severity || '').toLowerCase();
  if (!ALERT_LEVELS.has(sev)) return;
  // 默认 critical/error 才推；warning 在 LIVE_ALERT_INCLUDE_WARNING=true 时才推
  const includeWarning =
    String(process.env.LIVE_ALERT_INCLUDE_WARNING || '').toLowerCase() === 'true';
  if (!CRITICAL_LEVELS.has(sev) && !includeWarning) return;
  if (!isEnabled()) return;

  const key = bucketKey(payload);
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.windowEndsAt <= now) {
    bucket = { count: 0, lastSentAt: 0, windowEndsAt: now + DEDUP_WINDOW_MS, suppressed: 0 };
    buckets.set(key, bucket);
  }
  // 窗口内仅放行第 1 条
  if (bucket.count >= 1) {
    bucket.suppressed += 1;
    scheduleSummary(key);
    return;
  }
  bucket.count += 1;
  bucket.lastSentAt = now;

  const text = formatAlertText(payload);
  // 真正发送：异步 fire-and-forget，调用方拿不到结果
  void postToFeishu(text);
}

/** 测试用：清状态 */
export function __resetAuditAlertForTests() {
  buckets.clear();
  for (const t of pendingSummaryTimers.values()) clearTimeout(t);
  pendingSummaryTimers.clear();
  httpAgent = null;
}
