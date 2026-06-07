/**
 * BenchmarkAttributionService 单元测试（US-045）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/performance/benchmark-attribution-service.test.ts
 *
 * 完全脱离 DB：注入 fake BenchmarkReturnSource + in-memory strategy_daily_returns；
 * persist=false 跳过写库。
 *
 * 覆盖维度：
 *   - 纯函数：
 *     deriveDailyReturnsFromEquityCurve / alignReturnSeries / computeMean / computeStddev /
 *     linearRegression / computeInformationRatio / computeCumulativeReturn / computeExcessDrawdown
 *   - 常量校验：DEFAULT_BENCHMARK_SYMBOLS / BENCHMARK_NAME_MAP / MIN_SAMPLE_COUNT / ANNUALIZATION_FACTOR
 *   - end-to-end computeAttribution()：
 *     - happy path：3 个默认基准 + alpha/beta/IR 都算对
 *     - 自定义 benchmark_symbols 透传
 *     - 单基准失败隔离（其他基准照常）
 *     - 基准数据缺失（fake source 返回空）→ sample_count=0 + 全 null
 *     - 不足 MIN_SAMPLE_COUNT → sample_count 记录但 alpha/beta null + 累计收益仍算
 *     - in-memory 3 种入参形态优先级（strategy_daily_returns > equity_curve > result_id）
 *     - 三种入参都缺失 → 抛错
 *     - 策略收益为空 → 抛错
 *     - 完美正相关 (strategy = benchmark) → beta≈1 / alpha≈0 / IR=null（std=0）
 *     - strategy 完全无关于 benchmark → beta≈0 / alpha≈mean(strategy)
 *     - admin 方法（getRun / listRecentRuns / deleteRun / cleanupOlderThan）— 不走 DB 仅覆盖签名 + boundary
 *
 * 注意：admin 方法的真正持久化测试需要 DB；本测试只覆盖签名 + cleanupOlderThan 的 days 参数校验。
 */

import {
  BenchmarkAttributionService,
  BenchmarkReturnSource,
  DailyReturnPoint,
  deriveDailyReturnsFromEquityCurve,
  alignReturnSeries,
  computeMean,
  computeStddev,
  linearRegression,
  computeInformationRatio,
  computeCumulativeReturn,
  computeExcessDrawdown,
  DEFAULT_BENCHMARK_SYMBOLS,
  BENCHMARK_NAME_MAP,
  MIN_SAMPLE_COUNT,
  ANNUALIZATION_FACTOR,
  SHARPE_ANNUALIZATION_SQRT,
} from '../../src/quant/performance/BenchmarkAttributionService';
import { QuantEquityPoint } from '../../src/quant/types/QuantTypes';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertApprox(name: string, actual: number, expected: number, eps = 1e-6): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) < eps;
  assert(name, ok, `actual=${actual} expected=${expected}`);
}

function assertNull(name: string, actual: any): void {
  assert(name, actual === null, `actual=${JSON.stringify(actual)}`);
}

// ============================================================
// fixtures
// ============================================================

function makeEquityCurve(start: string, returns: number[], startValue = 100000): QuantEquityPoint[] {
  // returns 是百分数日收益序列；起始 equity = startValue，按日复利
  const out: QuantEquityPoint[] = [];
  const d = new Date(start);
  let cur = startValue;
  // 首日值
  out.push({
    date: start,
    total_value: cur,
    cash: cur,
    position_value: 0,
    cumulative_return_pct: 0,
    drawdown_pct: 0,
  });
  let cumulative = 0;
  for (let i = 0; i < returns.length; i += 1) {
    d.setDate(d.getDate() + 1);
    const r = returns[i];
    cur *= 1 + r / 100;
    cumulative = ((cur / startValue) - 1) * 100;
    out.push({
      date: d.toISOString().split('T')[0],
      total_value: cur,
      cash: cur,
      position_value: 0,
      cumulative_return_pct: cumulative,
      drawdown_pct: 0,
    });
  }
  return out;
}

function makeFakeReturnSource(returnsBySymbol: Record<string, DailyReturnPoint[]>): BenchmarkReturnSource {
  return {
    async loadBenchmarkReturns(symbol, _start, _end) {
      return returnsBySymbol[symbol] || [];
    },
  };
}

function makeReturnPoints(start: string, returns: number[]): DailyReturnPoint[] {
  const out: DailyReturnPoint[] = [];
  const d = new Date(start);
  d.setDate(d.getDate() - 1); // 第一个 return 对应 start+1
  for (const r of returns) {
    d.setDate(d.getDate() + 1);
    out.push({ date: d.toISOString().split('T')[0], return_pct: r });
  }
  return out;
}

// ============================================================
// 常量校验
// ============================================================

(function testConstants() {
  assert(
    'DEFAULT_BENCHMARK_SYMBOLS 含 HS300 / CSI500 / CSI1000',
    DEFAULT_BENCHMARK_SYMBOLS.length === 3 &&
      DEFAULT_BENCHMARK_SYMBOLS[0] === 'sh.000300' &&
      DEFAULT_BENCHMARK_SYMBOLS[1] === 'sh.000905' &&
      DEFAULT_BENCHMARK_SYMBOLS[2] === 'sh.000852'
  );
  assert(
    'BENCHMARK_NAME_MAP 含 7 个基准',
    Object.keys(BENCHMARK_NAME_MAP).length === 7 &&
      BENCHMARK_NAME_MAP['sh.000300'] === '沪深300' &&
      BENCHMARK_NAME_MAP['sh.000905'] === '中证500' &&
      BENCHMARK_NAME_MAP['sh.000852'] === '中证1000'
  );
  assert('MIN_SAMPLE_COUNT = 5', MIN_SAMPLE_COUNT === 5);
  assert('ANNUALIZATION_FACTOR = 252', ANNUALIZATION_FACTOR === 252);
  assertApprox('SHARPE_ANNUALIZATION_SQRT ≈ sqrt(252)', SHARPE_ANNUALIZATION_SQRT, Math.sqrt(252), 1e-9);
})();

// ============================================================
// 纯函数：deriveDailyReturnsFromEquityCurve
// ============================================================

(function testDeriveDailyReturns() {
  // 空 / 单天
  assert('deriveDailyReturnsFromEquityCurve 空数组 → []', deriveDailyReturnsFromEquityCurve([]).length === 0);
  assert(
    'deriveDailyReturnsFromEquityCurve 单天 → []',
    deriveDailyReturnsFromEquityCurve([{ date: '2024-01-01', total_value: 100, cash: 100, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 }]).length === 0
  );

  // 2 天：100 → 101 → +1%
  const curve = makeEquityCurve('2024-01-01', [1.0]);
  const r = deriveDailyReturnsFromEquityCurve(curve);
  assert('2-day equity → 1-day return', r.length === 1);
  assertApprox('return_pct ≈ 1.0', r[0].return_pct, 1.0, 1e-9);

  // 3 天复利 1% × 2
  const curve2 = makeEquityCurve('2024-01-01', [1.0, 1.0]);
  const r2 = deriveDailyReturnsFromEquityCurve(curve2);
  assert('3-day equity → 2-day return', r2.length === 2);
  assertApprox('day1 return ≈ 1.0', r2[0].return_pct, 1.0, 1e-9);
  assertApprox('day2 return ≈ 1.0', r2[1].return_pct, 1.0, 1e-9);

  // 负数 total_value 跳过
  const dirty: QuantEquityPoint[] = [
    { date: '2024-01-01', total_value: 100, cash: 100, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-02', total_value: -10, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-03', total_value: 101, cash: 101, position_value: 0, cumulative_return_pct: 1, drawdown_pct: 0 },
  ];
  const rd = deriveDailyReturnsFromEquityCurve(dirty);
  assert('负 value 跳过 → 长度=0（重置不跨缺失日）', rd.length === 0);

  // NaN total_value 跳过
  const dirty2: QuantEquityPoint[] = [
    { date: '2024-01-01', total_value: 100, cash: 100, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-02', total_value: NaN, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-03', total_value: 101, cash: 101, position_value: 0, cumulative_return_pct: 1, drawdown_pct: 0 },
  ];
  const rd2 = deriveDailyReturnsFromEquityCurve(dirty2);
  assert('NaN value 跳过 + 重置', rd2.length === 0);

  // string total_value 应被 Number() 转换支持
  const stringCurve: any[] = [
    { date: '2024-01-01', total_value: '100' },
    { date: '2024-01-02', total_value: '102' },
  ];
  const rs = deriveDailyReturnsFromEquityCurve(stringCurve);
  assert('string total_value 支持 Number 转换', rs.length === 1);
  assertApprox('string-derived return ≈ 2.0', rs[0].return_pct, 2.0, 1e-9);
})();

// ============================================================
// 纯函数：alignReturnSeries
// ============================================================

(function testAlignReturnSeries() {
  // 空 strategy
  let r = alignReturnSeries([], makeReturnPoints('2024-01-01', [1]));
  assert('空 strategy → 空对齐', r.dates.length === 0);

  // 空 benchmark
  r = alignReturnSeries(makeReturnPoints('2024-01-01', [1]), []);
  assert('空 benchmark → 空对齐', r.dates.length === 0);

  // 完全相同 dates
  const strat = makeReturnPoints('2024-01-01', [1.0, 2.0, -1.0]);
  const bench = makeReturnPoints('2024-01-01', [0.5, 1.0, -0.5]);
  r = alignReturnSeries(strat, bench);
  assert('完全相同 dates → 长度 = 3', r.dates.length === 3 && r.strategy.length === 3 && r.benchmark.length === 3);
  assertApprox('strat[0]', r.strategy[0], 1.0, 1e-9);
  assertApprox('bench[0]', r.benchmark[0], 0.5, 1e-9);

  // 部分重叠
  const stratPartial: DailyReturnPoint[] = [
    { date: '2024-01-02', return_pct: 1 },
    { date: '2024-01-03', return_pct: 2 },
    { date: '2024-01-04', return_pct: 3 },
  ];
  const benchPartial: DailyReturnPoint[] = [
    { date: '2024-01-01', return_pct: 0.5 },
    { date: '2024-01-03', return_pct: 1.5 },
    { date: '2024-01-04', return_pct: 2.5 },
    { date: '2024-01-05', return_pct: 3.5 },
  ];
  r = alignReturnSeries(stratPartial, benchPartial);
  assert('部分重叠 → 交集 = 2 (01-03, 01-04)', r.dates.length === 2);
  assert('交集 date[0]=01-03', r.dates[0] === '2024-01-03');
  assert('交集 date[1]=01-04', r.dates[1] === '2024-01-04');
  assertApprox('strat[01-03]', r.strategy[0], 2.0, 1e-9);
  assertApprox('bench[01-03]', r.benchmark[0], 1.5, 1e-9);

  // 无共同日
  const stratNoOverlap = makeReturnPoints('2024-01-01', [1, 2]);
  const benchNoOverlap = makeReturnPoints('2025-01-01', [1, 2]);
  r = alignReturnSeries(stratNoOverlap, benchNoOverlap);
  assert('无共同日 → 空对齐', r.dates.length === 0);

  // NaN 在 strategy 不进交集
  const stratWithNaN: DailyReturnPoint[] = [
    { date: '2024-01-01', return_pct: NaN },
    { date: '2024-01-02', return_pct: 2 },
  ];
  const benchClean = makeReturnPoints('2024-01-01', [1, 2]);
  r = alignReturnSeries(stratWithNaN, benchClean);
  assert('strategy NaN 行被剔除', r.dates.length === 1 && r.dates[0] === '2024-01-02');

  // Infinity 同理
  const stratWithInf: DailyReturnPoint[] = [
    { date: '2024-01-01', return_pct: Infinity },
    { date: '2024-01-02', return_pct: 2 },
  ];
  r = alignReturnSeries(stratWithInf, benchClean);
  assert('strategy Infinity 行被剔除', r.dates.length === 1);

  // 输出 dates 按 ISO 升序
  const stratUnsorted: DailyReturnPoint[] = [
    { date: '2024-01-03', return_pct: 3 },
    { date: '2024-01-01', return_pct: 1 },
    { date: '2024-01-02', return_pct: 2 },
  ];
  const benchSorted = makeReturnPoints('2024-01-01', [10, 20, 30]);
  r = alignReturnSeries(stratUnsorted, benchSorted);
  assert('输出 dates 按升序', r.dates[0] === '2024-01-01' && r.dates[1] === '2024-01-02' && r.dates[2] === '2024-01-03');
  assertApprox('对齐后 strat[01-01] = 1', r.strategy[0], 1, 1e-9);
  assertApprox('对齐后 bench[01-01] = 10', r.benchmark[0], 10, 1e-9);
})();

// ============================================================
// 纯函数：computeMean / computeStddev
// ============================================================

(function testMeanStddev() {
  assertNull('computeMean 空数组', computeMean([]));
  assertNull('computeMean 全 NaN', computeMean([NaN, NaN, Infinity, -Infinity]));
  assertApprox('computeMean [1,2,3] = 2', computeMean([1, 2, 3]) as number, 2, 1e-9);
  assertApprox('computeMean 过滤 NaN [1,NaN,3] = 2', computeMean([1, NaN, 3]) as number, 2, 1e-9);
  assertApprox('computeMean 单元素 [5] = 5', computeMean([5]) as number, 5, 1e-9);

  assertNull('computeStddev 空数组', computeStddev([]));
  assertNull('computeStddev 单元素', computeStddev([1]));
  assertApprox('computeStddev [1,2,3] = 1', computeStddev([1, 2, 3]) as number, 1, 1e-9);
  // n-1 公式：mean=2, ss=(1-2)^2+(2-2)^2+(3-2)^2=2, /2 = 1, sqrt=1
  assertApprox('computeStddev [1,1,1] = 0', computeStddev([1, 1, 1]) as number, 0, 1e-9);
  // [0,0,3,3] mean=1.5, ss=2.25+2.25+2.25+2.25=9, /3=3, sqrt(3)≈1.732
  assertApprox('computeStddev [0,0,3,3] ≈ √3', computeStddev([0, 0, 3, 3]) as number, Math.sqrt(3), 1e-9);
})();

// ============================================================
// 纯函数：linearRegression
// ============================================================

(function testLinearRegression() {
  // y = 2x + 1 完美线性
  const x = [1, 2, 3, 4, 5];
  const y = [3, 5, 7, 9, 11];
  let r = linearRegression(x, y);
  assertApprox('linear y=2x+1: beta=2', r.beta as number, 2, 1e-9);
  assertApprox('linear y=2x+1: alpha=1', r.alpha as number, 1, 1e-9);
  assertApprox('linear y=2x+1: r²=1', r.r_squared as number, 1, 1e-9);

  // y = 3x + 0 完美线性
  r = linearRegression([1, 2, 3], [3, 6, 9]);
  assertApprox('linear y=3x: beta=3', r.beta as number, 3, 1e-9);
  assertApprox('linear y=3x: alpha=0', r.alpha as number, 0, 1e-9);

  // 长度不等 → 全 null
  r = linearRegression([1, 2], [1, 2, 3]);
  assertNull('linear 长度不等 alpha', r.alpha);
  assertNull('linear 长度不等 beta', r.beta);
  assertNull('linear 长度不等 r²', r.r_squared);

  // 不足 2 → 全 null
  r = linearRegression([1], [1]);
  assertNull('linear < 2 alpha', r.alpha);
  assertNull('linear < 2 beta', r.beta);

  // x 全相等（var=0）→ 全 null
  r = linearRegression([5, 5, 5, 5], [1, 2, 3, 4]);
  assertNull('linear x 全相等 alpha', r.alpha);
  assertNull('linear x 全相等 beta', r.beta);
  assertNull('linear x 全相等 r²', r.r_squared);

  // y 全相等：beta=0, alpha=mean(y), r²=null
  r = linearRegression([1, 2, 3, 4], [5, 5, 5, 5]);
  assertApprox('linear y 全相等 beta=0', r.beta as number, 0, 1e-9);
  assertApprox('linear y 全相等 alpha=5', r.alpha as number, 5, 1e-9);
  assertNull('linear y 全相等 r²=null', r.r_squared);

  // NaN 输入 → 全 null
  r = linearRegression([1, NaN, 3], [1, 2, 3]);
  assertNull('linear NaN x alpha', r.alpha);

  r = linearRegression([1, 2, 3], [1, 2, Infinity]);
  assertNull('linear Infinity y alpha', r.alpha);

  // 无完美相关的真实场景：模拟 CAPM
  // bench = [-1, 1, -1, 1, 2], strategy = [0, 1.5, -0.5, 1, 3]
  // beta = cov/var(bench)；ssXX = sum((bench - mean)^2)
  // mean_bench=0.4, mean_strat=1.0
  // diffs bench: -1.4, 0.6, -1.4, 0.6, 1.6
  // diffs strat: -1, 0.5, -1.5, 0, 2
  // ssXY = (-1.4)(-1)+(0.6)(0.5)+(-1.4)(-1.5)+(0.6)(0)+(1.6)(2) = 1.4+0.3+2.1+0+3.2 = 7.0
  // ssXX = 1.96 + 0.36 + 1.96 + 0.36 + 2.56 = 7.20
  // beta = 7.0/7.2 = 0.9722...
  // alpha = 1 - 0.9722 * 0.4 = 0.6111...
  r = linearRegression([-1, 1, -1, 1, 2], [0, 1.5, -0.5, 1, 3]);
  assertApprox('CAPM-like beta ≈ 7/7.2', r.beta as number, 7 / 7.2, 1e-6);
  assertApprox('CAPM-like alpha ≈ 1 - 7/7.2 * 0.4', r.alpha as number, 1 - (7 / 7.2) * 0.4, 1e-6);
})();

// ============================================================
// 纯函数：computeInformationRatio
// ============================================================

(function testIR() {
  assertNull('IR 空 strategy', computeInformationRatio([], [1]));
  assertNull('IR 长度不等', computeInformationRatio([1, 2], [1, 2, 3]));
  assertNull('IR < 2', computeInformationRatio([1], [1]));

  // 完全相同：excess = 0...0 → std=0 → null
  assertNull('IR strategy = benchmark → null', computeInformationRatio([1, 2, 3, 4], [1, 2, 3, 4]));

  // strategy = benchmark + 0.1 每天 → excess = [0.1] * N → std=0 → null
  // 但 mean=0.1 → 仍是 std=0 case → null
  assertNull(
    'IR strategy = benchmark + 常数 → null（std=0）',
    computeInformationRatio([1.1, 2.1, 3.1], [1, 2, 3])
  );

  // 真实 IR
  // strategy=[1, 2, -1, 3], benchmark=[0, 1, 0, 1]
  // excess = [1, 1, -1, 2], mean=0.75, std (n-1) = sqrt((0.0625+0.0625+3.0625+1.5625)/3) = sqrt(4.75/3) ≈ 1.2583
  // IR = 0.75 / 1.2583 * sqrt(252) ≈ 0.5961 * 15.8745 ≈ 9.46
  const ir = computeInformationRatio([1, 2, -1, 3], [0, 1, 0, 1]);
  const meanExc = 0.75;
  const stdExc = Math.sqrt(4.75 / 3);
  const expectedIR = (meanExc / stdExc) * Math.sqrt(252);
  assertApprox('IR 实际公式验算', ir as number, expectedIR, 1e-6);

  // 含 NaN：剔除该日 (paired)
  const irNaN = computeInformationRatio([1, NaN, -1, 3], [0, 1, 0, 1]);
  // excess after filter NaN: [1, -1, 2], mean=0.6667, std=sqrt((0.111+2.778+1.778)/2)=sqrt(4.667/2)=sqrt(2.333)≈1.528
  // IR ≈ 0.6667/1.528 * sqrt(252)
  assert('IR NaN 过滤后仍能算', irNaN !== null && Number.isFinite(irNaN));
})();

// ============================================================
// 纯函数：computeCumulativeReturn
// ============================================================

(function testCumulativeReturn() {
  assertApprox('空数组 → 0', computeCumulativeReturn([]), 0, 1e-9);

  // 单日 +5% → +5%
  assertApprox('单日 +5%', computeCumulativeReturn([5]), 5, 1e-9);

  // 两日各 +10% → (1.1*1.1 - 1)*100 = 21%
  assertApprox('两日各 +10% → 21%', computeCumulativeReturn([10, 10]), 21, 1e-9);

  // +10% 然后 -10% → (1.1*0.9 - 1)*100 = -1%
  assertApprox('+10% -10% → -1%', computeCumulativeReturn([10, -10]), -1, 1e-9);

  // 100 天每天 0.1% → (1.001^100 - 1)*100 ≈ 10.512%
  const dailySmall = Array(100).fill(0.1);
  assertApprox('100 天每天 0.1%', computeCumulativeReturn(dailySmall), (Math.pow(1.001, 100) - 1) * 100, 1e-6);

  // 爆仓：单笔 -100%
  assertApprox('单笔 -100% → -100%', computeCumulativeReturn([-100]), -100, 1e-9);

  // 单笔 -110%（理论不可能）→ short-circuit -100%
  assertApprox('单笔 -110% → -100% (爆仓)', computeCumulativeReturn([-110]), -100, 1e-9);

  // NaN 过滤
  assertApprox('NaN 跳过 → 仍能算', computeCumulativeReturn([10, NaN, 10]), 21, 1e-9);
})();

// ============================================================
// 纯函数：computeExcessDrawdown
// ============================================================

(function testExcessDrawdown() {
  assertApprox('空数组 → 0', computeExcessDrawdown([], []), 0, 1e-9);
  assertApprox('长度不等 → 0', computeExcessDrawdown([1, 2], [1]), 0, 1e-9);
  assertApprox('单元素 → 0', computeExcessDrawdown([1], [1]), 0, 1e-9);

  // strategy = benchmark → excess 全 0 → equity 全 100 → dd=0
  assertApprox('strategy = benchmark → dd=0', computeExcessDrawdown([1, 2, 3, -1], [1, 2, 3, -1]), 0, 1e-9);

  // strategy 一直跑赢 → excess > 0 → 单调升 → dd=0
  assertApprox(
    'strategy 一直跑赢 → dd=0',
    computeExcessDrawdown([2, 2, 2, 2], [1, 1, 1, 1]),
    0,
    1e-9
  );

  // strategy 一直跑输：excess 一直负
  // strategy=[-2, -2, -2, -2], benchmark=[0, 0, 0, 0]
  // excess=[-2, -2, -2, -2]
  // equity: 100 → 98 → 96.04 → 94.1192 → 92.2368
  // peak=100, lowest=92.2368
  // dd = (100 - 92.2368) / 100 = 7.76%
  const dd1 = computeExcessDrawdown([-2, -2, -2, -2], [0, 0, 0, 0]);
  const exp1 = (1 - Math.pow(0.98, 4)) * 100;
  assertApprox('strategy 一直输 -2% → dd 约 7.76%', dd1, exp1, 1e-6);

  // strategy 先赢后输：excess +5, +5, -10, -10
  // equity: 100 → 105 → 110.25 → 99.225 → 89.3025
  // peak=110.25, lowest=89.3025 (so far)
  // dd = (110.25 - 89.3025) / 110.25 ≈ 19.0%
  const dd2 = computeExcessDrawdown([5, 5, -10, -10], [0, 0, 0, 0]);
  const peakV = 100 * 1.05 * 1.05;
  const lowV = peakV * 0.9 * 0.9;
  const expDd2 = ((peakV - lowV) / peakV) * 100;
  assertApprox('先赢后输 dd 验算', dd2, expDd2, 1e-6);
})();

// ============================================================
// end-to-end computeAttribution()
// ============================================================

async function testE2EHappyPath() {
  // 策略 = benchmark + 0.5% / 天的固定 alpha
  const benchReturns = [0.5, -0.3, 0.8, -0.2, 1.0, 0.0, -0.5, 0.6]; // 8 天
  const stratReturns = benchReturns.map(r => r + 0.5);
  const startDate = '2024-01-01';

  const stratPoints = makeReturnPoints(startDate, stratReturns);
  const benchPoints = makeReturnPoints(startDate, benchReturns);

  const fakeSource = makeFakeReturnSource({
    'sh.000300': benchPoints,
    'sh.000905': benchPoints,
    'sh.000852': benchPoints,
  });

  const service = new BenchmarkAttributionService();
  const r = await service.computeAttribution(
    {
      strategy_daily_returns: stratPoints,
      strategy_key: 'test_strategy',
    },
    { persist: false, benchmark_return_source: fakeSource }
  );

  assert('happy: 3 个基准结果', r.attributions.length === 3);
  assert('happy: 第一个基准 = sh.000300', r.attributions[0].benchmark_symbol === 'sh.000300');
  assert('happy: benchmark_name 自动填', r.attributions[0].benchmark_name === '沪深300');

  for (const a of r.attributions) {
    assert(`${a.benchmark_symbol}: sample_count = 8`, a.sample_count === 8);
    // strategy = benchmark + 0.5 → 完美线性，beta ≈ 1.0, alpha ≈ 0.5 (日)
    assertApprox(`${a.benchmark_symbol}: beta ≈ 1.0`, a.beta as number, 1.0, 1e-6);
    // alpha 日 = 0.5, 年化 = 0.5 * 252 = 126
    assertApprox(`${a.benchmark_symbol}: alpha_annual ≈ 126`, a.alpha_annual_pct as number, 126, 1e-3);
    assertApprox(`${a.benchmark_symbol}: r² ≈ 1.0`, a.r_squared as number, 1.0, 1e-6);
    // IR：excess 全为 0.5 → std=0 → null
    assertNull(`${a.benchmark_symbol}: IR null（std=0）`, a.information_ratio);
  }

  assert('happy: run_id = null（in-memory + no quant_id）', r.run_id === null);
  assert('happy: strategy_key 透传', r.strategy_key === 'test_strategy');
  assert('happy: duration_ms ≥ 0', r.duration_ms >= 0);
  assert('happy: persisted_ids 全 null（persist=false）', r.persisted_ids.every(x => x === null));
}

async function testE2ECustomBenchmarks() {
  const stratPoints = makeReturnPoints('2024-01-01', [1, 1, 1, 1, 1, 1]);
  const benchPoints = makeReturnPoints('2024-01-01', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const fakeSource = makeFakeReturnSource({ 'sh.000001': benchPoints });

  const service = new BenchmarkAttributionService();
  const r = await service.computeAttribution(
    {
      strategy_daily_returns: stratPoints,
      benchmark_symbols: ['sh.000001'], // 仅 1 个自定义基准
    },
    { persist: false, benchmark_return_source: fakeSource }
  );
  assert('custom: 仅 1 个 attribution', r.attributions.length === 1);
  assert('custom: 透传 symbol', r.attributions[0].benchmark_symbol === 'sh.000001');
  assert('custom: name 仍能从 map 找', r.attributions[0].benchmark_name === '上证指数');
}

async function testE2EMissingBenchmark() {
  // sh.000300 / sh.000905 有数据，sh.000852 fake source 返回 []
  const stratPoints = makeReturnPoints('2024-01-01', [1, 1, 1, 1, 1, 1]);
  const benchPoints = makeReturnPoints('2024-01-01', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const fakeSource = makeFakeReturnSource({
    'sh.000300': benchPoints,
    'sh.000905': benchPoints,
    'sh.000852': [], // 缺失
  });

  const service = new BenchmarkAttributionService();
  const r = await service.computeAttribution(
    { strategy_daily_returns: stratPoints },
    { persist: false, benchmark_return_source: fakeSource }
  );

  assert('missing: 3 个基准结果', r.attributions.length === 3);
  assert('missing: HS300 sample_count = 6', r.attributions[0].sample_count === 6);
  assert('missing: CSI500 sample_count = 6', r.attributions[1].sample_count === 6);
  assert('missing: CSI1000 sample_count = 0', r.attributions[2].sample_count === 0);
  assertNull('missing: CSI1000 alpha null', r.attributions[2].alpha_annual_pct);
  assertNull('missing: CSI1000 beta null', r.attributions[2].beta);
  assert(
    'missing: CSI1000 error 字段填了',
    typeof r.attributions[2].error === 'string' && r.attributions[2].error!.length > 0
  );
}

async function testE2EInsufficientSamples() {
  // 仅 3 天，少于 MIN_SAMPLE_COUNT=5
  const stratPoints = makeReturnPoints('2024-01-01', [1, 2, -1]);
  const benchPoints = makeReturnPoints('2024-01-01', [0.5, 1, -0.5]);
  const fakeSource = makeFakeReturnSource({
    'sh.000300': benchPoints,
    'sh.000905': benchPoints,
    'sh.000852': benchPoints,
  });

  const service = new BenchmarkAttributionService();
  const r = await service.computeAttribution(
    { strategy_daily_returns: stratPoints },
    { persist: false, benchmark_return_source: fakeSource }
  );

  for (const a of r.attributions) {
    assert(`${a.benchmark_symbol}: sample_count = 3`, a.sample_count === 3);
    assertNull(`${a.benchmark_symbol}: alpha null（不足 MIN）`, a.alpha_annual_pct);
    assertNull(`${a.benchmark_symbol}: beta null`, a.beta);
    // 累计收益仍能算
    assert(`${a.benchmark_symbol}: strategy_return_pct 非 null`, a.strategy_return_pct !== null);
    assert(`${a.benchmark_symbol}: benchmark_return_pct 非 null`, a.benchmark_return_pct !== null);
    assert(`${a.benchmark_symbol}: excess_return_pct 非 null`, a.excess_return_pct !== null);
    assert(
      `${a.benchmark_symbol}: error 字段提示 sample 不足`,
      typeof a.error === 'string' && a.error!.includes('不足')
    );
  }
}

async function testE2EInputPriority() {
  // 三种入参形态 (strategy_daily_returns > equity_curve > quant_backtest_result_id)
  const stratPoints = makeReturnPoints('2024-01-01', [1, 1, 1, 1, 1, 1]);
  const equityCurve = makeEquityCurve('2024-01-01', [5, 5, 5, 5, 5, 5]); // 不同 returns
  const benchPoints = makeReturnPoints('2024-01-01', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const fakeSource = makeFakeReturnSource({
    'sh.000300': benchPoints,
    'sh.000905': benchPoints,
    'sh.000852': benchPoints,
  });

  const service = new BenchmarkAttributionService();
  // 同时提供 strategy_daily_returns + equity_curve → 应使用 strategy_daily_returns
  const r = await service.computeAttribution(
    {
      strategy_daily_returns: stratPoints,
      equity_curve: equityCurve,
    },
    { persist: false, benchmark_return_source: fakeSource }
  );

  // strategy_daily_returns 的 strategy_return ≈ (1.01^6 - 1) * 100 ≈ 6.152%
  // equity_curve 的 strategy_return ≈ (1.05^6 - 1) * 100 ≈ 34.01%
  const expectedFromPriority = (Math.pow(1.01, 6) - 1) * 100;
  assertApprox(
    'input priority: strategy_daily_returns 优先（不是 equity_curve）',
    r.attributions[0].strategy_return_pct as number,
    expectedFromPriority,
    1e-4
  );
}

async function testE2EThrowsWhenMissingInput() {
  const service = new BenchmarkAttributionService();
  let threw = false;
  try {
    await service.computeAttribution({} as any, { persist: false });
  } catch (e: any) {
    threw = true;
    assert('missing input: error message 含 strategy_daily_returns', e.message.includes('strategy_daily_returns'));
  }
  assert('missing input: 抛错', threw);
}

async function testE2EThrowsWhenEmptyReturns() {
  const service = new BenchmarkAttributionService();
  let threw = false;
  try {
    await service.computeAttribution(
      { strategy_daily_returns: [] },
      { persist: false }
    );
  } catch (e: any) {
    threw = true;
    // strategy_daily_returns = [] 退化为 input 缺失路径，throw 的 message 是
    // "必须提供 strategy_daily_returns / equity_curve / quant_backtest_result_id 三者其一"。
    // 仅断言抛错 + 错误信息含有提示词。
    assert(
      'empty: error 含「必须提供」或「为空」',
      e.message.includes('必须提供') || e.message.includes('为空')
    );
  }
  assert('empty: 抛错（应该）', threw);
}

async function testE2EEquityCurveDerivation() {
  // 验证 equity_curve 输入也能 work（无 strategy_daily_returns）
  const equityCurve = makeEquityCurve('2024-01-01', [1, 1, 1, 1, 1, 1]); // +1% / 天
  const benchPoints = makeReturnPoints('2024-01-02', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]); // start +1 day
  const fakeSource = makeFakeReturnSource({
    'sh.000300': benchPoints,
    'sh.000905': benchPoints,
    'sh.000852': benchPoints,
  });

  const service = new BenchmarkAttributionService();
  const r = await service.computeAttribution(
    {
      equity_curve: equityCurve,
    },
    { persist: false, benchmark_return_source: fakeSource }
  );

  assert('equity_curve mode: 3 个 attribution', r.attributions.length === 3);
  // strategy 派生出 6 个 return（7 天 equity），与 6 个 bench return 对齐 = 6 个 sample
  assert(
    `equity_curve mode: sample_count = 6 (actual=${r.attributions[0].sample_count})`,
    r.attributions[0].sample_count === 6
  );
  assert('equity_curve mode: strategy_key fallback = unknown', r.strategy_key === 'unknown');
}

async function testE2EPerfectCorrelation() {
  // strategy = benchmark 完全相同 → beta=1 / alpha=0 / IR=null
  const benchReturns = [0.5, -0.3, 0.8, -0.2, 1.0, 0.0, -0.5, 0.6];
  const stratPoints = makeReturnPoints('2024-01-01', benchReturns);
  const benchPoints = makeReturnPoints('2024-01-01', benchReturns);
  const fakeSource = makeFakeReturnSource({ 'sh.000300': benchPoints });

  const service = new BenchmarkAttributionService();
  const r = await service.computeAttribution(
    { strategy_daily_returns: stratPoints, benchmark_symbols: ['sh.000300'] },
    { persist: false, benchmark_return_source: fakeSource }
  );

  assertApprox('perfect: beta = 1.0', r.attributions[0].beta as number, 1.0, 1e-6);
  assertApprox('perfect: alpha_annual = 0', r.attributions[0].alpha_annual_pct as number, 0, 1e-6);
  assertApprox('perfect: r² = 1.0', r.attributions[0].r_squared as number, 1.0, 1e-6);
  assertApprox('perfect: excess_return = 0', r.attributions[0].excess_return_pct as number, 0, 1e-6);
  assertNull('perfect: IR null (std=0)', r.attributions[0].information_ratio);
}

async function testE2EZeroBeta() {
  // strategy 与 benchmark 无关：x = [-1, 1, -1, 1, -1] var=1.6
  // y = [0, 0, 0, 0, 0] mean=0 var=0
  // beta=0, alpha=0, r²=null
  const stratPoints = makeReturnPoints('2024-01-01', [0, 0, 0, 0, 0]);
  const benchPoints = makeReturnPoints('2024-01-01', [-1, 1, -1, 1, -1]);
  const fakeSource = makeFakeReturnSource({ 'sh.000300': benchPoints });

  const service = new BenchmarkAttributionService();
  const r = await service.computeAttribution(
    { strategy_daily_returns: stratPoints, benchmark_symbols: ['sh.000300'] },
    { persist: false, benchmark_return_source: fakeSource }
  );

  // strategy 全 0 → mean=0 → alpha = 0 - beta * mean(bench)
  // beta = cov/var = 0 (因 strategy 全 0 → diffs 全 0 → covariance=0)
  // alpha = 0
  assertApprox('zero-beta: beta = 0', r.attributions[0].beta as number, 0, 1e-9);
  assertApprox('zero-beta: alpha = 0 (annualized)', r.attributions[0].alpha_annual_pct as number, 0, 1e-9);
  // r² = 0 / (ssXX * 0) = NaN... 但 ssYY=0 → 显式返回 null
  assertNull('zero-beta: r² null (ssYY=0)', r.attributions[0].r_squared);
}

async function testE2ESourceThrowsIsolation() {
  // 一个 source.loadBenchmarkReturns 抛错 → 该 attribution 失败 + error 字段 + 其他基准照常
  const benchPoints = makeReturnPoints('2024-01-01', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const sourceThrows: BenchmarkReturnSource = {
    async loadBenchmarkReturns(symbol) {
      if (symbol === 'sh.000905') {
        throw new Error('fake source intentional throw');
      }
      return benchPoints;
    },
  };

  const stratPoints = makeReturnPoints('2024-01-01', [1, 1, 1, 1, 1, 1]);
  const service = new BenchmarkAttributionService();
  const r = await service.computeAttribution(
    { strategy_daily_returns: stratPoints },
    { persist: false, benchmark_return_source: sourceThrows }
  );

  assert('source throws: 3 个 attribution（不中断）', r.attributions.length === 3);
  assert('source throws: HS300 仍成功', r.attributions[0].sample_count === 6);
  assert(
    'source throws: CSI500 失败 sample_count=0 + error 字段',
    r.attributions[1].sample_count === 0 &&
      typeof r.attributions[1].error === 'string' &&
      r.attributions[1].error!.includes('intentional throw')
  );
  assert('source throws: CSI1000 仍成功', r.attributions[2].sample_count === 6);
}

// ============================================================
// admin 方法 (cleanupOlderThan 参数校验 — 不走 DB)
// ============================================================

async function testCleanupParameterValidation() {
  const service = new BenchmarkAttributionService();
  let threw = false;
  try {
    await service.cleanupOlderThan(0);
  } catch (e: any) {
    threw = true;
    assert('cleanup days=0 抛错 msg 含「正数」', e.message.includes('正数'));
  }
  assert('cleanup days=0 抛错', threw);

  threw = false;
  try {
    await service.cleanupOlderThan(-5);
  } catch {
    threw = true;
  }
  assert('cleanup days=-5 抛错', threw);

  threw = false;
  try {
    await service.cleanupOlderThan(NaN);
  } catch {
    threw = true;
  }
  assert('cleanup days=NaN 抛错', threw);

  threw = false;
  try {
    await service.cleanupOlderThan(Infinity);
  } catch {
    threw = true;
  }
  assert('cleanup days=Infinity 抛错', threw);
}

// ============================================================
// computeSingleBenchmark 直接测试
// ============================================================

async function testComputeSingleBenchmarkDirect() {
  const service = new BenchmarkAttributionService();
  const stratPoints = makeReturnPoints('2024-01-01', [1, 2, -1, 3, 0.5]);
  const benchPoints = makeReturnPoints('2024-01-01', [0.5, 1, -0.5, 1.5, 0.25]);

  const a = service.computeSingleBenchmark('sh.000300', stratPoints, benchPoints);
  assert('direct: symbol', a.benchmark_symbol === 'sh.000300');
  assert('direct: name 自动填', a.benchmark_name === '沪深300');
  assert('direct: sample_count = 5', a.sample_count === 5);
  // 完美 2x 比例 + 0 alpha
  assertApprox('direct: beta ≈ 2', a.beta as number, 2, 1e-6);
  assertApprox('direct: alpha ≈ 0', a.alpha_annual_pct as number, 0, 1e-4);

  // 空 benchmark → sample_count = 0
  const empty = service.computeSingleBenchmark('sh.000300', stratPoints, []);
  assert('direct empty: sample_count=0', empty.sample_count === 0);
  assertNull('direct empty: alpha null', empty.alpha_annual_pct);
  assert('direct empty: error 字段', typeof empty.error === 'string');

  // 未知 symbol → name fallback = symbol
  const unknown = service.computeSingleBenchmark('xxx.999999', stratPoints, benchPoints);
  assert('direct unknown symbol: name = symbol', unknown.benchmark_name === 'xxx.999999');
}

// ============================================================
// Runner
// ============================================================

async function main() {
  await testE2EHappyPath();
  await testE2ECustomBenchmarks();
  await testE2EMissingBenchmark();
  await testE2EInsufficientSamples();
  await testE2EInputPriority();
  await testE2EThrowsWhenMissingInput();
  await testE2EThrowsWhenEmptyReturns();
  await testE2EEquityCurveDerivation();
  await testE2EPerfectCorrelation();
  await testE2EZeroBeta();
  await testE2ESourceThrowsIsolation();
  await testCleanupParameterValidation();
  await testComputeSingleBenchmarkDirect();

  console.log(`\n=== BenchmarkAttributionService tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
