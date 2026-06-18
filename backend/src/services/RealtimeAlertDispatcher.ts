/**
 * RealtimeAlertDispatcher — US-067 实时风控 webhook（高优先级告警）
 *
 * 监听 RiskAlert 表新行（任何 level='HIGH' 的告警写入即触发 dispatch），并行触发
 * 3 个通道：
 *   1. **飞书机器人 webhook** — interactive card，复用 FeishuBotWebhookService.sendRiskAlertCard
 *   2. **邮件 SMTP** — HTML 邮件，复用 EmailNotificationService.sendEmail
 *   3. **阿里云短信** — 11 位国内号，复用 AliyunSmsService.sendSms
 *
 * AC 字面要求：
 *   - 新增 RealtimeAlertDispatcher 监听 RiskAlert 表 afterCreate hook
 *   - 对 level=HIGH 的告警：立即并行触发 飞书 + 邮件 + （可选）阿里云短信
 *   - 防风暴：同一类告警 30 分钟内只推一次，使用 Redis 去重
 *   - 新增配置：用户可勾选哪些通道接收 HIGH 告警
 *
 * 与 US-053 / US-064 LRU dedup 模式同款（progress.txt 已记录 "dedup buffer FIFO LRU
 * 200 条 — JSONB 持久化"）：本项目暂未引入 Redis 基础设施，沿用 User.risk_config.
 * realtime_alert_seen JSONB array 持久化 dedup buffer + 30 min TTL 窗口（用
 * timestamp 比较代替 Redis EXPIRE）。signature 含 `<rule_id>::<symbol>::<level>`，
 * 30 分钟内同签名 dedup；超过 200 条 FIFO LRU trim。
 *
 * 设计遵循 US-063/064/065/066 推送 service 8 项 checklist (progress.txt):
 *   (1) **`User.risk_config.notification_channels` JSONB namespace 共享**
 *       (US-067 新增 sms{enabled,phone,risk_alert} 子对象 + email.risk_alert 字段)
 *   (2) **`normalizeNotificationConfig(raw)` 静默退回默认** (DailyTradingDigestService
 *       已在 US-063 引入；本 story 扩展 sms 字段+ email.risk_alert 不破坏 sibling tests)
 *   (3) **`shouldDispatchForChannel(config, channel)` 多路径 gate** 至少含 4 路径：
 *       feishu/email/sms 单独 enabled / 单独 risk_alert / 缺接收地址 + env fallback
 *   (4) **DataSource 注入式 send** — 飞书 webhook 调用走 sendFeishuCard / 邮件
 *       走 sendEmail / 短信走 sendSms，单测 fake 完全脱外部依赖
 *   (5) **每用户 channel 并行 Promise.allSettled** — 单 channel 失败不阻塞其他 channel
 *   (6) **`dry_run=true` 选项** — 让 UI 预览不实际推送；前端 Modal.confirm 二次确认
 *   (7) **业务 ID `ALERT-{user_id}-{YYYYMMDD}-{rand4}`** 与 US-055 一致命名范式
 *   (8) **alert hook 入口** — risk guards (PositionLimit / TrailingStop / PerStockStopLoss /
 *       DrawdownCircuitBreaker / BlackSwanWatchdog / IndustryConcentrationGuard /
 *       MarketRegimeAlertService) 在 writeAlert 后 fire-and-forget 调用本 service
 *
 * 边界与坑（**测试必覆盖**）：
 *   - **dedup 30 分钟时间窗 + 200 条 LRU**：30 min 内同 signature 跳过；超 30 min
 *     允许再发；超 200 条 drop 老的（防 JSONB 无限增长）。signature 含 alert.id
 *     时 dedup 失效（每个 alert id 唯一），所以本 service signature 不含 id，
 *     用 `${rule_id}::${symbol}::${level}` 让"同一类告警" 30 min dedup 生效。
 *   - **level !== 'HIGH' 直接 skip**：本 dispatcher 只处理 HIGH，MEDIUM/LOW 走
 *     SchedulerService 聚合 cron（未来 US 扩展）。
 *   - **3 channel 任一失败不阻塞其他**：用 Promise.allSettled 并行；单 channel
 *     fail-OPEN 返回 status='failed' 不 throw。
 *   - **fire-and-forget 入口**：risk guards 调 `dispatcher.dispatch(...)` 不
 *     `await`，让 RiskAlert.create 主流程不被网络延迟阻塞；service 内部 try/catch
 *     彻底吞错日志记录，绝不 unhandled promise rejection。
 *   - **dry_run=true 不写 dedup**：让用户多次预演同一告警；非 dry_run 写 dedup
 *     buffer。
 */

import moment from 'moment-timezone';

import { logger } from '../utils/logger';
import { User } from '../models/User';
import { feishuBotWebhookService, FeishuBotWebhookSendResult } from './FeishuBotWebhookService';
import {
  emailNotificationService,
  EmailNotificationSendResult,
  EmailPayload,
} from './EmailNotificationService';
import { aliyunSmsService, AliyunSmsSendResult, SmsPayload } from './AliyunSmsService';
import {
  normalizeNotificationConfig,
  NotificationChannelsConfig,
} from './DailyTradingDigestService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REALTIME_ALERT_STATUS = Object.freeze({
  SENT: 'sent',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  PARTIAL: 'partial',
} as const);

export type RealtimeAlertStatus =
  (typeof REALTIME_ALERT_STATUS)[keyof typeof REALTIME_ALERT_STATUS];

export const REALTIME_ALERT_CHANNELS = Object.freeze({
  FEISHU: 'feishu',
  EMAIL: 'email',
  SMS: 'sms',
} as const);

export type RealtimeAlertChannel =
  (typeof REALTIME_ALERT_CHANNELS)[keyof typeof REALTIME_ALERT_CHANNELS];

/** 30 分钟时间窗 — 同 signature dedup 阈值（AC "30 分钟内只推一次"）。 */
export const REALTIME_ALERT_DEDUP_WINDOW_MS = 30 * 60 * 1000;

/** LRU dedup buffer 上限 — 与 BlackSwanWatchdog / EarningsForecastWatcher 一致 200。 */
export const REALTIME_ALERT_SEEN_LRU_LIMIT = 200;

/** 只对 level=HIGH 触发（MEDIUM/LOW 走 cron 聚合）。 */
export const REALTIME_ALERT_TRIGGER_LEVEL = 'HIGH';

/** 阿里云 SMS 模板 / 签名 env 名 */
export const SMS_TEMPLATE_RISK_ALERT_ENV = 'ALIYUN_SMS_TEMPLATE_RISK_ALERT';
export const SMS_SIGN_NAME_ENV = 'ALIYUN_SMS_SIGN_NAME';

/** AI 解读 deeplink 前缀（前端 / workspace/portfolio?ai=<symbol>）。 */
const DEFAULT_FRONTEND_BASE = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** 上层 RiskAlert.create 完成后传给 dispatcher 的最小信息集（解耦 Sequelize 模型）。 */
export interface RealtimeAlertInput {
  /** RiskAlert.id (DB 主键)；用于日志关联；不参与 dedup signature */
  alert_id?: number;
  user_id: number;
  symbol: string;
  name: string;
  level: string;
  message: string;
  /** 触发的 rule 标识（e.g. 'position_limit' / 'trailing_stop' / 'drawdown_breaker'）
   * 用于 dedup signature；caller 不传时退回 'unknown'。 */
  rule_id?: string;
  /** 触发时间戳（ISO 字符串）；caller 不传时取当前时刻。 */
  triggered_at?: string;
}

/** dispatcher 持久化在 user.risk_config.realtime_alert_seen 的单条记录。 */
export interface RealtimeAlertSeenRecord {
  /** dedup signature: `<rule_id>::<symbol>::<level>` */
  signature: string;
  /** 该 signature 最后一次推送的时间戳（Unix ms） */
  pushed_at_ms: number;
}

export interface RealtimeAlertChannelResult {
  channel: RealtimeAlertChannel;
  status: RealtimeAlertStatus;
  sent: boolean;
  /** SKIPPED / FAILED / PARTIAL 时填原因 */
  message?: string;
  /** 下游 channel adapter 返回的 raw data（webhook response / SMTP messageId / SMS bizId） */
  data?: any;
}

/** 给上层（scheduler / api / unit test）查询 dispatcher 结果用的 plain-object 返回。 */
export interface RealtimeAlertDispatchResult {
  alert_id_dispatch: string;
  user_id: number;
  symbol: string;
  level: string;
  rule_id: string;
  signature: string;
  status: RealtimeAlertStatus;
  /** 至少一个 channel sent=true 时为 true */
  sent_any: boolean;
  /** dry_run = true 时不写 dedup */
  dry_run: boolean;
  /** 是否因 30 min dedup 命中而整体跳过（per-channel skip 不算） */
  deduped: boolean;
  /** 3 channel 各自结果 */
  channels: RealtimeAlertChannelResult[];
  /** 顶层跳过原因（level!='HIGH' / 用户不存在 / dedup hit） */
  skip_reason?: string;
}

export interface RealtimeAlertCardPayload {
  alert_id_dispatch: string;
  user_id: number;
  symbol: string;
  name: string;
  level: string;
  message: string;
  rule_id: string;
  triggered_at: string;
  /** 前端跳转 deeplink */
  deeplink_url: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * dedup signature：`<rule_id>::<symbol>::<level>::<message_hash>` — 30 min 内同签名只推一次。
 * 不含 alert_id（不同 alert id 但同 rule+symbol+level+message = 短时间内重复触发，需 dedup）。
 *
 * Batch X (2026-06-17, notif-3 fix): signature 加入 message 内容 hash, 让"升级告警"
 * (e.g. drawdown 10% LEVEL_1 → 15% LEVEL_2 同 rule_id=drawdown_breaker 但 message 不同)
 * 能突破 dedup 窗口 + 真发出. 之前只看 rule+symbol+level → 同 rule_id 升级的第二条
 * 30 min 内 silent drop, 用户错过关键升级.
 *
 * message hash 用前 32 字符 FNV-1a-like 兜底 (避免 npm crypto 依赖, sha-256 多余):
 * 简单算法对 message 完全相同 → 完全相同 hash → 真重复仍 dedup; 文字微差 → 不同 hash → 不 dedup.
 */
function hashMessage(message: string): string {
  if (!message) return '0';
  // 32-bit FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < message.length; i++) {
    hash ^= message.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function buildAlertSignature(input: {
  rule_id?: string;
  symbol: string;
  level: string;
  message?: string;
}): string {
  const rule = String(input.rule_id || 'unknown').trim() || 'unknown';
  const sym = String(input.symbol || '').trim() || 'UNKNOWN_SYMBOL';
  const lvl =
    String(input.level || '')
      .trim()
      .toUpperCase() || 'UNKNOWN_LEVEL';
  const msgHash = input.message ? hashMessage(input.message) : '0';
  return `${rule}::${sym}::${lvl}::${msgHash}`;
}

/**
 * 判定一条 seen 记录是否仍在 30 min dedup 窗口内。
 *  - 缺 pushed_at_ms / pushed_at_ms 不是有效数字 → 视为过期（不阻塞推送）
 *  - now - pushed_at_ms < window → 仍在 dedup 窗口 → true
 */
export function isWithinDedupWindow(
  record: RealtimeAlertSeenRecord | undefined,
  nowMs: number,
  windowMs: number = REALTIME_ALERT_DEDUP_WINDOW_MS
): boolean {
  if (!record || !Number.isFinite(record.pushed_at_ms)) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0) return false;
  return nowMs - record.pushed_at_ms < windowMs;
}

/**
 * FIFO LRU merge（与 BlackSwanWatchdog.mergeSeenSignatures /
 * EarningsForecastWatcher.mergeSeenForecastSignatures 同款），但本 service
 * 的 entry 是 `{signature, pushed_at_ms}` 对象，所以 bump 的语义是"更新
 * pushed_at_ms 到最新值并移到末尾"。
 *
 * 同 signature 重复时 bump 时间戳 + 位置；新 signature append；超 limit
 * drop 头部。
 */
export function mergeSeenAlertSignatures(
  existing: RealtimeAlertSeenRecord[] | null | undefined,
  newOnes: RealtimeAlertSeenRecord[],
  limit: number = REALTIME_ALERT_SEEN_LRU_LIMIT
): RealtimeAlertSeenRecord[] {
  const exist = Array.isArray(existing)
    ? existing.filter(
        (r): r is RealtimeAlertSeenRecord =>
          !!r &&
          typeof r === 'object' &&
          typeof r.signature === 'string' &&
          r.signature.length > 0 &&
          Number.isFinite(r.pushed_at_ms)
      )
    : [];
  const out: RealtimeAlertSeenRecord[] = [...exist];
  for (const rec of newOnes) {
    if (
      !rec ||
      typeof rec.signature !== 'string' ||
      !rec.signature ||
      !Number.isFinite(rec.pushed_at_ms)
    ) {
      continue;
    }
    const idx = out.findIndex(r => r.signature === rec.signature);
    if (idx >= 0) {
      out.splice(idx, 1);
    }
    out.push({ signature: rec.signature, pushed_at_ms: rec.pushed_at_ms });
  }
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : REALTIME_ALERT_SEEN_LRU_LIMIT;
  if (out.length > safeLimit) {
    return out.slice(out.length - safeLimit);
  }
  return out;
}

/**
 * 决定单 channel 是否应触发：
 *   - feishu: enabled && risk_alert && (webhook_url || env fallback)
 *   - email:  enabled && risk_alert && address
 *   - sms:    enabled && risk_alert && phone（normalize 11 位国内号）
 *
 * 与 US-063/064/065/066 shouldXxx gate 一致的 4 路径模式。
 */
export function shouldDispatchForChannel(
  config: NotificationChannelsConfig,
  channel: RealtimeAlertChannel,
  hasFeishuEnvFallback: boolean
): { shouldSend: boolean; reason?: string } {
  if (channel === REALTIME_ALERT_CHANNELS.FEISHU) {
    if (!config.feishu.enabled) return { shouldSend: false, reason: 'feishu 通道未启用' };
    if (!config.feishu.risk_alert) {
      return { shouldSend: false, reason: '用户已关闭 feishu risk_alert 推送' };
    }
    const hasUrl = !!safeString(config.feishu.webhook_url);
    if (!hasUrl && !hasFeishuEnvFallback) {
      return { shouldSend: false, reason: '未配置 feishu webhook URL' };
    }
    return { shouldSend: true };
  }
  if (channel === REALTIME_ALERT_CHANNELS.EMAIL) {
    if (!config.email.enabled) return { shouldSend: false, reason: 'email 通道未启用' };
    if (!config.email.risk_alert) {
      return { shouldSend: false, reason: '用户已关闭 email risk_alert 推送' };
    }
    if (!safeString(config.email.address)) {
      return { shouldSend: false, reason: '未配置邮件接收地址' };
    }
    return { shouldSend: true };
  }
  if (channel === REALTIME_ALERT_CHANNELS.SMS) {
    if (!config.sms.enabled) return { shouldSend: false, reason: 'sms 通道未启用' };
    if (!config.sms.risk_alert) {
      return { shouldSend: false, reason: '用户已关闭 sms risk_alert 推送' };
    }
    if (!safeString(config.sms.phone)) {
      return { shouldSend: false, reason: '未配置短信接收手机号' };
    }
    return { shouldSend: true };
  }
  return { shouldSend: false, reason: `未知通道: ${channel}` };
}

/**
 * 构造 dispatcher 业务 ID：`ALERT-{user_id}-{YYYYMMDD}-{rand4}`
 * 与 US-055 / US-063 / US-064 / US-065 / US-066 命名范式一致。
 */
export function buildAlertId(user_id: number, triggered_at: string, rand4Hex: string): string {
  const ymd = String(triggered_at).slice(0, 10).replace(/-/g, '');
  const rand = String(rand4Hex || '')
    .slice(0, 4)
    .padStart(4, '0');
  return `ALERT-${user_id}-${ymd}-${rand}`;
}

/**
 * 构造 AI 解读 deeplink — 前端 /workspace/portfolio?ai=<symbol>&alert=<alert_id>。
 */
export function buildAlertDeeplink(
  symbol: string,
  alert_id_dispatch: string,
  baseUrl: string = DEFAULT_FRONTEND_BASE
): string {
  const safeBase = String(baseUrl || DEFAULT_FRONTEND_BASE).replace(/\/+$/, '');
  const sp = new URLSearchParams({
    ai: symbol,
    alert: alert_id_dispatch,
    type: 'realtime_risk_alert',
  });
  return `${safeBase}/workspace/portfolio?${sp.toString()}`;
}

/**
 * 构造飞书 interactive card —— HIGH=红 header，含 symbol/level/触发时间/详情/deeplink。
 * 不直接调 webhook —— `sendFeishuCard` 才发；本函数只产出 card object 便于单测断言。
 */
export function buildRiskAlertFeishuCard(payload: RealtimeAlertCardPayload): {
  msg_type: 'interactive';
  card: {
    header: { template: string; title: { content: string; tag: 'plain_text' } };
    elements: any[];
  };
} {
  const level = String(payload.level || '').toUpperCase();
  // HIGH=红, MEDIUM=橙(orange), LOW/其他=灰(grey)
  const headerTemplate = level === 'HIGH' ? 'red' : level === 'MEDIUM' ? 'orange' : 'grey';
  const elements: any[] = [];
  // Section 1: header line — symbol + name
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**⚠️ ${payload.symbol} ${payload.name}**`,
    },
  });
  elements.push({
    tag: 'div',
    fields: [
      { is_short: true, text: { tag: 'lark_md', content: `**告警等级**\n${level || '—'}` } },
      {
        is_short: true,
        text: {
          tag: 'lark_md',
          content: `**触发规则**\n${safeText(payload.rule_id, 32) || '未知'}`,
        },
      },
      {
        is_short: false,
        text: {
          tag: 'lark_md',
          content: `**触发时间**\n${safeText(payload.triggered_at, 32) || '—'}`,
        },
      },
    ],
  });
  elements.push({ tag: 'hr' });
  // Section 2: detailed message
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: safeText(payload.message, 400) || '_无详细描述_' },
  });
  // Section 3: deeplink action
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '查看 AI 解读 →' },
        type: 'primary',
        url: payload.deeplink_url,
      },
    ],
  });
  // Footer
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `${payload.alert_id_dispatch} · 实时风控告警` }],
  });
  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: headerTemplate,
        title: {
          tag: 'plain_text',
          content: `🚨 ${level || ''} 风控告警`,
        },
      },
      elements,
    },
  };
}

/**
 * 构造 HTML 邮件 payload —— subject/html/text。
 */
export function buildRiskAlertEmail(payload: RealtimeAlertCardPayload): EmailPayload {
  const level = String(payload.level || '').toUpperCase();
  const subject = `【${level || '风控'}告警】${payload.symbol} ${payload.name}`;
  const levelColor = level === 'HIGH' ? '#cf1322' : level === 'MEDIUM' ? '#fa8c16' : '#999999';
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 16px; color: #333">
  <h2 style="color: ${levelColor}; margin: 0 0 12px">🚨 ${level || ''} 风控告警</h2>
  <p style="margin: 0 0 8px"><strong>股票：</strong>${escapeHtml(payload.symbol)} ${escapeHtml(
    payload.name
  )}</p>
  <p style="margin: 0 0 8px"><strong>告警等级：</strong><span style="color:${levelColor}">${escapeHtml(
    level
  )}</span></p>
  <p style="margin: 0 0 8px"><strong>触发规则：</strong>${escapeHtml(payload.rule_id)}</p>
  <p style="margin: 0 0 8px"><strong>触发时间：</strong>${escapeHtml(payload.triggered_at)}</p>
  <hr style="border: 0; border-top: 1px solid #eee; margin: 16px 0" />
  <p style="margin: 0 0 12px">${escapeHtml(payload.message)}</p>
  <p style="margin: 16px 0 0">
    <a href="${escapeHtmlAttr(
      payload.deeplink_url
    )}" style="background:${levelColor};color:#fff;padding:8px 16px;text-decoration:none;border-radius:4px;display:inline-block">查看 AI 解读 →</a>
  </p>
  <p style="margin: 24px 0 0; color: #999; font-size: 12px">${escapeHtml(
    payload.alert_id_dispatch
  )}</p>
</div>
  `.trim();
  const text =
    `[${level} 告警] ${payload.symbol} ${payload.name}\n` +
    `规则: ${payload.rule_id}\n` +
    `触发时间: ${payload.triggered_at}\n\n` +
    `${payload.message}\n\n` +
    `查看 AI 解读: ${payload.deeplink_url}\n` +
    `Alert ID: ${payload.alert_id_dispatch}`;
  return { subject, html, text };
}

/**
 * 构造阿里云短信 payload —— 用 env 取签名/模板，模板变量塞 4 个字段。
 *
 * 模板示例（阿里云后台审核）：
 *   "QuantX风控告警：${symbol} ${level}级，${rule}触发；详情见APP通知"
 *
 * 变量名 / 模板 code 由 caller 通过 env 配置；本函数只负责拼装；接收方手机号
 * 由 caller 在 sendSms 时单独传。
 */
export function buildRiskAlertSmsParams(
  payload: RealtimeAlertCardPayload,
  env: NodeJS.ProcessEnv = process.env
): SmsPayload {
  const signName = String(env[SMS_SIGN_NAME_ENV] || '').trim() || 'QuantX量化';
  const templateCode = String(env[SMS_TEMPLATE_RISK_ALERT_ENV] || '').trim();
  const level = String(payload.level || '').toUpperCase();
  return {
    signName,
    templateCode,
    templateParam: {
      symbol: safeText(payload.symbol, 24) || '—',
      name: safeText(payload.name, 16) || '—',
      level: level || '—',
      rule: safeText(payload.rule_id, 24) || '—',
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeString(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function safeText(value: any, maxLength: number): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function escapeHtml(value: any): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(value: any): string {
  return escapeHtml(value);
}

function randHex4(): string {
  const n = Math.floor(Math.random() * 0xffff);
  return n.toString(16).padStart(4, '0');
}

function nowMs(): number {
  return Date.now();
}

function nowShanghaiIso(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
}

// ---------------------------------------------------------------------------
// DataSource interface (DI seam)
// ---------------------------------------------------------------------------

export interface RealtimeAlertDispatcherDataSource {
  /** 取该 user 的 normalized config + username；user 不存在返回 null */
  loadUserConfig(
    user_id: number
  ): Promise<{ username: string; config: NotificationChannelsConfig } | null>;
  /** Load existing realtime-alert dedup buffer from User.risk_config.realtime_alert_seen */
  loadSeenRecords(user_id: number): Promise<RealtimeAlertSeenRecord[]>;
  /** Persist updated seen records (LRU trim already applied by caller). */
  saveSeenRecords(user_id: number, records: RealtimeAlertSeenRecord[]): Promise<void>;
  /** Call FeishuBotWebhookService.sendRiskAlertCard */
  sendFeishuCard(
    payload: RealtimeAlertCardPayload,
    webhook_url: string
  ): Promise<FeishuBotWebhookSendResult>;
  /** Call EmailNotificationService.sendEmail */
  sendEmail(
    payload: RealtimeAlertCardPayload,
    address: string
  ): Promise<EmailNotificationSendResult>;
  /** Call AliyunSmsService.sendSms */
  sendSms(payload: RealtimeAlertCardPayload, phone: string): Promise<AliyunSmsSendResult>;
}

// ---------------------------------------------------------------------------
// Default (production) DataSource — Sequelize + adapters
// ---------------------------------------------------------------------------

export class DefaultRealtimeAlertDispatcherDataSource implements RealtimeAlertDispatcherDataSource {
  // Batch X (2026-06-17, notif-4 fix): loadUserConfig 60s cache 防 DB 风暴.
  // 之前每条 HIGH alert 调 1 次 → 高频 alert (盘中暴跌时 N 条/min) 让 User 表
  // findByPk 风暴. notification config 不会 sub-minute 改, 60s cache 安全.
  // 同 user 并发 update notification config 后最坏延迟 60s 真生效, 可接受.
  private userConfigCache = new Map<number, { ts: number; data: any }>();
  private static USER_CONFIG_CACHE_TTL_MS = 60_000;

  async loadUserConfig(user_id: number) {
    const cached = this.userConfigCache.get(user_id);
    if (
      cached &&
      Date.now() - cached.ts < DefaultRealtimeAlertDispatcherDataSource.USER_CONFIG_CACHE_TTL_MS
    ) {
      return cached.data;
    }
    const user = await User.findByPk(user_id, {
      attributes: ['username', 'risk_config'],
      raw: true,
    });
    if (!user) {
      this.userConfigCache.set(user_id, { ts: Date.now(), data: null });
      return null;
    }
    const data = {
      username: (user as any).username,
      config: normalizeNotificationConfig((user as any).risk_config),
    };
    this.userConfigCache.set(user_id, { ts: Date.now(), data });
    return data;
  }

  /** Batch X: 让 settings update 路径手动 invalidate */
  invalidateUserConfigCache(user_id: number): void {
    this.userConfigCache.delete(user_id);
  }

  async loadSeenRecords(user_id: number): Promise<RealtimeAlertSeenRecord[]> {
    const user = await User.findByPk(user_id, { attributes: ['risk_config'], raw: true });
    if (!user) return [];
    const rc = (user as any).risk_config;
    if (!rc || typeof rc !== 'object') return [];
    const raw = (rc as any).realtime_alert_seen;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (r: any): r is RealtimeAlertSeenRecord =>
          r && typeof r.signature === 'string' && Number.isFinite(r.pushed_at_ms)
      )
      .map((r: any) => ({ signature: r.signature, pushed_at_ms: Number(r.pushed_at_ms) }));
  }

  async saveSeenRecords(user_id: number, records: RealtimeAlertSeenRecord[]): Promise<void> {
    const user = await User.findByPk(user_id);
    if (!user) return;
    const rc =
      (user as any).risk_config && typeof (user as any).risk_config === 'object'
        ? { ...(user as any).risk_config }
        : {};
    rc.realtime_alert_seen = records;
    (user as any).risk_config = rc;
    // 复用 US-017 JSONB mutation pattern — 必须显式 .changed('risk_config', true)
    user.changed('risk_config', true);
    await user.save();
  }

  async sendFeishuCard(payload: RealtimeAlertCardPayload, webhook_url: string) {
    return feishuBotWebhookService.sendRiskAlertCard(payload, webhook_url, {
      buildCard: buildRiskAlertFeishuCard,
    });
  }

  async sendEmail(payload: RealtimeAlertCardPayload, address: string) {
    return emailNotificationService.sendEmail(payload, address, {
      buildEmail: buildRiskAlertEmail,
    });
  }

  async sendSms(payload: RealtimeAlertCardPayload, phone: string) {
    return aliyunSmsService.sendSms(payload, phone, {
      buildSmsParams: p => buildRiskAlertSmsParams(p as RealtimeAlertCardPayload),
    });
  }
}

export const PRODUCTION_REALTIME_ALERT_DISPATCHER_DATA_SOURCE: RealtimeAlertDispatcherDataSource =
  new DefaultRealtimeAlertDispatcherDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  /** dry_run = true 时不实际推送 + 不写 dedup buffer */
  dry_run?: boolean;
  /** 前端 deeplink base url override（缺省 env or 默认） */
  frontend_base_url?: string;
  /** 测试 / 重放用 — 覆盖 nowMs（dedup 时间窗判定基准） */
  now_ms_override?: number;
}

export class RealtimeAlertDispatcher {
  private readonly dataSource: RealtimeAlertDispatcherDataSource;

  constructor(
    dataSource: RealtimeAlertDispatcherDataSource = PRODUCTION_REALTIME_ALERT_DISPATCHER_DATA_SOURCE
  ) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 —— risk guards 在 RiskAlert.create 后调用本方法 fire-and-forget。
   *
   * 流程：
   *   (1) level !== HIGH → skip
   *   (2) load user config + dedup buffer
   *   (3) 30 min dedup hit → skip（不写 dedup，让原 record TTL 走完）
   *   (4) 并行 fan-out 3 channel (Promise.allSettled fail-OPEN per channel)
   *   (5) 至少一个 channel sent → 写 dedup record（dry_run 不写）
   *
   * 所有错误吞回 RealtimeAlertDispatchResult.status='failed' + log.warn，绝不
   * throw —— 让 caller fire-and-forget 安全 (.catch(()=>{}) 也行)。
   */
  async dispatch(
    input: RealtimeAlertInput,
    options: DispatchOptions = {}
  ): Promise<RealtimeAlertDispatchResult> {
    const dryRun = options.dry_run === true;
    const triggered_at = input.triggered_at || nowShanghaiIso();
    const rule_id = String(input.rule_id || 'unknown').trim() || 'unknown';
    const signature = buildAlertSignature({
      rule_id,
      symbol: input.symbol,
      level: input.level,
      // Batch X (notif-3): 传 message 让升级告警 (drawdown 10% → 15%) 突破 dedup.
      message: input.message,
    });
    const alert_id_dispatch = buildAlertId(input.user_id, triggered_at, randHex4());
    const baseUrl = options.frontend_base_url || process.env.FRONTEND_BASE_URL || undefined;
    const deeplink_url = buildAlertDeeplink(input.symbol, alert_id_dispatch, baseUrl);

    const baseResult: RealtimeAlertDispatchResult = {
      alert_id_dispatch,
      user_id: input.user_id,
      symbol: input.symbol,
      level: String(input.level || '').toUpperCase(),
      rule_id,
      signature,
      status: REALTIME_ALERT_STATUS.SKIPPED,
      sent_any: false,
      dry_run: dryRun,
      deduped: false,
      channels: [],
    };

    // ---- (1) level gate -----------------------------------------------------
    if (String(input.level || '').toUpperCase() !== REALTIME_ALERT_TRIGGER_LEVEL) {
      return {
        ...baseResult,
        skip_reason: `level=${input.level} 非 ${REALTIME_ALERT_TRIGGER_LEVEL}，跳过实时推送`,
      };
    }

    // ---- (2) load user + dedup buffer --------------------------------------
    let userInfo: { username: string; config: NotificationChannelsConfig } | null = null;
    try {
      userInfo = await this.dataSource.loadUserConfig(input.user_id);
    } catch (err: any) {
      logger.warn(
        `[RealtimeAlertDispatcher] loadUserConfig user=${input.user_id} 失败: ${
          err?.message || err
        }`
      );
      return {
        ...baseResult,
        status: REALTIME_ALERT_STATUS.FAILED,
        skip_reason: `加载用户配置失败: ${err?.message || err}`,
      };
    }
    if (!userInfo) {
      return {
        ...baseResult,
        skip_reason: '用户不存在',
      };
    }

    let seenRecords: RealtimeAlertSeenRecord[] = [];
    try {
      seenRecords = await this.dataSource.loadSeenRecords(input.user_id);
    } catch (err: any) {
      // dedup 加载失败不阻塞推送（fail-OPEN），但记录 warn
      logger.warn(
        `[RealtimeAlertDispatcher] loadSeenRecords user=${input.user_id} 失败: ${
          err?.message || err
        }`
      );
    }

    // ---- (3) 30 min dedup check --------------------------------------------
    const now = Number.isFinite(options.now_ms_override)
      ? Number(options.now_ms_override)
      : nowMs();
    const existingRec = seenRecords.find(r => r.signature === signature);
    if (isWithinDedupWindow(existingRec, now)) {
      return {
        ...baseResult,
        deduped: true,
        skip_reason: `dedup: 30 分钟内已推送过 ${signature}`,
      };
    }

    // ---- (4) fan-out 3 channel ---------------------------------------------
    // Capture userInfo into a non-nullable local so closures below don't need
    // non-null assertion (`userInfo!`); narrowing inside async closures is lost
    // across the Promise boundary.
    const userConfig = userInfo.config;
    const cardPayload: RealtimeAlertCardPayload = {
      alert_id_dispatch,
      user_id: input.user_id,
      symbol: input.symbol,
      name: input.name,
      level: String(input.level || '').toUpperCase(),
      message: input.message,
      rule_id,
      triggered_at,
      deeplink_url,
    };

    const hasFeishuEnvFallback = !!(
      process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK
    );
    const feishuGate = shouldDispatchForChannel(
      userConfig,
      REALTIME_ALERT_CHANNELS.FEISHU,
      hasFeishuEnvFallback
    );
    const emailGate = shouldDispatchForChannel(userConfig, REALTIME_ALERT_CHANNELS.EMAIL, false);
    const smsGate = shouldDispatchForChannel(userConfig, REALTIME_ALERT_CHANNELS.SMS, false);

    const feishuPromise = this.runChannel(
      REALTIME_ALERT_CHANNELS.FEISHU,
      feishuGate,
      dryRun,
      async () => {
        const webhookUrl =
          safeString(userConfig.feishu.webhook_url) ||
          safeString(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK) ||
          safeString(process.env.FEISHU_BOT_WEBHOOK);
        const r = await this.dataSource.sendFeishuCard(cardPayload, webhookUrl);
        return adaptChannelResult(REALTIME_ALERT_CHANNELS.FEISHU, r);
      }
    );
    const emailPromise = this.runChannel(
      REALTIME_ALERT_CHANNELS.EMAIL,
      emailGate,
      dryRun,
      async () => {
        const addr = safeString(userConfig.email.address);
        const r = await this.dataSource.sendEmail(cardPayload, addr);
        return adaptChannelResult(REALTIME_ALERT_CHANNELS.EMAIL, r);
      }
    );
    const smsPromise = this.runChannel(REALTIME_ALERT_CHANNELS.SMS, smsGate, dryRun, async () => {
      const phone = safeString(userConfig.sms.phone);
      const r = await this.dataSource.sendSms(cardPayload, phone);
      return adaptChannelResult(REALTIME_ALERT_CHANNELS.SMS, r);
    });

    const settled = await Promise.allSettled([feishuPromise, emailPromise, smsPromise]);
    const channels: RealtimeAlertChannelResult[] = settled.map((s, idx) => {
      const channel = [
        REALTIME_ALERT_CHANNELS.FEISHU,
        REALTIME_ALERT_CHANNELS.EMAIL,
        REALTIME_ALERT_CHANNELS.SMS,
      ][idx];
      if (s.status === 'fulfilled') return s.value;
      // 防御 — runChannel 应该已经把所有 error 吞回 fulfilled，但万一漏了仍然兜底
      return {
        channel,
        status: REALTIME_ALERT_STATUS.FAILED,
        sent: false,
        message: `[fallback] ${(s.reason as any)?.message || String(s.reason)}`,
      };
    });

    const sentAny = channels.some(c => c.sent);
    const sentCount = channels.filter(c => c.sent).length;
    const failedCount = channels.filter(c => c.status === REALTIME_ALERT_STATUS.FAILED).length;
    const eligibleCount = channels.filter(c => c.status !== REALTIME_ALERT_STATUS.SKIPPED).length;

    let status: RealtimeAlertStatus;
    if (eligibleCount === 0) {
      status = REALTIME_ALERT_STATUS.SKIPPED; // 所有 channel 都被 gate 跳过
    } else if (sentCount === eligibleCount) {
      status = REALTIME_ALERT_STATUS.SENT;
    } else if (sentCount > 0) {
      status = REALTIME_ALERT_STATUS.PARTIAL;
    } else if (failedCount > 0) {
      status = REALTIME_ALERT_STATUS.FAILED;
    } else {
      status = REALTIME_ALERT_STATUS.SKIPPED;
    }

    // ---- (5) write dedup record (only when not dry-run AND at least one sent) ----
    if (!dryRun && sentAny) {
      try {
        const merged = mergeSeenAlertSignatures(seenRecords, [{ signature, pushed_at_ms: now }]);
        await this.dataSource.saveSeenRecords(input.user_id, merged);
      } catch (err: any) {
        // 写 dedup 失败不阻塞返回（fail-OPEN）— 下一次同 signature 不会被 dedup
        // 影响仅限"可能重复推送一次"，比"漏推 HIGH 告警" 风险小得多。
        logger.warn(
          `[RealtimeAlertDispatcher] saveSeenRecords user=${input.user_id} 失败: ${
            err?.message || err
          }`
        );
      }
    }

    return {
      ...baseResult,
      status,
      sent_any: sentAny,
      channels,
    };
  }

  /**
   * 单 channel 包装：gate skip / dry_run skip / try-catch fail-OPEN 三处兜底。
   * 任何错误都包成 ChannelResult 返回，绝不 throw（让 Promise.allSettled 干净）。
   */
  private async runChannel(
    channel: RealtimeAlertChannel,
    gate: { shouldSend: boolean; reason?: string },
    dryRun: boolean,
    invoke: () => Promise<RealtimeAlertChannelResult>
  ): Promise<RealtimeAlertChannelResult> {
    if (!gate.shouldSend) {
      return {
        channel,
        status: REALTIME_ALERT_STATUS.SKIPPED,
        sent: false,
        message: gate.reason,
      };
    }
    if (dryRun) {
      return {
        channel,
        status: REALTIME_ALERT_STATUS.SKIPPED,
        sent: false,
        message: 'dry_run',
      };
    }
    try {
      return await invoke();
    } catch (err: any) {
      const msg = err?.message || String(err);
      logger.warn(`[RealtimeAlertDispatcher] channel=${channel} 异常: ${msg}`);
      return {
        channel,
        status: REALTIME_ALERT_STATUS.FAILED,
        sent: false,
        message: msg,
      };
    }
  }

  /**
   * fire-and-forget 入口 — risk guards 在 RiskAlert.create 后调用本方法
   * 不需要 await。本方法内部 try/catch 彻底吞错（log warn），保证主调用方
   * 不被网络延迟阻塞、不产生 unhandled promise rejection。
   */
  fireAndForget(input: RealtimeAlertInput, options: DispatchOptions = {}): void {
    this.dispatch(input, options).catch(err => {
      // dispatch 内部已经 fail-OPEN 不应该 throw，这里是最后一道防御
      logger.warn(
        `[RealtimeAlertDispatcher] fireAndForget 未捕获异常 user=${input.user_id} alert=${
          input.alert_id ?? '?'
        }: ${err?.message || err}`
      );
    });
  }
}

/**
 * 把单 channel adapter 的 {success, skipped, message, data} 适配成
 * RealtimeAlertChannelResult。
 */
function adaptChannelResult(
  channel: RealtimeAlertChannel,
  raw: FeishuBotWebhookSendResult | EmailNotificationSendResult | AliyunSmsSendResult
): RealtimeAlertChannelResult {
  if (raw.success) {
    return {
      channel,
      status: REALTIME_ALERT_STATUS.SENT,
      sent: true,
      data: raw.data,
    };
  }
  if (raw.skipped) {
    return {
      channel,
      status: REALTIME_ALERT_STATUS.SKIPPED,
      sent: false,
      message: raw.message,
      data: raw.data,
    };
  }
  return {
    channel,
    status: REALTIME_ALERT_STATUS.FAILED,
    sent: false,
    message: raw.message || `${channel} 推送失败`,
    data: raw.data,
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const realtimeAlertDispatcher = new RealtimeAlertDispatcher();
