/**
 * US-058 / FE-019 「持仓 高级指标」纯函数 helper — ATR% / 当前回撤 % (DD) / 持仓天数
 * (days_held)。
 *
 * 与 backend pure helper 同款 (US-026/028/029) 也与前端兄弟 (US-042 todayPlanHelpers /
 * US-051 shadowRunHelpers / US-057 industryConcentrationKpiHelpers) 一脉相承:
 *
 *   - 纯函数, 无 React / antd 依赖 — backend ts-node 单测可直接 import 验证.
 *   - 三档分级 'normal' | 'watch' | 'high' | 'unknown', 命名与 shadowRunHelpers
 *     'healthy' / 'degraded' / 'critical' 形态对齐, 但语义针对单个持仓的风险维度.
 *   - 阈值常量全 export + Object.freeze, 单测守 sanity (high > watch).
 *   - 缺数据返 'unknown' 而非默认绿/红, 让 UI 渲染 '—' 不误导.
 *
 * 决策表 (与 backend 风控守卫 PerStockStopLossGuard / TrailingStopGuard 同源,
 * 数字阈值可在常量调一处生效, 不依赖 schema-sync):
 *
 *   ATR%   (波动率): ≥ ATR_HIGH_PCT (=8) 极高 / ≥ ATR_WATCH_PCT (=5) 警戒 / < 5 正常
 *   DD%    (当前回撤 = (highest - current) / highest * 100):
 *          ≥ DD_HIGH_PCT (=15) 深度回撤 / ≥ DD_WATCH_PCT (=8) 警戒 / < 8 健康
 *   days_held (持仓天数): < DAYS_HELD_FRESH (=7) 新仓 / ≤ DAYS_HELD_LONG (=180)
 *          正常 / > 180 长期 (不一定是坏事但 UI 灰显提示用户复盘)
 *
 * 与 US-044 SellSuggestionCard 联动: 高 ATR% + 深 DD% 是触发 high-priority "应卖"
 * 的关键输入; UI 列里看红色直接对应 SellSuggestionCard 应该出红卡, 用户对齐两个
 * 卡片认知零成本 (与 US-057 industry KPI / 卖出卡同色思想).
 */

// ===== 阈值常量 (与 backend guard 对齐, 可一处调参) ============================

/** ATR% ≥ 8 视为"极高波动", UI 红色 — 与 DonchianTrendStrategy 拒入门槛 (>8) 对齐. */
export const ATR_HIGH_PCT = 8;

/** ATR% ≥ 5 视为"警戒", UI 橙色 — 触发用户考虑减仓 / 收紧止损. */
export const ATR_WATCH_PCT = 5;

/** 当前回撤 % ≥ 15 视为"深度回撤", UI 红色 — 接近多数策略的 max_dd 阈值. */
export const DD_HIGH_PCT = 15;

/** 当前回撤 % ≥ 8 视为"警戒", UI 橙色 — 与 TrailingStopGuard 默认 10% 接近. */
export const DD_WATCH_PCT = 8;

/** 持仓天数 < 7 视为"新仓", UI 蓝色 — 提醒用户不要轻易加仓 / 给策略时间. */
export const DAYS_HELD_FRESH = 7;

/** 持仓天数 > 180 视为"长期持仓", UI 灰色 — 提示用户复盘是否还符合策略. */
export const DAYS_HELD_LONG = 180;

// ===== 公开类型 =================================================================

/** ATR / DD 三档健康度. */
export type PositionRiskLevel = 'normal' | 'watch' | 'high' | 'unknown';

/** 持仓天数三档. */
export type DaysHeldLevel = 'fresh' | 'normal' | 'long' | 'unknown';

/**
 * Helper 主输入 — 与 PositionRow (frontend/src/services/portfolioWorkspaceService.ts)
 * 字段对齐, 但全 optional 让 caller 不必每次填全 (e.g. 历史快照行无 highest_price
 * 时只能算 days_held / atr_pct).
 */
export interface PositionMetricsInput {
  current_price?: number | null;
  highest_price?: number | null;
  /** 后端 ATR(14) 算好的当日波动率, % 单位 (e.g. 6.5 = 6.5%). */
  atr_pct?: number | null;
  /** ISO 字符串 e.g. '2026-06-10T03:00:00.000Z'. */
  created_at?: string | null;
}

// ===== 颜色 / 标签表 (frozen, UI 直接消费) =====================================

/** Ant Design Tag color — 与 industry concentration KPI / sell suggestion 同色谱. */
export const POSITION_RISK_LEVEL_COLOR: Readonly<Record<PositionRiskLevel, string>> = Object.freeze(
  {
    normal: 'green',
    watch: 'orange',
    high: 'red',
    unknown: 'default',
  }
);

export const POSITION_RISK_LEVEL_LABEL: Readonly<Record<PositionRiskLevel, string>> = Object.freeze(
  {
    normal: '正常',
    watch: '警戒',
    high: '极高',
    unknown: '—',
  }
);

export const DAYS_HELD_LEVEL_COLOR: Readonly<Record<DaysHeldLevel, string>> = Object.freeze({
  fresh: 'blue',
  normal: 'default',
  long: 'default',
  unknown: 'default',
});

export const DAYS_HELD_LEVEL_LABEL: Readonly<Record<DaysHeldLevel, string>> = Object.freeze({
  fresh: '新仓',
  normal: '',
  long: '长期',
  unknown: '—',
});

// ===== 计算函数 =================================================================

/**
 * 计算持仓天数 (自然日, 不扣周末 / 节假日).  null / 非法日期 → null.
 *
 * 用 Date.UTC 对齐到日级别避免时区毛刺 (US-055 dailyAttribution 相同思想).
 * Today 由 caller 传入 (默认 new Date()), 让单测可固定边界.
 */
export function computeDaysHeld(
  createdAt: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  const diffMs = now.getTime() - t;
  if (diffMs < 0) return 0; // 防止时钟漂移返负数
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return days;
}

/**
 * 计算当前回撤 % = (highest_price - current_price) / highest_price * 100.
 *
 * 缺 highest_price 或 ≤ 0 → null (highest_price 由 TrailingStopGuard 每日收盘后
 * 写, 新仓首日可能为 null).  current_price ≤ 0 → null (脏数据兜底).
 * 当 current >= highest 时返 0 (浮盈中, 无回撤).
 */
export function computeDrawdownPct(
  currentPrice: number | null | undefined,
  highestPrice: number | null | undefined
): number | null {
  if (highestPrice === null || highestPrice === undefined) return null;
  if (currentPrice === null || currentPrice === undefined) return null;
  const high = Number(highestPrice);
  const cur = Number(currentPrice);
  if (!Number.isFinite(high) || high <= 0) return null;
  if (!Number.isFinite(cur) || cur <= 0) return null;
  const dd = ((high - cur) / high) * 100;
  if (dd < 0) return 0;
  return dd;
}

/** ATR% 三档分级.  null/NaN → 'unknown'. */
export function classifyAtrLevel(atrPct: number | null | undefined): PositionRiskLevel {
  if (atrPct === null || atrPct === undefined) return 'unknown';
  const v = Number(atrPct);
  if (!Number.isFinite(v) || v < 0) return 'unknown';
  if (v >= ATR_HIGH_PCT) return 'high';
  if (v >= ATR_WATCH_PCT) return 'watch';
  return 'normal';
}

/** DD% 三档分级.  null/NaN → 'unknown'. */
export function classifyDrawdownLevel(ddPct: number | null | undefined): PositionRiskLevel {
  if (ddPct === null || ddPct === undefined) return 'unknown';
  const v = Number(ddPct);
  if (!Number.isFinite(v) || v < 0) return 'unknown';
  if (v >= DD_HIGH_PCT) return 'high';
  if (v >= DD_WATCH_PCT) return 'watch';
  return 'normal';
}

/** 持仓天数三档.  null → 'unknown'. */
export function classifyDaysHeldLevel(days: number | null | undefined): DaysHeldLevel {
  if (days === null || days === undefined) return 'unknown';
  const v = Number(days);
  if (!Number.isFinite(v) || v < 0) return 'unknown';
  if (v < DAYS_HELD_FRESH) return 'fresh';
  if (v > DAYS_HELD_LONG) return 'long';
  return 'normal';
}

// ===== 组合 view-model — 给 UI 一次拿全 =======================================

export interface PositionMetricsViewModel {
  atrPct: number | null;
  atrLevel: PositionRiskLevel;
  ddPct: number | null;
  ddLevel: PositionRiskLevel;
  daysHeld: number | null;
  daysHeldLevel: DaysHeldLevel;
}

/**
 * 一次性把 ATR / DD / days_held 三维度算齐, UI 调一次拿一个对象, 不需要在
 * cell render 里调 3 次 helper.  与 buildShadowRunViewModel / buildIndustryKpiViewModel
 * 同款 "view-model 模式" — pure function, 同输入永远同输出 → useMemo 安全.
 */
export function buildPositionMetricsViewModel(
  input: PositionMetricsInput,
  now: Date = new Date()
): PositionMetricsViewModel {
  const atrPct =
    input.atr_pct === null || input.atr_pct === undefined ? null : Number(input.atr_pct);
  const ddPct = computeDrawdownPct(input.current_price ?? null, input.highest_price ?? null);
  const daysHeld = computeDaysHeld(input.created_at ?? null, now);
  return {
    atrPct: atrPct !== null && Number.isFinite(atrPct) ? atrPct : null,
    atrLevel: classifyAtrLevel(atrPct),
    ddPct,
    ddLevel: classifyDrawdownLevel(ddPct),
    daysHeld,
    daysHeldLevel: classifyDaysHeldLevel(daysHeld),
  };
}

// ===== UI formatter ============================================================

/** "6.50%" / "—". 1 位小数与既有 PortfolioWorkspace pnl pct 风格一致 (2 位略冗余, 1 位够). */
export function formatPctOrDash(v: number | null | undefined, precision = 2): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(precision)}%`;
}

/** "12 天" / "—".  长期持仓 (> 180) 加 (长期) 后缀. */
export function formatDaysHeld(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n > DAYS_HELD_LONG) return `${n} 天 (长期)`;
  return `${n} 天`;
}
