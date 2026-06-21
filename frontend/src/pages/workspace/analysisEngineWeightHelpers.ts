/**
 * US-067 [FE-028] SettingsWorkspace AI 引擎 8 dim 权重 slider — 纯函数 helper.
 *
 * 让操盘手在 SettingsWorkspace 的 "分析引擎" tab 给 8 个 analyzer dimension
 * (fundamental / technical / capital / sentiment / news / industry_regime / risk / event)
 * 拉 slider 调权重. UI 用 0~100 的百分比, 保存时归一化成 sum=1 写回
 * `User.risk_config.analysis_engine.weights` —— 与后端 normalizeWeights
 * (backend/src/services/analysis-engine/DecisionAggregator.ts) 同口径 (后端再做
 * 一次 sum→1 归一化, 防腐蚀).
 *
 * 默认值与后端 DEFAULT_ANALYZER_WEIGHTS 完全一致 (×100 换算成 %):
 *   fundamental 25 / technical 20 / capital 15 / sentiment 10 /
 *   news 10 / industry_regime 10 / risk 5 / event 5
 *
 * 设计:
 *   - 8 dim 顺序固定走 ANALYZER_DIMENSIONS, 让 UI/单测/保存 payload 都按同一序;
 *   - normalizeWeightsForSave: 把 0~100 的 % 转回 0~1 的 ratio (sum=1) — 与
 *     backend normalizeWeights 一样, 全 0 时返默认; 缺少 key 用默认填.
 *   - DEFAULT_ANALYZER_WEIGHTS_PERCENT export 让 UI 显示 "默认 25%" 提示, 且让
 *     单测可以单点守住 8 个默认值不被无意改动 (跟 backend 同步).
 *   - resetToDefaults() 返 fresh copy 让 React state 安全 mutate.
 *
 * 纯函数, 不依赖 React / antd / fetch, 直接吃 weights Record 返新 Record.
 * 单测在 backend/tests/services/analysis-engine-weight-helpers.test.ts (跨
 * monorepo import, 与 [[前端 pure helper 模板]] (factor-ai-weight / shadow-run /
 * overfit-metrics / etc.) 同款 ts-node --transpile-only 跑.
 */

/** 8 个 analyzer key — 与 backend AnalyzerKey 一致, 顺序与默认权重对齐 (从大到小) */
export type AnalyzerKey =
  | 'fundamental'
  | 'technical'
  | 'capital'
  | 'sentiment'
  | 'news'
  | 'industry_regime'
  | 'risk'
  | 'event';

/** 8 个 dimension 元数据 — 顺序固定, label 给 slider 显示, hint 给 Tooltip 显示 */
export interface AnalyzerDimensionMeta {
  key: AnalyzerKey;
  label: string;
  hint: string;
  defaultPercent: number;
}

/**
 * 8 个 dimension 的展示顺序 — 默认权重从大到小排,
 * 让用户视觉上立刻看出 "fundamental 最高 / event 最低" 的 prior.
 * frozen 防止 UI 端意外 mutate.
 */
export const ANALYZER_DIMENSIONS: ReadonlyArray<AnalyzerDimensionMeta> = Object.freeze([
  Object.freeze({
    key: 'fundamental' as AnalyzerKey,
    label: '基本面 (fundamental)',
    hint: 'ROE / 毛利 / 营收增速 / PE PB 估值分位. 长线主权重.',
    defaultPercent: 25,
  }),
  Object.freeze({
    key: 'technical' as AnalyzerKey,
    label: '技术面 (technical)',
    hint: 'MA / MACD / KDJ / 量价背离. 进出场时机与 buy_zone.',
    defaultPercent: 20,
  }),
  Object.freeze({
    key: 'capital' as AnalyzerKey,
    label: '资金面 (capital)',
    hint: '北向 / 主力净流入 / 融资余额 / 大单成交. 看主力动向.',
    defaultPercent: 15,
  }),
  Object.freeze({
    key: 'sentiment' as AnalyzerKey,
    label: '情绪面 (sentiment)',
    hint: '换手率 / 涨停 / 龙虎榜 / 雪球热度. 短期人气.',
    defaultPercent: 10,
  }),
  Object.freeze({
    key: 'news' as AnalyzerKey,
    label: '消息面 (news)',
    hint: '近 7 日新闻情感 / 高频关键词. 利好利空催化.',
    defaultPercent: 10,
  }),
  Object.freeze({
    key: 'industry_regime' as AnalyzerKey,
    label: '行业景气 (industry_regime)',
    hint: '所在行业 PMI / 政策 / 板块轮动 phase. 自上而下.',
    defaultPercent: 10,
  }),
  Object.freeze({
    key: 'risk' as AnalyzerKey,
    label: '风险面 (risk)',
    hint: '回撤 / 波动 / 违约 / 商誉减值. 硬否决 (score≤-80 时一票).',
    defaultPercent: 5,
  }),
  Object.freeze({
    key: 'event' as AnalyzerKey,
    label: '事件 (event)',
    hint: '退市 / 重大违规 / 业绩雷. veto/dampen 修正主分.',
    defaultPercent: 5,
  }),
]);

/** 默认权重表 (key→percent), 与后端 DEFAULT_ANALYZER_WEIGHTS ×100 等价. frozen. */
export const DEFAULT_ANALYZER_WEIGHTS_PERCENT: Readonly<Record<AnalyzerKey, number>> =
  Object.freeze({
    fundamental: 25,
    technical: 20,
    capital: 15,
    sentiment: 10,
    news: 10,
    industry_regime: 10,
    risk: 5,
    event: 5,
  });

/** 每个 slider 允许的取值范围 (UI 端硬约束). 单 slider 最高 60%, 最低 0%. */
export const ANALYZER_WEIGHT_MIN_PERCENT = 0;
export const ANALYZER_WEIGHT_MAX_PERCENT = 60;

/** sum 容忍带 — UI 显示 sum ∈ [95, 105] 为绿色 "已接近 100%". 否则黄/橙. */
export const WEIGHT_SUM_OK_MIN_PERCENT = 95;
export const WEIGHT_SUM_OK_MAX_PERCENT = 105;

/**
 * 把 partial percent record (UI state) 用默认值补齐 8 个 key, 让 slider
 * 控件永远拿到一个非 undefined 的数. 用于 load 后 init draft.
 *
 * pure, 不读全局.
 */
export function ensureAllPercents(
  partial: Partial<Record<AnalyzerKey, number>> | null | undefined
): Record<AnalyzerKey, number> {
  const out: Record<AnalyzerKey, number> = { ...DEFAULT_ANALYZER_WEIGHTS_PERCENT };
  if (!partial || typeof partial !== 'object') return out;
  for (const dim of ANALYZER_DIMENSIONS) {
    const raw = (partial as any)[dim.key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      out[dim.key] = clampPercent(raw);
    }
  }
  return out;
}

/** 单值钳制到 [MIN, MAX] 区间, 非数字返默认 (用入参 fallback 而非 0 以保留 prior). */
export function clampPercent(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < ANALYZER_WEIGHT_MIN_PERCENT) return ANALYZER_WEIGHT_MIN_PERCENT;
  if (value > ANALYZER_WEIGHT_MAX_PERCENT) return ANALYZER_WEIGHT_MAX_PERCENT;
  return value;
}

/**
 * 把后端 ratio 形式 (sum=1) 的 weights 转成 UI percent 形式 (sum≈100).
 * 容错: ratio 无效/缺失走默认 percent. 全 0 / 不存在键 → 默认.
 */
export function ratioToPercents(
  ratios: Partial<Record<AnalyzerKey, number>> | null | undefined
): Record<AnalyzerKey, number> {
  const out: Record<AnalyzerKey, number> = { ...DEFAULT_ANALYZER_WEIGHTS_PERCENT };
  if (!ratios || typeof ratios !== 'object') return out;
  // 后端可能存 ratio (sum=1) 也可能直接存 percent (sum=100) — 都兼容
  let total = 0;
  for (const dim of ANALYZER_DIMENSIONS) {
    const v = (ratios as any)[dim.key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) total += v;
  }
  if (total <= 0) return out;
  // 启发: 若 total ≤ 2 → 视为 ratio (sum≈1), 转 percent; 否则当 percent 直接用
  const isRatio = total <= 2;
  for (const dim of ANALYZER_DIMENSIONS) {
    const v = (ratios as any)[dim.key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[dim.key] = clampPercent(isRatio ? v * 100 : v, DEFAULT_ANALYZER_WEIGHTS_PERCENT[dim.key]);
    }
  }
  return out;
}

/**
 * 保存前把 UI percent 形式归一化成后端 ratio (sum=1), 与 backend
 * `normalizeWeights` 同语义: 全 0 或非法 → 返默认 ratio, 否则按比例归一.
 *
 * 输出 8 key 完整, 每个 ≥ 0, sum=1.0 ± 1e-9. caller 直接 PUT 给
 * /api/risk/analysis-engine-config 的 weights 字段.
 */
export function normalizeWeightsForSave(
  percents: Partial<Record<AnalyzerKey, number>> | null | undefined
): Record<AnalyzerKey, number> {
  const defaultRatios: Record<AnalyzerKey, number> = {
    fundamental: 0.25,
    technical: 0.2,
    capital: 0.15,
    sentiment: 0.1,
    news: 0.1,
    industry_regime: 0.1,
    risk: 0.05,
    event: 0.05,
  };
  if (!percents || typeof percents !== 'object') return defaultRatios;
  const cleaned: Record<AnalyzerKey, number> = {} as Record<AnalyzerKey, number>;
  let total = 0;
  for (const dim of ANALYZER_DIMENSIONS) {
    const v = (percents as any)[dim.key];
    const num = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    cleaned[dim.key] = num;
    total += num;
  }
  if (total <= 0) return defaultRatios;
  const out: Record<AnalyzerKey, number> = {} as Record<AnalyzerKey, number>;
  for (const dim of ANALYZER_DIMENSIONS) {
    out[dim.key] = cleaned[dim.key] / total;
  }
  return out;
}

/** UI 顶部显示 "当前 sum=NN%". 给 ensureAllPercents 后的 record 用. */
export function sumPercents(percents: Partial<Record<AnalyzerKey, number>>): number {
  let total = 0;
  for (const dim of ANALYZER_DIMENSIONS) {
    const v = (percents as any)[dim.key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) total += v;
  }
  return Math.round(total * 10) / 10;
}

/** UI 顶部 sum tag 颜色: [95,105] 绿 / [70, 130] 黄 / 其它 红. */
export function pickSumStatusColor(sum: number): 'success' | 'warning' | 'error' {
  if (!Number.isFinite(sum) || sum <= 0) return 'error';
  if (sum >= WEIGHT_SUM_OK_MIN_PERCENT && sum <= WEIGHT_SUM_OK_MAX_PERCENT) return 'success';
  if (sum >= 70 && sum <= 130) return 'warning';
  return 'error';
}

/**
 * 一键重置 — 返 fresh copy (不复用 frozen 常量, 让 caller 可以
 * setState(resetToDefaults()) 后继续 mutate 不踩 frozen).
 */
export function resetToDefaults(): Record<AnalyzerKey, number> {
  return { ...DEFAULT_ANALYZER_WEIGHTS_PERCENT };
}

/** 单 dim 默认值查询 — UI 显示 "默认 25%" 用 */
export function getDefaultPercent(key: AnalyzerKey): number {
  return DEFAULT_ANALYZER_WEIGHTS_PERCENT[key];
}
