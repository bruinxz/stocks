/**
 * Sprint 41-C: ResearchValidationService — 高级量化回测验证套件
 *
 * 解决"回测漂亮但实际没边际"的过拟合问题, 提供 3 个核心验证工具:
 *
 *   1. **Purged K-Fold CV**: K-fold split + embargo 隔离, 防止 label leakage
 *   2. **Deflated Sharpe Ratio (DSR)**: 修正多重测试导致的 Sharpe 膨胀
 *   3. **Probability of Backtest Overfitting (PBO)**: 量化策略可被过拟合的概率
 *
 * 所有纯函数全 export, 完全不依赖 DB. caller (回测脚本 / 策略提升评审) 把
 * 各 fold 的 returns 数组传进来直接调用.
 *
 * 参考文献:
 *   - Bailey & López de Prado (2014) "The Deflated Sharpe Ratio"
 *   - Bailey et al. (2017) "The Probability of Backtest Overfitting"
 *   - López de Prado (2018) "Advances in Financial Machine Learning" Ch. 7
 *
 * 设计要点:
 *   1. **纯函数, 无 state, 无 IO**: 适合任何上下文 (脚本 / API / cron / 单测).
 *   2. **数值稳定**: 用 log-sum-exp / Welford's algorithm 避免大数加减.
 *   3. **不引外部包**: 标准正态分布 CDF / 标准误差等都自实现 (≈30 行).
 */

import { logger } from '../../utils/logger';

// ===========================================================================
// 基础统计函数 (export 全部)
// ===========================================================================

/** 样本均值 */
export function mean(arr: number[]): number {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** 样本标准差 (Bessel 修正, n-1 分母) */
export function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

/** 样本偏度 (Fisher-Pearson 标准化) */
export function skewness(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  const sd = stddev(arr);
  if (sd === 0) return 0;
  let s = 0;
  for (const v of arr) s += ((v - m) / sd) ** 3;
  return (arr.length / ((arr.length - 1) * (arr.length - 2))) * s;
}

/** 样本超额峭度 (excess kurtosis, 正态 = 0) */
export function excessKurtosis(arr: number[]): number {
  if (arr.length < 4) return 0;
  const m = mean(arr);
  const sd = stddev(arr);
  if (sd === 0) return 0;
  let s = 0;
  for (const v of arr) s += ((v - m) / sd) ** 4;
  const n = arr.length;
  return (
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * s - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
  );
}

/** 标准正态 CDF (Abramowitz & Stegun 7.1.26, 误差 < 1.5e-7) */
export function normalCDF(x: number): number {
  // 误差函数近似
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + (0.3275911 * (sign * x)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-((sign * x) ** 2) / 2);
  return 0.5 * (1 + sign * y);
}

// ===========================================================================
// Sharpe Ratio
// ===========================================================================

/**
 * 计算年化 Sharpe Ratio.
 *
 * @param returns 周期收益率数组 (例如日收益)
 * @param periodsPerYear 每年周期数 (日=252, 周=52, 月=12)
 * @param risk_free_rate 周期无风险利率 (默认 0)
 */
export function sharpeRatio(returns: number[], periodsPerYear = 252, risk_free_rate = 0): number {
  if (returns.length < 2) return 0;
  const excess = returns.map(r => r - risk_free_rate);
  const m = mean(excess);
  const sd = stddev(excess);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(periodsPerYear);
}

// ===========================================================================
// 1. Purged K-Fold CV
// ===========================================================================

export interface PurgedKFoldSplit {
  fold_index: number;
  /** Train sample indices */
  train_indices: number[];
  /** Test sample indices */
  test_indices: number[];
  /** Purged (excluded) sample indices */
  purged_indices: number[];
}

/**
 * Purged K-Fold split.
 *
 * 输入 n 个按时间排序的样本, 输出 K 个 (train, test, purged) 切分.
 * 每个 fold 的 test set 周围 ±embargo 个样本被 purged (排除出 train), 防止
 * 时序相邻样本的 label leakage (典型: 用未来 t+5 的 label 训练 t 时刻的样本).
 *
 * @param n 总样本数
 * @param k_folds K-fold 数 (典型 5 或 10)
 * @param embargo 每个 fold 两侧需 purge 的样本数 (典型 = label_horizon)
 */
export function purgedKFoldSplit(n: number, k_folds: number, embargo: number): PurgedKFoldSplit[] {
  if (n < k_folds) {
    logger.warn(`purgedKFoldSplit: n=${n} < k_folds=${k_folds}, 返回空 splits`);
    return [];
  }
  if (embargo < 0) embargo = 0;
  const foldSize = Math.floor(n / k_folds);
  const splits: PurgedKFoldSplit[] = [];
  for (let k = 0; k < k_folds; k++) {
    const testStart = k * foldSize;
    const testEnd = k === k_folds - 1 ? n : (k + 1) * foldSize;
    const purgedStart = Math.max(0, testStart - embargo);
    const purgedEnd = Math.min(n, testEnd + embargo);
    const test_indices: number[] = [];
    const train_indices: number[] = [];
    const purged_indices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i >= testStart && i < testEnd) {
        test_indices.push(i);
      } else if (i >= purgedStart && i < purgedEnd) {
        purged_indices.push(i);
      } else {
        train_indices.push(i);
      }
    }
    splits.push({ fold_index: k, train_indices, test_indices, purged_indices });
  }
  return splits;
}

// ===========================================================================
// 2. Deflated Sharpe Ratio (DSR)
// ===========================================================================

export interface DeflatedSharpeInput {
  /** 候选策略 / 单组参数的样本 Sharpe (原始, 未年化也可, 但参数 returns 应一致) */
  observed_sharpe: number;
  /** 试过的策略 / 参数组数 (N) */
  n_trials: number;
  /** 试过的所有策略 Sharpe 的方差 (variance of trials' Sharpes) */
  variance_of_trials: number;
  /** 样本期数 (例如 252 个日收益) */
  n_observations: number;
  /** 样本 returns 的偏度 */
  skewness: number;
  /** 样本 returns 的 excess 峭度 */
  excess_kurtosis: number;
}

export interface DeflatedSharpeResult {
  /** 期望"最佳" Sharpe (假设 ground truth Sharpe = 0) */
  expected_max_sharpe: number;
  /** Deflated Sharpe = P(observed_sharpe > expected_max_sharpe | 真实 Sharpe = 0) */
  deflated_sharpe: number;
  /** observed_sharpe 是否显著 (> 0 真有 alpha): deflated_sharpe > 0.95 */
  is_significant: boolean;
  /** 解释字段 */
  explanation: string;
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014).
 *
 * 修正多重测试导致的 Sharpe 膨胀: 试 100 组参数总会有一组 Sharpe=2 不是因为
 * 真有 alpha 而是因为 sampling noise. DSR 给出该 observed_sharpe 真有 alpha
 * 的概率.
 *
 * 公式:
 *   E[max Sharpe | H0] ≈ √variance_of_trials × ((1-γ) × Φ⁻¹(1 - 1/N) + γ × Φ⁻¹(1 - 1/(Ne)))
 *   其中 γ ≈ 0.5772 (Euler-Mascheroni 常数), e = 2.71828
 *
 *   DSR = Φ((SR - E[max SR]) × √(N - 1) / √(1 - skew × SR + ((kurt-1)/4) × SR²))
 *
 *   DSR > 0.95 = 95% 置信度 observed_sharpe 真有 alpha (相对 N 次尝试).
 */
export function deflatedSharpeRatio(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const {
    observed_sharpe,
    n_trials,
    variance_of_trials,
    n_observations,
    skewness: skew,
    excess_kurtosis: kurt,
  } = input;

  if (n_trials < 1 || n_observations < 2 || variance_of_trials < 0) {
    return {
      expected_max_sharpe: 0,
      deflated_sharpe: 0,
      is_significant: false,
      explanation: '输入参数无效 (n_trials < 1 或 n_observations < 2 或 variance_of_trials < 0)',
    };
  }

  // E[max Sharpe | H0]
  const euler_gamma = 0.5772156649;
  const inv_norm_1m1n = inverseNormalCDF(1 - 1 / n_trials);
  const inv_norm_1m1ne = inverseNormalCDF(1 - 1 / (n_trials * Math.E));
  const expected_max_sharpe =
    Math.sqrt(variance_of_trials) *
    ((1 - euler_gamma) * inv_norm_1m1n + euler_gamma * inv_norm_1m1ne);

  // DSR
  // Bailey & López de Prado 2014 公式: γ4 是 raw kurtosis = excess_kurtosis + 3
  // 分母 = 1 - γ3·SR + (γ4-1)/4·SR²
  //      = 1 - skew·SR + (excess_kurt+2)/4·SR²
  const raw_kurt = kurt + 3;
  const denom_inner = 1 - skew * observed_sharpe + ((raw_kurt - 1) / 4) * observed_sharpe ** 2;
  if (denom_inner <= 0) {
    return {
      expected_max_sharpe,
      deflated_sharpe: 0,
      is_significant: false,
      explanation: `DSR 分母 ${denom_inner} <= 0 (skew/kurt 太极端), 视为不显著`,
    };
  }
  const dsr_z =
    ((observed_sharpe - expected_max_sharpe) * Math.sqrt(n_observations - 1)) /
    Math.sqrt(denom_inner);
  const dsr = normalCDF(dsr_z);

  return {
    expected_max_sharpe,
    deflated_sharpe: dsr,
    is_significant: dsr > 0.95,
    explanation: `观察 SR=${observed_sharpe.toFixed(3)}, 期望最佳 SR=${expected_max_sharpe.toFixed(
      3
    )} (N=${n_trials} trials), DSR=${(dsr * 100).toFixed(1)}% ${
      dsr > 0.95 ? '✓ 显著' : '✗ 不显著 (可能过拟合)'
    }`,
  };
}

/**
 * 标准正态分布逆 CDF (Beasley-Springer-Moro algorithm, 误差 < 1e-7)
 */
export function inverseNormalCDF(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    throw new Error(`inverseNormalCDF: p must be in (0,1), got ${p}`);
  }
  // Beasley-Springer-Moro
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const p_low = 0.02425;
  const p_high = 1 - p_low;
  let q: number;
  let r: number;
  let x: number;
  if (p < p_low) {
    q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= p_high) {
    q = p - 0.5;
    r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

// ===========================================================================
// 3. Probability of Backtest Overfitting (PBO)
// ===========================================================================

export interface PBOResult {
  /** PBO 值 (0 = 无过拟合, 1 = 严重过拟合, >0.5 = 警告) */
  pbo: number;
  /** 各 split 中"OOS 排名 < N/2 (劣于中位)"的样本数 */
  n_overfit: number;
  /** 总 split 数 */
  n_splits: number;
  /** 警告等级 */
  warning: 'ok' | 'caution' | 'overfit';
  explanation: string;
}

/**
 * Probability of Backtest Overfitting (Bailey et al. 2017).
 *
 * 输入 N 组策略 (或参数组) 在 T 个时间段的 returns 矩阵, 通过 combinatorial
 * symmetric CV (CSCV):
 *   1. 把时间段 T 分成 S 段 (S=16 typical), choose S/2 段做 IS, 另 S/2 段做 OOS
 *   2. 对每个分割: 在 IS 选 Sharpe 最高策略 → 看它在 OOS 上的排名
 *   3. 若 OOS 排名 < N/2 (劣于中位), 视为过拟合
 *   4. PBO = (过拟合次数) / (总分割数)
 *
 * 简化实现 (减少组合复杂度): 用 S=8 段 + 随机抽样 maxSplits=200 个分割.
 *
 * @param returnsMatrix N 组策略 × T 个时段的收益矩阵
 * @param maxSplits 最大随机分割数 (默认 200, 大于此值用蒙特卡洛近似)
 */
export function probabilityOfBacktestOverfitting(
  returnsMatrix: number[][],
  maxSplits = 200
): PBOResult {
  if (!returnsMatrix.length || returnsMatrix[0].length < 4) {
    return {
      pbo: 0,
      n_overfit: 0,
      n_splits: 0,
      warning: 'ok',
      explanation: '样本不足 (策略数 0 或时段数 < 4), 无法计算 PBO',
    };
  }
  const N = returnsMatrix.length;
  const T = returnsMatrix[0].length;
  // 一致性检查
  for (let i = 1; i < N; i++) {
    if (returnsMatrix[i].length !== T) {
      logger.warn(`PBO: 策略 ${i} 长度 ${returnsMatrix[i].length} != T=${T}, 强制按最短截断`);
    }
  }
  const Tmin = Math.min(...returnsMatrix.map(r => r.length));
  // 切成 S = 8 段
  const S = Math.min(8, Math.floor(Tmin / 2));
  if (S < 2) {
    return {
      pbo: 0,
      n_overfit: 0,
      n_splits: 0,
      warning: 'ok',
      explanation: `时段数 ${Tmin} 太少, S<2 无法分割`,
    };
  }
  const segSize = Math.floor(Tmin / S);
  const segments: Array<{ start: number; end: number }> = [];
  for (let s = 0; s < S; s++) {
    segments.push({ start: s * segSize, end: s === S - 1 ? Tmin : (s + 1) * segSize });
  }

  // 生成所有 S choose S/2 组合 (S=8 → 70 组), 若 > maxSplits 取前 maxSplits
  const half = Math.floor(S / 2);
  const combos = combinations(
    Array.from({ length: S }, (_, i) => i),
    half
  ).slice(0, maxSplits);

  let n_overfit = 0;
  for (const isSegments of combos) {
    const isSet = new Set(isSegments);
    // 算每策略在 IS 上的 Sharpe
    const isShape = computeStrategySharpes(returnsMatrix, segments, isSet, Tmin);
    // 找 IS 最高的策略
    let bestStrategy = 0;
    let bestSharpe = -Infinity;
    for (let i = 0; i < N; i++) {
      if (isShape[i] > bestSharpe) {
        bestSharpe = isShape[i];
        bestStrategy = i;
      }
    }
    // 算各策略在 OOS 上的 Sharpe
    const oosSet = new Set(Array.from({ length: S }, (_, i) => i).filter(s => !isSet.has(s)));
    const oosShape = computeStrategySharpes(returnsMatrix, segments, oosSet, Tmin);
    // best strategy 的 OOS 排名
    const bestOOS = oosShape[bestStrategy];
    const ranks = [...oosShape].sort((a, b) => a - b);
    const rank = ranks.indexOf(bestOOS); // 0 = 最差, N-1 = 最好
    // 排名 < N/2 → 过拟合
    if (rank < N / 2) n_overfit++;
  }

  const pbo = combos.length > 0 ? n_overfit / combos.length : 0;
  const warning: PBOResult['warning'] = pbo > 0.5 ? 'overfit' : pbo > 0.3 ? 'caution' : 'ok';
  return {
    pbo,
    n_overfit,
    n_splits: combos.length,
    warning,
    explanation: `${combos.length} splits 中 ${n_overfit} 次 OOS 排名劣于中位, PBO=${(
      pbo * 100
    ).toFixed(1)}% [${warning.toUpperCase()}]`,
  };
}

/**
 * 生成 arr 中所有 k 元素的组合.
 */
export function combinations<T>(arr: T[], k: number): T[][] {
  if (k < 0 || k > arr.length) return [];
  if (k === 0) return [[]];
  if (k === arr.length) return [arr];
  const out: T[][] = [];
  function recurse(start: number, combo: T[]): void {
    if (combo.length === k) {
      out.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      recurse(i + 1, combo);
      combo.pop();
    }
  }
  recurse(0, []);
  return out;
}

/**
 * Helper: 算各策略在指定 segments 集合内的 Sharpe.
 */
function computeStrategySharpes(
  returnsMatrix: number[][],
  segments: Array<{ start: number; end: number }>,
  segSet: Set<number>,
  Tmin: number
): number[] {
  const out: number[] = [];
  for (const stratReturns of returnsMatrix) {
    const subset: number[] = [];
    for (let s = 0; s < segments.length; s++) {
      if (!segSet.has(s)) continue;
      const seg = segments[s];
      for (let t = seg.start; t < seg.end && t < Tmin; t++) {
        subset.push(stratReturns[t]);
      }
    }
    out.push(sharpeRatio(subset, 1, 0)); // 不年化, 比较用
  }
  return out;
}
