/**
 * EmailNotificationService — US-065 邮件推送 channel adapter
 *
 * 与 FeishuBotWebhookService 完全镜像（同款 buildXxx 注入式 / fail-OPEN /
 * env 配置 / 单条 send method 命名规范），但底层通道走 SMTP。
 *
 * 设计要点：
 *  1. **lazy-require nodemailer**：在第一次 send 时才 `require('nodemailer')`，
 *     让本文件在 nodemailer 未安装的环境（如 CI 单测前置 / 老版本 worktree）
 *     仍能 import + typecheck，只有真正发邮件时才报错 → 转入 fail-OPEN 分支。
 *  2. **DataSource 注入 buildEmail helper**：caller (WeeklyReviewReportService)
 *     传 `buildEmail(payload) → { subject, html, text? }` 函数，本 adapter
 *     不知道周报 HTML schema —— 只负责 dispatch + smtp 错误处理。与 US-063
 *     FeishuBotWebhookService 同款反向依赖避免范式。
 *  3. **SMTP 配置 6 个 env**：SMTP_HOST / SMTP_PORT (默认 587) / SMTP_USER /
 *     SMTP_PASS / SMTP_SECURE (默认 false = STARTTLS) / SMTP_FROM (默认
 *     `process.env.SMTP_USER`)。`DISABLE_EMAIL_NOTIFICATION=true` 一键禁用
 *     (与 DISABLE_FEISHU_BOT_WEBHOOK 同款)。
 *  4. **Transporter 缓存**：单进程内 transporter 只创建一次（每次 send 创建
 *     会有几百毫秒 TCP 握手延迟），但 env 变化时手动调 `resetTransporter()`
 *     清缓存。
 *  5. **fail-OPEN**：所有错误返回 `{success:false, message}`，不 throw —— 让
 *     scheduler 不挂，上层 service 收到结果后决定 status='failed' / 'skipped'。
 */

import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

export interface EmailNotificationSendResult {
  success: boolean;
  /** 与 FeishuBotWebhookSendResult.skipped 同语义：not-an-error 但未发 */
  skipped?: boolean;
  message?: string;
  /** SMTP messageId / accepted recipients / smtp response 等 */
  data?: any;
}

export interface EmailPayload {
  subject: string;
  html: string;
  text?: string;
}

/** 第一次 send 前确定的 smtp config snapshot —— 不在每次 send 时重读 env */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  from: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 从 env 读取并 normalize SMTP config。任一必填字段缺失返回 null（caller fail-OPEN）。
 * - `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` 必填
 * - `SMTP_PORT` 默认 587（STARTTLS），465 通常对应 secure=true
 * - `SMTP_SECURE`: "true" / "1" / "yes" → true，其他 → false
 * - `SMTP_FROM` 默认走 `SMTP_USER`（多数 SMTP 服务要求 from=auth user）
 */
export function readSmtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = safeString(env.SMTP_HOST);
  const user = safeString(env.SMTP_USER);
  const pass = safeString(env.SMTP_PASS);
  if (!host || !user || !pass) return null;
  const port = parsePortOrDefault(env.SMTP_PORT, 587);
  const secure = parseBoolean(env.SMTP_SECURE, false);
  const from = safeString(env.SMTP_FROM) || user;
  return { host, port, user, pass, secure, from };
}

/**
 * 是否禁用邮件通知（DISABLE_EMAIL_NOTIFICATION=true 一键关闭）。
 */
export function isEmailDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolean(env.DISABLE_EMAIL_NOTIFICATION, false);
}

/**
 * 给邮件接收地址做最低限度校验 —— 避免一封"to: undefined"被发出去。
 * 不严格做 RFC 5322 校验（太复杂），只确保有 `local@domain` 形态。
 */
export function isValidEmailAddress(addr: string): boolean {
  if (!addr || typeof addr !== 'string') return false;
  const trimmed = addr.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return false;
  if (!domain.includes('.')) return false;
  // 拒绝空格 / 控制字符
  if (/[\s<>"]/.test(trimmed)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeString(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function parseBoolean(v: any, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const lower = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  return fallback;
}

function parsePortOrDefault(v: any, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

// ---------------------------------------------------------------------------
// Transporter cache
// ---------------------------------------------------------------------------

/**
 * 单进程 transporter cache —— SMTP TCP 握手 + auth ~ 300ms，每次 send 都重建
 * 会显著增加邮件吞吐延迟（周报 N 个用户 × 300ms）。
 */
let cachedTransporter: any = null;
let cachedConfigKey: string | null = null;

function configKey(cfg: SmtpConfig): string {
  return `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.secure ? '1' : '0'}`;
}

/**
 * 强制清缓存 —— env 变化（运维改 SMTP_PASS）/ 测试需要重置时调。
 */
export function resetTransporter(): void {
  cachedTransporter = null;
  cachedConfigKey = null;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * SMTP 邮件 channel adapter。
 *
 * 与 FeishuBotWebhookService 镜像：caller 注入 buildEmail helper 决定 subject /
 * html / text 内容；本 adapter 不知道 caller schema —— 只负责 SMTP dispatch +
 * 错误处理 + fail-OPEN。
 */
export class EmailNotificationService {
  /**
   * 是否启用邮件通知（综合 env + nodemailer 是否可用）。
   */
  isEnabled(): boolean {
    if (isEmailDisabledByEnv()) return false;
    if (readSmtpConfigFromEnv() === null) return false;
    return true;
  }

  /**
   * 发送 caller 构造好的邮件 payload。
   *
   * @param payload caller 透传给 buildEmail 的输入（任何形态）；本方法不解析它
   * @param toAddress 收件人邮箱（caller 必传 —— 通常来自 user.risk_config.notification_channels.email.address）
   * @param options.buildEmail caller 提供的 payload → {subject,html,text?} 函数（必填）
   * @param options.smtpOverride 测试用 —— override env-derived smtp config（生产不传）
   */
  async sendEmail(
    payload: any,
    toAddress: string,
    options: {
      buildEmail: (payload: any) => EmailPayload;
      smtpOverride?: SmtpConfig;
      /** 测试用 —— inject nodemailer-like transporter 完全脱离 nodemailer 依赖 */
      transporterOverride?: { sendMail: (opts: any) => Promise<any> };
    }
  ): Promise<EmailNotificationSendResult> {
    if (isEmailDisabledByEnv()) {
      return {
        success: false,
        skipped: true,
        message: '邮件通知已通过环境变量禁用',
      };
    }
    const target = safeString(toAddress);
    if (!target) {
      return {
        success: false,
        skipped: true,
        message: '收件人邮箱地址为空，已跳过邮件推送',
      };
    }
    if (!isValidEmailAddress(target)) {
      return {
        success: false,
        message: `收件人邮箱地址格式非法：${target}`,
      };
    }
    if (!options?.buildEmail || typeof options.buildEmail !== 'function') {
      return {
        success: false,
        message: 'sendEmail 必须提供 options.buildEmail 以构造 subject / html',
      };
    }
    if (!payload || typeof payload !== 'object') {
      return {
        success: false,
        message: '邮件 payload 不能为空',
      };
    }

    let mailContent: EmailPayload;
    try {
      mailContent = options.buildEmail(payload);
    } catch (err: any) {
      logger.warn(`邮件 buildEmail 异常: ${err?.message || err}`);
      return { success: false, message: `buildEmail 异常: ${err?.message || err}` };
    }
    if (
      !mailContent ||
      typeof mailContent.subject !== 'string' ||
      typeof mailContent.html !== 'string' ||
      !mailContent.subject ||
      !mailContent.html
    ) {
      return {
        success: false,
        message: 'buildEmail 返回的 EmailPayload 必须含非空 subject + html',
      };
    }

    const smtpConfig = options.smtpOverride || readSmtpConfigFromEnv();
    if (!smtpConfig) {
      return {
        success: false,
        skipped: true,
        message: '未配置 SMTP（缺少 SMTP_HOST / SMTP_USER / SMTP_PASS），已跳过邮件推送',
      };
    }

    let transporter = options.transporterOverride as any;
    if (!transporter) {
      try {
        transporter = getOrCreateTransporter(smtpConfig);
      } catch (err: any) {
        const message = err?.message || String(err);
        logger.warn(`邮件 transporter 创建失败 (nodemailer 不可用?): ${message}`);
        return {
          success: false,
          skipped: true,
          message: `邮件 transporter 不可用：${message}`,
        };
      }
    }

    try {
      const sendRes = await transporter.sendMail({
        from: smtpConfig.from,
        to: target,
        subject: mailContent.subject,
        html: mailContent.html,
        text: mailContent.text,
      });
      logger.info(
        `邮件已发送 (to=${target}, subject=${mailContent.subject}, messageId=${
          sendRes?.messageId || '?'
        })`
      );
      return {
        success: true,
        data: {
          messageId: sendRes?.messageId,
          accepted: sendRes?.accepted,
          rejected: sendRes?.rejected,
          response: sendRes?.response,
        },
      };
    } catch (err: any) {
      const message = err?.message || String(err);
      logger.warn(`邮件发送失败 (to=${target}): ${message}`);
      return { success: false, message };
    }
  }
}

/**
 * Lazy-require nodemailer 并返回 cached transporter。第一次 send 前才加载，
 * 让本文件在 nodemailer 未安装时仍可 typecheck/import。
 */
function getOrCreateTransporter(cfg: SmtpConfig): any {
  const key = configKey(cfg);
  if (cachedTransporter && cachedConfigKey === key) {
    return cachedTransporter;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  cachedTransporter = transporter;
  cachedConfigKey = key;
  return transporter;
}

export const emailNotificationService = new EmailNotificationService();
