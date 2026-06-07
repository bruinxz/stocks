/**
 * FactorICReport 单元测试（US-041）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/factor-ic-report.test.ts
 *
 * 完全脱离 DB：注入 fake FactorICDataSource + persist:false。
 *
 * 覆盖维度：
 *   - 纯函数：rankAscending / spearmanCorrelation / mean / sampleStddev / aggregateICSeries
 *   - end-to-end generate()：
 *     - happy path：单因子 × 单窗口 + 多窗口
 *     - lookahead bias guard：base_date + lookForward > end_date 该日跳过
 *     - 横截面 < MIN_CROSS_SECTION_SIZE 该日 ic=null 不进聚合
 *     - 全区间无可用 IC → sample_count=0 + 全 null
 *     - persist=false 不走 DB
 *     - 自定义 windows override
 *     - factor_name 未注册 + 未注入 DataSource → 抛错
 *     - factor_name 未注册 + 注入 DataSource → 不抛错
 *     - start >= end 抛错
 *     - lookForwardDays ≤ 0 抛错
 *     - period_start / period_end 字段正确（取自 valid IC 日期）
 *     - duration_ms 字段记录
 */

import {
  FactorICReport,
  FactorICDataSource,
  ICStatistics,
  DailyICRecord,
  rankAscending,
  spearmanCorrelation,
  mean,
  sampleStddev,
  aggregateICSeries,
  DEFAULT_LOOK_FORWARD_DAYS,
  MIN_CROSS_SECTION_SIZE,
} from '../../src/quant/factors/FactorICReport';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记（这样 factor_name 校验测试能拿到真实因子）
// eslint-disable-next-line @typescript-eslint/no-var-requires
import '../../src/quant/factors/library';

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

function runRankAscendingTests() {
  console.log('\n## rankAscending');
  // 空数组
  expectEqual('empty array → []', rankAscending([]), []);
  // 单元素
  expectEqual('single element → [1]', rankAscending([42]), [1]);
  // 升序
  expectEqual('ascending [10,20,30]', rankAscending([10, 20, 30]), [1, 2, 3]);
  // 降序（原 index → 反向 rank）
  expectEqual('descending [30,20,10]', rankAscending([30, 20, 10]), [3, 2, 1]);
  // 全相等 → 平均秩 (1+2+3)/3 = 2
  expectEqual('all equal → avg rank 2,2,2', rankAscending([5, 5, 5]), [2, 2, 2]);
  // 含 tie：[10, 30, 20, 30]，排序 [10, 20, 30, 30]，第 3/4 位 tie → avg=3.5
  expectEqual('tie at end [10,30,20,30]', rankAscending([10, 30, 20, 30]), [
    1, 3.5, 2, 3.5,
  ]);
  // 含 tie 在开头：[5, 5, 10, 20]，排序 [5, 5, 10, 20]，第 1/2 位 tie → avg=1.5
  expectEqual('tie at start [5,5,10,20]', rankAscending([5, 5, 10, 20]), [
    1.5, 1.5, 3, 4,
  ]);
  // 多组 tie
  expectEqual('multi-tie [1,2,1,2,3]', rankAscending([1, 2, 1, 2, 3]), [
    1.5, 3.5, 1.5, 3.5, 5,
  ]);
  // 负数
  expectEqual('with negatives [-5,0,5]', rankAscending([-5, 0, 5]), [1, 2, 3]);
  // 浮点 + tie
  expectEqual('floats with tie [1.5,2.5,1.5]', rankAscending([1.5, 2.5, 1.5]), [
    1.5, 3, 1.5,
  ]);
}

function runSpearmanTests() {
  console.log('\n## spearmanCorrelation');
  // 长度不对齐 → null
  expectEqual('length mismatch → null', spearmanCorrelation([1, 2], [1, 2, 3]), null);
  // 长度 < 2 → null
  expectEqual('length 1 → null', spearmanCorrelation([5], [10]), null);
  // 空数组 → null
  expectEqual('empty → null', spearmanCorrelation([], []), null);
  // 完美正相关：x 和 y 单调同序
  expectClose(
    'perfect positive corr',
    spearmanCorrelation([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]) as number,
    1.0,
    1e-9
  );
  // 完美负相关
  expectClose(
    'perfect negative corr',
    spearmanCorrelation([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]) as number,
    -1.0,
    1e-9
  );
  // 无序 (x 完全单调，y 完全反序)：x rank [1..5] y rank [5..1]，corr = -1
  expectClose(
    'reversed corr = -1',
    spearmanCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) as number,
    -1.0,
    1e-9
  );
  // 全相等 x → stddev=0 → null
  expectEqual(
    'all equal x → null (stddev 0)',
    spearmanCorrelation([5, 5, 5, 5], [1, 2, 3, 4]),
    null
  );
  expectEqual(
    'all equal y → null (stddev 0)',
    spearmanCorrelation([1, 2, 3, 4], [5, 5, 5, 5]),
    null
  );
  // 已知数值：x=[1,2,3,4,5], y=[1,3,2,5,4] → rank x=[1..5], rank y=[1,3,2,5,4]
  // 差 d=[0,-1,1,-1,1] → sum d^2 = 4 → Spearman = 1 - 6*4/(5*(25-1)) = 1 - 24/120 = 0.8
  {
    const r = spearmanCorrelation([1, 2, 3, 4, 5], [1, 3, 2, 5, 4]) as number;
    expectClose('known value 0.8', r, 0.8, 1e-9);
  }
  // 异常值不影响 rank-based（与 Pearson 差异验证）：x=[1,2,3,100], y=[1,2,3,4]
  // Spearman = 1.0 (rank 单调对齐), Pearson 也是 1.0 (因都是 R^2 = 1)，
  // 但 x=[1,2,3,100], y=[1,2,3,1] (4 个点中 3 个完美 + 1 个反转) →
  // rank x = [1,2,3,4], rank y = [1.5,3,4,1.5] -> 不完全相关
  {
    // x = [1,2,3,4,100]; y = [10,20,30,40,50]: 完全单调，Spearman=1，无视 100 异常值
    const r = spearmanCorrelation([1, 2, 3, 4, 100], [10, 20, 30, 40, 50]) as number;
    expectClose('outlier x does not break Spearman', r, 1.0, 1e-9);
  }
  // tie 处理：x=[1,2,2,3], y=[10,20,20,30] → rank x=[1,2.5,2.5,4] = rank y → corr=1
  {
    const r = spearmanCorrelation([1, 2, 2, 3], [10, 20, 20, 30]) as number;
    expectClose('tie-aligned → corr=1', r, 1.0, 1e-9);
  }
  // 完全独立：x=[1,2,3,4,5,6,7,8], y=[3,1,4,1,5,9,2,6] (近随机)
  {
    const r = spearmanCorrelation(
      [1, 2, 3, 4, 5, 6, 7, 8],
      [3, 1, 4, 1, 5, 9, 2, 6]
    ) as number;
    assert('quasi-random has |r| < 0.8', Math.abs(r) < 0.8, `got r=${r}`);
  }
  // 6 元素已知 Spearman = 1 (perfect)
  expectClose(
    '6-elem perfect',
    spearmanCorrelation([1, 2, 3, 4, 5, 6], [2, 4, 6, 8, 10, 12]) as number,
    1.0,
    1e-9
  );
  // 顺序敏感：同样的 (x,y) 集合，y 顺序打乱后相关性变化
  {
    const r1 = spearmanCorrelation([1, 2, 3, 4], [4, 3, 2, 1]) as number;
    const r2 = spearmanCorrelation([1, 2, 3, 4], [1, 4, 2, 3]) as number;
    assert('order matters: r1 != r2', Math.abs(r1 - r2) > 0.1);
  }
  // 2 元素：完美正相关
  expectClose(
    '2-elem positive',
    spearmanCorrelation([1, 2], [10, 20]) as number,
    1.0
  );
  // 2 元素：完美负相关
  expectClose(
    '2-elem negative',
    spearmanCorrelation([1, 2], [20, 10]) as number,
    -1.0
  );
}

function runMeanStddevTests() {
  console.log('\n## mean / sampleStddev');
  // mean 边角
  expectEqual('mean empty → null', mean([]), null);
  expectClose('mean single → that value', mean([42]) as number, 42);
  expectClose('mean 3 elements', mean([1, 2, 3]) as number, 2);
  expectClose('mean NaN filtered', mean([1, NaN, 2, 3, Infinity]) as number, 2);
  expectClose('mean negative', mean([-1, 1]) as number, 0);
  expectEqual('mean all NaN → null', mean([NaN, Infinity]), null);

  // sampleStddev 边角
  expectEqual('stddev empty → null', sampleStddev([]), null);
  expectEqual('stddev single → null', sampleStddev([42]), null);
  expectEqual('stddev all equal → 0', sampleStddev([5, 5, 5]), 0);
  // n-1 公式: [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, ss=32 → var=32/7≈4.571 → std≈2.138
  expectClose(
    'stddev sample formula',
    sampleStddev([2, 4, 4, 4, 5, 5, 7, 9]) as number,
    Math.sqrt(32 / 7),
    1e-6
  );
  // 含 NaN 过滤后剩 2 个
  expectClose(
    'stddev NaN filtered',
    sampleStddev([1, NaN, 3, Infinity]) as number,
    Math.sqrt(2),
    1e-6
  );
  expectEqual('stddev all NaN → null', sampleStddev([NaN, Infinity]), null);
}

function runAggregateICSeriesTests() {
  console.log('\n## aggregateICSeries');
  // 空 → all null
  {
    const stats = aggregateICSeries([]);
    expectEqual('empty: ic_mean null', stats.ic_mean, null);
    expectEqual('empty: ic_std null', stats.ic_std, null);
    expectEqual('empty: ic_ir null', stats.ic_ir, null);
    expectEqual('empty: ic_positive_ratio null', stats.ic_positive_ratio, null);
    expectEqual('empty: sample_count 0', stats.sample_count, 0);
    expectEqual('empty: universe_avg_size 0', stats.universe_avg_size, 0);
  }
  // 全 null IC → all null
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: null, effective_size: 5 },
      { trade_date: '2024-01-02', ic: null, effective_size: 0 },
    ]);
    expectEqual('all null: sample_count 0', stats.sample_count, 0);
    expectEqual('all null: ic_mean null', stats.ic_mean, null);
  }
  // 单日 IC → mean 该值，std null，ir null
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: 0.05, effective_size: 100 },
    ]);
    expectEqual('single: sample_count 1', stats.sample_count, 1);
    expectClose('single: mean 0.05', stats.ic_mean as number, 0.05);
    expectEqual('single: std null', stats.ic_std, null);
    expectEqual('single: ir null', stats.ic_ir, null);
    expectClose('single: positive_ratio 1', stats.ic_positive_ratio as number, 1);
    expectEqual('single: avg_universe 100', stats.universe_avg_size, 100);
  }
  // 两日 ic_std=0 → ir null
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: 0.1, effective_size: 50 },
      { trade_date: '2024-01-02', ic: 0.1, effective_size: 50 },
    ]);
    expectEqual('std 0: ir null', stats.ic_ir, null);
    expectClose('std 0: mean 0.1', stats.ic_mean as number, 0.1);
    expectEqual('std 0: std 0', stats.ic_std, 0);
  }
  // 多日，全部正 → positive_ratio = 1
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: 0.1, effective_size: 100 },
      { trade_date: '2024-01-02', ic: 0.05, effective_size: 90 },
      { trade_date: '2024-01-03', ic: 0.02, effective_size: 110 },
    ]);
    expectClose('all positive: ratio 1', stats.ic_positive_ratio as number, 1);
    expectClose('all positive: avg_univ 100', stats.universe_avg_size, 100);
    expectClose(
      'all positive: mean ≈ 0.0567',
      stats.ic_mean as number,
      (0.1 + 0.05 + 0.02) / 3
    );
  }
  // 全负 → positive_ratio = 0
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: -0.1, effective_size: 100 },
      { trade_date: '2024-01-02', ic: -0.05, effective_size: 100 },
    ]);
    expectClose('all negative: ratio 0', stats.ic_positive_ratio as number, 0);
  }
  // 混合，IC=0 算 not positive（严格 > 0）
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: 0.1, effective_size: 50 },
      { trade_date: '2024-01-02', ic: 0, effective_size: 50 },
      { trade_date: '2024-01-03', ic: -0.1, effective_size: 50 },
      { trade_date: '2024-01-04', ic: 0.05, effective_size: 50 },
    ]);
    expectClose('mixed: ratio 2/4 = 0.5', stats.ic_positive_ratio as number, 0.5);
  }
  // IC = null 不进入聚合
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: 0.1, effective_size: 50 },
      { trade_date: '2024-01-02', ic: null, effective_size: 0 },
      { trade_date: '2024-01-03', ic: 0.2, effective_size: 70 },
    ]);
    expectEqual('null skipped: sample_count 2', stats.sample_count, 2);
    expectClose('null skipped: mean 0.15', stats.ic_mean as number, 0.15);
    expectClose('null skipped: avg_univ 60', stats.universe_avg_size, 60);
  }
  // 已知 mean+std 精确
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: 0.1, effective_size: 100 },
      { trade_date: '2024-01-02', ic: 0.2, effective_size: 100 },
      { trade_date: '2024-01-03', ic: 0.3, effective_size: 100 },
    ]);
    expectClose('mean 0.2', stats.ic_mean as number, 0.2);
    // sample std of [0.1, 0.2, 0.3] = sqrt(0.02/2) = sqrt(0.01) = 0.1
    expectClose('std 0.1', stats.ic_std as number, 0.1, 1e-9);
    // ir = 0.2 / 0.1 = 2.0
    expectClose('ir 2.0', stats.ic_ir as number, 2.0, 1e-9);
  }
  // NaN IC 也算 invalid 跳过
  {
    const stats = aggregateICSeries([
      { trade_date: '2024-01-01', ic: NaN as any, effective_size: 0 },
      { trade_date: '2024-01-02', ic: 0.1, effective_size: 100 },
    ]);
    expectEqual('NaN skipped: sample_count 1', stats.sample_count, 1);
  }
}

// ============================================================
// Fake DataSource for end-to-end tests
// ============================================================

interface FakeDataConfig {
  trade_dates?: string[];
  /** factor_name → trade_date → Map<stock_code, z_score> */
  cross_sections?: Record<string, Record<string, Map<string, number>>>;
  /** trade_date → forward_days → Map<stock_code, return> */
  forward_returns?: Record<string, Record<number, Map<string, number>>>;
}

class FakeFactorICDataSource implements FactorICDataSource {
  constructor(private cfg: FakeDataConfig = {}) {}

  async loadTradeDatesInRange(
    factor_name: string,
    start: string,
    end: string
  ): Promise<string[]> {
    const all = this.cfg.trade_dates ?? [];
    return all.filter(d => d >= start && d <= end).sort();
  }

  async loadFactorCrossSection(
    factor_name: string,
    trade_date: string
  ): Promise<Map<string, number>> {
    const byFactor = this.cfg.cross_sections?.[factor_name];
    if (!byFactor) return new Map();
    const m = byFactor[trade_date];
    return m ? new Map(m) : new Map();
  }

  async loadForwardReturns(
    stock_codes: string[],
    base_date: string,
    forward_days: number
  ): Promise<Map<string, number>> {
    const byDate = this.cfg.forward_returns?.[base_date];
    if (!byDate) return new Map();
    const byFwd = byDate[forward_days];
    if (!byFwd) return new Map();
    const out = new Map<string, number>();
    for (const code of stock_codes) {
      const r = byFwd.get(code);
      if (r !== undefined) out.set(code, r);
    }
    return out;
  }
}

/**
 * 构造一个能凑 ≥ MIN_CROSS_SECTION_SIZE (30) 的横截面 + 配套 forward returns，
 * 让 IC 严格正相关（z_score 与 forward return 线性同序）。
 */
function makeCorrelatedCrossSection(
  size = 35
): { z: Map<string, number>; r: Map<string, number> } {
  const z = new Map<string, number>();
  const r = new Map<string, number>();
  for (let i = 0; i < size; i += 1) {
    const code = `S${String(i).padStart(4, '0')}`;
    const zVal = (i - size / 2) / 10; // -1.75..+1.75 范围
    z.set(code, zVal);
    r.set(code, zVal * 0.1 + 0.001); // 严格线性同序 → IC ≈ 1
  }
  return { z, r };
}

function makeAnticorrelatedCrossSection(
  size = 35
): { z: Map<string, number>; r: Map<string, number> } {
  const z = new Map<string, number>();
  const r = new Map<string, number>();
  for (let i = 0; i < size; i += 1) {
    const code = `S${String(i).padStart(4, '0')}`;
    const zVal = (i - size / 2) / 10;
    z.set(code, zVal);
    r.set(code, -zVal * 0.1 + 0.001); // 严格线性反向 → IC ≈ -1
  }
  return { z, r };
}

function makeSmallCrossSection(size = 5): { z: Map<string, number>; r: Map<string, number> } {
  const z = new Map<string, number>();
  const r = new Map<string, number>();
  for (let i = 0; i < size; i += 1) {
    const code = `S${i}`;
    z.set(code, i);
    r.set(code, i * 0.1);
  }
  return { z, r };
}

// ============================================================
// End-to-end generate() tests
// ============================================================

async function testHappyPathSingleWindow() {
  console.log('\n## end-to-end — happy path 单因子单窗口');
  const report = new FactorICReport();
  const { z, r } = makeCorrelatedCrossSection(35);
  const cfg: FakeDataConfig = {
    trade_dates: ['2024-01-01', '2024-01-02', '2024-01-03'],
    cross_sections: {
      value: {
        '2024-01-01': z,
        '2024-01-02': z,
        '2024-01-03': z,
      },
    },
    forward_returns: {
      '2024-01-01': { 1: r },
      '2024-01-02': { 1: r },
      '2024-01-03': { 1: r },
    },
  };

  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2024-12-31',
      look_forward_days_list: [1],
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );

  expectEqual('factor_name carried', out.factor_name, 'value');
  expectEqual('one window result', out.results_by_window.length, 1);
  expectEqual('lookForward = 1', out.results_by_window[0].look_forward_days, 1);
  // 严格线性同序 → IC = 1
  const stats = out.results_by_window[0].statistics;
  expectClose('ic_mean = 1', stats.ic_mean as number, 1.0, 1e-9);
  expectEqual('sample_count 3', stats.sample_count, 3);
  expectEqual('ic_positive_ratio 1', stats.ic_positive_ratio as number, 1);
  expectEqual('ic_std 0', stats.ic_std, 0);
  expectEqual('ic_ir null (std=0)', stats.ic_ir, null);
  expectEqual('upserted_count 0 (persist=false)', out.upserted_count, 0);
  assert('duration_ms ≥ 0', out.duration_ms >= 0);
}

async function testHappyPathMultiWindow() {
  console.log('\n## end-to-end — 多窗口 [1,5,10,20,60] 全部跑完');
  const report = new FactorICReport();
  const { z, r } = makeCorrelatedCrossSection(35);
  const { r: rAnti } = makeAnticorrelatedCrossSection(35);

  // 5 个交易日 + 各窗口设不同 forward returns 让 IC 衰减可观测
  const tradeDates = [
    '2024-01-01',
    '2024-01-02',
    '2024-01-03',
    '2024-01-04',
    '2024-01-05',
  ];
  const cross: Record<string, Map<string, number>> = {};
  for (const d of tradeDates) cross[d] = z;

  const forwardReturns: Record<string, Record<number, Map<string, number>>> = {};
  for (const d of tradeDates) {
    forwardReturns[d] = {
      1: r, // 强同序
      5: r, // 仍强
      10: rAnti, // 反转
      20: rAnti,
      60: rAnti,
    };
  }

  const cfg: FakeDataConfig = {
    trade_dates: tradeDates,
    cross_sections: { value: cross },
    forward_returns: forwardReturns,
  };

  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2099-12-31', // 远未来防 lookahead guard 切断
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );

  expectEqual('5 windows', out.results_by_window.length, 5);
  expectEqual(
    'all default windows',
    out.results_by_window.map(w => w.look_forward_days),
    Array.from(DEFAULT_LOOK_FORWARD_DAYS)
  );
  // 1d / 5d 应 ≈ 1
  expectClose(
    'lf=1d ic_mean ≈ 1',
    out.results_by_window[0].statistics.ic_mean as number,
    1.0,
    1e-9
  );
  expectClose(
    'lf=5d ic_mean ≈ 1',
    out.results_by_window[1].statistics.ic_mean as number,
    1.0,
    1e-9
  );
  // 10d / 20d / 60d 应 ≈ -1
  expectClose(
    'lf=10d ic_mean ≈ -1',
    out.results_by_window[2].statistics.ic_mean as number,
    -1.0,
    1e-9
  );
  expectClose(
    'lf=60d ic_mean ≈ -1',
    out.results_by_window[4].statistics.ic_mean as number,
    -1.0,
    1e-9
  );
}

async function testLookaheadBiasGuard() {
  console.log('\n## end-to-end — lookahead bias guard');
  const report = new FactorICReport();
  const { z, r } = makeCorrelatedCrossSection(35);
  const tradeDates = [
    '2024-01-01',
    '2024-01-02',
    '2024-01-03',
    '2024-01-04',
  ];
  const cross: Record<string, Map<string, number>> = {};
  for (const d of tradeDates) cross[d] = z;

  const forwardReturns: Record<string, Record<number, Map<string, number>>> = {};
  // 给所有日期都有 5d forward return
  for (const d of tradeDates) {
    forwardReturns[d] = { 5: r };
  }

  const cfg: FakeDataConfig = {
    trade_dates: tradeDates,
    cross_sections: { value: cross },
    forward_returns: forwardReturns,
  };

  // end_date = 2024-01-04，lookForward = 5 (≈ 8 自然日)
  // base_date + 5*1.5 = base_date + 8 自然日
  // 2024-01-01 + 8d = 2024-01-09 > 2024-01-04 → 跳过
  // 2024-01-02 + 8d = 2024-01-10 > 2024-01-04 → 跳过 ... 全部跳过
  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2024-01-04',
      look_forward_days_list: [5],
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );

  const w = out.results_by_window[0];
  expectEqual('lookahead all skipped: sample_count 0', w.statistics.sample_count, 0);
  expectEqual(
    'lookahead all skipped: all daily_ics null',
    w.daily_ics.every(d => d.ic === null),
    true
  );
  // 所有日的 reason 都包含 lookahead
  expectEqual(
    'lookahead all skipped: reason set',
    w.daily_ics.every(d => d.reason?.includes('lookahead')),
    true
  );
}

async function testInsufficientCrossSection() {
  console.log('\n## end-to-end — 横截面 < MIN_CROSS_SECTION_SIZE 该日跳过');
  const report = new FactorICReport();
  // 小横截面 (5 只股票 < 30)
  const small = makeSmallCrossSection(5);
  const tradeDates = ['2024-01-01', '2024-01-02', '2024-01-03'];
  const cross: Record<string, Map<string, number>> = {};
  for (const d of tradeDates) cross[d] = small.z;

  const forwardReturns: Record<string, Record<number, Map<string, number>>> = {};
  for (const d of tradeDates) forwardReturns[d] = { 1: small.r };

  const cfg: FakeDataConfig = {
    trade_dates: tradeDates,
    cross_sections: { value: cross },
    forward_returns: forwardReturns,
  };

  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2099-12-31',
      look_forward_days_list: [1],
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );

  const w = out.results_by_window[0];
  expectEqual('small cross_section: sample_count 0', w.statistics.sample_count, 0);
  expectEqual(
    'small cross_section: reason indicates MIN',
    w.daily_ics.every(d => d.reason?.includes('cross_section_lt_min')),
    true
  );
}

async function testEmptyTradeDates() {
  console.log('\n## end-to-end — 全区间无 trade_dates');
  const report = new FactorICReport();
  const cfg: FakeDataConfig = {
    trade_dates: [],
    cross_sections: {},
    forward_returns: {},
  };

  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2099-12-31',
      look_forward_days_list: [1],
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );

  expectEqual('1 window result', out.results_by_window.length, 1);
  expectEqual(
    'empty trade_dates: sample_count 0',
    out.results_by_window[0].statistics.sample_count,
    0
  );
  expectEqual('upserted 0', out.upserted_count, 0);
}

async function testCustomWindowsOverride() {
  console.log('\n## end-to-end — 自定义 windows override');
  const report = new FactorICReport();
  const { z, r } = makeCorrelatedCrossSection(35);
  const tradeDates = ['2024-01-01', '2024-01-02'];
  const cross: Record<string, Map<string, number>> = {};
  for (const d of tradeDates) cross[d] = z;
  const forwardReturns: Record<string, Record<number, Map<string, number>>> = {};
  for (const d of tradeDates) forwardReturns[d] = { 3: r, 7: r };

  const cfg: FakeDataConfig = {
    trade_dates: tradeDates,
    cross_sections: { value: cross },
    forward_returns: forwardReturns,
  };

  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2099-12-31',
      look_forward_days_list: [3, 7],
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );

  expectEqual('2 windows', out.results_by_window.length, 2);
  expectEqual('custom lf 3', out.results_by_window[0].look_forward_days, 3);
  expectEqual('custom lf 7', out.results_by_window[1].look_forward_days, 7);
}

async function testFactorNotRegisteredNoDataSource() {
  console.log('\n## end-to-end — factor 未注册 + 未注入 DataSource → 抛错');
  const report = new FactorICReport();
  await expectThrowAsync(
    'unregistered + no source → throws',
    () =>
      report.generate({
        factor_name: 'nonexistent_factor_xyz',
        start_date: '2024-01-01',
        end_date: '2025-01-01',
      }),
    'not registered'
  );
}

async function testFactorNotRegisteredWithDataSource() {
  console.log('\n## end-to-end — factor 未注册 + 注入 DataSource → 不抛错（fake mode）');
  const report = new FactorICReport();
  const cfg: FakeDataConfig = {
    trade_dates: [],
    cross_sections: {},
    forward_returns: {},
  };
  // 不应抛错
  const out = await report.generate(
    {
      factor_name: 'fake_factor_for_test',
      start_date: '2024-01-01',
      end_date: '2024-12-31',
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );
  expectEqual('completes despite unregistered name', out.factor_name, 'fake_factor_for_test');
}

async function testStartEqualEndThrows() {
  console.log('\n## end-to-end — start >= end 抛错');
  const report = new FactorICReport();
  await expectThrowAsync(
    'start == end throws',
    () =>
      report.generate(
        { factor_name: 'x', start_date: '2024-01-01', end_date: '2024-01-01' },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'must be <'
  );
  await expectThrowAsync(
    'start > end throws',
    () =>
      report.generate(
        { factor_name: 'x', start_date: '2024-06-01', end_date: '2024-01-01' },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'must be <'
  );
}

async function testLookForwardZeroThrows() {
  console.log('\n## end-to-end — lookForwardDays ≤ 0 抛错');
  const report = new FactorICReport();
  await expectThrowAsync(
    'lookForward 0 throws',
    () =>
      report.generate(
        {
          factor_name: 'x',
          start_date: '2024-01-01',
          end_date: '2024-12-31',
          look_forward_days_list: [0],
        },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'positive integer'
  );
  await expectThrowAsync(
    'lookForward -1 throws',
    () =>
      report.generate(
        {
          factor_name: 'x',
          start_date: '2024-01-01',
          end_date: '2024-12-31',
          look_forward_days_list: [-1],
        },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'positive integer'
  );
  await expectThrowAsync(
    'lookForward 1.5 throws',
    () =>
      report.generate(
        {
          factor_name: 'x',
          start_date: '2024-01-01',
          end_date: '2024-12-31',
          look_forward_days_list: [1.5],
        },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'positive integer'
  );
}

async function testEmptyLookForwardListThrows() {
  console.log('\n## end-to-end — 空 lookForwardDays 列表抛错');
  const report = new FactorICReport();
  await expectThrowAsync(
    'empty list throws',
    () =>
      report.generate(
        {
          factor_name: 'x',
          start_date: '2024-01-01',
          end_date: '2024-12-31',
          look_forward_days_list: [],
        },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'cannot be empty'
  );
}

async function testInvalidDateFormatThrows() {
  console.log('\n## end-to-end — 非法日期格式抛错');
  const report = new FactorICReport();
  await expectThrowAsync(
    'start_date 非 ISO 抛',
    () =>
      report.generate(
        { factor_name: 'x', start_date: '2024/01/01', end_date: '2024-12-31' },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'invalid start_date'
  );
  await expectThrowAsync(
    'end_date 非 ISO 抛',
    () =>
      report.generate(
        { factor_name: 'x', start_date: '2024-01-01', end_date: '20241231' },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'invalid end_date'
  );
}

async function testMissingFactorNameThrows() {
  console.log('\n## end-to-end — 缺 factor_name 抛错');
  const report = new FactorICReport();
  await expectThrowAsync(
    'empty factor_name throws',
    () =>
      report.generate(
        { factor_name: '', start_date: '2024-01-01', end_date: '2024-12-31' },
        { persist: false, data_source: new FakeFactorICDataSource() }
      ),
    'factor_name is required'
  );
}

async function testPeriodStartEndFields() {
  console.log('\n## end-to-end — period_start/period_end 取自 valid IC 日期');
  const report = new FactorICReport();
  const { z, r } = makeCorrelatedCrossSection(35);
  const tradeDates = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'];
  const cross: Record<string, Map<string, number>> = {};
  for (const d of tradeDates) cross[d] = z;

  // 第 1、4 日有 forward return；中间 2 日没有
  const forwardReturns: Record<string, Record<number, Map<string, number>>> = {
    '2024-01-01': { 1: r },
    '2024-01-04': { 1: r },
  };

  const cfg: FakeDataConfig = {
    trade_dates: tradeDates,
    cross_sections: { value: cross },
    forward_returns: forwardReturns,
  };

  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2099-12-31',
      look_forward_days_list: [1],
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );

  const w = out.results_by_window[0];
  expectEqual('period_start = first valid', w.period_start, '2024-01-01');
  expectEqual('period_end = last valid', w.period_end, '2024-01-04');
  expectEqual('sample_count 2', w.statistics.sample_count, 2);
}

async function testStrictlyMonotonicForwardReturnGivesIC1() {
  console.log('\n## end-to-end — 严格单调一致 forward → IC=1');
  const report = new FactorICReport();
  // 35 只股票，z_score 与 forward return 完全单调一致
  const z = new Map<string, number>();
  const r = new Map<string, number>();
  for (let i = 0; i < 35; i += 1) {
    const code = `S${String(i).padStart(4, '0')}`;
    z.set(code, Math.random() - 0.5); // 任意 z (即便随机也可以)
  }
  // 给 r 与 z 同序
  const sorted = Array.from(z.entries()).sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < sorted.length; i += 1) {
    r.set(sorted[i][0], i * 0.001 + 0.01);
  }
  const cfg: FakeDataConfig = {
    trade_dates: ['2024-01-01'],
    cross_sections: { value: { '2024-01-01': z } },
    forward_returns: { '2024-01-01': { 1: r } },
  };
  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2099-12-31',
      look_forward_days_list: [1],
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );
  expectClose(
    'strictly monotonic → IC=1',
    out.results_by_window[0].statistics.ic_mean as number,
    1.0,
    1e-9
  );
}

async function testMixedICSeriesAggregation() {
  console.log('\n## end-to-end — 混合正负 IC 时序聚合统计');
  const report = new FactorICReport();
  const tradeDates = [
    '2024-01-01',
    '2024-01-02',
    '2024-01-03',
    '2024-01-04',
    '2024-01-05',
  ];
  const cfg: FakeDataConfig = {
    trade_dates: tradeDates,
    cross_sections: { value: {} },
    forward_returns: {},
  };
  // 5 天交替正反相关
  const { z, r: rPos } = makeCorrelatedCrossSection(35);
  const { r: rNeg } = makeAnticorrelatedCrossSection(35);
  for (let i = 0; i < tradeDates.length; i += 1) {
    const d = tradeDates[i];
    cfg.cross_sections!.value[d] = z;
    // 第 1/3/5 天正相关; 第 2/4 天负相关
    cfg.forward_returns![d] = { 1: i % 2 === 0 ? rPos : rNeg };
  }

  const out = await report.generate(
    {
      factor_name: 'value',
      start_date: '2024-01-01',
      end_date: '2099-12-31',
      look_forward_days_list: [1],
    },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );

  const w = out.results_by_window[0];
  expectEqual('sample_count 5', w.statistics.sample_count, 5);
  // 3 个 +1 + 2 个 -1 → mean = (3-2)/5 = 0.2
  expectClose('mean = 0.2', w.statistics.ic_mean as number, 0.2, 1e-9);
  // positive ratio = 3/5 = 0.6
  expectClose('positive ratio 0.6', w.statistics.ic_positive_ratio as number, 0.6, 1e-9);
  // std > 0 → ir 可计算
  assert('ic_std > 0', (w.statistics.ic_std as number) > 0);
  assert('ic_ir finite', Number.isFinite(w.statistics.ic_ir as number));
}

async function testRealFactorNameAccepted() {
  console.log('\n## end-to-end — 真实注册的因子名（library 已 import 自我登记）');
  // 任选一个已注册的因子（例如 'value'），不传 data_source，但用 empty 配置让它
  // 不需要查真实 DB；通过用 fake data_source 但 factor_name 是真实注册名验证两边路径。
  if (!factorRegistry.has('value')) {
    console.log('  skip (value not in registry — library import 出问题了?)');
    return;
  }
  const report = new FactorICReport();
  const cfg: FakeDataConfig = { trade_dates: [] };
  const out = await report.generate(
    { factor_name: 'value', start_date: '2024-01-01', end_date: '2024-12-31' },
    { persist: false, data_source: new FakeFactorICDataSource(cfg) }
  );
  expectEqual('value factor accepted', out.factor_name, 'value');
}

async function testDefaultPersistTrueButFakeSourceFineCases() {
  console.log('\n## end-to-end — persist 默认 true 但 sample_count=0 时跳过写库');
  // 因为 fake DataSource 让 sample_count = 0，persistResult 不被调用，
  // 即使 persist=true（默认）也不会去 DB。这是 by design 防止空统计污染表。
  const report = new FactorICReport();
  const cfg: FakeDataConfig = { trade_dates: [] };
  const out = await report.generate(
    { factor_name: 'value', start_date: '2024-01-01', end_date: '2024-12-31' },
    { data_source: new FakeFactorICDataSource(cfg) } // persist 默认 true
  );
  expectEqual('upserted 0 because sample_count=0', out.upserted_count, 0);
}

async function testConstants() {
  console.log('\n## constants exported');
  expectEqual(
    'DEFAULT_LOOK_FORWARD_DAYS exact',
    Array.from(DEFAULT_LOOK_FORWARD_DAYS),
    [1, 5, 10, 20, 60]
  );
  expectEqual('MIN_CROSS_SECTION_SIZE = 30', MIN_CROSS_SECTION_SIZE, 30);
}

// ============================================================
// main
// ============================================================

async function main() {
  console.log('Running FactorICReport tests (US-041)...');

  runRankAscendingTests();
  runSpearmanTests();
  runMeanStddevTests();
  runAggregateICSeriesTests();

  await testHappyPathSingleWindow();
  await testHappyPathMultiWindow();
  await testLookaheadBiasGuard();
  await testInsufficientCrossSection();
  await testEmptyTradeDates();
  await testCustomWindowsOverride();
  await testFactorNotRegisteredNoDataSource();
  await testFactorNotRegisteredWithDataSource();
  await testStartEqualEndThrows();
  await testLookForwardZeroThrows();
  await testEmptyLookForwardListThrows();
  await testInvalidDateFormatThrows();
  await testMissingFactorNameThrows();
  await testPeriodStartEndFields();
  await testStrictlyMonotonicForwardReturnGivesIC1();
  await testMixedICSeriesAggregation();
  await testRealFactorNameAccepted();
  await testDefaultPersistTrueButFakeSourceFineCases();
  await testConstants();

  console.log(`\n${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test runner failed:', err);
  process.exit(2);
});
