/**
 * ErrorPatternCronRunner — L8-Postmortem / US-093 [PM-022] WEEKLY_ERROR_PATTERN cron 主入口
 *
 * 每周日 10:00 给所有 active user 聚合最近 90 天 DailyAttributionReport →
 * 落 error_pattern_reports (单 user 一周 = 一行, status='ok'/'skipped'/'failed'
 * 三态都 upsert 留痕).
 *
 * 设计遵循 [[AIDiaryCronRunner]] (US-091 PM-020) "cron 批量驱动 + 持久化层"
 * 模板 6 件套, 让 PM 系列 cron 全部共享同一形态:
 *
 *   (1) cron-side DataSource interface 与 service-side ErrorPatternAggregatorDataSource
 *       分两个 — 前者负责"枚举所有 active user", 后者负责"取 attribution + upsert
 *       error_pattern_reports". 职责清晰; 单测 fake 不互相污染.
 *   (2) PRODUCTION_ERROR_PATTERN_CRON_DATA_SOURCE singleton lazy-require User model
 *   (3) 单测注入 fake DataSource 完整覆盖 happy / skipped / failed / dry_run /
 *       upsert 失败 fail-OPEN, 完全脱离 DB
 *   (4) per-user try/catch — 单 user aggregateForUser 兜底转 failed, continue batch
 *   (5) explicit user_ids 优先 / 空时 listActiveUsers 兜底 — ops 可只 replay 某用户
 *   (6) dry_run=true 透传 — 本 service 没有真"零副作用 dry_run" 概念
 *       (upsert 由 service-side data_source 实现侧决定); cron-side dry_run 等价于
 *       "强制 cronSource.listActiveUsers 返 [] 不进任何 user 循环" — 由 caller 显式
 *       传 user_ids: [] 实现, 这里 dry_run 仅用于 summary 标记 + ops 日志
 *
 * 与 ErrorPatternAggregator 的边界:
 *   - aggregateForUser(user_id, {period_end, data_source, lookback_days?, cron_run_id?})
 *     是单 user 聚合入口 (本身已 fail-OPEN, 永不 throw — 见 ErrorPatternAggregator.ts
 *     头部 fail-OPEN 三层注释)
 *   - 本 runner 是 cron 批量驱动 + per-user 兜底, 把 service 返值聚合成 ok/skipped/
 *     failed/persisted 统计返 SchedulerService 写 execution_log
 *
 * 关键不变量:
 *   - period_end 默认取今日 (Asia/Shanghai UTC); ops 显式传 'YYYY-MM-DD' 可 replay
 *     历史窗口
 *   - lookback_days 默认 90 (DEFAULT_LOOKBACK_DAYS); ops 可在 ScheduledTask.parameters
 *     显式覆盖让本 cron 跑短窗口 (e.g. 30d 月度) — service 内部 < MIN_DATA_DAYS 自动
 *     落 status='skipped' reason='data_too_sparse' 留痕
 *   - 单 user service 内部 throw 已被 service 顶层 fail-OPEN 兜底, 但本 runner 仍
 *     套一层 per-user try/catch 防 ts-fake / 程序错误漏网
 */

import { logger } from '../../utils/logger';
import {
  AggregateForUserResult,
  DEFAULT_LOOKBACK_DAYS,
  ERROR_PATTERN_STATUS,
  ErrorPatternAggregatorDataSource,
  ErrorPatternStatus,
  aggregateForUser,
  createProductionErrorPatternAggregatorDataSource,
} from './ErrorPatternAggregator';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认 cron 触发的 cron_run_id 前缀 (落 metadata.cron_run_id 便于 ops grep) */
export const ERROR_PATTERN_CRON_RUN_ID_PREFIX = 'error_pattern_cron_';

/** dry_run 默认值 — cron 默认实际写入, 与 AI_DIARY_GENERATE 对齐 */
export const DEFAULT_ERROR_PATTERN_CRON_DRY_RUN = false;

/** 默认 lookback_days — 与 ErrorPatternAggregator.DEFAULT_LOOKBACK_DAYS 同源 */
export const DEFAULT_ERROR_PATTERN_CRON_LOOKBACK_DAYS = DEFAULT_LOOKBACK_DAYS;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一条 cron 触发的 user 处理结果 (供 SchedulerService 写 execution_log) */
export interface ErrorPatternCronUserResult {
  user_id: number;
  status: ErrorPatternStatus;
  reason: string | null;
  /** service throw 时的错误信息, 不含 stack */
  error?: string;
  /** 是否真正写入了 error_pattern_reports (upsert 失败 → false) */
  persisted: boolean;
}

/** 整批 cron 运行聚合结果 */
export interface ErrorPatternCronRunSummary {
  total_users: number;
  ok_count: number;
  skipped_count: number;
  failed_count: number;
  /** 真正落库 (status=ok|skipped|failed + persisted=true) 的笔数 */
  persisted_count: number;
  /** 本批聚合窗口的 period_end (YYYY-MM-DD) */
  period_end: string;
  /** 本批聚合窗口的天数 (默认 90) */
  lookback_days: number;
  dry_run: boolean;
  /** 本批 cron_run_id, 落 metadata.cron_run_id (Ops 可 grep 同次跑的全部聚合) */
  cron_run_id: string;
  /** 单 user 明细 (调用方按需写 execution_log.result_summary) */
  per_user: ErrorPatternCronUserResult[];
}

/** cron 入口 options — 透传给 ErrorPatternAggregator.aggregateForUser + 控制 dry_run / 范围 */
export interface RunWeeklyErrorPatternOptions {
  /** 'YYYY-MM-DD'; 默认今日 (Asia/Shanghai UTC) — 透传给 aggregateForUser 作 period_end */
  period_end?: string;
  /** 默认 90; 透传给 aggregateForUser 作 lookback_days */
  lookback_days?: number;
  /** 显式 list user_id; 空 / undefined 时枚举所有 is_active=true */
  user_ids?: number[];
  /** dry_run=true 时仅记标记 (cron-side 不进 user 循环 必须显式传 user_ids: [] 实现) */
  dry_run?: boolean;
  /**
   * 单测 / 灰度时可注入 fake cron-side DataSource, 默认走 PRODUCTION lazy-require.
   */
  cron_data_source?: ErrorPatternCronDataSource;
  /**
   * 单测 / 灰度时可注入 fake service-side DataSource (透传给 aggregateForUser).
   */
  service_data_source?: ErrorPatternAggregatorDataSource;
  /**
   * 显式 cron_run_id — 默认 `${PREFIX}${period_end}_${nowMs}`. ops 可显式传同一 id
   * 让重试覆盖原 metadata.cron_run_id (与 sequelize upsert 配合达到 idempotent).
   */
  cron_run_id?: string;
}

/** Cron-side DataSource — 独立于 ErrorPatternAggregator 的 service-side DataSource */
export interface ErrorPatternCronDataSource {
  /** 枚举待聚合的 user_id; cron 默认 is_active=true 全部 */
  listActiveUsers(): Promise<Array<{ id: number }>>;
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require 让单测进程不需要 sequelize 起 DB
// ---------------------------------------------------------------------------

export function createProductionErrorPatternCronDataSource(): ErrorPatternCronDataSource {
  return {
    async listActiveUsers() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { User } = require('../../models/User');
        const rows = await User.findAll({
          where: { is_active: true },
          attributes: ['id'],
          raw: true,
        });
        return (rows as Array<{ id: number }>).map(r => ({ id: Number(r.id) }));
      } catch (err) {
        logger.warn(
          `[error-pattern-cron] listActiveUsers failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
  };
}

const PRODUCTION_ERROR_PATTERN_CRON_DATA_SOURCE: ErrorPatternCronDataSource =
  createProductionErrorPatternCronDataSource();

const PRODUCTION_ERROR_PATTERN_AGGREGATOR_DATA_SOURCE: ErrorPatternAggregatorDataSource =
  createProductionErrorPatternAggregatorDataSource();

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** 归一化日期到 'YYYY-MM-DD'; 与 normalizeDiaryCronDate 同款 (Asia/Shanghai UTC). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function normalizeErrorPatternCronDate(d: unknown): string {
  if (typeof d === 'string' && DATE_RE.test(d)) return d;
  if (typeof d === 'string' && d.length >= 10 && DATE_RE.test(d.slice(0, 10))) {
    return d.slice(0, 10);
  }
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 构造本批默认 cron_run_id — 形如 `error_pattern_cron_2026-06-21_1718856000000`.
 * 同一次 cron 跑里多用户共享同一 cron_run_id, ops grep metadata 一目了然.
 */
export function buildDefaultCronRunId(periodEnd: string): string {
  return `${ERROR_PATTERN_CRON_RUN_ID_PREFIX}${periodEnd}_${Date.now()}`;
}

/** 归一化 lookback_days 入参 — 非正 / NaN / undefined → DEFAULT_LOOKBACK_DAYS. */
export function normalizeLookbackDays(d: unknown): number {
  const n = Number(d);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_LOOKBACK_DAYS;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * Cron 入口 — 枚举所有 active user, 逐个 aggregateForUser.
 *
 * fail-OPEN 双层:
 *   1. service 内部已 fail-OPEN (result.status='failed' / persisted=false) — caller
 *      直接消费 result 计数
 *   2. service throw (极端程序错误, e.g. fake/import 失败) → per-user try/catch
 *      兜底转 status='failed' reason='service_threw' + persisted=false
 *
 * dry_run=true 时仅 summary 标记 + ops 日志; 真正"零副作用 cron preview" 通过
 * explicit user_ids=[] 或 cron_data_source.listActiveUsers 返 [] 实现.
 */
export async function runWeeklyErrorPattern(
  options: RunWeeklyErrorPatternOptions = {}
): Promise<ErrorPatternCronRunSummary> {
  const cronSource = options.cron_data_source || PRODUCTION_ERROR_PATTERN_CRON_DATA_SOURCE;
  const serviceSource =
    options.service_data_source || PRODUCTION_ERROR_PATTERN_AGGREGATOR_DATA_SOURCE;
  const period_end = normalizeErrorPatternCronDate(options.period_end);
  const lookback_days = normalizeLookbackDays(options.lookback_days);
  const dryRun = options.dry_run === true;
  const cronRunId =
    typeof options.cron_run_id === 'string' && options.cron_run_id.length > 0
      ? options.cron_run_id
      : buildDefaultCronRunId(period_end);

  // 枚举 user 范围 — 显式 list 优先, 否则枚举 active
  let targets: Array<{ id: number }> = [];
  if (Array.isArray(options.user_ids)) {
    // user_ids: [] 显式传空 → 跳过 listActiveUsers (dry_run preview 用)
    targets = options.user_ids
      .filter(id => Number.isFinite(id) && Number(id) > 0)
      .map(id => ({ id: Number(id) }));
  } else {
    try {
      targets = await cronSource.listActiveUsers();
    } catch (err) {
      logger.warn(
        `[error-pattern-cron] listActiveUsers threw (treat as empty): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      targets = [];
    }
  }

  const summary: ErrorPatternCronRunSummary = {
    total_users: targets.length,
    ok_count: 0,
    skipped_count: 0,
    failed_count: 0,
    persisted_count: 0,
    period_end,
    lookback_days,
    dry_run: dryRun,
    cron_run_id: cronRunId,
    per_user: [],
  };

  for (const target of targets) {
    const userId = target.id;
    let result: AggregateForUserResult;
    let serviceError: string | undefined;
    try {
      result = await aggregateForUser(userId, {
        period_end,
        data_source: serviceSource,
        lookback_days,
        cron_run_id: cronRunId,
      });
    } catch (err) {
      // service 自身已 fail-OPEN 不该 throw — 兜底转 failed
      logger.warn(
        `[error-pattern-cron] aggregateForUser user=${userId} period_end=${period_end} threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      serviceError = err instanceof Error ? err.message : String(err);
      result = {
        status: ERROR_PATTERN_STATUS.FAILED,
        patterns: {
          bias_patterns: [],
          outcome_patterns: [],
          attribution_patterns: [],
          top_findings: [],
        },
        summary_stats: {
          total_bias_count: 0,
          total_outcome_count: 0,
          total_attribution_days: 0,
          avg_pnl_pct: 0,
          win_rate: 0,
          data_completeness: 'sparse',
        },
        summary: '',
        reason: 'service_threw',
        persisted: false,
      };
    }

    if (result.status === ERROR_PATTERN_STATUS.OK) summary.ok_count += 1;
    else if (result.status === ERROR_PATTERN_STATUS.SKIPPED) summary.skipped_count += 1;
    else summary.failed_count += 1;
    if (result.persisted) summary.persisted_count += 1;

    summary.per_user.push({
      user_id: userId,
      status: result.status,
      reason: result.reason,
      error: serviceError,
      persisted: result.persisted,
    });
  }

  return summary;
}

// 测试 / 调试用 — 暴露 PRODUCTION singleton 让外部 wiring 测试可拿到默认实例
export const __PRODUCTION_ERROR_PATTERN_CRON_DATA_SOURCE_FOR_TEST =
  PRODUCTION_ERROR_PATTERN_CRON_DATA_SOURCE;
