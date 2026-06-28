/**
 * RiskAlertService.ts — [OPS-005] 标准 RiskAlert dispatcher.
 *
 * 项目历史里告警写入逻辑长期是「每个 caller 自己 `RiskAlert.create(...)` +
 * 各自决定要不要再额外通知飞书 / 邮件」的散落实现：
 *   - audit-task-parameters-dry-run.ts 自己实现了 risk_alert + feishu_ops 双通道
 *   - RealtimeAlertDispatcher（US-067）只覆盖 level='HIGH' 的「实时风控」路径
 *     并且强绑定用户 risk_config（feishu / email / sms 个性化通道）
 *   - PositionLimitGuard / TrailingStopGuard / BlackSwanWatchdog 等 8 个 guards
 *     直接 RiskAlert.create({...})，由 model afterCreate hook 触发 dispatcher
 *
 * OPS-005 引入一个 **简单、按 severity 路由的标准入口**，让任何 server-side
 * 模块在「想发一条系统级风控告警」时有一个统一的接口（而不是再去 copy 一份
 * 散乱的逻辑）：
 *
 *   import { riskAlertService, RISK_ALERT_SEVERITY } from './RiskAlertService';
 *   await riskAlertService.write({
 *     user_id, symbol, name, message,
 *     severity: RISK_ALERT_SEVERITY.CRITICAL,
 *     rule_id: 'drawdown_breaker',
 *   });
 *
 * **路由规则（AC）**：
 *
 *   severity=critical  → 飞书 OPS 群 + IM(email) + toast(inbox is_read=false, badge)
 *                        + DB RiskAlert（level 写 'HIGH' 保持 dispatcher 兼容）
 *   severity=high      → 飞书 OPS 群 + DB RiskAlert（level='HIGH'）
 *                        + 触发 RealtimeAlertDispatcher（用户个性化 feishu/email/sms）
 *   severity=medium    → 仅 inbox（DB RiskAlert level='MEDIUM'，is_read=false → 出现在
 *                        AlertsPanel 收件箱）
 *
 * 「toast」在前后端契约里表示「实时弹窗 + AlertsBell badge 闪动」，落地手段
 * 是 RiskAlert 行写入后由 RealtimeAlertSubscriptionService（前端 polling）抓取
 * 并显示。本 service 不直接推 WebSocket（那是 FE-034 的范畴），它通过
 * `metadata.toast=true` 给前端附标记，让 AlertsBell 能区分「需要弹窗」vs
 * 「仅入收件箱」。
 *
 * 「IM」按现状取 email（user.email）；未来扩展短信 / 企业微信时本 service 是
 * 唯一的扩展点。
 *
 * 与既有 dispatcher 的关系：
 *   - 不取代 RealtimeAlertDispatcher：当 severity ∈ {critical, high} 且 user 有
 *     个性化通道时，本 service 会触发 dispatcher.fireAndForget（在 RiskAlert
 *     afterCreate hook 之外再补一道路径，让 hook 失效时 ops 仍能收到）
 *   - 不取代 audit-task-parameters-dry-run.ts：那个脚本有特殊的 task plan
 *     gating + 模板逻辑，独立保留；它写 RiskAlert 走 model hook 即可
 *
 * **设计原则（与项目其他 service 一致）**：
 *   - DataSource DI seam：单测注入 fake，完全脱离 DB / 网络
 *   - 纯函数 helpers 全 export：normalizeSeverity / buildChannelPlan / buildOpsAlertText
 *   - Promise.allSettled 并行 fan-out + per-channel try/catch fail-OPEN
 *   - 顶层 try/catch 兜底 — 主流程绝不被告警链路阻塞
 *   - 三级 severity 严格枚举（不接收 free-form string）
 */

import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/**
 * 三级严重度。**不要新增** —— 任何介于「critical / high / medium」之间的
 * 细分都用 rule_id / metadata.tag 区分；本 enum 是路由表的 key，扩展会让
 * channel plan 全套测试矩阵翻倍。
 */
export const RISK_ALERT_SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
} as const);

export type RiskAlertSeverity = (typeof RISK_ALERT_SEVERITY)[keyof typeof RISK_ALERT_SEVERITY];

/** 支持的 channel 名（与 result.channels[] 的 key 一一对应）。 */
export const RISK_ALERT_CHANNELS = Object.freeze([
  /** DB 写入（RiskAlert 行），所有 severity 都会走这条 */
  'inbox',
  /** 飞书 OPS 群（OPS_ALERT_FEISHU_WEBHOOK），critical/high 走这条 */
  'feishu',
  /** IM 推送（当前实现 = 用户邮箱），critical 走这条 */
  'im',
  /** 前端弹窗标记（写入 metadata.toast=true），critical 走这条 */
  'toast',
] as const);
export type RiskAlertChannel = (typeof RISK_ALERT_CHANNELS)[number];

/** severity → RiskAlert.level 字段映射（保持与既有 dispatcher hook 兼容）。 */
export const SEVERITY_TO_LEVEL: Readonly<Record<RiskAlertSeverity, 'HIGH' | 'MEDIUM'>> =
  Object.freeze({
    [RISK_ALERT_SEVERITY.CRITICAL]: 'HIGH',
    [RISK_ALERT_SEVERITY.HIGH]: 'HIGH',
    [RISK_ALERT_SEVERITY.MEDIUM]: 'MEDIUM',
  });

/** severity → channel plan（严格按 AC：critical→3 外部 channel, high→feishu, medium→空）。 */
export const SEVERITY_TO_CHANNELS: Readonly<
  Record<RiskAlertSeverity, ReadonlyArray<RiskAlertChannel>>
> = Object.freeze({
  [RISK_ALERT_SEVERITY.CRITICAL]: ['inbox', 'feishu', 'im', 'toast'],
  [RISK_ALERT_SEVERITY.HIGH]: ['inbox', 'feishu'],
  [RISK_ALERT_SEVERITY.MEDIUM]: ['inbox'],
});

export interface RiskAlertWriteInput {
  user_id: number;
  symbol: string;
  name: string;
  message: string;
  severity: RiskAlertSeverity;
  /** dedup signature 的一部分 — 调用方必须传，缺省时落 'unknown' */
  rule_id?: string;
  /** 附加结构化字段（metadata.toast 由本 service 注入；caller 不要覆盖） */
  metadata?: Record<string, any>;
}

export interface RiskAlertChannelResult {
  channel: RiskAlertChannel;
  attempted: boolean;
  success: boolean;
  /** 跳过原因（如 feishu webhook 未配置） */
  skipped?: boolean;
  /** 通道返回的引用 ID（DB 行 ID / message ID 等） */
  ref_id?: number | string;
  message?: string;
  error?: string;
}

export interface RiskAlertWriteResult {
  severity: RiskAlertSeverity;
  /** 实际计划走的 channel（按 plan 顺序） */
  planned_channels: RiskAlertChannel[];
  /** 每个 channel 的执行结果 */
  channels: RiskAlertChannelResult[];
  /** 写入的 RiskAlert.id（inbox 成功才有） */
  alert_id?: number;
  /** 顶层错误（极少触发；正常通道失败走 channels[].error） */
  error?: string;
}

export interface RiskAlertWriteOptions {
  /** 强制走某个 channel 集合，覆盖 severity 默认 plan（测试 / 特殊场景） */
  override_channels?: RiskAlertChannel[];
  /** 不实际发送（让 UI 预览） */
  dry_run?: boolean;
  /** 取决于 caller — 默认从 env / user 表读取 */
  feishu_webhook_url?: string;
  /** 取决于 caller — 默认从 user 表读取 */
  im_address?: string;
  /**
   * Phase 10 通知审计 (2026-06-28) — 强制走 runFeishu text 推送, 即便 inbox 已写入
   * 且 afterCreate hook 会推一张 interactive card. 默认 false: 让 hook card 成为
   * 唯一 ops 推送源避免双推. 仅 audit-task-parameters-dry-run.ts 等需要纯文本格式
   * 的 caller 应显式打开.
   */
  force_feishu_text?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * normalizeSeverity — 把任意输入归一化到三级 severity。
 * - 已是枚举值 → 直接返回
 * - 大小写差异（'CRITICAL' / 'High'）→ 小写后匹配
 * - 旧字段 'HIGH'/'MEDIUM'/'LOW' 兼容映射（high → high, medium → medium, low → medium）
 * - 完全无法识别 → 返回 null（caller 必须拦截并报错；不静默归一以防误推）
 */
export function normalizeSeverity(input: unknown): RiskAlertSeverity | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === RISK_ALERT_SEVERITY.CRITICAL) return RISK_ALERT_SEVERITY.CRITICAL;
  if (s === RISK_ALERT_SEVERITY.HIGH) return RISK_ALERT_SEVERITY.HIGH;
  if (s === RISK_ALERT_SEVERITY.MEDIUM) return RISK_ALERT_SEVERITY.MEDIUM;
  // 兼容旧 RiskAlert.level 字段大写值
  if (s === 'low') return RISK_ALERT_SEVERITY.MEDIUM;
  return null;
}

/**
 * buildChannelPlan — 计算本次实际要走的 channel 列表。
 *
 *   1. options.override_channels 显式传入 → 取其有效交集
 *   2. 否则取 SEVERITY_TO_CHANNELS[severity]
 *   3. options.dry_run=true → 强制返回空数组（caller 在外层短路）
 *   4. inbox 始终保证存在（除非 dry_run）—— DB 是 "事实源"，丢了它就丢了告警
 */
export function buildChannelPlan(
  severity: RiskAlertSeverity,
  options: RiskAlertWriteOptions = {}
): RiskAlertChannel[] {
  if (options.dry_run) return [];
  let plan: RiskAlertChannel[];
  if (options.override_channels) {
    const seen = new Set<RiskAlertChannel>();
    for (const c of options.override_channels) {
      if ((RISK_ALERT_CHANNELS as ReadonlyArray<string>).includes(c)) {
        seen.add(c as RiskAlertChannel);
      }
    }
    plan = Array.from(seen);
  } else {
    plan = [...SEVERITY_TO_CHANNELS[severity]];
  }
  // inbox 始终在最前；若 caller 显式 override_channels=[] 也尊重（让单测能验空 plan）
  if (plan.length > 0 && !plan.includes('inbox')) {
    plan.unshift('inbox');
  }
  return plan;
}

/**
 * buildOpsAlertText — 给飞书 OPS 群的纯文本摘要。
 * 含 severity / symbol / message / rule_id；不含 user_id（运维群不需要个人维度）。
 */
export function buildOpsAlertText(input: RiskAlertWriteInput): string {
  const severity = String(input.severity || 'unknown').toUpperCase();
  const symbol = String(input.symbol || '').trim() || '—';
  const name = String(input.name || '').trim();
  const rule = String(input.rule_id || 'unknown').trim() || 'unknown';
  const message = String(input.message || '').trim();
  const head = `🚨 [${severity}] ${symbol}${name ? ` ${name}` : ''}`;
  const body = message ? `\n${message}` : '';
  const tail = `\n触发规则: ${rule}`;
  return `${head}${body}${tail}`;
}

/**
 * buildImSubject — IM/邮件 subject 模板。
 */
export function buildImSubject(input: RiskAlertWriteInput): string {
  const severity = String(input.severity || 'unknown').toUpperCase();
  const symbol = String(input.symbol || '').trim() || '—';
  const name = String(input.name || '').trim();
  return `【${severity} 风控告警】${symbol}${name ? ` ${name}` : ''}`;
}

// ---------------------------------------------------------------------------
// DataSource DI seam
// ---------------------------------------------------------------------------

export interface RiskAlertCreatePayload {
  user_id: number;
  symbol: string;
  name: string;
  level: 'HIGH' | 'MEDIUM';
  message: string;
  rule_id?: string;
  is_read?: boolean;
  metadata?: Record<string, any>;
}

export interface RiskAlertServiceDataSource {
  /** 写 DB RiskAlert 行；返回 id（写失败时抛错由 caller 兜） */
  createRiskAlert(payload: RiskAlertCreatePayload): Promise<{ id: number }>;
  /** 取 user.email 作 IM 地址（user 不存在返回 null） */
  loadUserImAddress(user_id: number): Promise<string | null>;
  /** 推飞书 OPS 群（webhook url 由 caller 解析）。fail-OPEN 返回 success=false 而非 throw */
  postFeishuOps(
    url: string,
    body: { msg_type: 'text'; content: { text: string } }
  ): Promise<{ success: boolean; message?: string }>;
  /** 发 IM/邮件（地址由 caller 解析）。fail-OPEN 返回 success=false 而非 throw */
  sendIm(
    address: string,
    subject: string,
    body: string
  ): Promise<{ success: boolean; message?: string; ref_id?: string }>;
  /** Fire-and-forget 触发用户个性化 RealtimeAlertDispatcher（仅当 alert_id 已知） */
  fireRealtimeDispatcher(input: {
    alert_id: number;
    user_id: number;
    symbol: string;
    name: string;
    level: 'HIGH';
    message: string;
    rule_id?: string;
  }): void;
}

// ---------------------------------------------------------------------------
// Production DataSource — 复用既有 model / service 单例
// ---------------------------------------------------------------------------

class DefaultRiskAlertServiceDataSource implements RiskAlertServiceDataSource {
  async createRiskAlert(payload: RiskAlertCreatePayload): Promise<{ id: number }> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RiskAlert } = require('../models/RiskAlert');
    const row = await RiskAlert.create({
      user_id: payload.user_id,
      symbol: payload.symbol,
      name: payload.name,
      level: payload.level,
      message: payload.message,
      rule_id: payload.rule_id || null,
      is_read: payload.is_read === true ? true : false,
      // metadata 字段当前 RiskAlert model 未声明 — Sequelize ignore；未来 migration
      // 加 jsonb metadata 字段时这里就自动生效。
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
    } as any);
    return { id: Number((row as any)?.id) };
  }

  async loadUserImAddress(user_id: number): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { User } = require('../models/User');
    try {
      const u = await User.findByPk(user_id, { attributes: ['email'], raw: true });
      const email = (u as any)?.email;
      if (typeof email === 'string' && email.trim()) return email.trim();
      return null;
    } catch (err: any) {
      logger.warn(
        `[RiskAlertService] loadUserImAddress user=${user_id} failed: ${err?.message || err}`
      );
      return null;
    }
  }

  async postFeishuOps(
    url: string,
    body: { msg_type: 'text'; content: { text: string } }
  ): Promise<{ success: boolean; message?: string }> {
    // 复用 LiveAuditAlertService / audit-task-parameters-dry-run 同款轻量 axios POST
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios');
    try {
      await axios.post(url, body, {
        timeout: Number(process.env.OPS_ALERT_FEISHU_TIMEOUT_MS || 5000),
        maxRedirects: 0,
        validateStatus: (s: number) => s >= 200 && s < 300,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err?.message || String(err) };
    }
  }

  async sendIm(
    address: string,
    subject: string,
    body: string
  ): Promise<{ success: boolean; message?: string; ref_id?: string }> {
    // 复用 EmailNotificationService 同款 transporter；保持 service 间解耦只用
    // sendMail 这一个低阶 API，不强绑 buildEmail。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { emailNotificationService } = require('./EmailNotificationService');
    try {
      const r = await emailNotificationService.sendEmail(
        // EmailNotificationService.sendEmail 签名 (payload, address, {buildEmail})
        // payload 非空校验 — 用 subject+body wrap 一层让单一职责仍然成立.
        { subject, body },
        address,
        {
          buildEmail: () => ({
            subject,
            html: `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(
              body
            )}</pre>`,
            text: body,
          }),
        }
      );
      if (r?.success) {
        return { success: true, ref_id: (r as any)?.data?.messageId };
      }
      return { success: false, message: (r as any)?.message };
    } catch (err: any) {
      return { success: false, message: err?.message || String(err) };
    }
  }

  fireRealtimeDispatcher(input: {
    alert_id: number;
    user_id: number;
    symbol: string;
    name: string;
    level: 'HIGH';
    message: string;
    rule_id?: string;
  }): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { realtimeAlertDispatcher } = require('./RealtimeAlertDispatcher');
      realtimeAlertDispatcher.fireAndForget({
        alert_id: input.alert_id,
        user_id: input.user_id,
        symbol: input.symbol,
        name: input.name,
        level: input.level,
        message: input.message,
        rule_id: input.rule_id,
        triggered_at: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.warn(`[RiskAlertService] fireRealtimeDispatcher failed: ${err?.message || err}`);
    }
  }
}

function escapeHtml(value: any): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const PRODUCTION_RISK_ALERT_SERVICE_DATA_SOURCE: RiskAlertServiceDataSource =
  new DefaultRiskAlertServiceDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RiskAlertService {
  private readonly dataSource: RiskAlertServiceDataSource;

  constructor(dataSource: RiskAlertServiceDataSource = PRODUCTION_RISK_ALERT_SERVICE_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 — 按 severity 路由到 inbox / feishu / im / toast 各通道.
   * 整体 fail-OPEN：任何通道失败仅记 warning，不 throw；caller 用 result.channels
   * 检查每个通道的成败.
   */
  async write(
    input: RiskAlertWriteInput,
    options: RiskAlertWriteOptions = {}
  ): Promise<RiskAlertWriteResult> {
    // ---- (1) input validation ----
    const severity = normalizeSeverity(input.severity);
    if (!severity) {
      const err = `Unknown severity: ${input.severity}`;
      logger.warn(`[RiskAlertService.write] ${err}`);
      return {
        severity: RISK_ALERT_SEVERITY.MEDIUM, // 兜底 — 但不实际发送
        planned_channels: [],
        channels: [],
        error: err,
      };
    }

    // ---- (2) plan channels ----
    const plannedChannels = buildChannelPlan(severity, options);

    if (plannedChannels.length === 0) {
      return {
        severity,
        planned_channels: [],
        channels: [],
      };
    }

    // ---- (3) inbox first (sync) — 拿到 alert_id 之后才能 fan-out 其它通道 ----
    const channels: RiskAlertChannelResult[] = [];
    let alertId: number | undefined;
    const wantToast = plannedChannels.includes('toast');
    const inboxMetadata: Record<string, any> = {
      ...(input.metadata || {}),
      ...(wantToast ? { toast: true } : {}),
      severity,
    };

    if (plannedChannels.includes('inbox')) {
      try {
        const created = await this.dataSource.createRiskAlert({
          user_id: input.user_id,
          symbol: input.symbol,
          name: input.name,
          level: SEVERITY_TO_LEVEL[severity],
          message: input.message,
          rule_id: input.rule_id,
          is_read: false,
          metadata: inboxMetadata,
        });
        const id = Number(created?.id);
        if (Number.isFinite(id)) alertId = id;
        channels.push({
          channel: 'inbox',
          attempted: true,
          success: true,
          ref_id: Number.isFinite(id) ? id : undefined,
        });
      } catch (err: any) {
        logger.warn(
          `[RiskAlertService.write] inbox 写入失败 user=${input.user_id} severity=${severity}: ${
            err?.message || err
          }`
        );
        channels.push({
          channel: 'inbox',
          attempted: true,
          success: false,
          error: err?.message || String(err),
        });
        // inbox 写失败 → 后续通道仍尝试（运维群仍能看到告警），但不触发
        // realtime dispatcher（dispatcher 需要 alert_id）
      }
    }

    // ---- (4) fan-out 外部通道（parallel + Promise.allSettled）----
    const fanoutPromises: Array<Promise<RiskAlertChannelResult>> = [];

    if (plannedChannels.includes('feishu')) {
      // Phase 10 通知审计 (2026-06-28): 当 inbox 写入成功 (alertId 已知) 时,
      // RiskAlert.afterCreate hook 会通过 SystemAdminAlertPusher 推一张更完整的
      // interactive card 到同一个 OPS_ALERT_FEISHU_WEBHOOK; 这里再发一条 text msg
      // 会让 OPS 群几秒内收到两条覆盖率 ~90% 重叠的内容. 当 alertId 存在 ->
      // 跳过本路径, 让 hook 的 card 成为唯一 ops 推送源.
      //
      // 兼容路径: caller 显式 override_channels=['feishu'] 不走 inbox (alertId
      // 仍是 undefined) 的旧场景, 仍发 text msg, 行为不变.
      // 也兼容: caller 显式 options.force_feishu_text=true (供 audit-task-
      // parameters-dry-run.ts 等需要文本格式的场景强发 text).
      if (typeof alertId !== 'number' || options.force_feishu_text === true) {
        fanoutPromises.push(this.runFeishu(input, options));
      } else {
        channels.push({
          channel: 'feishu',
          attempted: false,
          success: false,
          skipped: true,
          message:
            'inbox 写入成功后由 afterCreate hook 接管 ops 推送, skip duplicate text (Phase 10)',
        });
      }
    }
    if (plannedChannels.includes('im')) {
      fanoutPromises.push(this.runIm(input, options));
    }
    if (plannedChannels.includes('toast')) {
      // toast 不是真发送通道 — 它的实际语义是「inbox metadata.toast=true 已写入」.
      // 这里返回一个 status 行让 result.channels 自描述完整，UI 可以从中读到
      // 「toast 通道已就绪」的可观测信号.
      fanoutPromises.push(
        Promise.resolve({
          channel: 'toast' as const,
          attempted: true,
          success: typeof alertId === 'number',
          ref_id: alertId,
          message:
            typeof alertId === 'number'
              ? 'metadata.toast=true'
              : 'inbox 写入失败，toast 标记未生效',
        })
      );
    }

    const settled = await Promise.allSettled(fanoutPromises);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        channels.push(s.value);
      } else {
        // runFeishu / runIm 都内置 try/catch，正常路径不会落到这里；防御性兜底
        channels.push({
          channel: 'inbox', // 占位（unknown channel）
          attempted: true,
          success: false,
          error: `[fallback] ${(s.reason as any)?.message || String(s.reason)}`,
        });
      }
    }

    // ---- (5) realtime dispatcher hook — 仅 critical / high 且 alert 已写入 ----
    if (
      (severity === RISK_ALERT_SEVERITY.CRITICAL || severity === RISK_ALERT_SEVERITY.HIGH) &&
      typeof alertId === 'number'
    ) {
      try {
        this.dataSource.fireRealtimeDispatcher({
          alert_id: alertId,
          user_id: input.user_id,
          symbol: input.symbol,
          name: input.name,
          level: 'HIGH', // RealtimeAlertDispatcher 只识 'HIGH'
          message: input.message,
          rule_id: input.rule_id,
        });
      } catch (err: any) {
        // fireAndForget 自身已吞错；这里再兜一层
        logger.warn(`[RiskAlertService.write] fireRealtimeDispatcher 异常: ${err?.message || err}`);
      }
    }

    return {
      severity,
      planned_channels: plannedChannels,
      channels,
      alert_id: alertId,
    };
  }

  // -----------------------------------------------------------------------
  // Channel runners — 单独抽出便于读
  // -----------------------------------------------------------------------

  private async runFeishu(
    input: RiskAlertWriteInput,
    options: RiskAlertWriteOptions
  ): Promise<RiskAlertChannelResult> {
    const url =
      String(options.feishu_webhook_url || '').trim() ||
      String(process.env.OPS_ALERT_FEISHU_WEBHOOK || '').trim();
    if (!url) {
      return {
        channel: 'feishu',
        attempted: false,
        success: false,
        skipped: true,
        message: 'OPS_ALERT_FEISHU_WEBHOOK 未配置, skip',
      };
    }
    try {
      const text = buildOpsAlertText(input);
      const r = await this.dataSource.postFeishuOps(url, {
        msg_type: 'text',
        content: { text },
      });
      if (r.success) {
        return { channel: 'feishu', attempted: true, success: true };
      }
      return {
        channel: 'feishu',
        attempted: true,
        success: false,
        error: r.message || 'feishu post failed',
      };
    } catch (err: any) {
      return {
        channel: 'feishu',
        attempted: true,
        success: false,
        error: err?.message || String(err),
      };
    }
  }

  private async runIm(
    input: RiskAlertWriteInput,
    options: RiskAlertWriteOptions
  ): Promise<RiskAlertChannelResult> {
    let address = String(options.im_address || '').trim();
    if (!address) {
      try {
        const fromDb = await this.dataSource.loadUserImAddress(input.user_id);
        if (fromDb) address = fromDb;
      } catch (err: any) {
        return {
          channel: 'im',
          attempted: true,
          success: false,
          error: `loadUserImAddress failed: ${err?.message || err}`,
        };
      }
    }
    if (!address) {
      return {
        channel: 'im',
        attempted: false,
        success: false,
        skipped: true,
        message: '用户未配置 IM 地址 (email), skip',
      };
    }
    try {
      const subject = buildImSubject(input);
      const body = buildOpsAlertText(input);
      const r = await this.dataSource.sendIm(address, subject, body);
      if (r.success) {
        return {
          channel: 'im',
          attempted: true,
          success: true,
          ref_id: r.ref_id,
        };
      }
      return {
        channel: 'im',
        attempted: true,
        success: false,
        error: r.message || 'im send failed',
      };
    } catch (err: any) {
      return {
        channel: 'im',
        attempted: true,
        success: false,
        error: err?.message || String(err),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const riskAlertService = new RiskAlertService();
