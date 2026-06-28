/**
 * webhookFailOpen — L0-Ops / US-095 [OPS-006] 飞书 webhook fail-open + fallback_log + retry
 *
 * 主流程契约: 飞书 webhook POST 失败时绝不阻塞 caller (sender 已 fail-OPEN 返
 * `{success:false, message}`, 本模块**额外**把失败 snapshot 落库,
 * `WEBHOOK_FALLBACK_RETRY` cron 每 5min 扫 pending 行重投递).
 *
 * 设计要点 — 不入侵 FeishuBotWebhookService 现有 N 个 sendXxx 方法:
 *   - caller 用 `wrapFeishuWebhookFailOpen({channel, scenario, webhookUrl, payload}, sender)`
 *     包一层; sender 是返 Promise<FeishuBotWebhookSendResult> 的 thunk
 *     (典型: `() => feishuBotWebhookService.sendDailyDigestCard(...)`).
 *   - sender 返 success=false 或 throw → 本模块 INSERT 一行 status='pending'
 *     并把 caller 收到的 result 原样返回 (主流程行为完全不变).
 *   - sender 成功 → 不落库, 不影响延迟 (single-row INSERT 仅在失败路径).
 *
 * Cron 端 `retryPendingFallbacks({source, limit?, now?, dispatchers})`:
 *   - 扫 status='pending' AND next_retry_at <= now LIMIT N 行;
 *   - 按 row.scenario 查 dispatchers 映射拿 sender 函数, 透传 row.payload 调一次;
 *   - 成功 → status='sent' + sent_at; 失败 attempts+=1 +
 *     next_retry_at=now + BACKOFF[attempts] clamp 4h;
 *   - attempts >= max_attempts → status='dead' + dead_at (人工介入).
 *
 * 不变量:
 *   - 主流程行为不变: 任何 sender 失败都返同样的 `{success:false, ...}` 给 caller;
 *   - DB 失败不传染: log INSERT 自身失败仅 logger.warn 吞错, 返原 sender result;
 *   - retry 不依赖 env: webhook_url / payload 都在 row 里, env 改了不影响在飞历史;
 *   - sender 工厂注入: 单测注入 fake sender + fake repo 完整覆盖 happy/fail/throw 4 路径,
 *     无需起 DB; 与 [[Risk guard 三件套]] / [[ai-polling-enqueue]] 同款 DataSource DI 思想.
 *
 * 与既有模块的边界:
 *   - FeishuBotWebhookService — 既有 sender (sendRecommendationSummary /
 *     sendDailyDigestCard / sendRiskAlertCard / sendEarningsForecastCard / etc);
 *     每个 send 方法**内部已 fail-OPEN** 返 success=false 而非 throw, 本模块顺着
 *     这个契约工作 (success=false 即视为失败要 log).
 *   - RiskAlertService (US-005) — 多通道 dispatcher; 调 feishuBotWebhookService 时
 *     可包一层 wrapFeishuWebhookFailOpen 让 webhook 通道有兜底
 *     (本 story 不强制接入; 留给后续 story 按需开).
 *
 * Cron 注册位置 (cronRegistry.ts): `WEBHOOK_FALLBACK_RETRY`, recommendedCron
 * `'\*\/5 \* \* \* \*'` (每 5min 跑一次, 与首次失败 INSERT 的默认 next_retry_at=5min 对齐).
 */

import { logger } from '../utils/logger';

/** sender 返值契约 — 与 FeishuBotWebhookService 各 sendXxx 返值同 shape. */
export interface WebhookSendResult {
  success: boolean;
  skipped?: boolean;
  message?: string;
  data?: any;
  /** HTTP status code (可选; 失败时 caller 可塞进来便于落 last_status_code). */
  status_code?: number;
}

export type WebhookChannel = 'feishu' | 'feishu_ops';

/** 已知的 sender scenario (caller 自报; retry cron 按此映射回 sender 函数). */
export const WEBHOOK_SCENARIOS = Object.freeze([
  'sendRecommendationSummary',
  'sendDailyDigestCard',
  'sendRiskAlertCard',
  'sendEarningsForecastCard',
  'sendEarningsForecastDigestCard',
  'sendCriticalAnnouncement',
  'sendAttributionReport',
  'sendImprovementSuggestion',
  'sendOpsAlertText',
  'sendOther',
] as const);

export type WebhookScenario = (typeof WEBHOOK_SCENARIOS)[number];

/** 单条 fallback log row 的 in-memory 视图 (与 model 字段对齐). */
export interface WebhookFallbackLogRow {
  id: number;
  channel: WebhookChannel;
  scenario: WebhookScenario | string;
  webhook_url: string;
  payload: Record<string, unknown>;
  last_error: string;
  last_status_code: number | null;
  attempts: number;
  max_attempts: number;
  status: 'pending' | 'sent' | 'dead';
  next_retry_at: Date;
  last_attempt_at: Date | null;
  sent_at: Date | null;
  dead_at: Date | null;
  metadata: Record<string, unknown>;
}

export interface WrapWebhookFailOpenArgs {
  channel: WebhookChannel;
  scenario: WebhookScenario | string;
  webhookUrl: string;
  /** 原始 send 参数 — retry cron 序列化传给 sender; 不要塞循环引用. */
  payload: Record<string, unknown>;
  /** 可选 caller 元数据 (caller_module / cron_run_id / etc). */
  metadata?: Record<string, unknown>;
  /** caller 可覆盖最大重试次数 (默认 5). */
  maxAttempts?: number;
}

export type SenderThunk = () => Promise<WebhookSendResult>;

/**
 * DataSource — DB 层抽象, 单测注入 fake 完整覆盖.
 * Production 实现 lazy-require model 避开 sequelize 顶层 import (与
 * RiskAlertService / aiPollingEnqueue 同款).
 */
export interface WebhookFallbackLogDataSource {
  insertFallback(input: {
    channel: WebhookChannel;
    scenario: string;
    webhook_url: string;
    payload: Record<string, unknown>;
    last_error: string;
    last_status_code: number | null;
    attempts: number;
    max_attempts: number;
    next_retry_at: Date;
    metadata: Record<string, unknown>;
  }): Promise<WebhookFallbackLogRow | null>;

  /** 扫 status='pending' AND next_retry_at <= now LIMIT N. */
  loadPending(now: Date, limit: number): Promise<WebhookFallbackLogRow[]>;

  /** 重试成功 → status='sent'. */
  markSent(id: number, now: Date): Promise<void>;

  /** 重试失败但仍可再试 → attempts+=1 + next_retry_at + last_error. */
  markRetryFailed(input: {
    id: number;
    attempts: number;
    next_retry_at: Date;
    last_error: string;
    last_status_code: number | null;
    last_attempt_at: Date;
  }): Promise<void>;

  /** 达到 max_attempts → status='dead'. */
  markDead(input: {
    id: number;
    last_error: string;
    last_status_code: number | null;
    last_attempt_at: Date;
    dead_at: Date;
  }): Promise<void>;
}

/* ===========================================================================
 * 常量 — backoff 阶梯 + 默认上限 (与 migration default 同步)
 * =========================================================================== */

export const DEFAULT_MAX_ATTEMPTS = 5;

/** 第 N 次失败后, 下一次重试的延迟 (毫秒). attempts=1 → next 5min. */
export const DEFAULT_FIRST_BACKOFF_MS = 5 * 60 * 1000;

/** 指数 backoff 上限 (即 80min 后封顶, 防 cron 永远不再扫). */
export const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000;

/** cron 单次扫的最大 row 数 (防一次扫太多卡主线程). */
export const DEFAULT_RETRY_BATCH_SIZE = 50;

/* ===========================================================================
 * 纯函数 helpers — 阶梯计算 / 错误分类 (全 export 单测)
 * =========================================================================== */

/** attempts=1 → 5min; 2 → 10min; 3 → 20min; ...; clamp MAX_BACKOFF_MS. */
export function computeNextBackoffMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) return DEFAULT_FIRST_BACKOFF_MS;
  const n = Math.max(1, Math.floor(attempts));
  const ms = DEFAULT_FIRST_BACKOFF_MS * Math.pow(2, n - 1);
  return Math.min(ms, MAX_BACKOFF_MS);
}

/** 从 SendResult / Error 抽取 last_error 文本 + status_code (用于落库). */
export function extractErrorInfo(resultOrError: WebhookSendResult | Error | unknown): {
  last_error: string;
  last_status_code: number | null;
} {
  if (resultOrError instanceof Error) {
    const anyErr = resultOrError as any;
    const status = Number.isFinite(anyErr?.response?.status)
      ? Number(anyErr.response.status)
      : Number.isFinite(anyErr?.status_code)
      ? Number(anyErr.status_code)
      : null;
    return {
      last_error: String(anyErr?.message || resultOrError.toString() || 'unknown error'),
      last_status_code: status,
    };
  }
  const r = (resultOrError || {}) as WebhookSendResult;
  return {
    last_error: String(r.message || 'webhook send failed'),
    last_status_code:
      typeof r.status_code === 'number' && Number.isFinite(r.status_code) ? r.status_code : null,
  };
}

/** skipped=true (e.g. webhook 未配置 / DISABLE 开关) 不算失败, 不落 log. */
export function isSkippedResult(r: WebhookSendResult | null | undefined): boolean {
  if (!r) return false;
  return r.success === false && r.skipped === true;
}

/* ===========================================================================
 * 主入口: wrapFeishuWebhookFailOpen (caller 包 sender)
 * =========================================================================== */

/**
 * sender 失败 → INSERT 一行 status='pending', **返原 result 给 caller**.
 * sender throw → 同样落 log, 但 throw 不再向上抛 (转 `{success:false, message}`),
 *   主流程绝不阻塞.
 * sender 成功 → 不落 log, 直接返 result.
 *
 * @param args   caller 上下文 (channel / scenario / webhookUrl / payload / metadata)
 * @param sender thunk: 真实 sender (典型: `() => feishuBotWebhookService.sendDailyDigestCard(...)`)
 * @param source DB 层注入点 (默认 createProductionWebhookFallbackLogDataSource())
 */
export async function wrapFeishuWebhookFailOpen(
  args: WrapWebhookFailOpenArgs,
  sender: SenderThunk,
  source?: WebhookFallbackLogDataSource
): Promise<WebhookSendResult> {
  const ds = source || createProductionWebhookFallbackLogDataSource();
  let result: WebhookSendResult;
  try {
    result = await sender();
  } catch (err: any) {
    const info = extractErrorInfo(err);
    await safeInsertFallback(ds, args, info);
    // sender throw → 主流程不抛, 转 fail-OPEN 返值 (与 sender 返 success=false 等价).
    return { success: false, message: info.last_error };
  }
  if (!result || result.success === true) {
    return result || { success: true };
  }
  if (isSkippedResult(result)) {
    // skipped 不算失败, 不落 log.
    return result;
  }
  const info = extractErrorInfo(result);
  await safeInsertFallback(ds, args, info);
  return result;
}

async function safeInsertFallback(
  ds: WebhookFallbackLogDataSource,
  args: WrapWebhookFailOpenArgs,
  info: { last_error: string; last_status_code: number | null }
): Promise<void> {
  try {
    const maxAttempts = Number.isFinite(args.maxAttempts as number)
      ? Math.max(1, Math.floor(args.maxAttempts as number))
      : DEFAULT_MAX_ATTEMPTS;
    await ds.insertFallback({
      channel: args.channel,
      scenario: String(args.scenario || 'sendOther'),
      webhook_url: String(args.webhookUrl || ''),
      payload: args.payload || {},
      last_error: info.last_error,
      last_status_code: info.last_status_code,
      attempts: 1,
      max_attempts: maxAttempts,
      // INSERT 时 next_retry_at = NOW + FIRST_BACKOFF (cron 5min 后扫到).
      next_retry_at: new Date(Date.now() + DEFAULT_FIRST_BACKOFF_MS),
      metadata: args.metadata || {},
    });
  } catch (dbErr: any) {
    // DB INSERT 自身失败仅 logger.warn 吞错 — 绝不让 fallback 兜底反过来挂主流程.
    logger.warn(
      `[webhookFailOpen] insertFallback failed (channel=${args.channel} scenario=${
        args.scenario
      }): ${dbErr?.message || dbErr}`
    );
  }
}

/* ===========================================================================
 * Cron 入口: retryPendingFallbacks (WEBHOOK_FALLBACK_RETRY cron 调)
 * =========================================================================== */

export interface RetryPendingFallbacksInput {
  /** scenario → sender 工厂; sender 接 row.payload 调真实 send 方法. */
  dispatchers: Record<
    string,
    (payload: Record<string, unknown>, row: WebhookFallbackLogRow) => Promise<WebhookSendResult>
  >;
  /** 单次扫 LIMIT (默认 DEFAULT_RETRY_BATCH_SIZE). */
  limit?: number;
  /** 注入 now 让单测可控时间. */
  now?: Date;
  /** 可选 DataSource (默认生产). */
  source?: WebhookFallbackLogDataSource;
  /**
   * Phase 10 缺漏 P1-4 (2026-06-28): 元告警 hook (测试注入).
   * 默认 pushSystemAdminAlertFireAndForget. 整 cron 跑完 dead_count > 0 时推 1 次
   * (dedup_key='webhook_fallback_dead_burst', 1h dedup).
   */
  meta_alert_push?: (input: {
    dedup_key: string;
    level: 'HIGH';
    title: string;
    body_markdown: string;
    triggered_at: string;
  }) => void;
}

export interface RetryPendingFallbacksSummary {
  total: number;
  sent_count: number;
  retry_failed_count: number;
  dead_count: number;
  skipped_unknown_scenario_count: number;
  per_row: Array<{
    id: number;
    scenario: string;
    status: 'sent' | 'retry_failed' | 'dead' | 'skipped_unknown_scenario';
    last_error?: string;
  }>;
}

/**
 * cron 主入口 — 扫 pending 行 + 透传 sender 重投递.
 *
 * 不 throw — 单 row 失败仅本 row counters +=1; 整体 catch 顶层吞错返 summary.
 */
export async function retryPendingFallbacks(
  input: RetryPendingFallbacksInput
): Promise<RetryPendingFallbacksSummary> {
  const ds = input.source || createProductionWebhookFallbackLogDataSource();
  const now = input.now || new Date();
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Number(input.limit))
    : DEFAULT_RETRY_BATCH_SIZE;

  const summary: RetryPendingFallbacksSummary = {
    total: 0,
    sent_count: 0,
    retry_failed_count: 0,
    dead_count: 0,
    skipped_unknown_scenario_count: 0,
    per_row: [],
  };

  let rows: WebhookFallbackLogRow[];
  try {
    rows = await ds.loadPending(now, limit);
  } catch (err: any) {
    logger.warn(`[webhookFailOpen] loadPending failed: ${err?.message || err}`);
    return summary;
  }
  summary.total = rows.length;

  for (const row of rows) {
    const sender = input.dispatchers[row.scenario];
    if (typeof sender !== 'function') {
      summary.skipped_unknown_scenario_count += 1;
      summary.per_row.push({
        id: row.id,
        scenario: row.scenario,
        status: 'skipped_unknown_scenario',
      });
      continue;
    }

    let result: WebhookSendResult;
    try {
      result = await sender(row.payload, row);
    } catch (err: any) {
      result = { success: false, message: String(err?.message || err) };
    }

    if (result && result.success === true) {
      try {
        await ds.markSent(row.id, now);
      } catch (dbErr: any) {
        logger.warn(`[webhookFailOpen] markSent failed (id=${row.id}): ${dbErr?.message || dbErr}`);
      }
      summary.sent_count += 1;
      summary.per_row.push({ id: row.id, scenario: row.scenario, status: 'sent' });
      continue;
    }

    const info = extractErrorInfo(result);
    const nextAttempts = row.attempts + 1;

    if (nextAttempts >= row.max_attempts) {
      try {
        await ds.markDead({
          id: row.id,
          last_error: info.last_error,
          last_status_code: info.last_status_code,
          last_attempt_at: now,
          dead_at: now,
        });
      } catch (dbErr: any) {
        logger.warn(`[webhookFailOpen] markDead failed (id=${row.id}): ${dbErr?.message || dbErr}`);
      }
      summary.dead_count += 1;
      summary.per_row.push({
        id: row.id,
        scenario: row.scenario,
        status: 'dead',
        last_error: info.last_error,
      });
      continue;
    }

    try {
      await ds.markRetryFailed({
        id: row.id,
        attempts: nextAttempts,
        next_retry_at: new Date(now.getTime() + computeNextBackoffMs(nextAttempts)),
        last_error: info.last_error,
        last_status_code: info.last_status_code,
        last_attempt_at: now,
      });
    } catch (dbErr: any) {
      logger.warn(
        `[webhookFailOpen] markRetryFailed failed (id=${row.id}): ${dbErr?.message || dbErr}`
      );
    }
    summary.retry_failed_count += 1;
    summary.per_row.push({
      id: row.id,
      scenario: row.scenario,
      status: 'retry_failed',
      last_error: info.last_error,
    });
  }

  // Phase 10 缺漏 P1-4 (2026-06-28): 本次 cron 跑出 dead row → 一次性元告警.
  // dead = 重试到上限仍失败 = 该消息永久丢弃, OPS 必须人工干预 (查 webhook_url
  // 配置 / 飞书侧 rate limit / 模板格式). 元告警 dedup_key 让 1h 内 N 个 dead
  // 只推 1 次, 避免风暴.
  if (summary.dead_count > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sysMod = require('./SystemAdminAlertPusher');
      const pushFn =
        input.meta_alert_push ||
        (sysMod && typeof sysMod.pushSystemAdminAlertFireAndForget === 'function'
          ? sysMod.pushSystemAdminAlertFireAndForget
          : null);
      if (pushFn) {
        const deadIds = summary.per_row
          .filter(r => r.status === 'dead')
          .map(r => `${r.id}(${r.scenario})`)
          .slice(0, 10) // 截 10 个防 body 太长
          .join(', ');
        pushFn({
          dedup_key: 'webhook_fallback_dead_burst',
          level: 'HIGH',
          title: `[HIGH] webhook fallback ${summary.dead_count} 条进入 dead 状态`,
          body_markdown:
            `**触发原因**: WEBHOOK_FALLBACK_RETRY cron 本次跑出 ${summary.dead_count} 条 dead row\n` +
            `**含义**: 这些消息重试到 max_attempts 仍失败, 已**永久丢弃**\n` +
            `**dead row IDs**: ${deadIds}${summary.dead_count > 10 ? ` ...+${summary.dead_count - 10}` : ''}\n` +
            `**dedup**: 1h 内本元告警只推 1 次 (SystemAdminAlertPusher 默认窗口)\n` +
            `**排查方向**: webhook URL 配置 / 飞书 rate limit / payload schema`,
          triggered_at: now.toISOString(),
        });
      }
    } catch (metaErr: any) {
      logger.warn(
        `[webhookFailOpen] dead-burst 元告警 push 异常 (吞错保护): ${metaErr?.message || metaErr}`
      );
    }
  }

  return summary;
}

/* ===========================================================================
 * Production DataSource — lazy-require WebhookFallbackLog model
 * =========================================================================== */

export function createProductionWebhookFallbackLogDataSource(): WebhookFallbackLogDataSource {
  return {
    async insertFallback(input) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { WebhookFallbackLog } = require('../models/WebhookFallbackLog');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const row = await WebhookFallbackLog.create(input);
        return toRow(row);
      } catch (err: any) {
        logger.warn(`[webhookFailOpen] production insertFallback failed: ${err?.message || err}`);
        return null;
      }
    },
    async loadPending(now, limit) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { WebhookFallbackLog } = require('../models/WebhookFallbackLog');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const rows = await WebhookFallbackLog.findAll({
          where: {
            status: 'pending',
            next_retry_at: { [Op.lte]: now },
          },
          order: [['next_retry_at', 'ASC']],
          limit,
        });
        return rows.map(toRow);
      } catch (err: any) {
        logger.warn(`[webhookFailOpen] production loadPending failed: ${err?.message || err}`);
        return [];
      }
    },
    async markSent(id, now) {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { WebhookFallbackLog } = require('../models/WebhookFallbackLog');
      /* eslint-enable @typescript-eslint/no-var-requires */
      await WebhookFallbackLog.update(
        { status: 'sent', sent_at: now, last_attempt_at: now },
        { where: { id } }
      );
    },
    async markRetryFailed(input) {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { WebhookFallbackLog } = require('../models/WebhookFallbackLog');
      /* eslint-enable @typescript-eslint/no-var-requires */
      await WebhookFallbackLog.update(
        {
          attempts: input.attempts,
          next_retry_at: input.next_retry_at,
          last_error: input.last_error,
          last_status_code: input.last_status_code,
          last_attempt_at: input.last_attempt_at,
        },
        { where: { id: input.id } }
      );
    },
    async markDead(input) {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { WebhookFallbackLog } = require('../models/WebhookFallbackLog');
      /* eslint-enable @typescript-eslint/no-var-requires */
      await WebhookFallbackLog.update(
        {
          status: 'dead',
          last_error: input.last_error,
          last_status_code: input.last_status_code,
          last_attempt_at: input.last_attempt_at,
          dead_at: input.dead_at,
        },
        { where: { id: input.id } }
      );
    },
  };
}

function toRow(model: any): WebhookFallbackLogRow {
  return {
    id: Number(model.id),
    channel: model.channel,
    scenario: model.scenario,
    webhook_url: model.webhook_url,
    payload: model.payload || {},
    last_error: model.last_error || '',
    last_status_code: model.last_status_code ?? null,
    attempts: Number(model.attempts) || 0,
    max_attempts: Number(model.max_attempts) || DEFAULT_MAX_ATTEMPTS,
    status: model.status,
    next_retry_at:
      model.next_retry_at instanceof Date ? model.next_retry_at : new Date(model.next_retry_at),
    last_attempt_at: model.last_attempt_at ? new Date(model.last_attempt_at) : null,
    sent_at: model.sent_at ? new Date(model.sent_at) : null,
    dead_at: model.dead_at ? new Date(model.dead_at) : null,
    metadata: model.metadata || {},
  };
}
