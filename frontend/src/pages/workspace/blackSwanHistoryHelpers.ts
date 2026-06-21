/**
 * US-133 [PR-018] — SettingsWorkspace.BlackSwanHistoryTab pure helpers.
 *
 * 把 `BlackSwanEvent` row 归一化成 UI 友好的展示值: 标签 / 颜色 / 中文描述, 让 tab.tsx
 * 只剩 fetch + render + navigate. 不依赖 React / antd, 单测在
 * backend/tests/risk/black-swan-history-helpers.test.ts 跨 monorepo 跑.
 *
 * 与 [[todoSuggestionsHelpers]] / [[analysisEngineWeightHelpers]] / [[shadowRunHelpers]]
 * 同款 "pure helper + frozen 常量 + 单测可验 + 跨 monorepo import" 思想.
 *
 * 接入 [[Codebase Patterns]] "前端 pure helper 模板" + "≤N / ∈[a,b] 类 AC 5 件套" 思想:
 *   - 阈值 / cap 全 export 常量, 单测守 sanity;
 *   - 颜色 / 标签 / 排序 frozen Record, 改一处生效;
 *   - 主入口 enrichBlackSwanEventRow(row) 接受 unknown 兜底, 任何字段缺失走 fallback;
 *   - severity 排序在 sortBlackSwanEvents 内显式 (critical→high→medium→low + detected_at DESC),
 *     与 [[todoSuggestionsHelpers.sortTodos]] 同款 3 段稳定 (severity → time → id).
 */

import type {
  BlackSwanEventRow,
  BlackSwanEventType,
  BlackSwanSeverity,
  BlackSwanScope,
  BlackSwanStatus,
} from '../../services/blackSwanService';

// ---------------------------------------------------------------------------
// 常量 — 全 export 让单测守 sanity + ops 改一处生效
// ---------------------------------------------------------------------------

/** event_type 显示顺序 (UI Select 下拉) — 与 [[BlackSwanEvent]] enum 对齐 */
export const BLACK_SWAN_EVENT_TYPES: ReadonlyArray<BlackSwanEventType> = Object.freeze([
  'ST',
  'SUSPENDED',
  'NEWS_KEYWORD',
  'SHAREHOLDER_REDUCTION',
  'MARKET_REGIME',
  'OTHER',
]);

/** event_type 中文标签 */
export const BLACK_SWAN_EVENT_TYPE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  ST: 'ST 标记',
  SUSPENDED: '停牌',
  NEWS_KEYWORD: '重大利空新闻',
  SHAREHOLDER_REDUCTION: '大股东减持',
  MARKET_REGIME: '大盘极端',
  OTHER: '其它',
});

/** severity 排序 (critical 最严重) */
export const BLACK_SWAN_SEVERITY_ORDER: ReadonlyArray<BlackSwanSeverity> = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
]);

/** severity Tag 颜色 (antd token) — 与 [[todoSuggestionsHelpers]] TODO_PRIORITY_COLOR 风格一致 */
export const BLACK_SWAN_SEVERITY_COLOR: Readonly<Record<BlackSwanSeverity, string>> = Object.freeze(
  {
    critical: 'red',
    high: 'volcano',
    medium: 'gold',
    low: 'default',
  }
);

/** severity 中文标签 */
export const BLACK_SWAN_SEVERITY_LABEL: Readonly<Record<BlackSwanSeverity, string>> = Object.freeze(
  {
    critical: '极端',
    high: '高',
    medium: '中',
    low: '低',
  }
);

/** scope 中文标签 */
export const BLACK_SWAN_SCOPE_LABEL: Readonly<Record<BlackSwanScope, string>> = Object.freeze({
  symbol: '单股',
  sector: '行业',
  market: '全市场',
  portfolio: '组合',
});

/** scope Tag 颜色 */
export const BLACK_SWAN_SCOPE_COLOR: Readonly<Record<BlackSwanScope, string>> = Object.freeze({
  symbol: 'blue',
  sector: 'cyan',
  market: 'purple',
  portfolio: 'green',
});

/** status 中文标签 */
export const BLACK_SWAN_STATUS_LABEL: Readonly<Record<BlackSwanStatus, string>> = Object.freeze({
  open: '进行中',
  resolved: '已解决',
  expired: '已过期',
});

/** status Tag 颜色 */
export const BLACK_SWAN_STATUS_COLOR: Readonly<Record<BlackSwanStatus, string>> = Object.freeze({
  open: 'red',
  resolved: 'green',
  expired: 'default',
});

/** title / description 截断 cap (UI 列表展示, 详情不截) */
export const BLACK_SWAN_TITLE_MAX_CHARS = 60;
export const BLACK_SWAN_DESCRIPTION_MAX_CHARS = 120;

/** 默认分页 limit (与 backend default 对齐) */
export const BLACK_SWAN_DEFAULT_PAGE_LIMIT = 30;
/** 单页最大 limit (与 backend cap 对齐 — 同源避免前后端漂) */
export const BLACK_SWAN_MAX_PAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// pure helpers — 显示归一化
// ---------------------------------------------------------------------------

/** 截断字符串到 max 字符 (含最后的 '…'). 空字符串返空. 与 truncateText 同款. */
export function truncateText(text: string | null | undefined, max: number): string {
  if (text == null) return '';
  const s = String(text);
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

/** event_type 显示名 (未知值回退到原值, 防 backend 新增 enum 后 UI 显示空) */
export function eventTypeLabel(t: string | null | undefined): string {
  if (!t) return '—';
  return BLACK_SWAN_EVENT_TYPE_LABEL[String(t)] ?? String(t);
}

/** scope 显示名, 同上 */
export function scopeLabel(s: string | null | undefined): string {
  if (!s) return '—';
  return BLACK_SWAN_SCOPE_LABEL[String(s) as BlackSwanScope] ?? String(s);
}

/** status 显示名, 同上 */
export function statusLabel(s: string | null | undefined): string {
  if (!s) return '—';
  return BLACK_SWAN_STATUS_LABEL[String(s) as BlackSwanStatus] ?? String(s);
}

/** severity 显示名, 同上 */
export function severityLabel(s: string | null | undefined): string {
  if (!s) return '—';
  return BLACK_SWAN_SEVERITY_LABEL[String(s) as BlackSwanSeverity] ?? String(s);
}

/** severity 颜色 (UI Tag) — 未知 severity 走 'default' 不抛 */
export function severityColor(s: string | null | undefined): string {
  if (!s) return 'default';
  return BLACK_SWAN_SEVERITY_COLOR[String(s) as BlackSwanSeverity] ?? 'default';
}

/** scope 颜色 — 未知 scope 走 'default' 不抛 */
export function scopeColor(s: string | null | undefined): string {
  if (!s) return 'default';
  return BLACK_SWAN_SCOPE_COLOR[String(s) as BlackSwanScope] ?? 'default';
}

/** status 颜色 — 未知 status 走 'default' 不抛 */
export function statusColor(s: string | null | undefined): string {
  if (!s) return 'default';
  return BLACK_SWAN_STATUS_COLOR[String(s) as BlackSwanStatus] ?? 'default';
}

/**
 * severity rank — critical=0 最严重 → low=3.
 * 未知 severity 返 999 让其落最后. 用于稳定排序的第一段.
 */
export function severityRank(s: string | null | undefined): number {
  const idx = BLACK_SWAN_SEVERITY_ORDER.indexOf(String(s) as BlackSwanSeverity);
  if (idx < 0) return 999;
  return idx;
}

/**
 * 排序 black-swan event 列表 — 3 段稳定排序 (severity → detected_at DESC → id ASC).
 * 与 [[todoSuggestionsHelpers.sortTodos]] / [[alertsPanelHelpers.sortAlerts]] 同款 3 段稳定模板.
 *
 * - 第 1 段: severity (critical 最先);
 * - 第 2 段: detected_at DESC (最新最先);
 * - 第 3 段: id ASC (兜底稳定 — 同 ts 同 severity 时按 id 字典序, 防 React key 抖动).
 *
 * 注意: 调用方传 backend response 已经按 detected_at DESC 排过, 这个 helper 主要给"按
 * severity 重新排"用 — 默认 backend 顺序就好, severity-first 排序只在用户切 "按严重度" 视图时启用.
 */
export function sortBlackSwanEventsBySeverity(rows: BlackSwanEventRow[]): BlackSwanEventRow[] {
  return [...rows].sort((a, b) => {
    const sa = severityRank(a.severity);
    const sb = severityRank(b.severity);
    if (sa !== sb) return sa - sb;
    const ta = a.detected_at ? new Date(a.detected_at).getTime() : 0;
    const tb = b.detected_at ? new Date(b.detected_at).getTime() : 0;
    if (ta !== tb) return tb - ta; // DESC
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

/**
 * 计算分类聚合 — 顶部 KPI bar 用. 永远返 4 个 severity 即使某个 count=0, 顺序固定不闪烁
 * (与 [[alertsPanelHelpers.summarize]] 同款).
 */
export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
}

export function summarizeBlackSwanEvents(rows: BlackSwanEventRow[]): SeveritySummary {
  const summary: SeveritySummary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    total: 0,
  };
  for (const r of rows || []) {
    summary.total += 1;
    const sv = String(r.severity || '');
    if (sv === 'critical') summary.critical += 1;
    else if (sv === 'high') summary.high += 1;
    else if (sv === 'medium') summary.medium += 1;
    else if (sv === 'low') summary.low += 1;
    else summary.unknown += 1;
  }
  return summary;
}

/**
 * postmortem 4 段完成度计算 — UI 详情页用 Tag "已生成 N/4" 展示.
 * 段判定: JSONB 非 null 且 Object.keys 数 > 0.
 *
 * 与 [[BlackSwanPostmortemReport]] metadata.sections_filled[] 的语义对齐, 但本 helper
 * 直接从 4 段 JSONB 内容判断 (不依赖 metadata 维护), 让"未维护 sections_filled 字段
 * 但实际段已填" 的兼容情况下仍正确.
 */
export interface PostmortemSectionStatus {
  event_summary: boolean;
  counterfactual_baselines: boolean;
  event_timeline: boolean;
  improvement_suggestions: boolean;
  filled: number;
  total: number;
}

export function computePostmortemSectionStatus(
  postmortem:
    | {
        event_summary?: Record<string, unknown> | null;
        counterfactual_baselines?: Record<string, unknown> | null;
        event_timeline?: Record<string, unknown> | null;
        improvement_suggestions?: Record<string, unknown> | null;
      }
    | null
    | undefined
): PostmortemSectionStatus {
  const hasFilled = (v: unknown): boolean => {
    if (v == null) return false;
    if (typeof v !== 'object') return false;
    return Object.keys(v as object).length > 0;
  };
  const e = hasFilled(postmortem?.event_summary);
  const c = hasFilled(postmortem?.counterfactual_baselines);
  const t = hasFilled(postmortem?.event_timeline);
  const i = hasFilled(postmortem?.improvement_suggestions);
  const filled = [e, c, t, i].filter(Boolean).length;
  return {
    event_summary: e,
    counterfactual_baselines: c,
    event_timeline: t,
    improvement_suggestions: i,
    filled,
    total: 4,
  };
}
