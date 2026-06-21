/**
 * ImprovementSuggestionService — L8-Postmortem / US-094 [PM-023]
 *
 * 输入 (user_id, period_end?) → 读最近 1 行 ErrorPatternReport (status=ok) →
 * 把 patterns (bias / outcome / attribution / top_findings) 各自展开成
 * actionable ImprovementSuggestion 行 → bulkUpsert. 永不 throw.
 *
 * PM-024 (US-188) apply route: POST /api/me/improvement-suggestions/:id/apply
 * 后续 story 接入 — 仅消费本表数据.
 *
 * ─── 设计 (与 [[ErrorPatternAggregator]] / [[AIDiaryService]] 5 件套对齐) ─────────
 *
 * (1) 常量 / 类型 / 纯函数 helpers 全 export 便于单测
 * (2) ImprovementSuggestionDataSource interface 把所有 I/O (取 ErrorPatternReport /
 *     bulkUpsert) 抽干净 — 单测注入 fake 完全脱离 DB
 * (3) createProductionImprovementSuggestionDataSource() lazy-require model
 * (4) 主入口 generateForUser 三层 fail-OPEN — load throw / no report / upsert
 *     失败均不向上抛
 *
 * ─── fail-OPEN 三层 ────────────────────────────────────────────────────────
 *
 * - loadLatestErrorPatternReport throw → status='failed' reason='load_threw',
 *   不 upsert (无 patterns 无证据)
 * - report 不存在 / patterns 全空 → status='skipped' reason='no_error_pattern' /
 *   'patterns_empty', 不 upsert (没东西可建议)
 * - bulkUpsert 失败 → 顶层 try/catch + logger.warn, 返 persisted_count=0 不抛
 *
 * ─── (user_id, period_end, category, key) idempotent ─────────────────────
 *
 * 与 ImprovementSuggestion (user_id, period_end, category, key) UNIQUE 索引
 * 对齐 — 周一重跑覆盖最新 (sequelize bulkUpsert ON CONFLICT DO UPDATE).
 *
 * ─── 三层校验 (与 AI_VIEW_MAX_CHARS / [[AIDiaryService]] 同款) ──────────────────
 *
 * (1) 上游 — buildBiasSuggestion / buildOutcomeSuggestion / buildAttributionSuggestion
 *     / buildTopSuggestion 各自 heuristic 模板 (本 story 无 LLM)
 * (2) 中游 — enforceTitleConstraints / enforceBodyConstraints 双 cap (60 / 500 字)
 * (3) 下游 — heuristic 永远不抛 (固定模板, 缺数据降级 generic 句)
 */

import { logger } from '../../utils/logger';
import type {
  AttributionPattern,
  BiasPattern,
  ErrorPatterns,
  OutcomePattern,
  TopFinding,
} from './ErrorPatternAggregator';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** title cap (与 ImprovementSuggestion.title VARCHAR(200) 对齐, 业务侧 ≤ 60 字保 UI 单行). */
export const IMPROVEMENT_TITLE_MAX_CHARS = 60;

/** body cap (与 ImprovementSuggestion.body TEXT 对齐, 业务侧 ≤ 500 字与 AI summary 一致). */
export const IMPROVEMENT_BODY_MAX_CHARS = 500;

/** category 枚举 (与 ImprovementSuggestion.category 字段对齐). */
export const IMPROVEMENT_CATEGORY = Object.freeze({
  BIAS: 'bias',
  OUTCOME: 'outcome',
  ATTRIBUTION: 'attribution',
  TOP: 'top',
} as const);

export type ImprovementCategory = (typeof IMPROVEMENT_CATEGORY)[keyof typeof IMPROVEMENT_CATEGORY];

/** status 枚举 (与 ImprovementSuggestion.status 字段对齐). */
export const IMPROVEMENT_STATUS = Object.freeze({
  OPEN: 'open',
  APPLIED: 'applied',
  DISMISSED: 'dismissed',
  EXPIRED: 'expired',
} as const);

export type ImprovementStatus = (typeof IMPROVEMENT_STATUS)[keyof typeof IMPROVEMENT_STATUS];

/** source 枚举 (与 model.source 字段对齐, 本 story 仅 heuristic). */
export const IMPROVEMENT_SOURCE = Object.freeze({
  HEURISTIC: 'heuristic',
  LLM: 'llm',
  MANUAL: 'manual',
} as const);

export type ImprovementSource = (typeof IMPROVEMENT_SOURCE)[keyof typeof IMPROVEMENT_SOURCE];

/** action.type 枚举 (apply route 透传给目标 module; 本 story 默认 noop). */
export const IMPROVEMENT_ACTION_TYPE = Object.freeze({
  NOOP: 'noop',
  TUNE_RISK_PARAM: 'tune_risk_param',
  ENABLE_KILL_SWITCH: 'enable_kill_switch',
  OPEN_WORKSPACE_TAB: 'open_workspace_tab',
} as const);

export type ImprovementActionType =
  (typeof IMPROVEMENT_ACTION_TYPE)[keyof typeof IMPROVEMENT_ACTION_TYPE];

/** generateForUser status (与 ErrorPatternAggregator 范式一致). */
export const IMPROVEMENT_GENERATE_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const);

export type ImprovementGenerateStatus =
  (typeof IMPROVEMENT_GENERATE_STATUS)[keyof typeof IMPROVEMENT_GENERATE_STATUS];

/** top_findings 第一条的 priority 锚点; 其余按 score 比例归一化. */
export const IMPROVEMENT_PRIORITY_TOP = 100;

/** sample_items / metric 上限 (与前端 UI 列表展示 cap 对齐). */
export const SAMPLE_ITEMS_MAX = 3;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 最小 ErrorPatternReport 投影 — service 不依赖 sequelize 实例类型, PRODUCTION
 * DataSource 在 loadLatestErrorPatternReport 内做 row.toJSON() 映射成本类型.
 */
export interface ErrorPatternSnapshot {
  id: number;
  user_id: number;
  period_start: string;
  period_end: string;
  lookback_days: number;
  patterns: ErrorPatterns;
  summary: string;
  status: string;
  generated_at: Date | string;
}

export interface ImprovementSuggestionUpsertRow {
  user_id: number;
  period_start: string;
  period_end: string;
  category: string;
  key: string;
  title: string;
  body: string;
  priority: number;
  evidence: Record<string, unknown>;
  action: Record<string, unknown>;
  source: string;
  status: string;
  metadata: Record<string, unknown>;
  generated_at: Date;
}

export interface ImprovementSuggestionDataSource {
  /**
   * 取目标 user 最近 1 行 ErrorPatternReport (status='ok' 优先, 若 period_end
   * 指定则按 period_end 等值查). 没有返 null, **永不 throw**.
   */
  loadLatestErrorPatternReport(input: {
    user_id: number;
    period_end?: string | null;
  }): Promise<ErrorPatternSnapshot | null>;
  /**
   * bulkUpsert 到 improvement_suggestions. (user_id, period_end, category, key)
   * UNIQUE 走 ON CONFLICT DO UPDATE. 失败返 {ok:false, reason}, **永不 throw**.
   * persisted_count = 成功 upsert 的行数 (失败时为 0).
   */
  bulkUpsertSuggestions(
    rows: ImprovementSuggestionUpsertRow[]
  ): Promise<{ ok: boolean; persisted_count: number; reason?: string; error?: string }>;
}

export interface GenerateImprovementResult {
  status: ImprovementGenerateStatus;
  /** 生成的建议行 (落库前形态; 失败时 = []) */
  rows: ImprovementSuggestionUpsertRow[];
  /** 成功 upsert 的行数 (failed 时 = 0) */
  persisted_count: number;
  /** skipped / failed 时的原因; ok 时 null */
  reason: string | null;
  /** 关联的 ErrorPatternReport.id (skipped/failed 时可能为 null) */
  error_pattern_report_id: number | null;
}

// ---------------------------------------------------------------------------
// pure helpers — text constraints
// ---------------------------------------------------------------------------

/** 截断 title 到 IMPROVEMENT_TITLE_MAX_CHARS, Array.from 算字符 + '…' 收尾. */
export function enforceTitleConstraints(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  if (chars.length <= IMPROVEMENT_TITLE_MAX_CHARS) return cleaned;
  return chars.slice(0, IMPROVEMENT_TITLE_MAX_CHARS - 1).join('') + '…';
}

/** 截断 body 到 IMPROVEMENT_BODY_MAX_CHARS, 多重空白合并. */
export function enforceBodyConstraints(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  if (chars.length <= IMPROVEMENT_BODY_MAX_CHARS) return cleaned;
  return chars.slice(0, IMPROVEMENT_BODY_MAX_CHARS - 1).join('') + '…';
}

/** trending 描述 (中文短词). */
export function describeTrending(trending: 'up' | 'down' | 'flat'): string {
  if (trending === 'up') return '上升';
  if (trending === 'down') return '下降';
  return '稳定';
}

/** 把 patterns 排序 index → priority 0..IMPROVEMENT_PRIORITY_TOP. */
export function computePriority(rank: number, total: number, anchor: number): number {
  if (total <= 0) return 0;
  // rank 0 = 最高 priority = anchor; 其余线性递减到 1
  const step = total > 1 ? (anchor - 1) / (total - 1) : 0;
  const p = Math.round(anchor - step * rank);
  if (p < 0) return 0;
  if (p > IMPROVEMENT_PRIORITY_TOP) return IMPROVEMENT_PRIORITY_TOP;
  return p;
}

// ---------------------------------------------------------------------------
// pure helpers — builders (bias / outcome / attribution / top)
// ---------------------------------------------------------------------------

/**
 * 把单个 BiasPattern → ImprovementSuggestionUpsertRow.
 * category='bias', key=bias_type, action.type='open_workspace_tab' → 复盘面板.
 */
export function buildBiasSuggestion(
  bias: BiasPattern,
  rank: number,
  total: number,
  ctx: {
    user_id: number;
    period_start: string;
    period_end: string;
    error_pattern_report_id: number;
    generated_at: Date;
    metadata: Record<string, unknown>;
  }
): ImprovementSuggestionUpsertRow {
  const title = enforceTitleConstraints(
    `近 90 天 ${bias.bias_type} 偏差命中 ${bias.total_count} 次, 趋势 ${describeTrending(
      bias.trending
    )}`
  );
  const samples = bias.sample_trades.slice(0, SAMPLE_ITEMS_MAX).join('/');
  const body = enforceBodyConstraints(
    [
      `${bias.bias_type} 90 天内出现 ${bias.total_count} 次, 平均严重度 ${bias.avg_severity.toFixed(
        2
      )}, 活跃周数 ${bias.weeks_active}, 趋势 ${describeTrending(bias.trending)}.`,
      samples ? `典型涉及标的: ${samples}.` : '',
      `建议: ① 入场前强制核查触发条件; ② 复盘 sample 案例; ③ 接入风控参数中心的相应阈值收紧.`,
    ]
      .filter(Boolean)
      .join(' ')
  );
  return {
    user_id: ctx.user_id,
    period_start: ctx.period_start,
    period_end: ctx.period_end,
    category: IMPROVEMENT_CATEGORY.BIAS,
    key: bias.bias_type,
    title,
    body,
    priority: computePriority(rank, total, IMPROVEMENT_PRIORITY_TOP - 5),
    evidence: {
      error_pattern_report_id: ctx.error_pattern_report_id,
      period_start: ctx.period_start,
      period_end: ctx.period_end,
      sample_items: bias.sample_trades.slice(0, SAMPLE_ITEMS_MAX),
      metric: {
        total_count: bias.total_count,
        avg_severity: bias.avg_severity,
        weeks_active: bias.weeks_active,
        trending: bias.trending,
      },
    },
    action: { type: IMPROVEMENT_ACTION_TYPE.OPEN_WORKSPACE_TAB, payload: { tab: 'bias_review' } },
    source: IMPROVEMENT_SOURCE.HEURISTIC,
    status: IMPROVEMENT_STATUS.OPEN,
    metadata: { ...ctx.metadata, builder: 'bias' },
    generated_at: ctx.generated_at,
  };
}

/**
 * 把单个 OutcomePattern → ImprovementSuggestionUpsertRow.
 * category='outcome', key=outcome_type, action='open_workspace_tab' → 亏损复盘.
 */
export function buildOutcomeSuggestion(
  outcome: OutcomePattern,
  rank: number,
  total: number,
  ctx: {
    user_id: number;
    period_start: string;
    period_end: string;
    error_pattern_report_id: number;
    generated_at: Date;
    metadata: Record<string, unknown>;
  }
): ImprovementSuggestionUpsertRow {
  const title = enforceTitleConstraints(
    `${outcome.outcome_type} 命中 ${outcome.total_count} 笔, 累计亏损 ${outcome.total_loss.toFixed(
      2
    )} 元`
  );
  const samples = outcome.worst_examples
    .slice(0, SAMPLE_ITEMS_MAX)
    .map(e => `${e.symbol}(${e.date} ${e.loss.toFixed(0)})`)
    .join('/');
  const body = enforceBodyConstraints(
    [
      `90 天内 ${outcome.outcome_type} 共触发 ${
        outcome.total_count
      } 笔, 累计亏损 ${outcome.total_loss.toFixed(
        2
      )} 元, 平均单笔亏损 ${outcome.avg_loss_pct.toFixed(2)}%.`,
      samples ? `最严重 case: ${samples}.` : '',
      `建议: ① 复盘 worst case 共性; ② 调整止损 / 仓位上限; ③ 该类型再次触发时强制人工 confirm.`,
    ]
      .filter(Boolean)
      .join(' ')
  );
  return {
    user_id: ctx.user_id,
    period_start: ctx.period_start,
    period_end: ctx.period_end,
    category: IMPROVEMENT_CATEGORY.OUTCOME,
    key: outcome.outcome_type,
    title,
    body,
    priority: computePriority(rank, total, IMPROVEMENT_PRIORITY_TOP - 10),
    evidence: {
      error_pattern_report_id: ctx.error_pattern_report_id,
      period_start: ctx.period_start,
      period_end: ctx.period_end,
      sample_items: outcome.worst_examples.slice(0, SAMPLE_ITEMS_MAX),
      metric: {
        total_count: outcome.total_count,
        total_loss: outcome.total_loss,
        avg_loss_pct: outcome.avg_loss_pct,
      },
    },
    action: { type: IMPROVEMENT_ACTION_TYPE.OPEN_WORKSPACE_TAB, payload: { tab: 'loss_review' } },
    source: IMPROVEMENT_SOURCE.HEURISTIC,
    status: IMPROVEMENT_STATUS.OPEN,
    metadata: { ...ctx.metadata, builder: 'outcome' },
    generated_at: ctx.generated_at,
  };
}

/**
 * 把单个 AttributionPattern (负贡献) → ImprovementSuggestionUpsertRow.
 * category='attribution', key=dimension, action='tune_risk_param' (建议调阈).
 * 仅处理 total_contrib < 0 的维度.
 */
export function buildAttributionSuggestion(
  attr: AttributionPattern,
  rank: number,
  total: number,
  ctx: {
    user_id: number;
    period_start: string;
    period_end: string;
    error_pattern_report_id: number;
    generated_at: Date;
    metadata: Record<string, unknown>;
  }
): ImprovementSuggestionUpsertRow {
  const negPct = (attr.sign_consistency * 100).toFixed(0);
  const title = enforceTitleConstraints(
    `${attr.dimension} 维度累计 ${attr.total_contrib.toFixed(2)} 元, 负贡献天数 ${negPct}%`
  );
  const body = enforceBodyConstraints(
    [
      `${attr.dimension} 在 90 天窗口内累计贡献 ${attr.total_contrib.toFixed(
        2
      )} 元, 日均 ${attr.avg_per_day.toFixed(2)} 元, 负贡献天数占比 ${negPct}%.`,
      attr.worst_day
        ? `最差当天: ${attr.worst_day} 贡献 ${attr.worst_day_contrib.toFixed(2)} 元.`
        : '',
      `建议: 检查 ${attr.dimension} 相关参数 (e.g. 风控阈值 / 行业敞口 / 执行成本) 并在风控参数中心调整.`,
    ]
      .filter(Boolean)
      .join(' ')
  );
  return {
    user_id: ctx.user_id,
    period_start: ctx.period_start,
    period_end: ctx.period_end,
    category: IMPROVEMENT_CATEGORY.ATTRIBUTION,
    key: attr.dimension,
    title,
    body,
    priority: computePriority(rank, total, IMPROVEMENT_PRIORITY_TOP - 15),
    evidence: {
      error_pattern_report_id: ctx.error_pattern_report_id,
      period_start: ctx.period_start,
      period_end: ctx.period_end,
      sample_items: attr.worst_day
        ? [{ date: attr.worst_day, contrib: attr.worst_day_contrib }]
        : [],
      metric: {
        total_contrib: attr.total_contrib,
        avg_per_day: attr.avg_per_day,
        sign_consistency: attr.sign_consistency,
      },
    },
    action: {
      type: IMPROVEMENT_ACTION_TYPE.TUNE_RISK_PARAM,
      payload: { dimension: attr.dimension },
    },
    source: IMPROVEMENT_SOURCE.HEURISTIC,
    status: IMPROVEMENT_STATUS.OPEN,
    metadata: { ...ctx.metadata, builder: 'attribution' },
    generated_at: ctx.generated_at,
  };
}

/**
 * 把单个 TopFinding → 'top' category suggestion.
 * key = "{category}:{key}" 保证与三类原始 suggestion 不冲突.
 * 给前端高优先级 banner 用 — priority 始终 = IMPROVEMENT_PRIORITY_TOP, 按 score 排序后渐降.
 */
export function buildTopSuggestion(
  finding: TopFinding,
  rank: number,
  total: number,
  ctx: {
    user_id: number;
    period_start: string;
    period_end: string;
    error_pattern_report_id: number;
    generated_at: Date;
    metadata: Record<string, unknown>;
  }
): ImprovementSuggestionUpsertRow {
  const title = enforceTitleConstraints(`[Top ${rank + 1}] ${finding.category}: ${finding.key}`);
  const body = enforceBodyConstraints(
    [
      `综合优先级 top finding (score=${finding.score.toFixed(2)}, category=${finding.category}).`,
      finding.detail,
      `建议: 优先复盘该项, 必要时一键 apply 调用对应类目 (${finding.category}) 的根因 suggestion.`,
    ].join(' ')
  );
  return {
    user_id: ctx.user_id,
    period_start: ctx.period_start,
    period_end: ctx.period_end,
    category: IMPROVEMENT_CATEGORY.TOP,
    key: `${finding.category}:${finding.key}`,
    title,
    body,
    priority: computePriority(rank, total, IMPROVEMENT_PRIORITY_TOP),
    evidence: {
      error_pattern_report_id: ctx.error_pattern_report_id,
      period_start: ctx.period_start,
      period_end: ctx.period_end,
      sample_items: [],
      metric: {
        score: finding.score,
        source_category: finding.category,
        source_key: finding.key,
      },
    },
    action: { type: IMPROVEMENT_ACTION_TYPE.NOOP },
    source: IMPROVEMENT_SOURCE.HEURISTIC,
    status: IMPROVEMENT_STATUS.OPEN,
    metadata: { ...ctx.metadata, builder: 'top' },
    generated_at: ctx.generated_at,
  };
}

/**
 * 把整份 ErrorPatternSnapshot.patterns 展开成所有 suggestion 行 (四类合并).
 * 调用方拿到 rows 后 bulkUpsert 即可.
 */
export function buildSuggestionsFromPatterns(
  snapshot: ErrorPatternSnapshot,
  generatedAt: Date,
  baseMetadata: Record<string, unknown>
): ImprovementSuggestionUpsertRow[] {
  const ctx = {
    user_id: snapshot.user_id,
    period_start: snapshot.period_start,
    period_end: snapshot.period_end,
    error_pattern_report_id: snapshot.id,
    generated_at: generatedAt,
    metadata: baseMetadata,
  };
  const patterns = snapshot.patterns;
  const rows: ImprovementSuggestionUpsertRow[] = [];
  const biases = Array.isArray(patterns.bias_patterns) ? patterns.bias_patterns : [];
  biases.forEach((b, i) => rows.push(buildBiasSuggestion(b, i, biases.length, ctx)));
  const outcomes = Array.isArray(patterns.outcome_patterns) ? patterns.outcome_patterns : [];
  outcomes.forEach((o, i) => rows.push(buildOutcomeSuggestion(o, i, outcomes.length, ctx)));
  const attrs = Array.isArray(patterns.attribution_patterns)
    ? patterns.attribution_patterns.filter(a => a.total_contrib < 0)
    : [];
  attrs.forEach((a, i) => rows.push(buildAttributionSuggestion(a, i, attrs.length, ctx)));
  const tops = Array.isArray(patterns.top_findings) ? patterns.top_findings : [];
  tops.forEach((t, i) => rows.push(buildTopSuggestion(t, i, tops.length, ctx)));
  return rows;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * generateForUser — PM-023 主入口.
 *
 * 流程:
 *   (1) ds.loadLatestErrorPatternReport(user_id, period_end?) → null = skipped
 *   (2) snapshot.patterns 全空 → skipped reason='patterns_empty'
 *   (3) buildSuggestionsFromPatterns → rows[] (四类合并)
 *   (4) ds.bulkUpsertSuggestions(rows) → 失败 logger.warn 不抛, persisted_count=0
 *
 * 行为契约: 任何阶段异常 fail-OPEN, 永不 throw. **本 service 不写"留痕空行"** —
 * 与 ErrorPatternAggregator 的"周日强制留痕" 不同, 改进建议不写 zero-row 占位
 * (没建议就没建议, UI 显示"暂无建议"即可).
 */
export async function generateForUser(
  userId: number,
  options: {
    data_source: ImprovementSuggestionDataSource;
    /** 不传则取最近 1 行 ErrorPatternReport; 传则按 period_end 等值查. */
    period_end?: string | null;
    /** 'cron' / 'manual' / 'replay' 等; 落 metadata.cron_run_id 用. */
    cron_run_id?: string | null;
  }
): Promise<GenerateImprovementResult> {
  const { data_source: ds, period_end, cron_run_id } = options;
  const baseMetadata: Record<string, unknown> = { heuristic_engine: 'v1' };
  if (cron_run_id != null) baseMetadata.cron_run_id = cron_run_id;

  // (1) 取 snapshot
  let snapshot: ErrorPatternSnapshot | null = null;
  try {
    snapshot = await ds.loadLatestErrorPatternReport({ user_id: userId, period_end });
  } catch (err) {
    logger.warn(
      `[improvement] loadLatestErrorPatternReport user=${userId} period_end=${
        period_end ?? 'latest'
      } threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      status: IMPROVEMENT_GENERATE_STATUS.FAILED,
      rows: [],
      persisted_count: 0,
      reason: 'load_threw',
      error_pattern_report_id: null,
    };
  }

  if (!snapshot) {
    return {
      status: IMPROVEMENT_GENERATE_STATUS.SKIPPED,
      rows: [],
      persisted_count: 0,
      reason: 'no_error_pattern',
      error_pattern_report_id: null,
    };
  }

  baseMetadata.error_pattern_report_id = snapshot.id;
  baseMetadata.error_pattern_report_generated_at = snapshot.generated_at;

  // (2) 全空 patterns → skipped
  const patterns = snapshot.patterns || ({} as ErrorPatterns);
  const biasCount = Array.isArray(patterns.bias_patterns) ? patterns.bias_patterns.length : 0;
  const outcomeCount = Array.isArray(patterns.outcome_patterns)
    ? patterns.outcome_patterns.length
    : 0;
  const attrCount = Array.isArray(patterns.attribution_patterns)
    ? patterns.attribution_patterns.filter(a => a.total_contrib < 0).length
    : 0;
  const topCount = Array.isArray(patterns.top_findings) ? patterns.top_findings.length : 0;
  if (biasCount + outcomeCount + attrCount + topCount === 0) {
    return {
      status: IMPROVEMENT_GENERATE_STATUS.SKIPPED,
      rows: [],
      persisted_count: 0,
      reason: 'patterns_empty',
      error_pattern_report_id: snapshot.id,
    };
  }

  // (3) 构造 rows
  const generatedAt = new Date();
  const rows = buildSuggestionsFromPatterns(snapshot, generatedAt, baseMetadata);
  if (rows.length === 0) {
    return {
      status: IMPROVEMENT_GENERATE_STATUS.SKIPPED,
      rows: [],
      persisted_count: 0,
      reason: 'patterns_empty',
      error_pattern_report_id: snapshot.id,
    };
  }

  // (4) bulkUpsert
  const upsertRes = await safeBulkUpsert(ds, rows);
  if (!upsertRes.ok) {
    return {
      status: IMPROVEMENT_GENERATE_STATUS.FAILED,
      rows,
      persisted_count: 0,
      reason: upsertRes.reason || 'bulk_upsert_failed',
      error_pattern_report_id: snapshot.id,
    };
  }
  return {
    status: IMPROVEMENT_GENERATE_STATUS.OK,
    rows,
    persisted_count: upsertRes.persisted_count,
    reason: null,
    error_pattern_report_id: snapshot.id,
  };
}

/** bulkUpsert 包一层 try/catch — DataSource 已 try/catch, 再兜一层防 fake 差异. */
async function safeBulkUpsert(
  ds: ImprovementSuggestionDataSource,
  rows: ImprovementSuggestionUpsertRow[]
): Promise<{ ok: boolean; persisted_count: number; reason?: string }> {
  try {
    const r = await ds.bulkUpsertSuggestions(rows);
    if (r.ok) return { ok: true, persisted_count: r.persisted_count };
    return {
      ok: false,
      persisted_count: 0,
      reason: r.reason || 'bulk_upsert_returned_false',
    };
  } catch (err) {
    logger.warn(
      `[improvement] bulkUpsertSuggestions threw (${rows.length} rows): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { ok: false, persisted_count: 0, reason: 'bulk_upsert_threw' };
  }
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require model
// ---------------------------------------------------------------------------

/**
 * 生产 DataSource 工厂. lazy require ErrorPatternReport + ImprovementSuggestion
 * 让单测进程 (无 PG) 不被 require chain 拽起 sequelize 实例.
 *
 * loadLatestErrorPatternReport:
 *   - period_end 传 → 按 (user_id, period_end, status='ok') 精确查
 *   - period_end 不传 → 按 user_id 取 generated_at DESC 最近 1 行 (status='ok')
 *   - 任何 throw 内部 try/catch 兜底返 null
 *
 * bulkUpsertSuggestions:
 *   - 逐行 ImprovementSuggestion.upsert ((user_id, period_end, category, key) UNIQUE
 *     ON CONFLICT DO UPDATE)
 *   - 单行失败 logger.warn + persisted_count 不计入, 不中断后续行
 *   - 全失败 → ok=false reason='all_rows_failed'; 部分成功 → ok=true persisted_count<N
 */
export function createProductionImprovementSuggestionDataSource(): ImprovementSuggestionDataSource {
  return {
    async loadLatestErrorPatternReport({ user_id, period_end }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ErrorPatternReport } = require('../../models/ErrorPatternReport');
        const where: Record<string, unknown> = { user_id, status: 'ok' };
        if (period_end != null) where.period_end = period_end;
        const row = await ErrorPatternReport.findOne({
          where,
          order: [['generated_at', 'DESC']],
        });
        if (!row) return null;
        const j: Record<string, unknown> = typeof row.toJSON === 'function' ? row.toJSON() : row;
        const patterns =
          j.patterns && typeof j.patterns === 'object'
            ? (j.patterns as ErrorPatterns)
            : ({
                bias_patterns: [],
                outcome_patterns: [],
                attribution_patterns: [],
                top_findings: [],
              } as ErrorPatterns);
        return {
          id: Number(j.id) || 0,
          user_id: Number(j.user_id) || user_id,
          period_start: String(j.period_start ?? ''),
          period_end: String(j.period_end ?? ''),
          lookback_days: Number(j.lookback_days) || 90,
          patterns,
          summary: String(j.summary ?? ''),
          status: String(j.status ?? 'ok'),
          generated_at:
            j.generated_at instanceof Date
              ? j.generated_at
              : new Date(String(j.generated_at ?? new Date().toISOString())),
        };
      } catch (err) {
        logger.warn(
          `[improvement] PRODUCTION loadLatestErrorPatternReport user=${user_id} period_end=${
            period_end ?? 'latest'
          } threw: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }
    },
    async bulkUpsertSuggestions(rows) {
      if (rows.length === 0) return { ok: true, persisted_count: 0 };
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ImprovementSuggestion } = require('../../models/ImprovementSuggestion');
        let persisted = 0;
        const errors: string[] = [];
        for (const row of rows) {
          try {
            await ImprovementSuggestion.upsert(row);
            persisted += 1;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${row.category}:${row.key} -> ${msg}`);
            logger.warn(
              `[improvement] PRODUCTION upsert user=${row.user_id} period_end=${row.period_end} ${row.category}/${row.key} threw: ${msg}`
            );
          }
        }
        if (persisted === 0) {
          return {
            ok: false,
            persisted_count: 0,
            reason: 'all_rows_failed',
            error: errors.join('; '),
          };
        }
        return { ok: true, persisted_count: persisted };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[improvement] PRODUCTION bulkUpsertSuggestions threw: ${msg}`);
        return { ok: false, persisted_count: 0, reason: 'bulk_upsert_threw', error: msg };
      }
    },
  };
}

export const PRODUCTION_IMPROVEMENT_SUGGESTION_DATA_SOURCE: ImprovementSuggestionDataSource =
  createProductionImprovementSuggestionDataSource();
