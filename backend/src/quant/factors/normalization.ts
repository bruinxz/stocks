/**
 * 横截面标准化工具 (US-009 因子 pipeline 内部)
 *
 * - winsorize: 把极端值（默认 1%-99% 分位）截断到分位边界。
 * - zscore: 计算 (value - mean) / stddev，stddev=0 时全部返回 0（中性）。
 * - percentile: 每个 value 在样本中的百分位 (0..1)，平均秩处理 tie。
 *
 * 输入约定：传入 finite-only 的 number[]。NaN / Infinity 由调用方提前过滤。
 *
 * 为什么不复用 quant/engine/QuantMath.ts：QuantMath 的 average/stddev 是
 * "时序" 视角（rolling、ema 等）；这里的几个函数是 "横截面" 视角（同一时刻
 * 多只股票），用途不同，独立放在 factors/ 下避免相互污染。
 */

export interface WinsorizeOptions {
  /** 下分位（默认 0.01）。在该百分位以下的值被截断到该分位值 */
  lowerQuantile?: number;
  /** 上分位（默认 0.99）。在该百分位以上的值被截断到该分位值 */
  upperQuantile?: number;
}

/**
 * 按分位截断极端值。返回新数组（不 mutate 入参）。
 *
 * 空数组、单元素数组直接返回拷贝（无极端值可言）。
 */
export function winsorize(values: number[], options: WinsorizeOptions = {}): number[] {
  const lower = options.lowerQuantile ?? 0.01;
  const upper = options.upperQuantile ?? 0.99;
  if (lower < 0 || lower > 1 || upper < 0 || upper > 1 || lower >= upper) {
    throw new Error(`winsorize: invalid quantile bounds (${lower}, ${upper})`);
  }
  if (values.length < 2) return values.slice();
  const sorted = values.slice().sort((a, b) => a - b);
  const lowerBound = quantileAtSorted(sorted, lower);
  const upperBound = quantileAtSorted(sorted, upper);
  return values.map(v => {
    if (v < lowerBound) return lowerBound;
    if (v > upperBound) return upperBound;
    return v;
  });
}

/**
 * 简单算术均值（NaN 安全：调用方应已过滤 NaN）。
 * 空数组返回 0（横截面无样本时的中性默认）。
 */
export function mean(values: number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * 样本标准差（n-1 分母）。
 * 样本不足 2 个或方差为 0 时返回 0（z-score 将退化为全 0）。
 */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * 横截面 z-score。stddev=0 → 全部返回 0（避免 NaN，下游可视为中性）。
 *
 * 返回与 values 等长的数组，索引对齐。
 */
export function zscore(values: number[]): number[] {
  if (!values.length) return [];
  const m = mean(values);
  const sd = stddev(values);
  if (sd === 0) return values.map(() => 0);
  return values.map(v => (v - m) / sd);
}

/**
 * 每个 value 在样本中的百分位 (0..1)，使用平均秩处理 tie。
 *
 * 公式：percentile = (avg_rank - 1) / (n - 1)
 *   - 最小值的 percentile = 0
 *   - 最大值的 percentile = 1
 *   - tie 之间 percentile 相同（取平均秩）
 *
 * n=1 时返回 [0.5]（中性）。
 */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];

  // index_in_values → sorted_position
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  // 给每个原始位置计算 "平均秩"（1-based）
  const avgRanks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && indexed[j + 1].v === indexed[i].v) j += 1;
    // 区间 [i, j] 都是 tie，平均秩 = ((i+1) + (j+1)) / 2
    const rank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) {
      avgRanks[indexed[k].i] = rank;
    }
    i = j + 1;
  }

  // percentile = (rank - 1) / (n - 1)，保证 [0, 1]
  return avgRanks.map(r => (r - 1) / (n - 1));
}

// --- 内部 helper ---

/** 已排序数组的分位值（线性插值法），quantile ∈ [0,1] */
function quantileAtSorted(sorted: number[], quantile: number): number {
  if (!sorted.length) return 0;
  if (quantile <= 0) return sorted[0];
  if (quantile >= 1) return sorted[sorted.length - 1];
  const pos = quantile * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 >= sorted.length) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}
