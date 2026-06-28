/**
 * CriticalAnnouncementPushService — US-031 / ANN-007: critical 公告 5min 飞书 push.
 *
 * 在 AnnouncementNLPService.syncDate 落库成功后, 把 priority='critical' 的公告
 * 即时推送到 OPS 飞书群 (text webhook), 让 ops/quant 5min 内看到处罚/亏损/重大
 * 减持等强监管事件, 与 ANN-005 (computePriority) 的决策表 + RealtimeAlertDispatcher
 * critical 路径对齐.
 *
 * **路由契约**:
 *   - 仅 `priority === 'critical'` 的记录入队 (low/medium/high 一律 skip);
 *   - dry_run 路径 (records.persisted=false) 也 skip — 没真落库就不推, 避免噪音;
 *   - `OPS_ALERT_FEISHU_WEBHOOK` 未配置 → 整批 skip (与 RiskAlertService /
 *     audit-task-parameters-dry-run.ts 同款 fail-OPEN: 没 webhook 不阻塞主流程);
 *   - per-message try-catch, 单条失败不阻塞批内其他条;
 *   - 顶层 catch 兜底 — push 失败绝不影响 syncDate 本身的成功返回.
 *
 * **设计原则** (与 RiskAlertService / audit-task-parameters-dry-run.ts 同款):
 *   - DataSource DI seam (FeishuWebhookPoster), 单测注入 fake 完全脱离 HTTP;
 *   - 纯函数 helpers 全 export (buildCriticalAnnouncementText / shouldPushRecord);
 *   - 顺序 fan-out (critical 数极少, 通常 0-5 条/天), 不需要并发;
 *   - text msg 而非 interactive card — 与 audit-task-parameters-dry-run.ts 同款
 *     轻量路径, 不引入 buildCard 反向依赖; 后续如需富文本卡片再切 sendRiskAlertCard.
 *
 * **为什么不直接接 RiskAlertService.write?**
 *   - RiskAlertService 强绑定 user_id (每条 alert 隶属某用户), 而 critical 公告
 *     是市场级事件不属于个人, ops 群应该收全市场 critical, 单写 user_id=系统占位
 *     会让 user.AlertsBell 收到不相关数据;
 *   - RiskAlertService 同时写 DB + IM + toast, 引入额外 DB 写入开销 (每天 ~1000
 *     条公告里若 1% critical = 10 条/天, 但每条还要再写 RiskAlert 行就重复了);
 *   - 本 service 只走 feishu text webhook 一条通道, 职责清晰.
 */

import { logger } from '../utils/logger';
import { AnnouncementNLPRecord, AnnouncementPriority } from './AnnouncementNLPService';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** 仅这一级才触发 5min 飞书 push. 与 ANN-005 (computePriority) 决策表对齐. */
export const CRITICAL_ANNOUNCEMENT_PRIORITY: AnnouncementPriority = 'critical';

/** 单批最多推送条数 (防风暴 — 极端日某些黑天鹅事件可能一次 30+ 条). */
export const CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH = 20;

/** 单条文本上限 (飞书 webhook content.text 长度限制 ~30k, 这里给余量). */
export const CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN = 800;

export interface CriticalAnnouncementPushItemResult {
  stock_code: string;
  original_title: string;
  attempted: boolean;
  success: boolean;
  /** 跳过原因 (e.g. 'not_critical' / 'not_persisted' / 'truncated_batch') */
  skipped?: boolean;
  skip_reason?: string;
  /** webhook 失败原因 */
  error?: string;
}

export interface CriticalAnnouncementPushResult {
  /** 入参总条数 */
  scanned: number;
  /** 满足 critical 条件且 persisted=true 的条数 */
  matched: number;
  /** 实际尝试推送的条数 (受 MAX_PUSH_PER_BATCH clamp) */
  attempted: number;
  /** 成功推送的条数 */
  succeeded: number;
  /** 失败推送的条数 (含 webhook 4xx/5xx) */
  failed: number;
  /** 整批 skip 原因 — 一旦设置, items 为空且 attempted=0 */
  skipped_reason?: 'no_webhook' | 'no_critical' | 'no_records' | 'top_level_error';
  /** per-item 详情 (仅含尝试推送或 skip 的项, 不含 priority!=critical 的常规 skip) */
  items: CriticalAnnouncementPushItemResult[];
  error?: string;
}

export interface CriticalAnnouncementPushOptions {
  /** override OPS_ALERT_FEISHU_WEBHOOK env (主要给单测 / 多租户场景) */
  webhook_url?: string;
  /** 不真发, 只返回若推会发什么 (UI 预览) */
  dry_run?: boolean;
  /** 单批上限覆盖 (默认 CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH) */
  max_per_batch?: number;
  /**
   * Phase 10 缺漏 P1-3 (2026-06-28) — 元告警 hook 注入点 (测试). 默认
   * pushSystemAdminAlertFireAndForget, fail-OPEN. 主流程跑完若 failed > 0
   * 推一次元告警 (dedup_key='critical_announcement_push_fail', 1h dedup).
   */
  meta_alert_push?: (input: {
    dedup_key: string;
    level: 'WARN';
    title: string;
    body_markdown: string;
    triggered_at: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * shouldPushRecord — 单条记录是否应入队 critical push.
 *
 * 双重 gate: priority 必须 critical + 必须真落库 (persisted=true);
 * dry_run 路径 persisted=false 不推, 避免 UI 预演触发真飞书消息.
 */
export function shouldPushRecord(record: AnnouncementNLPRecord): boolean {
  if (!record) return false;
  if (record.priority !== CRITICAL_ANNOUNCEMENT_PRIORITY) return false;
  if (record.persisted !== true) return false;
  return true;
}

/**
 * buildCriticalAnnouncementText — 飞书 text webhook 的消息体.
 *
 * 输出格式 (与 RiskAlertService.buildOpsAlertText / audit-task-parameters-dry-run
 * buildOpsAlertText 同款排版风格: emoji 头 + 多行 body + 触发规则尾):
 *
 *   🚨 [CRITICAL 公告] {stock_code} {stock_name}
 *   {original_title}
 *   摘要: {summary}
 *   事件类型: {event_type} | 情绪: {sentiment}
 *   公告日期: {announce_date}
 *   触发规则: announcement_critical_priority
 *
 * 缺失字段自动跳过, 但 stock_code + original_title 必有 (caller 保证).
 * 总长度超 CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN 时截断末尾加 '...'.
 */
export function buildCriticalAnnouncementText(record: AnnouncementNLPRecord): string {
  const stockCode = String(record.stock_code || '').trim() || '—';
  const stockName = String(record.stock_name || '').trim();
  const title = String(record.original_title || '').trim();
  const summary = String(record.summary || '').trim();
  const eventType = String(record.event_type || '').trim();
  const sentiment = String(record.sentiment || '').trim();
  const announceDate = String(record.announce_date || '').trim();

  const lines: string[] = [];
  lines.push(`🚨 [CRITICAL 公告] ${stockCode}${stockName ? ` ${stockName}` : ''}`);
  if (title) lines.push(title);
  if (summary && summary !== title) lines.push(`摘要: ${summary}`);

  const meta: string[] = [];
  if (eventType) meta.push(`事件类型: ${eventType}`);
  if (sentiment) meta.push(`情绪: ${sentiment}`);
  if (meta.length > 0) lines.push(meta.join(' | '));

  if (announceDate) lines.push(`公告日期: ${announceDate}`);
  lines.push('触发规则: announcement_critical_priority');

  const text = lines.join('\n');
  if (text.length <= CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN) return text;
  // 截断末尾 + 保留尾行 (触发规则), 否则 ops 不知道是哪条规则触发的
  const tail = '\n触发规则: announcement_critical_priority';
  const head = text.slice(0, Math.max(0, CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN - tail.length - 3));
  return `${head}...${tail}`;
}

/**
 * resolveWebhookUrl — 解析最终使用的 webhook url.
 * - options.webhook_url 优先 (单测注入 / 多租户);
 * - 否则取 env.OPS_ALERT_FEISHU_WEBHOOK (与 RiskAlertService /
 *   audit-task-parameters-dry-run.ts 同款 env 名);
 * - trim 后为空字符串 → 返回 null (caller short-circuit).
 */
export function resolveWebhookUrl(
  options: CriticalAnnouncementPushOptions = {},
  env: Record<string, string | undefined> = process.env as any
): string | null {
  const fromOptions = String(options.webhook_url ?? '').trim();
  if (fromOptions) return fromOptions;
  const fromEnv = String(env.OPS_ALERT_FEISHU_WEBHOOK ?? '').trim();
  return fromEnv ? fromEnv : null;
}

// ---------------------------------------------------------------------------
// DataSource DI seam
// ---------------------------------------------------------------------------

export type FeishuWebhookPoster = (
  url: string,
  body: { msg_type: 'text'; content: { text: string } }
) => Promise<{ success: boolean; message?: string }>;

/**
 * 生产飞书 webhook poster — 与 audit-task-parameters-dry-run.ts 同款轻量
 * axios POST + fail-OPEN, 不复用 FeishuBotWebhookService.sendRiskAlertCard
 * (那是 interactive card 通道, 依赖 buildCard 注入), ANN-007 走最简单的 text msg.
 *
 * 复用 OPS_ALERT_FEISHU_TIMEOUT_MS 与其他 ops 通道保持一致的超时配置.
 */
export async function defaultCriticalAnnouncementFeishuPoster(
  url: string,
  body: { msg_type: 'text'; content: { text: string } }
): Promise<{ success: boolean; message?: string }> {
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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CriticalAnnouncementPushService {
  private readonly poster: FeishuWebhookPoster;

  constructor(poster: FeishuWebhookPoster = defaultCriticalAnnouncementFeishuPoster) {
    this.poster = poster;
  }

  /**
   * 主入口 — 给一批刚落库的公告记录里 priority=critical 的逐条 push 飞书.
   *
   * 顶层 try/catch 兜底 — 任何异常都吞掉返 error 字段, 主流程 (syncDate) 绝不
   * 被本通道阻塞.
   */
  async pushBatch(
    records: AnnouncementNLPRecord[],
    options: CriticalAnnouncementPushOptions = {},
    env: Record<string, string | undefined> = process.env as any
  ): Promise<CriticalAnnouncementPushResult> {
    const scanned = Array.isArray(records) ? records.length : 0;
    try {
      if (scanned === 0) {
        return {
          scanned: 0,
          matched: 0,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          skipped_reason: 'no_records',
          items: [],
        };
      }

      const candidates = records.filter(shouldPushRecord);
      if (candidates.length === 0) {
        return {
          scanned,
          matched: 0,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          skipped_reason: 'no_critical',
          items: [],
        };
      }

      const webhook = resolveWebhookUrl(options, env);
      if (!webhook && options.dry_run !== true) {
        logger.info(
          `[CriticalAnnouncementPush] OPS_ALERT_FEISHU_WEBHOOK 未配置, skip ${candidates.length} critical 公告 push.`
        );
        return {
          scanned,
          matched: candidates.length,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          skipped_reason: 'no_webhook',
          items: [],
        };
      }

      const cap = Math.max(
        1,
        Math.floor(options.max_per_batch ?? CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH)
      );
      const toPush = candidates.slice(0, cap);
      const truncatedTail = candidates.slice(cap);

      const items: CriticalAnnouncementPushItemResult[] = [];
      let succeeded = 0;
      let failed = 0;

      for (const rec of toPush) {
        const text = buildCriticalAnnouncementText(rec);
        if (options.dry_run === true) {
          items.push({
            stock_code: rec.stock_code,
            original_title: rec.original_title,
            attempted: false,
            success: false,
            skipped: true,
            skip_reason: 'dry_run',
          });
          continue;
        }
        try {
          const r = await this.poster(webhook as string, {
            msg_type: 'text',
            content: { text },
          });
          if (r.success) {
            succeeded += 1;
            items.push({
              stock_code: rec.stock_code,
              original_title: rec.original_title,
              attempted: true,
              success: true,
            });
          } else {
            failed += 1;
            logger.warn(
              `[CriticalAnnouncementPush] feishu post failed for ${
                rec.stock_code
              } "${rec.original_title.slice(0, 30)}": ${r.message || 'unknown'}`
            );
            items.push({
              stock_code: rec.stock_code,
              original_title: rec.original_title,
              attempted: true,
              success: false,
              error: r.message || 'feishu post failed',
            });
          }
        } catch (err: any) {
          // defaultCriticalAnnouncementFeishuPoster 已 fail-OPEN; 兜底用户自注入 poster 抛 sync error.
          failed += 1;
          logger.warn(
            `[CriticalAnnouncementPush] poster threw for ${rec.stock_code}: ${err?.message || err}`
          );
          items.push({
            stock_code: rec.stock_code,
            original_title: rec.original_title,
            attempted: true,
            success: false,
            error: err?.message || String(err),
          });
        }
      }

      // truncate 的尾部也登记一笔 skip, 便于 ops 看到 "今天 critical 数超了 cap"
      for (const rec of truncatedTail) {
        items.push({
          stock_code: rec.stock_code,
          original_title: rec.original_title,
          attempted: false,
          success: false,
          skipped: true,
          skip_reason: 'truncated_batch',
        });
      }

      if (truncatedTail.length > 0) {
        logger.warn(
          `[CriticalAnnouncementPush] batch truncated: ${candidates.length} matched > cap=${cap}, skipped ${truncatedTail.length} tail items.`
        );
      }

      logger.info(
        `[CriticalAnnouncementPush] scanned=${scanned} matched=${candidates.length} ` +
          `attempted=${toPush.length} succeeded=${succeeded} failed=${failed} dry_run=${
            options.dry_run === true
          }`
      );

      // Phase 10 缺漏 P1-3 (2026-06-28): 失败 > 0 时推一条元告警 — 当 webhook
      // URL 配错 / 飞书 rate limit 让 critical 公告 silent drop 时, OPS 能从
      // SystemAdminAlertPusher 1h dedup 内收到 1 条 "本次推 N 失败" 元告警.
      if (failed > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const sysMod = require('./SystemAdminAlertPusher');
          const pushFn =
            options.meta_alert_push ||
            (sysMod && typeof sysMod.pushSystemAdminAlertFireAndForget === 'function'
              ? sysMod.pushSystemAdminAlertFireAndForget
              : null);
          if (pushFn) {
            pushFn({
              dedup_key: 'critical_announcement_push_fail',
              level: 'WARN',
              title: `[WARN] critical 公告推送失败 ${failed}/${toPush.length}`,
              body_markdown:
                `**触发原因**: 本次 critical 公告推送有 ${failed} 条失败 ` +
                `(succeeded=${succeeded}, attempted=${toPush.length})\n` +
                `**dedup**: 1h 内本元告警只推 1 次\n` +
                `**排查方向**: OPS_ALERT_FEISHU_WEBHOOK URL / 飞书 rate limit / ` +
                `webhookFailOpen retry pending`,
              triggered_at: new Date().toISOString(),
            });
          }
        } catch (metaErr: any) {
          // fail-OPEN: 元告警失败不应让本次 pushBatch 返 error
          logger.warn(
            `[CriticalAnnouncementPush] meta-alert push 异常 (吞错保护): ${
              metaErr?.message || metaErr
            }`
          );
        }
      }

      return {
        scanned,
        matched: candidates.length,
        attempted: toPush.length,
        succeeded,
        failed,
        items,
      };
    } catch (err: any) {
      // 双重防御外层 catch — 主流程 (syncDate) 绝不被本通道阻塞
      logger.error(`[CriticalAnnouncementPush] top-level failure: ${err?.message || err}`);
      return {
        scanned,
        matched: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped_reason: 'top_level_error',
        items: [],
        error: err?.message || String(err),
      };
    }
  }
}

/** 生产 singleton — AnnouncementNLPService.syncDate 内默认使用. */
export const criticalAnnouncementPushService = new CriticalAnnouncementPushService();
