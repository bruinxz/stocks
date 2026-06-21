/**
 * DailyAttributionFeishuPushService — US-086 [PM-009] 飞书 push DailyAttribution.
 *
 * DailyAttributionCronRunner (US-083 PM-006) 在 17:00 工作日 cron 跑完后, 把
 * 当日所有 status='ok' 的 DailyAttributionReport (含 AI/heuristic summary +
 * 6 维 breakdown + best/worst) 顺序 fan-out 到 OPS 飞书群 (text webhook), 让
 * 操盘手 17:35 前在手机/PC 上看到当日归因 — 对齐 PRD AC §E.1 "推送" + "17:35
 * 前送达" 时窗.
 *
 * **路由契约** (与 [[CriticalAnnouncementPushService]] / [[RiskAlertService]]
 * fail-OPEN 同款):
 *   - 仅 `status === 'ok'` 且 persisted=true 的 portfolio 才推 (dry_run / skipped /
 *     failed / persist_failed 一律 skip — 否则空报告 push 风暴);
 *   - `OPS_ALERT_FEISHU_WEBHOOK` 未配置 → 整批 skip (与 OPS-003 / OPS-005 /
 *     ANN-007 同款 fail-OPEN: 没 webhook 不阻塞 cron);
 *   - per-message try-catch, 单条失败不阻塞批内其他条;
 *   - 顶层 try/catch 兜底 — push 失败绝不影响 cron summary 返回.
 *
 * **设计原则** (复用 [[CriticalAnnouncementPushService]] 6 件套):
 *   - DataSource DI seam (FeishuWebhookPoster), 单测注入 fake 完全脱离 HTTP;
 *   - 纯函数 helpers 全 export (buildDailyAttributionPushText / shouldPushItem /
 *     resolveWebhookUrl);
 *   - 顺序 fan-out (paper trading portfolio 数极少, 通常 1-10 个);
 *   - text msg 而非 interactive card — 与 audit-task-parameters-dry-run.ts +
 *     ANN-007 同款轻量路径, 不引入 buildCard 反向依赖;
 *   - 单批 cap MAX_PUSH_PER_BATCH=20 防风暴 (多账号灰度场景);
 *   - reason 用 enum (no_webhook / no_records / dry_run / top_level_error) 让
 *     Grafana 可按 label group.
 *
 * **为什么不复用 CriticalAnnouncementPushService?**
 *   - CriticalAnnouncementPushService 输入是 AnnouncementNLPRecord (公告级
 *     事件), 输出格式 "🚨 [CRITICAL 公告]"; 而本服务输入是 DailyAttributionReport
 *     (portfolio-level 归因), 输出格式 "📊 [盘后归因]" — 业务语义/字段都不同,
 *     强塞会让 buildText 充满 if (kind==='announcement') 分支, 不如各自一个文件.
 *   - 但 6 件套结构完全对齐 (constant / type / pure helpers / DataSource /
 *     service class / singleton), 后续 PM 类 push 都按本模板抽.
 */

import { logger } from '../../utils/logger';
import { DailyAttributionReport } from './DailyAttributionService';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** 单批最多推送条数 (防风暴 — 多账号灰度时可能 5-10 个 portfolio 同时 ok). */
export const DAILY_ATTRIBUTION_PUSH_MAX_PER_BATCH = 20;

/** 单条文本上限 (飞书 webhook content.text 长度限制 ~30k, 这里给余量) */
export const DAILY_ATTRIBUTION_PUSH_MAX_TEXT_LEN = 1200;

/** 单条 push 顶部 emoji + 标签 — 与 CriticalAnnouncementPushService 风格统一. */
export const DAILY_ATTRIBUTION_PUSH_HEADER = '📊 [盘后归因]';

export interface DailyAttributionPushItem {
  portfolio_id: number;
  report: DailyAttributionReport;
}

export interface DailyAttributionPushItemResult {
  portfolio_id: number;
  date: string;
  attempted: boolean;
  success: boolean;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
}

export interface DailyAttributionPushResult {
  scanned: number;
  attempted: number;
  succeeded: number;
  failed: number;
  /** 整批 skip 原因 — 一旦设置, items 为空且 attempted=0 */
  skipped_reason?: 'no_webhook' | 'no_records' | 'top_level_error';
  items: DailyAttributionPushItemResult[];
  error?: string;
}

export interface DailyAttributionPushOptions {
  /** override OPS_ALERT_FEISHU_WEBHOOK env (主要给单测 / 多租户场景) */
  webhook_url?: string;
  /** 不真发, 只返回若推会发什么 (cron preview / UI 试推) */
  dry_run?: boolean;
  /** 单批上限覆盖 (默认 DAILY_ATTRIBUTION_PUSH_MAX_PER_BATCH) */
  max_per_batch?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * shouldPushItem — caller 已 filter status=ok+persisted=true, 这里再守一遍
 * report 非空 + 必要字段齐 (双重保险防 caller 误传 skipped/failed item).
 */
export function shouldPushItem(item: DailyAttributionPushItem | null | undefined): boolean {
  if (!item) return false;
  if (!item.report) return false;
  if (!Number.isFinite(Number(item.portfolio_id))) return false;
  if (typeof item.report.date !== 'string' || item.report.date.length === 0) return false;
  return true;
}

/**
 * buildDailyAttributionPushText — 飞书 text webhook 的消息体.
 *
 * 输出格式 (与 [[buildCriticalAnnouncementText]] / RiskAlertService.buildOpsAlertText
 * 同款 emoji 头 + 多行 body + 触发规则尾):
 *
 *   📊 [盘后归因] portfolio={id} 日期={date}
 *   总盈亏 +X.XX 元 (+1.23%)
 *   已实现 +X.XX | 浮盈变动 +X.XX
 *   成交 N 笔 (买M/卖K)
 *   行业贡献 TOP: 电子 +X.XX / 医药 -Y.YY ...
 *   执行成本 X.XX 元
 *   AI 总结: {ai_summary}
 *   触发规则: daily_attribution_post_close_push
 *
 * 总长度超 DAILY_ATTRIBUTION_PUSH_MAX_TEXT_LEN 时截断末尾加 '...' + 保留尾行
 * (触发规则), 与 ANN-007 同款"截断保留尾行让 ops 知道哪条规则触发"模式.
 */
export function buildDailyAttributionPushText(item: DailyAttributionPushItem): string {
  const { portfolio_id, report } = item;
  const lines: string[] = [];
  lines.push(`${DAILY_ATTRIBUTION_PUSH_HEADER} portfolio=${portfolio_id} 日期=${report.date}`);

  const sign = report.total_pnl > 0 ? '+' : '';
  const pctStr =
    report.total_pnl_pct == null ? '—' : `${(report.total_pnl_pct as number).toFixed(2)}%`;
  lines.push(`总盈亏 ${sign}${Number(report.total_pnl).toFixed(2)} 元 (${pctStr})`);

  const realizedSign = report.realized_pnl >= 0 ? '+' : '';
  const unrealizedSign = report.unrealized_delta >= 0 ? '+' : '';
  lines.push(
    `已实现 ${realizedSign}${Number(report.realized_pnl).toFixed(
      2
    )} | 浮盈变动 ${unrealizedSign}${Number(report.unrealized_delta).toFixed(2)}`
  );

  lines.push(`成交 ${report.trade_count} 笔 (买${report.buy_count}/卖${report.sell_count})`);

  const topIndustries = (report.breakdown?.industry_contrib || []).slice(0, 3);
  if (topIndustries.length > 0) {
    const parts = topIndustries.map(it => {
      const s = it.pnl >= 0 ? '+' : '';
      return `${it.industry} ${s}${Number(it.pnl).toFixed(2)}`;
    });
    lines.push(`行业贡献 TOP: ${parts.join(' / ')}`);
  }

  if (report.breakdown?.execution_cost > 0) {
    lines.push(`执行成本 ${Number(report.breakdown.execution_cost).toFixed(2)} 元`);
  }

  const aiSummary = String(report.ai_summary || '').trim();
  if (aiSummary) {
    lines.push(`AI 总结: ${aiSummary}`);
  }

  lines.push('触发规则: daily_attribution_post_close_push');

  const text = lines.join('\n');
  if (text.length <= DAILY_ATTRIBUTION_PUSH_MAX_TEXT_LEN) return text;
  const tail = '\n触发规则: daily_attribution_post_close_push';
  const head = text.slice(0, Math.max(0, DAILY_ATTRIBUTION_PUSH_MAX_TEXT_LEN - tail.length - 3));
  return `${head}...${tail}`;
}

/**
 * resolveWebhookUrl — 解析最终使用的 webhook url.
 * - options.webhook_url 优先 (单测注入 / 多租户);
 * - 否则取 env.OPS_ALERT_FEISHU_WEBHOOK (与 [[CriticalAnnouncementPushService.resolveWebhookUrl]] /
 *   RiskAlertService / audit-task-parameters-dry-run.ts 同款 env 名);
 * - trim 后为空字符串 → 返回 null (caller short-circuit).
 */
export function resolveWebhookUrl(
  options: DailyAttributionPushOptions = {},
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
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
 * 生产飞书 webhook poster — 与 [[defaultCriticalAnnouncementFeishuPoster]] /
 * audit-task-parameters-dry-run.ts 同款轻量 axios POST + fail-OPEN.
 *
 * 复用 OPS_ALERT_FEISHU_TIMEOUT_MS 与其他 ops 通道保持一致的超时配置.
 */
export async function defaultDailyAttributionFeishuPoster(
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
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { success: false, message: e?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DailyAttributionFeishuPushService {
  private readonly poster: FeishuWebhookPoster;

  constructor(poster: FeishuWebhookPoster = defaultDailyAttributionFeishuPoster) {
    this.poster = poster;
  }

  /**
   * 主入口 — 给一批刚 persist 的 portfolio report 逐条 push 飞书.
   *
   * 顶层 try/catch 兜底 — 任何异常都吞掉返 error 字段, 主流程 (cron runner)
   * 绝不被本通道阻塞.
   */
  async pushBatch(
    items: DailyAttributionPushItem[],
    options: DailyAttributionPushOptions = {},
    env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
  ): Promise<DailyAttributionPushResult> {
    const scanned = Array.isArray(items) ? items.length : 0;
    try {
      if (scanned === 0) {
        return {
          scanned: 0,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          skipped_reason: 'no_records',
          items: [],
        };
      }

      const candidates = items.filter(shouldPushItem);
      if (candidates.length === 0) {
        return {
          scanned,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          skipped_reason: 'no_records',
          items: [],
        };
      }

      const webhook = resolveWebhookUrl(options, env);
      if (!webhook && options.dry_run !== true) {
        logger.info(
          `[DailyAttributionPush] OPS_ALERT_FEISHU_WEBHOOK 未配置, skip ${candidates.length} portfolio push.`
        );
        return {
          scanned,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          skipped_reason: 'no_webhook',
          items: [],
        };
      }

      const cap = Math.max(
        1,
        Math.floor(options.max_per_batch ?? DAILY_ATTRIBUTION_PUSH_MAX_PER_BATCH)
      );
      const toPush = candidates.slice(0, cap);
      const truncatedTail = candidates.slice(cap);

      const out: DailyAttributionPushItemResult[] = [];
      let succeeded = 0;
      let failed = 0;

      for (const item of toPush) {
        const text = buildDailyAttributionPushText(item);
        if (options.dry_run === true) {
          out.push({
            portfolio_id: item.portfolio_id,
            date: item.report.date,
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
            out.push({
              portfolio_id: item.portfolio_id,
              date: item.report.date,
              attempted: true,
              success: true,
            });
          } else {
            failed += 1;
            logger.warn(
              `[DailyAttributionPush] feishu post failed for portfolio=${item.portfolio_id} date=${
                item.report.date
              }: ${r.message || 'unknown'}`
            );
            out.push({
              portfolio_id: item.portfolio_id,
              date: item.report.date,
              attempted: true,
              success: false,
              error: r.message || 'feishu post failed',
            });
          }
        } catch (err: unknown) {
          // defaultDailyAttributionFeishuPoster 已 fail-OPEN; 兜底用户自注入 poster 抛 sync error.
          failed += 1;
          const e = err as { message?: string };
          logger.warn(
            `[DailyAttributionPush] poster threw for portfolio=${item.portfolio_id}: ${
              e?.message || err
            }`
          );
          out.push({
            portfolio_id: item.portfolio_id,
            date: item.report.date,
            attempted: true,
            success: false,
            error: e?.message || String(err),
          });
        }
      }

      // truncate 的尾部也登记一笔 skip, 便于 ops 看到 "今天 portfolio 数超 cap"
      for (const item of truncatedTail) {
        out.push({
          portfolio_id: item.portfolio_id,
          date: item.report.date,
          attempted: false,
          success: false,
          skipped: true,
          skip_reason: 'truncated_batch',
        });
      }

      if (truncatedTail.length > 0) {
        logger.warn(
          `[DailyAttributionPush] batch truncated: ${candidates.length} matched > cap=${cap}, skipped ${truncatedTail.length} tail items.`
        );
      }

      logger.info(
        `[DailyAttributionPush] scanned=${scanned} matched=${candidates.length} ` +
          `attempted=${toPush.length} succeeded=${succeeded} failed=${failed} dry_run=${
            options.dry_run === true
          }`
      );

      return {
        scanned,
        attempted: toPush.length,
        succeeded,
        failed,
        items: out,
      };
    } catch (err: unknown) {
      // 双重防御外层 catch — 主流程 (cron runner) 绝不被本通道阻塞
      const e = err as { message?: string };
      logger.error(`[DailyAttributionPush] top-level failure: ${e?.message || err}`);
      return {
        scanned,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped_reason: 'top_level_error',
        items: [],
        error: e?.message || String(err),
      };
    }
  }
}

/** 生产 singleton — DailyAttributionCronRunner.runDailyAttributionGenerate 内默认使用. */
export const dailyAttributionFeishuPushService = new DailyAttributionFeishuPushService();
