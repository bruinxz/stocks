/**
 * Bootstrap Confidence Intervals for PBO / DSR
 *
 * 论文 reference:
 *   Efron, B. (1987). "Better Bootstrap Confidence Intervals."
 *   Journal of the American Statistical Association 82(397), 171-185.
 *   BCa method (bias-corrected and accelerated).
 *
 *   配合 De Prado AFML Ch.11 — DSR / PBO 的置信区间
 *
 * **核心问题**:
 *
 *   DSR / PBO 都是 single point estimate。100 个回测出来 PBO=0.4 比
 *   100 个回测出来 PBO=0.4 (但 90% CI = [0.05, 0.75]) 完全不同。
 *
 *   后者大概率是 noise，前者才有 signal.
 *
 * **BCa bootstrap (Efron 1987)**:
 *
 *   1. Resample B 次原样本 (with replacement) → B 个 θ̂_b
 *   2. 普通 percentile 区间: [θ̂_(α/2), θ̂_(1-α/2)]
 *   3. **Bias correction** z_0: 估真值偏离 sample median
 *        z_0 = Φ^-1( #{θ̂_b < θ̂} / B )
 *   4. **Acceleration** a: jackknife 估 skewness
 *        a = Σ (θ̄_(.) - θ̂_(-i))³ / (6 · [Σ (θ̄_(.) - θ̂_(-i))²]^{3/2})
 *   5. 调整后 percentile:
 *        α_1 = Φ(z_0 + (z_0 + z_{α/2}) / (1 - a·(z_0 + z_{α/2})))
 *        α_2 = Φ(z_0 + (z_0 + z_{1-α/2}) / (1 - a·(z_0 + z_{1-α/2})))
 *   6. CI = [θ̂_(α_1), θ̂_(α_2)]
 *
 * **简化版本**:
 *   完整 BCa 复杂. 这里实现 2 个简化:
 *     a) `percentileBootstrap`: 纯 percentile (Efron 1981, basic version)
 *     b) `basicBootstrap`: pivotal interval (避免 percentile 偏)
 *
 *   两者都比单一 point estimate 强很多。完整 BCa 留给未来 v4.
 */

import { standardNormalCdf, standardNormalInverseCdf } from '../../quant/backtest/OverfitMetrics';

/**
 * Seeded random for reproducibility (Park-Miller LCG)
 */
export class BootstrapRng {
  private state: number;
  constructor(seed = 42) {
    this.state = seed % 2147483647;
    if (this.state <= 0) this.state += 2147483646;
  }
  next(): number {
    this.state = (this.state * 16807) % 2147483647;
    return this.state / 2147483647;
  }
  randInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

/**
 * Sample with replacement from array
 */
export function bootstrapResample<T>(samples: T[], rng: BootstrapRng): T[] {
  const N = samples.length;
  const out: T[] = new Array(N);
  for (let i = 0; i < N; i += 1) {
    out[i] = samples[rng.randInt(N)];
  }
  return out;
}

/**
 * Compute percentile of an array
 */
export function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - rank) + sorted[upper] * (rank - lower);
}

/**
 * Simple percentile bootstrap CI
 *
 * 算法:
 *   1. Resample original sample B 次
 *   2. 对每个 resample 算 statistic
 *   3. 返回 [α/2 percentile, 1-α/2 percentile]
 *
 * 优点: 简单, 不假设分布
 * 缺点: 对 skewed 数据有 bias (用 BCa 修正)
 *
 * @param samples 原 sample
 * @param statistic 算 statistic 的函数 (e.g. mean, median, PBO)
 * @param options.B 重采样次数 (default 1000)
 * @param options.alpha CI 显著水平 (default 0.05 → 95% CI)
 * @param options.seed RNG seed
 */
export function percentileBootstrap<T>(
  samples: T[],
  statistic: (sample: T[]) => number,
  options: { B?: number; alpha?: number; seed?: number } = {}
): { estimate: number; lower: number; upper: number; replicates: number[] } {
  const B = options.B ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const rng = new BootstrapRng(options.seed ?? 42);

  const original_estimate = statistic(samples);
  const replicates: number[] = [];
  for (let b = 0; b < B; b += 1) {
    const resample = bootstrapResample(samples, rng);
    const stat = statistic(resample);
    if (Number.isFinite(stat)) replicates.push(stat);
  }

  if (replicates.length === 0) {
    return { estimate: original_estimate, lower: NaN, upper: NaN, replicates: [] };
  }

  const lower = computePercentile(replicates, (alpha / 2) * 100);
  const upper = computePercentile(replicates, (1 - alpha / 2) * 100);

  return { estimate: original_estimate, lower, upper, replicates };
}

/**
 * Basic bootstrap (pivotal) CI
 *
 *   lower = 2 · θ̂ - upper_percentile
 *   upper = 2 · θ̂ - lower_percentile
 *
 * 解决 percentile bootstrap 在 skewed 分布的 bias.
 */
export function basicBootstrap<T>(
  samples: T[],
  statistic: (sample: T[]) => number,
  options: { B?: number; alpha?: number; seed?: number } = {}
): { estimate: number; lower: number; upper: number; replicates: number[] } {
  const p = percentileBootstrap(samples, statistic, options);
  return {
    estimate: p.estimate,
    lower: 2 * p.estimate - p.upper,
    upper: 2 * p.estimate - p.lower,
    replicates: p.replicates,
  };
}

/**
 * BCa bootstrap (Bias-corrected and accelerated; Efron 1987)
 *
 * 全完整版.
 *
 * @returns CI + bias correction z_0 + acceleration a (用于诊断)
 */
export function bcaBootstrap<T>(
  samples: T[],
  statistic: (sample: T[]) => number,
  options: { B?: number; alpha?: number; seed?: number } = {}
): {
  estimate: number;
  lower: number;
  upper: number;
  z0: number;
  acceleration: number;
  replicates: number[];
} {
  const B = options.B ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const rng = new BootstrapRng(options.seed ?? 42);

  const original = statistic(samples);
  const replicates: number[] = [];
  for (let b = 0; b < B; b += 1) {
    const resample = bootstrapResample(samples, rng);
    const stat = statistic(resample);
    if (Number.isFinite(stat)) replicates.push(stat);
  }

  if (replicates.length < 2) {
    return {
      estimate: original,
      lower: NaN,
      upper: NaN,
      z0: 0,
      acceleration: 0,
      replicates: [],
    };
  }

  // Bias correction z_0
  const belowEst = replicates.filter(r => r < original).length;
  const fraction = belowEst / replicates.length;
  // clamp 防 inverse cdf 爆掉
  const fClamped = Math.max(1e-6, Math.min(1 - 1e-6, fraction));
  const z0 = standardNormalInverseCdf(fClamped);

  // Acceleration via jackknife
  const N = samples.length;
  const jack: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const leaveOut = [...samples.slice(0, i), ...samples.slice(i + 1)];
    const stat = statistic(leaveOut);
    if (Number.isFinite(stat)) jack.push(stat);
  }
  const jackMean = jack.reduce((s, v) => s + v, 0) / jack.length;
  let num = 0;
  let den = 0;
  for (const j of jack) {
    const diff = jackMean - j;
    num += diff ** 3;
    den += diff ** 2;
  }
  const a = den === 0 ? 0 : num / (6 * Math.pow(den, 1.5));

  // Adjusted percentiles
  const zAlphaHalf = standardNormalInverseCdf(alpha / 2);
  const zOneMinusAlphaHalf = standardNormalInverseCdf(1 - alpha / 2);

  const adjustZ = (z: number): number =>
    z0 + (z0 + z) / (1 - a * (z0 + z));

  const alpha1 = standardNormalCdf(adjustZ(zAlphaHalf));
  const alpha2 = standardNormalCdf(adjustZ(zOneMinusAlphaHalf));

  const lower = computePercentile(replicates, Math.max(0, Math.min(100, alpha1 * 100)));
  const upper = computePercentile(replicates, Math.max(0, Math.min(100, alpha2 * 100)));

  return {
    estimate: original,
    lower,
    upper,
    z0,
    acceleration: a,
    replicates,
  };
}
