/**
 * Purged K-Fold Cross-Validation with Embargo (De Prado AFML Ch.7)
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 7: "Cross-Validation in Finance"
 *
 * **问题**：
 *   传统 K-Fold CV 在时间序列上失效，因为：
 *
 *   1. **Information leakage from overlapping labels** —
 *      Triple Barrier 等 label 跨 horizon (从 t_entry 到 t_exit)
 *      训练集 包含 t < t_test_start 的 entry 但 exit 在 test 期内
 *      → 训练 label 包含未来信息 → 测试 sharpe 虚高
 *
 *   2. **Serial correlation in features** —
 *      consecutive bars 高度相关，传统 CV 把它们随机分进 train/test
 *      就是变相把同一信息既给 train 又给 test
 *
 * **解决方案**：
 *
 *   **Purging (Ch.7.4.1)**: 从 train 集中删除任何
 *     - entry_date < test_start AND exit_date >= test_start
 *     - entry_date <= test_end AND exit_date > test_end
 *     即任何 label 与 test 期重叠的样本
 *
 *   **Embargo (Ch.7.4.2)**: test 期结束后再放 h 个 bar (默认 1% of total)
 *     才允许 train 开始新样本，防 serial correlation 泄漏
 *
 * **K-Fold 切分**：
 *   把整个时间序列均匀切 K 段；每次轮流取 1 段为 test，其他为 train。
 *   每个 train 集都经过 Purging + Embargo 净化。
 *
 * **关键 design 判定**：
 *   1. K 默认 5（业界惯例）
 *   2. Embargo h = 1% × T (Ch.7.4.2 推荐)
 *   3. 必须知道每个样本的 (entry_date, exit_date)；普通 daily 样本可
 *      用 (date, date + holding_period) 替代
 */

export interface SampleEvent {
  /** 唯一标识 */
  id: number | string;
  /** 样本入场时间 (epoch ms or index) */
  entry_time: number;
  /** 样本出场时间 (epoch ms or index)；可以是 entry_time + holding 长度 */
  exit_time: number;
}

export interface FoldSplit {
  fold_index: number;
  train_ids: Array<number | string>;
  test_ids: Array<number | string>;
  test_start: number;
  test_end: number;
  /** 被 purged 出 train 的样本数 */
  purged_count: number;
  /** 被 embargo 推迟的样本数 */
  embargoed_count: number;
}

export interface PurgedKFoldOptions {
  /** Number of folds, default 5 */
  k?: number;
  /** Embargo period (in same unit as event time)；null 用 0；默认 1% of total span */
  embargo_pct?: number;
}

/**
 * 主入口：返回 K 个 fold split
 *
 * @param events 全部样本 (必须按 entry_time 升序排序；若否本函数会排)
 */
export function purgedKFoldSplits(
  events: SampleEvent[],
  options: PurgedKFoldOptions = {}
): FoldSplit[] {
  const k = options.k ?? 5;
  if (k < 2) throw new Error(`purgedKFoldSplits: k=${k} < 2`);
  if (events.length < k) return [];

  const sorted = [...events].sort((a, b) => a.entry_time - b.entry_time);
  const tMin = sorted[0].entry_time;
  const tMax = sorted.reduce((m, e) => Math.max(m, e.exit_time), -Infinity);
  const totalSpan = tMax - tMin;
  const embargoPct = options.embargo_pct ?? 0.01;
  const embargoSpan = totalSpan * embargoPct;

  // 按 entry_time 等分 K 段
  const folds: FoldSplit[] = [];
  const foldSpan = totalSpan / k;
  for (let f = 0; f < k; f += 1) {
    const testStart = tMin + f * foldSpan;
    const testEnd = f === k - 1 ? tMax : tMin + (f + 1) * foldSpan;

    const testIds: Array<number | string> = [];
    const candidateTrainIds: Array<number | string> = [];

    for (const e of sorted) {
      const entryInTest = e.entry_time >= testStart && e.entry_time < testEnd;
      if (entryInTest) {
        testIds.push(e.id);
      } else {
        candidateTrainIds.push(e.id);
      }
    }

    // Purging: 从 candidateTrainIds 删除 label 与 test 期重叠的样本
    // 条件: entry_time < testStart AND exit_time >= testStart  (跨入 test)
    //   OR  entry_time < testEnd AND exit_time > testEnd       (跨出 test) [非 test 内]
    //   OR  entry_time >= testStart AND entry_time < testEnd (本身在 test 内, 已划归 test)
    let purgedCount = 0;
    let embargoedCount = 0;
    const eventMap = new Map(sorted.map(e => [e.id, e]));
    const trainIds = candidateTrainIds.filter(id => {
      const e = eventMap.get(id)!;
      const overlapsTest =
        (e.entry_time < testStart && e.exit_time >= testStart) ||
        (e.entry_time < testEnd &&
          e.exit_time > testEnd &&
          !(e.entry_time >= testStart && e.entry_time < testEnd));
      if (overlapsTest) {
        purgedCount += 1;
        return false;
      }
      // Embargo: 排除 entry_time in (testEnd, testEnd + embargoSpan]
      if (e.entry_time > testEnd && e.entry_time <= testEnd + embargoSpan) {
        embargoedCount += 1;
        return false;
      }
      return true;
    });

    folds.push({
      fold_index: f,
      train_ids: trainIds,
      test_ids: testIds,
      test_start: testStart,
      test_end: testEnd,
      purged_count: purgedCount,
      embargoed_count: embargoedCount,
    });
  }

  return folds;
}

/**
 * Sample uniqueness weights (Ch.4.3 - 4.4 简化版)
 *
 * 当两个 sample 的 [entry, exit] 重叠，它们带的信息冗余。
 * 给每个样本一个权重 = 1 / (number of samples whose interval overlaps with it)
 *
 * 用于在训练时 sample_weight=weights 让重叠样本降权。
 *
 * @returns weights[i] for events[i]
 */
export function sampleUniquenessWeights(events: SampleEvent[]): number[] {
  const N = events.length;
  const overlapCount = new Array(N).fill(1); // 自己算 1
  for (let i = 0; i < N; i += 1) {
    for (let j = i + 1; j < N; j += 1) {
      const overlaps =
        events[i].entry_time <= events[j].exit_time && events[j].entry_time <= events[i].exit_time;
      if (overlaps) {
        overlapCount[i] += 1;
        overlapCount[j] += 1;
      }
    }
  }
  return overlapCount.map(c => 1 / c);
}

/**
 * Aggregate purged k-fold metrics across folds
 */
export function aggregateFoldMetrics(
  foldMetrics: Array<{ fold: number; accuracy: number; auc?: number }>
): {
  mean_accuracy: number;
  std_accuracy: number;
  mean_auc: number | null;
  std_auc: number | null;
  num_folds: number;
} {
  const accs = foldMetrics.map(f => f.accuracy).filter(v => Number.isFinite(v));
  const aucs = foldMetrics.map(f => f.auc).filter((v): v is number => Number.isFinite(v as number));
  const meanAcc = accs.reduce((s, v) => s + v, 0) / accs.length;
  const stdAcc = Math.sqrt(
    accs.reduce((s, v) => s + (v - meanAcc) ** 2, 0) / Math.max(1, accs.length - 1)
  );
  const meanAuc = aucs.length > 0 ? aucs.reduce((s, v) => s + v, 0) / aucs.length : null;
  const stdAuc =
    aucs.length > 1
      ? Math.sqrt(aucs.reduce((s, v) => s + (v - (meanAuc as number)) ** 2, 0) / (aucs.length - 1))
      : null;
  return {
    mean_accuracy: meanAcc,
    std_accuracy: stdAcc,
    mean_auc: meanAuc,
    std_auc: stdAuc,
    num_folds: foldMetrics.length,
  };
}
