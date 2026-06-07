/**
 * MonteCarloStressTest — 蒙特卡洛压力测试（US-043）
 *
 * 对一次已完成的回测，抽取每笔交易的盈亏百分比序列（`return_pct`），随机重排
 * N=1000 次复利得到 N 条模拟资金曲线，输出最终收益 / 最大回撤 / 夏普的分位数
 * 分布。
 *
 * **为什么需要蒙特卡洛**：
 *   一次回测的 sharpe=2.0 / total_return=80% / max_drawdown=15% 单点数字本身
 *   不告诉你"如果交易顺序不同结果会差多少"。如果 80% 的累计收益靠的是少数 3
 *   笔超额交易 + 这 3 笔恰好早出现避免被早期回撤吃掉，那策略其实"靠运气"——
 *   重排 1000 次可能 5% 分位的最终收益就是 -20%。蒙特卡洛把"路径敏感性"摊开
 *   成可视分布，让 ops 看到 "我这个策略的下沿到底有多差"。
 *
 * **公共接口**：
 *   - `run(input, options?)` — 异步执行 N 次模拟；选择性写入 MonteCarloResult；
 *     返回 { distribution_summary, base_metrics }。
 *   - `getRunResult(base_run_id, seed)` — 查某次回测某 seed 的结果。
 *   - `getRunResults(base_run_id)` — 查某次回测的全部 seeds 结果。
 *   - `deleteRun(base_run_id)` — 删除某次回测的全部 MC 结果。
 *   - `cleanupOlderThan(days)` — 删除 N 天前的 MC 结果。
 *   - `listRecentRuns(limit)` — 列出最近 N 个 MC 跑过的 base_run_id。
 *
 * **6 个纯函数 helper（独立单测，完全脱离 DB）**：
 *   - `computeQuantile(sortedAsc, q)` — 已排序数组的 q 分位数（线性插值；与
 *     RegimeSegmentedBacktest 共用 mean/sampleStddev 但不引入跨模块依赖，所以
 *     这里独立实现，与 GridSearch / Bayesian / WalkForward / Regime / IC /
 *     Correlation 同款"避免跨模块反向依赖"模式）。
 *   - `bootstrapResample(returnsPct, rng)` — Fisher-Yates 洗牌返回新数组（**不**
 *     mutate 输入）。
 *   - `computeSimulationFinalReturn(returnsPct)` — 复利得到最终累计收益 %
 *     （e.g. [10, -5, 8] → (1.10 * 0.95 * 1.08 - 1) * 100）
 *   - `computeSimulationMaxDrawdown(returnsPct)` — 复利权益曲线的最大回撤百分比
 *     （正数；e.g. 18.0 = -18%）
 *   - `computeSimulationSharpe(returnsPct)` — mean(returns) / std(returns) *
 *     sqrt(252)；少于 5 笔返回 null
 *   - `aggregateSimulations(sims)` — 把 N 次模拟结果聚合成 DistributionSummary
 *     （分位数 + mean / std + positive_ratio）
 *
 * **TradeReturnSource DI 模式**（与 GridSearchOptimizer.BacktestRunner /
 * RegimeSegmentedBacktest.RegimeSource / FactorICReport.FactorICDataSource
 * 同款）：
 *   - 生产默认 `PRODUCTION_TRADE_RETURN_SOURCE` — lazy require 读
 *     QuantBacktestTrade（避免单测拉重量级 DB stack）；
 *   - 测试注入 fake source 完全脱离 DB；同时支持 in-memory 模式直接传入
 *     trades / return_pcts 数组（CLI / 单测都用得上）。
 *
 * **SeededRandom 而非 Math.random**：
 *   - 与 BayesianOptimizer.SeededRandom 同款 Park-Miller LCG；
 *   - 同 seed + 同 trades → 完全可复现的模拟序列；
 *   - 单测可断言精确分位数 / 报告可重算论文结果 / ops 可重跑出"我上周看到的同
 *     一份图"。
 *
 * **关键约束**：
 *   - **失败 trades 跳过 + 不阻塞批次**：source 返回的 return_pct 必须是 finite
 *     number；NaN / Infinity 自动剔除 + warning，但不让整个 run 失败。
 *   - **N < 1 抛错**：simulation_count 默认 1000，最小允许 1（debug 用），上限
 *     100_000 防误用。
 *   - **trade_count < 2 抛错**：少于 2 笔交易没有重排意义；提示用户选别的回测。
 *   - **简易模式 sharpe = mean / std * sqrt(252)**：把 trade returns 当成日收益
 *     算 sharpe 是简化假设——真实持有期不同 trade 长度不一致——但作为压力测试
 *     的*相对比较*指标已足够（用户主要看分位数分布形状，不是绝对 sharpe）。
 *     文档里明确这一假设，让用户知道分位数 sharpe 与 base sharpe 不可直接对比。
 *   - **不复用 OptimizationRun 父表**（与 US-040/US-041/US-042 判据一致）。
 *
 * 主要消费方：
 *   - run-monte-carlo.ts CLI（US-043）
 *   - 未来 US-016 策略实验室 "稳健性测试" tab
 *   - 未来 US-049 DrawdownCircuitBreaker 用 drawdown_p95 作为组合熔断阈值参考
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { MonteCarloResult } from '../../models/MonteCarloResult';
import { QuantBacktestResult } from '../../models/QuantBacktestResult';
import { SeededRandom } from './BayesianOptimizer';

// ============================================================
// 常量
// ============================================================

/** AC 默认模拟次数 */
export const DEFAULT_SIMULATION_COUNT = 1000;

/** 模拟次数上限（防误用 / OOM） */
export const MAX_SIMULATION_COUNT = 100_000;

/** 模拟次数下限（debug 模式允许 1） */
export const MIN_SIMULATION_COUNT = 1;

/** 计算 sharpe 所需最小 returns 数（少于此 → sharpe = null） */
export const MIN_RETURNS_FOR_SHARPE = 5;

/** Trade returns 最小数量（少于此 → throw，重排无意义） */
export const MIN_TRADES_FOR_BOOTSTRAP = 2;

/** Sharpe 年化系数（252 个交易日 / 年的量化界惯例） */
export const SHARPE_ANNUALIZATION_FACTOR = Math.sqrt(252);

/** 默认 seed（与 BayesianOptimizer.SeededRandom 一致） */
export const DEFAULT_SEED = 42;

// ============================================================
// 类型
// ============================================================

/**
 * 单次模拟的指标快照。
 */
export interface SimulationOutcome {
  /** 复利最终收益百分比（e.g. 12.34 = +12.34%；亏损为负） */
  final_return_pct: number;
  /** 段内最大回撤百分比的绝对值（正数；e.g. 8.50 表示 -8.50%） */
  max_drawdown_pct: number;
  /** 该模拟的 sharpe；returns < MIN_RETURNS_FOR_SHARPE 时 null */
  sharpe: number | null;
}

/**
 * 聚合 N 次模拟得到的分布统计。
 */
export interface DistributionSummary {
  /** 实际跑成功的模拟数（一般 = simulation_count） */
  simulation_count: number;
  /** 源 trades 数量（每次模拟用来重排的 returns 数量） */
  trade_count: number;

  /** 最终收益分位数（AC 必须）*/
  return_p5: number | null;
  return_p50: number | null;
  return_p95: number | null;

  /** 最大回撤 95% 分位（AC 必须；正数） */
  drawdown_p95: number | null;

  /** Sharpe 5% 分位（AC 必须；下沿） */
  sharpe_p5: number | null;

  // === 诊断字段 ===
  /** N 次模拟最终收益均值 */
  return_mean: number | null;
  /** N 次模拟最终收益 n-1 样本标准差 */
  return_std: number | null;
  /** N 次模拟最大回撤均值 */
  drawdown_mean: number | null;
  /** N 次模拟 sharpe 均值（剔除 null sharpe） */
  sharpe_mean: number | null;
  /** N 次模拟里 final_return > 0 的占比（0..1 小数） */
  positive_simulation_ratio: number | null;
}

/**
 * run() 输入。三种入参形态：
 *
 * (1) `quant_backtest_result_id`：从 DB 读 QuantBacktestTrade 行得到
 *     return_pct 序列；最常见的入参方式（CLI / UI 都按 result_id 触发）。
 *
 * (2) `trade_returns_pct`：纯 in-memory 模式，单测 / 嵌入式调用方已经手上
 *     有 returns 数组，不想再 round-trip DB。
 *
 * 至少要提供其中一种；同时提供时 (2) 优先（in-memory 数据本就是 source of
 * truth）。
 */
export interface MonteCarloInput {
  /** 源回测 ID（DB 模式必填） */
  quant_backtest_result_id?: number;
  /** in-memory 模式：直接传 trade returns（百分数） */
  trade_returns_pct?: number[];
  /** 物化进 MonteCarloResult 行的 strategy_key（与父结果保持一致） */
  strategy_key?: string;
}

export interface MonteCarloOptions {
  /** 模拟次数（默认 DEFAULT_SIMULATION_COUNT=1000） */
  simulation_count?: number;
  /** RNG seed（默认 DEFAULT_SEED=42） */
  seed?: number;
  /** 是否写库（默认 true；in-memory 模式且 base_run_id 缺失时自动 false） */
  persist?: boolean;
  /** 自定义 TradeReturnSource（测试注入 fake；不传走 PRODUCTION） */
  trade_return_source?: TradeReturnSource;
  /** 自定义 source 标识（写入 MonteCarloResult.source；默认 'monte_carlo_stress_test'） */
  source?: string;
}

/**
 * TradeReturnSource 抽象。让测试可以注入 fake source 完全脱离 DB。
 *
 * 入参 (quant_backtest_result_id) → 出参 { strategy_key, returns_pct[] }。
 * 缺失时 returns_pct 为空数组（caller 处理 throw）。
 */
export interface TradeReturnSource {
  loadTradeReturns(quant_backtest_result_id: number): Promise<{
    strategy_key: string;
    trade_returns_pct: number[];
  }>;
}

/**
 * 生产默认 TradeReturnSource：lazy require QuantBacktestTrade 与
 * QuantBacktestResult，避免单测拉重量级 DB stack。
 */
export const PRODUCTION_TRADE_RETURN_SOURCE: TradeReturnSource = {
  async loadTradeReturns(quant_backtest_result_id: number) {
    // lazy require — 避免本模块顶部 import 让 fake-source 单测也付出加载重量级
    // 子系统的代价（同 GridSearchOptimizer.defaultBacktestRunner 范式）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { QuantBacktestResult: QBR } = require('../../models/QuantBacktestResult');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { QuantBacktestTrade: QBT } = require('../../models/QuantBacktestTrade');

    const result = await QBR.findByPk(quant_backtest_result_id);
    if (!result) {
      throw new Error(
        `PRODUCTION_TRADE_RETURN_SOURCE: QuantBacktestResult #${quant_backtest_result_id} 未找到`
      );
    }
    const tradeRows = await QBT.findAll({
      where: {
        task_id: result.task_id,
        strategy_key: result.strategy_key,
        // 只取已平仓的 trade（return_pct 才有意义）；未平仓 trade 浮盈不能算重排
        sell_date: { [Op.ne]: null },
        return_pct: { [Op.ne]: null },
      },
      attributes: ['return_pct'],
      raw: true,
    });
    const returns: number[] = [];
    for (const r of tradeRows as Array<{ return_pct: number | string | null }>) {
      const v = Number(r.return_pct);
      if (Number.isFinite(v)) returns.push(v);
    }
    return {
      strategy_key: result.strategy_key,
      trade_returns_pct: returns,
    };
  },
};

export interface MonteCarloRunResult {
  /** 写库时关联的 base_run_id；in-memory 模式且未传 ID 时为 null */
  base_run_id: number | null;
  /** 使用的 seed */
  seed: number;
  /** 实际跑的模拟次数 */
  simulation_count: number;
  /** 每次模拟的 outcome（按 simulation_index 顺序） */
  outcomes: SimulationOutcome[];
  /** 聚合分布统计 */
  distribution: DistributionSummary;
  /** 物化进 MonteCarloResult 行的 strategy_key */
  strategy_key: string;
  /** 写库 row id；非 persist 时 null */
  persisted_id: number | null;
  /** 总执行 ms */
  duration_ms: number;
}

// ============================================================
// 纯函数 helpers — 独立单测
// ============================================================

/**
 * 对一个**已升序排序**的数组算 q 分位数（线性插值）。
 *
 * - q ∈ [0, 1]；q < 0 / q > 1 抛错；
 * - 空数组返回 null；
 * - 单元素数组返回该值；
 * - 标准插值：position = q * (n - 1)；取 lower + (upper - lower) * frac。
 *
 * 注意：**caller 负责传入升序数组**。本函数不验证排序避免 O(n log n) 开销，且
 * caller 通常已经排好（aggregateSimulations 内部统一排一次）。
 *
 * 示例：[1,2,3,4,5] q=0.5 → 3；q=0.25 → 2；q=0.05 → 1.2
 */
export function computeQuantile(sortedAsc: number[], q: number): number | null {
  if (!sortedAsc || sortedAsc.length === 0) return null;
  if (!Number.isFinite(q)) {
    throw new Error(`computeQuantile: q 必须有限数, 收到 ${q}`);
  }
  if (q < 0 || q > 1) {
    throw new Error(`computeQuantile: q 必须 ∈ [0, 1], 收到 ${q}`);
  }
  if (sortedAsc.length === 1) return sortedAsc[0];

  const position = q * (sortedAsc.length - 1);
  const lowerIdx = Math.floor(position);
  const upperIdx = Math.ceil(position);
  if (lowerIdx === upperIdx) return sortedAsc[lowerIdx];

  const lower = sortedAsc[lowerIdx];
  const upper = sortedAsc[upperIdx];
  const frac = position - lowerIdx;
  return lower + (upper - lower) * frac;
}

/**
 * Fisher-Yates 洗牌（**返回新数组**，不 mutate 输入）。
 *
 * 注：这是 *无放回* 重排——同样的 N 笔 returns 重新排列。不是 *有放回* 的
 * 自助法 (bootstrap with replacement)。AC 用语是"随机重排"暗示无放回——这
 * 也是路径敏感性测试更常用的形式，因为它保留了完整的样本统计（mean / std
 * 不变，只有顺序变），让 sharpe / max_drawdown 的分布变化纯粹来自顺序。
 *
 * 若未来需要有放回的 classical bootstrap，扩 `mode: 'shuffle' | 'with_replacement'`
 * 参数即可。
 */
export function bootstrapResample(returnsPct: number[], rng: SeededRandom): number[] {
  const out = returnsPct.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    // rng.next() ∈ [0, 1)，floor(rng * (i+1)) ∈ [0, i]
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 复利得到最终累计收益 %（百分数）。
 *
 * 公式：final = (prod(1 + r_i / 100) - 1) * 100
 *
 * - 空数组返回 0（没交易 = 没收益）
 * - 任一 (1 + r_i / 100) ≤ 0 → 视为爆仓 → 直接 -100%（防 log/sqrt 错误传播）
 *
 * 示例：[10, -5, 8] → (1.10 * 0.95 * 1.08 - 1) * 100 ≈ 12.86%
 */
export function computeSimulationFinalReturn(returnsPct: number[]): number {
  if (!returnsPct || returnsPct.length === 0) return 0;
  let cumulative = 1.0;
  for (const r of returnsPct) {
    if (!Number.isFinite(r)) continue;
    const factor = 1 + r / 100;
    if (factor <= 0) {
      // 爆仓：单笔亏损 ≥ 100%（A 股理论上不可能，但用户可能传入 fake data）
      return -100;
    }
    cumulative *= factor;
  }
  return (cumulative - 1) * 100;
}

/**
 * 给一个 returnsPct 序列，按 trade 顺序复利得到资金曲线，算最大回撤百分比
 * （**正数**；e.g. 18.5 = -18.5% 回撤）。
 *
 * - 空数组返回 0
 * - 任一 (1 + r/100) ≤ 0 → 爆仓 → 返回 100%（最深回撤）
 * - 单 trade 数组：若 r > 0 dd=0；若 r < 0 dd = -r（亏损本身就是回撤）
 *
 * **注意**：这里的"回撤"基于**累积权益曲线**而不是连续日权益曲线，因为我们
 * 没有 trade 之间的日级 equity（QuantBacktestResult.equity_curve_json 是按
 * trade-by-trade 累积的近似）。这是为 MonteCarlo 简化的"trade-bar drawdown"，
 * 比真实"daily drawdown"通常偏小，是相对比较指标。
 */
export function computeSimulationMaxDrawdown(returnsPct: number[]): number {
  if (!returnsPct || returnsPct.length === 0) return 0;
  let cumulative = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  for (const r of returnsPct) {
    if (!Number.isFinite(r)) continue;
    const factor = 1 + r / 100;
    if (factor <= 0) {
      // 爆仓：100% 回撤
      return 100;
    }
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
 * 算 sharpe = mean(returns) / std(returns) * sqrt(252)。
 *
 * - returns.length < MIN_RETURNS_FOR_SHARPE (5) → null（n-1 公式不稳）
 * - std = 0（所有 return 相等，理论上罕见）→ null（防 NaN）
 *
 * **注意 sharpe 假设**：把 trade returns 当成"每个 trade 一个时间单位"算 sharpe，
 * 不是真实的"日级 sharpe"。SHARPE_ANNUALIZATION_FACTOR=sqrt(252) 是把它 nominally
 * 缩放成"年化"形式让数字与传统 sharpe 在同一量级，但绝对值不可直接对比
 * QuantBacktestResult.sharpe_ratio（后者基于日级 equity 序列）。MC 中分位数
 * sharpe 用于 *相对比较* 不同模拟之间的稳健性。
 */
export function computeSimulationSharpe(returnsPct: number[]): number | null {
  const valid = (returnsPct || []).filter(v => Number.isFinite(v));
  if (valid.length < MIN_RETURNS_FOR_SHARPE) return null;

  const m = valid.reduce((s, v) => s + v, 0) / valid.length;
  let ss = 0;
  for (const v of valid) ss += (v - m) * (v - m);
  const std = Math.sqrt(ss / (valid.length - 1));
  if (std === 0 || !Number.isFinite(std)) return null;

  return (m / std) * SHARPE_ANNUALIZATION_FACTOR;
}

/**
 * 把 N 次模拟结果聚合成 DistributionSummary。
 *
 * 规则：
 *   - 空 outcomes → 全 null（所有分位 + mean + std）
 *   - 单 outcome → 分位数全 = 该值；std = null（n-1 不可用）
 *   - sharpe 为 null 的 outcome **不进入** sharpe 聚合（独立 valid 数组）
 *   - 数值字段（return / drawdown）全部进入聚合（NaN 已在前面剔除）
 *   - positive_simulation_ratio = 严格 > 0 的 outcome 数 / 总 outcomes（= 0 不计正）
 */
export function aggregateSimulations(outcomes: SimulationOutcome[]): DistributionSummary {
  const tradeCount = 0; // caller (run()) 会覆盖这个字段；本函数不知道源 trade_count
  if (!outcomes || outcomes.length === 0) {
    return {
      simulation_count: 0,
      trade_count: tradeCount,
      return_p5: null,
      return_p50: null,
      return_p95: null,
      drawdown_p95: null,
      sharpe_p5: null,
      return_mean: null,
      return_std: null,
      drawdown_mean: null,
      sharpe_mean: null,
      positive_simulation_ratio: null,
    };
  }

  const returns = outcomes
    .map(o => o.final_return_pct)
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b);
  const drawdowns = outcomes
    .map(o => o.max_drawdown_pct)
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b);
  const sharpes = outcomes
    .map(o => o.sharpe)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);

  const returnMean = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : null;
  let returnStd: number | null = null;
  if (returns.length >= 2 && returnMean !== null) {
    let ss = 0;
    for (const v of returns) ss += (v - returnMean) * (v - returnMean);
    returnStd = Math.sqrt(ss / (returns.length - 1));
  }
  const drawdownMean = drawdowns.length
    ? drawdowns.reduce((s, v) => s + v, 0) / drawdowns.length
    : null;
  const sharpeMean = sharpes.length ? sharpes.reduce((s, v) => s + v, 0) / sharpes.length : null;
  const positiveCount = outcomes.filter(
    o => Number.isFinite(o.final_return_pct) && o.final_return_pct > 0
  ).length;
  const positiveRatio = outcomes.length > 0 ? positiveCount / outcomes.length : null;

  return {
    simulation_count: outcomes.length,
    trade_count: tradeCount,
    return_p5: computeQuantile(returns, 0.05),
    return_p50: computeQuantile(returns, 0.5),
    return_p95: computeQuantile(returns, 0.95),
    drawdown_p95: computeQuantile(drawdowns, 0.95),
    sharpe_p5: computeQuantile(sharpes, 0.05),
    return_mean: returnMean,
    return_std: returnStd,
    drawdown_mean: drawdownMean,
    sharpe_mean: sharpeMean,
    positive_simulation_ratio: positiveRatio,
  };
}

function roundTo(value: number | null | undefined, digits: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const k = Math.pow(10, digits);
  return Math.round(Number(value) * k) / k;
}

function roundDistribution(d: DistributionSummary): DistributionSummary {
  return {
    ...d,
    return_p5: roundTo(d.return_p5, 4),
    return_p50: roundTo(d.return_p50, 4),
    return_p95: roundTo(d.return_p95, 4),
    drawdown_p95: roundTo(d.drawdown_p95, 4),
    sharpe_p5: roundTo(d.sharpe_p5, 4),
    return_mean: roundTo(d.return_mean, 4),
    return_std: roundTo(d.return_std, 4),
    drawdown_mean: roundTo(d.drawdown_mean, 4),
    sharpe_mean: roundTo(d.sharpe_mean, 4),
    positive_simulation_ratio: roundTo(d.positive_simulation_ratio, 4),
  };
}

// ============================================================
// 主类
// ============================================================

export class MonteCarloStressTest {
  /**
   * 单次完整压力测试流程入口。流程：
   *   1. 解析 input：从 DB / in-memory 拿到 returns_pct 数组 + strategy_key
   *   2. 验证 trade_count ≥ MIN_TRADES_FOR_BOOTSTRAP 与 simulation_count 范围
   *   3. 初始化 SeededRandom(seed)
   *   4. for i in [0..N): bootstrap 重排 → 算 final_return / max_drawdown / sharpe
   *   5. aggregateSimulations() 聚合分布
   *   6. 可选写 MonteCarloResult（upsert 同 base_run_id+seed）
   */
  async run(input: MonteCarloInput, options: MonteCarloOptions = {}): Promise<MonteCarloRunResult> {
    const t0 = Date.now();
    const seed = options.seed ?? DEFAULT_SEED;
    const simulationCount = options.simulation_count ?? DEFAULT_SIMULATION_COUNT;
    const source = options.source ?? 'monte_carlo_stress_test';
    const tradeReturnSource = options.trade_return_source ?? PRODUCTION_TRADE_RETURN_SOURCE;

    if (!Number.isFinite(simulationCount) || simulationCount < MIN_SIMULATION_COUNT) {
      throw new Error(
        `MonteCarloStressTest.run: simulation_count 必须 ≥ ${MIN_SIMULATION_COUNT}, 收到 ${simulationCount}`
      );
    }
    if (simulationCount > MAX_SIMULATION_COUNT) {
      throw new Error(
        `MonteCarloStressTest.run: simulation_count 必须 ≤ ${MAX_SIMULATION_COUNT}, 收到 ${simulationCount}`
      );
    }

    // (1) 解析 input
    let returnsPct: number[] = [];
    let strategyKey = input.strategy_key || '';
    let baseRunId: number | null = null;

    if (input.trade_returns_pct && input.trade_returns_pct.length > 0) {
      // in-memory 模式优先
      returnsPct = input.trade_returns_pct.filter(v => Number.isFinite(v));
      baseRunId = input.quant_backtest_result_id ?? null;
    } else if (input.quant_backtest_result_id) {
      const loaded = await tradeReturnSource.loadTradeReturns(input.quant_backtest_result_id);
      strategyKey = strategyKey || loaded.strategy_key;
      returnsPct = loaded.trade_returns_pct.filter(v => Number.isFinite(v));
      baseRunId = input.quant_backtest_result_id;
    } else {
      throw new Error(
        'MonteCarloStressTest.run: 必须提供 quant_backtest_result_id 或 trade_returns_pct 之一'
      );
    }

    if (returnsPct.length < MIN_TRADES_FOR_BOOTSTRAP) {
      throw new Error(
        `MonteCarloStressTest.run: 有效 trade returns 数量 ${returnsPct.length} < ${MIN_TRADES_FOR_BOOTSTRAP}，无法重排`
      );
    }

    if (!strategyKey) {
      logger.warn('[monte-carlo] strategy_key 未提供 — 将以 "unknown" 物化到 MonteCarloResult');
      strategyKey = 'unknown';
    }

    const persistDefault = options.persist !== false;
    const persist = persistDefault && baseRunId !== null;

    logger.info(
      `[monte-carlo] start: base_run_id=${baseRunId ?? 'in-memory'} strategy=${strategyKey} ` +
        `trades=${returnsPct.length} simulations=${simulationCount} seed=${seed} persist=${persist}`
    );

    // (3) RNG
    const rng = new SeededRandom(seed);

    // (4) 跑 N 次模拟
    const outcomes: SimulationOutcome[] = [];
    for (let i = 0; i < simulationCount; i += 1) {
      const shuffled = bootstrapResample(returnsPct, rng);
      outcomes.push({
        final_return_pct: computeSimulationFinalReturn(shuffled),
        max_drawdown_pct: computeSimulationMaxDrawdown(shuffled),
        sharpe: computeSimulationSharpe(shuffled),
      });
    }

    // (5) 聚合
    const distributionRaw = aggregateSimulations(outcomes);
    const distribution = roundDistribution({
      ...distributionRaw,
      trade_count: returnsPct.length,
    });

    // (6) 写库（upsert by base_run_id + seed）
    let persistedId: number | null = null;
    if (persist) {
      // upsert: 同 base_run_id + seed → 覆盖
      const existing = await MonteCarloResult.findOne({
        where: { base_run_id: baseRunId!, seed },
      });
      const payload = {
        base_run_id: baseRunId!,
        seed,
        simulation_count: simulationCount,
        trade_count: returnsPct.length,
        return_p5: distribution.return_p5,
        return_p50: distribution.return_p50,
        return_p95: distribution.return_p95,
        drawdown_p95: distribution.drawdown_p95,
        sharpe_p5: distribution.sharpe_p5,
        return_mean: distribution.return_mean,
        return_std: distribution.return_std,
        drawdown_mean: distribution.drawdown_mean,
        sharpe_mean: distribution.sharpe_mean,
        positive_simulation_ratio: distribution.positive_simulation_ratio,
        strategy_key: strategyKey,
        computed_at: new Date(),
        source,
      };
      if (existing) {
        await existing.update(payload);
        persistedId = existing.base_run_id; // composite PK; expose base_run_id for diagnostics
      } else {
        const created = await MonteCarloResult.create(payload);
        persistedId = created.base_run_id;
      }
    }

    const duration = Date.now() - t0;
    logger.info(
      `[monte-carlo] done in ${(duration / 1000).toFixed(2)}s: ` +
        `return_p5=${distribution.return_p5} return_p50=${distribution.return_p50} ` +
        `return_p95=${distribution.return_p95} dd_p95=${distribution.drawdown_p95} ` +
        `sharpe_p5=${distribution.sharpe_p5} positive_ratio=${distribution.positive_simulation_ratio} ` +
        `(persisted=${persistedId !== null})`
    );

    return {
      base_run_id: baseRunId,
      seed,
      simulation_count: simulationCount,
      outcomes,
      distribution,
      strategy_key: strategyKey,
      persisted_id: persistedId,
      duration_ms: duration,
    };
  }

  /**
   * 查某次回测某 seed 的结果（composite PK 精确查询）。
   */
  async getRunResult(base_run_id: number, seed: number): Promise<MonteCarloResult | null> {
    return MonteCarloResult.findOne({ where: { base_run_id, seed } });
  }

  /**
   * 查某次回测的全部 seeds 结果（按 seed 升序）。
   */
  async getRunResults(base_run_id: number): Promise<MonteCarloResult[]> {
    return MonteCarloResult.findAll({
      where: { base_run_id },
      order: [['seed', 'ASC']],
    });
  }

  /**
   * 删除某次回测的全部 MC 结果（不影响源 QuantBacktestResult）。
   */
  async deleteRun(base_run_id: number): Promise<{ deleted: number }> {
    const deleted = await MonteCarloResult.destroy({ where: { base_run_id } });
    return { deleted };
  }

  /**
   * 清理 N 天前的所有 MC 结果。
   */
  async cleanupOlderThan(days: number): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const deleted = await MonteCarloResult.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted };
  }

  /**
   * 列出最近 N 个有 MC 结果的 base_run_id（DESCENDING latest computed_at）。
   */
  async listRecentRuns(limit = 30): Promise<
    Array<{
      base_run_id: number;
      strategy_key: string;
      seed_count: number;
      latest_computed_at: Date;
    }>
  > {
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const rows = (await MonteCarloResult.sequelize!.query(
      `SELECT base_run_id, strategy_key,
              COUNT(DISTINCT seed) AS seed_count,
              MAX(computed_at) AS latest_computed_at
       FROM monte_carlo_results
       GROUP BY base_run_id, strategy_key
       ORDER BY latest_computed_at DESC
       LIMIT :limit`,
      { replacements: { limit: safeLimit }, type: 'SELECT' as any }
    )) as any[];
    return rows.map(r => ({
      base_run_id: Number(r.base_run_id),
      strategy_key: String(r.strategy_key),
      seed_count: Number(r.seed_count),
      latest_computed_at: new Date(r.latest_computed_at),
    }));
  }
}

// 单例 — 与 gridSearchOptimizer / walkForwardValidator / regimeSegmentedBacktest 一致
export const monteCarloStressTest = new MonteCarloStressTest();
