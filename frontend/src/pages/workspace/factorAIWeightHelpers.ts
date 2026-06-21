/**
 * US-046 因子 AI 权重对照 (FE-007) — 纯函数 helper, 给 FactorWorkspace 权重调参
 * tab 用. 把 GET /api/factors/overview 返的 (ic_90d, ic_ir, health_class) 三件套
 * 转成"AI 建议每个因子分配多少 %", 让操盘手 slider 旁边能看到 AI 视角的参考值
 * 并一键 Apply.
 *
 * 设计:
 *   - 评分公式: rawScore = max(0, |ic_90d|) × max(0, |ic_ir|)
 *     - 用 abs(ic_90d) 是因为短期反转类因子 ic_mean 是负数, 同样代表"信息量",
 *       MFA strategy 的 ic_weighted 模式也是按 |ic_mean| 给权 (与 backend 对齐).
 *     - 乘 |ic_ir| 是把"信息比率"作为稳定性放大器: 信号强 + 稳健才值得高权重.
 *     - max(0, ·) 防御 NaN / 负 IR 退化, 不会出现负权重.
 *   - 健康度门槛: 只有 health_class ∈ {'alpha', 'unstable'} 的因子才进入加权;
 *     'weak' (已失效) 与 'unknown' (无数据) 直接 0 权重. 这跟 FactorWorkspace
 *     UI Tag 颜色语义 (alpha=green / unstable=gold / weak=red / unknown=default)
 *     一致, 操盘手心智不分裂.
 *   - 归一化: rawScores 求和后按比例缩到 sum=100, 然后 round 到 1 位小数.
 *     舍入误差用 "最大余数法 / largest remainder" 修正, 保证 sum 精确 = 100.0
 *     ±0.05 — 这样后端 normalizeFactorWeights 不会再二次扰动用户看到的数字.
 *   - 全空场景 (所有因子都 weak/unknown 或没数据): 返回空对象 — UI 显示
 *     "AI 暂无建议 (等 FACTOR_IC_COMPUTE 跑完)", 不要 fallback 到等权,
 *     等权是"全 default" 的语义不是"AI 推荐".
 *
 * 纯函数, 不依赖 React / antd / fetch, 直接吃 FactorOverviewItem[] 返
 * Record<factor_name, weight_percent>. 单测在
 * backend/tests/services/factor-ai-weight.test.ts (因为 frontend 没 jest infra,
 * 走 ts-node --transpile-only 跑这个 .ts 文件).
 */

import type { FactorOverviewItem } from '../../services/factorService';

/** AI 推荐权重 helper 用的 health_class 集合 — 与后端 FactorHealthClass 一致 */
export type AIWeightEligibleHealth = 'alpha' | 'unstable';

/** 数值容差: 归一化后 sum=100 ±EPS */
export const AI_WEIGHT_SUM_EPS = 0.1;

/**
 * 把单个因子的 (ic_90d, ic_ir, health_class) 转成 rawScore. 返回 0 时
 * 直接被排除在归一化外, 不分配权重.
 *
 * pure, 不读全局, 可单独测.
 */
export function computeAIRawScore(item: {
  ic_90d: number | null;
  ic_ir: number | null;
  health_class: 'alpha' | 'weak' | 'unstable' | 'unknown';
}): number {
  // 健康度门槛: 只有 alpha / unstable 进入加权
  if (item.health_class !== 'alpha' && item.health_class !== 'unstable') return 0;
  const absIc = item.ic_90d !== null && Number.isFinite(item.ic_90d) ? Math.abs(item.ic_90d) : 0;
  const absIr = item.ic_ir !== null && Number.isFinite(item.ic_ir) ? Math.abs(item.ic_ir) : 0;
  // 任一为 0 即排除, 避免"|ic|=0.1 但 ir=0"这种纯噪声因子分到权重
  if (absIc <= 0 || absIr <= 0) return 0;
  return absIc * absIr;
}

/**
 * 把 rawScores 归一化到 sum=100, 保留 1 位小数 + 用最大余数法修正舍入误差.
 *
 * 输入: Record<factor_name, rawScore> (rawScore 必须 ≥ 0).
 * 输出: Record<factor_name, weight_percent> (1 位小数, sum=100.0 ± EPS).
 *
 * 边缘:
 *   - rawScores 全 0 或空: 返 {} (caller 用以判断 "AI 暂无建议").
 *   - 只有一个 factor > 0: 它独占 100.0.
 *
 * pure, 不读全局, 可单独测.
 */
export function normalizeAIWeights(rawScores: Record<string, number>): Record<string, number> {
  const names = Object.keys(rawScores).filter(n => rawScores[n] > 0 && Number.isFinite(rawScores[n]));
  if (names.length === 0) return {};
  const total = names.reduce((acc, n) => acc + rawScores[n], 0);
  if (total <= 0) return {};
  // 先按比例算未取整的精确权重 (X = rawScore / total * 100), 然后取 floor 到 0.1 精度
  // (= floor(X * 10) / 10). 余数 (X*10 - floor) 用于 largest-remainder 分配剩余 0.1.
  const scaled = names.map(n => ({
    name: n,
    exact: (rawScores[n] / total) * 100,
  }));
  // 转成 0.1 精度单元数 (×10 后 floor), 剩余加和应该是 1000 - sumFloor
  const floors = scaled.map(s => ({ name: s.name, units: Math.floor(s.exact * 10), frac: s.exact * 10 - Math.floor(s.exact * 10) }));
  const sumUnits = floors.reduce((acc, f) => acc + f.units, 0);
  // target = 1000 units (== 100.0 %); deficit > 0 时给余数最大的 N 个 +1 unit
  let deficit = 1000 - sumUnits;
  // 处理舍入溢出 (sumUnits > 1000 — 理论上不会, 但浮点防御)
  if (deficit < 0) deficit = 0;
  const sorted = [...floors].sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < deficit && i < sorted.length; i += 1) {
    sorted[i].units += 1;
  }
  // 转回原 names 顺序的 Record
  const unitsByName = new Map(floors.map(f => [f.name, f.units]));
  const result: Record<string, number> = {};
  for (const n of names) {
    const u = unitsByName.get(n) ?? 0;
    result[n] = u / 10;
  }
  return result;
}

/**
 * 顶层 helper: 从 FactorOverviewItem[] 一步算出 AI 推荐权重表.
 *
 * 串起 computeAIRawScore + normalizeAIWeights, 同时:
 *   - 只考虑入参 factors 的因子 (跟 UI 显示的因子列表一致, 不会推荐用户看不到的因子);
 *   - 输出 Record key 一定是入参 factors 里出现过的 name, caller 直接做
 *     `weights[factor.name] ?? null` 取值即可.
 *
 * 返回空对象时 caller 应在 UI 显示 "AI 暂无建议".
 */
export function computeAIWeights(factors: FactorOverviewItem[]): Record<string, number> {
  if (!Array.isArray(factors) || factors.length === 0) return {};
  const rawScores: Record<string, number> = {};
  for (const f of factors) {
    rawScores[f.name] = computeAIRawScore({
      ic_90d: f.ic_90d,
      ic_ir: f.ic_ir,
      health_class: f.health_class,
    });
  }
  return normalizeAIWeights(rawScores);
}

/**
 * 比较用户当前 weights 与 AI 建议的差距, 用于 UI 显示 "与 AI 偏差 ±N%".
 *
 * 输入: 用户权重 + AI 权重 (都是已归一化或近似归一化的 %).
 * 输出: per-factor delta = user - ai (单位 %, 可正可负).
 *
 * 仅 ai 中存在的 factor 才计算 delta — user 中独有的项忽略, 因为
 * "AI 没建议" 不构成偏差.
 */
export function computeWeightDeltas(
  userWeights: Record<string, number>,
  aiWeights: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(aiWeights)) {
    const u = Number.isFinite(userWeights[name]) ? userWeights[name] : 0;
    out[name] = Number((u - aiWeights[name]).toFixed(1));
  }
  return out;
}
