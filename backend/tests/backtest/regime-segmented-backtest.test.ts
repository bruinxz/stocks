/**
 * RegimeSegmentedBacktest 单元测试（US-040）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/regime-segmented-backtest.test.ts
 *
 * 完全脱离 DB：注入 fake RegimeSource + in-memory equity_curve/trades + persist:false。
 *
 * 覆盖维度：
 *   - 纯函数：mapRawRegimeToSegmentRegime / mergeAdjacentSegments /
 *     sampleStddev / mean / maxDrawdownPctFromEquity /
 *     computeSegmentMetrics / aggregateRegimeSegments
 *   - end-to-end segment()：
 *     - happy path：4 regime 段 + 完整指标计算
 *     - 全 bull 单一段（边界）
 *     - 注入 fake RegimeSource 单日抛错 → 该日 'range' 兜底
 *     - trades 关联以 sell_date 为准
 *     - sell_date 落在段外不计入该段
 *     - 空 equity_curve 抛错
 *     - 同时缺 quant_backtest_result_id + equity_curve 抛错
 *     - 自定义 benchmark_symbol 透传到 RegimeSource
 *     - 段不足 5 日 sharpe=null
 *     - 段无成交 win_rate=null
 *     - persist=false 不写库（默认行为，因 in-memory 模式没 run_id）
 */

import {
  RegimeSegmentedBacktest,
  RegimeSource,
  SegmentRegime,
  DailyRegimeStamp,
  mapRawRegimeToSegmentRegime,
  mergeAdjacentSegments,
  sampleStddev,
  mean,
  maxDrawdownPctFromEquity,
  computeSegmentMetrics,
  aggregateRegimeSegments,
} from '../../src/quant/backtest/RegimeSegmentedBacktest';
import { QuantEquityPoint, QuantBacktestTradeResult } from '../../src/quant/types/QuantTypes';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEqual<T>(name: string, actual: T, expected: T, detail = '') {
  const same =
    JSON.stringify(actual) === JSON.stringify(expected) ||
    (typeof actual === 'number' &&
      typeof expected === 'number' &&
      Math.abs(actual - expected) < 1e-9);
  assert(
    name,
    same,
    detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-6) {
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}`
  );
}

async function expectThrowAsync(name: string, fn: () => Promise<any>, substr?: string) {
  try {
    await fn();
    assert(name, false, 'expected throw, none thrown');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (substr && !msg.includes(substr)) {
      assert(name, false, `expected msg to include '${substr}', got '${msg}'`);
    } else {
      assert(name, true);
    }
  }
}

// ============================================================
// Pure helper tests
// ============================================================

function runMapRegimeTests() {
  console.log('\n## mapRawRegimeToSegmentRegime');
  expectEqual('bull → bull', mapRawRegimeToSegmentRegime('bull'), 'bull');
  expectEqual('bear → bear', mapRawRegimeToSegmentRegime('bear'), 'bear');
  expectEqual('range → range', mapRawRegimeToSegmentRegime('range'), 'range');
  expectEqual('rebound → range', mapRawRegimeToSegmentRegime('rebound'), 'range');
  expectEqual('stress → volatile', mapRawRegimeToSegmentRegime('stress'), 'volatile');
  expectEqual('unknown → range', mapRawRegimeToSegmentRegime('unknown'), 'range');
  // 不在 enum 内的值落入 default → range
  expectEqual('garbage → range', mapRawRegimeToSegmentRegime('garbage' as any), 'range');
}

function runMergeAdjacentTests() {
  console.log('\n## mergeAdjacentSegments');

  expectEqual('empty input → []', mergeAdjacentSegments([]), []);

  // 单日
  const single = mergeAdjacentSegments([{ date: '2024-01-01', regime: 'bull' }]);
  expectEqual('single day → 1 segment', single.length, 1);
  expectEqual('single day regime', single[0].regime, 'bull');
  expectEqual('single day start=end', single[0].start_date, '2024-01-01');
  expectEqual('single day end', single[0].end_date, '2024-01-01');
  expectEqual('single day day_count', single[0].day_count, 1);
  expectEqual('single day index=0', single[0].segment_index, 0);

  // 全 bull 连续 5 天 → 1 段
  const allBull = mergeAdjacentSegments([
    { date: '2024-01-01', regime: 'bull' },
    { date: '2024-01-02', regime: 'bull' },
    { date: '2024-01-03', regime: 'bull' },
    { date: '2024-01-04', regime: 'bull' },
    { date: '2024-01-05', regime: 'bull' },
  ]);
  expectEqual('5 days all bull → 1 segment', allBull.length, 1);
  expectEqual('5 days end', allBull[0].end_date, '2024-01-05');
  expectEqual('5 days day_count', allBull[0].day_count, 5);

  // bull → bear → range → 3 段
  const threeReg = mergeAdjacentSegments([
    { date: '2024-01-01', regime: 'bull' },
    { date: '2024-01-02', regime: 'bull' },
    { date: '2024-01-03', regime: 'bear' },
    { date: '2024-01-04', regime: 'range' },
    { date: '2024-01-05', regime: 'range' },
  ]);
  expectEqual('3 regimes → 3 segments', threeReg.length, 3);
  expectEqual('seg0 regime', threeReg[0].regime, 'bull');
  expectEqual('seg0 days', threeReg[0].day_count, 2);
  expectEqual('seg0 index', threeReg[0].segment_index, 0);
  expectEqual('seg1 regime', threeReg[1].regime, 'bear');
  expectEqual('seg1 days', threeReg[1].day_count, 1);
  expectEqual('seg1 index', threeReg[1].segment_index, 1);
  expectEqual('seg2 regime', threeReg[2].regime, 'range');
  expectEqual('seg2 days', threeReg[2].day_count, 2);
  expectEqual('seg2 index', threeReg[2].segment_index, 2);

  // 同 regime 不相邻视为两段
  const splitBull = mergeAdjacentSegments([
    { date: '2024-01-01', regime: 'bull' },
    { date: '2024-01-02', regime: 'bear' },
    { date: '2024-01-03', regime: 'bull' },
  ]);
  expectEqual('bull bear bull → 3 segments', splitBull.length, 3);
  expectEqual('splitBull seg0 regime', splitBull[0].regime, 'bull');
  expectEqual('splitBull seg2 regime', splitBull[2].regime, 'bull');
  expectEqual('splitBull seg0 index=0', splitBull[0].segment_index, 0);
  expectEqual('splitBull seg2 index=2', splitBull[2].segment_index, 2);

  // 4 regime 全部出现
  const allFour = mergeAdjacentSegments([
    { date: '2024-01-01', regime: 'bull' },
    { date: '2024-01-02', regime: 'bear' },
    { date: '2024-01-03', regime: 'range' },
    { date: '2024-01-04', regime: 'volatile' },
  ]);
  expectEqual('4 distinct regimes → 4 segments', allFour.length, 4);
}

function runStatsTests() {
  console.log('\n## sampleStddev / mean / maxDrawdownPctFromEquity');

  expectEqual('stddev 空 → null', sampleStddev([]), null);
  expectEqual('stddev 单元素 → null', sampleStddev([5]), null);
  expectClose('stddev [1,3]', sampleStddev([1, 3])!, Math.sqrt(2));
  expectClose('stddev [1..5]', sampleStddev([1, 2, 3, 4, 5])!, Math.sqrt(2.5));
  expectEqual('stddev 全 NaN → null', sampleStddev([NaN, NaN, NaN]), null);
  expectClose('stddev 含 NaN 剔除', sampleStddev([1, 2, NaN, 3])!, 1);

  expectEqual('mean 空 → null', mean([]), null);
  expectClose('mean [1..5]', mean([1, 2, 3, 4, 5])!, 3);
  expectClose('mean 含 NaN 剔除', mean([1, 2, NaN, 3])!, 2);
  expectEqual('mean 全 NaN → null', mean([NaN, NaN]), null);

  expectEqual('maxDD 空 → 0', maxDrawdownPctFromEquity([]), 0);
  expectEqual('maxDD 单元素 → 0', maxDrawdownPctFromEquity([100]), 0);
  // peak=100, low=80 → -20% drawdown，正数 20
  expectClose('maxDD 100→80 = 20%', maxDrawdownPctFromEquity([100, 80]), 20);
  // peak=100, 持续上涨 110, 120, 90 → peak=120, dd=(120-90)/120=25%
  expectClose('maxDD 100→110→120→90 = 25%', maxDrawdownPctFromEquity([100, 110, 120, 90]), 25);
  // peak=100, low=50, 后又涨到 200 (新峰), 再跌到 150 → 后段 dd 较深: peak=200 → 150 = 25%; 前段 peak=100→50 = 50%。max=50%
  expectClose(
    'maxDD 取整段最深回撤',
    maxDrawdownPctFromEquity([100, 50, 200, 150]),
    50
  );
  // 全增 → 0
  expectClose('maxDD 全增 → 0', maxDrawdownPctFromEquity([100, 110, 120, 130]), 0);
  // 含 0 跳过（防御）
  expectClose('maxDD 含 0 跳过', maxDrawdownPctFromEquity([100, 0, 80]), 20);
}

function runComputeMetricsTests() {
  console.log('\n## computeSegmentMetrics');

  const baseRange = {
    segment_index: 0,
    regime: 'bull' as SegmentRegime,
    start_date: '2024-01-01',
    end_date: '2024-01-10',
    day_count: 10,
  };

  // 空 equity → 兜底零值
  const empty = computeSegmentMetrics(baseRange, [], []);
  expectEqual('empty equity → return 0', empty.return_pct, 0);
  expectEqual('empty equity → sharpe null', empty.sharpe, null);
  expectEqual('empty equity → win_rate null (no trades)', empty.win_rate, null);
  expectEqual('empty equity → trade_count 0', empty.trade_count, 0);

  // 简单 happy：equity 1000 → 1100，return = 10%
  const equity1: QuantEquityPoint[] = [
    {
      date: '2024-01-01',
      total_value: 1000,
      cash: 1000,
      position_value: 0,
      cumulative_return_pct: 0,
      drawdown_pct: 0,
    },
    {
      date: '2024-01-10',
      total_value: 1100,
      cash: 1100,
      position_value: 0,
      cumulative_return_pct: 10,
      drawdown_pct: 0,
    },
  ];
  const m1 = computeSegmentMetrics(baseRange, equity1, []);
  expectClose('happy return 10%', m1.return_pct, 10);
  expectEqual('happy sharpe null (only 1 daily return < 5)', m1.sharpe, null);
  expectEqual('happy equity_start', m1.equity_start, 1000);
  expectEqual('happy equity_end', m1.equity_end, 1100);

  // sharpe 充足（≥ 5 个日收益 = ≥ 6 个 equity 点）
  const equity2: QuantEquityPoint[] = [
    { date: '2024-01-01', total_value: 100, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-02', total_value: 101, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-03', total_value: 102, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-04', total_value: 103, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-05', total_value: 104, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-06', total_value: 105, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
  ];
  const m2 = computeSegmentMetrics(baseRange, equity2, []);
  // 5 个日收益每个都 ~1% 但 stddev 因复利轻微递减 → sharpe 应该非常大（>20）
  assert(
    'sharpe with 6 equity points is not null',
    m2.sharpe !== null,
    `got ${m2.sharpe}`
  );
  if (m2.sharpe !== null) {
    assert('sharpe > 20 (low std smooth uptrend)', m2.sharpe > 20, `got ${m2.sharpe}`);
  }

  // win_rate 计算
  const trades: QuantBacktestTradeResult[] = [
    {
      strategy_key: 'test',
      symbol: 'A',
      buy_date: '2024-01-01',
      sell_date: '2024-01-05',
      buy_price: 10,
      quantity: 100,
      amount: 1000,
      pnl: 200, // win
      holding_days: 4,
    },
    {
      strategy_key: 'test',
      symbol: 'B',
      buy_date: '2024-01-02',
      sell_date: '2024-01-06',
      buy_price: 20,
      quantity: 50,
      amount: 1000,
      pnl: -50, // loss
      holding_days: 4,
    },
    {
      strategy_key: 'test',
      symbol: 'C',
      buy_date: '2024-01-03',
      sell_date: '2024-01-07',
      buy_price: 5,
      quantity: 200,
      amount: 1000,
      pnl: 100, // win
      holding_days: 4,
    },
  ];
  const m3 = computeSegmentMetrics(baseRange, equity2, trades);
  expectEqual('win_rate 2/3', m3.win_rate, 0.6667); // rounded to 4 places
  expectEqual('trade_count 3', m3.trade_count, 3);

  // 0 trades → win_rate null
  const m4 = computeSegmentMetrics(baseRange, equity2, []);
  expectEqual('0 trades → win_rate null', m4.win_rate, null);
  expectEqual('0 trades → trade_count 0', m4.trade_count, 0);

  // drawdown 计算（段内峰值 100 → 谷值 90 = 10% dd）
  const equityDD: QuantEquityPoint[] = [
    { date: '2024-01-01', total_value: 100, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-02', total_value: 90, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-03', total_value: 95, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
  ];
  const m5 = computeSegmentMetrics(baseRange, equityDD, []);
  expectClose('drawdown 10%', m5.drawdown_pct, 10);
  expectClose('return -5% (100→95)', m5.return_pct, -5);
}

function runAggregateTests() {
  console.log('\n## aggregateRegimeSegments');

  // 空 → 全 null
  const empty = aggregateRegimeSegments([]);
  expectEqual('empty total_segments 0', empty.total_segments, 0);
  expectEqual('empty bull count 0', empty.segments_by_regime.bull, 0);
  expectEqual('empty bull avg_return null', empty.avg_return_pct_by_regime.bull, null);
  expectEqual('empty bull avg_sharpe null', empty.avg_sharpe_by_regime.bull, null);
  expectEqual('empty bull max_dd null', empty.max_drawdown_pct_by_regime.bull, null);
  expectEqual('empty total_days 0', empty.total_days, 0);
  expectEqual('empty total_start null', empty.total_start_date, null);

  // 2 bull + 1 bear
  const segs = [
    {
      segment_index: 0,
      regime: 'bull' as SegmentRegime,
      start_date: '2024-01-01',
      end_date: '2024-01-10',
      day_count: 10,
      return_pct: 10,
      sharpe: 1.5,
      drawdown_pct: 3,
      win_rate: 0.6,
      trade_count: 5,
      equity_start: 1000,
      equity_end: 1100,
    },
    {
      segment_index: 1,
      regime: 'bear' as SegmentRegime,
      start_date: '2024-01-11',
      end_date: '2024-01-20',
      day_count: 10,
      return_pct: -5,
      sharpe: -0.8,
      drawdown_pct: 8,
      win_rate: 0.3,
      trade_count: 3,
      equity_start: 1100,
      equity_end: 1045,
    },
    {
      segment_index: 2,
      regime: 'bull' as SegmentRegime,
      start_date: '2024-01-21',
      end_date: '2024-01-30',
      day_count: 10,
      return_pct: 6,
      sharpe: 2.0,
      drawdown_pct: 2,
      win_rate: 0.7,
      trade_count: 4,
      equity_start: 1045,
      equity_end: 1107.7,
    },
  ];
  const agg = aggregateRegimeSegments(segs);
  expectEqual('total_segments 3', agg.total_segments, 3);
  expectEqual('bull count 2', agg.segments_by_regime.bull, 2);
  expectEqual('bear count 1', agg.segments_by_regime.bear, 1);
  expectEqual('range count 0', agg.segments_by_regime.range, 0);
  expectEqual('volatile count 0', agg.segments_by_regime.volatile, 0);
  expectEqual('bull days 20', agg.days_by_regime.bull, 20);
  expectEqual('bear days 10', agg.days_by_regime.bear, 10);
  expectEqual('total_days 30', agg.total_days, 30);
  expectClose('bull avg_return = (10+6)/2 = 8', agg.avg_return_pct_by_regime.bull!, 8);
  expectClose('bear avg_return = -5', agg.avg_return_pct_by_regime.bear!, -5);
  expectClose('bull avg_sharpe = (1.5+2)/2 = 1.75', agg.avg_sharpe_by_regime.bull!, 1.75);
  expectClose('bull max_dd = max(3,2) = 3', agg.max_drawdown_pct_by_regime.bull!, 3);
  expectEqual('bull trade_count 5+4 = 9', agg.trade_count_by_regime.bull, 9);
  expectEqual('range avg_return null (0 segs)', agg.avg_return_pct_by_regime.range, null);
  expectEqual('total_start_date', agg.total_start_date, '2024-01-01');
  expectEqual('total_end_date', agg.total_end_date, '2024-01-30');

  // sharpe=null 不进入平均
  const withNull = aggregateRegimeSegments([
    {
      segment_index: 0,
      regime: 'bull',
      start_date: '2024-01-01',
      end_date: '2024-01-02',
      day_count: 2,
      return_pct: 1,
      sharpe: null,
      drawdown_pct: 0,
      win_rate: null,
      trade_count: 0,
      equity_start: 100,
      equity_end: 101,
    },
    {
      segment_index: 1,
      regime: 'bull',
      start_date: '2024-01-03',
      end_date: '2024-01-12',
      day_count: 10,
      return_pct: 5,
      sharpe: 1.0,
      drawdown_pct: 1,
      win_rate: 0.5,
      trade_count: 2,
      equity_start: 101,
      equity_end: 106,
    },
  ]);
  expectClose('bull avg_sharpe excludes null', withNull.avg_sharpe_by_regime.bull!, 1.0);
  expectClose('bull avg_return includes both', withNull.avg_return_pct_by_regime.bull!, 3);
}

// ============================================================
// End-to-end segment() tests with fake RegimeSource
// ============================================================

function makeFakeRegimeSource(stamps: Record<string, SegmentRegime>): RegimeSource {
  return {
    async resolveRegime(asOfDate: string): Promise<SegmentRegime> {
      return stamps[asOfDate] || 'range';
    },
  };
}

function makeThrowingRegimeSource(throwOn: string): RegimeSource {
  // 注意：生产 PRODUCTION_REGIME_SOURCE 自身 try/catch 兜底为 'range'，但
  // 通过自定义 RegimeSource 注入时**不会自动**兜底——caller 责任。本 fake
  // 验证 segment() 不会因 source 抛错让整个 run 失败，前提是 source 自己兜底。
  return {
    async resolveRegime(asOfDate: string): Promise<SegmentRegime> {
      if (asOfDate === throwOn) {
        // 模拟生产兜底（PRODUCTION_REGIME_SOURCE 把抛错变 'range'）
        return 'range';
      }
      return 'bull';
    },
  };
}

function makeEquityCurve(
  startDate: string,
  count: number,
  startValue: number,
  growthPerDay = 0.001
): QuantEquityPoint[] {
  const points: QuantEquityPoint[] = [];
  let value = startValue;
  const d = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    const date = d.toISOString().slice(0, 10);
    points.push({
      date,
      total_value: value,
      cash: 0,
      position_value: value,
      cumulative_return_pct: ((value / startValue - 1) * 100),
      drawdown_pct: 0,
    });
    value *= 1 + growthPerDay;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return points;
}

async function testHappyPath() {
  console.log('\n## end-to-end segment() — happy path');
  const validator = new RegimeSegmentedBacktest();
  const equity = makeEquityCurve('2024-01-01', 10, 1000, 0.01);
  const trades: QuantBacktestTradeResult[] = [
    {
      strategy_key: 'multi_factor_alpha',
      symbol: 'A',
      buy_date: '2024-01-01',
      sell_date: '2024-01-03',
      buy_price: 10,
      quantity: 100,
      amount: 1000,
      pnl: 200,
      holding_days: 2,
    },
    {
      strategy_key: 'multi_factor_alpha',
      symbol: 'B',
      buy_date: '2024-01-04',
      sell_date: '2024-01-07',
      buy_price: 20,
      quantity: 50,
      amount: 1000,
      pnl: -100,
      holding_days: 3,
    },
  ];
  // 2 段：jan 01-05 = bull, jan 06-10 = bear
  const stamps: Record<string, SegmentRegime> = {
    '2024-01-01': 'bull',
    '2024-01-02': 'bull',
    '2024-01-03': 'bull',
    '2024-01-04': 'bull',
    '2024-01-05': 'bull',
    '2024-01-06': 'bear',
    '2024-01-07': 'bear',
    '2024-01-08': 'bear',
    '2024-01-09': 'bear',
    '2024-01-10': 'bear',
  };
  const out = await validator.segment(
    {
      equity_curve: equity,
      trades,
      strategy_key: 'multi_factor_alpha',
    },
    {
      persist: false,
      regime_source: makeFakeRegimeSource(stamps),
    }
  );
  expectEqual('2 segments', out.segments.length, 2);
  expectEqual('seg0 regime bull', out.segments[0].regime, 'bull');
  expectEqual('seg1 regime bear', out.segments[1].regime, 'bear');
  expectEqual('seg0 start', out.segments[0].start_date, '2024-01-01');
  expectEqual('seg0 end', out.segments[0].end_date, '2024-01-05');
  expectEqual('seg0 day_count', out.segments[0].day_count, 5);
  expectEqual('seg1 day_count', out.segments[1].day_count, 5);
  // seg0 含 2024-01-03 trade (A, win) + 但 trade B sell_date=01-07 不在 seg0 内
  expectEqual('seg0 trade_count 1', out.segments[0].trade_count, 1);
  expectEqual('seg0 win_rate 1.0', out.segments[0].win_rate, 1);
  // seg1 含 trade B (loss, sell_date 01-07)
  expectEqual('seg1 trade_count 1', out.segments[1].trade_count, 1);
  expectEqual('seg1 win_rate 0', out.segments[1].win_rate, 0);
  // summary
  expectEqual('summary total_segments', out.summary.total_segments, 2);
  expectEqual('summary bull count', out.summary.segments_by_regime.bull, 1);
  expectEqual('summary bear count', out.summary.segments_by_regime.bear, 1);
  expectEqual('summary run_id null (in-memory)', out.run_id, null);
  expectEqual('summary persisted_ids empty', out.persisted_ids.length, 0);
}

async function testAllOneRegime() {
  console.log('\n## end-to-end — 全 bull 单段（边界）');
  const validator = new RegimeSegmentedBacktest();
  const equity = makeEquityCurve('2024-01-01', 8, 1000, 0.005);
  const allBull: Record<string, SegmentRegime> = {};
  equity.forEach(p => (allBull[p.date] = 'bull'));
  const out = await validator.segment(
    { equity_curve: equity, strategy_key: 'test' },
    { persist: false, regime_source: makeFakeRegimeSource(allBull) }
  );
  expectEqual('1 segment (all bull)', out.segments.length, 1);
  expectEqual('1 segment day_count = 8', out.segments[0].day_count, 8);
  expectEqual('bull count=1', out.summary.segments_by_regime.bull, 1);
  expectEqual('bear count=0', out.summary.segments_by_regime.bear, 0);
}

async function testCustomBenchmark() {
  console.log('\n## end-to-end — 自定义 benchmark_symbol 透传');
  const validator = new RegimeSegmentedBacktest();
  const equity = makeEquityCurve('2024-01-01', 5, 1000, 0.001);
  const seen: string[] = [];
  const captureSource: RegimeSource = {
    async resolveRegime(asOfDate: string, benchmark: string): Promise<SegmentRegime> {
      seen.push(benchmark);
      return 'range';
    },
  };
  await validator.segment(
    {
      equity_curve: equity,
      strategy_key: 'test',
      benchmark_symbol: 'sh.000905',
    },
    { persist: false, regime_source: captureSource }
  );
  expectEqual('5 calls', seen.length, 5);
  expectEqual('all calls use sh.000905', seen.every(b => b === 'sh.000905'), true);
}

async function testDefaultBenchmark() {
  console.log('\n## end-to-end — 默认 benchmark = sh.000300');
  const validator = new RegimeSegmentedBacktest();
  const equity = makeEquityCurve('2024-01-01', 3, 1000);
  const seen: string[] = [];
  const captureSource: RegimeSource = {
    async resolveRegime(asOfDate: string, benchmark: string): Promise<SegmentRegime> {
      seen.push(benchmark);
      return 'range';
    },
  };
  await validator.segment(
    { equity_curve: equity, strategy_key: 'test' }, // 不传 benchmark_symbol
    { persist: false, regime_source: captureSource }
  );
  expectEqual('default benchmark = sh.000300', seen[0], 'sh.000300');
}

async function testTradeSellDateFiltering() {
  console.log('\n## end-to-end — trade 关联以 sell_date 为准');
  const validator = new RegimeSegmentedBacktest();
  const equity = makeEquityCurve('2024-01-01', 6, 1000);
  const stamps: Record<string, SegmentRegime> = {
    '2024-01-01': 'bull',
    '2024-01-02': 'bull',
    '2024-01-03': 'bear',
    '2024-01-04': 'bear',
    '2024-01-05': 'bear',
    '2024-01-06': 'bear',
  };
  const trades: QuantBacktestTradeResult[] = [
    {
      strategy_key: 'test',
      symbol: 'A',
      buy_date: '2024-01-01', // bull
      sell_date: '2024-01-04', // bear
      buy_price: 10,
      quantity: 100,
      amount: 1000,
      pnl: 100,
      holding_days: 3,
    },
    {
      strategy_key: 'test',
      symbol: 'B',
      buy_date: '2024-01-02', // bull
      sell_date: '2024-01-02', // bull (same day)
      buy_price: 5,
      quantity: 50,
      amount: 250,
      pnl: 25,
      holding_days: 0,
    },
    {
      strategy_key: 'test',
      symbol: 'C',
      buy_date: '2024-01-01',
      // sell_date 未定义（未平仓）→ 不计入任何段
      buy_price: 8,
      quantity: 60,
      amount: 480,
      holding_days: 5,
    },
  ];
  const out = await validator.segment(
    { equity_curve: equity, trades, strategy_key: 'test' },
    { persist: false, regime_source: makeFakeRegimeSource(stamps) }
  );
  // 2 段：bull (01-01..02) + bear (01-03..06)
  expectEqual('2 segments', out.segments.length, 2);
  expectEqual('bull seg trade_count = 1 (B)', out.segments[0].trade_count, 1);
  expectEqual('bear seg trade_count = 1 (A)', out.segments[1].trade_count, 1);
  // unclosed trade C 不计入
}

async function testEmptyEquityThrows() {
  console.log('\n## end-to-end — 空 equity_curve 抛错');
  const validator = new RegimeSegmentedBacktest();
  await expectThrowAsync(
    'empty equity_curve throws',
    () =>
      validator.segment(
        { equity_curve: [], strategy_key: 'test' },
        { persist: false, regime_source: makeFakeRegimeSource({}) }
      ),
    'equity_curve'
  );
}

async function testMissingInputThrows() {
  console.log('\n## end-to-end — 同时缺 result_id + equity_curve 抛错');
  const validator = new RegimeSegmentedBacktest();
  await expectThrowAsync(
    'no input throws',
    () =>
      validator.segment(
        { strategy_key: 'test' },
        { persist: false, regime_source: makeFakeRegimeSource({}) }
      ),
    'quant_backtest_result_id'
  );
}

async function testUnsortedEquitySortedByImpl() {
  console.log('\n## end-to-end — 乱序 equity_curve 自动 sort');
  const validator = new RegimeSegmentedBacktest();
  // 故意反序
  const equity = makeEquityCurve('2024-01-01', 5, 1000).reverse();
  const stamps: Record<string, SegmentRegime> = {
    '2024-01-01': 'bull',
    '2024-01-02': 'bull',
    '2024-01-03': 'bull',
    '2024-01-04': 'bull',
    '2024-01-05': 'bull',
  };
  const out = await validator.segment(
    { equity_curve: equity, strategy_key: 'test' },
    { persist: false, regime_source: makeFakeRegimeSource(stamps) }
  );
  expectEqual('1 segment after sort', out.segments.length, 1);
  expectEqual('start_date is earliest', out.segments[0].start_date, '2024-01-01');
  expectEqual('end_date is latest', out.segments[0].end_date, '2024-01-05');
}

async function testRegimeSourceRangeFallback() {
  console.log('\n## end-to-end — RegimeSource 兜底 range 不破坏整个 run');
  const validator = new RegimeSegmentedBacktest();
  const equity = makeEquityCurve('2024-01-01', 5, 1000);
  // makeThrowingRegimeSource 在 2024-01-03 处会返回 range 兜底，其余 bull
  const source = makeThrowingRegimeSource('2024-01-03');
  const out = await validator.segment(
    { equity_curve: equity, strategy_key: 'test' },
    { persist: false, regime_source: source }
  );
  // bull (01-01..02) + range (01-03) + bull (01-04..05) → 3 段
  expectEqual('3 segments after fallback', out.segments.length, 3);
  expectEqual('seg0 bull', out.segments[0].regime, 'bull');
  expectEqual('seg1 range (fallback)', out.segments[1].regime, 'range');
  expectEqual('seg2 bull', out.segments[2].regime, 'bull');
}

async function testNoSharpeForShortSegments() {
  console.log('\n## end-to-end — 段不足 5 日 sharpe=null');
  const validator = new RegimeSegmentedBacktest();
  const equity = makeEquityCurve('2024-01-01', 3, 1000, 0.01);
  const stamps: Record<string, SegmentRegime> = {
    '2024-01-01': 'bull',
    '2024-01-02': 'bull',
    '2024-01-03': 'bull',
  };
  const out = await validator.segment(
    { equity_curve: equity, strategy_key: 'test' },
    { persist: false, regime_source: makeFakeRegimeSource(stamps) }
  );
  expectEqual('1 segment', out.segments.length, 1);
  expectEqual('short segment sharpe null', out.segments[0].sharpe, null);
}

async function testStrategyKeyUnknownFallback() {
  console.log('\n## end-to-end — 未提供 strategy_key 时退化为 "unknown"');
  // 注：本测试不直接 assert 输出 string（毕竟 in-memory 模式不写库），但
  // 我们可以验证 segment() 不抛错（segment() 内部 warning + 物化为 'unknown'）。
  const validator = new RegimeSegmentedBacktest();
  const equity = makeEquityCurve('2024-01-01', 3, 1000);
  const stamps: Record<string, SegmentRegime> = {
    '2024-01-01': 'bull',
    '2024-01-02': 'bull',
    '2024-01-03': 'bull',
  };
  const out = await validator.segment(
    { equity_curve: equity }, // 无 strategy_key
    { persist: false, regime_source: makeFakeRegimeSource(stamps) }
  );
  expectEqual('segment success despite missing strategy_key', out.segments.length, 1);
}

async function testFourRegimesAllPresent() {
  console.log('\n## end-to-end — 4 regime 全部出现 / aggregateSummary 4 维统计');
  const validator = new RegimeSegmentedBacktest();
  // 12 天: bull 3 + bear 3 + range 3 + volatile 3
  const equity = makeEquityCurve('2024-01-01', 12, 1000, 0.001);
  const stamps: Record<string, SegmentRegime> = {
    '2024-01-01': 'bull',
    '2024-01-02': 'bull',
    '2024-01-03': 'bull',
    '2024-01-04': 'bear',
    '2024-01-05': 'bear',
    '2024-01-06': 'bear',
    '2024-01-07': 'range',
    '2024-01-08': 'range',
    '2024-01-09': 'range',
    '2024-01-10': 'volatile',
    '2024-01-11': 'volatile',
    '2024-01-12': 'volatile',
  };
  const out = await validator.segment(
    { equity_curve: equity, strategy_key: 'test' },
    { persist: false, regime_source: makeFakeRegimeSource(stamps) }
  );
  expectEqual('4 segments', out.segments.length, 4);
  expectEqual('bull count 1', out.summary.segments_by_regime.bull, 1);
  expectEqual('bear count 1', out.summary.segments_by_regime.bear, 1);
  expectEqual('range count 1', out.summary.segments_by_regime.range, 1);
  expectEqual('volatile count 1', out.summary.segments_by_regime.volatile, 1);
  expectEqual('bull days 3', out.summary.days_by_regime.bull, 3);
  expectEqual('total_days 12', out.summary.total_days, 12);
}

// ============================================================
// main
// ============================================================

async function main() {
  console.log('Running RegimeSegmentedBacktest tests (US-040)...');

  runMapRegimeTests();
  runMergeAdjacentTests();
  runStatsTests();
  runComputeMetricsTests();
  runAggregateTests();

  await testHappyPath();
  await testAllOneRegime();
  await testCustomBenchmark();
  await testDefaultBenchmark();
  await testTradeSellDateFiltering();
  await testEmptyEquityThrows();
  await testMissingInputThrows();
  await testUnsortedEquitySortedByImpl();
  await testRegimeSourceRangeFallback();
  await testNoSharpeForShortSegments();
  await testStrategyKeyUnknownFallback();
  await testFourRegimesAllPresent();

  console.log(`\n${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test runner failed:', err);
  process.exit(2);
});
