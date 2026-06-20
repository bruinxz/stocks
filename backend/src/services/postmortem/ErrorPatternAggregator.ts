/**
 * ErrorPatternAggregator — L8-Postmortem / US-092 [PM-021] 90 天错误模式聚合
 *
 * 输入 (user_id, period_end) → 取近 lookback_days (默认 90) 天 DailyAttributionReport
 *   (bias_findings / 6 维 breakdown / best_worst_trades) → 聚合成
 *   patterns JSONB + summary_stats + heuristic ≤ 500 字 summary → upsert
 *   ErrorPatternReport. 永不 throw.
 *
 * PM-022 (US-093) WEEKLY_ERROR_PATTERN_AGGREGATE cron 周日 10:00 对所有 active
 * 用户调本 service 的 aggregateForUser. 本 story 只做 service + 单测; cron
 * 接入留给 US-093.
 *
 * ─── 设计 (与 [[AIDiaryService 5 件套]] 对齐) ─────────────────────────────────
 *
 * (1) 常量 / 类型 / 纯函数 helpers 全 export 便于单测
 * (2) ErrorPatternAggregatorDataSource interface 把所有 I/O 抽干净 — 单测注入
 *     fake 完全脱离 DB
 * (3) createProductionErrorPatternAggregatorDataSource() lazy-require model
 * (4) 主入口 aggregateForUser 三层 fail-OPEN — 任何异常 → status='failed' 留痕
 *     行, 永不向上抛
 *
 * ─── fail-OPEN 三层 ─────────────────────────────────────────────────────────
 *
 * - loadAttributionReports throw → status='failed' reason='load_threw' 仍尝试
 *   upsert 留痕 (空 patterns + summary='')
 * - 数据天数 < MIN_DATA_DAYS → status='skipped' reason='data_too_sparse', 仍
 *   upsert 留痕 (PRD AC "周日生成" 强语义 — 任何 cron 跑过都必须留行)
 * - upsert 失败 → 顶层 try/catch + logger.warn, 返 persisted=false 不抛
 *
 * ─── (user_id, period_end) idempotent ─────────────────────────────────────
 *
 * 与 ErrorPatternReport (user_id, period_end) UNIQUE 索引对齐 — 周日重跑
 * (cron 第二次跑 / 手动 replay) 覆盖最新结果. sequelize upsert 走 ON CONFLICT.
 *
 * ─── 与既有 model 的边界 ─────────────────────────────────────────────────
 *
 * - 输入: DailyAttributionReport (PM-003 落库) — 不重新算 6 维归因
 * - 输出: ErrorPatternReport (US-092 已上 model + migration)
 * - 后续 US-093 PM-022 cron 调本 service for each active user
 * - 后续 US-094 PM-023 ImprovementSuggestionService 读最近 1 行作 prompt 上下文
 */

import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** PRD US-092 AC: 默认 90 天聚合窗口. */
export const DEFAULT_LOOKBACK_DAYS = 90;

/** PRD US-092 AC: heuristic summary ≤ 500 字 (与 AIDiaryService AI_DIARY_MAX_CHARS 同款 cap). */
export const ERROR_PATTERN_SUMMARY_MAX_CHARS = 500;

/** 最少有效数据天数 — < 此 → status='skipped' reason='data_too_sparse'. */
export const MIN_DATA_DAYS = 5;

/** data_completeness 三档分级阈值 (与窗口天数比例): full ≥ 60 / partial ≥ 30 / sparse. */
export const DATA_COMPLETENESS_FULL_DAYS = 60;
export const DATA_COMPLETENESS_PARTIAL_DAYS = 30;

/** top_findings / worst_examples / sample_trades cap (UI 列表展示用). */
export const TOP_FINDINGS_MAX = 5;
export const WORST_EXAMPLES_MAX = 3;
export const SAMPLE_TRADES_MAX = 3;

/** trending 判定阈值 (近 1/3 窗口 vs 前 2/3 频次比 — 高于 = up / 低于 = down / 之间 = flat). */
export const TRENDING_UP_RATIO = 1.5;
export const TRENDING_DOWN_RATIO = 0.5;

/** ErrorPatternReport.source 枚举 (与 model.source 字段对齐). */
export const ERROR_PATTERN_SOURCE = Object.freeze({
  HEURISTIC: 'heuristic',
  LLM: 'llm',
  MANUAL: 'manual',
} as const);

export type ErrorPatternSource = (typeof ERROR_PATTERN_SOURCE)[keyof typeof ERROR_PATTERN_SOURCE];

/** ErrorPatternReport.status 枚举 (与 model.status 字段对齐, fail-OPEN 三态). */
export const ERROR_PATTERN_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const);

export type ErrorPatternStatus = (typeof ERROR_PATTERN_STATUS)[keyof typeof ERROR_PATTERN_STATUS];

/** data_completeness 枚举. */
export const DATA_COMPLETENESS = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  SPARSE: 'sparse',
} as const);

export type DataCompleteness = (typeof DATA_COMPLETENESS)[keyof typeof DATA_COMPLETENESS];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * AttributionDailyRecord — 从 DailyAttributionReport 抽取的最小聚合输入.
 * service 不依赖 sequelize 实例类型, PRODUCTION DataSource 将 row.toJSON() 映射成本类型.
 */
export interface AttributionDailyRecord {
  date: string;
  total_pnl: number;
  total_pnl_pct: number | null;
  trade_count: number;
  /** PM-008 BehaviorBiasDetector 落的 bias 数组 (本 story 视为黑盒, 仅按 bias_type 聚合). */
  bias_findings: Array<Record<string, unknown>>;
  /** 6 维 breakdown — industry/timing/sizing/selection/factor/execution_cost/residual. */
  breakdown: Record<string, unknown>;
  best_trades: Array<Record<string, unknown>>;
  worst_trades: Array<Record<string, unknown>>;
}

export interface BiasPattern {
  bias_type: string;
  total_count: number;
  avg_severity: number;
  weeks_active: number;
  trending: 'up' | 'down' | 'flat';
  sample_trades: string[];
}

export interface OutcomePattern {
  outcome_type: string;
  total_count: number;
  avg_loss_pct: number;
  total_loss: number;
  worst_examples: Array<{ symbol: string; date: string; loss: number }>;
}

export interface AttributionPattern {
  dimension: string;
  total_contrib: number;
  avg_per_day: number;
  worst_day: string;
  worst_day_contrib: number;
  /** 0..1 — 负贡献天数 / 总有效天数 (越高 = 该维度持续拖累). */
  sign_consistency: number;
}

export interface TopFinding {
  category: 'bias' | 'outcome' | 'attribution';
  key: string;
  score: number;
  detail: string;
}

export interface ErrorPatterns {
  bias_patterns: BiasPattern[];
  outcome_patterns: OutcomePattern[];
  attribution_patterns: AttributionPattern[];
  top_findings: TopFinding[];
}

export interface SummaryStats {
  total_bias_count: number;
  total_outcome_count: number;
  total_attribution_days: number;
  avg_pnl_pct: number;
  win_rate: number;
  data_completeness: DataCompleteness;
}

export interface ErrorPatternUpsertRow {
  user_id: number;
  period_start: string;
  period_end: string;
  lookback_days: number;
  patterns: Record<string, unknown>;
  summary_stats: Record<string, unknown>;
  summary: string;
  source: string;
  status: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  generated_at: Date;
}

export interface ErrorPatternAggregatorDataSource {
  /**
   * 取目标 user 在 [period_start, period_end] 窗口内所有 DailyAttributionReport
   * (status='ok'). 失败返 [], **永不 throw** (实现侧 try/catch 兜底).
   */
  loadAttributionReports(input: {
    user_id: number;
    period_start: string;
    period_end: string;
  }): Promise<AttributionDailyRecord[]>;
  /**
   * upsert 到 error_pattern_reports. (user_id, period_end) UNIQUE 走 ON CONFLICT.
   * 失败返 {ok:false, reason}, **永不 throw**.
   */
  upsertErrorPatternReport(
    row: ErrorPatternUpsertRow
  ): Promise<{ ok: boolean; reason?: string; error?: string }>;
}

export interface AggregateForUserResult {
  status: ErrorPatternStatus;
  patterns: ErrorPatterns;
  summary_stats: SummaryStats;
  summary: string;
  reason: string | null;
  /** 是否真的 upsert 落库成功 (failed 时仍可能 = false). */
  persisted: boolean;
}

// ---------------------------------------------------------------------------
// pure helpers — date math
// ---------------------------------------------------------------------------

/**
 * 计算 period_start = period_end - (lookbackDays - 1) (含 period_end 当天).
 * 输入 / 输出均为 'YYYY-MM-DD'. period_end 非法 → 返 period_end 兜底 (空窗口).
 */
export function computePeriodStart(periodEnd: string, lookbackDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodEnd);
  if (!m) return periodEnd;
  const safeLookback = lookbackDays > 0 ? lookbackDays : DEFAULT_LOOKBACK_DAYS;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - (safeLookback - 1));
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** data_completeness 三档分级 — 与 PRD AC 'full/partial/sparse' 对齐. */
export function classifyDataCompleteness(activeDays: number): DataCompleteness {
  if (activeDays >= DATA_COMPLETENESS_FULL_DAYS) return DATA_COMPLETENESS.FULL;
  if (activeDays >= DATA_COMPLETENESS_PARTIAL_DAYS) return DATA_COMPLETENESS.PARTIAL;
  return DATA_COMPLETENESS.SPARSE;
}

/** 把 unknown 转有效 finite number, 否则返 fallback (0). */
function safeFiniteNumber(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 把 unknown 转有效非空 string, 否则返 fallback. */
function safeString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  const s = String(v);
  return s.length > 0 ? s : fallback;
}

// ---------------------------------------------------------------------------
// pure helpers — bias / outcome / attribution 聚合
// ---------------------------------------------------------------------------

/**
 * 按 bias_type 聚合 90 天 bias_findings 数组 → BiasPattern[]
 *
 * 输入 records 内每行 bias_findings 形如:
 *   [{ bias_type: 'chase_high', severity: 0.7, related_trades: ['600519'] }, ...]
 *
 * trending 判定: 把窗口按时间分成"近 1/3" vs "前 2/3", 频次比例对照
 * TRENDING_UP_RATIO / TRENDING_DOWN_RATIO 落 up/down/flat.
 */
export function aggregateBiasPatterns(records: AttributionDailyRecord[]): BiasPattern[] {
  // 按日期升序后, "近 1/3" = 末尾 ceil(n/3) 天.
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const n = sorted.length;
  const recentStart = n - Math.ceil(n / 3); // 近 1/3 起点 index
  type Acc = {
    total_count: number;
    severity_sum: number;
    severity_n: number;
    weeks: Set<string>;
    sample_trades: string[];
    recent_count: number;
    earlier_count: number;
  };
  const acc = new Map<string, Acc>();
  sorted.forEach((rec, idx) => {
    const findings = Array.isArray(rec.bias_findings) ? rec.bias_findings : [];
    for (const f of findings) {
      const type = safeString(f.bias_type);
      if (!type) continue;
      let cell = acc.get(type);
      if (!cell) {
        cell = {
          total_count: 0,
          severity_sum: 0,
          severity_n: 0,
          weeks: new Set(),
          sample_trades: [],
          recent_count: 0,
          earlier_count: 0,
        };
        acc.set(type, cell);
      }
      cell.total_count += 1;
      const sev = safeFiniteNumber(f.severity, NaN);
      if (Number.isFinite(sev)) {
        cell.severity_sum += sev;
        cell.severity_n += 1;
      }
      cell.weeks.add(isoWeekKey(rec.date));
      const trades = Array.isArray(f.related_trades) ? f.related_trades : [];
      for (const t of trades) {
        const sym = safeString(t);
        if (
          sym &&
          cell.sample_trades.length < SAMPLE_TRADES_MAX &&
          !cell.sample_trades.includes(sym)
        ) {
          cell.sample_trades.push(sym);
        }
      }
      if (idx >= recentStart) cell.recent_count += 1;
      else cell.earlier_count += 1;
    }
  });
  const out: BiasPattern[] = [];
  acc.forEach((cell, bias_type) => {
    const avg_severity = cell.severity_n > 0 ? cell.severity_sum / cell.severity_n : 0;
    out.push({
      bias_type,
      total_count: cell.total_count,
      avg_severity,
      weeks_active: cell.weeks.size,
      trending: classifyTrending(cell.recent_count, cell.earlier_count, n),
      sample_trades: cell.sample_trades,
    });
  });
  // 频次降序; 同频次按 bias_type 字母序兜底稳定
  out.sort((a, b) => b.total_count - a.total_count || (a.bias_type < b.bias_type ? -1 : 1));
  return out;
}

/** 把 'YYYY-MM-DD' 转 ISO week key 'YYYY-Www' (用于 weeks_active 计数). */
export function isoWeekKey(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const day = d.getUTCDay() || 7; // 周一 = 1, 周日 = 7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** 近 1/3 频次 vs 前 2/3 频次 (按"每段平均每天频次") 决定 up/down/flat. */
export function classifyTrending(
  recentCount: number,
  earlierCount: number,
  totalDays: number
): 'up' | 'down' | 'flat' {
  if (totalDays <= 0) return 'flat';
  const recentDays = Math.ceil(totalDays / 3);
  const earlierDays = totalDays - recentDays;
  if (recentDays <= 0 || earlierDays <= 0) return 'flat';
  const recentRate = recentCount / recentDays;
  const earlierRate = earlierCount / earlierDays;
  if (earlierRate === 0) {
    // earlierRate=0 → 仅 recent 有命中 → up; 全 0 → flat
    return recentRate > 0 ? 'up' : 'flat';
  }
  const ratio = recentRate / earlierRate;
  if (ratio >= TRENDING_UP_RATIO) return 'up';
  if (ratio <= TRENDING_DOWN_RATIO) return 'down';
  return 'flat';
}

/**
 * 按 outcome 维度聚合 worst_trades — 一个 worst_trade 一条 outcome 命中.
 *
 * outcome_type 当前简化为 "loss_trade" 单维 (PM-008 未来扩 chase_high /
 * stop_loss_too_late 等枚举; 当前以 worst_trades 命中数 + 平均亏损率作主指标).
 * 输出 OutcomePattern[] 按 total_loss 降序, 最坏案例 ≤ WORST_EXAMPLES_MAX.
 */
export function aggregateOutcomePatterns(records: AttributionDailyRecord[]): OutcomePattern[] {
  type Acc = {
    count: number;
    loss_pct_sum: number;
    loss_pct_n: number;
    loss_sum: number;
    worst: Array<{ symbol: string; date: string; loss: number }>;
  };
  const acc = new Map<string, Acc>();
  for (const rec of records) {
    const worst = Array.isArray(rec.worst_trades) ? rec.worst_trades : [];
    for (const t of worst) {
      // 把 worst_trade 当作一条 "亏损交易" outcome (简化); 未来 PM-008 可
      // 在每行 t 上挂 outcome_type 字段供细分.
      const type = safeString(t.outcome_type, 'loss_trade');
      let cell = acc.get(type);
      if (!cell) {
        cell = {
          count: 0,
          loss_pct_sum: 0,
          loss_pct_n: 0,
          loss_sum: 0,
          worst: [],
        };
        acc.set(type, cell);
      }
      cell.count += 1;
      const pnl = safeFiniteNumber(t.pnl, 0);
      // worst_trades 的 pnl 是负值; total_loss = sum of negatives.
      cell.loss_sum += pnl;
      const pct = safeFiniteNumber(t.pnl_pct, NaN);
      if (Number.isFinite(pct)) {
        cell.loss_pct_sum += pct;
        cell.loss_pct_n += 1;
      }
      const symbol = safeString(t.symbol);
      if (symbol) {
        cell.worst.push({ symbol, date: rec.date, loss: pnl });
      }
    }
  }
  const out: OutcomePattern[] = [];
  acc.forEach((cell, outcome_type) => {
    cell.worst.sort((a, b) => a.loss - b.loss); // 最负的最前
    out.push({
      outcome_type,
      total_count: cell.count,
      avg_loss_pct: cell.loss_pct_n > 0 ? cell.loss_pct_sum / cell.loss_pct_n : 0,
      total_loss: cell.loss_sum,
      worst_examples: cell.worst.slice(0, WORST_EXAMPLES_MAX),
    });
  });
  out.sort((a, b) => a.total_loss - b.total_loss); // 最负的最前
  return out;
}

/** 6 维 attribution breakdown 累计 — 输出 AttributionPattern[] 按 |total_contrib| 降序. */
export function aggregateAttributionPatterns(
  records: AttributionDailyRecord[]
): AttributionPattern[] {
  const DIMENSIONS = [
    'industry',
    'timing',
    'sizing',
    'selection',
    'factor',
    'execution_cost',
    'residual',
  ];
  type Acc = {
    total: number;
    n: number;
    worst_day: string;
    worst_day_contrib: number;
    negative_days: number;
  };
  const acc = new Map<string, Acc>();
  for (const dim of DIMENSIONS) {
    acc.set(dim, {
      total: 0,
      n: 0,
      worst_day: '',
      worst_day_contrib: 0,
      negative_days: 0,
    });
  }
  for (const rec of records) {
    const b = rec.breakdown || {};
    for (const dim of DIMENSIONS) {
      const v = extractDimensionContrib(b, dim);
      const cell = acc.get(dim)!;
      cell.total += v;
      cell.n += 1;
      // 最坏当天 = 该维度最负贡献当天
      if (v < cell.worst_day_contrib || cell.worst_day === '') {
        cell.worst_day_contrib = v;
        cell.worst_day = rec.date;
      }
      if (v < 0) cell.negative_days += 1;
    }
  }
  const out: AttributionPattern[] = [];
  acc.forEach((cell, dimension) => {
    out.push({
      dimension,
      total_contrib: cell.total,
      avg_per_day: cell.n > 0 ? cell.total / cell.n : 0,
      worst_day: cell.worst_day,
      worst_day_contrib: cell.worst_day_contrib,
      sign_consistency: cell.n > 0 ? cell.negative_days / cell.n : 0,
    });
  });
  out.sort((a, b) => Math.abs(b.total_contrib) - Math.abs(a.total_contrib));
  return out;
}

/**
 * 从 breakdown JSONB 抽某维度数字贡献.
 * - industry: 取 sum(industry_contrib[].pnl)
 * - factor: 取 factor_contrib_total 兜底 sum(factor_contrib[].pnl)
 * - 其余 timing/sizing/selection/execution_cost/residual: 取同名 *_contrib / 同名字段
 */
export function extractDimensionContrib(
  breakdown: Record<string, unknown>,
  dimension: string
): number {
  if (dimension === 'industry') {
    const arr = (breakdown as { industry_contrib?: unknown }).industry_contrib;
    if (Array.isArray(arr)) {
      return arr.reduce<number>((s, r) => s + safeFiniteNumber((r as { pnl?: unknown }).pnl, 0), 0);
    }
    return 0;
  }
  if (dimension === 'factor') {
    const total = (breakdown as { factor_contrib_total?: unknown }).factor_contrib_total;
    if (total != null) return safeFiniteNumber(total, 0);
    const arr = (breakdown as { factor_contrib?: unknown }).factor_contrib;
    if (Array.isArray(arr)) {
      return arr.reduce<number>((s, r) => s + safeFiniteNumber((r as { pnl?: unknown }).pnl, 0), 0);
    }
    return 0;
  }
  // 其余维度优先 *_contrib (PM-002 命名), 兜底 dimension 同名字段
  const key1 = `${dimension}_contrib`;
  if (key1 in breakdown) return safeFiniteNumber((breakdown as Record<string, unknown>)[key1], 0);
  if (dimension in breakdown) {
    return safeFiniteNumber((breakdown as Record<string, unknown>)[dimension], 0);
  }
  return 0;
}

/**
 * 综合 top_findings — 从 bias / outcome / attribution 三类各取最严重 N 条,
 * 总数 ≤ TOP_FINDINGS_MAX. score 用统一规则: bias=total_count*avg_severity,
 * outcome=|total_loss|, attribution=|total_contrib|.
 */
export function buildTopFindings(
  bias: BiasPattern[],
  outcome: OutcomePattern[],
  attribution: AttributionPattern[]
): TopFinding[] {
  const candidates: TopFinding[] = [];
  for (const b of bias) {
    candidates.push({
      category: 'bias',
      key: b.bias_type,
      score: b.total_count * Math.max(b.avg_severity, 0.1),
      detail: `${b.bias_type} 90 天命中 ${b.total_count} 次, 平均严重度 ${b.avg_severity.toFixed(
        2
      )}, 趋势 ${b.trending}`,
    });
  }
  for (const o of outcome) {
    candidates.push({
      category: 'outcome',
      key: o.outcome_type,
      score: Math.abs(o.total_loss),
      detail: `${o.outcome_type} 命中 ${o.total_count} 笔, 累计亏损 ${o.total_loss.toFixed(2)} 元`,
    });
  }
  for (const a of attribution) {
    if (a.total_contrib >= 0) continue; // 仅关心负贡献维度
    candidates.push({
      category: 'attribution',
      key: a.dimension,
      score: Math.abs(a.total_contrib),
      detail: `${a.dimension} 累计贡献 ${a.total_contrib.toFixed(2)} 元, 负贡献天数占比 ${(
        a.sign_consistency * 100
      ).toFixed(0)}%`,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, TOP_FINDINGS_MAX);
}

/** summary_stats — 喂 LLM / 飞书 push / UI 用. */
export function buildSummaryStats(
  records: AttributionDailyRecord[],
  bias: BiasPattern[],
  outcome: OutcomePattern[]
): SummaryStats {
  const total_attribution_days = records.length;
  const pctValues = records
    .map(r => r.total_pnl_pct)
    .filter((p): p is number => p != null && Number.isFinite(p));
  const avg_pnl_pct =
    pctValues.length > 0 ? pctValues.reduce((s, v) => s + v, 0) / pctValues.length : 0;
  const winDays = records.filter(r => safeFiniteNumber(r.total_pnl, 0) > 0).length;
  const win_rate = total_attribution_days > 0 ? winDays / total_attribution_days : 0;
  const total_bias_count = bias.reduce((s, b) => s + b.total_count, 0);
  const total_outcome_count = outcome.reduce((s, o) => s + o.total_count, 0);
  return {
    total_bias_count,
    total_outcome_count,
    total_attribution_days,
    avg_pnl_pct,
    win_rate,
    data_completeness: classifyDataCompleteness(total_attribution_days),
  };
}

/**
 * heuristic summary — 永远 ≤ ERROR_PATTERN_SUMMARY_MAX_CHARS 字, 描述最显著的
 * bias / outcome / attribution. records 为空时返简短"无足够数据"占位.
 */
export function buildHeuristicSummary(
  patterns: ErrorPatterns,
  stats: SummaryStats,
  periodStart: string,
  periodEnd: string
): string {
  if (stats.total_attribution_days === 0) {
    return `${periodStart}~${periodEnd} 90 天窗口内无有效归因数据, 暂无错误模式可聚合.`;
  }
  const parts: string[] = [];
  parts.push(
    `${periodStart}~${periodEnd} 共 ${stats.total_attribution_days} 个交易日 (覆盖度 ${
      stats.data_completeness
    }), 日胜率 ${(stats.win_rate * 100).toFixed(1)}%, 平均日盈亏 ${stats.avg_pnl_pct.toFixed(2)}%.`
  );
  if (patterns.bias_patterns.length > 0) {
    const top = patterns.bias_patterns[0];
    parts.push(
      `最频偏差: ${top.bias_type} (${top.total_count} 次, 趋势 ${
        top.trending
      }, 平均严重度 ${top.avg_severity.toFixed(2)}).`
    );
  } else {
    parts.push('未命中行为偏差.');
  }
  if (patterns.outcome_patterns.length > 0) {
    const worst = patterns.outcome_patterns[0];
    parts.push(
      `主要亏损模式: ${worst.outcome_type} (${
        worst.total_count
      } 笔, 累计 ${worst.total_loss.toFixed(2)} 元).`
    );
  }
  const negAttrs = patterns.attribution_patterns.filter(a => a.total_contrib < 0);
  if (negAttrs.length > 0) {
    const worst = negAttrs[0];
    parts.push(
      `主要失分维度: ${worst.dimension} 累计 ${worst.total_contrib.toFixed(2)} 元 (负贡献天数 ${(
        worst.sign_consistency * 100
      ).toFixed(0)}%).`
    );
  }
  if (patterns.top_findings.length > 0) {
    parts.push(`重点建议: 复盘 top finding "${patterns.top_findings[0].detail}".`);
  }
  let out = parts.join(' ');
  const chars = Array.from(out);
  if (chars.length > ERROR_PATTERN_SUMMARY_MAX_CHARS) {
    out = chars.slice(0, ERROR_PATTERN_SUMMARY_MAX_CHARS - 1).join('') + '…';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * aggregateForUser — PM-021 主入口.
 *
 * 流程:
 *   (1) computePeriodStart 算 period_start = period_end - lookback_days + 1
 *   (2) ds.loadAttributionReports → 失败兜底 failed 留痕
 *   (3) records.length < MIN_DATA_DAYS → skipped 留痕
 *   (4) aggregateBias / aggregateOutcome / aggregateAttribution → buildTopFindings
 *   (5) buildSummaryStats / buildHeuristicSummary
 *   (6) upsert → 失败 logger.warn 不抛, 返 persisted=false
 *
 * 永不 throw. PRD AC "周日生成" 强语义: 任何 cron 跑过都尝试留痕 (status='ok' /
 * 'skipped' / 'failed' 三态都 upsert), 不阻塞下一周期 / 下一用户.
 */
export async function aggregateForUser(
  userId: number,
  options: {
    period_end: string;
    data_source: ErrorPatternAggregatorDataSource;
    /** 默认 DEFAULT_LOOKBACK_DAYS=90; ops 可调. */
    lookback_days?: number;
    /** 'cron' / 'manual' / 'replay' 等; 落 metadata.cron_run_id 用. */
    cron_run_id?: string | null;
  }
): Promise<AggregateForUserResult> {
  const {
    period_end,
    data_source: ds,
    lookback_days = DEFAULT_LOOKBACK_DAYS,
    cron_run_id,
  } = options;
  const effectiveLookback = lookback_days > 0 ? lookback_days : DEFAULT_LOOKBACK_DAYS;
  const period_start = computePeriodStart(period_end, effectiveLookback);
  const baseMetadata: Record<string, unknown> = {};
  if (cron_run_id != null) baseMetadata.cron_run_id = cron_run_id;
  baseMetadata.lookback_days = effectiveLookback;
  baseMetadata.data_sources_used = ['daily_attribution_report'];

  // (2) 取 attribution
  let records: AttributionDailyRecord[] = [];
  let loadThrew = false;
  let loadErrMsg = '';
  try {
    records = await ds.loadAttributionReports({
      user_id: userId,
      period_start,
      period_end,
    });
    if (!Array.isArray(records)) records = [];
  } catch (err) {
    loadThrew = true;
    loadErrMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[error-pattern] loadAttributionReports user=${userId} period_end=${period_end} threw: ${loadErrMsg}`
    );
  }

  if (loadThrew) {
    const emptyPatterns: ErrorPatterns = {
      bias_patterns: [],
      outcome_patterns: [],
      attribution_patterns: [],
      top_findings: [],
    };
    const stats = buildSummaryStats([], [], []);
    const upsertRes = await safeUpsert(ds, {
      user_id: userId,
      period_start,
      period_end,
      lookback_days: effectiveLookback,
      patterns: emptyPatterns as unknown as Record<string, unknown>,
      summary_stats: stats as unknown as Record<string, unknown>,
      summary: '',
      source: ERROR_PATTERN_SOURCE.HEURISTIC,
      status: ERROR_PATTERN_STATUS.FAILED,
      reason: 'load_threw',
      metadata: { ...baseMetadata, error: loadErrMsg },
      generated_at: new Date(),
    });
    return {
      status: ERROR_PATTERN_STATUS.FAILED,
      patterns: emptyPatterns,
      summary_stats: stats,
      summary: '',
      reason: 'load_threw',
      persisted: upsertRes.ok,
    };
  }

  baseMetadata.attribution_days_loaded = records.length;

  // (3) sparse 数据 → skipped 留痕
  if (records.length < MIN_DATA_DAYS) {
    const emptyPatterns: ErrorPatterns = {
      bias_patterns: [],
      outcome_patterns: [],
      attribution_patterns: [],
      top_findings: [],
    };
    const stats = buildSummaryStats(records, [], []);
    const upsertRes = await safeUpsert(ds, {
      user_id: userId,
      period_start,
      period_end,
      lookback_days: effectiveLookback,
      patterns: emptyPatterns as unknown as Record<string, unknown>,
      summary_stats: stats as unknown as Record<string, unknown>,
      summary: '',
      source: ERROR_PATTERN_SOURCE.HEURISTIC,
      status: ERROR_PATTERN_STATUS.SKIPPED,
      reason: 'data_too_sparse',
      metadata: { ...baseMetadata, skipped_reason: 'data_too_sparse' },
      generated_at: new Date(),
    });
    return {
      status: ERROR_PATTERN_STATUS.SKIPPED,
      patterns: emptyPatterns,
      summary_stats: stats,
      summary: '',
      reason: 'data_too_sparse',
      persisted: upsertRes.ok,
    };
  }

  // (4/5) 真聚合
  const bias_patterns = aggregateBiasPatterns(records);
  const outcome_patterns = aggregateOutcomePatterns(records);
  const attribution_patterns = aggregateAttributionPatterns(records);
  const top_findings = buildTopFindings(bias_patterns, outcome_patterns, attribution_patterns);
  const patterns: ErrorPatterns = {
    bias_patterns,
    outcome_patterns,
    attribution_patterns,
    top_findings,
  };
  const summary_stats = buildSummaryStats(records, bias_patterns, outcome_patterns);
  const summary = buildHeuristicSummary(patterns, summary_stats, period_start, period_end);

  baseMetadata.bias_findings_loaded = summary_stats.total_bias_count;

  // (6) upsert
  const upsertRes = await safeUpsert(ds, {
    user_id: userId,
    period_start,
    period_end,
    lookback_days: effectiveLookback,
    patterns: patterns as unknown as Record<string, unknown>,
    summary_stats: summary_stats as unknown as Record<string, unknown>,
    summary,
    source: ERROR_PATTERN_SOURCE.HEURISTIC,
    status: ERROR_PATTERN_STATUS.OK,
    reason: null,
    metadata: baseMetadata,
    generated_at: new Date(),
  });

  if (!upsertRes.ok) {
    return {
      status: ERROR_PATTERN_STATUS.FAILED,
      patterns,
      summary_stats,
      summary,
      reason: upsertRes.reason || 'upsert_failed',
      persisted: false,
    };
  }
  return {
    status: ERROR_PATTERN_STATUS.OK,
    patterns,
    summary_stats,
    summary,
    reason: null,
    persisted: true,
  };
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require model 让 DB-less 单测进程 require 本
// service 不被 sequelize 拽起 DB. 与 [[AIDiaryService]] /
// [[DailyAttributionCronRunner]] 同款.
// ---------------------------------------------------------------------------

/**
 * 生产 DataSource 工厂. lazy require DailyAttributionReport + ErrorPatternReport
 * 让单测进程 (无 PG) 不被 require chain 拽起 sequelize 实例.
 *
 * loadAttributionReports — 按 user_id + date BETWEEN period_start AND period_end
 *   + status='ok' 查 DailyAttributionReport, 映射成 AttributionDailyRecord[].
 *   任何 throw 内部 try/catch 兜底返 [].
 *
 * upsertErrorPatternReport — 走 ErrorPatternReport.upsert 利用
 *   (user_id, period_end) UNIQUE 索引的 ON CONFLICT. 任何 throw 内部 try/catch
 *   兜底返 {ok:false, reason:'upsert_threw', error: msg}.
 */
export function createProductionErrorPatternAggregatorDataSource(): ErrorPatternAggregatorDataSource {
  return {
    async loadAttributionReports({ user_id, period_start, period_end }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DailyAttributionReport } = require('../../models/DailyAttributionReport');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const rows = await DailyAttributionReport.findAll({
          where: {
            user_id,
            status: 'ok',
            date: { [Op.between]: [period_start, period_end] },
          },
          order: [['date', 'ASC']],
        });
        return rows.map((r: { toJSON?: () => Record<string, unknown> }) => {
          const j = typeof r.toJSON === 'function' ? r.toJSON() : (r as Record<string, unknown>);
          return {
            date: String(j.date ?? ''),
            total_pnl: typeof j.total_pnl === 'number' ? j.total_pnl : Number(j.total_pnl) || 0,
            total_pnl_pct:
              j.total_pnl_pct == null
                ? null
                : Number.isFinite(Number(j.total_pnl_pct))
                ? Number(j.total_pnl_pct)
                : null,
            trade_count: Number(j.trade_count) || 0,
            bias_findings: Array.isArray(j.bias_findings)
              ? (j.bias_findings as Array<Record<string, unknown>>)
              : [],
            breakdown:
              j.breakdown && typeof j.breakdown === 'object'
                ? (j.breakdown as Record<string, unknown>)
                : {},
            best_trades: Array.isArray(j.best_trades)
              ? (j.best_trades as Array<Record<string, unknown>>)
              : [],
            worst_trades: Array.isArray(j.worst_trades)
              ? (j.worst_trades as Array<Record<string, unknown>>)
              : [],
          };
        });
      } catch (err) {
        logger.warn(
          `[error-pattern] PRODUCTION loadAttributionReports user=${user_id} period=${period_start}~${period_end} threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async upsertErrorPatternReport(row) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ErrorPatternReport } = require('../../models/ErrorPatternReport');
        await ErrorPatternReport.upsert(row);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[error-pattern] PRODUCTION upsertErrorPatternReport user=${row.user_id} period_end=${row.period_end} threw: ${msg}`
        );
        return { ok: false, reason: 'upsert_threw', error: msg };
      }
    },
  };
}

/** upsert 包一层 try/catch — DataSource 实现侧本身已 try/catch 不抛, 再兜一层. */
async function safeUpsert(
  ds: ErrorPatternAggregatorDataSource,
  row: ErrorPatternUpsertRow
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await ds.upsertErrorPatternReport(row);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason || 'upsert_returned_false' };
  } catch (err) {
    logger.warn(
      `[error-pattern] upsertErrorPatternReport user=${row.user_id} period_end=${
        row.period_end
      } threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, reason: 'upsert_threw' };
  }
}
