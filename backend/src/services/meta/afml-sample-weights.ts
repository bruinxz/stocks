/**
 * AFML Ch.4 — Sample Weights
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 4: "Sample Weights"
 *
 * **核心问题**:
 *   时间序列样本重叠 (overlapping labels) 违反 IID 假设。
 *   ML 模型直接训练会过度依赖某些时段 (重叠的样本被多次计算).
 *
 * **解决方案**:
 *
 *   1. **Indicator Matrix** (Eq.4.1):
 *      1_{t,i} = 1 if sample i was active at time t
 *
 *   2. **Concurrency** (Eq.4.2):
 *      c_t = Σ_i 1_{t,i}  - 同一时刻有多少 sample 重叠
 *
 *   3. **Average Uniqueness** (Eq.4.3):
 *      ū_i = (1/T_i) Σ_t (1_{t,i} / c_t)  - sample i 的平均独特性
 *
 *   4. **Sequential Bootstrap** (Section 4.3):
 *      不是随机抽样, 而是根据 uniqueness 加权抽样, 后续 sample 的概率
 *      依赖于已抽 sample 的 uniqueness (减少重叠).
 *
 *   5. **Class Weights** (Section 4.7):
 *      Sample weight = ū_i × |return|  - return 大的样本权重大
 */

export interface BarTimespan {
  /** Index of bar in time series (t in entry_time) */
  t_in: number;
  /** Index of bar at exit (t_out) */
  t_out: number;
}

/**
 * 计算 indicator matrix: 1_{t,i} = 1 if sample i is active at time t
 *
 * @returns matrix (T × N) of 0/1
 */
export function buildIndicatorMatrix(samples: BarTimespan[], num_time_bars: number): number[][] {
  const T = num_time_bars;
  const N = samples.length;
  const matrix: number[][] = Array.from({ length: T }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    for (let t = samples[i].t_in; t <= samples[i].t_out && t < T; t += 1) {
      matrix[t][i] = 1;
    }
  }
  return matrix;
}

/**
 * Concurrency vector c_t = number of overlapping samples at time t.
 */
export function computeConcurrency(indicator: number[][]): number[] {
  const T = indicator.length;
  if (T === 0) return [];
  const N = indicator[0].length;
  const c: number[] = new Array(T).fill(0);
  for (let t = 0; t < T; t += 1) {
    for (let i = 0; i < N; i += 1) c[t] += indicator[t][i];
  }
  return c;
}

/**
 * Average uniqueness ū_i for each sample.
 *
 *   ū_i = (1 / T_i) Σ_t (1_{t,i} / c_t)
 *
 * T_i = number of time bars sample i is active.
 */
export function averageUniqueness(indicator: number[][]): number[] {
  const T = indicator.length;
  if (T === 0) return [];
  const N = indicator[0].length;
  const c = computeConcurrency(indicator);
  const out: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    let sum_u = 0;
    let T_i = 0;
    for (let t = 0; t < T; t += 1) {
      if (indicator[t][i] === 1 && c[t] > 0) {
        sum_u += 1 / c[t];
        T_i += 1;
      }
    }
    out[i] = T_i > 0 ? sum_u / T_i : 0;
  }
  return out;
}

/**
 * Sequential Bootstrap (Section 4.3 + 4.4).
 *
 * 不是 i.i.d. 抽样, 而是迭代:
 *   每次抽 1 个 sample, 考虑它会被加入已抽集合后对 average uniqueness 的影响.
 *
 * 简化算法:
 *   1. Start with empty drawn set Φ
 *   2. For k = 1..size:
 *      a. Compute marginal uniqueness if each candidate i was added next
 *      b. Sample probability ∝ marginal uniqueness
 *      c. Add sampled i to Φ
 */
export function sequentialBootstrap(
  indicator: number[][],
  size: number,
  rng: () => number = Math.random
): number[] {
  const T = indicator.length;
  if (T === 0) return [];
  const N = indicator[0].length;
  const drawn: number[] = [];
  // Current concurrency from drawn samples
  const c: number[] = new Array(T).fill(0);

  for (let k = 0; k < size; k += 1) {
    // Marginal uniqueness if we add each candidate next
    const marginal_u: number[] = new Array(N).fill(0);
    for (let i = 0; i < N; i += 1) {
      let sum_u = 0;
      let T_i = 0;
      for (let t = 0; t < T; t += 1) {
        if (indicator[t][i] === 1) {
          const new_c = c[t] + 1; // adding this sample increases c_t
          sum_u += 1 / new_c;
          T_i += 1;
        }
      }
      marginal_u[i] = T_i > 0 ? sum_u / T_i : 0;
    }

    // Sample probability ∝ marginal_u
    const total = marginal_u.reduce((s, v) => s + v, 0);
    if (total <= 0) break;
    const probs = marginal_u.map(v => v / total);
    // Sample
    const r = rng();
    let chosen = 0;
    let cumul = 0;
    for (let i = 0; i < N; i += 1) {
      cumul += probs[i];
      if (r <= cumul) {
        chosen = i;
        break;
      }
    }
    drawn.push(chosen);
    // Update c
    for (let t = 0; t < T; t += 1) {
      if (indicator[t][chosen] === 1) c[t] += 1;
    }
  }

  return drawn;
}

/**
 * Sample weights for ML training (Section 4.7).
 *
 *   weight_i = ū_i × |return_i|
 *
 * Optionally normalize sum to N.
 */
export function computeSampleWeightsByReturns(
  avg_uniqueness: number[],
  returns: number[],
  normalize = true
): number[] {
  if (avg_uniqueness.length !== returns.length) throw new Error('length mismatch');
  const N = avg_uniqueness.length;
  const w: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    w[i] = avg_uniqueness[i] * Math.abs(returns[i]);
  }
  if (normalize) {
    const sum = w.reduce((s, v) => s + v, 0);
    if (sum > 0) {
      const scale = N / sum;
      for (let i = 0; i < N; i += 1) w[i] *= scale;
    }
  }
  return w;
}

/**
 * Time-decay sample weights (Section 4.10).
 *
 *   w_i^d = c · ū_i + (1 - c) · ū_i × decay_i
 *
 *   decay_i = 0 for first sample, linearly to 1 for last sample.
 *   c ∈ [0, 1]: weight on time-decayed term vs uniqueness alone.
 *
 *   Equivalent: oldest samples get c·ū, newest get ū.
 */
export function timeDecayWeights(avg_uniqueness: number[], c = 0.5): number[] {
  const N = avg_uniqueness.length;
  if (N === 0) return [];
  const out: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    const decay = N > 1 ? i / (N - 1) : 1;
    out[i] = c * avg_uniqueness[i] + (1 - c) * avg_uniqueness[i] * decay;
  }
  return out;
}
