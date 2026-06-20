/**
 * ImprovementEffectTracker — L8-Postmortem / US-146 [PM-027]
 *
 * apply 后 30 天效果跟踪. 对每条 status='applied' 且 applied_at <= NOW - window_days
 * 且尚未跟踪 (effect_tracked_at IS NULL) 的 improvement_suggestion, 从用户名下所有
 * active PaperTradingPortfolio 的 DailyAttributionReport (status='ok') 中
 * 抽 apply_date..apply_date+window 区间的 pnl 序列, 计算:
 *   - total_pnl_sum         Σ total_pnl
 *   - total_pnl_pct_avg     mean(total_pnl_pct) (跳过 null)
 *   - total_pnl_pct_sharpe  mean / stddev × √sample_days (年化前简易, 样本 < 2 → 0)
 *   - trade_count_sum       Σ trade_count
 *   - sample_days           参与计算的 (portfolio, date) 行数
 *   - start_date / end_date 窗口实际边界
 *   - portfolios_covered    distinct portfolio_id 数
 *
 * 写回 improvement_suggestions.effect_metrics JSONB + effect_tracked_at,
 * (id) 单步 update 不动 status / applied_at — tracker 仅"追加 metrics".
 *
 * ─── 设计 (与 [[ImprovementSuggestionService]] / [[AIDiaryService]] 5 件套对齐) ──
 *
 * (1) 常量 / 类型 / 纯函数 helpers 全 export 便于单测
 * (2) ImprovementEffectTrackerDataSource interface 把所有 I/O (枚举 applied 列表 /
 *     取用户 portfolios / 取 attribution reports / 写回 metrics) 抽干净 —
 *     单测注入 fake 完全脱离 DB
 * (3) createProductionImprovementEffectTrackerDataSource() lazy-require model
 * (4) 主入口 trackPendingSuggestions 三层 fail-OPEN — load throw / 单条 trackForSuggestion
 *     throw / writeBack 失败均不抛
 *
 * ─── fail-OPEN 三层 ────────────────────────────────────────────────────────
 *
 * - listPendingApplied throw → status='failed' reason='list_threw', 仍返 summary
 * - 单条 trackForSuggestion throw → per-row 计入 failed_count + continue
 * - writeBackMetrics 失败 → per-row status='persist_failed' + continue 不阻塞下条
 *
 * ─── 与既有 service 边界 ──────────────────────────────────────────────────
 *
 * - 输入端: ImprovementSuggestion (status='applied') + PaperTradingPortfolio + DailyAttributionReport
 * - 输出端: improvement_suggestions.effect_metrics JSONB + effect_tracked_at
 * - PM-024 apply route 写 status='applied' + applied_at, 本 service 是 PM-024 的下游
 * - 未来 cron (PM-028+ 未排期) 接入 SchedulerService 调本 service trackPendingSuggestions
 *   for all users; ops 临时手动跑给单 user / 单 suggestion 走 trackForSuggestion
 *
 * ─── (id) idempotent ───────────────────────────────────────────────────────
 *
 * effect_tracked_at IS NOT NULL 时默认 skip (避免重跑覆盖) ; 显式 force=true 可重算
 * (e.g. heuristic 升级后想刷新历史 metrics).
 */

import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** apply 后窗口默认天数 (PRD US-146 / EV-015 文档 "30 天 effect_metrics"). */
export const DEFAULT_EFFECT_WINDOW_DAYS = 30;

/** sample_days 最小值才算"够算 sharpe"; 2 是 stddev 至少需 2 样本. */
export const MIN_SHARPE_SAMPLE_DAYS = 2;

/** effect_metrics.source 标识 — 区分 cron 自动跑 / ops 手动 replay. */
export const EFFECT_METRICS_SOURCE = Object.freeze({
  TRACKER_CRON: 'tracker_cron',
  MANUAL: 'manual',
} as const);

export type EffectMetricsSource =
  (typeof EFFECT_METRICS_SOURCE)[keyof typeof EFFECT_METRICS_SOURCE];

/** trackForSuggestion 单条结果 status. */
export const TRACK_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const);

export type TrackStatus = (typeof TRACK_STATUS)[keyof typeof TRACK_STATUS];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一条待跟踪 ImprovementSuggestion 的最小投影 (PRODUCTION ds 做 row.toJSON 映射). */
export interface AppliedSuggestionRow {
  id: number;
  user_id: number;
  period_end: string;
  category: string;
  key: string;
  applied_at: Date;
  effect_tracked_at: Date | null;
}

/** DailyAttributionReport 中我们需要的字段 (PRODUCTION ds 投影). */
export interface AttributionDailyRow {
  portfolio_id: number;
  date: string;
  total_pnl: number;
  total_pnl_pct: number | null;
  trade_count: number;
}

/** apply 后效果 metrics (写到 improvement_suggestions.effect_metrics). */
export interface ImprovementEffectMetrics {
  window_days: number;
  sample_days: number;
  total_pnl_sum: number;
  total_pnl_pct_avg: number;
  total_pnl_pct_sharpe: number;
  trade_count_sum: number;
  start_date: string;
  end_date: string;
  portfolios_covered: number;
  source: EffectMetricsSource;
}

export interface ImprovementEffectTrackerDataSource {
  /**
   * 枚举待跟踪 ImprovementSuggestion: status='applied' AND applied_at <= cutoff
   * AND (effect_tracked_at IS NULL OR force).
   * 永不 throw — 失败返 [] + 内部 logger.warn.
   */
  listPendingApplied(input: {
    cutoff: Date;
    force: boolean;
    user_id?: number | null;
    limit?: number;
  }): Promise<AppliedSuggestionRow[]>;
  /**
   * 取用户名下所有 active PaperTradingPortfolio 的 portfolio_id. 永不 throw.
   */
  listUserPortfolios(input: { user_id: number }): Promise<number[]>;
  /**
   * 取 (portfolio_ids, start_date..end_date) 内 status='ok' 的 DailyAttributionReport
   * 行 (按 date ASC). 永不 throw — 失败返 [].
   */
  loadAttributionReports(input: {
    portfolio_ids: number[];
    start_date: string;
    end_date: string;
  }): Promise<AttributionDailyRow[]>;
  /**
   * 把 effect_metrics + effect_tracked_at 写回 improvement_suggestions.
   * 永不 throw — 失败返 {ok:false, reason, error}.
   */
  writeBackMetrics(input: {
    id: number;
    effect_metrics: ImprovementEffectMetrics;
    effect_tracked_at: Date;
  }): Promise<{ ok: boolean; reason?: string; error?: string }>;
}

/** 单条 trackForSuggestion 输出 (给 trackPending 聚合). */
export interface TrackSuggestionResult {
  id: number;
  user_id: number;
  status: TrackStatus;
  reason: string | null;
  metrics: ImprovementEffectMetrics | null;
  /** writeBack 是否真写入 (dry_run / persist failed → false). */
  persisted: boolean;
}

/** trackPending 聚合 summary. */
export interface TrackPendingSummary {
  total_candidates: number;
  ok_count: number;
  skipped_count: number;
  failed_count: number;
  persisted_count: number;
  window_days: number;
  source: EffectMetricsSource;
  dry_run: boolean;
  per_suggestion: TrackSuggestionResult[];
  /** list 阶段 fail-OPEN 时填; ok 路径为 null. */
  reason?: string;
}

export interface TrackPendingOptions {
  data_source: ImprovementEffectTrackerDataSource;
  window_days?: number;
  /** 默认 EFFECT_METRICS_SOURCE.TRACKER_CRON. */
  source?: EffectMetricsSource;
  /** 仅跑指定 user; 不传 = 全 user. */
  user_id?: number | null;
  /** 最多处理 N 条 (cron 灰度 / ops 限流). 默认 0 = 不限. */
  limit?: number;
  /** dry_run=true 时跳过 writeBack, 仅返 metrics. */
  dry_run?: boolean;
  /** force=true 时重算已 tracked 的行 (heuristic 升级后刷新). */
  force?: boolean;
  /** "现在" 时间注入便于单测 / replay (默认 new Date()). */
  now?: Date;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * 把 Date / 'YYYY-MM-DD' 字符串归一化到 'YYYY-MM-DD' (UTC 切日).
 * 非法 → 空串 (caller 自行视为 skip 信号).
 */
export function normalizeDate(d: Date | string | null | undefined): string {
  if (d == null) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (typeof d === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
    const parsed = new Date(d);
    if (!Number.isNaN(parsed.getTime())) return normalizeDate(parsed);
  }
  return '';
}

/**
 * apply_date + window_days → end_date ('YYYY-MM-DD', UTC).
 * end_date = applied_at (UTC date) + window_days 自然日 (inclusive 边界).
 * 注: 实际查 DailyAttributionReport 时按 [start, end] BETWEEN; window=30 即覆盖 31 天?
 * 这里按"apply 当天 = day 0, +window 天到达 day=window" 给到 30 个交易/自然日内的 EOD
 * snapshot. caller 看 sample_days 实际计数 (周末没 DAR 行就少).
 */
export function computeWindowEndDate(appliedAt: Date, windowDays: number): string {
  const ms = appliedAt.getTime() + windowDays * 24 * 3600 * 1000;
  return normalizeDate(new Date(ms));
}

/**
 * 给定 attribution rows (按 date 已升序) → ImprovementEffectMetrics.
 * 永不 throw; rows=[] 时返 sample_days=0 + 全 0.
 */
export function buildEffectMetrics(input: {
  rows: AttributionDailyRow[];
  start_date: string;
  end_date: string;
  window_days: number;
  source: EffectMetricsSource;
}): ImprovementEffectMetrics {
  const { rows, start_date, end_date, window_days, source } = input;
  const sample_days = rows.length;
  if (sample_days === 0) {
    return {
      window_days,
      sample_days: 0,
      total_pnl_sum: 0,
      total_pnl_pct_avg: 0,
      total_pnl_pct_sharpe: 0,
      trade_count_sum: 0,
      start_date,
      end_date,
      portfolios_covered: 0,
      source,
    };
  }
  let pnlSum = 0;
  let tradeSum = 0;
  const pcts: number[] = [];
  const portfolios = new Set<number>();
  for (const r of rows) {
    if (Number.isFinite(r.total_pnl)) pnlSum += Number(r.total_pnl);
    if (Number.isFinite(r.trade_count)) tradeSum += Number(r.trade_count);
    if (r.total_pnl_pct != null && Number.isFinite(r.total_pnl_pct)) {
      pcts.push(Number(r.total_pnl_pct));
    }
    if (Number.isFinite(r.portfolio_id) && r.portfolio_id > 0) portfolios.add(r.portfolio_id);
  }
  const pctAvg = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
  const sharpe = computeSharpeRatio(pcts);
  return {
    window_days,
    sample_days,
    total_pnl_sum: round2(pnlSum),
    total_pnl_pct_avg: round4(pctAvg),
    total_pnl_pct_sharpe: round4(sharpe),
    trade_count_sum: tradeSum,
    start_date,
    end_date,
    portfolios_covered: portfolios.size,
    source,
  };
}

/**
 * 简易 sharpe = mean / stddev × √sample; 不年化 (window 是固定 N 天, 比"看建议是否
 * 让风险调整后收益更好"的相对指标). 样本 < MIN_SHARPE_SAMPLE_DAYS → 0.
 * stddev 用样本无偏估计 (n-1).
 */
export function computeSharpeRatio(pcts: number[]): number {
  const n = pcts.length;
  if (n < MIN_SHARPE_SAMPLE_DAYS) return 0;
  const mean = pcts.reduce((a, b) => a + b, 0) / n;
  let varSum = 0;
  for (const p of pcts) {
    const d = p - mean;
    varSum += d * d;
  }
  const variance = varSum / (n - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return 0;
  return (mean / std) * Math.sqrt(n);
}

function round2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * trackForSuggestion — 给单条 AppliedSuggestionRow 算 metrics + 写回.
 * 永不 throw; fail-OPEN 三态 (ok / skipped / failed).
 *
 * skipped 原因:
 *   - 'no_portfolios'        — 用户没有 active portfolio (例如已注销, 无法采集)
 *   - 'no_attribution_data'  — 窗口内 0 行 DailyAttributionReport (新户 / cron 未跑)
 *   - 'already_tracked'      — effect_tracked_at !== null 且 !force
 *   - 'invalid_applied_at'   — applied_at 缺失 / 非法
 *
 * failed 原因:
 *   - 'list_portfolios_threw' / 'load_attribution_threw' / 'writeback_failed'
 *     (各自由 ds 内 try/catch 转 [] / {ok:false}, 这里捕到的多半是 force throw)
 */
export async function trackForSuggestion(input: {
  data_source: ImprovementEffectTrackerDataSource;
  suggestion: AppliedSuggestionRow;
  window_days: number;
  source: EffectMetricsSource;
  dry_run: boolean;
  force: boolean;
  now: Date;
}): Promise<TrackSuggestionResult> {
  const { data_source: ds, suggestion, window_days, source, dry_run, force, now } = input;
  const baseSkipped = (
    reason: string,
    metrics: ImprovementEffectMetrics | null = null
  ): TrackSuggestionResult => ({
    id: suggestion.id,
    user_id: suggestion.user_id,
    status: TRACK_STATUS.SKIPPED,
    reason,
    metrics,
    persisted: false,
  });

  if (!suggestion.applied_at || !(suggestion.applied_at instanceof Date)) {
    return baseSkipped('invalid_applied_at');
  }
  if (Number.isNaN(suggestion.applied_at.getTime())) {
    return baseSkipped('invalid_applied_at');
  }
  if (suggestion.effect_tracked_at != null && !force) {
    return baseSkipped('already_tracked');
  }

  const start_date = normalizeDate(suggestion.applied_at);
  const end_date = computeWindowEndDate(suggestion.applied_at, window_days);
  if (!start_date || !end_date) {
    return baseSkipped('invalid_applied_at');
  }

  // 1) 用户 portfolios
  let portfolioIds: number[] = [];
  try {
    portfolioIds = await ds.listUserPortfolios({ user_id: suggestion.user_id });
  } catch (err) {
    logger.warn(
      `[effect-tracker] listUserPortfolios user=${suggestion.user_id} threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return {
      id: suggestion.id,
      user_id: suggestion.user_id,
      status: TRACK_STATUS.FAILED,
      reason: 'list_portfolios_threw',
      metrics: null,
      persisted: false,
    };
  }
  if (portfolioIds.length === 0) {
    return baseSkipped('no_portfolios');
  }

  // 2) attribution rows
  let rows: AttributionDailyRow[] = [];
  try {
    rows = await ds.loadAttributionReports({
      portfolio_ids: portfolioIds,
      start_date,
      end_date,
    });
  } catch (err) {
    logger.warn(
      `[effect-tracker] loadAttributionReports id=${suggestion.id} threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return {
      id: suggestion.id,
      user_id: suggestion.user_id,
      status: TRACK_STATUS.FAILED,
      reason: 'load_attribution_threw',
      metrics: null,
      persisted: false,
    };
  }

  const metrics = buildEffectMetrics({
    rows,
    start_date,
    end_date,
    window_days,
    source,
  });

  if (metrics.sample_days === 0) {
    // 仍可选写一条 (留痕"跑过但没数据"); 但 PRD AC "30 天 effect_metrics 落表"
    // 默认 skip 让 cron 下次重试 (e.g. attribution cron 当晚才跑完, tracker 等下一轮拿到).
    // 显式 force 时也跳过 (没数据无意义).
    return baseSkipped('no_attribution_data', metrics);
  }

  if (dry_run) {
    return {
      id: suggestion.id,
      user_id: suggestion.user_id,
      status: TRACK_STATUS.OK,
      reason: 'dry_run',
      metrics,
      persisted: false,
    };
  }

  // 3) write back
  let writeRes: { ok: boolean; reason?: string; error?: string };
  try {
    writeRes = await ds.writeBackMetrics({
      id: suggestion.id,
      effect_metrics: metrics,
      effect_tracked_at: now,
    });
  } catch (err) {
    logger.warn(
      `[effect-tracker] writeBackMetrics id=${suggestion.id} threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    writeRes = { ok: false, reason: 'writeback_threw' };
  }

  if (!writeRes.ok) {
    return {
      id: suggestion.id,
      user_id: suggestion.user_id,
      status: TRACK_STATUS.FAILED,
      reason: writeRes.reason || 'writeback_failed',
      metrics,
      persisted: false,
    };
  }
  return {
    id: suggestion.id,
    user_id: suggestion.user_id,
    status: TRACK_STATUS.OK,
    reason: null,
    metrics,
    persisted: true,
  };
}

/**
 * trackPendingSuggestions — 枚举所有待跟踪 suggestion 逐个 trackForSuggestion.
 * 永不 throw; fail-OPEN 双层 (listPending 失败返空 summary + 单条 throw 转 failed).
 *
 * cutoff = now - window_days 天 (即 applied_at <= cutoff 才"满 window 可跟踪").
 */
export async function trackPendingSuggestions(
  options: TrackPendingOptions
): Promise<TrackPendingSummary> {
  const ds = options.data_source;
  const window_days =
    typeof options.window_days === 'number' && options.window_days > 0
      ? Math.floor(options.window_days)
      : DEFAULT_EFFECT_WINDOW_DAYS;
  const source = options.source || EFFECT_METRICS_SOURCE.TRACKER_CRON;
  const dry_run = options.dry_run === true;
  const force = options.force === true;
  const now = options.now || new Date();
  const cutoff = new Date(now.getTime() - window_days * 24 * 3600 * 1000);
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 0;

  let pending: AppliedSuggestionRow[] = [];
  try {
    pending = await ds.listPendingApplied({
      cutoff,
      force,
      user_id: options.user_id ?? null,
      limit,
    });
  } catch (err) {
    logger.warn(
      `[effect-tracker] listPendingApplied threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return {
      total_candidates: 0,
      ok_count: 0,
      skipped_count: 0,
      failed_count: 0,
      persisted_count: 0,
      window_days,
      source,
      dry_run,
      per_suggestion: [],
      reason: 'list_threw',
    };
  }

  const summary: TrackPendingSummary = {
    total_candidates: pending.length,
    ok_count: 0,
    skipped_count: 0,
    failed_count: 0,
    persisted_count: 0,
    window_days,
    source,
    dry_run,
    per_suggestion: [],
  };

  for (const sug of pending) {
    let res: TrackSuggestionResult;
    try {
      res = await trackForSuggestion({
        data_source: ds,
        suggestion: sug,
        window_days,
        source,
        dry_run,
        force,
        now,
      });
    } catch (err) {
      // trackForSuggestion 已 fail-OPEN, 兜底防 fake throw
      logger.warn(
        `[effect-tracker] trackForSuggestion id=${sug.id} threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      res = {
        id: sug.id,
        user_id: sug.user_id,
        status: TRACK_STATUS.FAILED,
        reason: 'tracker_threw',
        metrics: null,
        persisted: false,
      };
    }
    if (res.status === TRACK_STATUS.OK) summary.ok_count += 1;
    else if (res.status === TRACK_STATUS.SKIPPED) summary.skipped_count += 1;
    else summary.failed_count += 1;
    if (res.persisted) summary.persisted_count += 1;
    summary.per_suggestion.push(res);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require model 让 DB-less 单测进程不被 sequelize 拽起 DB
// ---------------------------------------------------------------------------

export function createProductionImprovementEffectTrackerDataSource(): ImprovementEffectTrackerDataSource {
  return {
    async listPendingApplied({ cutoff, force, user_id, limit }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ImprovementSuggestion } = require('../../models/ImprovementSuggestion');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const where: Record<string, unknown> = {
          status: 'applied',
          applied_at: { [Op.lte]: cutoff },
        };
        if (!force) where.effect_tracked_at = null;
        if (user_id != null && Number.isFinite(user_id) && Number(user_id) > 0) {
          where.user_id = Number(user_id);
        }
        const opts: Record<string, unknown> = {
          where,
          attributes: [
            'id',
            'user_id',
            'period_end',
            'category',
            'key',
            'applied_at',
            'effect_tracked_at',
          ],
          order: [['applied_at', 'ASC']],
          raw: true,
        };
        if (limit && limit > 0) opts.limit = limit;
        const rows = await ImprovementSuggestion.findAll(opts);
        return (rows as Array<Record<string, unknown>>).map(r => ({
          id: Number(r.id),
          user_id: Number(r.user_id),
          period_end: String(r.period_end ?? ''),
          category: String(r.category ?? ''),
          key: String(r.key ?? ''),
          applied_at: r.applied_at instanceof Date ? r.applied_at : new Date(String(r.applied_at)),
          effect_tracked_at:
            r.effect_tracked_at == null
              ? null
              : r.effect_tracked_at instanceof Date
              ? r.effect_tracked_at
              : new Date(String(r.effect_tracked_at)),
        }));
      } catch (err) {
        logger.warn(
          `[effect-tracker] PRODUCTION listPendingApplied threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },

    async listUserPortfolios({ user_id }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingPortfolio } = require('../../models/PaperTradingPortfolio');
        const rows = await PaperTradingPortfolio.findAll({
          where: { user_id, is_active: true },
          attributes: ['id'],
          raw: true,
        });
        return (rows as Array<{ id: number }>)
          .map(r => Number(r.id))
          .filter(id => Number.isFinite(id) && id > 0);
      } catch (err) {
        logger.warn(
          `[effect-tracker] PRODUCTION listUserPortfolios user=${user_id} threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },

    async loadAttributionReports({ portfolio_ids, start_date, end_date }) {
      if (portfolio_ids.length === 0) return [];
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DailyAttributionReport } = require('../../models/DailyAttributionReport');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const rows = await DailyAttributionReport.findAll({
          where: {
            portfolio_id: { [Op.in]: portfolio_ids },
            status: 'ok',
            date: { [Op.between]: [start_date, end_date] },
          },
          order: [['date', 'ASC']],
          raw: true,
        });
        return (rows as Array<Record<string, unknown>>).map(r => ({
          portfolio_id: Number(r.portfolio_id) || 0,
          date: String(r.date ?? ''),
          total_pnl: typeof r.total_pnl === 'number' ? r.total_pnl : Number(r.total_pnl) || 0,
          total_pnl_pct:
            r.total_pnl_pct == null
              ? null
              : Number.isFinite(Number(r.total_pnl_pct))
              ? Number(r.total_pnl_pct)
              : null,
          trade_count: Number(r.trade_count) || 0,
        }));
      } catch (err) {
        logger.warn(
          `[effect-tracker] PRODUCTION loadAttributionReports threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },

    async writeBackMetrics({ id, effect_metrics, effect_tracked_at }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ImprovementSuggestion } = require('../../models/ImprovementSuggestion');
        const [count] = await ImprovementSuggestion.update(
          {
            effect_metrics,
            effect_tracked_at,
          },
          { where: { id } }
        );
        if (count === 0) {
          return { ok: false, reason: 'row_not_found' };
        }
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[effect-tracker] PRODUCTION writeBackMetrics id=${id} threw: ${msg}`);
        return { ok: false, reason: 'writeback_threw', error: msg };
      }
    },
  };
}

/** 默认 PRODUCTION DataSource singleton (调用方一般不直接用, 透过 trackPendingSuggestions). */
export const PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE: ImprovementEffectTrackerDataSource =
  createProductionImprovementEffectTrackerDataSource();
