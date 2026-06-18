/**
 * Combinatorial Purged Cross-Validation (CPCV) — De Prado AFML Ch.12
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 12: "Backtesting through Cross-Validation"
 *
 * **CPCV 解决什么问题**：
 *
 *   Walk-Forward 只跑 K 个 不重叠 paths。CPCV 跑 C(N, k) 个 paths（N 段中选 k 段做 test
 *   的所有组合），用样本更高效，对 backtest 过拟合的 PBO 估计更可靠。
 *
 *   eg. N=10, k=2 → C(10, 2) = 45 paths
 *       Walk-Forward 只有 10 paths
 *
 * **算法**：
 *
 *   1. 把时间序列切 N 段
 *   2. 列举 C(N, k) 个 "test_groups" — 每次选 k 段做 test
 *   3. 对每个 test_groups:
 *      a. 标记非 test 段为 train
 *      b. **Purge**: 从 train 删 label 与 test 重叠的样本
 *      c. **Embargo**: 从 train 删 test 期后 h 个 bar 内的样本
 *      d. 训练 + 测试 → 收集 metric (sharpe / accuracy)
 *   4. 输出 C(N, k) 个 metrics, 计算分布
 *
 * **PBO 估计 (Section 12.4)**：
 *
 *   - 每个 path 计算 IS Sharpe rank vs OOS Sharpe rank
 *   - IS 冠军在 OOS 是否仍 > median？
 *   - PBO = % path 中 IS 冠军 OOS rank < median
 *   - PBO > 0.5 → 大概率过拟合
 *
 * **N 和 k 推荐 (Ch.12.3.1)**:
 *   - N = 10 (10 段)
 *   - k = 2 (每次 2 段测试)
 *   - → C(10,2) = 45 paths, OOS coverage = 2/10 = 20% per path
 *   - 每段被测试次数 = C(9,1) = 9 次 (vs WalkForward 1 次)
 */

export interface CpcvSampleEvent {
  id: number | string;
  entry_time: number;
  exit_time: number;
}

export interface CpcvFold {
  fold_index: number;
  test_groups: number[];
  train_ids: Array<number | string>;
  test_ids: Array<number | string>;
  test_intervals: Array<{ start: number; end: number }>;
  purged_count: number;
  embargoed_count: number;
}

export interface CpcvOptions {
  /** 把时间序列切 N 段 (默认 10) */
  n_groups?: number;
  /** 每次选 k 段做 test (默认 2) */
  k_test?: number;
  /** Embargo: test 后多少时间单位的 train 样本被删 (默认 1% of total) */
  embargo_pct?: number;
}

/**
 * 主入口: 生成 C(N, k) 个 CPCV fold
 */
export function combinatorialPurgedCV(
  events: CpcvSampleEvent[],
  options: CpcvOptions = {}
): CpcvFold[] {
  const N = options.n_groups ?? 10;
  const k = options.k_test ?? 2;
  if (N < 2) throw new Error(`combinatorialPurgedCV: N=${N} < 2`);
  if (k < 1 || k >= N) throw new Error(`combinatorialPurgedCV: k=${k} must be in [1, N-1]`);
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => a.entry_time - b.entry_time);
  const tMin = sorted[0].entry_time;
  const tMax = sorted.reduce((m, e) => Math.max(m, e.exit_time), -Infinity);
  const totalSpan = tMax - tMin;
  const embargoPct = options.embargo_pct ?? 0.01;
  const embargoSpan = totalSpan * embargoPct;
  const groupSpan = totalSpan / N;

  // 切 N 段
  const groupIntervals: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < N; i += 1) {
    groupIntervals.push({
      start: tMin + i * groupSpan,
      end: i === N - 1 ? tMax : tMin + (i + 1) * groupSpan,
    });
  }

  // 列举 C(N, k) 组合
  const combinations = generateCombinations(N, k);
  const folds: CpcvFold[] = [];

  for (let f = 0; f < combinations.length; f += 1) {
    const test_groups = combinations[f];
    const test_intervals = test_groups.map(g => groupIntervals[g]);

    const test_ids: Array<number | string> = [];
    const candidate_train: Array<number | string> = [];
    const eventMap = new Map(sorted.map(e => [e.id, e]));

    for (const e of sorted) {
      // 样本属于 test 当 entry_time ∈ 任一 test_intervals
      const inTest = test_intervals.some(it => e.entry_time >= it.start && e.entry_time < it.end);
      if (inTest) test_ids.push(e.id);
      else candidate_train.push(e.id);
    }

    // Purging + Embargo
    let purgedCount = 0;
    let embargoedCount = 0;
    const train_ids = candidate_train.filter(id => {
      const e = eventMap.get(id)!;
      // 任一 test_interval overlap label
      const overlaps = test_intervals.some(it => {
        const labelOverlapsTest =
          (e.entry_time < it.start && e.exit_time >= it.start) ||
          (e.entry_time < it.end && e.exit_time > it.end);
        return labelOverlapsTest;
      });
      if (overlaps) {
        purgedCount += 1;
        return false;
      }
      // Embargo
      const inEmbargo = test_intervals.some(
        it => e.entry_time > it.end && e.entry_time <= it.end + embargoSpan
      );
      if (inEmbargo) {
        embargoedCount += 1;
        return false;
      }
      return true;
    });

    folds.push({
      fold_index: f,
      test_groups,
      train_ids,
      test_ids,
      test_intervals,
      purged_count: purgedCount,
      embargoed_count: embargoedCount,
    });
  }

  return folds;
}

/**
 * Generate all C(N, k) combinations of [0, N-1] choose k.
 */
export function generateCombinations(N: number, k: number): number[][] {
  const result: number[][] = [];
  function recurse(start: number, combo: number[]) {
    if (combo.length === k) {
      result.push(combo.slice());
      return;
    }
    for (let i = start; i < N; i += 1) {
      combo.push(i);
      recurse(i + 1, combo);
      combo.pop();
    }
  }
  recurse(0, []);
  return result;
}

/**
 * 从 CPCV fold metrics 估 PBO (与 OverfitMetrics.probabilityOfBacktestOverfitting 比的优势：
 * CPCV 有更多 paths 让 PBO 估计更稳定)
 *
 * 输入: paths[i] = { train_metric_per_candidate[], test_metric_per_candidate[] }
 * 输出: PBO ∈ [0, 1]
 *
 * 算法 (Bailey-De Prado 2014):
 *   for each path:
 *     n_train = train_metrics.length
 *     n_test = test_metrics.length
 *     champion_idx = argmax(train_metrics)
 *     champion_test_rank = rank of test_metrics[champion_idx]
 *     if champion_test_rank > median_rank → overfit
 *   PBO = overfit_count / total_paths
 */
export function computePboFromPaths(
  paths: Array<{ train_metrics: number[]; test_metrics: number[] }>
): number {
  if (paths.length === 0) return Number.NaN;
  let overfitCount = 0;
  for (const p of paths) {
    const n = p.train_metrics.length;
    if (n < 2 || p.test_metrics.length !== n) continue;
    // champion = highest train metric
    let championIdx = 0;
    let championVal = p.train_metrics[0];
    for (let i = 1; i < n; i += 1) {
      if (p.train_metrics[i] > championVal) {
        championVal = p.train_metrics[i];
        championIdx = i;
      }
    }
    // champion's rank in test (1 = best)
    const sortedTestIdx = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => p.test_metrics[b] - p.test_metrics[a]
    );
    const championTestRank = sortedTestIdx.indexOf(championIdx) + 1;
    // if champion test rank > n/2 → overfit (bottom half)
    if (championTestRank > n / 2) overfitCount += 1;
  }
  return overfitCount / paths.length;
}
