/**
 * SystemAdminAlertPusher — Batch BF-1 (2026-06-23)
 *
 * 系统级 admin 告警推送 (Lark OPS 群 + admin 邮件), 与 RealtimeAlertDispatcher
 * 互补:
 *   - RealtimeAlertDispatcher 走 **per-user** notification config (用户自己的
 *     Lark webhook / 邮箱 / 短信) — 用户关掉就收不到
 *   - SystemAdminAlertPusher 走 **env 配置** (OPS_ALERT_FEISHU_WEBHOOK /
 *     FEISHU_RECOMMENDATION_BOT_WEBHOOK fallback + ADMIN_ALERT_EMAILS CSV) —
 *     无论用户怎么配, 系统级 HIGH/CRITICAL 告警 / cron 失败 / 数据陈旧
 *     都能推到运维群里
 *
 * 用户原话: "凌晨出问题没人知道" — 当前 RiskAlert 只写 DB, 告警不推. 即使
 * RiskAlert.afterCreate hook 触发 dispatcher, 也因为 prod 2/3 用户
 * `feishu.enabled=false` 导致一条都发不出. 系统级别 fallback 必须存在.
 *
 * 抑制 (debounce):
 *   - 同 dedup_key 1 小时内最多推 1 次, 默认窗 60min (env
 *     SYSTEM_ALERT_DEDUP_WINDOW_MS 覆盖, 测试用)
 *   - 进程内 Map 存 dedup state (kv = dedup_key → last_push_ms)
 *   - 重启清空 (告警是 "宁可多推 1 次" 也比漏报好, 重启不算事故)
 *
 * 调用方:
 *   - RiskAlert.afterCreate (HIGH/CRITICAL): dedup_key=`risk:${symbol}:${level}`
 *   - SchedulerService.markTaskFinished FAILED: dedup_key=`cron:${task.type}`
 *   - DataFreshnessCheckService: dedup_key=`freshness:${item}`
 *   - DailyHealthReport: dedup_key=`daily-health:${date}` (实际不会重复, 但走同 API 一致)
 *
 * fail-OPEN: 所有内部错误吞为 warn, 绝不 throw — 主流程 (RiskAlert.create / cron
 * markFinished) 不会被告警链路阻塞.
 */

import axios from 'axios';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** dedup 默认窗口 60 min */
const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

function resolveDedupWindowMs(): number {
  const raw = process.env.SYSTEM_ALERT_DEDUP_WINDOW_MS;
  if (!raw) return DEFAULT_DEDUP_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DEDUP_WINDOW_MS;
  return n;
}

// ---------------------------------------------------------------------------
// 内部状态: dedup Map (process-local)
// ---------------------------------------------------------------------------

const dedupMap = new Map<string, number>();

/**
 * 测试 / ops 调试用 — 清空 dedup state.
 */
export function clearSystemAdminAlertDedupForTests(): void {
  dedupMap.clear();
}

/**
 * 暴露 dedup snapshot 供单测断言.
 */
export function getSystemAdminAlertDedupSnapshotForTests(): Map<string, number> {
  return new Map(dedupMap);
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type SystemAdminAlertLevel = 'INFO' | 'WARN' | 'HIGH' | 'CRITICAL';

export interface SystemAdminAlertInput {
  /** dedup 主键, e.g. `risk:sh.600519:HIGH` / `cron:DAILY_UPDATE` */
  dedup_key: string;
  /** 告警等级, 决定 card header 颜色 (CRITICAL/HIGH=红, WARN=橙, INFO=蓝) */
  level: SystemAdminAlertLevel;
  /** 一行标题, e.g. "🚨 [HIGH] sh.600519 贵州茅台 - 跌破支撑位" */
  title: string;
  /** markdown body (≤ 2000 字符 lark 限制) */
  body_markdown: string;
  /** 触发时间 ISO; 缺省 Date.now() */
  triggered_at?: string;
  /** trace_id 关联 prod log */
  trace_id?: string;
  /** 跳转 URL */
  deeplink?: string;
}

export interface SystemAdminAlertPushResult {
  pushed: boolean;
  /** dedup 命中跳过 */
  deduped: boolean;
  /** Feishu 推送结果 */
  feishu: { attempted: boolean; success: boolean; message?: string };
  /** Email 推送结果 (per recipient) */
  email: {
    attempted: boolean;
    success_count: number;
    failed_count: number;
    skipped: boolean;
    message?: string;
  };
}

// ---------------------------------------------------------------------------
// 配置解析 (env)
// ---------------------------------------------------------------------------

function resolveFeishuWebhookUrl(): string {
  return (
    String(process.env.OPS_ALERT_FEISHU_WEBHOOK || '').trim() ||
    String(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || '').trim() ||
    String(process.env.FEISHU_BOT_WEBHOOK || '').trim()
  );
}

function resolveAdminEmails(): string[] {
  const raw = String(process.env.ADMIN_ALERT_EMAILS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.includes('@'));
}

// ---------------------------------------------------------------------------
// dedup 判定
// ---------------------------------------------------------------------------

/**
 * isDeduped — 给定 dedup_key + now, 返回是否仍在 dedup 窗口内.
 * pure (export for test)
 */
export function isDedupedForKey(
  key: string,
  now: number,
  state: Map<string, number> = dedupMap,
  windowMs: number = resolveDedupWindowMs()
): boolean {
  if (!key) return false;
  const last = state.get(key);
  if (!Number.isFinite(last)) return false;
  return now - (last as number) < windowMs;
}

/** record key → now (LRU trim 不需要, 历史 key 自然过期, 内存占用 ~ K entries × 64B) */
export function recordDedupForKey(
  key: string,
  now: number,
  state: Map<string, number> = dedupMap
): void {
  if (!key) return;
  state.set(key, now);
  // 防内存无限增长 — LRU trim 到 5000 条 (远大于业务量, 但有上限)
  if (state.size > 5000) {
    const entries = Array.from(state.entries());
    entries.sort((a, b) => a[1] - b[1]);
    const dropCount = state.size - 4000;
    for (let i = 0; i < dropCount; i++) state.delete(entries[i][0]);
  }
}

// ---------------------------------------------------------------------------
// 卡片构造
// ---------------------------------------------------------------------------

/** lark interactive card builder — pure (export for test) */
export function buildSystemAdminAlertCard(input: SystemAdminAlertInput): {
  msg_type: 'interactive';
  card: any;
} {
  const lvl = String(input.level || '').toUpperCase();
  const headerTemplate =
    lvl === 'CRITICAL'
      ? 'red'
      : lvl === 'HIGH'
        ? 'red'
        : lvl === 'WARN'
          ? 'orange'
          : 'blue';
  const triggeredAt = input.triggered_at || new Date().toISOString();
  const trace = input.trace_id ? `\ntrace_id: ${input.trace_id}` : '';
  const elements: any[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: truncateLarkMd(input.body_markdown || '_无详情_', 2000),
      },
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `触发时间: ${triggeredAt}${trace}`,
        },
      ],
    },
  ];
  if (input.deeplink) {
    elements.splice(1, 0, {
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
  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: headerTemplate,
        title: { tag: 'plain_text', content: input.title || `[${lvl}] 系统告警` },
      },
      elements,
    },
  };
}

function truncateLarkMd(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export interface SystemAdminAlertPusherOptions {
  /** 测试 — 替换 dedup state (默认进程内 dedupMap) */
  dedup_state?: Map<string, number>;
  /** 测试 — 替换 now (默认 Date.now()) */
  now_ms?: number;
  /** 测试 — 替换 axios post */
  feishu_post?: (url: string, body: any) => Promise<any>;
  /** 测试 — 替换 emailNotificationService.sendEmail */
  email_send?: (
    address: string,
    subject: string,
    html: string
  ) => Promise<{ success: boolean; message?: string }>;
  /** 测试 — 强制不 dedup (bypass) */
  skip_dedup?: boolean;
  /** 测试 — 覆盖 dedup window */
  dedup_window_ms?: number;
}

/**
 * 推送系统级 admin 告警. 主流程 fail-OPEN, 永不 throw.
 */
export async function pushSystemAdminAlert(
  input: SystemAdminAlertInput,
  options: SystemAdminAlertPusherOptions = {}
): Promise<SystemAdminAlertPushResult> {
  const now = Number.isFinite(options.now_ms) ? Number(options.now_ms) : Date.now();
  const state = options.dedup_state || dedupMap;
  const windowMs = Number.isFinite(options.dedup_window_ms)
    ? Number(options.dedup_window_ms)
    : resolveDedupWindowMs();

  const result: SystemAdminAlertPushResult = {
    pushed: false,
    deduped: false,
    feishu: { attempted: false, success: false },
    email: { attempted: false, success_count: 0, failed_count: 0, skipped: false },
  };

  // ---- dedup 检查 ----
  if (!options.skip_dedup && isDedupedForKey(input.dedup_key, now, state, windowMs)) {
    result.deduped = true;
    return result;
  }

  // ---- Feishu ----
  const feishuUrl = resolveFeishuWebhookUrl();
  if (!feishuUrl) {
    result.feishu = {
      attempted: false,
      success: false,
      message:
        '未配置 OPS_ALERT_FEISHU_WEBHOOK / FEISHU_RECOMMENDATION_BOT_WEBHOOK / FEISHU_BOT_WEBHOOK',
    };
  } else {
    result.feishu.attempted = true;
    try {
      const card = buildSystemAdminAlertCard(input);
      // 校验 URL 安全 (复用 webhookUrlGuard SSRF 防护)
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { assertWebhookUrlAllowed } = require('../utils/webhookUrlGuard');
        assertWebhookUrlAllowed(feishuUrl, 'system_admin_alert');
      } catch (urlErr: any) {
        result.feishu.success = false;
        result.feishu.message = urlErr?.message || String(urlErr);
        logger.warn(
          `[SystemAdminAlert] feishu webhook URL invalid (dedup_key=${input.dedup_key}): ${result.feishu.message}`
        );
      }

      if (!result.feishu.message) {
        const post = options.feishu_post || defaultFeishuPost;
        const resp = await post(feishuUrl, card);
        const respData = resp?.data || resp || {};
        const code = Number(respData.code ?? respData.StatusCode ?? respData.status_code ?? 0);
        if (Number.isFinite(code) && code !== 0) {
          result.feishu.success = false;
          result.feishu.message =
            respData.msg || respData.message || respData.StatusMessage || `lark code=${code}`;
          logger.warn(
            `[SystemAdminAlert] feishu non-zero code (dedup_key=${input.dedup_key}): ${result.feishu.message}`
          );
        } else {
          result.feishu.success = true;
        }
      }
    } catch (err: any) {
      result.feishu.success = false;
      result.feishu.message = err?.message || String(err);
      logger.warn(
        `[SystemAdminAlert] feishu push failed (dedup_key=${input.dedup_key}): ${result.feishu.message}`
      );
    }
  }

  // ---- Admin Email ----
  const emails = resolveAdminEmails();
  if (emails.length === 0) {
    result.email = {
      attempted: false,
      success_count: 0,
      failed_count: 0,
      skipped: true,
      message: '未配置 ADMIN_ALERT_EMAILS',
    };
  } else {
    result.email.attempted = true;
    const sendFn = options.email_send || defaultEmailSend;
    const subject = `[${String(input.level || 'INFO').toUpperCase()}] ${input.title || '系统告警'}`;
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;padding:16px;color:#333">
<h2 style="margin:0 0 12px">${escapeHtml(input.title || '系统告警')}</h2>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:13px">${escapeHtml(
      input.body_markdown || ''
    )}</pre>
<p style="color:#999;font-size:12px;margin:16px 0 0">触发时间: ${escapeHtml(
      input.triggered_at || new Date().toISOString()
    )}${input.trace_id ? ` &middot; trace_id: ${escapeHtml(input.trace_id)}` : ''}</p>
${
  input.deeplink
    ? `<p style="margin:16px 0 0"><a href="${escapeHtml(input.deeplink)}" style="background:#1677ff;color:#fff;padding:8px 16px;text-decoration:none;border-radius:4px;display:inline-block">查看详情 →</a></p>`
    : ''
}
</div>`;
    for (const addr of emails) {
      try {
        const r = await sendFn(addr, subject, html);
        if (r?.success) result.email.success_count += 1;
        else {
          result.email.failed_count += 1;
          logger.warn(
            `[SystemAdminAlert] admin email to ${addr} failed (dedup_key=${input.dedup_key}): ${r?.message || 'unknown'}`
          );
        }
      } catch (err: any) {
        result.email.failed_count += 1;
        logger.warn(
          `[SystemAdminAlert] admin email to ${addr} threw (dedup_key=${input.dedup_key}): ${err?.message || err}`
        );
      }
    }
  }

  // ---- record dedup (无论 feishu/email 单点是否成功; 整体只要触发过就 mark) ----
  if (!options.skip_dedup) {
    recordDedupForKey(input.dedup_key, now, state);
  }
  result.pushed = result.feishu.success || result.email.success_count > 0;
  return result;
}

/**
 * fire-and-forget 包装 — caller (RiskAlert.afterCreate / SchedulerService) 用.
 */
export function pushSystemAdminAlertFireAndForget(input: SystemAdminAlertInput): void {
  pushSystemAdminAlert(input).catch(err => {
    logger.warn(
      `[SystemAdminAlert] fireAndForget unexpected throw (dedup_key=${input.dedup_key}): ${err?.message || err}`
    );
  });
}

// ---------------------------------------------------------------------------
// 默认实现 (生产)
// ---------------------------------------------------------------------------

async function defaultFeishuPost(url: string, body: any): Promise<any> {
  return axios.post(url, body, {
    timeout: Number(process.env.SYSTEM_ALERT_FEISHU_TIMEOUT_MS || 8000),
    maxRedirects: 0,
    validateStatus: (s: number) => s >= 200 && s < 300,
  });
}

async function defaultEmailSend(
  address: string,
  subject: string,
  html: string
): Promise<{ success: boolean; message?: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { emailNotificationService } = require('./EmailNotificationService');
    const r = await emailNotificationService.sendEmail({ subject, html }, address, {
      buildEmail: () => ({ subject, html, text: stripHtml(html) }),
    });
    return { success: r?.success === true, message: r?.message };
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) };
  }
}

function escapeHtml(value: any): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(s: string): string {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
