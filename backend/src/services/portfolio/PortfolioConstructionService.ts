/**
 * PortfolioConstructionService — Sprint 2B 股票级风险预算组合构造
 *
 * 与 PortfolioOptimizer（US-044 *策略级* 权重组合）不同：本 service 是**股票级**
 * 组合构造。输入 M 只候选股票 + 历史日收益序列（或 cov 矩阵）+ 约束，输出
 * 满足约束的权重。
 *
 * **方法**：
 *
 *   1. **risk_parity** (默认) — Equal Risk Contribution
 *      用 cyclic coordinate descent: 每次迭代将 w_i ← w_i × sqrt((V/N) / RC_i)
 *      让每只票对组合 variance 的贡献相等。低 vol 股自动多权，高 vol 股自动少权。
 *
 *   2. **min_variance** — Minimum Variance Portfolio
 *      投影梯度下降 minimize w^T * cov * w s.t. sum(w)=1
 *
 *   3. **equal_weight** — 1/N baseline
 *
 *   4. **max_sharpe** — 期望收益 + variance trade-off (需要 alpha_scores 作为 mu)
 *
 * **约束**:
 *   - sum(w) = total_allocation ∈ [0, 1]（< 1 留现金）
 *   - 每只 w_i ∈ [min_weight, max_weight] (默认 0%-15%)
 *   - 行业暴露 ∈ [min_industry, max_industry] (默认 0%-40%)
 *   - factor exposure (可选): 通过 alpha_factor_loadings 限制
 *
 * **设计选择**：
 *   - cov_matrix 可以直接传入，或者从 daily_returns_matrix 自动估算
 *     (sample covariance, n-1 denominator)
 *   - 与 PortfolioOptimizer 共用 projectOntoSimplexWithBox 投影
 *   - 所有核心算法 pure function 单测
 *   - 持久化可选 (默认 false; 每日构造一次时由 caller 显式 enable)
 */

import { Op } from 'sequelize';
import { PortfolioConstructionResult } from '../../models/PortfolioConstructionResult';
import { projectOntoSimplexWithBox } from '../../quant/backtest/PortfolioOptimizer';
import { ledoitWolfCovariance } from './ledoit-wolf';
import { hierarchicalRiskParity } from './hrp';
import { logger } from '../../utils/logger';

// ============================================================
// Constants
// ============================================================

export const DEFAULT_MAX_WEIGHT = 0.15;
export const DEFAULT_MIN_WEIGHT = 0.0;
export const DEFAULT_MAX_INDUSTRY_WEIGHT = 0.40;
export const DEFAULT_TOTAL_ALLOCATION = 0.95;
export const DEFAULT_MAX_ITERATIONS = 500;
export const DEFAULT_TOLERANCE = 1e-6;

export type ConstructionMethod = 'risk_parity' | 'equal_weight' | 'min_variance' | 'max_sharpe' | 'hrp';

/** 协方差估计方法 (v2) */
export type CovarianceEstimator = 'sample' | 'ledoit_wolf';

// ============================================================
// Types
// ============================================================

export interface CandidateStock {
  symbol: string;
  /** 一层 alpha_score 0-100（max_sharpe 模式必填） */
  alpha_score?: number | null;
  /** 行业（行业暴露约束用） */
  industry?: string | null;
  /** 历史日收益序列（cov 估算用；max_sharpe 也用 mean 估收益） */
  daily_returns?: number[];
}

export interface ConstructionInput {
  user_id?: number | null;
  as_of_date: string;
  candidates: CandidateStock[];
  /** 直接提供 cov 矩阵（NxN）；如果不传则从 candidates.daily_returns 估算 */
  cov_matrix?: number[][];
  /** 直接提供期望收益 vector (max_sharpe 用)；不传则从 daily_returns mean 估算 */
  expected_returns?: number[];
}

export interface ConstructionOptions {
  method?: ConstructionMethod;
  max_weight?: number;
  min_weight?: number;
  max_industry_weight?: number;
  total_allocation?: number;
  max_iterations?: number;
  tolerance?: number;
  persist?: boolean;
  /** risk aversion λ for max_sharpe (越大越保守) */
  risk_aversion?: number;
  /** v2: 协方差估计方法 (sample / ledoit_wolf 默认 sample) */
  cov_estimator?: CovarianceEstimator;
}

export interface ConstructionResult {
  symbols: string[];
  weights: number[];
  risk_contributions: number[];
  industry_exposure: Record<string, number>;
  total_allocation: number;
  converged: boolean;
  iterations: number;
  method: ConstructionMethod;
  expected_volatility: number | null;
  expected_return: number | null;
  sharpe_estimate: number | null;
  constraints: {
    max_weight: number;
    min_weight: number;
    max_industry_weight: number;
    total_allocation: number;
  };
  summary: string;
  persisted_id: number | null;
  generated_at: Date;
}

// ============================================================
// Pure helpers (full export)
// ============================================================

/**
 * 从 daily_returns 矩阵估算 sample covariance (N×N)
 *
 * - returns: M 个资产 × T 天 (returns[i][t])
 * - 输出 N×N matrix
 * - n-1 denominator
 * - 任一 asset 数据长度 < 2 → 抛错
 */
export function estimateCovariance(returns: number[][]): number[][] {
  const N = returns.length;
  if (N === 0) return [];
  const T = returns[0].length;
  if (T < 2) {
    throw new Error(`estimateCovariance: 需要 ≥ 2 个日收益，得到 ${T}`);
  }
  // 检查所有 asset 长度一致
  for (let i = 0; i < N; i += 1) {
    if (returns[i].length !== T) {
      throw new Error(
        `estimateCovariance: asset[${i}] length ${returns[i].length} != asset[0] length ${T}`
      );
    }
  }
  // means
  const means: number[] = [];
  for (let i = 0; i < N; i += 1) {
    let s = 0;
    for (let t = 0; t < T; t += 1) s += returns[i][t];
    means.push(s / T);
  }
  // cov
  const cov: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    for (let j = i; j < N; j += 1) {
      let s = 0;
      for (let t = 0; t < T; t += 1) {
        s += (returns[i][t] - means[i]) * (returns[j][t] - means[j]);
      }
      const c = s / (T - 1);
      cov[i][j] = c;
      cov[j][i] = c;
    }
  }
  return cov;
}

/**
 * 组合 variance = w^T * cov * w
 */
export function computePortfolioVariance(weights: number[], cov: number[][]): number {
  const N = weights.length;
  if (cov.length !== N) throw new Error(`cov size ${cov.length} != weights length ${N}`);
  let v = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      v += weights[i] * weights[j] * cov[i][j];
    }
  }
  return Math.max(0, v);
}

/**
 * 每只票的边际风险贡献 = w_i * (cov * w)_i
 *
 * sum(RC_i) = portfolio variance
 */
export function computeRiskContributions(weights: number[], cov: number[][]): number[] {
  const N = weights.length;
  const out = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    let row = 0;
    for (let j = 0; j < N; j += 1) row += cov[i][j] * weights[j];
    out[i] = weights[i] * row;
  }
  return out;
}

/**
 * Cyclic Coordinate Descent for Equal Risk Contribution (ERC)
 *
 * 算法（Maillard, Roncalli, Teïletche 2010）：
 *   - 初始化 w = [1/N]
 *   - while not converged:
 *     - V = w^T * cov * w
 *     - RC_i = w_i * (cov * w)_i
 *     - target = V / N
 *     - w_i ← w_i * sqrt(target / RC_i)  ∀i
 *     - 归一化 sum(w) = 1
 *     - 检查 max|RC_i - target| / V < tol
 *
 * 收敛速度对凸 cov 矩阵几何收敛；50-200 iter 足够。
 */
export function solveERC(
  cov: number[][],
  options: { max_iterations?: number; tolerance?: number } = {}
): { weights: number[]; iterations: number; converged: boolean } {
  const N = cov.length;
  if (N === 0) return { weights: [], iterations: 0, converged: true };

  const max_iter = options.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;

  let w = new Array(N).fill(1 / N);
  let converged = false;
  let iter = 0;

  for (iter = 0; iter < max_iter; iter += 1) {
    const V = computePortfolioVariance(w, cov);
    if (V <= 0 || !Number.isFinite(V)) break;
    const RC = computeRiskContributions(w, cov);
    const target = V / N;

    // 检查收敛
    let maxDeviation = 0;
    for (let i = 0; i < N; i += 1) {
      const d = Math.abs(RC[i] - target) / V;
      if (d > maxDeviation) maxDeviation = d;
    }
    if (maxDeviation < tol) {
      converged = true;
      break;
    }

    // 更新 w_i ← w_i * sqrt(target / RC_i)
    // 边界: RC_i ≤ 0 (cov 矩阵非正定时可能发生) → 不更新该维度
    const wNext = w.slice();
    for (let i = 0; i < N; i += 1) {
      if (RC[i] > 1e-12) {
        wNext[i] = w[i] * Math.sqrt(target / RC[i]);
      }
    }
    // 归一化
    const sum = wNext.reduce((s, v) => s + v, 0);
    if (sum > 0) {
      w = wNext.map(v => v / sum);
    } else {
      break;
    }
  }
  return { weights: w, iterations: iter, converged };
}

/**
 * 最小方差组合 (无 short-sell, sum=1)
 *
 * 用投影梯度下降:
 *   - 起点: equal_weight
 *   - 梯度 grad = 2 * cov * w
 *   - w_next = projectOntoSimplexWithBox(w - lr * grad, min, max)
 *   - 收敛: |V_new - V_old| < tol
 */
export function solveMinVariance(
  cov: number[][],
  minW: number,
  maxW: number,
  options: { max_iterations?: number; tolerance?: number; learning_rate?: number } = {}
): { weights: number[]; iterations: number; converged: boolean } {
  const N = cov.length;
  if (N === 0) return { weights: [], iterations: 0, converged: true };

  const max_iter = options.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const lr = options.learning_rate ?? 0.5;

  let w = projectOntoSimplexWithBox(new Array(N).fill(1 / N), minW, maxW);
  let prevV = computePortfolioVariance(w, cov);
  let converged = false;
  let iter = 0;

  for (iter = 0; iter < max_iter; iter += 1) {
    // 梯度 = 2 * cov * w
    const grad = new Array(N).fill(0);
    for (let i = 0; i < N; i += 1) {
      let s = 0;
      for (let j = 0; j < N; j += 1) s += cov[i][j] * w[j];
      grad[i] = 2 * s;
    }
    // gradient descent: w - lr * grad (minimize)
    const wRaw = w.map((v, i) => v - lr * grad[i]);
    let wNext: number[];
    try {
      wNext = projectOntoSimplexWithBox(wRaw, minW, maxW);
    } catch (err) {
      logger.warn(`[portfolio-construction] min_variance projection failed: ${(err as Error).message}`);
      break;
    }
    const V = computePortfolioVariance(wNext, cov);
    if (Math.abs(V - prevV) < tol) {
      w = wNext;
      converged = true;
      break;
    }
    w = wNext;
    prevV = V;
  }
  return { weights: w, iterations: iter, converged };
}

/**
 * Max Sharpe (mean-variance) — 优化 mu^T * w - lambda * w^T * cov * w
 *
 * 用投影梯度上升:
 *   grad = mu - 2*lambda*cov*w
 *   w_next = projectOntoSimplexWithBox(w + lr * grad, min, max)
 */
export function solveMaxSharpe(
  cov: number[][],
  expectedReturns: number[],
  minW: number,
  maxW: number,
  riskAversion: number,
  options: { max_iterations?: number; tolerance?: number; learning_rate?: number } = {}
): { weights: number[]; iterations: number; converged: boolean } {
  const N = cov.length;
  if (N === 0) return { weights: [], iterations: 0, converged: true };
  if (expectedReturns.length !== N) {
    throw new Error(`solveMaxSharpe: expectedReturns length ${expectedReturns.length} != N=${N}`);
  }

  const max_iter = options.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const lr = options.learning_rate ?? 0.05;

  let w = projectOntoSimplexWithBox(new Array(N).fill(1 / N), minW, maxW);
  let prevObj = -Infinity;
  let converged = false;
  let iter = 0;

  for (iter = 0; iter < max_iter; iter += 1) {
    const grad = new Array(N).fill(0);
    for (let i = 0; i < N; i += 1) {
      let s = 0;
      for (let j = 0; j < N; j += 1) s += cov[i][j] * w[j];
      grad[i] = expectedReturns[i] - 2 * riskAversion * s;
    }
    const wRaw = w.map((v, i) => v + lr * grad[i]);
    let wNext: number[];
    try {
      wNext = projectOntoSimplexWithBox(wRaw, minW, maxW);
    } catch (err) {
      logger.warn(`[portfolio-construction] max_sharpe projection failed: ${(err as Error).message}`);
      break;
    }
    const obj = mvObjective(wNext, expectedReturns, cov, riskAversion);
    if (Math.abs(obj - prevObj) < tol) {
      w = wNext;
      converged = true;
      break;
    }
    w = wNext;
    prevObj = obj;
  }
  return { weights: w, iterations: iter, converged };
}

function mvObjective(w: number[], mu: number[], cov: number[][], lambda: number): number {
  const N = w.length;
  let meanRet = 0;
  for (let i = 0; i < N; i += 1) meanRet += mu[i] * w[i];
  const variance = computePortfolioVariance(w, cov);
  return meanRet - lambda * variance;
}

/**
 * 应用行业暴露约束（cap 后归一化）
 *   - 计算每行业当前总权重
 *   - 超过 cap 的行业按比例缩放
 *   - 缩出的权重按比例分给未触顶行业 / 现金
 */
export function applyIndustryConstraints(
  symbols: string[],
  weights: number[],
  industries: Array<string | null | undefined>,
  maxIndustryWeight: number
): number[] {
  if (industries.length !== weights.length) {
    throw new Error(
      `applyIndustryConstraints: industries length ${industries.length} != weights length ${weights.length}`
    );
  }
  const industryTotals = new Map<string, number>();
  for (let i = 0; i < weights.length; i += 1) {
    const ind = String(industries[i] || 'UNKNOWN');
    industryTotals.set(ind, (industryTotals.get(ind) || 0) + weights[i]);
  }
  // 找超 cap 的行业
  const overCapIndustries = new Set<string>();
  for (const [ind, total] of industryTotals) {
    if (total > maxIndustryWeight + 1e-9) overCapIndustries.add(ind);
  }
  if (overCapIndustries.size === 0) return weights.slice();

  // 缩放超 cap 行业内的权重
  const out = weights.slice();
  for (const ind of overCapIndustries) {
    const total = industryTotals.get(ind)!;
    const scale = maxIndustryWeight / total;
    for (let i = 0; i < weights.length; i += 1) {
      const stockInd = String(industries[i] || 'UNKNOWN');
      if (stockInd === ind) out[i] = weights[i] * scale;
    }
  }
  return out;
}

/**
 * 按 total_allocation 缩放（< 1 留现金）
 */
export function scaleToTotalAllocation(weights: number[], totalAllocation: number): number[] {
  const sum = weights.reduce((s, v) => s + v, 0);
  if (sum <= 0) return weights.slice();
  return weights.map(v => (v / sum) * totalAllocation);
}

/**
 * 行业暴露 dict {industry: pct}
 */
export function computeIndustryExposure(
  weights: number[],
  industries: Array<string | null | undefined>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < weights.length; i += 1) {
    const ind = String(industries[i] || 'UNKNOWN');
    out[ind] = (out[ind] || 0) + weights[i];
  }
  for (const k in out) {
    out[k] = Math.round(out[k] * 10000) / 10000;
  }
  return out;
}

function buildSummaryMsg(input: {
  method: ConstructionMethod;
  N: number;
  weights: number[];
  industryExposure: Record<string, number>;
  totalAllocation: number;
  expectedVol: number | null;
  expectedReturn: number | null;
}): string {
  const { method, N, weights, industryExposure, totalAllocation, expectedVol, expectedReturn } = input;
  const top3 = weights
    .map((w, i) => ({ i, w }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 3)
    .map(({ w }) => (w * 100).toFixed(1) + '%');
  const topIndustries = Object.entries(industryExposure)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`);
  const parts: string[] = [
    `${method} 组合 (N=${N}, 总仓=${(totalAllocation * 100).toFixed(0)}%)`,
    `top3 权重=${top3.join(',')}`,
    `行业=${topIndustries.join('|')}`,
  ];
  if (expectedVol !== null) parts.push(`σ=${(expectedVol * 100).toFixed(2)}%`);
  if (expectedReturn !== null) parts.push(`μ=${(expectedReturn * 100).toFixed(2)}%`);
  return parts.join('; ');
}

// ============================================================
// Service
// ============================================================

export class PortfolioConstructionService {
  /**
   * 构造组合权重
   */
  async construct(
    input: ConstructionInput,
    options: ConstructionOptions = {}
  ): Promise<ConstructionResult> {
    const method = options.method ?? 'risk_parity';
    const maxW = options.max_weight ?? DEFAULT_MAX_WEIGHT;
    const minW = options.min_weight ?? DEFAULT_MIN_WEIGHT;
    const maxInd = options.max_industry_weight ?? DEFAULT_MAX_INDUSTRY_WEIGHT;
    const totalAlloc = options.total_allocation ?? DEFAULT_TOTAL_ALLOCATION;
    const maxIter = options.max_iterations ?? DEFAULT_MAX_ITERATIONS;
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    const persist = options.persist === true;
    const riskAversion = options.risk_aversion ?? 1.0;

    const N = input.candidates.length;
    if (N === 0) {
      throw new Error('PortfolioConstructionService.construct: candidates 不能为空');
    }
    if (N === 1) {
      // 单只票直接 100%
      const w = totalAlloc;
      return this.buildSingleAssetResult(input, w, method, persist);
    }

    // 准备 cov
    let cov = input.cov_matrix;
    let covShrinkage: number | null = null;
    if (!cov) {
      const returnsMatrix = input.candidates.map(c => c.daily_returns || []);
      const validLength = returnsMatrix[0].length;
      if (validLength < 2 || returnsMatrix.some(r => r.length !== validLength)) {
        // cov 必需但无数据 → 退化到 equal_weight
        logger.warn('[portfolio-construction] cov_matrix 缺失，退化到 equal_weight');
        return this.constructEqualWeight(input, options);
      }
      // v2: Ledoit-Wolf shrinkage (默认 sample cov)
      if (options.cov_estimator === 'ledoit_wolf') {
        // returnsMatrix 是 N×T (每行是一只资产)，LW 需要 T×N
        const T = validLength;
        const M = returnsMatrix.length;
        const xTxN: number[][] = [];
        for (let t = 0; t < T; t += 1) {
          const row: number[] = [];
          for (let i = 0; i < M; i += 1) row.push(returnsMatrix[i][t]);
          xTxN.push(row);
        }
        const lw = ledoitWolfCovariance(xTxN);
        cov = lw.cov;
        covShrinkage = lw.shrinkage;
        logger.info(`[portfolio-construction] Ledoit-Wolf shrinkage applied: δ=${lw.shrinkage.toFixed(4)}, μ=${lw.mu.toFixed(6)}`);
      } else {
        cov = estimateCovariance(returnsMatrix);
      }
    }

    // 求解
    let weights: number[];
    let iterations = 0;
    let converged = false;

    if (method === 'equal_weight') {
      weights = new Array(N).fill(1 / N);
      converged = true;
    } else if (method === 'hrp') {
      // v2: Hierarchical Risk Parity (López de Prado 2016)
      // 不需要 max_weight / min_weight 约束（HRP 自然分配，但事后用 simplex 投影 cap）
      const hrpResult = hierarchicalRiskParity(cov);
      weights = hrpResult.weights;
      iterations = 0;
      converged = true;
      logger.info(`[portfolio-construction] HRP cluster order: [${hrpResult.cluster_order.join(',')}]`);
    } else if (method === 'risk_parity') {
      const r = solveERC(cov, { max_iterations: maxIter, tolerance });
      weights = r.weights;
      iterations = r.iterations;
      converged = r.converged;
    } else if (method === 'min_variance') {
      const r = solveMinVariance(cov, minW, maxW, { max_iterations: maxIter, tolerance });
      weights = r.weights;
      iterations = r.iterations;
      converged = r.converged;
    } else if (method === 'max_sharpe') {
      let expectedReturns = input.expected_returns;
      if (!expectedReturns) {
        // 从 alpha_score 估算（normalize 到 [0, 0.001]）
        expectedReturns = input.candidates.map(c => (c.alpha_score ?? 50) / 100000);
      }
      const r = solveMaxSharpe(cov, expectedReturns, minW, maxW, riskAversion, {
        max_iterations: maxIter,
        tolerance,
      });
      weights = r.weights;
      iterations = r.iterations;
      converged = r.converged;
    } else {
      throw new Error(`PortfolioConstructionService: unknown method ${method}`);
    }

    // 投影到 [minW, maxW] 简形约束
    try {
      // 对 risk_parity 和 hrp 都做事后投影 (其他算法已在算法内投影)
      if (method === 'risk_parity' || method === 'hrp') {
        weights = projectOntoSimplexWithBox(weights, minW, maxW);
      }
    } catch (err: any) {
      logger.warn(`[portfolio-construction] projection failed: ${err?.message}`);
    }

    // 先按 total_allocation 缩放，再 cap 行业（行业 cap 相对总资产）。
    // 这样 cap 不会被后续 scale 回涨，cap 出去的部分作为现金保留。
    const industries = input.candidates.map(c => c.industry || null);
    weights = scaleToTotalAllocation(weights, totalAlloc);
    weights = applyIndustryConstraints(input.candidates.map(c => c.symbol), weights, industries, maxInd);

    // 计算 metrics
    const symbols = input.candidates.map(c => c.symbol);
    const riskContribs = computeRiskContributions(weights, cov);
    const expectedVol = Math.sqrt(computePortfolioVariance(weights, cov));
    let expectedRet: number | null = null;
    if (input.expected_returns && input.expected_returns.length === N) {
      expectedRet = weights.reduce((s, w, i) => s + w * input.expected_returns![i], 0);
    } else if (input.candidates.some(c => c.daily_returns && c.daily_returns.length > 0)) {
      const means = input.candidates.map(c => {
        const rs = c.daily_returns || [];
        if (rs.length === 0) return 0;
        return rs.reduce((s, v) => s + v, 0) / rs.length;
      });
      expectedRet = weights.reduce((s, w, i) => s + w * means[i], 0);
    }
    const sharpeEst =
      expectedRet !== null && expectedVol > 0
        ? Math.round((expectedRet / expectedVol) * Math.sqrt(252) * 10000) / 10000
        : null;

    const industryExposure = computeIndustryExposure(weights, industries);

    const result: ConstructionResult = {
      symbols,
      weights: weights.map(w => Math.round(w * 1000000) / 1000000),
      risk_contributions: riskContribs.map(r => Math.round(r * 1000000) / 1000000),
      industry_exposure: industryExposure,
      total_allocation: Math.round(weights.reduce((s, v) => s + v, 0) * 1000000) / 1000000,
      converged,
      iterations,
      method,
      expected_volatility: expectedVol !== null ? Math.round(expectedVol * 10000) / 10000 : null,
      expected_return: expectedRet !== null ? Math.round(expectedRet * 10000) / 10000 : null,
      sharpe_estimate: sharpeEst,
      constraints: {
        max_weight: maxW,
        min_weight: minW,
        max_industry_weight: maxInd,
        total_allocation: totalAlloc,
      },
      summary: buildSummaryMsg({
        method,
        N,
        weights,
        industryExposure,
        totalAllocation: totalAlloc,
        expectedVol,
        expectedReturn: expectedRet,
      }),
      persisted_id: null,
      generated_at: new Date(),
    };

    // 把 LW shrinkage 信息写到 metadata 让前端 / debug 看到
    if (covShrinkage !== null) {
      (result as any).cov_estimator = options.cov_estimator;
      (result as any).cov_shrinkage = Math.round(covShrinkage * 10000) / 10000;
    }

    if (persist) {
      try {
        const row = await PortfolioConstructionResult.create({
          user_id: input.user_id ?? null,
          as_of_date: input.as_of_date,
          method: result.method,
          n_assets: N,
          symbols_json: result.symbols,
          weights_json: result.weights,
          risk_contributions_json: result.risk_contributions,
          industry_exposure_json: result.industry_exposure,
          total_allocation: result.total_allocation,
          converged: result.converged,
          iterations: result.iterations,
          constraints_json: result.constraints,
          summary: result.summary,
          metadata: {
            expected_volatility: result.expected_volatility,
            expected_return: result.expected_return,
            sharpe_estimate: result.sharpe_estimate,
          },
        });
        result.persisted_id = row.id;
      } catch (err: any) {
        logger.warn(`[portfolio-construction] persist failed: ${err?.message}`);
      }
    }

    return result;
  }

  private async constructEqualWeight(
    input: ConstructionInput,
    options: ConstructionOptions
  ): Promise<ConstructionResult> {
    const N = input.candidates.length;
    const totalAlloc = options.total_allocation ?? DEFAULT_TOTAL_ALLOCATION;
    const maxInd = options.max_industry_weight ?? DEFAULT_MAX_INDUSTRY_WEIGHT;
    let weights = new Array(N).fill(1 / N);
    const industries = input.candidates.map(c => c.industry || null);
    weights = applyIndustryConstraints(input.candidates.map(c => c.symbol), weights, industries, maxInd);
    weights = scaleToTotalAllocation(weights, totalAlloc);
    const industryExposure = computeIndustryExposure(weights, industries);
    return {
      symbols: input.candidates.map(c => c.symbol),
      weights: weights.map(w => Math.round(w * 1000000) / 1000000),
      risk_contributions: weights.map(() => 1 / N),
      industry_exposure: industryExposure,
      total_allocation: Math.round(weights.reduce((s, v) => s + v, 0) * 1000000) / 1000000,
      converged: true,
      iterations: 0,
      method: 'equal_weight',
      expected_volatility: null,
      expected_return: null,
      sharpe_estimate: null,
      constraints: {
        max_weight: options.max_weight ?? DEFAULT_MAX_WEIGHT,
        min_weight: options.min_weight ?? DEFAULT_MIN_WEIGHT,
        max_industry_weight: maxInd,
        total_allocation: totalAlloc,
      },
      summary: `equal_weight 退化组合 (N=${N})`,
      persisted_id: null,
      generated_at: new Date(),
    };
  }

  private async buildSingleAssetResult(
    input: ConstructionInput,
    weight: number,
    method: ConstructionMethod,
    persist: boolean
  ): Promise<ConstructionResult> {
    const r: ConstructionResult = {
      symbols: [input.candidates[0].symbol],
      weights: [Math.round(weight * 1000000) / 1000000],
      risk_contributions: [1.0],
      industry_exposure: { [input.candidates[0].industry || 'UNKNOWN']: weight },
      total_allocation: weight,
      converged: true,
      iterations: 0,
      method,
      expected_volatility: null,
      expected_return: null,
      sharpe_estimate: null,
      constraints: {
        max_weight: 1,
        min_weight: 0,
        max_industry_weight: 1,
        total_allocation: weight,
      },
      summary: `单只票组合: ${input.candidates[0].symbol} (${(weight * 100).toFixed(1)}%)`,
      persisted_id: null,
      generated_at: new Date(),
    };
    if (persist) {
      try {
        const row = await PortfolioConstructionResult.create({
          user_id: input.user_id ?? null,
          as_of_date: input.as_of_date,
          method: r.method,
          n_assets: 1,
          symbols_json: r.symbols,
          weights_json: r.weights,
          risk_contributions_json: r.risk_contributions,
          industry_exposure_json: r.industry_exposure,
          total_allocation: r.total_allocation,
          converged: true,
          iterations: 0,
          constraints_json: r.constraints,
          summary: r.summary,
        });
        r.persisted_id = row.id;
      } catch (err: any) {
        logger.warn(`[portfolio-construction] persist single asset failed: ${err?.message}`);
      }
    }
    return r;
  }

  async listRecent(limit = 30, user_id?: number) {
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const where: any = {};
    if (user_id) where.user_id = user_id;
    return PortfolioConstructionResult.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: safeLimit,
    });
  }

  async cleanupOlderThan(days: number) {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const deleted = await PortfolioConstructionResult.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted };
  }
}

export const portfolioConstructionService = new PortfolioConstructionService();
