/**
 * @fileoverview Satellite Slot Weight Scheme · §Q7 双态权重表 v1 计算模块
 *
 * 权威锚 (契约层数值定值 + slot 命名):
 *   docs/refactor/contracts/strategy.md v1 §Q7.1 (主态 5-slot 定值表)
 *   docs/refactor/contracts/strategy.md v1 §Q7.2 (回落态 4-slot 精算表)
 *   docs/refactor/contracts/strategy.md v1 §Q7.3 (Rounding tie-break 规则)
 *   docs/refactor/contracts/strategy.md v1 §Q7.4 (ENABLE_US_DRIVER_SIGNAL 双态切换开关)
 *
 * 权威锚 (tie-break 规则源):
 *   docs/refactor/adr/0001-layering-and-collab.md §附录 §Rounding-Tie-Break
 *
 * 承接位: Task #12 v2 融合位 · QADocs test_satellite_slot_4_slot_renormalization.test.ts hardcoded → module invocation
 *
 * 层分离原则 (§Layer-Separation):
 *   - satellite §Q7 5-slot 命名: us_driver / history_response / quality_proxy / intraday_momentum / news_evidence
 *   - core.factors §11.1 5-factor 命名: Momentum / Value / Quality / Size / LowVol
 *   - 层分离 · 命名不混淆
 *
 * 独立性红线 v1.1:
 *   - 模块目录/文件名 = 我方原创（satellite/slot-weight-scheme.ts · 非 catalyst 项目原型）
 *   - slot 名 = 我方原创 v1 §Q7 官方名（非 catalyst 5-factor 命名）
 *   - 权重定值 = 我方 v0.2 delta 起草定值 + tie-break +0.001 落 news_evidence（非 catalyst 项目魔数）
 *   - jscpd 预估 < 5% · 借鉴思想档 ✅
 */

/**
 * §Q7.1 主态 5-slot slot 名（ENABLE_US_DRIVER_SIGNAL=true）
 */
export type MainSlotName =
  | 'us_driver'
  | 'history_response'
  | 'quality_proxy'
  | 'intraday_momentum'
  | 'news_evidence';

/**
 * §Q7.2 回落态 4-slot slot 名（ENABLE_US_DRIVER_SIGNAL=false · us_driver 移除）
 */
export type FallbackSlotName =
  | 'history_response'
  | 'quality_proxy'
  | 'intraday_momentum'
  | 'news_evidence';

/**
 * §Q7.1 主态 5-slot 权重接口
 */
export interface SatelliteSlotWeights5 {
  us_driver: number;
  history_response: number;
  quality_proxy: number;
  intraday_momentum: number;
  news_evidence: number;
}

/**
 * §Q7.2 回落态 4-slot 权重接口
 */
export interface SatelliteSlotWeights4 {
  history_response: number;
  quality_proxy: number;
  intraday_momentum: number;
  news_evidence: number;
}

/**
 * §Q7.1 主态 5-slot 定值表（landed contract v1）
 *
 * 权重和 = 0.30 + 0.25 + 0.15 + 0.15 + 0.15 = 1.000
 */
export const SATELLITE_5_SLOT_MAIN_WEIGHTS: Readonly<SatelliteSlotWeights5> = Object.freeze({
  us_driver: 0.3,
  history_response: 0.25,
  quality_proxy: 0.15,
  intraday_momentum: 0.15,
  news_evidence: 0.15,
});

/**
 * §Q7.2 回落态 4-slot 精算表 + §Q7.3 tie-break 后终态定值（landed contract v1）
 *
 * 归一化前值: w_i / 0.70
 *   history_response = 0.25 / 0.70 = 0.357143...
 *   quality_proxy    = 0.15 / 0.70 = 0.214286...
 *   intraday_momentum = 0.15 / 0.70 = 0.214286...
 *   news_evidence    = 0.15 / 0.70 = 0.214286...
 *
 * 3 位小数舍入后: 0.357 + 0.214 + 0.214 + 0.214 = 0.999 → 尾差 0.001
 *
 * §Rounding-Tie-Break: +0.001 补偿位落在 news_evidence slot（证据链融合位 · 语义呼应"证据补足"）
 *
 * 终态权重和 = 0.357 + 0.214 + 0.214 + 0.215 = 1.000
 */
export const SATELLITE_4_SLOT_FALLBACK_WEIGHTS: Readonly<SatelliteSlotWeights4> = Object.freeze({
  history_response: 0.357,
  quality_proxy: 0.214,
  intraday_momentum: 0.214,
  news_evidence: 0.215,
});

/**
 * §Q7.2 主态 us_driver slot 权重占比（定值 0.30 · 用于 4-slot 归一化除数 1 - 0.30 = 0.70）
 */
export const US_DRIVER_MAIN_WEIGHT = 0.3;

/**
 * §Q7.2 归一化除数（1 - us_driver 主态权重）
 */
export const FALLBACK_RENORMALIZE_DIVISOR = 1 - US_DRIVER_MAIN_WEIGHT;

/**
 * §Q7.3 tie-break 补偿位（+0.001 落 news_evidence slot）
 */
export const TIE_BREAK_INCREMENT = 0.001;

/**
 * §Q7.2 4-slot 回落态归一化前 raw 值（未舍入 · 未 tie-break）
 *
 * 输入: 主态 5-slot 权重（含 us_driver 定值）
 * 输出: 4-slot 归一化前 raw 值 · w_i / (1 - us_driver)
 *
 * 语义: 移除 us_driver slot 后 · 剩余 4-slot 按 (1 - us_driver) 归一化
 */
export function renormalizeWeightsRaw(
  mainWeights: Readonly<SatelliteSlotWeights5>
): SatelliteSlotWeights4 {
  const divisor = 1 - mainWeights.us_driver;
  return {
    history_response: mainWeights.history_response / divisor,
    quality_proxy: mainWeights.quality_proxy / divisor,
    intraday_momentum: mainWeights.intraday_momentum / divisor,
    news_evidence: mainWeights.news_evidence / divisor,
  };
}

/**
 * §Q7.2 + §Q7.3 4-slot 回落态终态权重（3 位小数舍入 + tie-break +0.001 落 news_evidence）
 *
 * 输入: 主态 5-slot 权重
 * 输出: 4-slot 舍入+tie-break 后终态权重 · 权重和保证 = 1.000
 *
 * 实现步骤:
 *   1. renormalizeWeightsRaw 得归一化前 raw 值
 *   2. 3 位小数舍入 · 得 rounded 值
 *   3. 权重和 = 0.999 尾差 → +0.001 落 news_evidence
 */
export function renormalizeWeights(
  mainWeights: Readonly<SatelliteSlotWeights5>
): SatelliteSlotWeights4 {
  const raw = renormalizeWeightsRaw(mainWeights);
  const rounded = {
    history_response: roundTo3(raw.history_response),
    quality_proxy: roundTo3(raw.quality_proxy),
    intraday_momentum: roundTo3(raw.intraday_momentum),
    news_evidence: roundTo3(raw.news_evidence),
  };
  const sumBeforeTieBreak =
    rounded.history_response +
    rounded.quality_proxy +
    rounded.intraday_momentum +
    rounded.news_evidence;
  const tieBreakDelta = roundTo3(1 - sumBeforeTieBreak);
  return {
    history_response: rounded.history_response,
    quality_proxy: rounded.quality_proxy,
    intraday_momentum: rounded.intraday_momentum,
    news_evidence: roundTo3(rounded.news_evidence + tieBreakDelta),
  };
}

/**
 * §Q7.4 双态切换开关 · 解析 ENABLE_US_DRIVER_SIGNAL 得实际生效权重
 *
 * 输入: enableUsDriverSignal (§Q7.4 双态切换开关)
 * 输出:
 *   - true (主态): SATELLITE_5_SLOT_MAIN_WEIGHTS 5-slot 定值
 *   - false (回落态): renormalize(SATELLITE_5_SLOT_MAIN_WEIGHTS) 4-slot 精算+tie-break 定值
 *
 * 双态互斥 · 权重和统一归一化到 1.000
 */
export function resolveActiveSlotWeights(
  enableUsDriverSignal: boolean
): SatelliteSlotWeights5 | SatelliteSlotWeights4 {
  if (enableUsDriverSignal) {
    return SATELLITE_5_SLOT_MAIN_WEIGHTS;
  }
  return renormalizeWeights(SATELLITE_5_SLOT_MAIN_WEIGHTS);
}

/**
 * 3 位小数舍入辅助函数
 */
function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
