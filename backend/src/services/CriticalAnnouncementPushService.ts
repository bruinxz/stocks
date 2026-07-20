/**
 * CriticalAnnouncementPushService — US-031 / ANN-007: critical 公告 5min 飞书 push
 * + PR-E (2026-06-29) 持仓相关 critical 公告写 user inbox RiskAlert.
 *
 * 在 AnnouncementNLPService.syncDate 落库成功后, 把 priority='critical' 的公告
 * 即时推送到 OPS 飞书群 (text webhook), 让 ops/quant 5min 内看到处罚/亏损/重大
 * 减持等强监管事件, 与 ANN-005 (computePriority) 的决策表 + RealtimeAlertDispatcher
 * critical 路径对齐.
 *
 * PR-E 新增 (2026-06-29): 对每条 critical 公告, 找出所有当前真持仓该股票的用户
 * (paper_trading_positions.quantity > 0 → 关联 paper_trading_portfolios.user_id),
 * 给每个 user 写一条 RiskAlert (level='HIGH', rule_id='announcement_critical').
 * RiskAlert.afterCreate hook 会触发 WebSocket 广播 + 用户个人通知 (按 user
 * notification config). 让用户的 AlertsBell 在公告落库 5min 内出现红点提醒,
 * 与 ops 群 critical push 一起形成"市场级 OPS 群 + 用户级 inbox"双通道.
 *
 * **路由契约**:
 *   - 仅 `priority === 'critical'` 的记录入队 (low/medium/high 一律 skip);
 *   - dry_run 路径 (records.persisted=false) 也 skip — 没真落库就不推, 避免噪音;
 *   - `OPS_ALERT_FEISHU_WEBHOOK` 未配置 → 整批 skip OPS 群 push (与 RiskAlertService /
 *     audit-task-parameters-dry-run.ts 同款 fail-OPEN), **但仍写 user_alerts**;
 *   - per-message try-catch, 单条失败不阻塞批内其他条;
 *   - 顶层 catch 兜底 — push 失败绝不影响 syncDate 本身的成功返回.
 *
 * **设计原则** (与 RiskAlertService / audit-task-parameters-dry-run.ts 同款):
 *   - DataSource DI seam (FeishuWebhookPoster + CriticalAnnouncementPushDataSource),
 *     单测注入 fake 完全脱离 HTTP + DB;
 *   - 纯函数 helpers 全 export (buildCriticalAnnouncementText / shouldPushRecord /
 *     buildUserAlertMessage / buildUserAlertDedupKey);
 *   - 顺序 fan-out (critical 数极少, 通常 0-5 条/天), 不需要并发;
 *   - text msg 而非 interactive card — 与 audit-task-parameters-dry-run.ts 同款
 *     轻量路径, 不引入 buildCard 反向依赖; 后续如需富文本卡片再切 sendRiskAlertCard.
 *
 * **为什么 OPS 群 push 不直接接 RiskAlertService.write?**
 *   - RiskAlertService 强绑定 user_id (每条 alert 隶属某用户), 而 OPS 群 push
 *     是市场级事件不属于个人, ops 群应该收全市场 critical;
 *   - 本 service 只走 feishu text webhook 一条通道 + 用户 inbox RiskAlert 一条
 *     通道, 职责清晰; user_alerts 写法显式枚举持仓用户而非全员推送, 避免噪音.
 */

import { logger } from '../utils/logger';
import { createHash } from 'crypto';
import { feishuNotificationService } from './FeishuNotificationService';
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

/** PR-E: 单条用户 RiskAlert message 体长度上限 (DB TEXT 列无硬限, 防 UI 卡死) */
export const CRITICAL_ANNOUNCEMENT_USER_ALERT_MAX_MSG_LEN = 1000;

/** PR-E: RiskAlert rule_id 常量 — 与 RealtimeAlertDispatcher dedup signature 对齐 */
export const CRITICAL_ANNOUNCEMENT_RULE_ID = 'announcement_critical';

/**
 * PR-L emergency stop-loss (2026-06-29):
 * PR-K 回测证实当前 confidence_score 反向 — high(≥70) win 30% < low(<50) win 40%.
 * 该 gate 在 OPS 飞书 push entry 处暂停 conf≥70 的推送 (user inbox RiskAlert 仍写,
 * UI 不受影响). conf 字段从 record.confidence_score / metadata.fusion_score /
 * metadata.confidence_score 三者按优先级取数, 任一 ≥ EMERGENCY_CONF_GATE_THRESHOLD
 * 即拦截. **等 PR-I 战法库 + conf evaluator 修复后, 把 EMERGENCY_CONF_GATE 切回
 * false** — 现阶段优先 fail-closed (高 conf 一律不推 OPS 群) 防 OPS 群被毒推.
 */
/**
 * PR-W (2026-06-30) — 解除 PR-L 紧急 conf gate.
 * 用户 prod 实测明确反馈"飞书没收到通知", PR-L 把 conf≥70 的 OPS 飞书推送
 * 全 gate 掉是 over-fix. 改回 false 让飞书推送正常. user inbox / RiskAlert 仍
 * 独立写, /home banner 仍在 (前端 PR-L 还在但只是评估期提示). 真正反向 conf
 * 修复走 PR-M3 SourceTypeWinRateAdjuster (已部署), 让真假 high-conf 自动区分.
 */
export const EMERGENCY_CONF_GATE = false;
export const EMERGENCY_CONF_GATE_THRESHOLD = 70;
export const EMERGENCY_CONF_GATE_SKIP_REASON = 'emergency_stop_loss_conf_gate';

/**
 * PR-L: 从 NLP record 提取 confidence_score (兼容多字段命名), 任一 ≥ threshold
 * 返 true. 全部缺失 / 非数字 → false (不拦截).
 * pure (export for test).
 */
export function isEmergencyConfGated(
  record: AnnouncementNLPRecord,
  threshold: number = EMERGENCY_CONF_GATE_THRESHOLD
): boolean {
  if (!EMERGENCY_CONF_GATE) return false;
  if (!record) return false;
  const meta = (record as any).metadata || {};
  const candidates = [
    (record as any).confidence_score,
    meta.confidence_score,
    meta.fusion_score,
    meta.final_score,
    (record as any).fusion_score,
    (record as any).final_score,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= threshold) return true;
  }
  return false;
}

export interface CriticalAnnouncementPushItemResult {
  stock_code: string;
  original_title: string;
  attempted: boolean;
  success: boolean;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
}

export interface CriticalAnnouncementPushResult {
  scanned: number;
  matched: number;
  attempted: number;
  succeeded: number;
  failed: number;
  /**
   * PR-E (2026-06-29): 给 "持仓相关 critical 公告" 写入用户 inbox 的
   * RiskAlert 总条数. 同一公告若 N 个用户持仓则写 N 条. dry_run=true 时为 0.
   */
  user_alerts: number;
  skipped_reason?: 'no_webhook' | 'no_critical' | 'no_records' | 'top_level_error';
  items: CriticalAnnouncementPushItemResult[];
  error?: string;
}

export interface CriticalAnnouncementPushOptions {
  webhook_url?: string;
  dry_run?: boolean;
  max_per_batch?: number;
  /**
   * PR-E (2026-06-29): DataSource DI seam — 注入 fake 完全脱离 DB.
   */
  data_source?: CriticalAnnouncementPushDataSource;
}

// ---------------------------------------------------------------------------
// PR-E DataSource DI seam
// ---------------------------------------------------------------------------

export interface CriticalAnnouncementPushDataSource {
  findUsersHoldingStock(symbol: string): Promise<number[]>;
  createRiskAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    level: 'HIGH';
    rule_id: string;
    message: string;
  }): Promise<void>;
}

/**
 * 生产 DataSource — lazy require 真模型 + try/catch fail-OPEN.
 * user_id 在 PaperTradingPortfolio 上 (持仓表只关联 portfolio_id), 用 include 关联.
 */
export const DEFAULT_CRITICAL_ANN_DATA_SOURCE: CriticalAnnouncementPushDataSource = {
  async findUsersHoldingStock(symbol: string): Promise<number[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPosition } = require('../models/PaperTradingPosition');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const rows = await PaperTradingPosition.findAll({
        where: { symbol, quantity: { [Op.gt]: 0 } },
        attributes: ['portfolio_id'],
        include: [
          {
            model: PaperTradingPortfolio,
            attributes: ['user_id'],
            required: true,
          },
        ],
        raw: true,
      });
      const seen = new Set<number>();
      for (const r of rows) {
        const uid = Number(
          (r as any)['portfolio.user_id'] ?? (r as any).portfolio?.user_id ?? (r as any).user_id
        );
        if (Number.isInteger(uid) && uid > 0) seen.add(uid);
      }
      return Array.from(seen).sort((a, b) => a - b);
    } catch (e: any) {
      logger.warn(
        `[CriticalAnnouncementPush] findUsersHoldingStock(${symbol}) failed (fail-OPEN): ${
          e?.message || e
        }`
      );
      return [];
    }
  },
  async createRiskAlert(input): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RiskAlert } = require('../models/RiskAlert');
      await RiskAlert.create(input);
    } catch (e: any) {
      logger.warn(
        `[CriticalAnnouncementPush] createRiskAlert(user=${input.user_id}, sym=${
          input.symbol
        }) failed (fail-OPEN): ${e?.message || e}`
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function shouldPushRecord(record: AnnouncementNLPRecord): boolean {
  if (!record) return false;
  if (record.priority !== CRITICAL_ANNOUNCEMENT_PRIORITY) return false;
  if (record.persisted !== true) return false;
  return true;
}

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
  const tail = '\n触发规则: announcement_critical_priority';
  const head = text.slice(0, Math.max(0, CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN - tail.length - 3));
  return `${head}...${tail}`;
}

/**
 * PR-E: buildUserAlertMessage — RiskAlert.message 主体 (用户 inbox 显示).
 */
export function buildUserAlertMessage(record: AnnouncementNLPRecord): string {
  const title = String(record.original_title || '').trim() || '(无标题)';
  const summary = String(record.summary || '').trim();
  const eventType = String(record.event_type || '').trim();

  const parts: string[] = [title];
  if (summary && summary !== title) parts.push(summary);
  if (eventType) parts.push(`事件类型: ${eventType}`);

  const msg = parts.join('\n\n');
  if (msg.length <= CRITICAL_ANNOUNCEMENT_USER_ALERT_MAX_MSG_LEN) return msg;
  return `${msg.slice(0, CRITICAL_ANNOUNCEMENT_USER_ALERT_MAX_MSG_LEN - 3)}...`;
}

/**
 * PR-E: buildUserAlertDedupKey — RealtimeAlertDispatcher 用 (rule_id, symbol, level,
 * message_hash) 作 signature, 这里只返回一个稳定 identifier 让单测能验证.
 */
export function buildUserAlertDedupKey(record: AnnouncementNLPRecord): string {
  const date = String(record.announce_date || '').trim();
  const code = String(record.stock_code || '').trim();
  const titleHash = String(record.original_title || '')
    .trim()
    .slice(0, 32);
  return `announcement_critical:${code}:${date}:${titleHash}`;
}

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
// DataSource DI seam (FeishuWebhookPoster)
// ---------------------------------------------------------------------------

export type FeishuWebhookPoster = (
  url: string,
  body: { msg_type: 'text'; content: { text: string } }
) => Promise<{ success: boolean; message?: string }>;

export async function defaultCriticalAnnouncementFeishuPoster(
  _url: string,
  body: { msg_type: 'text'; content: { text: string } }
): Promise<{ success: boolean; message?: string }> {
  try {
    const digest = createHash('sha256').update(body.content.text).digest('hex').slice(0, 32);
    const result = await feishuNotificationService.enqueueAndDeliver({
      idempotency_key: `critical-announcement:${digest}`,
      topic_key: 'critical-announcement',
      audience: 'ops',
      kind: 'critical_announcement',
      severity: 'CRITICAL',
      title: body.content.text.split('\n')[0] || 'CRITICAL 公告',
      payload: body,
    });
    return { success: result.success, message: result.message };
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CriticalAnnouncementPushService {
  private readonly poster: FeishuWebhookPoster;
  private readonly usesOutbox: boolean;

  constructor(poster: FeishuWebhookPoster = defaultCriticalAnnouncementFeishuPoster) {
    this.poster = poster;
    this.usesOutbox = poster === defaultCriticalAnnouncementFeishuPoster;
  }

  async pushBatch(
    records: AnnouncementNLPRecord[],
    options: CriticalAnnouncementPushOptions = {},
    env: Record<string, string | undefined> = process.env as any
  ): Promise<CriticalAnnouncementPushResult> {
    const scanned = Array.isArray(records) ? records.length : 0;
    const dataSource = options.data_source ?? DEFAULT_CRITICAL_ANN_DATA_SOURCE;
    try {
      if (scanned === 0) {
        return {
          scanned: 0,
          matched: 0,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          user_alerts: 0,
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
          user_alerts: 0,
          skipped_reason: 'no_critical',
          items: [],
        };
      }

      // PR-E: user inbox RiskAlert 写库阶段 — 即使 OPS 群无 webhook 也照写,
      // 用户 inbox 是与 OPS 群完全独立的通道; dry_run=true 时跳过 (UI 预览).
      const userAlerts = await this.writeUserInboxAlerts(candidates, options, dataSource);

      const webhook = resolveWebhookUrl(options, env);
      if (!webhook && !this.usesOutbox && options.dry_run !== true) {
        logger.info(
          `[CriticalAnnouncementPush] OPS_ALERT_FEISHU_WEBHOOK 未配置, skip ${candidates.length} critical 公告 OPS push (user_alerts 仍写=${userAlerts}).`
        );
        return {
          scanned,
          matched: candidates.length,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          user_alerts: userAlerts,
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
        // PR-L emergency stop-loss gate (2026-06-29) — 高 conf 反向, 暂停 OPS 群推送.
        // inbox (writeUserInboxAlerts 上方已执行) 仍写, 不阻塞 UI / RiskAlert.
        if (isEmergencyConfGated(rec)) {
          logger.warn(
            `[PR-L emergency] skip OPS push for ${rec.stock_code} "${String(
              rec.original_title || ''
            ).slice(0, 30)}" — conf>=${EMERGENCY_CONF_GATE_THRESHOLD} 反向 (见 PR-K 30 天回测)`
          );
          items.push({
            stock_code: rec.stock_code,
            original_title: rec.original_title,
            attempted: false,
            success: false,
            skipped: true,
            skip_reason: EMERGENCY_CONF_GATE_SKIP_REASON,
          });
          continue;
        }
        try {
          const r = await this.poster(webhook || '', { msg_type: 'text', content: { text } });
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
          `attempted=${toPush.length} succeeded=${succeeded} failed=${failed} ` +
          `user_alerts=${userAlerts} dry_run=${options.dry_run === true}`
      );

      return {
        scanned,
        matched: candidates.length,
        attempted: toPush.length,
        succeeded,
        failed,
        user_alerts: userAlerts,
        items,
      };
    } catch (err: any) {
      logger.error(`[CriticalAnnouncementPush] top-level failure: ${err?.message || err}`);
      return {
        scanned,
        matched: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        user_alerts: 0,
        skipped_reason: 'top_level_error',
        items: [],
        error: err?.message || String(err),
      };
    }
  }

  /**
   * PR-E: 给所有 critical 公告写 user inbox RiskAlert.
   */
  private async writeUserInboxAlerts(
    candidates: AnnouncementNLPRecord[],
    options: CriticalAnnouncementPushOptions,
    dataSource: CriticalAnnouncementPushDataSource
  ): Promise<number> {
    if (options.dry_run === true) return 0;
    let total = 0;
    for (const rec of candidates) {
      let userIds: number[] = [];
      try {
        userIds = await dataSource.findUsersHoldingStock(rec.stock_code);
      } catch (e: any) {
        logger.warn(
          `[CriticalAnnouncementPush] findUsersHoldingStock(${rec.stock_code}) threw (fail-OPEN): ${
            e?.message || e
          }`
        );
        userIds = [];
      }
      if (!Array.isArray(userIds) || userIds.length === 0) continue;
      const message = buildUserAlertMessage(rec);
      const name = String(rec.stock_name || '').trim() || rec.stock_code;
      for (const user_id of userIds) {
        try {
          await dataSource.createRiskAlert({
            user_id,
            symbol: rec.stock_code,
            name,
            level: 'HIGH',
            rule_id: CRITICAL_ANNOUNCEMENT_RULE_ID,
            message,
          });
          total += 1;
        } catch (e: any) {
          logger.warn(
            `[CriticalAnnouncementPush] createRiskAlert(user=${user_id}, sym=${
              rec.stock_code
            }) threw (fail-OPEN): ${e?.message || e}`
          );
        }
      }
    }
    return total;
  }
}

/** 生产 singleton — AnnouncementNLPService.syncDate 内默认使用. */
export const criticalAnnouncementPushService = new CriticalAnnouncementPushService();
