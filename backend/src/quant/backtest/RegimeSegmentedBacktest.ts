/**
 * RegimeSegmentedBacktest — 分段市场环境回测报告（US-040）
 *
 * 输入一次完成的回测（QuantBacktestResult.id 或一份 in-memory equity_curve +
 * trades），把回测期间按市场环境（bull/bear/range/volatile）切分成 N 个连续段，
 * 对每段独立计算 收益 / 夏普 / 最大回撤 / 胜率 / 成交数。
 *
 * **为什么需要分段验证**：
 *   一个策略整段历史的 sharpe=1.2 可能掩盖了 "bull 段 sharpe=2.5 / volatile 段
 *   sharpe=-1.0" 的真实风险特征。分段验证能回答"我这个策略到底是在哪种行情下
 *   赚钱、在哪种行情下亏钱"——这是 walk-forward 看不到的视角（walk-forward 看
 *   时间滚动 in-sample vs out-of-sample 衰减；regime-segmented 看的是不同
 *   *环境* 的表现差异）。
 *
 * **公共接口**：
 *   - `segment(input, options?)` — 异步执行一次完整分段；选择性写入
 *     RegimeBacktestResult；返回 { segments, summary }。
 *   - `getRunSegments(run_id)` — 按 segment_index 升序查询某次回测的全部段。
 *   - `deleteRun(run_id)` — 删除某次回测的全部段（保留父 QuantBacktestResult）。
 *   - `cleanupOlderThan(days)` — 删除 N 天前的全部段。
 *
 * **三个纯函数 helper（独立单测）**：
 *   - `mapRawRegimeToSegmentRegime(raw)` — 把 MarketEnvironmentService 的 6 种
 *     raw regime 折叠到 4 种 segment regime（与 EnsembleStrategy.
 *     mapToEnsembleRegime 完全一致，复用其语义）。
 *   - `mergeAdjacentSegments(stamps)` — 把 per-day regime stamp 序列 run-length-
 *     encode 成连续段。
 *   - `computeSegmentMetrics(equity, trades, regime, start, end)` — 给一个段
 *     的 equity slice + trades slice，算 return / sharpe / drawdown / win_rate。
 *
 * **RegimeSource 注入模式**（与 WalkForwardValidator.EmbeddedOptimizer 对齐）：
 *   - 生产环境默认走 marketEnvironmentService.getEnvironmentForStock(benchmark,
 *     {as_of: <date>})，对回测期间的每个交易日逐日采样。
 *   - 测试时注入 fake RegimeSource，传入 (asOfDate) → regime 的 Map 让单测
 *     完全脱离 DB / 网络。
 *
 * **错误隔离 per-day**：
 *   - 某日 regime 检测抛错 → 该日 regime='unknown'（折叠到 range）；
 *   - 整条 segment 流程的最后才聚合，单日失败不阻塞后续日。
 *
 * **关键约束**：
 *   - 段必须连续覆盖整个回测期间，不留空隙（每个 equity point 必须属于某个段）。
 *   - 段按 start_date 升序写入；同 regime 的不相邻段视为两条独立记录（e.g.
 *     bull → bear → bull → 三条记录，而非合并）。
 *   - benchmark 默认 sh.000300；可通过 RegimeSegmentInput.benchmark_symbol 覆盖。
 *
 * **设计取舍 — 不复用 OptimizationRun 父表**：
 *   - US-037/US-038/US-039 共享 OptimizationRun，因为他们都是"长时间参数搜索任务"。
 *   - US-040 是 "对一次已完成的 backtest 做事后分析"——不是新的优化任务，因此
 *     没有理由起一个 OptimizationRun 行。本表直接通过 `run_id` 引用
 *     QuantBacktestResult.id，关联清晰。
 *
 * 主要消费方：
 *   - run-regime-backtest.ts CLI（US-040）
 *   - 未来 US-016 策略实验室 "环境分段表现" tab
 *   - 未来 US-046 IndustryAttributionService 可能联表
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { RegimeBacktestResult } from '../../models/RegimeBacktestResult';
import { QuantBacktestResult } from '../../models/QuantBacktestResult';
import { QuantBacktestTrade } from '../../models/QuantBacktestTrade';
import { QuantEquityPoint, QuantBacktestTradeResult } from '../types/QuantTypes';
import {
  marketEnvironmentService,
  MarketEnvironmentSnapshot,
} from '../../services/MarketEnvironmentService';

// ============================================================
// Types
// ============================================================

/**
 * 4 分类的 regime label。与 EnsembleStrategy.EnsembleMarketRegime 完全一致，
 * 保证下游 (前端图表 / 跨表聚合) 单一事实源。
 */
export type SegmentRegime = 'bull' | 'bear' | 'range' | 'volatile';

/**
 * MarketEnvironmentService 的 raw regime 类型别名（避免循环 import）。
 * 6 种：bull / bear / range / rebound / stress / unknown
 */
export type RawMarketRegime = MarketEnvironmentSnapshot['market_regime'];

/**
 * 单日 regime stamp（即将被 mergeAdjacentSegments run-length 压缩）。
 */
export interface DailyRegimeStamp {
  date: string;
  regime: SegmentRegime;
}

/**
 * 一个连续 regime 段（mergeAdjacentSegments 输出）。
 */
export interface RegimeSegmentRange {
  segment_index: number;
  regime: SegmentRegime;
  start_date: string;
  end_date: string;
  day_count: number;
}

/**
 * 单段完整结果（待写入 RegimeBacktestResult）。
 *
 * - `return_pct`：百分数（e.g. 12.34 = +12.34%）
 * - `sharpe`：年化夏普；不足 5 个日收益时为 null
 * - `drawdown_pct`：段内最大回撤的绝对值（正数）
 * - `win_rate`：sell_date ∈ 段内的成交里盈利笔数 / 总成交，0..1 小数；0 笔时 null
 */
export interface RegimeSegmentMetrics {
  segment_index: number;
  regime: SegmentRegime;
  start_date: string;
  end_date: string;
  day_count: number;
  return_pct: number;
  sharpe: number | null;
  drawdown_pct: number;
  win_rate: number | null;
  trade_count: number;
  equity_start: number;
  equity_end: number;
}

/**
 * `segment()` 输入。三种入参形态：
 *
 * (1) `quant_backtest_result_id`：从 DB 读 QuantBacktestResult 的
 *     equity_curve_json + 关联 QuantBacktestTrade 行。最常见的入参方式
 *     （CLI / UI 都是按 result_id 触发）。
 *
 * (2) `equity_curve + trades`：纯 in-memory 模式，单测 / 嵌入式调用方
 *     已经手上有数据，不想再 round-trip DB。
 *
 * 至少要提供其中一种；同时提供时优先用 (2) in-memory 数据。
 */
export interface RegimeSegmentInput {
  quant_backtest_result_id?: number;
  /** in-memory 模式：直接传 equity_curve（按 date 升序）+ trades 列表 */
  equity_curve?: QuantEquityPoint[];
  trades?: QuantBacktestTradeResult[];
  /** 物化进 RegimeBacktestResult 行的 strategy_key（与父结果保持一致） */
  strategy_key?: string;
  /** regime 检测所用的基准；默认 'sh.000300' */
  benchmark_symbol?: string;
}

/**
 * RegimeSource 抽象。让测试可以注入 fake regime 来源，完全脱离
 * MarketEnvironmentService 与 DB。
 *
 * 入参 (asOfDate, benchmarkSymbol) → 出参 SegmentRegime（已折叠到 4 分类）。
 * 失败时建议返回 'range'（trade-as-most-neutral 兜底，避免单日失败让整个 run 失败）。
 */
export interface RegimeSource {
  resolveRegime(asOfDate: string, benchmarkSymbol: string): Promise<SegmentRegime>;
}

/**
 * 生产默认 RegimeSource：走 marketEnvironmentService.getEnvironmentForStock。
 */
export const PRODUCTION_REGIME_SOURCE: RegimeSource = {
  async resolveRegime(asOfDate: string, benchmarkSymbol: string): Promise<SegmentRegime> {
    try {
      const env = await marketEnvironmentService.getEnvironmentForStock(benchmarkSymbol, {
        as_of: asOfDate,
        use_cache: true,
      });
      return mapRawRegimeToSegmentRegime(env.market_regime);
    } catch (err) {
      logger.warn(
        `[regime-segment] resolve regime failed for ${asOfDate} ${benchmarkSymbol}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return 'range';
    }
  },
};

export interface RegimeSegmentOptions {
  /** 是否写库，默认 true（in-memory 模式 = false 自动跳过） */
  persist?: boolean;
  /** 注入 RegimeSource（测试用），默认 PRODUCTION_REGIME_SOURCE */
  regime_source?: RegimeSource;
  /** 写库时若已存在同 run_id 行，是否先清除再写入；默认 true（覆盖式重算） */
  replace_existing?: boolean;
}

/**
 * 跨段聚合统计，便于 UI / CLI 一眼比较"哪种环境下表现最好"。
 */
export interface RegimeSegmentSummary {
  total_segments: number;
  /** 段数按 regime 分桶（bull / bear / range / volatile） */
  segments_by_regime: Record<SegmentRegime, number>;
  /** 各 regime 累计交易日数 */
  days_by_regime: Record<SegmentRegime, number>;
  /** 各 regime 平均 return_pct（仅含该 regime 的段；段数=0 时为 null） */
  avg_return_pct_by_regime: Record<SegmentRegime, number | null>;
  /** 各 regime 平均 sharpe（剔除 null sharpe；段数=0 时为 null） */
  avg_sharpe_by_regime: Record<SegmentRegime, number | null>;
  /** 各 regime 最大回撤里的最大值（取最深；段数=0 时为 null） */
  max_drawdown_pct_by_regime: Record<SegmentRegime, number | null>;
  /** 各 regime 累计成交数 */
  trade_count_by_regime: Record<SegmentRegime, number>;
  /** 整段回测的开始/结束日 + 总交易日数 */
  total_days: number;
  total_start_date: string | null;
  total_end_date: string | null;
}

export interface RegimeSegmentResult {
  /** 各段的完整指标（按 segment_index 升序） */
  segments: RegimeSegmentMetrics[];
  /** 跨段聚合 */
  summary: RegimeSegmentSummary;
  /** 写库时关联的 run_id；in-memory 模式为 null */
  run_id: number | null;
  /** 实际写入的行 id（与 segments 同序）；非 persist 时为空数组 */
  persisted_ids: number[];
}

// ============================================================
// Pure helpers — independently unit-testable
// ============================================================

/**
 * MarketEnvironmentService 的 6 种 raw regime 折叠到 4 种 segment regime。
 * 与 EnsembleStrategy.mapToEnsembleRegime 完全一致（独立实现而非 import，因
 * 避免 quant/backtest → quant/strategies 的反向依赖；如果未来语义有差异在
 * 这里调整不影响 strategy 层）：
 *   bull    → bull
 *   bear    → bear
 *   range   → range
 *   rebound → range（弱反弹按震荡处理）
 *   stress  → volatile（高压力 / 大回撤当作高波动）
 *   unknown → range（最中性的兜底）
 */
export function mapRawRegimeToSegmentRegime(raw: RawMarketRegime | string): SegmentRegime {
  switch (raw) {
    case 'bull':
      return 'bull';
    case 'bear':
      return 'bear';
    case 'stress':
      return 'volatile';
    case 'range':
    case 'rebound':
    case 'unknown':
    default:
      return 'range';
  }
}

/**
 * Run-length-encode per-day regime stamps into continuous segments.
 * Input 必须按 date 升序排序（caller 责任）；同 regime 的不相邻段视为两段。
 *
 * 失败模式：
 *   - 空输入 → []
 *   - 单天输入 → 一段长度 1
 */
export function mergeAdjacentSegments(stamps: DailyRegimeStamp[]): RegimeSegmentRange[] {
  if (!stamps.length) return [];
  const result: RegimeSegmentRange[] = [];
  let currentIndex = 0;
  let currentRegime = stamps[0].regime;
  let currentStart = stamps[0].date;
  let currentEnd = stamps[0].date;
  let currentDays = 1;
  for (let i = 1; i < stamps.length; i += 1) {
    const s = stamps[i];
    if (s.regime === currentRegime) {
      currentEnd = s.date;
      currentDays += 1;
    } else {
      result.push({
        segment_index: currentIndex,
        regime: currentRegime,
        start_date: currentStart,
        end_date: currentEnd,
        day_count: currentDays,
      });
      currentIndex += 1;
      currentRegime = s.regime;
      currentStart = s.date;
      currentEnd = s.date;
      currentDays = 1;
    }
  }
  result.push({
    segment_index: currentIndex,
    regime: currentRegime,
    start_date: currentStart,
    end_date: currentEnd,
    day_count: currentDays,
  });
  return result;
}

/**
 * n-1 样本标准差。少于 2 个观测返回 null。
 */
export function sampleStddev(values: number[]): number | null {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length < 2) return null;
  const m = valid.reduce((s, v) => s + v, 0) / valid.length;
  const ss = valid.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (valid.length - 1));
}

/** mean of finite numbers; null if empty */
export function mean(values: number[]): number | null {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

/**
 * 从段内连续的 equity 序列算最大回撤百分比（**正数**，e.g. 8.5 = -8.5% 回撤）。
 * 与 QuantMath.maxDrawdownFromValues 同算法但避免反向依赖 quant/engine/。
 *
 * 失败模式：
 *   - 0 或 1 个 equity → 0（没法算回撤）
 *   - 任一 equity ≤ 0 → 跳过（避免除零；常见于回测前期清算异常）
 */
export function maxDrawdownPctFromEquity(equityValues: number[]): number {
  if (equityValues.length < 2) return 0;
  let peak = 0;
  let maxDd = 0;
  for (const v of equityValues) {
    if (!Number.isFinite(v) || v <= 0) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

/**
 * 给单段的 equity 切片 + trades 切片，算 RegimeSegmentMetrics。
 *
 * 计算细节：
 *   - return_pct = (end / start - 1) * 100（百分数）
 *   - sharpe = mean(daily_returns) / stddev(daily_returns) * sqrt(252)
 *     （252 个交易日 / 年的年化系数；不足 5 个日收益返回 null）
 *   - drawdown_pct = maxDrawdownPctFromEquity(equity_in_segment)
 *   - win_rate = 段内 sell_date ∈ [start, end] 的成交里 pnl > 0 的比例
 *   - trade_count = 段内成交数
 *
 * **trade 关联规则**：以 sell_date 为准（成交真正落在该 regime 的时间点）。
 * 入场跨段、出场在该段的 trade 也算入该段 —— 这样段的成交统计与"该段实际兑
 * 现的盈亏"匹配。
 */
export function computeSegmentMetrics(
  range: RegimeSegmentRange,
  equityInSegment: QuantEquityPoint[],
  tradesInSegment: QuantBacktestTradeResult[]
): RegimeSegmentMetrics {
  if (equityInSegment.length === 0) {
    // 段内一个 equity 都没有时退化为零值；理论上不应该发生（segment 是从 equity
    // 序列推导的），但作为防御性 fallback。
    return {
      segment_index: range.segment_index,
      regime: range.regime,
      start_date: range.start_date,
      end_date: range.end_date,
      day_count: range.day_count,
      return_pct: 0,
      sharpe: null,
      drawdown_pct: 0,
      win_rate: tradesInSegment.length === 0 ? null : 0,
      trade_count: tradesInSegment.length,
      equity_start: 0,
      equity_end: 0,
    };
  }

  const equityStart = Number(equityInSegment[0].total_value);
  const equityEnd = Number(equityInSegment[equityInSegment.length - 1].total_value);
  const returnPct = equityStart > 0 ? (equityEnd / equityStart - 1) * 100 : 0;

  // 日收益序列：基于段内连续 equity 算一阶差分百分比
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityInSegment.length; i += 1) {
    const prev = Number(equityInSegment[i - 1].total_value);
    const cur = Number(equityInSegment[i].total_value);
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) {
      dailyReturns.push((cur / prev - 1) * 100);
    }
  }
  let sharpe: number | null = null;
  if (dailyReturns.length >= 5) {
    const meanRet = mean(dailyReturns);
    const stdRet = sampleStddev(dailyReturns);
    if (meanRet !== null && stdRet !== null && stdRet > 0) {
      // mean 与 std 都是 % 单位 —— 比例不变；乘 sqrt(252) 年化
      sharpe = (meanRet / stdRet) * Math.sqrt(252);
    }
  }

  const drawdownPct = maxDrawdownPctFromEquity(equityInSegment.map(p => Number(p.total_value)));

  let winRate: number | null = null;
  if (tradesInSegment.length > 0) {
    const wins = tradesInSegment.filter(t => Number(t.pnl ?? 0) > 0).length;
    winRate = wins / tradesInSegment.length;
  }

  return {
    segment_index: range.segment_index,
    regime: range.regime,
    start_date: range.start_date,
    end_date: range.end_date,
    day_count: range.day_count,
    return_pct: roundTo(returnPct, 4) as number,
    sharpe: sharpe === null ? null : (roundTo(sharpe, 4) as number),
    drawdown_pct: roundTo(drawdownPct, 4) as number,
    win_rate: winRate === null ? null : (roundTo(winRate, 4) as number),
    trade_count: tradesInSegment.length,
    equity_start: roundTo(equityStart, 2) as number,
    equity_end: roundTo(equityEnd, 2) as number,
  };
}

/**
 * 跨段聚合 — 让 UI / CLI 一眼比较"哪种环境下表现最好"。
 *
 * 每个 regime 维度 4 个指标：
 *   - segments_by_regime / days_by_regime 是 count 类（必有值）
 *   - avg_return_pct_by_regime / avg_sharpe_by_regime / max_drawdown_pct_by_regime
 *     是统计类（段数=0 时为 null，避免出现 "mean of empty = 0" 误导）
 */
export function aggregateRegimeSegments(segments: RegimeSegmentMetrics[]): RegimeSegmentSummary {
  const regimes: SegmentRegime[] = ['bull', 'bear', 'range', 'volatile'];
  const segmentsByRegime: Record<SegmentRegime, number> = {
    bull: 0,
    bear: 0,
    range: 0,
    volatile: 0,
  };
  const daysByRegime: Record<SegmentRegime, number> = {
    bull: 0,
    bear: 0,
    range: 0,
    volatile: 0,
  };
  const tradeCountByRegime: Record<SegmentRegime, number> = {
    bull: 0,
    bear: 0,
    range: 0,
    volatile: 0,
  };
  const returnsByRegime: Record<SegmentRegime, number[]> = {
    bull: [],
    bear: [],
    range: [],
    volatile: [],
  };
  const sharpesByRegime: Record<SegmentRegime, number[]> = {
    bull: [],
    bear: [],
    range: [],
    volatile: [],
  };
  const drawdownsByRegime: Record<SegmentRegime, number[]> = {
    bull: [],
    bear: [],
    range: [],
    volatile: [],
  };

  for (const s of segments) {
    segmentsByRegime[s.regime] += 1;
    daysByRegime[s.regime] += s.day_count;
    tradeCountByRegime[s.regime] += s.trade_count;
    if (Number.isFinite(Number(s.return_pct))) returnsByRegime[s.regime].push(Number(s.return_pct));
    if (s.sharpe !== null && Number.isFinite(Number(s.sharpe))) {
      sharpesByRegime[s.regime].push(Number(s.sharpe));
    }
    if (Number.isFinite(Number(s.drawdown_pct))) {
      drawdownsByRegime[s.regime].push(Number(s.drawdown_pct));
    }
  }

  const avgReturnByRegime: Record<SegmentRegime, number | null> = {
    bull: null,
    bear: null,
    range: null,
    volatile: null,
  };
  const avgSharpeByRegime: Record<SegmentRegime, number | null> = {
    bull: null,
    bear: null,
    range: null,
    volatile: null,
  };
  const maxDrawdownByRegime: Record<SegmentRegime, number | null> = {
    bull: null,
    bear: null,
    range: null,
    volatile: null,
  };
  for (const r of regimes) {
    const ret = mean(returnsByRegime[r]);
    avgReturnByRegime[r] = ret === null ? null : (roundTo(ret, 4) as number);
    const sh = mean(sharpesByRegime[r]);
    avgSharpeByRegime[r] = sh === null ? null : (roundTo(sh, 4) as number);
    maxDrawdownByRegime[r] = drawdownsByRegime[r].length
      ? (roundTo(Math.max(...drawdownsByRegime[r]), 4) as number)
      : null;
  }

  const totalDays = segments.reduce((s, x) => s + x.day_count, 0);
  return {
    total_segments: segments.length,
    segments_by_regime: segmentsByRegime,
    days_by_regime: daysByRegime,
    avg_return_pct_by_regime: avgReturnByRegime,
    avg_sharpe_by_regime: avgSharpeByRegime,
    max_drawdown_pct_by_regime: maxDrawdownByRegime,
    trade_count_by_regime: tradeCountByRegime,
    total_days: totalDays,
    total_start_date: segments.length ? segments[0].start_date : null,
    total_end_date: segments.length ? segments[segments.length - 1].end_date : null,
  };
}

function roundTo(value: number | null | undefined, digits: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const k = Math.pow(10, digits);
  return Math.round(Number(value) * k) / k;
}

// ============================================================
// Main segmenter class
// ============================================================

export class RegimeSegmentedBacktest {
  /**
   * 单次完整分段流程入口。流程：
   *   1. 解析 input：从 DB 读 QuantBacktestResult / 或直接用 in-memory equity_curve+trades
   *   2. 对 equity_curve 的每个 date 调用 regime_source.resolveRegime() 得到 per-day stamp
   *   3. mergeAdjacentSegments() run-length 压缩成段
   *   4. for each segment: 切 equity slice + trades slice, computeSegmentMetrics
   *   5. 可选写 RegimeBacktestResult（先 destroy 同 run_id 旧行 if replace_existing）
   *   6. aggregateRegimeSegments() 汇总
   */
  async segment(
    input: RegimeSegmentInput,
    options: RegimeSegmentOptions = {}
  ): Promise<RegimeSegmentResult> {
    const benchmark = input.benchmark_symbol || 'sh.000300';
    const persist = options.persist !== false;
    const replaceExisting = options.replace_existing !== false;
    const regimeSource = options.regime_source || PRODUCTION_REGIME_SOURCE;

    // (1) 解析 input
    let equityCurve: QuantEquityPoint[] = [];
    let trades: QuantBacktestTradeResult[] = [];
    let runId: number | null = null;
    let strategyKey = input.strategy_key || '';

    if (input.equity_curve && input.equity_curve.length > 0) {
      // in-memory 模式
      equityCurve = input.equity_curve.slice();
      trades = (input.trades || []).slice();
      runId = input.quant_backtest_result_id ?? null;
    } else if (input.quant_backtest_result_id) {
      const result = await QuantBacktestResult.findByPk(input.quant_backtest_result_id);
      if (!result) {
        throw new Error(
          `RegimeSegmentedBacktest.segment: QuantBacktestResult #${input.quant_backtest_result_id} 未找到`
        );
      }
      runId = result.id;
      strategyKey = strategyKey || result.strategy_key;
      const rawCurve = Array.isArray(result.equity_curve_json) ? result.equity_curve_json : [];
      equityCurve = rawCurve.filter(
        (p: any) => p && typeof p.date === 'string' && Number.isFinite(Number(p.total_value))
      ) as QuantEquityPoint[];
      // 关联 trades
      const tradeRows = await QuantBacktestTrade.findAll({
        where: { task_id: result.task_id, strategy_key: result.strategy_key },
        order: [['sell_date', 'ASC']],
      });
      trades = tradeRows.map(t => ({
        strategy_key: t.strategy_key,
        symbol: t.symbol,
        name: t.name,
        buy_date: String(t.buy_date),
        sell_date: t.sell_date ? String(t.sell_date) : undefined,
        buy_price: Number(t.buy_price),
        sell_price: t.sell_price ? Number(t.sell_price) : undefined,
        quantity: Number(t.quantity),
        amount: Number(t.amount),
        pnl: t.pnl !== null && t.pnl !== undefined ? Number(t.pnl) : undefined,
        return_pct:
          t.return_pct !== null && t.return_pct !== undefined ? Number(t.return_pct) : undefined,
        holding_days: Number(t.holding_days || 0),
        entry_reason: t.entry_reason,
        exit_reason: t.exit_reason,
      }));
    } else {
      throw new Error(
        'RegimeSegmentedBacktest.segment: 必须提供 quant_backtest_result_id 或 equity_curve+trades 之一'
      );
    }

    if (equityCurve.length === 0) {
      throw new Error('RegimeSegmentedBacktest.segment: equity_curve 为空，无法分段');
    }

    // 按 date 升序排序（防御性 — 调用方可能已按时间倒序）
    equityCurve.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    if (!strategyKey) {
      // in-memory 模式且未提供 strategy_key 时，物化为 'unknown' 让行能落库；
      // 调用方应总是提供 strategy_key（否则跨 run 聚合查询不可用）。
      logger.warn(
        '[regime-segment] strategy_key 未提供 — 将以 "unknown" 物化到 RegimeBacktestResult'
      );
      strategyKey = 'unknown';
    }

    logger.info(
      `[regime-segment] start: strategy=${strategyKey} benchmark=${benchmark} ` +
        `equity_points=${equityCurve.length} trades=${trades.length} ` +
        `range=${equityCurve[0].date}..${equityCurve[equityCurve.length - 1].date}`
    );

    // (2) per-day regime stamp（串行 await，避免 MarketEnvironmentService 并发查 DB 撞 cache）
    const stamps: DailyRegimeStamp[] = [];
    for (const p of equityCurve) {
      const regime = await regimeSource.resolveRegime(p.date, benchmark);
      stamps.push({ date: p.date, regime });
    }

    // (3) run-length-encode 成段
    const ranges = mergeAdjacentSegments(stamps);

    // (4) per-segment 指标
    const segments: RegimeSegmentMetrics[] = ranges.map(range => {
      const slice = equityCurve.filter(p => p.date >= range.start_date && p.date <= range.end_date);
      const segTrades = trades.filter(t => {
        const sd = t.sell_date;
        return typeof sd === 'string' && sd >= range.start_date && sd <= range.end_date;
      });
      return computeSegmentMetrics(range, slice, segTrades);
    });

    // (5) 写库
    const persisted_ids: number[] = [];
    if (persist && runId !== null) {
      if (replaceExisting) {
        await RegimeBacktestResult.destroy({ where: { run_id: runId } });
      }
      for (const seg of segments) {
        const row = await RegimeBacktestResult.create({
          run_id: runId,
          segment_index: seg.segment_index,
          strategy_key: strategyKey,
          benchmark_symbol: benchmark,
          regime: seg.regime,
          start_date: seg.start_date,
          end_date: seg.end_date,
          day_count: seg.day_count,
          return_pct: seg.return_pct,
          sharpe: seg.sharpe,
          drawdown_pct: seg.drawdown_pct,
          win_rate: seg.win_rate,
          trade_count: seg.trade_count,
          equity_start: seg.equity_start,
          equity_end: seg.equity_end,
        });
        persisted_ids.push(row.id);
      }
    }

    // (6) 汇总
    const summary = aggregateRegimeSegments(segments);

    logger.info(
      `[regime-segment] done: segments=${segments.length} ` +
        `bull=${summary.segments_by_regime.bull} bear=${summary.segments_by_regime.bear} ` +
        `range=${summary.segments_by_regime.range} volatile=${summary.segments_by_regime.volatile} ` +
        `total_days=${summary.total_days}`
    );

    return {
      segments,
      summary,
      run_id: runId,
      persisted_ids,
    };
  }

  /**
   * 查询某次回测的全部 segments（按 segment_index 升序）。
   */
  async getRunSegments(run_id: number): Promise<RegimeSegmentMetrics[]> {
    const rows = await RegimeBacktestResult.findAll({
      where: { run_id },
      order: [['segment_index', 'ASC']],
    });
    return rows.map(modelToMetrics);
  }

  /**
   * 删除某次回测的全部 segments（不删父 QuantBacktestResult）。
   */
  async deleteRun(run_id: number): Promise<{ deleted: number }> {
    const deleted = await RegimeBacktestResult.destroy({ where: { run_id } });
    return { deleted };
  }

  /**
   * 清理 N 天前的所有 segments。
   */
  async cleanupOlderThan(days: number): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const deleted = await RegimeBacktestResult.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted };
  }

  /**
   * 列出最近 N 个有 segments 的 run_id（DESCENDING created_at）。
   */
  async listRecentRuns(limit = 30): Promise<
    Array<{
      run_id: number;
      strategy_key: string;
      benchmark_symbol: string;
      segment_count: number;
      latest_created_at: Date;
    }>
  > {
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
    // Sequelize 不直接支持 distinct + count + max group by 多列；用 raw 查询
    const rows = (await RegimeBacktestResult.sequelize!.query(
      `SELECT run_id, strategy_key, benchmark_symbol,
              COUNT(*) AS segment_count,
              MAX(created_at) AS latest_created_at
       FROM regime_backtest_results
       GROUP BY run_id, strategy_key, benchmark_symbol
       ORDER BY latest_created_at DESC
       LIMIT :limit`,
      { replacements: { limit: safeLimit }, type: 'SELECT' as any }
    )) as any[];
    return rows.map(r => ({
      run_id: Number(r.run_id),
      strategy_key: String(r.strategy_key),
      benchmark_symbol: String(r.benchmark_symbol),
      segment_count: Number(r.segment_count),
      latest_created_at: new Date(r.latest_created_at),
    }));
  }
}

function modelToMetrics(row: RegimeBacktestResult): RegimeSegmentMetrics {
  const numOrNull = (v: any): number | null =>
    v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  return {
    segment_index: row.segment_index,
    regime: row.regime as SegmentRegime,
    start_date: String(row.start_date),
    end_date: String(row.end_date),
    day_count: Number(row.day_count),
    return_pct: Number(row.return_pct),
    sharpe: numOrNull(row.sharpe),
    drawdown_pct: Number(row.drawdown_pct),
    win_rate: numOrNull(row.win_rate),
    trade_count: Number(row.trade_count),
    equity_start: Number(row.equity_start),
    equity_end: Number(row.equity_end),
  };
}

// Default singleton — same convention as gridSearchOptimizer / walkForwardValidator
export const regimeSegmentedBacktest = new RegimeSegmentedBacktest();
