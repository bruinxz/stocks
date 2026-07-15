/**
 * SignalDrivenSizing — CB-2 (2026/06/25)
 *
 * 让 sizing 按 signal.confidence_score 派生 target_pct, 而不是默认拍 1 手 (~900 元).
 * 之前现状 (prod): 20 个模拟盘各 20W 初始, 真实持仓只 1-3% (~3000-6000 元),
 * 即 "策略根本没开干"; 同质化 + 仓位低 = 收益曲线扁平.
 *
 * 用户决策: 仓位"应按策略, 该冲就冲" — 让 sizing 听信号强度. 4 档:
 *
 *   confidence ≥ 0.8 → 8%   (该冲就冲)
 *   confidence ≥ 0.6 → 5%
 *   confidence ≥ 0.4 → 3%
 *   confidence < 0.4 → 1.5% (低信心也少买点试水)
 *
 * 兜底最低单笔 = MAX(target_pct × total_value, 5000 元) — 避免摩擦 (摩擦 0.2%
 * 是可接受上限). 上限受 user.risk_config.max_position_pct (默认 15%) 限制.
 *
 * 设计原则:
 *   1. **纯函数**: deriveTargetPctFromConfidence(confidence, options) 不读 DB
 *      不接外部 service, 完全单测脱离 DB.
 *   2. **confidence 输入 0-1 (小数) 或 0-100 (百分比) 双兼容**: signal.confidence_score
 *      历史上有时存 0-1 有时存 0-100 (multi-factor strategies 用 0-100, 等). 函数
 *      自动归一: 输入 > 1 视为百分比, 除 100.
 *   3. **target_pct 是百分比** (跟现有 effectiveTargetPct 同款单位 — automation 已
 *      用 `(totalValue * effectiveTargetPct) / 100` 算 targetAmount).
 *   4. **min trade amount 与 target 解耦**: deriveTargetPctFromConfidence 只算 pct,
 *      computeMinTradeAmount 算"按 pct 算 amount 再 max(5000) 上抬". caller 决定要不要
 *      把 amount 抬高后反推 pct.
 *   5. **NOT 替换 PositionSizingPolicy**: 现有 PositionSizingPolicy (equal_pct/vol_target/
 *      atr_based/kelly) 保留, 本模块是新的 default 行为. caller 选 method='signal_driven'
 *      时走本模块. 用户 / strategy override 仍优先.
 *
 * 边界 / 兜底:
 *   - confidence < 0 / NaN / null → 视为 0 (落到 < 0.4 档, target_pct = 1.5%)
 *   - confidence > 1 假定百分制, 除 100 后再判档
 *   - max_pct cap 永远生效 (用户 risk_config 兜底 15%)
 *
 * **不动 hardcutover (PositionSizingPolicy.hard_cutover_enabled)**: 那是另一套
 * "用户在 SettingsWorkspace 配 method=kelly 跑 shadow → 切 hard" 的渐进式开关.
 * 本模块是 confidence-driven 的全新 default, 用户没开 hard_cutover 时直接生效.
 */

/** 默认最低单笔 5000 元 (摩擦 ≤ 0.2%). 用户 / strategy 可显式 override. */
export const CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT = 5000;

/** 默认 user.risk_config.max_position_pct fallback (与 SizingPolicy 默认同款 12 接近, CB-2 用户决策 15). */
export const CONFIDENCE_DRIVEN_DEFAULT_MAX_PCT = 15;

/** 4 档默认 target_pct (signal.confidence_score 输入归一为 0-1 后判档). */
export const CONFIDENCE_TIER_DEFAULTS = Object.freeze({
  tier_strong: { threshold: 0.8, target_pct: 8 },
  tier_high: { threshold: 0.6, target_pct: 5 },
  tier_medium: { threshold: 0.4, target_pct: 3 },
  tier_low: { threshold: 0, target_pct: 1.5 },
});

export interface SignalDrivenSizingOptions {
  /** 单股最大仓位百分比 cap (e.g. 15 = 15%). 缺省 15. */
  max_position_pct?: number;
  /** 4 档 target_pct override; 部分 override 时用 partial-merge. */
  tier_overrides?: Partial<{
    tier_strong: number;
    tier_high: number;
    tier_medium: number;
    tier_low: number;
  }>;
}

export interface SignalDrivenSizingResult {
  /** 决策后的 target_pct (百分比, 例如 8 = 8%) — 已应用 max_pct cap */
  target_pct: number;
  /** 归一后的 confidence (0-1) */
  normalized_confidence: number;
  /** 触发哪一档 */
  tier: 'tier_strong' | 'tier_high' | 'tier_medium' | 'tier_low';
  /** 是否触发 max_position_pct cap */
  capped_by_max: boolean;
  /** 决策原因 (人类可读) */
  reason: string;
}

/** 把 confidence 输入归一到 0-1; 兼容 0-1 小数 / 0-100 百分比. */
export function normalizeConfidence(input: any): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return 0;
  // 视为百分比 (multi-factor 等历史用 0-100)
  if (n > 1) return Math.min(1, n / 100);
  return Math.min(1, n);
}

/**
 * 按 confidence 派生 target_pct (百分比).
 *
 * @param confidence 信号置信度 (0-1 或 0-100, 自动归一)
 * @param options    max_pct cap / tier_overrides
 */
export function deriveTargetPctFromConfidence(
  confidence: any,
  options: SignalDrivenSizingOptions = {}
): SignalDrivenSizingResult {
  const norm = normalizeConfidence(confidence);
  const maxPct = (() => {
    const n = Number(options.max_position_pct);
    if (!Number.isFinite(n) || n <= 0) return CONFIDENCE_DRIVEN_DEFAULT_MAX_PCT;
    return Math.min(50, n);
  })();
  const overrides = options.tier_overrides || {};
  const tiers = {
    tier_strong: overrides.tier_strong ?? CONFIDENCE_TIER_DEFAULTS.tier_strong.target_pct,
    tier_high: overrides.tier_high ?? CONFIDENCE_TIER_DEFAULTS.tier_high.target_pct,
    tier_medium: overrides.tier_medium ?? CONFIDENCE_TIER_DEFAULTS.tier_medium.target_pct,
    tier_low: overrides.tier_low ?? CONFIDENCE_TIER_DEFAULTS.tier_low.target_pct,
  };

  let tier: SignalDrivenSizingResult['tier'];
  let rawPct: number;
  if (norm >= CONFIDENCE_TIER_DEFAULTS.tier_strong.threshold) {
    tier = 'tier_strong';
    rawPct = tiers.tier_strong;
  } else if (norm >= CONFIDENCE_TIER_DEFAULTS.tier_high.threshold) {
    tier = 'tier_high';
    rawPct = tiers.tier_high;
  } else if (norm >= CONFIDENCE_TIER_DEFAULTS.tier_medium.threshold) {
    tier = 'tier_medium';
    rawPct = tiers.tier_medium;
  } else {
    tier = 'tier_low';
    rawPct = tiers.tier_low;
  }

  const capped_by_max = rawPct > maxPct;
  const target_pct = Math.min(rawPct, maxPct);
  const reason =
    `confidence=${(norm * 100).toFixed(0)}% → ${tier} (raw ${rawPct}%)` +
    (capped_by_max ? ` | capped at max ${maxPct}%` : '');

  return {
    target_pct,
    normalized_confidence: norm,
    tier,
    capped_by_max,
    reason,
  };
}

/**
 * 算 "按 target_pct 算 amount, 再 max(5000) 上抬" 后的最终最低交易金额.
 *
 * @param target_pct  pct 决策 (百分比, 例如 8 = 8%)
 * @param total_value 账户总市值
 * @param min_trade_amount  caller 可 override 默认 5000
 * @returns           最终下单金额 (元)
 */
export function computeMinTradeAmount(
  target_pct: number,
  total_value: number,
  min_trade_amount: number = CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT
): number {
  const pct = Number(target_pct);
  const total = Number(total_value);
  const floor = Number(min_trade_amount);
  if (!Number.isFinite(pct) || !Number.isFinite(total) || total <= 0) return 0;
  const raw = (total * pct) / 100;
  const minimum =
    Number.isFinite(floor) && floor > 0 ? floor : CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT;
  return Math.max(raw, minimum);
}

/**
 * 防止最低单笔 floor 把 target_amount 推到 max_position_pct 之上.
 * 当 floor amount > max_pct × total_value 时, 该信号"太穷买不起", 返 null 让 caller skip.
 *
 * @returns 修正后的 final_amount (元), 或 null (skip)
 */
export function applyMaxPctCapToAmount(
  amount: number,
  total_value: number,
  max_position_pct: number
): number | null {
  const total = Number(total_value);
  const maxPct = Number(max_position_pct);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(maxPct) || maxPct <= 0) return amount;
  const cap = (total * maxPct) / 100;
  if (amount > cap) {
    // amount 触顶, fall back 到 cap (用 cap 代替 floor 5000); 但如果 cap < min_trade 也 skip
    return cap;
  }
  return amount;
}
