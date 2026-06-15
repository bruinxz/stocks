/**
 * Sprint 41-B: IsotonicCalibrator — 单调概率校准 (Pool Adjacent Violators)
 *
 * 问题: MetaLabel logistic regression 输出的 confidence (0-1) 并不等于真实胜率.
 * 比如训练集里 confidence=0.80 的样本实际胜率可能只有 0.55 (overconfident).
 * 这导致下游 EV 计算 (win_prob × avg_win) 系统性偏高, 总是过度下注.
 *
 * Isotonic Regression 通过 PAV (Pool Adjacent Violators) 算法学一个单调
 * 非降的映射 f: raw_confidence → calibrated_probability, 用最少的假设 (只要
 * monotonic) 让校准曲线尽可能贴合实际胜率.
 *
 * 与 Platt scaling (sigmoid 拟合) 对比:
 *   - Platt: 假设 confidence-胜率关系是 sigmoid, 适合小样本 + 明显 sigmoid 形态
 *   - Isotonic: 无 sigmoid 假设, 拟合任何单调形态, 适合大样本 + 形态不规则
 *   - 我们生产数据可能是非典型 sigmoid (signal_score 与 win_rate 不一定 logistic),
 *     选 Isotonic 更稳健.
 *
 * 设计要点:
 *   1. **纯函数实现**: trainIsotonic(samples) → CalibrationModel,
 *      calibrate(model, raw) → calibratedProb. 全 export 让单测脱依赖.
 *   2. **模型存 (x, y) 阶梯数组**: 用 binary search 在 predict 时 O(log n) 查询.
 *      n 通常 < 100 (合并相邻同值后).
 *   3. **边界外延**: raw < first_x → first_y; raw > last_x → last_y. 不外推.
 *   4. **空样本 / 单样本 fallback**: 返回 identity model (x→x), 让 caller 仍能调
 *      calibrate 不崩.
 *   5. **不依赖任何外部包**: PAV 算法约 30 行 JS, 自实现避免引入 ml-isotonic 依赖.
 */

import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalibrationSample {
  /** Raw confidence from underlying model (e.g. logistic regression) (0..1) */
  raw_confidence: number;
  /** Actual outcome: 1 = win, 0 = loss */
  outcome: 0 | 1;
}

export interface IsotonicCalibrationModel {
  /** Sorted (x, y) anchor points where x = raw confidence, y = calibrated probability */
  points: Array<{ x: number; y: number }>;
  /** Number of training samples */
  trained_samples: number;
  /** Mean raw confidence in training set (debug) */
  mean_raw_confidence: number;
  /** Mean outcome (i.e. base win rate) in training set */
  base_win_rate: number;
  trained_at: string;
}

// ---------------------------------------------------------------------------
// Pure-function helpers
// ---------------------------------------------------------------------------

/**
 * Identity model — for fallback when no training data.
 */
export function identityCalibrationModel(): IsotonicCalibrationModel {
  return {
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    trained_samples: 0,
    mean_raw_confidence: 0.5,
    base_win_rate: 0.5,
    trained_at: new Date().toISOString(),
  };
}

/**
 * PAV (Pool Adjacent Violators) 核心算法.
 * 输入: samples 按 raw_confidence 升序排列后的数组
 * 输出: 一组 (x, y, weight) 的 monotonic 阶梯, y 单调非降
 *
 * 算法:
 *   1. 初始化每个样本为一个 "pool", weight=1, y=outcome
 *   2. 从左到右扫描, 若发现相邻 pool[i].y > pool[i+1].y, 合并两个 pool:
 *      new_y = (w_i × y_i + w_{i+1} × y_{i+1}) / (w_i + w_{i+1})
 *      重新检查左邻 (因合并后可能破坏左侧 monotonic)
 *   3. 直到所有相邻 pool 都满足 y_i <= y_{i+1}
 *
 * 复杂度: O(n) amortized (每个 sample 最多被合并一次)
 */
export function poolAdjacentViolators(
  sortedSamples: Array<{ x: number; y: number }>
): Array<{ x: number; y: number; weight: number }> {
  if (!sortedSamples.length) return [];
  const pools: Array<{ x_sum: number; y_sum: number; weight: number; x_max: number }> = [];
  for (const s of sortedSamples) {
    pools.push({ x_sum: s.x, y_sum: s.y, weight: 1, x_max: s.x });
    // 检查是否需要合并左邻
    while (pools.length >= 2) {
      const right = pools[pools.length - 1];
      const left = pools[pools.length - 2];
      const left_y = left.y_sum / left.weight;
      const right_y = right.y_sum / right.weight;
      if (left_y > right_y) {
        // 合并 left + right
        const merged = {
          x_sum: left.x_sum + right.x_sum,
          y_sum: left.y_sum + right.y_sum,
          weight: left.weight + right.weight,
          x_max: Math.max(left.x_max, right.x_max),
        };
        pools.pop();
        pools.pop();
        pools.push(merged);
      } else {
        break;
      }
    }
  }
  return pools.map(p => ({
    x: p.x_max, // 用 max 作为 anchor, 让 predict 时 raw=x 落在该 pool
    y: p.y_sum / p.weight,
    weight: p.weight,
  }));
}

/**
 * 训练 isotonic calibration 模型.
 * 空样本 → identity model; 单样本 → 平坦模型 y = sample.outcome.
 */
export function trainIsotonicCalibration(samples: CalibrationSample[]): IsotonicCalibrationModel {
  if (!samples.length) return identityCalibrationModel();
  if (samples.length === 1) {
    const s = samples[0];
    return {
      points: [
        { x: 0, y: s.outcome },
        { x: 1, y: s.outcome },
      ],
      trained_samples: 1,
      mean_raw_confidence: s.raw_confidence,
      base_win_rate: s.outcome,
      trained_at: new Date().toISOString(),
    };
  }
  const cleaned = samples.filter(
    s =>
      Number.isFinite(s.raw_confidence) &&
      s.raw_confidence >= 0 &&
      s.raw_confidence <= 1 &&
      (s.outcome === 0 || s.outcome === 1)
  );
  if (!cleaned.length) return identityCalibrationModel();

  const sorted = [...cleaned].sort((a, b) => a.raw_confidence - b.raw_confidence);
  const pavInput = sorted.map(s => ({ x: s.raw_confidence, y: s.outcome }));
  const pavOutput = poolAdjacentViolators(pavInput);

  // Dedup by x (PAV 输出可能有相邻 pool 同 x — 取后者)
  const dedupedMap = new Map<number, number>();
  for (const p of pavOutput) {
    dedupedMap.set(p.x, p.y);
  }
  const points = Array.from(dedupedMap.entries())
    .map(([x, y]) => ({ x, y }))
    .sort((a, b) => a.x - b.x);

  // Sanity: y monotonic 验证 (浮点容差 1e-9)
  for (let i = 1; i < points.length; i++) {
    if (points[i].y < points[i - 1].y - 1e-9) {
      logger.warn(
        `isotonic: monotonic violation at idx=${i} (${points[i - 1].y} > ${points[i].y})`
      );
    }
  }

  const meanRaw = cleaned.reduce((s, r) => s + r.raw_confidence, 0) / cleaned.length;
  const baseWin = cleaned.reduce((s, r) => s + r.outcome, 0) / cleaned.length;

  return {
    points,
    trained_samples: cleaned.length,
    mean_raw_confidence: meanRaw,
    base_win_rate: baseWin,
    trained_at: new Date().toISOString(),
  };
}

/**
 * 用训练好的 isotonic model 校准 raw confidence → calibrated probability.
 * Binary search + 线性插值 (在阶梯之间).
 *
 * 边界:
 *   - raw < points[0].x  → points[0].y (不外推, 用最小阶梯值)
 *   - raw > points[-1].x → points[-1].y (不外推, 用最大阶梯值)
 *   - raw 介于 points[i].x 和 points[i+1].x → 线性插值
 */
export function calibrate(model: IsotonicCalibrationModel, raw_confidence: number): number {
  const x = Math.max(0, Math.min(1, raw_confidence));
  if (!model.points.length) return x;
  if (x <= model.points[0].x) return model.points[0].y;
  if (x >= model.points[model.points.length - 1].x) {
    return model.points[model.points.length - 1].y;
  }
  // Binary search the bracket
  let lo = 0;
  let hi = model.points.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (model.points[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const left = model.points[lo];
  const right = model.points[hi];
  if (right.x === left.x) return left.y;
  const t = (x - left.x) / (right.x - left.x);
  return left.y + t * (right.y - left.y);
}

/**
 * Brier score 评估校准质量: 越低越好, 完美 = 0, 最差 = 1.
 * 用于训练后 in-sample / OOS 验证.
 */
export function brierScore(model: IsotonicCalibrationModel, samples: CalibrationSample[]): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) {
    const pred = calibrate(model, s.raw_confidence);
    const diff = pred - s.outcome;
    sum += diff * diff;
  }
  return sum / samples.length;
}

// ---------------------------------------------------------------------------
// Service wrapper (for stateful in-memory cache)
// ---------------------------------------------------------------------------

export class IsotonicCalibrator {
  private model: IsotonicCalibrationModel = identityCalibrationModel();

  /** 替换当前模型 */
  setModel(model: IsotonicCalibrationModel): void {
    this.model = model;
    logger.info(
      `[isotonic] model updated: ${model.trained_samples} samples, ${
        model.points.length
      } pools, base_win=${model.base_win_rate.toFixed(3)}`
    );
  }

  getModel(): IsotonicCalibrationModel {
    return this.model;
  }

  /** 训练并替换模型 */
  train(samples: CalibrationSample[]): IsotonicCalibrationModel {
    const m = trainIsotonicCalibration(samples);
    this.setModel(m);
    return m;
  }

  /** 校准单个 raw confidence */
  calibrate(raw_confidence: number): number {
    return calibrate(this.model, raw_confidence);
  }
}

export const isotonicCalibrator = new IsotonicCalibrator();
