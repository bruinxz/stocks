/**
 * FactorDetailService 单元测试 (US-094)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/factor-detail-service.test.ts
 *
 * 完全脱离 DB：注入 fake FactorDetailDataSource。
 *
 * 覆盖维度：
 *   纯函数：
 *     - splitIntoQuintiles：空 / 单元素 / 5 整除 / 余数 / ties / 稳定排序 / 数字异常
 *     - quintileAverageReturn：单桶空 / 全缺 return / 混合存在 / 桶不存在
 *     - accumulateNetValue：空 / 单元素 / 全 0 / 涨跌混合 / 浮点精度
 *     - buildQuintileTimeSeries：长度对齐 / 全空 / 长度不一致抛错
 *     - formatTradeDate：YYYY-MM-DD / ISO / Date / null / 非法字符串
 *     - clampLimitDays / clampICLimit：边界 / 默认 / 上下限 / 非整数
 *   end-to-end getDetail()：
 *     - happy path：3 日 cross-section + 桶分配 + 净值累乘
 *     - factor_name 未注册 + 未注入 DataSource → 抛错
 *     - factor_name 未注册 + 注入 DataSource → 不抛错（绕过 registry 校验，description=''）
 *     - 空 trade_dates → 返回 note + 空 quintile_curves
 *     - 所有日 cross-section < MIN → effective_trade_days=0 + note
 *     - IC history empty → ic_history=[] 不报错
 *     - limit_days clamp（传 -1 / 300 / NaN）
 */

import {
  FactorDetailService,
  FactorDetailDataSource,
  ICHistoryPoint,
  Quintile,
  splitIntoQuintiles,
  quintileAverageReturn,
  accumulateNetValue,
  buildQuintileTimeSeries,
  formatTradeDate,
  clampLimitDays,
  clampICLimit,
  DEFAULT_DETAIL_TRADE_DAYS,
  MAX_DETAIL_TRADE_DAYS,
  DEFAULT_IC_HISTORY_LIMIT,
  MIN_QUINTILE_CROSS_SECTION,
} from '../../src/quant/factors/FactorDetailService';
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
// 纯函数 helpers
// ============================================================

function runSplitIntoQuintilesTests() {
  console.log('\n## splitIntoQuintiles');
  // 空入 → 空出
  expectEqual('empty map → empty', splitIntoQuintiles(new Map()), new Map());

  // 单 stock 全放最后桶？规则：n=1, base=0, remainder=1, sizes=[1,0,0,0,0] → Q1
  const single = splitIntoQuintiles(new Map([['600519', 1.0]]));
  expectEqual('single stock → Q1', single.get('600519'), 1);

  // 5 整除：10 只股票 → 每桶 2 只
  const ten = new Map<string, number>();
  for (let i = 0; i < 10; i += 1) ten.set(`60050${i}`, i * 1.0); // z = 0..9 升序
  const tenQ = splitIntoQuintiles(ten);
  expectEqual('n=10 Q1 contains 600500', tenQ.get('600500'), 1);
  expectEqual('n=10 Q1 contains 600501', tenQ.get('600501'), 1);
  expectEqual('n=10 Q5 contains 600508', tenQ.get('600508'), 5);
  expectEqual('n=10 Q5 contains 600509', tenQ.get('600509'), 5);
  expectEqual('n=10 Q3 contains 600504', tenQ.get('600504'), 3);
  // 桶大小分布
  const tenSizes = [1, 2, 3, 4, 5].map(q => Array.from(tenQ.values()).filter(v => v === q).length);
  expectEqual('n=10 sizes [2,2,2,2,2]', tenSizes, [2, 2, 2, 2, 2]);

  // 有余数：n=23 → base=4 remainder=3 → sizes=[5,5,5,4,4]
  const map23 = new Map<string, number>();
  for (let i = 0; i < 23; i += 1) map23.set(String(600500 + i), i * 0.1);
  const q23 = splitIntoQuintiles(map23);
  const sizes23 = [1, 2, 3, 4, 5].map(q => Array.from(q23.values()).filter(v => v === q).length);
  expectEqual('n=23 sizes [5,5,5,4,4]', sizes23, [5, 5, 5, 4, 4]);

  // ties：同 z_score 按 stock_code 升序 stable
  const ties = new Map<string, number>([
    ['600600', 1.0],
    ['600500', 1.0], // tie with 600600
    ['600700', 2.0],
    ['600400', 0.5],
    ['600300', 0.5], // tie with 600400
  ]);
  const tQ = splitIntoQuintiles(ties);
  // 排序后：600300(0.5), 600400(0.5), 600500(1.0), 600600(1.0), 600700(2.0)
  // n=5 base=1 remainder=0 → 每桶 1
  expectEqual('tie Q1', tQ.get('600300'), 1);
  expectEqual('tie Q2', tQ.get('600400'), 2);
  expectEqual('tie Q3', tQ.get('600500'), 3);
  expectEqual('tie Q4', tQ.get('600600'), 4);
  expectEqual('tie Q5', tQ.get('600700'), 5);

  // 数字异常：NaN/Infinity 应被过滤
  const dirty = new Map<string, number>([
    ['600100', NaN],
    ['600200', Infinity],
    ['600300', -Infinity],
    ['600400', 1.0],
    ['600500', 2.0],
  ]);
  const dirtyQ = splitIntoQuintiles(dirty);
  expectEqual('dirty size = 2', dirtyQ.size, 2);
  expectEqual('NaN filtered (no key)', dirtyQ.has('600100'), false);
  expectEqual('+Inf filtered (no key)', dirtyQ.has('600200'), false);
  expectEqual('-Inf filtered (no key)', dirtyQ.has('600300'), false);
}

function runQuintileAverageReturnTests() {
  console.log('\n## quintileAverageReturn');
  const qm = new Map<string, Quintile>([
    ['600100', 1],
    ['600200', 1],
    ['600300', 3],
    ['600400', 5],
    ['600500', 5],
  ]);
  const rm = new Map<string, number>([
    ['600100', 0.01],
    ['600200', 0.03],
    ['600300', -0.02],
    ['600400', 0.05],
    ['600500', 0.07],
  ]);
  expectClose('Q1 avg (0.01+0.03)/2 = 0.02', quintileAverageReturn(qm, rm, 1), 0.02);
  expectClose('Q3 single = -0.02', quintileAverageReturn(qm, rm, 3), -0.02);
  expectClose('Q5 avg (0.05+0.07)/2 = 0.06', quintileAverageReturn(qm, rm, 5), 0.06);
  // 桶不存在
  expectEqual('Q2 not present → 0', quintileAverageReturn(qm, rm, 2), 0);
  expectEqual('Q4 not present → 0', quintileAverageReturn(qm, rm, 4), 0);
  // 桶里 stock 全缺 return → 0
  const incomplete = new Map<string, number>([['600999', 1.0]]); // 不在 qm 内
  expectEqual('return missing → 0', quintileAverageReturn(qm, incomplete, 1), 0);

  // 含 NaN 的 return 跳过
  const dirtyR = new Map<string, number>([
    ['600100', NaN],
    ['600200', 0.05],
  ]);
  expectClose('Q1 NaN ignored, avg = 0.05', quintileAverageReturn(qm, dirtyR, 1), 0.05);
}

function runAccumulateNetValueTests() {
  console.log('\n## accumulateNetValue');
  expectEqual('empty → []', accumulateNetValue([]), []);
  // 全 0 → 净值不变
  expectEqual('all zero → [1,1,1]', accumulateNetValue([0, 0, 0]), [1, 1, 1]);
  // 单步涨 1%
  expectEqual('single +1% → [1.01]', accumulateNetValue([0.01]), [1.01]);
  // 涨跌混合
  const mixed = accumulateNetValue([0.01, -0.02, 0.03]);
  expectClose('mixed step 1: 1.01', mixed[0], 1.01, 1e-5);
  expectClose('mixed step 2: 1.01*0.98 = 0.9898', mixed[1], 0.9898, 1e-5);
  expectClose('mixed step 3: 0.9898*1.03 ≈ 1.019494', mixed[2], 1.019494, 1e-5);
  // NaN 视为 0（safe）
  expectEqual('NaN safe → 1', accumulateNetValue([NaN])[0], 1.0);
  // 浮点精度：连续 100 个 +0.001 应稳定接近 e^0.1 ≈ 1.1051
  const longSeq = Array.from({ length: 100 }, () => 0.001);
  const longNV = accumulateNetValue(longSeq);
  expectClose('100 step +0.1% ≈ 1.1051', longNV[99], 1.1051, 1e-3);
}

function runBuildQuintileTimeSeriesTests() {
  console.log('\n## buildQuintileTimeSeries');
  // 2 日：第 1 日 Q1 +1% / Q5 +5%；第 2 日 Q1 -2% / Q5 +1%
  const day1Q = new Map<string, Quintile>([
    ['A', 1],
    ['B', 5],
  ]);
  const day1R = new Map<string, number>([
    ['A', 0.01],
    ['B', 0.05],
  ]);
  const day2Q = new Map<string, Quintile>([
    ['A', 1],
    ['B', 5],
  ]);
  const day2R = new Map<string, number>([
    ['A', -0.02],
    ['B', 0.01],
  ]);
  const series = buildQuintileTimeSeries([day1Q, day2Q], [day1R, day2R]);
  expectEqual('Q1 length 2', series.Q1.length, 2);
  expectEqual('Q5 length 2', series.Q5.length, 2);
  expectClose('Q1 day1: 1.01', series.Q1[0], 1.01);
  expectClose('Q1 day2: 1.01 * 0.98 = 0.9898', series.Q1[1], 0.9898, 1e-5);
  expectClose('Q5 day1: 1.05', series.Q5[0], 1.05);
  expectClose('Q5 day2: 1.05 * 1.01 = 1.0605', series.Q5[1], 1.0605, 1e-5);
  // 不参与桶（Q2/Q3/Q4）净值保持 1.0
  expectEqual('Q2 unchanged [1,1]', series.Q2, [1, 1]);
  expectEqual('Q3 unchanged [1,1]', series.Q3, [1, 1]);
  expectEqual('Q4 unchanged [1,1]', series.Q4, [1, 1]);

  // 全空
  const empty = buildQuintileTimeSeries([], []);
  expectEqual('empty Q1', empty.Q1, []);
  expectEqual('empty Q5', empty.Q5, []);

  // 长度不一致 → 抛错
  let threw = false;
  try {
    buildQuintileTimeSeries([day1Q], [day1R, day2R]);
  } catch {
    threw = true;
  }
  assert('length mismatch throws', threw);
}

function runFormatTradeDateTests() {
  console.log('\n## formatTradeDate');
  expectEqual('YYYY-MM-DD passthrough', formatTradeDate('2026-06-05'), '2026-06-05');
  expectEqual('ISO truncate', formatTradeDate('2026-06-05T15:30:00Z'), '2026-06-05');
  expectEqual('null → null', formatTradeDate(null), null);
  expectEqual('undefined → null', formatTradeDate(undefined), null);
  expectEqual('bad string → null', formatTradeDate('not-a-date'), null);
  // Date object
  const d = new Date('2026-06-05T00:00:00Z');
  expectEqual('Date → YYYY-MM-DD', formatTradeDate(d), '2026-06-05');
  // Invalid Date
  expectEqual('Invalid Date → null', formatTradeDate(new Date('bad')), null);
}

function runClampTests() {
  console.log('\n## clampLimitDays / clampICLimit');
  // limit_days defaults
  expectEqual('undefined → 120', clampLimitDays(undefined), DEFAULT_DETAIL_TRADE_DAYS);
  expectEqual('null → 120', clampLimitDays(null), DEFAULT_DETAIL_TRADE_DAYS);
  expectEqual('"" → 120', clampLimitDays(''), DEFAULT_DETAIL_TRADE_DAYS);
  expectEqual('valid 50 → 50', clampLimitDays(50), 50);
  expectEqual('string "100" → 100', clampLimitDays('100'), 100);
  expectEqual('over max → MAX', clampLimitDays(10000), MAX_DETAIL_TRADE_DAYS);
  expectEqual('zero → default', clampLimitDays(0), DEFAULT_DETAIL_TRADE_DAYS);
  expectEqual('negative → default', clampLimitDays(-5), DEFAULT_DETAIL_TRADE_DAYS);
  expectEqual('float 50.5 → default (not integer)', clampLimitDays(50.5), DEFAULT_DETAIL_TRADE_DAYS);
  expectEqual('NaN → default', clampLimitDays('abc'), DEFAULT_DETAIL_TRADE_DAYS);
  // ic_limit
  expectEqual('ic undefined → 60', clampICLimit(undefined), DEFAULT_IC_HISTORY_LIMIT);
  expectEqual('ic 30 → 30', clampICLimit(30), 30);
  expectEqual('ic over 200 → 200', clampICLimit(500), 200);
  expectEqual('ic zero → default', clampICLimit(0), DEFAULT_IC_HISTORY_LIMIT);
}

// ============================================================
// FakeDataSource for end-to-end tests
// ============================================================

class FakeDataSource implements FactorDetailDataSource {
  constructor(
    private readonly tradeDates: string[],
    private readonly crossSections: Map<string, Map<string, number>>,
    private readonly forwardReturns: Map<string, Map<string, number>>,
    private readonly icHistory: ICHistoryPoint[] = []
  ) {}

  async loadRecentTradeDates(_factor: string, limit: number): Promise<string[]> {
    // 返回最近 limit 个，按 ASC
    return this.tradeDates.slice(-limit);
  }

  async loadFactorCrossSection(_factor: string, date: string): Promise<Map<string, number>> {
    return this.crossSections.get(date) ?? new Map();
  }

  async loadForwardReturns(
    _codes: string[],
    base_date: string,
    _forward: number
  ): Promise<Map<string, number>> {
    return this.forwardReturns.get(base_date) ?? new Map();
  }

  async loadICHistory(_factor: string, _limit: number): Promise<ICHistoryPoint[]> {
    return this.icHistory;
  }
}

// ============================================================
// end-to-end getDetail() tests
// ============================================================

async function runGetDetailHappyPath() {
  console.log('\n## getDetail happy path');
  // 模拟一个 25-stock 横截面（>= MIN_QUINTILE_CROSS_SECTION），3 天
  const dates = ['2026-06-01', '2026-06-02', '2026-06-03'];
  const cross = new Map<string, Map<string, number>>();
  const fwd = new Map<string, Map<string, number>>();
  for (const date of dates) {
    const cs = new Map<string, number>();
    const fr = new Map<string, number>();
    for (let i = 0; i < 25; i += 1) {
      const code = `60010${String(i).padStart(2, '0')}`;
      cs.set(code, (i - 12) * 0.5); // z 从 -6 到 +6
      // Q5 (高 z) 拿 +2%，Q1 (低 z) 拿 -1%
      const ret = i < 5 ? -0.01 : i >= 20 ? 0.02 : 0.005;
      fr.set(code, ret);
    }
    cross.set(date, cs);
    fwd.set(date, fr);
  }
  const ds = new FakeDataSource(dates, cross, fwd, []);
  const service = new FactorDetailService();
  const detail = await service.getDetail('value', { data_source: ds, limit_days: 5 });

  expectEqual('name = value', detail.name, 'value');
  expectEqual('period_start = first', detail.period_start, '2026-06-01');
  expectEqual('period_end = last', detail.period_end, '2026-06-03');
  expectEqual('effective_trade_days = 3', detail.effective_trade_days, 3);
  expectEqual('quintile_curves length = 3', detail.quintile_curves.length, 3);
  // Q5 在 3 天 +2% → 净值 ≈ 1.06
  const lastQ5 = detail.quintile_curves[2].Q5;
  expectClose('Q5 ≈ 1.061208 after 3 days +2%', lastQ5, 1.061208, 1e-5);
  // Q1 在 3 天 -1% → 净值 ≈ 0.9703
  const lastQ1 = detail.quintile_curves[2].Q1;
  expectClose('Q1 ≈ 0.970299 after 3 days -1%', lastQ1, 0.970299, 1e-5);
  // Q3 中间组每天 +0.5% → 净值 ≈ 1.0150
  const lastQ3 = detail.quintile_curves[2].Q3;
  expectClose('Q3 ≈ 1.015075 after 3 days +0.5%', lastQ3, 1.015075, 1e-5);

  // 每行 trade_date 对应
  expectEqual('curve[0].date', detail.quintile_curves[0].trade_date, '2026-06-01');
  expectEqual('curve[2].date', detail.quintile_curves[2].trade_date, '2026-06-03');

  // note undefined when ok
  expectEqual('note undefined when ok', detail.note ?? null, null);

  // ic_history empty
  expectEqual('ic_history empty', detail.ic_history.length, 0);
}

async function runGetDetailMissingFactor() {
  console.log('\n## getDetail factor not registered');
  const service = new FactorDetailService();
  // 不注入 DataSource — 会走 registry.has 检查
  await expectThrowAsync(
    'no DS + unknown factor → throw',
    () => service.getDetail('definitely_not_a_real_factor'),
    'not registered'
  );
  // 注入 DataSource → 跳过 registry，应不抛错（用空 datasource）
  const ds = new FakeDataSource([], new Map(), new Map(), []);
  const res = await service.getDetail('synthetic_test_factor', { data_source: ds });
  expectEqual('injected DS bypasses registry', res.name, 'synthetic_test_factor');
  expectEqual('not registered → description empty', res.description, '');
  expectEqual('not registered → category=other', res.category, 'other');
}

async function runGetDetailEmptyTradeDates() {
  console.log('\n## getDetail empty trade_dates');
  const ds = new FakeDataSource([], new Map(), new Map(), []);
  const service = new FactorDetailService();
  const detail = await service.getDetail('value', { data_source: ds });
  expectEqual('period_start = null', detail.period_start, null);
  expectEqual('period_end = null', detail.period_end, null);
  expectEqual('effective_trade_days = 0', detail.effective_trade_days, 0);
  expectEqual('quintile_curves = []', detail.quintile_curves, []);
  assert('note present', !!detail.note && detail.note.includes('factor_scores'));
}

async function runGetDetailSmallCrossSection() {
  console.log('\n## getDetail all days cross-section < MIN');
  // 每日只有 10 只股票 < MIN_QUINTILE_CROSS_SECTION (25)
  const dates = ['2026-06-01', '2026-06-02'];
  const cross = new Map<string, Map<string, number>>();
  const fwd = new Map<string, Map<string, number>>();
  for (const date of dates) {
    const cs = new Map<string, number>();
    for (let i = 0; i < 10; i += 1) cs.set(`60010${i}`, i * 0.1);
    cross.set(date, cs);
    fwd.set(date, new Map());
  }
  const ds = new FakeDataSource(dates, cross, fwd, []);
  const service = new FactorDetailService();
  const detail = await service.getDetail('value', { data_source: ds });
  expectEqual('effective_trade_days = 0', detail.effective_trade_days, 0);
  // 净值仍生成 (2 个点) 但都是 1.0 因为 return = 0
  expectEqual('quintile_curves length = 2', detail.quintile_curves.length, 2);
  expectEqual('Q1 day0 = 1', detail.quintile_curves[0].Q1, 1);
  expectEqual('Q5 day1 = 1', detail.quintile_curves[1].Q5, 1);
  assert('note present', !!detail.note && detail.note.includes(String(MIN_QUINTILE_CROSS_SECTION)));
}

async function runGetDetailMixedDays() {
  console.log('\n## getDetail mixed: some days valid, some too small');
  const dates = ['2026-06-01', '2026-06-02', '2026-06-03'];
  const cross = new Map<string, Map<string, number>>();
  const fwd = new Map<string, Map<string, number>>();
  // day 1: 26 股 (≥ MIN) Q5 +2%
  {
    const cs = new Map<string, number>();
    const fr = new Map<string, number>();
    for (let i = 0; i < 26; i += 1) {
      const code = `601${String(i).padStart(3, '0')}`;
      cs.set(code, i * 0.1);
      const ret = i >= 21 ? 0.02 : 0.0; // 最高 5 个 +2%
      fr.set(code, ret);
    }
    cross.set('2026-06-01', cs);
    fwd.set('2026-06-01', fr);
  }
  // day 2: 5 股 (太少)
  {
    const cs = new Map<string, number>();
    for (let i = 0; i < 5; i += 1) cs.set(`6020${i}`, i * 0.1);
    cross.set('2026-06-02', cs);
    fwd.set('2026-06-02', new Map());
  }
  // day 3: 30 股 Q5 -1%
  {
    const cs = new Map<string, number>();
    const fr = new Map<string, number>();
    for (let i = 0; i < 30; i += 1) {
      const code = `603${String(i).padStart(3, '0')}`;
      cs.set(code, i * 0.1);
      const ret = i >= 24 ? -0.01 : 0.0; // 最高 6 个 -1%
      fr.set(code, ret);
    }
    cross.set('2026-06-03', cs);
    fwd.set('2026-06-03', fr);
  }
  const ds = new FakeDataSource(dates, cross, fwd, []);
  const service = new FactorDetailService();
  const detail = await service.getDetail('value', { data_source: ds });

  expectEqual('effective_trade_days = 2', detail.effective_trade_days, 2);
  expectEqual('quintile_curves length = 3', detail.quintile_curves.length, 3);
  // day 1 Q5 +2% → 1.02
  expectClose('day 1 Q5 = 1.02', detail.quintile_curves[0].Q5, 1.02);
  // day 2 = 1.02 * 1.0 = 1.02 (cross-section 太小，return=0)
  expectClose('day 2 Q5 unchanged = 1.02', detail.quintile_curves[1].Q5, 1.02);
  // day 3 -1% → 1.02 * 0.99 = 1.0098
  expectClose('day 3 Q5 = 1.02 * 0.99 = 1.0098', detail.quintile_curves[2].Q5, 1.0098, 1e-5);
}

async function runGetDetailWithICHistory() {
  console.log('\n## getDetail with IC history');
  const ic: ICHistoryPoint[] = [
    { period_end: '2026-05-01', ic_mean: 0.05, ic_ir: 0.6, look_forward_days: 1 },
    { period_end: '2026-05-15', ic_mean: 0.04, ic_ir: 0.5, look_forward_days: 1 },
    { period_end: '2026-06-01', ic_mean: 0.06, ic_ir: 0.7, look_forward_days: 1 },
  ];
  const ds = new FakeDataSource([], new Map(), new Map(), ic);
  const service = new FactorDetailService();
  const detail = await service.getDetail('value', { data_source: ds });
  expectEqual('ic_history length', detail.ic_history.length, 3);
  expectEqual('ic_history[0].period_end', detail.ic_history[0].period_end, '2026-05-01');
  expectEqual('ic_history[2].ic_mean', detail.ic_history[2].ic_mean, 0.06);
}

async function runRegistryIntegration() {
  console.log('\n## registered factor metadata');
  const service = new FactorDetailService();
  // 用真实因子 'value' （library/* 自我登记后必在 registry）
  const ds = new FakeDataSource([], new Map(), new Map(), []);
  const detail = await service.getDetail('value', { data_source: ds });
  // factorRegistry 有 'value' 因子
  assert('registry has value', factorRegistry.has('value'));
  expectEqual('detail.name = value', detail.name, 'value');
  assert('description non-empty', detail.description.length > 0);
  expectEqual('category = value', detail.category, 'value');
}

async function runLimitDaysClampPropagation() {
  console.log('\n## getDetail limit_days clamp propagation');
  // 模拟 service 内部 clampLimitDays 行为：传 50 应只拉 50 个 trade_date
  // 注：数据集 300 天 > MAX_DETAIL_TRADE_DAYS (250) 才能验证 clamp
  const dates = Array.from({ length: 300 }, (_, i) => {
    const d = new Date(`2026-01-01T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const ds: FactorDetailDataSource = {
    async loadRecentTradeDates(_f, limit) {
      // 模拟真实 DB：返回最近 limit 个
      return dates.slice(-limit);
    },
    async loadFactorCrossSection() {
      // 每日 30 只股票 (>= MIN)
      const cs = new Map<string, number>();
      for (let i = 0; i < 30; i += 1) cs.set(`60010${i}`, i * 0.1);
      return cs;
    },
    async loadForwardReturns() {
      return new Map();
    },
    async loadICHistory() {
      return [];
    },
  };
  const service = new FactorDetailService();
  // limit_days = 50
  const d50 = await service.getDetail('value', { data_source: ds, limit_days: 50 });
  expectEqual('limit_days=50 → 50 curves', d50.quintile_curves.length, 50);

  // 默认 (无 limit_days) → DEFAULT_DETAIL_TRADE_DAYS (120)
  const dDefault = await service.getDetail('value', { data_source: ds });
  expectEqual('default → 120 curves', dDefault.quintile_curves.length, DEFAULT_DETAIL_TRADE_DAYS);

  // 超过 MAX → clamp 到 MAX
  const dMax = await service.getDetail('value', {
    data_source: ds,
    limit_days: 999 as any,
  });
  // 999 不是 integer? 实际是 integer (999.0)，应 clamp 到 250
  expectEqual('limit_days=999 → 250 (max)', dMax.quintile_curves.length, MAX_DETAIL_TRADE_DAYS);
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  console.log('# FactorDetailService unit tests (US-094)');

  runSplitIntoQuintilesTests();
  runQuintileAverageReturnTests();
  runAccumulateNetValueTests();
  runBuildQuintileTimeSeriesTests();
  runFormatTradeDateTests();
  runClampTests();

  await runGetDetailHappyPath();
  await runGetDetailMissingFactor();
  await runGetDetailEmptyTradeDates();
  await runGetDetailSmallCrossSection();
  await runGetDetailMixedDays();
  await runGetDetailWithICHistory();
  await runRegistryIntegration();
  await runLimitDaysClampPropagation();

  console.log('\n----------------------------------------');
  console.log(`PASSED: ${passed}    FAILED: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
