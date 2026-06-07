/**
 * BenchmarkAttributionService — 基准比较与超额收益拆解（US-045）
 *
 * 对一次完成的回测（QuantBacktestResult.id 或 in-memory equity_curve）vs
 * **N 个基准（默认 HS300 / CSI500 / CSI1000）** 自动计算：
 *   - **alpha**：年化超额收益（CAPM 回归截距 * 252）
 *   - **beta**：CAPM 回归斜率（敏感度）
 *   - **information_ratio**：(策略 - 基准) 超额收益的 Sharpe（≈年化）
 *   - **excess_return**：策略累计 - 基准累计（百分数）
 *   - **excess_drawdown**：基于「策略-基准」逐日 excess return 的最大回撤
 *
 * **为什么需要基准归因**：
 *   单看策略 sharpe=1.5 / annual=15% 看不出来这是不是因为 2023 年大盘普涨
 *   (beta) 还是策略真的有 alpha。基准归因把策略收益拆成「beta * 基准 + alpha」
 *   两部分 — 一眼回答「这个策略到底是 lucky 还是 skilled」。
 *
 *   对多基准（HS300/CSI500/CSI1000）独立计算，能识别策略 *风格*：
 *     - HS300 alpha=12% / CSI1000 alpha=-3% → 大盘价值风格策略
 *     - HS300 alpha=-3% / CSI1000 alpha=15% → 小盘动量风格策略
 *     - 三个基准都 alpha>10% → 真 alpha（与任何风格无关）
 *
 * **公共接口**：
 *   - `computeAttribution(input, options?)` — 异步执行一次归因；选择性写入
 *     BenchmarkAttributionResult；返回 { attributions, persisted_ids }。
 *   - `getRun(id)` — 查某 id 的结果。
 *   - `listRecentRuns(limit)` — 列出最近 N 个归因结果（按 created_at 倒序）。
 *   - `deleteRun(id)` — 删除某 id 的结果。
 *   - `cleanupOlderThan(days)` — 删除 N 天前的全部结果。
 *
 * **8 个纯函数 helper（独立单测，完全脱离 DB）**：
 *   - `deriveDailyReturnsFromEquityCurve(curve)` — equity 曲线 → 日收益 % 序列（按 date）。
 *   - `alignReturnSeries(strategy, benchmark)` — 两个 (date, value) 序列 → 共同日 + 两个对齐数组。
 *   - `computeMean(values)` — 算术均值；空数组 null。
 *   - `computeStddev(values)` — n-1 样本标准差；< 2 个值 null。
 *   - `linearRegression(x, y)` — OLS y = alpha + beta * x；返回 {alpha, beta, r_squared}。
 *   - `computeInformationRatio(strategyReturns, benchmarkReturns)` — IR = mean(excess) / std(excess) * sqrt(252)。
 *   - `computeCumulativeReturn(daily_returns_pct)` — 复利累计收益（百分数）。
 *   - `computeExcessDrawdown(strategy_returns_pct, benchmark_returns_pct)` — 基于 excess 序列复利权益曲线的最大回撤百分比。
 *
 * **DataSource DI 模式**（与 GridSearchOptimizer.BacktestRunner /
 * RegimeSegmentedBacktest.RegimeSource / MonteCarloStressTest.TradeReturnSource /
 * PortfolioOptimizer.StrategyReturnSource 同款）：
 *   - 生产默认 `PRODUCTION_BENCHMARK_RETURN_SOURCE` — lazy require 从
 *     DailyBar 读基准日线；
 *   - 测试注入 fake source 完全脱离 DB；同时支持 in-memory 模式直接传入
 *     strategy_returns + benchmark_returns 数组（单测 / 嵌入式调用方都用得上）。
 *
 * **关键约束**：
 *   - **至少 MIN_SAMPLE_COUNT (5) 个对齐后日收益**：少于此回归不稳；该基准跳过
 *     （写一行 sample_count=5 + 全 null 指标），不阻塞其他基准计算。
 *   - **策略 / 基准日收益 NaN/Infinity 剔除**：单日数据异常不污染回归整体。
 *   - **基准缺失整段数据 → 该基准 attribution 全 null + sample_count=0**：不抛错，
 *     让 caller 看清楚是哪个基准失败（沪深 300 数据缺失 vs 中证 500 数据缺失 vs 策略本身问题）。
 *   - **不复用 OptimizationRun 父表**（与 US-040/US-041/US-042/US-043/US-044 判据一致）。
 *
 * **设计取舍**：
 *   - **CAPM 回归用日收益级别而非月收益**：A 股回测通常 6 个月起，日收益 ~120 个样本足够
 *     回归稳定（vs 月收益只 6 个样本）。
 *   - **alpha 年化系数 = 252（交易日）**：与 MonteCarloStressTest /
 *     PortfolioOptimizer 一致。
 *   - **IR 的 sqrt(252) 是 nominal annualization**：与传统 sharpe 在同一量级，
 *     不严格代表「年化 IR」但便于跨策略比较。
 *
 * 主要消费方：
 *   - QuantBacktestService 完成 hook（每次回测完成后异步触发，per-basenmark 失败隔离）
 *   - benchmark-attribution CLI（US-045）
 *   - 未来 US-016 策略实验室 "基准对比" tab
 *   - 未来 US-046 IndustryAttributionService（行业 alpha vs 整体 alpha 联表）
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { BenchmarkAttributionResult } from '../../models/BenchmarkAttributionResult';
import { QuantEquityPoint } from '../types/QuantTypes';

// ============================================================
// 常量
// ============================================================

/** 默认三大基准（AC 指定）：沪深 300 / 中证 500 / 中证 1000 */
export const DEFAULT_BENCHMARK_SYMBOLS: ReadonlyArray<string> = Object.freeze([
  'sh.000300',
  'sh.000905',
  'sh.000852',
]);

/** 基准 symbol → 中文名（与 BenchmarkIndexService.DEFAULT_BENCHMARK_INDICES 一致） */
export const BENCHMARK_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  'sh.000300': '沪深300',
  'sh.000001': '上证指数',
  'sz.399001': '深证成指',
  'sz.399006': '创业板指',
  'sh.000905': '中证500',
  'sh.000852': '中证1000',
  'sh.000688': '科创50',
});

/** 算 alpha/beta/IR 所需最小对齐后日收益数 */
export const MIN_SAMPLE_COUNT = 5;

/** 年化系数（252 个交易日 / 年） */
export const ANNUALIZATION_FACTOR = 252;

/** sqrt(252)，与 MonteCarloStressTest / PortfolioOptimizer 一致 */
export const SHARPE_ANNUALIZATION_SQRT = Math.sqrt(ANNUALIZATION_FACTOR);

/**
 * IR 计算时判定 std(excess) ≈ 0 的浮点阈值。
 *
 * 当 strategy = benchmark + 常数 alpha 时，理论 excess std = 0；但浮点累计误差会让
 * std 落在 1e-15 ~ 1e-17 范围，让 IR = mean / std 爆为天文数字。1e-10 远小于任何
 * 真实日收益的 noise floor（实测 daily std 通常 > 0.1）→ 不会误杀有意义的 IR。
 */
export const IR_STD_EPSILON = 1e-10;

// ============================================================
// Types
// ============================================================

/**
 * (date, daily_return_pct) 序列条目。
 * daily_return_pct 是 *百分数* 单位（e.g. 1.23 = +1.23%）。
 */
export interface DailyReturnPoint {
  date: string;
  return_pct: number;
}

/**
 * 单基准归因结果。
 *
 * - `alpha_annual_pct`：年化 alpha (%) = CAPM intercept * 252
 * - `beta`：CAPM 回归斜率
 * - `information_ratio`：(策略 - 基准) 超额收益的 Sharpe = mean(excess) / std(excess) * sqrt(252)
 * - `excess_return_pct`：策略累计 - 基准累计（百分数）
 * - `excess_drawdown_pct`：基于「策略-基准」逐日 excess 序列算的最大回撤（正数）
 * - `sample_count`：对齐后日收益数；< MIN 时其他指标可能为 null
 * - `r_squared`：回归 R²；< MIN 或回归不稳时 null
 * - `strategy_return_pct` / `benchmark_return_pct`：分别的累计收益
 */
export interface BenchmarkAttribution {
  benchmark_symbol: string;
  benchmark_name?: string;
  alpha_annual_pct: number | null;
  beta: number | null;
  information_ratio: number | null;
  excess_return_pct: number | null;
  excess_drawdown_pct: number | null;
  sample_count: number;
  r_squared: number | null;
  strategy_return_pct: number | null;
  benchmark_return_pct: number | null;
  /** 区间起止；以 *对齐后* 数据实际覆盖的范围为准 */
  period_start: string | null;
  period_end: string | null;
  /** 该基准计算失败的原因；成功时 null */
  error?: string;
}

/**
 * `computeAttribution()` 输入。三种入参形态：
 *
 * (1) `quant_backtest_result_id`：从 DB 读 QuantBacktestResult 的
 *     equity_curve_json → 派生日收益。最常见的入参方式（CLI / hook / UI 都按 result_id 触发）。
 *
 * (2) `equity_curve`：纯 in-memory 模式 — 单测 / 嵌入式调用方已经手上有 equity 序列。
 *
 * (3) `strategy_daily_returns`：纯 in-memory 模式 — 已经派生好日收益，跳过 equity → return 转换。
 *
 * 优先级：(3) > (2) > (1)。同时提供时取最高优先级。
 */
export interface BenchmarkAttributionInput {
  quant_backtest_result_id?: number;
  equity_curve?: QuantEquityPoint[];
  /** 已派生的策略日收益（百分数；与 deriveDailyReturnsFromEquityCurve 输出格式一致） */
  strategy_daily_returns?: DailyReturnPoint[];
  /** 物化进 BenchmarkAttributionResult 行的 strategy_key（与父结果保持一致） */
  strategy_key?: string;
  /** 自定义基准列表；不传走 DEFAULT_BENCHMARK_SYMBOLS（HS300 + CSI500 + CSI1000） */
  benchmark_symbols?: ReadonlyArray<string>;
}

/**
 * BenchmarkReturnSource 抽象。让测试可以注入 fake source 完全脱离 DB。
 *
 * 入参 (benchmark_symbol, start_date, end_date) →
 * 出参 DailyReturnPoint[]（按 date 升序；首日 return_pct = 0 或省略；自然日缺失视为无效）。
 *
 * 缺失整段数据时返回空数组（caller 把该基准的 attribution 标 null + sample_count=0）。
 */
export interface BenchmarkReturnSource {
  loadBenchmarkReturns(
    benchmark_symbol: string,
    start_date: string,
    end_date: string
  ): Promise<DailyReturnPoint[]>;
}

/**
 * 生产默认 BenchmarkReturnSource：lazy require DailyBar + Stock，避免单测拉重量级 DB stack。
 *
 * 失败时返回空数组 + 日志（不抛错；caller 把该基准 attribution 标 null 不阻塞其他基准）。
 */
export const PRODUCTION_BENCHMARK_RETURN_SOURCE: BenchmarkReturnSource = {
  async loadBenchmarkReturns(
    benchmark_symbol: string,
    start_date: string,
    end_date: string
  ): Promise<DailyReturnPoint[]> {
    try {
      // lazy require — 避免本模块顶部 import 让 fake-source 单测也付出加载重量级
      // 子系统的代价（同 GridSearchOptimizer.defaultBacktestRunner / MonteCarloStressTest
      // PRODUCTION_TRADE_RETURN_SOURCE 范式）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');

      const stock = await Stock.findOne({ where: { symbol: benchmark_symbol } });
      if (!stock) {
        logger.warn(
          `[benchmark-attribution] 基准 ${benchmark_symbol} 未找到对应 Stock 行（请先跑 BenchmarkIndexService.ensureBenchmarkIndices）`
        );
        return [];
      }

      const bars = await DailyBar.findAll({
        where: {
          stock_id: stock.id,
          time: {
            [Op.gte]: new Date(`${start_date}T00:00:00.000Z`),
            [Op.lte]: new Date(`${end_date}T23:59:59.999Z`),
          },
        },
        attributes: ['time', 'close'],
        order: [['time', 'ASC']],
        raw: true,
      });

      if (!bars.length) {
        logger.warn(
          `[benchmark-attribution] 基准 ${benchmark_symbol} 区间 ${start_date}..${end_date} 无 DailyBar 数据`
        );
        return [];
      }

      // 从 close 价格序列派生日收益
      const points: DailyReturnPoint[] = [];
      let prevClose: number | null = null;
      for (const bar of bars as Array<{ time: Date | string; close: number | string }>) {
        const close = Number(bar.close);
        if (!Number.isFinite(close) || close <= 0) {
          prevClose = null; // 重置 — 不能跨缺失日算 return
          continue;
        }
        const dateStr =
          bar.time instanceof Date
            ? bar.time.toISOString().split('T')[0]
            : String(bar.time).slice(0, 10);
        if (prevClose !== null && prevClose > 0) {
          const ret = (close / prevClose - 1) * 100;
          if (Number.isFinite(ret)) {
            points.push({ date: dateStr, return_pct: ret });
          }
        }
        prevClose = close;
      }
      return points;
    } catch (err) {
      logger.warn(
        `[benchmark-attribution] 加载基准 ${benchmark_symbol} 行情失败: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return [];
    }
  },
};

export interface BenchmarkAttributionOptions {
  /** 是否写库；默认 true（in-memory 模式 + 单测应该传 false） */
  persist?: boolean;
  /** 自定义 BenchmarkReturnSource（测试用），默认 PRODUCTION_BENCHMARK_RETURN_SOURCE */
  benchmark_return_source?: BenchmarkReturnSource;
  /** 写库时若已存在同 (run_id, benchmark_symbol, period_start, period_end) 行，是否覆盖更新；默认 true */
  replace_existing?: boolean;
  /** 物化进 BenchmarkAttributionResult.source 字段；默认 'benchmark_attribution_service' */
  source?: string;
}

export interface BenchmarkAttributionRunResult {
  /** 写库时关联的 run_id；in-memory 模式且未传 ID 时为 null */
  run_id: number | null;
  /** strategy_key（与父回测一致 / 自定义 / fallback 'unknown'） */
  strategy_key: string;
  /** 每个基准的归因结果（与输入 benchmark_symbols 顺序一致） */
  attributions: BenchmarkAttribution[];
  /** 实际写入的行 id（与 attributions 同序；持久化失败 / 跳过的为 null） */
  persisted_ids: Array<number | null>;
  /** 总执行 ms */
  duration_ms: number;
}

// ============================================================
// Pure helpers — independently unit-testable
// ============================================================

/**
 * 从 equity_curve 派生日收益序列（百分数）。
 *
 * 算法：return[i] = (equity[i] / equity[i-1] - 1) * 100
 *
 * 失败模式：
 *   - 空 curve / 单天 curve → []
 *   - 非有限 total_value → 跳过该天（重置 prev，不跨缺失日算 return）
 *   - prev_value ≤ 0 → 跳过该天
 *
 * 输出按 date 升序（与输入顺序保持，不重排）。**caller 应确保输入 equity_curve 已升序。**
 */
export function deriveDailyReturnsFromEquityCurve(curve: QuantEquityPoint[]): DailyReturnPoint[] {
  if (!curve || curve.length < 2) return [];
  const points: DailyReturnPoint[] = [];
  let prev: number | null = null;
  let prevDate: string | null = null;
  for (const p of curve) {
    const v = Number(p.total_value);
    if (!Number.isFinite(v) || v <= 0) {
      prev = null;
      prevDate = null;
      continue;
    }
    if (prev !== null && prev > 0 && prevDate !== null) {
      const ret = (v / prev - 1) * 100;
      if (Number.isFinite(ret)) {
        points.push({ date: p.date, return_pct: ret });
      }
    }
    prev = v;
    prevDate = p.date;
  }
  return points;
}

/**
 * 两个 DailyReturnPoint 序列对齐为共同日 + 两个对齐数组。
 *
 * 算法：对 strategy / benchmark 各自构造 Map<date, return>，取交集 dates，
 * 按 date 升序排列，输出 (dates, strategy_aligned, benchmark_aligned)。
 *
 * 失败模式：
 *   - 任一序列为空 → 三个空数组
 *   - 无共同日 → 三个空数组
 *   - 单边 NaN/Infinity → 该日不入交集
 */
export function alignReturnSeries(
  strategy: DailyReturnPoint[],
  benchmark: DailyReturnPoint[]
): { dates: string[]; strategy: number[]; benchmark: number[] } {
  if (!strategy.length || !benchmark.length) {
    return { dates: [], strategy: [], benchmark: [] };
  }
  const strategyMap = new Map<string, number>();
  for (const p of strategy) {
    if (typeof p.date === 'string' && Number.isFinite(p.return_pct)) {
      strategyMap.set(p.date, p.return_pct);
    }
  }
  const benchMap = new Map<string, number>();
  for (const p of benchmark) {
    if (typeof p.date === 'string' && Number.isFinite(p.return_pct)) {
      benchMap.set(p.date, p.return_pct);
    }
  }
  const commonDates: string[] = [];
  for (const date of strategyMap.keys()) {
    if (benchMap.has(date)) commonDates.push(date);
  }
  commonDates.sort();
  const strategyOut: number[] = [];
  const benchmarkOut: number[] = [];
  for (const date of commonDates) {
    strategyOut.push(strategyMap.get(date) as number);
    benchmarkOut.push(benchMap.get(date) as number);
  }
  return { dates: commonDates, strategy: strategyOut, benchmark: benchmarkOut };
}

/** 算术均值。空 / 全无效 → null */
export function computeMean(values: number[]): number | null {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

/** n-1 样本标准差。< 2 个有效值 → null */
export function computeStddev(values: number[]): number | null {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length < 2) return null;
  const m = valid.reduce((s, v) => s + v, 0) / valid.length;
  const ss = valid.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (valid.length - 1));
}

/**
 * OLS 线性回归 y = alpha + beta * x。
 *
 * 公式：
 *   beta = cov(x, y) / var(x)
 *   alpha = mean(y) - beta * mean(x)
 *   r_squared = (cov(x,y))^2 / (var(x) * var(y))
 *
 * 失败模式：
 *   - x / y 长度不等或 < 2 → 全 null
 *   - var(x) = 0（基准全平）→ 无法回归 → 全 null
 *   - 任一含 NaN → 全 null（不静默剔除以免破坏 paired 关系）
 */
export function linearRegression(
  x: number[],
  y: number[]
): { alpha: number | null; beta: number | null; r_squared: number | null } {
  if (!x || !y || x.length !== y.length || x.length < 2) {
    return { alpha: null, beta: null, r_squared: null };
  }
  for (let i = 0; i < x.length; i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
      return { alpha: null, beta: null, r_squared: null };
    }
  }
  const n = x.length;
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let ssXY = 0;
  let ssXX = 0;
  let ssYY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
    ssYY += dy * dy;
  }
  if (ssXX === 0) {
    // 基准 var=0（所有日收益相等 / 全 0）→ 回归无意义
    return { alpha: null, beta: null, r_squared: null };
  }
  const beta = ssXY / ssXX;
  const alpha = meanY - beta * meanX;
  const r2 = ssYY === 0 ? null : (ssXY * ssXY) / (ssXX * ssYY);
  return { alpha, beta, r_squared: r2 };
}

/**
 * 信息比率 = mean(strategy - benchmark) / std(strategy - benchmark) * sqrt(252)。
 *
 * 失败模式：
 *   - 长度不等 / < 2 → null
 *   - std(excess) ≈ 0 → null（策略完全 follow 基准 / 完全 anti-follow / 常数 alpha）
 *
 * **浮点精度处理**：判定 std == 0 时用 IR_STD_EPSILON (1e-10) 阈值而非严格 ===0。
 *   理由：当 strategy = benchmark + 常数 (e.g. strategy = bench + 0.5) 时，理论上
 *   excess std=0，但浮点运算后 std 可能是 ~1e-17 让 IR 爆为天文数字。1e-10 远小于
 *   任何真实 daily return 的 noise floor (实测 daily std 通常 > 0.1)，不会误杀
 *   有意义的 IR。
 */
export function computeInformationRatio(
  strategyReturns: number[],
  benchmarkReturns: number[]
): number | null {
  if (
    !strategyReturns.length ||
    strategyReturns.length !== benchmarkReturns.length ||
    strategyReturns.length < 2
  ) {
    return null;
  }
  const excess: number[] = [];
  for (let i = 0; i < strategyReturns.length; i += 1) {
    const s = strategyReturns[i];
    const b = benchmarkReturns[i];
    if (Number.isFinite(s) && Number.isFinite(b)) {
      excess.push(s - b);
    }
  }
  if (excess.length < 2) return null;
  const meanExc = computeMean(excess);
  const stdExc = computeStddev(excess);
  if (meanExc === null || stdExc === null || stdExc < IR_STD_EPSILON) return null;
  return (meanExc / stdExc) * SHARPE_ANNUALIZATION_SQRT;
}

/**
 * 复利累计收益（百分数）。
 *
 * 算法：prod((1 + r/100)) - 1，然后 * 100。
 *
 * 失败模式：
 *   - 空数组 → 0（没有 return = 0% 涨幅）
 *   - 单笔 ≤ -100% → -100%（爆仓兜底；理论 A 股不会发生）
 *   - NaN 过滤
 */
export function computeCumulativeReturn(dailyReturnsPct: number[]): number {
  if (!dailyReturnsPct.length) return 0;
  let factor = 1;
  for (const r of dailyReturnsPct) {
    if (!Number.isFinite(r)) continue;
    const f = 1 + r / 100;
    if (f <= 0) {
      // 爆仓 short-circuit
      return -100;
    }
    factor *= f;
  }
  return (factor - 1) * 100;
}

/**
 * 基于「策略 - 基准」逐日 excess return 的复利权益曲线最大回撤百分比（**正数**）。
 *
 * 算法：
 *   1. excess[i] = strategy[i] - benchmark[i]
 *   2. 用 excess 序列构造 excess equity 曲线（初始 = 100，累计复利）
 *   3. 算 max drawdown 百分比（peak-trough）/ peak * 100，取最大
 *
 * 失败模式：
 *   - 长度不等 / 空 / 单元素 → 0
 *   - 全 NaN → 0
 */
export function computeExcessDrawdown(
  strategyReturnsPct: number[],
  benchmarkReturnsPct: number[]
): number {
  if (
    !strategyReturnsPct.length ||
    strategyReturnsPct.length !== benchmarkReturnsPct.length ||
    strategyReturnsPct.length < 2
  ) {
    return 0;
  }
  const excessEquity: number[] = [100]; // 起始 100
  let cur = 100;
  for (let i = 0; i < strategyReturnsPct.length; i += 1) {
    const s = strategyReturnsPct[i];
    const b = benchmarkReturnsPct[i];
    if (!Number.isFinite(s) || !Number.isFinite(b)) {
      excessEquity.push(cur);
      continue;
    }
    const excessRet = s - b;
    const f = 1 + excessRet / 100;
    if (f <= 0) {
      cur = 0;
    } else {
      cur *= f;
    }
    excessEquity.push(cur);
  }
  let peak = 0;
  let maxDd = 0;
  for (const v of excessEquity) {
    if (!Number.isFinite(v) || v <= 0) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

// ============================================================
// 内部 helpers（非 export）
// ============================================================

function roundTo(value: number | null | undefined, digits: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const k = Math.pow(10, digits);
  return Math.round(Number(value) * k) / k;
}

// ============================================================
// Main service class
// ============================================================

export class BenchmarkAttributionService {
  /**
   * 一次完整归因流程入口。流程：
   *   1. 解析 input：从 DB 读 QuantBacktestResult / 或 in-memory equity_curve / strategy_daily_returns
   *   2. 派生策略日收益序列（若 input 是 equity_curve）
   *   3. 对每个 benchmark_symbol（默认 3 个）独立计算：
   *      - 拉基准日收益序列 from BenchmarkReturnSource
   *      - 与策略日收益对齐
   *      - 算 alpha / beta / r² / IR / excess_return / excess_drawdown
   *      - 写一行 BenchmarkAttributionResult（可选）
   *   4. 返回 { attributions: BenchmarkAttribution[], persisted_ids }
   *
   * **失败隔离 per-benchmark**：单基准计算失败 → 该 attribution 字段全 null +
   *   error 字段记录，其他基准不受影响。
   */
  async computeAttribution(
    input: BenchmarkAttributionInput,
    options: BenchmarkAttributionOptions = {}
  ): Promise<BenchmarkAttributionRunResult> {
    const startTime = Date.now();
    const persist = options.persist !== false;
    const replaceExisting = options.replace_existing !== false;
    const source = options.source || 'benchmark_attribution_service';
    const benchmarkReturnSource =
      options.benchmark_return_source || PRODUCTION_BENCHMARK_RETURN_SOURCE;

    // (1) 解析 input
    let strategyReturns: DailyReturnPoint[] = [];
    let runId: number | null = null;
    let strategyKey = input.strategy_key || 'unknown';

    if (input.strategy_daily_returns && input.strategy_daily_returns.length > 0) {
      // 优先级 (3)：已派生好的日收益
      strategyReturns = input.strategy_daily_returns.slice();
      runId = input.quant_backtest_result_id ?? null;
    } else if (input.equity_curve && input.equity_curve.length > 0) {
      // 优先级 (2)：in-memory equity_curve
      strategyReturns = deriveDailyReturnsFromEquityCurve(input.equity_curve);
      runId = input.quant_backtest_result_id ?? null;
    } else if (input.quant_backtest_result_id) {
      // 优先级 (1)：从 DB 读 QuantBacktestResult
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { QuantBacktestResult: QBR } = require('../../models/QuantBacktestResult');
      const result = await QBR.findByPk(input.quant_backtest_result_id);
      if (!result) {
        throw new Error(
          `BenchmarkAttributionService.computeAttribution: QuantBacktestResult #${input.quant_backtest_result_id} 未找到`
        );
      }
      runId = result.id;
      strategyKey = input.strategy_key || result.strategy_key || 'unknown';
      const rawCurve = Array.isArray(result.equity_curve_json) ? result.equity_curve_json : [];
      const equityCurve = rawCurve.filter(
        (p: any) => p && typeof p.date === 'string' && Number.isFinite(Number(p.total_value))
      ) as QuantEquityPoint[];
      strategyReturns = deriveDailyReturnsFromEquityCurve(equityCurve);
    } else {
      throw new Error(
        'BenchmarkAttributionService.computeAttribution: 必须提供 strategy_daily_returns / equity_curve / quant_backtest_result_id 三者其一'
      );
    }

    if (strategyReturns.length === 0) {
      throw new Error(
        'BenchmarkAttributionService.computeAttribution: 策略日收益序列为空（equity_curve 不足 2 天或全无效）'
      );
    }

    // (2) 解析 benchmark 列表
    const benchmarkSymbols =
      input.benchmark_symbols && input.benchmark_symbols.length > 0
        ? input.benchmark_symbols
        : DEFAULT_BENCHMARK_SYMBOLS;

    // 用策略日收益的 [first, last] 作为基准查询窗口；
    // alignReturnSeries 后会再次按 date 交集对齐。
    const queryStart = strategyReturns[0].date;
    const queryEnd = strategyReturns[strategyReturns.length - 1].date;

    // (3) 对每个 benchmark 串行计算（per-benchmark 失败隔离）
    const attributions: BenchmarkAttribution[] = [];
    for (const symbol of benchmarkSymbols) {
      try {
        const benchReturns = await benchmarkReturnSource.loadBenchmarkReturns(
          symbol,
          queryStart,
          queryEnd
        );
        const attr = this.computeSingleBenchmark(symbol, strategyReturns, benchReturns);
        attributions.push(attr);
      } catch (err) {
        logger.warn(
          `[benchmark-attribution] 基准 ${symbol} 归因失败: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        attributions.push({
          benchmark_symbol: symbol,
          benchmark_name: BENCHMARK_NAME_MAP[symbol] || symbol,
          alpha_annual_pct: null,
          beta: null,
          information_ratio: null,
          excess_return_pct: null,
          excess_drawdown_pct: null,
          sample_count: 0,
          r_squared: null,
          strategy_return_pct: null,
          benchmark_return_pct: null,
          period_start: null,
          period_end: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (4) 可选写库
    const persistedIds: Array<number | null> = [];
    if (persist && runId !== null) {
      for (const attr of attributions) {
        try {
          const id = await this.persistAttribution(
            runId,
            strategyKey,
            attr,
            source,
            replaceExisting
          );
          persistedIds.push(id);
        } catch (err) {
          logger.warn(
            `[benchmark-attribution] 持久化 ${attr.benchmark_symbol} 失败: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          persistedIds.push(null);
        }
      }
    } else {
      for (let i = 0; i < attributions.length; i += 1) persistedIds.push(null);
    }

    return {
      run_id: runId,
      strategy_key: strategyKey,
      attributions,
      persisted_ids: persistedIds,
      duration_ms: Date.now() - startTime,
    };
  }

  /**
   * 单基准归因核心计算（exposed as private method for testability via class instance）。
   *
   * 流程：
   *   1. alignReturnSeries → 共同日 strategyAligned / benchAligned
   *   2. 不足 MIN_SAMPLE_COUNT → 返回 sample_count 但其他指标全 null
   *   3. linearRegression(benchAligned, strategyAligned) → alpha / beta / r²
   *   4. computeInformationRatio → IR
   *   5. computeCumulativeReturn → 累计收益 (两边各算)
   *   6. computeExcessDrawdown → 超额回撤
   */
  computeSingleBenchmark(
    symbol: string,
    strategy: DailyReturnPoint[],
    benchmark: DailyReturnPoint[]
  ): BenchmarkAttribution {
    const name = BENCHMARK_NAME_MAP[symbol] || symbol;
    const aligned = alignReturnSeries(strategy, benchmark);
    const n = aligned.dates.length;
    if (n === 0) {
      return {
        benchmark_symbol: symbol,
        benchmark_name: name,
        alpha_annual_pct: null,
        beta: null,
        information_ratio: null,
        excess_return_pct: null,
        excess_drawdown_pct: null,
        sample_count: 0,
        r_squared: null,
        strategy_return_pct: null,
        benchmark_return_pct: null,
        period_start: null,
        period_end: null,
        error: '基准数据缺失或与策略无共同日',
      };
    }
    if (n < MIN_SAMPLE_COUNT) {
      // 不足以做稳定回归，但仍可算累计收益
      const stratCum = computeCumulativeReturn(aligned.strategy);
      const benchCum = computeCumulativeReturn(aligned.benchmark);
      return {
        benchmark_symbol: symbol,
        benchmark_name: name,
        alpha_annual_pct: null,
        beta: null,
        information_ratio: null,
        excess_return_pct: roundTo(stratCum - benchCum, 4),
        excess_drawdown_pct: null,
        sample_count: n,
        r_squared: null,
        strategy_return_pct: roundTo(stratCum, 4),
        benchmark_return_pct: roundTo(benchCum, 4),
        period_start: aligned.dates[0],
        period_end: aligned.dates[n - 1],
        error: `对齐后样本数 ${n} 不足最小 ${MIN_SAMPLE_COUNT}`,
      };
    }
    // CAPM 回归：y = strategy_return, x = benchmark_return
    const { alpha, beta, r_squared } = linearRegression(aligned.benchmark, aligned.strategy);
    const ir = computeInformationRatio(aligned.strategy, aligned.benchmark);
    const stratCum = computeCumulativeReturn(aligned.strategy);
    const benchCum = computeCumulativeReturn(aligned.benchmark);
    const excessDd = computeExcessDrawdown(aligned.strategy, aligned.benchmark);

    return {
      benchmark_symbol: symbol,
      benchmark_name: name,
      alpha_annual_pct: alpha === null ? null : roundTo(alpha * ANNUALIZATION_FACTOR, 4),
      beta: roundTo(beta, 4),
      information_ratio: roundTo(ir, 4),
      excess_return_pct: roundTo(stratCum - benchCum, 4),
      excess_drawdown_pct: roundTo(excessDd, 4),
      sample_count: n,
      r_squared: roundTo(r_squared, 4),
      strategy_return_pct: roundTo(stratCum, 4),
      benchmark_return_pct: roundTo(benchCum, 4),
      period_start: aligned.dates[0],
      period_end: aligned.dates[n - 1],
    };
  }

  private async persistAttribution(
    runId: number,
    strategyKey: string,
    attr: BenchmarkAttribution,
    source: string,
    replaceExisting: boolean
  ): Promise<number | null> {
    if (attr.period_start === null || attr.period_end === null) {
      // 没有有效区间，跳过写库
      return null;
    }
    const where = {
      run_id: runId,
      benchmark_symbol: attr.benchmark_symbol,
      period_start: attr.period_start,
      period_end: attr.period_end,
    };
    const existing = await BenchmarkAttributionResult.findOne({ where });
    const payload = {
      run_id: runId,
      strategy_key: strategyKey,
      benchmark_symbol: attr.benchmark_symbol,
      benchmark_name: attr.benchmark_name,
      period_start: attr.period_start,
      period_end: attr.period_end,
      alpha_annual_pct: attr.alpha_annual_pct ?? undefined,
      beta: attr.beta ?? undefined,
      information_ratio: attr.information_ratio ?? undefined,
      excess_return_pct: attr.excess_return_pct ?? undefined,
      excess_drawdown_pct: attr.excess_drawdown_pct ?? undefined,
      sample_count: attr.sample_count,
      r_squared: attr.r_squared ?? undefined,
      strategy_return_pct: attr.strategy_return_pct ?? undefined,
      benchmark_return_pct: attr.benchmark_return_pct ?? undefined,
      computed_at: new Date(),
      source,
    };
    if (existing) {
      if (!replaceExisting) return existing.id;
      await existing.update(payload);
      return existing.id;
    }
    const created = await BenchmarkAttributionResult.create(payload as any);
    return created.id;
  }

  // ============================================================
  // Admin 方法（与 RegimeSegmentedBacktest / PortfolioOptimizer 同款）
  // ============================================================

  /** 查某 id 的结果 */
  async getRun(id: number): Promise<BenchmarkAttributionResult | null> {
    return BenchmarkAttributionResult.findByPk(id);
  }

  /** 按 run_id 查全部基准归因（一次回测 -> N 个基准） */
  async getResultsForRun(run_id: number): Promise<BenchmarkAttributionResult[]> {
    return BenchmarkAttributionResult.findAll({
      where: { run_id },
      order: [['benchmark_symbol', 'ASC']],
    });
  }

  /** 列出最近 N 个归因结果（按 created_at 倒序） */
  async listRecentRuns(limit = 30): Promise<BenchmarkAttributionResult[]> {
    return BenchmarkAttributionResult.findAll({
      order: [['created_at', 'DESC']],
      limit,
    });
  }

  /** 删除某 id 的结果 */
  async deleteRun(id: number): Promise<{ deleted: number }> {
    const count = await BenchmarkAttributionResult.destroy({ where: { id } });
    return { deleted: count };
  }

  /** 按 run_id 删除整套（所有基准） */
  async deleteRunByRunId(run_id: number): Promise<{ deleted: number }> {
    const count = await BenchmarkAttributionResult.destroy({ where: { run_id } });
    return { deleted: count };
  }

  /** 删除 N 天前的全部结果 */
  async cleanupOlderThan(days: number): Promise<{ deleted: number }> {
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`cleanupOlderThan: days 必须为正数，收到 ${days}`);
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const count = await BenchmarkAttributionResult.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted: count };
  }
}

export const benchmarkAttributionService = new BenchmarkAttributionService();
