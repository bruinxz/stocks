/**
 * PortfolioOptimizer — 多策略组合权重优化（US-044）
 *
 * 输入 N 个策略的历史日收益序列，求解一组权重 (w_1, …, w_N) 使得
 * 组合的夏普比率最大化，约束：
 *   - sum(w_i) = 1 ± epsilon
 *   - 每个 w_i ∈ [min_weight, max_weight]（AC 默认 max_weight=0.4）
 *
 * 输出最优权重 + 组合年化收益 / 夏普 / 最大回撤。
 *
 * **为什么需要组合优化**：
 *   单一策略再好也有 regime 失效期 (MFA 在 bear 段拉胯，DragonHead 在 range 段没信号)。
 *   把 N 个 *已经验证收益* 的策略组合成"权重 0.4-0.3-0.3" 的 portfolio，
 *   利用策略间相关性偏低的特点，可以让组合 sharpe > 任一单策略 sharpe（夏普
 *   improvement = sqrt(N) 在极限"完全不相关 + 同 sharpe"假设下；现实约 1.3-1.7x）。
 *   AC 0.4 单策略上限防止"全押单策略"退化为非组合。
 *
 * **公共接口**：
 *   - `optimize(input, options?)` — 异步执行一次完整求解；选择性写入
 *     StrategyPortfolioResult；返回 { weights, metrics, diagnostics }。
 *   - `getRun(id)` — 查某 id 的结果。
 *   - `listRecentRuns(limit)` — 列出最近 N 个 portfolio 优化结果。
 *   - `deleteRun(id)` — 删除某 id 的结果。
 *   - `cleanupOlderThan(days)` — 删除 N 天前的全部结果。
 *
 * **7 个纯函数 helper（独立单测，完全脱离 DB）**：
 *   - `alignDailyReturns(strategy_returns)` — N 个策略 (date, return) → 共同日期
 *     列表 + N 个对齐数组。无共同日 → 空。
 *   - `computePortfolioDailyReturns(returnMatrix, weights)` — 每日加权和（row-wise）。
 *   - `computeMean(values)` — 平均；空数组 null。
 *   - `computeStddev(values)` — n-1 样本标准差；< 2 个值 null。
 *   - `computeAnnualizedSharpe(daily_returns, annualization)` — mean/std * sqrt(N)。
 *   - `computeAnnualizedReturn(daily_returns, annualization)` — (geometric_total_growth) ^
 *     (annualization / N) - 1；返回百分数。
 *   - `computeMaxDrawdownPct(daily_returns)` — 复利权益曲线最大回撤百分比（正数）。
 *   - `projectOntoSimplexWithBox(w, min, max)` — 把 weight 向量投影到 sum=1 且
 *     每个分量 ∈ [min, max] 的约束集；bisection on lambda 算法。
 *   - `computeSharpeGradient(returnMatrix, weights, eps)` — 数值梯度（中心差分；防解析
 *     梯度推导出错。eps 默认 1e-5）。
 *
 * **DataSource DI 模式**（与 GridSearchOptimizer.BacktestRunner /
 * RegimeSegmentedBacktest.RegimeSource / MonteCarloStressTest.TradeReturnSource
 * 同款）：
 *   - 生产默认 `PRODUCTION_STRATEGY_RETURN_SOURCE` — lazy require 从
 *     QuantBacktestResult.equity_curve_json 派生日收益；
 *   - 测试注入 fake source 完全脱离 DB；同时支持 in-memory 模式直接传入
 *     strategy_returns 数组（CLI / 单测都用得上）。
 *
 * **求解器策略**：
 *   - **projected_gradient**（默认）：投影梯度上升（PGA）。学习率 0.001（保守，
 *     防止 sharpe 噪音震荡），最大迭代 5000；不动 < tolerance=1e-6 即收敛。
 *     多个随机起点取最优（默认 3 起点：equal_weight + 2 个 seeded random）。
 *   - **equal_weight**（baseline）：纯 1/N 等权基线，不做迭代；快速 sanity check。
 *
 * **关键约束**：
 *   - **N ≥ 2 才有意义**：N=1 无组合（直接 weight=1.0）；本接口 throw。
 *   - **每个策略至少 MIN_DAILY_RETURNS_FOR_SHARPE=5 个对齐后日收益**：少于此夏普
 *     不稳；caller 应该确保 source 提供足够数据，否则求解会被 sharpe=null 拖死。
 *   - **共同日期数（对齐后）< MIN_DAILY_RETURNS_FOR_SHARPE**：throw"无共同窗口"。
 *   - **max_weight × N ≥ 1.0**：否则无解（e.g. N=2 时 max_weight=0.4 → 总和最大
 *     0.8 < 1.0）。本接口提前 throw 友好提示。
 *   - **min_weight ≥ 0** 且 **min_weight × N ≤ 1.0**：否则无解。
 *   - **不复用 OptimizationRun 父表**（与 US-040/US-041/US-042/US-043 判据一致）。
 *
 * 主要消费方：
 *   - optimize-portfolio.ts CLI（US-044）
 *   - 未来 US-016 策略实验室 "组合优化" tab
 *   - 未来 US-086 仓位再平衡引擎用 weights 作为目标配比
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { QuantEquityPoint } from '../types/QuantTypes';
import { SeededRandom } from './BayesianOptimizer';

// Stub for deleted StrategyPortfolioResult model
const StrategyPortfolioResult = {
  create: async (_data?: any): Promise<any> => ({ id: null }),
  findByPk: async (_id?: any): Promise<any> => null,
  findAll: async (_opts?: any): Promise<any[]> => [],
  destroy: async (_opts?: any): Promise<number> => 0,
};

// ============================================================
// 常量
// ============================================================

/** AC 默认单策略权重上限（40%；防全押单策略退化） */
export const DEFAULT_MAX_WEIGHT = 0.4;

/** 默认单策略权重下限（0%；允许策略权重为 0 → 等同剔除） */
export const DEFAULT_MIN_WEIGHT = 0.0;

/** 算 sharpe / annual return 所需最小日收益数 */
export const MIN_DAILY_RETURNS_FOR_SHARPE = 5;

/** 年化系数（252 个交易日 / 年的量化界惯例） */
export const ANNUALIZATION_FACTOR = 252;

/** sqrt(252)，与 MonteCarloStressTest 一致 */
export const SHARPE_ANNUALIZATION_SQRT = Math.sqrt(ANNUALIZATION_FACTOR);

/** PGA 默认学习率（保守，防 sharpe 噪音震荡） */
export const DEFAULT_LEARNING_RATE = 0.001;

/** PGA 默认最大迭代次数 */
export const DEFAULT_MAX_ITERATIONS = 5000;

/** PGA 收敛 tolerance（|sharpe_new - sharpe_old| < tol → 收敛） */
export const DEFAULT_TOLERANCE = 1e-6;

/** PGA 默认随机起点数量（包含 equal_weight；总 starts = 1 + RANDOM_RESTARTS） */
export const DEFAULT_RANDOM_RESTARTS = 2;

/** 默认 seed for SeededRandom（与 BayesianOptimizer / MonteCarloStressTest 一致） */
export const DEFAULT_SEED = 42;

/** simplex 投影 bisection 迭代上限（一般 50-60 次即收敛到 1e-12 精度） */
export const SIMPLEX_PROJECTION_MAX_BISECTION_ITER = 100;

/** simplex 投影 bisection tolerance */
export const SIMPLEX_PROJECTION_TOLERANCE = 1e-10;

/** 求解器标签集合 */
export type PortfolioOptimizerSolver = 'projected_gradient' | 'equal_weight';

// ============================================================
// 类型
// ============================================================

/**
 * 单策略的"日期 → 日收益（小数；e.g. 0.012 = +1.2%）"序列。
 * 注意：是**小数** (decimal) 不是百分数，与 QuantBacktestResult.cumulative_return_pct 不同
 * （后者是百分数）。我们内部统一用小数，输出 metrics 时再转百分数。
 */
export interface StrategyDailyReturns {
  /** 策略 key（与 QuantBacktestResult.strategy_key 一致；输出严格按此顺序） */
  strategy_key: string;
  /** [date, return_decimal] tuple 数组；date YYYY-MM-DD；return 小数 */
  daily_returns: Array<{ date: string; return_decimal: number }>;
}

/**
 * StrategyReturnSource 抽象。让测试可以注入 fake source 完全脱离 DB。
 *
 * 入参 (quant_backtest_result_ids[]) → 出参 N 个 StrategyDailyReturns（保持入参顺序）。
 */
export interface StrategyReturnSource {
  loadStrategyReturns(quant_backtest_result_ids: number[]): Promise<StrategyDailyReturns[]>;
}

/**
 * 生产默认 StrategyReturnSource：lazy require QuantBacktestResult 读
 * equity_curve_json 派生日收益（cumulative_return_pct 的差分）。
 */
export const PRODUCTION_STRATEGY_RETURN_SOURCE: StrategyReturnSource = {
  async loadStrategyReturns(quant_backtest_result_ids: number[]): Promise<StrategyDailyReturns[]> {
    // lazy require — 避免本模块顶部 import 让 fake-source 单测也付出加载重量级
    // 子系统的代价（同 MonteCarloStressTest.PRODUCTION_TRADE_RETURN_SOURCE 范式）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { QuantBacktestResult: QBR } = require('../../models/QuantBacktestResult');

    const out: StrategyDailyReturns[] = [];
    for (const id of quant_backtest_result_ids) {
      const row = await QBR.findByPk(id);
      if (!row) {
        throw new Error(`PRODUCTION_STRATEGY_RETURN_SOURCE: QuantBacktestResult #${id} 未找到`);
      }
      const equityCurve: QuantEquityPoint[] = Array.isArray(row.equity_curve_json)
        ? row.equity_curve_json
        : [];
      const dailyReturns = deriveDailyReturnsFromEquityCurve(equityCurve);
      out.push({
        strategy_key: row.strategy_key,
        daily_returns: dailyReturns,
      });
    }
    return out;
  },
};

/**
 * `optimize()` 输入。两种入参形态：
 *
 * (1) `quant_backtest_result_ids[]`：从 DB 读 QuantBacktestResult.equity_curve_json
 *     派生日收益序列（最常见的入参方式）。
 *
 * (2) `strategy_returns[]`：纯 in-memory 模式，单测 / 嵌入式调用方已经手上
 *     有 returns 数组，不想再 round-trip DB。
 *
 * 至少要提供其中一种；同时提供时 (2) 优先（in-memory 数据本就是 source of truth）。
 */
export interface PortfolioOptimizerInput {
  /** 源回测 ID 列表（DB 模式必填） */
  quant_backtest_result_ids?: number[];
  /** in-memory 模式：直接传 N 个策略日收益序列 */
  strategy_returns?: StrategyDailyReturns[];
  /** 自由文本备注（写入 StrategyPortfolioResult.notes） */
  notes?: string;
}

export interface PortfolioOptimizerOptions {
  /** 单策略权重上限（默认 0.4） */
  max_weight?: number;
  /** 单策略权重下限（默认 0） */
  min_weight?: number;
  /** 求解器（默认 projected_gradient） */
  solver?: PortfolioOptimizerSolver;
  /** PGA 学习率（默认 DEFAULT_LEARNING_RATE） */
  learning_rate?: number;
  /** PGA 最大迭代次数（默认 DEFAULT_MAX_ITERATIONS） */
  max_iterations?: number;
  /** PGA 收敛 tolerance（默认 DEFAULT_TOLERANCE） */
  tolerance?: number;
  /** PGA 随机起点数量（默认 DEFAULT_RANDOM_RESTARTS） */
  random_restarts?: number;
  /** RNG seed（默认 DEFAULT_SEED） */
  seed?: number;
  /** Lookback 天数（None = 用全部传入日；用于做 trailing window 求解） */
  lookback_days?: number;
  /** 是否写库（默认 true；in-memory 模式且 ids 缺失时仍可 persist） */
  persist?: boolean;
  /** 自定义 StrategyReturnSource（测试注入 fake；不传走 PRODUCTION） */
  strategy_return_source?: StrategyReturnSource;
  /** 自定义 source 标识（写入 StrategyPortfolioResult.source） */
  source?: string;
}

/**
 * 单次优化结果（in-memory 返回 + 持久化的 DB row 都是这个 plain object）。
 */
export interface PortfolioOptimizerResult {
  /** 策略 key 列表（按求解输入顺序，与 weights 严格 index 对齐） */
  strategy_keys: string[];
  /** 最优权重（长度 = strategy_keys.length，sum ≈ 1） */
  weights: number[];
  /** 组合年化收益（百分数；e.g. 18.5 = 18.5%）；样本不足时 null */
  annual_return: number | null;
  /** 组合夏普；样本不足时 null */
  sharpe: number | null;
  /** 组合最大回撤的绝对值（正数百分数；e.g. 15.5 = -15.5%） */
  max_drawdown: number | null;
  /** 求解算法 */
  solver: PortfolioOptimizerSolver;
  /** 求解器迭代次数（非梯度法 = 0） */
  iterations: number;
  /** 是否在 tolerance 内收敛 */
  converged: boolean;
  /** 实际生效的单策略权重上限 */
  max_weight: number;
  /** 实际生效的单策略权重下限 */
  min_weight: number;
  /** 求解所用日收益窗口；null = 用全部 */
  lookback_days: number | null;
  /** 对齐后日收益的实际起始日 */
  period_start: string | null;
  /** 对齐后日收益的实际结束日 */
  period_end: string | null;
  /** 对齐后日收益数 */
  daily_return_count: number;
  /** 自由文本备注 */
  notes: string | null;
  /** 物化进 row 的写入来源标识 */
  source: string;
  /** 最近一次跑的时间 */
  computed_at: Date;
  /** 写库 row id；persist=false 时 null */
  persisted_id: number | null;
  /** 总执行 ms */
  duration_ms: number;
}

// ============================================================
// 纯函数 helpers — 独立单测，完全脱离 DB
// ============================================================

/**
 * 从 equity_curve_json 派生日收益序列：(equity[t] / equity[t-1]) - 1。
 *
 * - 空 / 单点 → 空数组（无前一日参考）
 * - total_value ≤ 0 → 跳过该日（爆仓边界，避免负数 log）
 * - 重复 date → 保留最后一条（防 backtest engine 偶发 dup）
 *
 * Number() 包装：QuantEquityPoint.total_value 来自 JSONB，可能是 number 或 string
 * （Sequelize JSONB 列 round-trip 时序列化偶发"DECIMAL → string"行为，与
 * RegimeSegmentedBacktest 处理同款）。
 */
export function deriveDailyReturnsFromEquityCurve(
  equityCurve: QuantEquityPoint[]
): Array<{ date: string; return_decimal: number }> {
  if (!equityCurve || equityCurve.length < 2) return [];

  // dedup by date — 保留最后一条
  const dedupedMap = new Map<string, QuantEquityPoint>();
  for (const p of equityCurve) {
    if (p && typeof p.date === 'string') {
      dedupedMap.set(p.date, p);
    }
  }
  const sorted = Array.from(dedupedMap.values())
    .filter(p => Number(p.total_value) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const out: Array<{ date: string; return_decimal: number }> = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = Number(sorted[i - 1].total_value);
    const curr = Number(sorted[i].total_value);
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
      out.push({
        date: sorted[i].date,
        return_decimal: curr / prev - 1,
      });
    }
  }
  return out;
}

/**
 * 对齐 N 个策略的日收益到共同日期集合（取交集）。
 *
 * 返回：
 *   - common_dates: 排序后的共同日期数组
 *   - return_matrix: T × N 矩阵，return_matrix[t][i] = 策略 i 在 common_dates[t] 的日收益
 *
 * 若任一策略缺数据或共同日为空，对应行不输出。
 *
 * 例：strat_A 有 [2024-01-01, 2024-01-02, 2024-01-03]，strat_B 有 [2024-01-02, 2024-01-03]
 * → common = [2024-01-02, 2024-01-03]，return_matrix 是 2 行 × 2 列。
 */
export function alignDailyReturns(strategyReturns: StrategyDailyReturns[]): {
  common_dates: string[];
  return_matrix: number[][];
} {
  if (!strategyReturns || strategyReturns.length === 0) {
    return { common_dates: [], return_matrix: [] };
  }

  // 每策略构建 date → return 的 map
  const perStrategyMap: Array<Map<string, number>> = strategyReturns.map(s => {
    const m = new Map<string, number>();
    for (const dr of s.daily_returns || []) {
      if (dr && typeof dr.date === 'string' && Number.isFinite(dr.return_decimal)) {
        m.set(dr.date, dr.return_decimal);
      }
    }
    return m;
  });

  if (perStrategyMap.length === 0 || perStrategyMap.some(m => m.size === 0)) {
    return { common_dates: [], return_matrix: [] };
  }

  // 求交集：以最小 map 为基准
  const minMap = perStrategyMap.reduce((acc, m) => (m.size < acc.size ? m : acc));
  const candidateDates = Array.from(minMap.keys());
  const commonDates = candidateDates
    .filter(d => perStrategyMap.every(m => m.has(d)))
    .sort((a, b) => a.localeCompare(b));

  const returnMatrix: number[][] = commonDates.map(d => perStrategyMap.map(m => m.get(d)!));

  return { common_dates: commonDates, return_matrix: returnMatrix };
}

/**
 * 每日加权和：portfolio_returns[t] = sum_i (weights[i] * return_matrix[t][i])
 *
 * - return_matrix 必须是 T × N
 * - weights 必须长度 = N（不验证 sum=1；caller 负责）
 * - 空矩阵 → 空数组
 */
export function computePortfolioDailyReturns(
  returnMatrix: number[][],
  weights: number[]
): number[] {
  if (!returnMatrix || returnMatrix.length === 0) return [];
  const N = weights.length;
  const out: number[] = [];
  for (const row of returnMatrix) {
    if (!row || row.length !== N) {
      throw new Error(
        `computePortfolioDailyReturns: row length ${row?.length ?? 0} ≠ weights length ${N}`
      );
    }
    let s = 0;
    for (let i = 0; i < N; i += 1) {
      s += weights[i] * row[i];
    }
    out.push(s);
  }
  return out;
}

/**
 * 简单平均（空数组返回 null）。
 */
export function computeMean(values: number[]): number | null {
  if (!values || values.length === 0) return null;
  let s = 0;
  let c = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      s += v;
      c += 1;
    }
  }
  return c > 0 ? s / c : null;
}

/**
 * n-1 样本标准差（< 2 个有效值返回 null）。
 */
export function computeStddev(values: number[]): number | null {
  if (!values || values.length < 2) return null;
  const m = computeMean(values);
  if (m === null) return null;
  let ss = 0;
  let c = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      ss += (v - m) * (v - m);
      c += 1;
    }
  }
  if (c < 2) return null;
  return Math.sqrt(ss / (c - 1));
}

/**
 * 年化夏普 = mean(daily_returns) / std(daily_returns) * sqrt(252)。
 *
 * - daily_returns.length < MIN_DAILY_RETURNS_FOR_SHARPE → null
 * - std = 0 → null（防 NaN / Infinity）
 *
 * 假设 daily_returns 是**小数**（不是百分数）；输出 sharpe 无单位（量纲是小数 / 小数）。
 */
export function computeAnnualizedSharpe(
  dailyReturns: number[],
  annualizationSqrt: number = SHARPE_ANNUALIZATION_SQRT
): number | null {
  if (!dailyReturns || dailyReturns.length < MIN_DAILY_RETURNS_FOR_SHARPE) return null;
  const m = computeMean(dailyReturns);
  const s = computeStddev(dailyReturns);
  if (m === null || s === null || s === 0 || !Number.isFinite(s)) return null;
  return (m / s) * annualizationSqrt;
}

/**
 * 年化收益：(prod(1 + r_t)) ^ (annualization / N) - 1，输出**百分数**。
 *
 * - 空数组返回 null
 * - 任一 (1 + r_t) ≤ 0 → 视为爆仓 → 返回 -100%
 *
 * 假设 daily_returns 是**小数**。
 */
export function computeAnnualizedReturn(
  dailyReturns: number[],
  annualization: number = ANNUALIZATION_FACTOR
): number | null {
  if (!dailyReturns || dailyReturns.length === 0) return null;
  let cumulative = 1.0;
  let count = 0;
  for (const r of dailyReturns) {
    if (!Number.isFinite(r)) continue;
    const factor = 1 + r;
    if (factor <= 0) return -100;
    cumulative *= factor;
    count += 1;
  }
  if (count === 0) return null;
  const annualGrowth = Math.pow(cumulative, annualization / count);
  return (annualGrowth - 1) * 100;
}

/**
 * 复利权益曲线最大回撤百分比（**正数**；e.g. 18.5 = -18.5%）。
 *
 * 假设 daily_returns 是**小数**。爆仓 → 100。
 */
export function computeMaxDrawdownPct(dailyReturns: number[]): number | null {
  if (!dailyReturns || dailyReturns.length === 0) return null;
  let cumulative = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  for (const r of dailyReturns) {
    if (!Number.isFinite(r)) continue;
    const factor = 1 + r;
    if (factor <= 0) return 100;
    cumulative *= factor;
    if (cumulative > peak) peak = cumulative;
    if (peak > 0) {
      const dd = (peak - cumulative) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

/**
 * 投影到约束集 {w : sum(w) = 1, w_i ∈ [min, max]}。
 *
 * 算法：bisection on lambda such that sum(clip(w + lambda, min, max)) = 1.
 *
 * - clip(w + lambda, min, max) 的总和是 lambda 的单调非降函数 → bisection 一定收敛。
 * - 若 max * N < 1 → 上界不够大 → 无解，throw。
 * - 若 min * N > 1 → 下界不够小 → 无解，throw。
 * - bisection 范围：[min - max(w), max - min(w)]
 *
 * 例：N=3, max=0.4, min=0, w=[0.5, 0.3, 0.2]
 *   → sum=1.0 已满足，但 w[0]=0.5 > max=0.4 越界
 *   → 投影后 [0.4, 0.35, 0.25]（lambda < 0 把 0.5 clip 到 0.4，余下 0.1 分给另两个）
 */
export function projectOntoSimplexWithBox(w: number[], min: number, max: number): number[] {
  const N = w.length;
  if (N === 0) return [];
  if (max * N < 1 - 1e-12) {
    throw new Error(`projectOntoSimplexWithBox: max_weight=${max} * N=${N} = ${max * N} < 1，无解`);
  }
  if (min * N > 1 + 1e-12) {
    throw new Error(`projectOntoSimplexWithBox: min_weight=${min} * N=${N} = ${min * N} > 1，无解`);
  }
  if (min < 0) {
    throw new Error(`projectOntoSimplexWithBox: min_weight=${min} < 0，不支持`);
  }
  if (max < min) {
    throw new Error(`projectOntoSimplexWithBox: max_weight=${max} < min_weight=${min}，不合法`);
  }

  const clip = (lambda: number): number[] => w.map(v => Math.max(min, Math.min(max, v + lambda)));
  const sumClip = (lambda: number): number => clip(lambda).reduce((s, v) => s + v, 0);

  // 找 lambda 边界
  // - lambda_low: 使所有 w[i] + lambda ≤ min → sum = min * N
  // - lambda_high: 使所有 w[i] + lambda ≥ max → sum = max * N
  // 都需要 lo 使 sum < 1, hi 使 sum > 1
  let lo = min - Math.max(...w) - 1;
  let hi = max - Math.min(...w) + 1;

  // 防御：确认 sumClip(lo) ≤ 1 ≤ sumClip(hi)
  while (sumClip(lo) > 1 - SIMPLEX_PROJECTION_TOLERANCE) lo -= 1;
  while (sumClip(hi) < 1 + SIMPLEX_PROJECTION_TOLERANCE) hi += 1;

  let mid = (lo + hi) / 2;
  for (let i = 0; i < SIMPLEX_PROJECTION_MAX_BISECTION_ITER; i += 1) {
    mid = (lo + hi) / 2;
    const s = sumClip(mid);
    if (Math.abs(s - 1) < SIMPLEX_PROJECTION_TOLERANCE) break;
    if (s < 1) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return clip(mid);
}

/**
 * 数值梯度（中心差分；防解析梯度推导出错）。
 *
 * grad[i] = (sharpe(w + eps * e_i) - sharpe(w - eps * e_i)) / (2 * eps)
 *
 * - sharpe 在两侧任一为 null → grad[i] = 0（保守，让 PGA 不动该维度）
 * - eps 默认 1e-5（与 weight 量级 [0, 0.4] 适配）
 *
 * 注意：本函数**不做约束投影**，由 caller 负责将 w ± eps 投影到约束集再算
 * sharpe（否则 w + eps 可能越界，sharpe 变成无效值）。
 */
export function computeSharpeGradient(
  returnMatrix: number[][],
  weights: number[],
  eps = 1e-5
): number[] {
  const N = weights.length;
  const grad = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    const wPlus = weights.slice();
    const wMinus = weights.slice();
    wPlus[i] += eps;
    wMinus[i] -= eps;
    const sPlus = computeAnnualizedSharpe(computePortfolioDailyReturns(returnMatrix, wPlus));
    const sMinus = computeAnnualizedSharpe(computePortfolioDailyReturns(returnMatrix, wMinus));
    if (sPlus !== null && sMinus !== null && Number.isFinite(sPlus) && Number.isFinite(sMinus)) {
      grad[i] = (sPlus - sMinus) / (2 * eps);
    }
  }
  return grad;
}

/**
 * 给一组随机起点（包含 equal_weight），跑 PGA，返回每个起点的最终 (weights, sharpe)。
 */
function runProjectedGradientFromStarts(
  returnMatrix: number[][],
  startWeights: number[][],
  options: {
    min: number;
    max: number;
    learningRate: number;
    maxIterations: number;
    tolerance: number;
  }
): Array<{ weights: number[]; sharpe: number | null; iterations: number; converged: boolean }> {
  const out: Array<{
    weights: number[];
    sharpe: number | null;
    iterations: number;
    converged: boolean;
  }> = [];

  for (const start of startWeights) {
    let w = projectOntoSimplexWithBox(start, options.min, options.max);
    let prevSharpe = computeAnnualizedSharpe(computePortfolioDailyReturns(returnMatrix, w));
    let converged = false;
    let iter = 0;

    for (iter = 0; iter < options.maxIterations; iter += 1) {
      const grad = computeSharpeGradient(returnMatrix, w);
      // gradient ASCENT (maximize sharpe)
      const wRaw = w.map((v, i) => v + options.learningRate * grad[i]);
      let wNext: number[];
      try {
        wNext = projectOntoSimplexWithBox(wRaw, options.min, options.max);
      } catch (err) {
        logger.warn(
          `[portfolio-optimizer] simplex projection threw at iter=${iter}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        break;
      }
      const sharpeNext = computeAnnualizedSharpe(computePortfolioDailyReturns(returnMatrix, wNext));

      if (prevSharpe !== null && sharpeNext !== null) {
        if (Math.abs(sharpeNext - prevSharpe) < options.tolerance) {
          w = wNext;
          prevSharpe = sharpeNext;
          converged = true;
          break;
        }
      }
      w = wNext;
      prevSharpe = sharpeNext;
    }
    out.push({ weights: w, sharpe: prevSharpe, iterations: iter, converged });
  }
  return out;
}

/**
 * 生成 N 个 strategies 的初始 weight 起点数组（包含 equal_weight + R 个 seeded random）。
 *
 * - equal_weight = [1/N, 1/N, ..., 1/N] —— sum=1 自然满足；越界由后续 PGA 投影修正。
 * - random: rng.next() per coord; 归一化到 sum=1；不强制盒约束（投影器会处理）。
 */
function generateInitialStarts(N: number, randomRestarts: number, rng: SeededRandom): number[][] {
  const starts: number[][] = [];
  // 起点 1: equal_weight
  starts.push(new Array(N).fill(1 / N));
  // 起点 2..R+1: random
  for (let r = 0; r < randomRestarts; r += 1) {
    const raw = new Array(N).fill(0).map(() => rng.next());
    const sum = raw.reduce((s, v) => s + v, 0);
    starts.push(sum > 0 ? raw.map(v => v / sum) : new Array(N).fill(1 / N));
  }
  return starts;
}

/**
 * round helper — 与 MonteCarloStressTest 一致。
 */
function roundTo(value: number | null | undefined, digits: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const k = Math.pow(10, digits);
  return Math.round(Number(value) * k) / k;
}

/**
 * Sequelize 模型 row → plain object (与 OptimizationResultRecord 同款范式)。
 *
 * 让 persist=true 和 persist=false 两条路径返回同一类型，避免 Model 类型噩梦。
 */
export function modelToRecord(row: any): PortfolioOptimizerResult {
  return {
    strategy_keys: Array.isArray(row.strategy_keys_json) ? row.strategy_keys_json : [],
    weights: Array.isArray(row.weights_json) ? row.weights_json.map(v => Number(v)) : [],
    annual_return:
      row.annual_return !== null && row.annual_return !== undefined
        ? Number(row.annual_return)
        : null,
    sharpe: row.sharpe !== null && row.sharpe !== undefined ? Number(row.sharpe) : null,
    max_drawdown:
      row.max_drawdown !== null && row.max_drawdown !== undefined ? Number(row.max_drawdown) : null,
    solver: row.solver as PortfolioOptimizerSolver,
    iterations: Number(row.iterations || 0),
    converged: Boolean(row.converged),
    max_weight: Number(row.max_weight),
    min_weight: Number(row.min_weight),
    lookback_days:
      row.lookback_days !== null && row.lookback_days !== undefined
        ? Number(row.lookback_days)
        : null,
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    daily_return_count: Number(row.daily_return_count || 0),
    notes: row.notes || null,
    source: row.source,
    computed_at: new Date(row.computed_at),
    persisted_id: row.id,
    duration_ms: 0, // not stored in DB
  };
}

// ============================================================
// 主类
// ============================================================

export class PortfolioOptimizer {
  /**
   * 单次完整组合优化流程入口。流程：
   *   1. 解析 input：从 DB / in-memory 拿到 N 个策略日收益序列
   *   2. align 到共同日期（取交集）
   *   3. 可选 lookback_days 截尾
   *   4. 验证：N ≥ 2 / 共同日 ≥ MIN_DAILY_RETURNS_FOR_SHARPE / 约束可行
   *   5. solver：projected_gradient（多起点）/ equal_weight（baseline）
   *   6. 计算组合指标：sharpe / annual_return / max_drawdown
   *   7. 可选写 StrategyPortfolioResult
   */
  async optimize(
    input: PortfolioOptimizerInput,
    options: PortfolioOptimizerOptions = {}
  ): Promise<PortfolioOptimizerResult> {
    const t0 = Date.now();
    const maxWeight = options.max_weight ?? DEFAULT_MAX_WEIGHT;
    const minWeight = options.min_weight ?? DEFAULT_MIN_WEIGHT;
    const solver = options.solver ?? 'projected_gradient';
    const learningRate = options.learning_rate ?? DEFAULT_LEARNING_RATE;
    const maxIterations = options.max_iterations ?? DEFAULT_MAX_ITERATIONS;
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    const randomRestarts = options.random_restarts ?? DEFAULT_RANDOM_RESTARTS;
    const seed = options.seed ?? DEFAULT_SEED;
    const lookbackDays = options.lookback_days ?? null;
    const persistRequested = options.persist !== false;
    const source = options.source ?? 'portfolio_optimizer';
    const returnSource = options.strategy_return_source ?? PRODUCTION_STRATEGY_RETURN_SOURCE;

    // === (1) 解析 input ===
    let strategyReturns: StrategyDailyReturns[];
    if (input.strategy_returns && input.strategy_returns.length > 0) {
      strategyReturns = input.strategy_returns;
    } else if (input.quant_backtest_result_ids && input.quant_backtest_result_ids.length > 0) {
      strategyReturns = await returnSource.loadStrategyReturns(input.quant_backtest_result_ids);
    } else {
      throw new Error(
        'PortfolioOptimizer.optimize: 必须提供 quant_backtest_result_ids 或 strategy_returns 之一'
      );
    }

    const N = strategyReturns.length;
    if (N < 2) {
      throw new Error(`PortfolioOptimizer.optimize: 至少需要 2 个策略才能组合优化，当前 N=${N}`);
    }

    // === (2) 对齐到共同日期 ===
    const { common_dates, return_matrix } = alignDailyReturns(strategyReturns);

    // === (3) 可选 lookback_days 截尾 ===
    let alignedDates = common_dates;
    let alignedMatrix = return_matrix;
    if (lookbackDays !== null && lookbackDays > 0 && lookbackDays < common_dates.length) {
      alignedDates = common_dates.slice(common_dates.length - lookbackDays);
      alignedMatrix = return_matrix.slice(return_matrix.length - lookbackDays);
    }

    if (alignedMatrix.length < MIN_DAILY_RETURNS_FOR_SHARPE) {
      throw new Error(
        `PortfolioOptimizer.optimize: 对齐后日收益数 ${alignedMatrix.length} < ${MIN_DAILY_RETURNS_FOR_SHARPE}，无法求解`
      );
    }

    // === (4) 验证约束可行性 ===
    if (maxWeight * N < 1 - 1e-12) {
      throw new Error(
        `PortfolioOptimizer.optimize: max_weight=${maxWeight} * N=${N} = ${
          maxWeight * N
        } < 1，无可行解`
      );
    }
    if (minWeight * N > 1 + 1e-12) {
      throw new Error(
        `PortfolioOptimizer.optimize: min_weight=${minWeight} * N=${N} = ${
          minWeight * N
        } > 1，无可行解`
      );
    }
    if (minWeight < 0) {
      throw new Error(`PortfolioOptimizer.optimize: min_weight=${minWeight} 必须 ≥ 0`);
    }
    if (maxWeight < minWeight) {
      throw new Error(
        `PortfolioOptimizer.optimize: max_weight=${maxWeight} < min_weight=${minWeight}，不合法`
      );
    }

    const strategyKeys = strategyReturns.map(s => s.strategy_key);

    logger.info(
      `[portfolio-optimizer] start: strategies=${strategyKeys.join(',')} ` +
        `N=${N} aligned_days=${alignedMatrix.length} solver=${solver} ` +
        `max_weight=${maxWeight} min_weight=${minWeight} ` +
        `lookback=${lookbackDays ?? 'all'} seed=${seed}`
    );

    // === (5) 求解 ===
    let weights: number[];
    let iterations = 0;
    let converged = false;

    if (solver === 'equal_weight') {
      // 等权基线
      weights = projectOntoSimplexWithBox(new Array(N).fill(1 / N), minWeight, maxWeight);
      converged = true;
    } else {
      // projected_gradient — 多起点择最优
      const rng = new SeededRandom(seed);
      const starts = generateInitialStarts(N, randomRestarts, rng);
      const results = runProjectedGradientFromStarts(alignedMatrix, starts, {
        min: minWeight,
        max: maxWeight,
        learningRate,
        maxIterations,
        tolerance,
      });
      // 选 sharpe 最大的
      let best = results[0];
      for (const r of results) {
        if (r.sharpe !== null && (best.sharpe === null || r.sharpe > best.sharpe)) {
          best = r;
        }
      }
      weights = best.weights;
      iterations = best.iterations;
      converged = best.converged;
    }

    // === (6) 计算组合指标 ===
    const portfolioReturns = computePortfolioDailyReturns(alignedMatrix, weights);
    const sharpe = computeAnnualizedSharpe(portfolioReturns);
    const annualReturn = computeAnnualizedReturn(portfolioReturns);
    const maxDrawdown = computeMaxDrawdownPct(portfolioReturns);

    const periodStart = alignedDates.length > 0 ? alignedDates[0] : null;
    const periodEnd = alignedDates.length > 0 ? alignedDates[alignedDates.length - 1] : null;

    const result: PortfolioOptimizerResult = {
      strategy_keys: strategyKeys,
      weights: weights.map(w => roundTo(w, 6) ?? 0),
      annual_return: roundTo(annualReturn, 4),
      sharpe: roundTo(sharpe, 4),
      max_drawdown: roundTo(maxDrawdown, 4),
      solver,
      iterations,
      converged,
      max_weight: maxWeight,
      min_weight: minWeight,
      lookback_days: lookbackDays,
      period_start: periodStart,
      period_end: periodEnd,
      daily_return_count: alignedMatrix.length,
      notes: input.notes ?? null,
      source,
      computed_at: new Date(),
      persisted_id: null,
      duration_ms: 0,
    };

    // === (7) 持久化 ===
    if (persistRequested) {
      const created = await StrategyPortfolioResult.create({
        strategy_keys_json: result.strategy_keys,
        weights_json: result.weights,
        annual_return: result.annual_return,
        sharpe: result.sharpe,
        max_drawdown: result.max_drawdown,
        solver: result.solver,
        iterations: result.iterations,
        converged: result.converged,
        max_weight: result.max_weight,
        min_weight: result.min_weight,
        lookback_days: result.lookback_days,
        period_start: result.period_start,
        period_end: result.period_end,
        daily_return_count: result.daily_return_count,
        notes: result.notes,
        computed_at: result.computed_at,
        source: result.source,
      });
      result.persisted_id = created.id;
    }

    const duration = Date.now() - t0;
    result.duration_ms = duration;
    logger.info(
      `[portfolio-optimizer] done in ${(duration / 1000).toFixed(2)}s: ` +
        `weights=[${result.weights.map(w => w.toFixed(4)).join(',')}] ` +
        `sharpe=${result.sharpe} annual=${result.annual_return}% ` +
        `max_dd=${result.max_drawdown}% converged=${result.converged} ` +
        `iter=${result.iterations} (persisted=${result.persisted_id !== null})`
    );

    return result;
  }

  /**
   * 查某 id 的结果。
   */
  async getRun(id: number): Promise<PortfolioOptimizerResult | null> {
    const row = await StrategyPortfolioResult.findByPk(id);
    return row ? modelToRecord(row) : null;
  }

  /**
   * 列出最近 N 个组合优化结果（DESCENDING computed_at）。
   */
  async listRecentRuns(limit = 30): Promise<PortfolioOptimizerResult[]> {
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const rows = await StrategyPortfolioResult.findAll({
      order: [['computed_at', 'DESC']],
      limit: safeLimit,
    });
    return rows.map(modelToRecord);
  }

  /**
   * 删除某 id 的结果。
   */
  async deleteRun(id: number): Promise<{ deleted: number }> {
    const deleted = await StrategyPortfolioResult.destroy({ where: { id } });
    return { deleted };
  }

  /**
   * 清理 N 天前的所有 portfolio 结果。
   */
  async cleanupOlderThan(days: number): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const deleted = await StrategyPortfolioResult.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted };
  }
}

// 单例 — 与 gridSearchOptimizer / walkForwardValidator / regimeSegmentedBacktest /
// monteCarloStressTest 一致
export const portfolioOptimizer = new PortfolioOptimizer();
