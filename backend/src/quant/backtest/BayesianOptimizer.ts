/**
 * BayesianOptimizer — 高斯过程 + Expected Improvement 贝叶斯参数搜索（US-038）
 *
 * 给定一个策略 + 连续 / 整数参数边界 + 通用回测配置，在 N 次回测预算内通过
 * 贝叶斯优化高效搜索：
 *   1. 先做 `init_points` 次 Sobol-like 拟随机均匀采样建立先验
 *   2. 后续每次基于已观测点拟合高斯过程后验，按 Expected Improvement (EI)
 *      acquisition 选下一个采样点
 *   3. 跑完 `iterations` 次后返回历史最优参数组合
 *
 * **设计选择**：自实现 EI + GP 而非 npm 依赖：
 *   - bayesian-optimization 包近 4 年未更新且依赖 ml-matrix（多 MB）
 *   - EI + RBF GP 的核心数学不超过 200 行，自实现可保持纯函数 + 可单测
 *   - 测试时可注入 fake runner + 固定 seed，预期采样轨迹完全可复现
 *
 * **与 GridSearchOptimizer 的关系**（CLAUDE.md US-037 → US-038 设计）：
 *   - 共享 OptimizationRun + OptimizationResult 表（已加 optimizer_type 字段区分）
 *   - 共享 BacktestRunner / OptimizationResultRecord / CompositeScoreWeights 类型
 *   - 共享 computeCompositeScore + sortByCompositeScoreDesc + defaultBacktestRunner
 *   - 互补关系：grid 适合离散少维网格穷举；bayesian 适合 3+ 维连续 / 大空间
 *
 * 公共接口：
 *   - `optimize(input, options?)` — 异步执行一次完整贝叶斯搜索
 *   - `expectedImprovement(mean, std, bestObserved, xi?)` — 纯函数 EI 公式
 *   - `gaussianProcessPosterior(x, observations, kernel)` — 纯函数 GP 后验
 *   - `sampleInitialPoints(bounds, n, seed?)` — 纯函数初始均匀采样
 *
 * **采样轨迹的确定性**：
 *   - `options.seed` 控制初始拟随机采样 + EI tie-break 的随机扰动
 *   - 同 seed + 同 bounds + 同 runner → 完全相同的采样序列（test 可复现）
 *   - 不传 seed 时用 fixed default seed (US-038 deliberately 不引入 Math.random，
 *     因为 backtest 已经够慢，再叠加随机源会让 reproduce 困难)
 *
 * **Acquisition function**：默认 Expected Improvement (EI) with xi=0.01
 * exploration factor。caller 可通过 options.exploration_xi 调节：
 *   - 较小 xi (0.001) → exploitation-heavy 收敛快但容易卡局部最优
 *   - 较大 xi (0.1) → exploration-heavy 收敛慢但覆盖广
 *
 * **失败隔离**：单 iter 失败不中断后续 iter——同 GridSearchOptimizer 模式。
 * 但失败点**不会**进入 GP 训练集（NaN 会让 GP 协方差矩阵不可逆）；diagnostics
 * 字段记录失败 iter 序号。
 *
 * 主要消费方：
 *   - run-bayesian-opt.ts CLI
 *   - 未来 US-016 策略实验室 "贝叶斯调优" tab
 *   - WalkForwardValidator (US-039) train 窗口的更高效搜索引擎
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { SeededRandom } from '../../utils/SeededRandom';
import { OptimizationRun } from '../../models/OptimizationRun';
import { OptimizationResult } from '../../models/OptimizationResult';
import { strategyRegistry } from '../engine/StrategyRegistry';
import { QuantBacktestOptions } from '../types/QuantTypes';
// Sprint 43-E: 接入 DSR 防过拟合
import { deflatedSharpeRatio } from '../../services/research/ResearchValidationService';
import {
  BacktestRunner,
  OptimizationResultRecord,
  CompositeScoreWeights,
  DEFAULT_COMPOSITE_WEIGHTS,
  defaultBacktestRunner,
  computeCompositeScore,
  sortByCompositeScoreDesc,
} from './GridSearchOptimizer';

// ============================================================
// Types
// ============================================================

/**
 * 单参数的搜索边界。
 *   - min/max 必填，min < max
 *   - integer=true 时采样会 round 到整数（适用于 topN / lookbackDays 等）
 *
 * 示例：
 *   { topN: { min: 10, max: 50, integer: true },
 *     stopLossPct: { min: -15, max: -3 } }
 */
export interface ParamBound {
  min: number;
  max: number;
  /** 是否取整（默认 false = 连续浮点） */
  integer?: boolean;
}

export type ParamBounds = Record<string, ParamBound>;

/**
 * `optimize()` 输入。`base_config` 同 GridSearchOptimizer：除被优化参数外的所
 * 有回测配置（start_date / end_date / initial_capital / universe / ...）。
 */
export interface BayesianOptimizeInput {
  strategy_key: string;
  param_bounds: ParamBounds;
  base_config: Omit<QuantBacktestOptions, 'strategy_keys' | 'params_by_strategy'>;
}

export interface BayesianOptimizeOptions {
  /** 总采样次数（包含 init_points + EI 推荐采样），默认 30 */
  iterations?: number;
  /** 初始拟随机均匀采样次数（用于建立 GP 先验），默认 max(5, ceil(2 * D)) */
  init_points?: number;
  /** 多目标排序权重，默认 DEFAULT_COMPOSITE_WEIGHTS */
  weights?: Partial<CompositeScoreWeights>;
  /** EI exploration factor xi，默认 0.01 */
  exploration_xi?: number;
  /** RBF kernel length scale（控制 GP 平滑度），默认 0.3（归一化到 [0,1] 空间） */
  kernel_length_scale?: number;
  /** GP 训练点不可逆时的 jitter（添加到对角线），默认 1e-6 */
  kernel_jitter?: number;
  /** 是否写库，默认 true */
  persist?: boolean;
  /** 安全上限：单次贝叶斯调用最多 iter 数，默认 200 */
  max_iterations?: number;
  /** 触发用户 ID（落库 OptimizationRun.created_by） */
  user_id?: number;
  /** 自定义 backtest runner（默认走 quantBacktestEngine）；测试时注入 fake */
  runner?: BacktestRunner;
  /** 随机种子；同 seed + 同 bounds + 同 runner → 完全相同轨迹（测试用） */
  seed?: number;
  /**
   * EI candidate 网格大小：每维度上的候选点数。默认 64；单 iter EI 评估总点数 =
   * 64 ^ D。维度 > 4 时建议下调到 32 否则 64^5 = 10^9 内存爆炸。
   */
  ei_candidate_grid_size?: number;
}

/**
 * `optimize()` 输出。与 GridSearchOptimizer 输出 shape 高度一致让 caller 可以
 * 用同一段代码消费两种优化器的输出（CLI / UI / WalkForward 嵌套）。
 */
export interface BayesianOptimizeResult {
  run: OptimizationRun | null;
  /** 全部 iter 的 result records（按 iter index ASC） */
  results: OptimizationResultRecord[];
  /** 按 composite_score DESC 排序后的第一行（None 若全部失败） */
  best: OptimizationResultRecord | null;
  /** ranked 视图（已排序，null 推到最末），方便 caller 不再二次 sort */
  ranked: OptimizationResultRecord[];
  /** 实际跑了多少 iter（受 max_iterations / iterations 限制） */
  iterations_run: number;
  /** 失败 iter 数 */
  failed_iterations: number;
  /** init 阶段 iter 数（前 init_points 次） */
  init_iterations: number;
  /** EI 阶段 iter 数（init_points 之后） */
  ei_iterations: number;
}

/**
 * 已观测点。归一化到 [0,1]^D 空间存储以让 RBF kernel length scale 与维度无关
 * （原始空间下 stopLossPct ∈ [-15,-3] 和 topN ∈ [10,50] 的 distance 完全不可比）。
 */
interface ObservedPoint {
  /** 在归一化 [0,1]^D 空间的坐标 */
  normalized: number[];
  /** composite_score（贝叶斯优化的目标） */
  score: number;
  /** 原始空间的 params */
  params: Record<string, any>;
}

// ============================================================
// Pure helpers — independently unit-testable
// ============================================================

/**
 * 把参数从原始空间映射到 [0,1]^D。
 *   - normalize({ topN: 30 }, { topN: {min:10, max:50} }) = [0.5]
 *   - normalize({ topN: 30, slPct: -7 }, { topN:{...}, slPct:{min:-15,max:-3} })
 *     = [0.5, 0.667]（按 bounds keys 的顺序）
 *
 * 维度顺序 = `Object.keys(bounds)` 顺序，保证整个 optimize() 内一致。
 */
export function normalizeParams(params: Record<string, any>, bounds: ParamBounds): number[] {
  const keys = Object.keys(bounds);
  const out: number[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const bound = bounds[key];
    const value = Number(params[key]);
    if (!Number.isFinite(value)) {
      throw new Error(`normalizeParams: ${key} 不是有限数 (${params[key]})`);
    }
    out[i] = (value - bound.min) / (bound.max - bound.min);
  }
  return out;
}

/**
 * 把 [0,1]^D 坐标映射回原始空间参数。integer=true 时 round。
 *   - denormalize([0.5], { topN: {min:10, max:50, integer:true} }) = { topN: 30 }
 *   - denormalize([0.25], { x: {min:-1, max:3} }) = { x: 0 }
 */
export function denormalizeParams(normalized: number[], bounds: ParamBounds): Record<string, any> {
  const keys = Object.keys(bounds);
  if (normalized.length !== keys.length) {
    throw new Error(
      `denormalizeParams: 维度不匹配 (got ${normalized.length}, expected ${keys.length})`
    );
  }
  const out: Record<string, any> = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const bound = bounds[key];
    const clamped = Math.max(0, Math.min(1, normalized[i]));
    const raw = bound.min + clamped * (bound.max - bound.min);
    out[key] = bound.integer ? Math.round(raw) : raw;
  }
  return out;
}

/**
 * RBF (Gaussian / squared-exponential) kernel：k(x, x') = exp(-||x - x'||² / (2 * l²))
 *
 * length_scale 越小 → kernel 越尖锐 → GP 越能拟合复杂曲面但容易过拟合；
 * length_scale 越大 → kernel 越平滑 → GP 倾向输出训练点均值；
 * 经验默认 0.3（在 [0,1]^D 归一化空间内）适合大多数中等平滑的回测目标函数。
 */
export function rbfKernel(x1: number[], x2: number[], lengthScale = 0.3): number {
  if (x1.length !== x2.length) {
    throw new Error(`rbfKernel: 维度不匹配 ${x1.length} vs ${x2.length}`);
  }
  let sqDist = 0;
  for (let i = 0; i < x1.length; i++) {
    const d = x1[i] - x2[i];
    sqDist += d * d;
  }
  return Math.exp(-sqDist / (2 * lengthScale * lengthScale));
}

/**
 * 标准正态分布累积分布函数 CDF Φ(z) — Abramowitz-Stegun 7.1.26 + erf-based。
 * 误差 < 1.5e-7（对 EI 来说远超精度需求）。
 */
export function normalCDF(z: number): number {
  // Φ(z) = 0.5 * (1 + erf(z / √2))
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * 标准正态分布概率密度函数 PDF φ(z) = (1/√(2π)) * exp(-z²/2)
 */
export function normalPDF(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Abramowitz-Stegun 7.1.26 误差函数近似 */
function erf(x: number): number {
  // 常数（A&S 7.1.26）
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Expected Improvement acquisition function:
 *   EI(x) = (μ(x) - f* - ξ) * Φ(Z) + σ(x) * φ(Z)
 *   Z = (μ(x) - f* - ξ) / σ(x)  if σ(x) > 0
 *   EI(x) = 0  if σ(x) <= 0
 *
 * 其中 μ(x), σ(x) 是 GP 在 x 的后验均值/标准差；f* 是当前最优观测；ξ 是
 * exploration factor（越大越偏向 exploration）。
 *
 * EI 越大 = 该点越值得下一次尝试。BayesianOptimizer 在 candidate grid 上算 EI
 * 后取 argmax 作为下一个采样点。
 */
export function expectedImprovement(
  mean: number,
  std: number,
  bestObserved: number,
  xi = 0.01
): number {
  if (!Number.isFinite(mean) || !Number.isFinite(std) || !Number.isFinite(bestObserved)) {
    return 0;
  }
  if (std <= 1e-12) return 0;
  const improvement = mean - bestObserved - xi;
  const z = improvement / std;
  return improvement * normalCDF(z) + std * normalPDF(z);
}

/**
 * 求解线性方程组 K * α = y，其中 K 是对称正定 n×n 矩阵（GP 协方差）。
 * 使用 Cholesky 分解：K = L * L^T，先解 L * z = y 再解 L^T * α = z。
 * 对 n ≤ 200 的贝叶斯优化训练集（典型 ≤ 30 iter）速度完全足够。
 *
 * 若 K 非正定（罕见：训练点重合）会抛错；caller 应已添加 jitter。
 */
export function choleskyDecompose(K: number[][]): number[][] {
  const n = K.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = K[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) {
          throw new Error(
            `choleskyDecompose: 矩阵非正定（i=${i}, sum=${sum}）。增大 kernel_jitter 试试`
          );
        }
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

/** 解下三角线性方程 L * x = b */
export function solveLowerTriangular(L: number[][], b: number[]): number[] {
  const n = L.length;
  const x = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * x[k];
    x[i] = sum / L[i][i];
  }
  return x;
}

/** 解上三角线性方程 L^T * x = b */
export function solveUpperTriangular(L: number[][], b: number[]): number[] {
  const n = L.length;
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return x;
}

/**
 * GP 后验在 query 点 x 的均值与方差：
 *   μ(x) = k(x, X)^T * K^{-1} * y
 *   σ²(x) = k(x, x) - k(x, X)^T * K^{-1} * k(x, X)
 *
 * 其中 K 是训练点的 N×N kernel 矩阵（含 jitter），y 是中心化的 score 向量。
 * 返回 {mean, variance, std} 三元；caller 用 mean + std 算 EI。
 *
 * **中心化**：训练时减去 y 均值让先验更合理（GP 先验默认均值=0）；query 时
 * 算完 μ 后再加回 yMean。
 *
 * 训练点很少（≤ 30）时直接 Cholesky；不引入稀疏 GP / inducing points。
 */
export function gaussianProcessPosterior(
  xQuery: number[],
  trainingPoints: Array<{ x: number[]; y: number }>,
  lengthScale = 0.3,
  jitter = 1e-6
): { mean: number; variance: number; std: number } {
  const n = trainingPoints.length;
  if (n === 0) {
    // 无观测点 → 先验均值=0，标准差=1（最大不确定）
    return { mean: 0, variance: 1, std: 1 };
  }

  // 1. 算 y 均值（中心化先验）
  let yMean = 0;
  for (const tp of trainingPoints) yMean += tp.y;
  yMean /= n;

  // 2. 构造 N×N kernel 矩阵 K = k(X, X) + jitter * I
  const K: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      K[i][j] = rbfKernel(trainingPoints[i].x, trainingPoints[j].x, lengthScale);
      if (i === j) K[i][j] += jitter;
    }
  }

  // 3. Cholesky 解 K * α = (y - yMean)
  let L: number[][];
  try {
    L = choleskyDecompose(K);
  } catch (err) {
    // 训练点高度重合时 K 仍可能非正定；fallback 返回保守先验
    logger.warn(`[bayesian] GP Cholesky failed: ${(err as Error).message}`);
    return { mean: yMean, variance: 1, std: 1 };
  }
  const yCentered = trainingPoints.map(tp => tp.y - yMean);
  const z = solveLowerTriangular(L, yCentered);
  const alpha = solveUpperTriangular(L, z);

  // 4. k(x, X) 向量
  const kStar = new Array(n);
  for (let i = 0; i < n; i++) {
    kStar[i] = rbfKernel(xQuery, trainingPoints[i].x, lengthScale);
  }

  // 5. μ(x) = k(x,X) · α + yMean
  let mean = yMean;
  for (let i = 0; i < n; i++) mean += kStar[i] * alpha[i];

  // 6. σ²(x) = k(x,x) - k(x,X)^T * K^{-1} * k(x,X)
  //       =  k(x,x) - v^T * v，其中 v = L^{-1} * k(x,X)
  const v = solveLowerTriangular(L, kStar);
  let vDotV = 0;
  for (let i = 0; i < n; i++) vDotV += v[i] * v[i];
  const kxx = rbfKernel(xQuery, xQuery, lengthScale); // = 1 for RBF self
  const variance = Math.max(0, kxx - vDotV);
  return { mean, variance, std: Math.sqrt(variance) };
}

/**
 * 初始拟随机均匀采样（Latin-Hypercube-like 简化版）。
 *
 * 在 [0,1]^D 内对每个维度独立分成 n 个 bins，每个 bin 内取一个 jittered 中点。
 * 比纯随机更均匀；比完整 Sobol 序列简单（无需查表 / Gray code）。对 ≤ 20 init
 * points 完全够用，n ≥ 20 时退化为随机均匀（避免分箱过密的视觉伪规律）。
 *
 * 同 seed → 完全相同初始采样序列。
 */
export function sampleInitialPoints(
  bounds: ParamBounds,
  n: number,
  seed = 42
): Array<Record<string, any>> {
  const rng = new SeededRandom(seed);
  const keys = Object.keys(bounds);
  const D = keys.length;
  if (n <= 0 || D === 0) return [];

  if (n < 20) {
    // Latin-Hypercube 风格：每维独立分 n 个 bins + jitter
    const dimSamples: number[][] = []; // [dim][bin] = sample in [0,1]
    for (let d = 0; d < D; d++) {
      const samples: number[] = [];
      for (let b = 0; b < n; b++) {
        // bin [b/n, (b+1)/n] 内 jitter
        samples.push((b + rng.next()) / n);
      }
      // 在维度内 shuffle 让 bins 不与序号绑定
      for (let i = samples.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [samples[i], samples[j]] = [samples[j], samples[i]];
      }
      dimSamples.push(samples);
    }
    // 组合每个 bin 序号下的 D 个维度值
    const points: Array<Record<string, any>> = [];
    for (let b = 0; b < n; b++) {
      const normalized: number[] = [];
      for (let d = 0; d < D; d++) normalized.push(dimSamples[d][b]);
      points.push(denormalizeParams(normalized, bounds));
    }
    return points;
  }

  // n >= 20：直接均匀随机
  const points: Array<Record<string, any>> = [];
  for (let i = 0; i < n; i++) {
    const normalized: number[] = [];
    for (let d = 0; d < D; d++) normalized.push(rng.next());
    points.push(denormalizeParams(normalized, bounds));
  }
  return points;
}

/**
 * 在 [0,1]^D 上构造稀疏 candidate 网格 + 当前最优点周围加密。EI 在此网格上
 * 评估，取 argmax 作为下一个采样点。维度 > 4 时不全展开 cartesian product
 * 而是混合随机采样避免内存爆炸。
 */
export function generateEICandidates(
  bounds: ParamBounds,
  gridSize: number,
  rng: SeededRandom,
  bestNormalized: number[] | null = null
): number[][] {
  const D = Object.keys(bounds).length;
  if (D === 0) return [];

  // 单维 / 二维：可以全 cartesian
  const totalIfCartesian = Math.pow(gridSize, D);
  const useCartesian = D <= 3 && totalIfCartesian <= 200_000;

  const candidates: number[][] = [];

  if (useCartesian) {
    // 全 cartesian：每维 gridSize 个均匀点
    const axis = new Array(gridSize);
    for (let i = 0; i < gridSize; i++) axis[i] = i / (gridSize - 1);
    // 递归展开 cartesian
    let combos: number[][] = [[]];
    for (let d = 0; d < D; d++) {
      const next: number[][] = [];
      for (const c of combos) {
        for (let i = 0; i < gridSize; i++) next.push([...c, axis[i]]);
      }
      combos = next;
    }
    for (const c of combos) candidates.push(c);
  } else {
    // 高维：随机采样 gridSize * D * 4 个点（保持探索密度可控）
    const target = Math.min(50_000, gridSize * D * 4);
    for (let i = 0; i < target; i++) {
      const point = new Array(D);
      for (let d = 0; d < D; d++) point[d] = rng.next();
      candidates.push(point);
    }
  }

  // 在最优点周围加密 32 个 jittered 候选（local refinement）
  if (bestNormalized) {
    for (let i = 0; i < 32; i++) {
      const point = new Array(D);
      for (let d = 0; d < D; d++) {
        const jitter = (rng.next() - 0.5) * 0.1; // ±0.05 在归一化空间
        point[d] = Math.max(0, Math.min(1, bestNormalized[d] + jitter));
      }
      candidates.push(point);
    }
  }

  return candidates;
}

/**
 * 在 candidate 网格上算 EI 取 argmax。tie-break by 最小欧式 distance 到任一
 * 已观测点（避免连续选同一点导致 GP 退化）。
 */
export function pickNextByEI(
  candidates: number[][],
  observations: ObservedPoint[],
  bestScore: number,
  lengthScale: number,
  jitter: number,
  xi: number
): { point: number[]; ei: number } {
  if (candidates.length === 0) {
    throw new Error('pickNextByEI: candidates 为空');
  }
  const trainingPoints = observations.map(o => ({ x: o.normalized, y: o.score }));
  let bestEI = -Infinity;
  let bestPoint: number[] = candidates[0];
  for (const cand of candidates) {
    const { mean, std } = gaussianProcessPosterior(cand, trainingPoints, lengthScale, jitter);
    const ei = expectedImprovement(mean, std, bestScore, xi);
    if (ei > bestEI) {
      bestEI = ei;
      bestPoint = cand;
    } else if (ei === bestEI && observations.length > 0) {
      // tie-break：远离已观测点的优先
      const candMinDist = minDistanceTo(cand, observations);
      const bestMinDist = minDistanceTo(bestPoint, observations);
      if (candMinDist > bestMinDist) {
        bestPoint = cand;
      }
    }
  }
  return { point: bestPoint, ei: bestEI };
}

function minDistanceTo(x: number[], observations: ObservedPoint[]): number {
  let min = Infinity;
  for (const o of observations) {
    let sq = 0;
    for (let i = 0; i < x.length; i++) {
      const d = x[i] - o.normalized[i];
      sq += d * d;
    }
    if (sq < min) min = sq;
  }
  return Math.sqrt(min);
}

function roundTo(value: number, digits: number): number {
  const k = Math.pow(10, digits);
  return Math.round(value * k) / k;
}

function isFiniteOrNull(value: number | undefined | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? roundTo(n, 4) : null;
}

function validateBounds(bounds: ParamBounds): void {
  const keys = Object.keys(bounds);
  if (keys.length === 0) {
    throw new Error('param_bounds 为空 — 至少要 1 个维度');
  }
  for (const key of keys) {
    const b = bounds[key];
    if (!b || typeof b.min !== 'number' || typeof b.max !== 'number') {
      throw new Error(`param_bounds.${key}: 缺少 min / max 字段`);
    }
    if (!Number.isFinite(b.min) || !Number.isFinite(b.max)) {
      throw new Error(`param_bounds.${key}: min / max 必须是有限数 (got ${b.min}, ${b.max})`);
    }
    if (b.min >= b.max) {
      throw new Error(`param_bounds.${key}: min (${b.min}) 必须 < max (${b.max})`);
    }
  }
}

// ============================================================
// Main optimizer class
// ============================================================

export class BayesianOptimizer {
  /**
   * 单次完整贝叶斯优化入口。流程：
   *   1. 校验 strategy_key + param_bounds
   *   2. （可选）写 OptimizationRun.status='running'（optimizer_type='bayesian'）
   *   3. 第 1 阶段：跑 init_points 次拟随机均匀采样建立 GP 先验
   *   4. 第 2 阶段：剩余 (iterations - init_points) 次按 EI 推荐采样点
   *   5. 每次采样 try/catch 失败隔离（失败点不进入 GP 训练集）
   *   6. 整轮结束后 computeCompositeScore + sort DESC 找冠军
   *   7. （可选）写 N 行 OptimizationResult + 回写 OptimizationRun.best_result_id
   *   8. 返回 { run, results, best, ranked, diagnostics }
   *
   * persist=false 时返回的 OptimizationResult 是 in-memory 对象（未触 DB）。
   */
  async optimize(
    input: BayesianOptimizeInput,
    options: BayesianOptimizeOptions = {}
  ): Promise<BayesianOptimizeResult> {
    const persist = options.persist !== false;
    const runner = options.runner || defaultBacktestRunner;
    const weights = {
      sharpe: options.weights?.sharpe ?? DEFAULT_COMPOSITE_WEIGHTS.sharpe,
      annual: options.weights?.annual ?? DEFAULT_COMPOSITE_WEIGHTS.annual,
      drawdown: options.weights?.drawdown ?? DEFAULT_COMPOSITE_WEIGHTS.drawdown,
    };
    const lengthScale = options.kernel_length_scale ?? 0.3;
    const jitter = options.kernel_jitter ?? 1e-6;
    const xi = options.exploration_xi ?? 0.01;
    const seed = options.seed ?? 42;
    const eiGridSize = Math.max(8, Math.floor(options.ei_candidate_grid_size ?? 64));

    // (1) 校验 strategy + bounds
    if (!options.runner) {
      const exists = strategyRegistry.get(input.strategy_key);
      if (!exists) {
        throw new Error(
          `BayesianOptimizer.optimize: strategy_key='${input.strategy_key}' 未在 StrategyRegistry 中注册`
        );
      }
    }
    validateBounds(input.param_bounds);

    const D = Object.keys(input.param_bounds).length;
    const requestedIterations = Math.max(1, Math.floor(options.iterations ?? 30));
    const maxIterations = Math.min(Math.max(1, Math.floor(options.max_iterations ?? 200)), 4096);
    const iterations = Math.min(requestedIterations, maxIterations);
    const requestedInit = options.init_points ?? Math.max(5, Math.ceil(2 * D));
    const initPoints = Math.min(Math.max(1, Math.floor(requestedInit)), iterations);

    logger.info(
      `[bayesian] start: strategy=${input.strategy_key} D=${D} iterations=${iterations} init_points=${initPoints} seed=${seed}`
    );

    // (2) 写 OptimizationRun
    let run: OptimizationRun | null = null;
    if (persist) {
      run = await OptimizationRun.create({
        optimizer_type: 'bayesian',
        strategy_name: input.strategy_key,
        param_grid_json: input.param_bounds,
        backtest_config_json: input.base_config as Record<string, any>,
        status: 'running',
        total_combos: iterations,
        completed_combos: 0,
        failed_combos: 0,
        created_by: options.user_id,
        started_at: new Date(),
      });
    }

    // (3) 初始采样
    const rng = new SeededRandom(seed);
    const initialParamsList = sampleInitialPoints(input.param_bounds, initPoints, seed);

    const results: OptimizationResultRecord[] = [];
    const observations: ObservedPoint[] = [];
    let failedCount = 0;
    let bestObservedScore = -Infinity;

    try {
      for (let iter = 0; iter < iterations; iter++) {
        let params: Record<string, any>;
        if (iter < initialParamsList.length) {
          // init 阶段：用预先采样的均匀点
          params = initialParamsList[iter];
        } else {
          // EI 阶段：根据当前 observations 找下一个采样点
          const lastBest = observations.find(
            o => o.score === Math.max(...observations.map(p => p.score))
          );
          const bestNormalized = lastBest ? lastBest.normalized : null;
          const candidates = generateEICandidates(
            input.param_bounds,
            eiGridSize,
            rng,
            bestNormalized
          );
          const { point } = pickNextByEI(
            candidates,
            observations,
            bestObservedScore,
            lengthScale,
            jitter,
            xi
          );
          params = denormalizeParams(point, input.param_bounds);
        }

        const fullOptions: QuantBacktestOptions = {
          ...input.base_config,
          strategy_keys: [input.strategy_key],
          params_by_strategy: {
            [input.strategy_key]: params,
          },
        };

        const t0 = Date.now();
        let summary: Awaited<ReturnType<BacktestRunner>> | null = null;
        let errorMessage: string | null = null;
        try {
          summary = await runner({ params, index: iter }, fullOptions);
        } catch (err) {
          errorMessage = err instanceof Error ? err.message : String(err);
          failedCount += 1;
          logger.warn(`[bayesian] iter #${iter} failed for ${input.strategy_key}: ${errorMessage}`);
        }
        const durationSeconds = (Date.now() - t0) / 1000;

        if (summary) {
          const score = computeCompositeScore(summary, weights);
          const record: OptimizationResultRecord = {
            id: 0,
            run_id: run?.id ?? 0,
            combo_index: iter,
            params_json: params,
            sharpe: roundTo(summary.sharpe, 4),
            annual_return: roundTo(summary.annual_return, 4),
            max_drawdown: roundTo(Math.abs(summary.max_drawdown), 4),
            total_return: isFiniteOrNull(summary.total_return),
            win_rate: isFiniteOrNull(summary.win_rate),
            trade_count: summary.trade_count ?? null,
            composite_score: score,
            status: 'completed',
            error_message: null,
            duration_seconds: roundTo(durationSeconds, 3),
          };
          if (persist && run) {
            const created = await OptimizationResult.create(record as any);
            record.id = created.id;
          }
          results.push(record);

          // 只有成功且 composite_score 有限的点才进入 GP 训练集
          if (score !== null && Number.isFinite(score)) {
            observations.push({
              normalized: normalizeParams(params, input.param_bounds),
              score,
              params,
            });
            if (score > bestObservedScore) bestObservedScore = score;
          }
        } else {
          const record: OptimizationResultRecord = {
            id: 0,
            run_id: run?.id ?? 0,
            combo_index: iter,
            params_json: params,
            sharpe: null,
            annual_return: null,
            max_drawdown: null,
            total_return: null,
            win_rate: null,
            trade_count: null,
            composite_score: null,
            status: 'failed',
            error_message: errorMessage,
            duration_seconds: roundTo(durationSeconds, 3),
          };
          if (persist && run) {
            const created = await OptimizationResult.create(record as any);
            record.id = created.id;
          }
          results.push(record);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (run) {
        await run.update({
          status: 'failed',
          error_message: message,
          finished_at: new Date(),
          completed_combos: results.length,
          failed_combos: failedCount,
        });
      }
      throw err;
    }

    // 排序 + best
    const ranked = sortByCompositeScoreDesc(results);
    const best = ranked.find(r => r.status === 'completed' && r.composite_score !== null) || null;

    // Sprint 43-E: DSR 防过拟合 (与 GridSearchOptimizer 同款)
    let dsrSummary: any = null;
    try {
      const completed = results.filter(r => r.status === 'completed' && Number.isFinite(r.sharpe));
      if (best && completed.length >= 2 && Number.isFinite(best.sharpe)) {
        const sharpes = completed.map(r => Number(r.sharpe));
        const meanSharpe = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
        const varSharpe =
          sharpes.reduce((s, v) => s + (v - meanSharpe) ** 2, 0) / Math.max(sharpes.length - 1, 1);
        const dsr = deflatedSharpeRatio({
          observed_sharpe: Number(best.sharpe),
          n_trials: completed.length,
          variance_of_trials: varSharpe,
          n_observations: 252,
          skewness: 0,
          excess_kurtosis: 0,
        });
        dsrSummary = {
          observed_sharpe: best.sharpe,
          n_trials: completed.length,
          variance_of_trials: varSharpe,
          expected_max_sharpe: dsr.expected_max_sharpe,
          deflated_sharpe: dsr.deflated_sharpe,
          is_significant: dsr.is_significant,
          explanation: dsr.explanation,
        };
        logger.info(
          `[bayesian] DSR for ${input.strategy_key}: best_sharpe=${best.sharpe} N=${
            completed.length
          } → DSR=${dsr.deflated_sharpe.toFixed(3)} ${
            dsr.is_significant ? '✓ 显著' : '✗ 可能过拟合'
          }`
        );
      }
    } catch (dsrErr: any) {
      logger.warn(`[bayesian] DSR 计算失败 (fail-open): ${dsrErr?.message || dsrErr}`);
    }

    if (persist && run) {
      const existingMeta = (run as any).metadata_json || {};
      await run.update({
        status: 'completed',
        completed_combos: results.length,
        failed_combos: failedCount,
        best_result_id: best?.id ?? null,
        finished_at: new Date(),
        metadata_json: dsrSummary ? { ...existingMeta, deflated_sharpe: dsrSummary } : existingMeta,
      });
    }

    logger.info(
      `[bayesian] done: iter=${results.length} failed=${failedCount} best_score=${
        best?.composite_score ?? 'none'
      }`
    );

    return {
      run,
      results,
      best,
      ranked,
      iterations_run: results.length,
      failed_iterations: failedCount,
      init_iterations: Math.min(initialParamsList.length, results.length),
      ei_iterations: Math.max(0, results.length - initialParamsList.length),
    };
  }

  /**
   * 查询一个 OptimizationRun 的所有 results，已按 composite_score 排序。
   * 与 GridSearchOptimizer.getRunResults() 同样行为；让 caller 用同一段代码
   * 消费两种优化器历史。
   */
  async getRunResults(run_id: number): Promise<OptimizationResultRecord[]> {
    const rows = await OptimizationResult.findAll({
      where: { run_id },
      order: [['combo_index', 'ASC']],
    });
    const records = rows.map(modelToRecord);
    return sortByCompositeScoreDesc(records);
  }

  /**
   * 列出指定 strategy 的最近 N 个 Bayesian OptimizationRun（已完成的）。
   * 默认只列 optimizer_type='bayesian' 的 run；传 includeAllTypes=true 一并列
   * grid_search 行（用于"我所有调优历史"视图）。
   */
  async listRuns(
    options: {
      strategy_name?: string;
      limit?: number;
      user_id?: number;
      include_all_types?: boolean;
    } = {}
  ): Promise<OptimizationRun[]> {
    const where: Record<string, any> = {};
    if (options.strategy_name) where.strategy_name = options.strategy_name;
    if (options.user_id) where.created_by = options.user_id;
    if (!options.include_all_types) where.optimizer_type = 'bayesian';
    return OptimizationRun.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(options.limit || 30), 1), 200),
    });
  }

  /**
   * 删除一个 run + 所有相关 results（CLI --clean 用）。共享 GridSearchOptimizer
   * 的 cleanup 行为；不区分 optimizer_type，按 run_id 精确删。
   */
  async deleteRun(run_id: number): Promise<{ deleted_results: number; deleted_run: number }> {
    const deleted_results = await OptimizationResult.destroy({ where: { run_id } });
    const deleted_run = await OptimizationRun.destroy({ where: { id: run_id } });
    return { deleted_results, deleted_run };
  }

  /**
   * 清理 N 天前的所有 Bayesian OptimizationRun + 关联 results。
   * 故意不动 grid_search 的行（CLI 各自管各自的）。
   */
  async cleanupOlderThan(days: number): Promise<{ deleted_runs: number; deleted_results: number }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const oldRuns = await OptimizationRun.findAll({
      where: {
        created_at: { [Op.lt]: cutoff },
        optimizer_type: 'bayesian',
      },
      attributes: ['id'],
    });
    const runIds = oldRuns.map(r => r.id);
    if (!runIds.length) return { deleted_runs: 0, deleted_results: 0 };
    const deleted_results = await OptimizationResult.destroy({
      where: { run_id: { [Op.in]: runIds } },
    });
    const deleted_runs = await OptimizationRun.destroy({
      where: { id: { [Op.in]: runIds } },
    });
    return { deleted_runs, deleted_results };
  }
}

/**
 * 把 Sequelize 的 OptimizationResult model 实例转成 plain record。
 * 复刻 GridSearchOptimizer 中 modelToRecord（避免循环依赖）。
 */
function modelToRecord(row: OptimizationResult): OptimizationResultRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    combo_index: row.combo_index,
    params_json: row.params_json,
    sharpe: row.sharpe === null || row.sharpe === undefined ? null : Number(row.sharpe),
    annual_return:
      row.annual_return === null || row.annual_return === undefined
        ? null
        : Number(row.annual_return),
    max_drawdown:
      row.max_drawdown === null || row.max_drawdown === undefined ? null : Number(row.max_drawdown),
    total_return:
      row.total_return === null || row.total_return === undefined ? null : Number(row.total_return),
    win_rate: row.win_rate === null || row.win_rate === undefined ? null : Number(row.win_rate),
    trade_count:
      row.trade_count === null || row.trade_count === undefined ? null : Number(row.trade_count),
    composite_score:
      row.composite_score === null || row.composite_score === undefined
        ? null
        : Number(row.composite_score),
    status: row.status as OptimizationResultRecord['status'],
    error_message: row.error_message ?? null,
    duration_seconds:
      row.duration_seconds === null || row.duration_seconds === undefined
        ? null
        : Number(row.duration_seconds),
  };
}

// Default singleton (使用模式同 gridSearchOptimizer / backtestEngine 等)
export const bayesianOptimizer = new BayesianOptimizer();
