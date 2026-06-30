/**
 * US-057 [FE-018] PortfolioWorkspace 行业集中度 KPI — 纯函数 helper.
 *
 * 把 PortfolioWorkspace.tsx 内联的 `IndustryConcentrationKpi` 渲染逻辑
 * 抽到独立 module 让它真可单测 — 与 [[前端 pure helper 模板]] (US-049
 * factorPickReasonHelpers / US-054 strategy-leaderboard-helpers / US-052
 * overfitMetricsHelpers) 同款思路.
 *
 * 设计取舍 (与 backend US-012 [PR-007] IndustryConcentrationGuard 对照):
 *   - **不复用后端 alert_pct (35%) 作为红色阈值**: 25% 是 UI 提示用户
 *     关注的早期 warning, 35% 才是后端真正写 RiskAlert 的阈值. 双阈值
 *     解耦避免"看到红色 = 立刻爆仓"的误读. tooltip 里把两数字都写出来.
 *   - **严格 > 25% 才转红**, 恰好等于 25% 仍走 neutral 色 — 与后端
 *     `over_alert` 同款"严格大于"语义, 避免边界值反复抖动.
 *   - **分母不含 cash**: 与 backend `IndustryConcentrationGuard.aggregateByIndustry`
 *     同款 (`max_industry_pct` 已是后端算好的 0-1 fraction), helper 不
 *     重算只渲染.
 *   - **`__UNKNOWN__` → "未分类"**: 让用户知道补行业映射数据, 而不是
 *     直接显示一段 sentinel 字面量.
 *   - **summary=null 或 portfolio_id=null → 隐藏 KPI**: 接口失败 / 还
 *     未加载完 → 不显示 NaN / 不撑空位 (其它 KPI 已渲染, 没必要因为
 *     一项 KPI 失败把整个 strip 拆了).
 *
 * 纯函数, 不依赖 React / antd / fetch, 单测在
 * backend/tests/services/industry-concentration-kpi-helpers.test.ts
 * (跨 monorepo import, 与 US-049/US-054 同款模式).
 */

import type { IndustryConcentrationSummary } from '../../services/portfolioWorkspaceService';
import { UNKNOWN_INDUSTRY_LABEL } from '../../services/portfolioWorkspaceService';

/** AC 主条款: > 25% 红色提示阈值 (0-1 fraction). */
export const INDUSTRY_KPI_WARN_PCT = 0.25;

/** 红色 — antd `cf1322` 主红, 与最大回撤 KPI 同色 (同语义: 危险) */
export const INDUSTRY_KPI_WARN_COLOR = '#dc2626';

/** 中性灰 — 默认 valueStyle, 与 antd Statistic 默认接近 */
export const INDUSTRY_KPI_NEUTRAL_COLOR = '#1f1f1f';

/** sentinel industry 名的人类标签 (与 backend `__UNKNOWN__` 同步) */
export const INDUSTRY_UNKNOWN_HUMAN_LABEL = '未分类';

/** industry 名缺失 (null/empty) 的兜底显示文案 */
export const INDUSTRY_EMPTY_PLACEHOLDER = '—';

/**
 * View model 形态 — KPI 渲染层一次拿全, 不再在 component 里散开算.
 *
 * `hidden=true` → KPI 整个不渲染 (return null).
 * 其它字段在 `hidden=false` 时一定有值, component 不需要再 fallback.
 */
export interface IndustryConcentrationKpiViewModel {
  /** true = 整个 KPI 隐藏 (summary 缺 / portfolio_id null). */
  hidden: boolean;
  /** 0-1 fraction; 0 if max_industry_pct=null (空持仓). */
  rawPct: number;
  /** rawPct * 100 — UI 直显数字. */
  pctNum: number;
  /** 严格 > 25% 才 true. 触发红色 valueStyle. */
  overWarn: boolean;
  /** 后端 over_alert 透传 (是否超 35% 真告警阈值) — 用于 tooltip warning 文案. */
  overAlert: boolean;
  /** 行业名人类标签 (UNKNOWN→未分类, null/empty→—, 否则原值). */
  industryLabel: string;
  /** Statistic 的 suffix — "% · 银行" / "%" (当 label='—' 时). */
  suffix: string;
  /** Statistic valueStyle.color — warn 或 neutral. */
  color: string;
  /** Tooltip 行 — testable 数组, component 简单 .map 渲染. */
  tooltipLines: string[];
}

/**
 * 判断 KPI 是否该整个隐藏.
 *
 * - summary 缺 (loading / 接口失败) → true
 * - portfolio_id null (用户没选 portfolio / 没建任何 portfolio) → true
 *
 * 与 component 里的 `if (!summary || summary.portfolio_id === null) return null` 等价,
 * 独立函数让 META-GUARD 可以一句 regex 守住.
 */
export function shouldHideIndustryKpi(
  summary: IndustryConcentrationSummary | null | undefined
): boolean {
  if (summary === null || summary === undefined) return true;
  if (summary.portfolio_id === null) return true;
  return false;
}

/**
 * 严格 > WARN_PCT 才转红. 恰好等于 25% 仍 false (与后端 `over_alert` 严格
 * 大于语义对齐, 避免边界值抖动).
 */
export function isOverIndustryWarn(rawPct: number | null | undefined): boolean {
  if (rawPct === null || rawPct === undefined) return false;
  if (!Number.isFinite(rawPct)) return false;
  return rawPct > INDUSTRY_KPI_WARN_PCT;
}

/**
 * 行业名 → 人类标签.
 *
 * - `__UNKNOWN__` (与后端 sentinel 完全一致) → "未分类"
 * - null / undefined / 空串 → "—"
 * - 其它原样返
 */
export function formatIndustryLabel(name: string | null | undefined): string {
  if (name === UNKNOWN_INDUSTRY_LABEL) return INDUSTRY_UNKNOWN_HUMAN_LABEL;
  if (name === null || name === undefined) return INDUSTRY_EMPTY_PLACEHOLDER;
  const trimmed = String(name).trim();
  if (trimmed.length === 0) return INDUSTRY_EMPTY_PLACEHOLDER;
  return trimmed;
}

/**
 * Statistic 的 suffix 段拼接.
 *
 * - 行业 label 是占位 '—' → "%" (不拼后缀; 避免 "0.00% · —" 看着像数据错)
 * - 否则 → "% · 银行"
 */
export function buildIndustryKpiSuffix(industryLabel: string): string {
  if (industryLabel === INDUSTRY_EMPTY_PLACEHOLDER) return '%';
  return `% · ${industryLabel}`;
}

/**
 * Tooltip 行集合 — 返字符串数组让单测可以逐行断言, component 直接 .map 渲染.
 *
 * 行内容:
 *   1. 最大行业: <label>
 *   2. 当前占比: <pct>%
 *   3. UI 提示阈值: 25% (超出转红)
 *   4. 系统告警阈值: <alert>% (超出写 RiskAlert)
 *   5. (仅 over_alert=true) ⚠ 当前已超系统告警阈值, 建议一键再平衡.
 */
export function buildIndustryKpiTooltipLines(summary: IndustryConcentrationSummary): string[] {
  const label = formatIndustryLabel(summary.max_industry_name);
  const rawPct = summary.max_industry_pct ?? 0;
  const pctNum = rawPct * 100;
  const lines: string[] = [
    `最大行业: ${label}`,
    `当前占比: ${pctNum.toFixed(2)}%`,
    `UI 提示阈值: ${(INDUSTRY_KPI_WARN_PCT * 100).toFixed(0)}% (超出转红)`,
    `系统告警阈值: ${(summary.alert_pct * 100).toFixed(0)}% (超出写 RiskAlert)`,
  ];
  if (summary.over_alert) {
    lines.push('⚠ 当前已超系统告警阈值, 建议一键再平衡.');
  }
  return lines;
}

/**
 * 主入口: summary → view model. component 直接 destructure 渲染.
 *
 * 任何非法/缺数据输入返 `hidden=true` 兜底 view model — 永远不抛, 让
 * component 零 try/catch.
 */
export function buildIndustryConcentrationKpiViewModel(
  summary: IndustryConcentrationSummary | null | undefined
): IndustryConcentrationKpiViewModel {
  if (shouldHideIndustryKpi(summary)) {
    return {
      hidden: true,
      rawPct: 0,
      pctNum: 0,
      overWarn: false,
      overAlert: false,
      industryLabel: INDUSTRY_EMPTY_PLACEHOLDER,
      suffix: '%',
      color: INDUSTRY_KPI_NEUTRAL_COLOR,
      tooltipLines: [],
    };
  }
  // 上面 shouldHideIndustryKpi 已守 summary 非空
  const s = summary as IndustryConcentrationSummary;
  const rawPct = s.max_industry_pct ?? 0;
  const pctNum = Number.isFinite(rawPct) ? rawPct * 100 : 0;
  const overWarn = isOverIndustryWarn(rawPct);
  const industryLabel = formatIndustryLabel(s.max_industry_name);
  const suffix = buildIndustryKpiSuffix(industryLabel);
  const color = overWarn ? INDUSTRY_KPI_WARN_COLOR : INDUSTRY_KPI_NEUTRAL_COLOR;
  const tooltipLines = buildIndustryKpiTooltipLines(s);
  return {
    hidden: false,
    rawPct,
    pctNum,
    overWarn,
    overAlert: Boolean(s.over_alert),
    industryLabel,
    suffix,
    color,
    tooltipLines,
  };
}
