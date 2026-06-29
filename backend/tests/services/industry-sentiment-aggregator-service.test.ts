/**
 * IndustrySentimentAggregator 单元测试 (PR-M3 / 2026-06-29)
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/industry-sentiment-aggregator-service.test.ts
 *
 * 完全脱 DB — IndustrySentimentDataSource 全 stub.
 *
 * 覆盖维度:
 *   - 纯 helpers: maxOr0 / meanFinite / stdevFinite / computeSealRate / computeFailureRate
 *     / computeConsecutiveMax / pickTopCodes / computeCompositeScore /
 *     computeIndustryMomentumZScores / aggregateOneIndustry / classifyIndustry / groupByIndustry
 *   - runOnce e2e:
 *     - 空 limit_up_stocks → 不写库
 *     - 多 industry 命中 → 每 industry upsert 一行
 *     - 单 industry upsert throw → 仅 error 记录, 其它仍写
 *     - dry_run=true → 不调 upsert
 *     - momentum z-score 数据不足 → industry_momentum_30d = null
 */

import {
  IndustrySentimentAggregator,
  IndustrySentimentDataSource,
  IndustrySentimentResult,
  LimitUpStockRow,
  aggregateOneIndustry,
  classifyIndustry,
  computeCompositeScore,
  computeConsecutiveMax,
  computeFailureRate,
  computeIndustryMomentumZScores,
  computeSealRate,
  groupByIndustry,
  maxOr0,
  meanFinite,
  pickTopCodes,
  stdevFinite,
} from '../../src/services/IndustrySentimentAggregator';

let ok = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function assertEqual(name: string, got: any, want: any): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}

function assertApprox(name: string, got: number, want: number, tol = 0.01): void {
  if (Math.abs(got - want) <= tol) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name} — got ${got}, want ${want} (tol ${tol})`);
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDSData {
  limitUpStocks?: LimitUpStockRow[];
  bars30d?: Array<{ stock_id: number; industry: string | null; close30d_pct: number }>;
  upsertThrowIndustries?: Set<string>;
  listLimitUpStocksThrow?: string;
}

interface FakeDSCalls {
  upserted: IndustrySentimentResult[];
}

function makeFakeDS(data: FakeDSData = {}): {
  ds: IndustrySentimentDataSource;
  calls: FakeDSCalls;
} {
  const calls: FakeDSCalls = { upserted: [] };
  const ds: IndustrySentimentDataSource = {
    async listLimitUpStocks() {
      if (data.listLimitUpStocksThrow) throw new Error(data.listLimitUpStocksThrow);
      return data.limitUpStocks || [];
    },
    async listRecent30DayBars() {
      return data.bars30d || [];
    },
    async upsertSentiment(r: IndustrySentimentResult) {
      if (data.upsertThrowIndustries && data.upsertThrowIndustries.has(r.industry)) {
        throw new Error(`upsert mock fail: ${r.industry}`);
      }
      calls.upserted.push(r);
    },
  };
  return { ds, calls };
}

// ---------------------------------------------------------------------------
// [1] Pure helpers — basic stats
// ---------------------------------------------------------------------------
console.log('\n[1] Pure helpers — basic stats...');
assertEqual('maxOr0 空', maxOr0([]), 0);
assertEqual('maxOr0 多值', maxOr0([3, 1, 5, 2]), 5);
assertEqual('maxOr0 全负', maxOr0([-3, -1, -5]), 0);
assertEqual('meanFinite 空', meanFinite([]), 0);
assertEqual('meanFinite 单值', meanFinite([5]), 5);
assertEqual('meanFinite skip NaN', meanFinite([1, NaN, 3]), 2);
assertEqual('stdevFinite 空', stdevFinite([]), 0);
assertEqual('stdevFinite 单值', stdevFinite([5]), 0);
assert('stdevFinite 多值 > 0', stdevFinite([1, 2, 3, 4, 5]) > 1);

// ---------------------------------------------------------------------------
// [2] computeSealRate / computeFailureRate / computeConsecutiveMax
// ---------------------------------------------------------------------------
console.log('\n[2] seal/failure/consecutive helpers...');
assertEqual('seal_rate 空', computeSealRate([]), 0);
assertEqual(
  'seal_rate 全 sealed (是一字板)',
  computeSealRate([
    { stock_code: '1', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: true },
    { stock_code: '2', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: true },
  ]),
  1
);
assertEqual(
  'seal_rate 一半 sealed',
  computeSealRate([
    { stock_code: '1', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: true },
    { stock_code: '2', continuous_days: 1, limit_up_open_times: 3, is_one_word_board: false },
  ]),
  0.5
);
assertEqual(
  'seal_rate 含 fail=0 但 non-one-word 也算 sealed',
  computeSealRate([
    { stock_code: '1', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: false },
  ]),
  1
);
assertEqual(
  'failure_rate 空',
  computeFailureRate([]),
  0
);
assertEqual(
  'failure_rate 一半炸过',
  computeFailureRate([
    { stock_code: '1', continuous_days: 1, limit_up_open_times: 2, is_one_word_board: false },
    { stock_code: '2', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: true },
  ]),
  0.5
);
assertEqual(
  'consecutive_max',
  computeConsecutiveMax([
    { stock_code: '1', continuous_days: 2, limit_up_open_times: 0, is_one_word_board: false },
    { stock_code: '2', continuous_days: 5, limit_up_open_times: 0, is_one_word_board: false },
    { stock_code: '3', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: false },
  ]),
  5
);
assertEqual('consecutive_max 空 = 0', computeConsecutiveMax([]), 0);

// ---------------------------------------------------------------------------
// [3] pickTopCodes
// ---------------------------------------------------------------------------
console.log('\n[3] pickTopCodes...');
assertEqual(
  'pickTopCodes top 3 by continuous_days desc',
  pickTopCodes([
    { stock_code: 'A', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: false },
    { stock_code: 'B', continuous_days: 5, limit_up_open_times: 0, is_one_word_board: false },
    { stock_code: 'C', continuous_days: 3, limit_up_open_times: 0, is_one_word_board: false },
    { stock_code: 'D', continuous_days: 2, limit_up_open_times: 0, is_one_word_board: false },
  ]),
  ['B', 'C', 'D']
);
assertEqual('pickTopCodes 空', pickTopCodes([]), []);

// ---------------------------------------------------------------------------
// [4] computeCompositeScore
// ---------------------------------------------------------------------------
console.log('\n[4] computeCompositeScore...');
// 高活跃 leader 板块: 5 涨停 + 5 连板 + 100% 封板 + 0 炸板 + 强动量 (z=2)
const leaderScore = computeCompositeScore({
  lim_up_count: 5,
  consecutive_max: 5,
  seal_rate: 1,
  lim_up_failure_rate: 0,
  industry_momentum_30d: 2,
});
// 0.3 + 0.3 + 0.2 - 0 + 0.2 = 1.0 * 10 = 10
assertApprox('composite_score leader', leaderScore, 10, 0.001);

// 全 0 板块
assertEqual(
  'composite_score 全 0',
  computeCompositeScore({
    lim_up_count: 0,
    consecutive_max: 0,
    seal_rate: 0,
    lim_up_failure_rate: 0,
    industry_momentum_30d: 0,
  }),
  0
);

// weak 板块: 1 涨停 + 1 连板 + 0% 封板 + 100% 炸板 + 弱动量 (z=-2)
const weakScore = computeCompositeScore({
  lim_up_count: 1,
  consecutive_max: 1,
  seal_rate: 0,
  lim_up_failure_rate: 1,
  industry_momentum_30d: -2,
});
// 0.06 + 0.06 + 0 - 0.1 - 0.2 = -0.18 * 10 = -1.8
assertApprox('composite_score weak', weakScore, -1.8, 0.001);

// null momentum → 0
const nullMom = computeCompositeScore({
  lim_up_count: 2,
  consecutive_max: 2,
  seal_rate: 0.5,
  lim_up_failure_rate: 0,
  industry_momentum_30d: null,
});
// 0.12 + 0.12 + 0.1 = 0.34 * 10 = 3.4
assertApprox('composite_score null momentum', nullMom, 3.4, 0.001);

// ---------------------------------------------------------------------------
// [5] computeIndustryMomentumZScores
// ---------------------------------------------------------------------------
console.log('\n[5] computeIndustryMomentumZScores...');
const fewMap = new Map<string, number>([['A', 1], ['B', 2]]);
assertEqual('z-scores 数据不足返空', computeIndustryMomentumZScores(fewMap).size, 0);

const enoughMap = new Map<string, number>([
  ['A', -5],
  ['B', 0],
  ['C', 5],
  ['D', 10],
  ['E', 20],
]);
const zMap = computeIndustryMomentumZScores(enoughMap);
assert('z-scores 5 industries 都有值', zMap.size === 5);
assert('z-scores E 最大', (zMap.get('E') as number) > (zMap.get('A') as number));

// 全相同值 → 空 (s=0)
const flatMap = new Map<string, number>([['A', 5], ['B', 5], ['C', 5]]);
assertEqual('z-scores 全相同返空', computeIndustryMomentumZScores(flatMap).size, 0);

// ---------------------------------------------------------------------------
// [6] aggregateOneIndustry
// ---------------------------------------------------------------------------
console.log('\n[6] aggregateOneIndustry...');
const semiconductorRows: LimitUpStockRow[] = [
  { stock_code: '300750', stock_name: '宁德时代', continuous_days: 3, limit_up_open_times: 0, is_one_word_board: true, industry: '半导体' },
  { stock_code: '688981', stock_name: '中芯国际', continuous_days: 2, limit_up_open_times: 0, is_one_word_board: false, industry: '半导体' },
  { stock_code: '603501', stock_name: '韦尔股份', continuous_days: 1, limit_up_open_times: 1, is_one_word_board: false, industry: '半导体' },
];
const aggregated = aggregateOneIndustry('2026-06-29', '半导体', semiconductorRows, 1.5);
assertEqual('industry', aggregated.industry, '半导体');
assertEqual('trade_date', aggregated.trade_date, '2026-06-29');
assertEqual('lim_up_count', aggregated.lim_up_count, 3);
assertEqual('consecutive_max', aggregated.consecutive_max, 3);
assertApprox('seal_rate', aggregated.seal_rate, 2 / 3, 0.001);
assertApprox('failure_rate', aggregated.lim_up_failure_rate, 1 / 3, 0.001);
assertEqual('momentum z透传', aggregated.industry_momentum_30d, 1.5);
assertEqual('top_codes', aggregated.top_codes, ['300750', '688981', '603501']);
assert('composite_score > 2 (leader)', aggregated.composite_score > 2);

// ---------------------------------------------------------------------------
// [7] classifyIndustry
// ---------------------------------------------------------------------------
console.log('\n[7] classifyIndustry...');
assertEqual('leader > 2', classifyIndustry(3), 'leader');
assertEqual('boundary 2 → neutral', classifyIndustry(2), 'neutral');
assertEqual('boundary -1 → neutral', classifyIndustry(-1), 'neutral');
assertEqual('weak < -1', classifyIndustry(-2), 'weak');
assertEqual('neutral 0', classifyIndustry(0), 'neutral');
assertEqual('NaN → neutral', classifyIndustry(NaN), 'neutral');

// ---------------------------------------------------------------------------
// [8] groupByIndustry
// ---------------------------------------------------------------------------
console.log('\n[8] groupByIndustry...');
const mixed: LimitUpStockRow[] = [
  { stock_code: 'A', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: false, industry: '电力' },
  { stock_code: 'B', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: false, industry: '电力' },
  { stock_code: 'C', continuous_days: 2, limit_up_open_times: 0, is_one_word_board: false, industry: '半导体' },
  { stock_code: 'D', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: false, industry: null },
];
const groups = groupByIndustry(mixed);
assertEqual('groups size', groups.size, 3);
assertEqual('电力 has 2', groups.get('电力')?.length, 2);
assertEqual('半导体 has 1', groups.get('半导体')?.length, 1);
assertEqual('__UNKNOWN__ has 1', groups.get('__UNKNOWN__')?.length, 1);

// ---------------------------------------------------------------------------
// [9] runOnce e2e
// ---------------------------------------------------------------------------
console.log('\n[9] runOnce e2e...');

async function testEmptyLimitUp(): Promise<void> {
  const { ds, calls } = makeFakeDS({ limitUpStocks: [] });
  const svc = new IndustrySentimentAggregator({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('empty — ok=true', r.ok === true);
  assertEqual('empty — scanned', r.industries_scanned, 0);
  assertEqual('empty — written', r.industries_written, 0);
  assertEqual('empty — no upsert', calls.upserted.length, 0);
}

async function testMultiIndustryHit(): Promise<void> {
  const { ds, calls } = makeFakeDS({
    limitUpStocks: [
      { stock_code: 'A', continuous_days: 3, limit_up_open_times: 0, is_one_word_board: true, industry: '电力' },
      { stock_code: 'B', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: false, industry: '电力' },
      { stock_code: 'C', continuous_days: 5, limit_up_open_times: 0, is_one_word_board: true, industry: '半导体' },
    ],
    bars30d: [
      { stock_id: 1, industry: '电力', close30d_pct: -3 },
      { stock_id: 2, industry: '半导体', close30d_pct: 12 },
      { stock_id: 3, industry: '钢铁', close30d_pct: 1 },
      { stock_id: 4, industry: '券商', close30d_pct: 5 },
    ],
  });
  const svc = new IndustrySentimentAggregator({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('multi — ok', r.ok === true);
  assertEqual('multi — scanned 2 industries', r.industries_scanned, 2);
  assertEqual('multi — written 2', r.industries_written, 2);
  assertEqual('multi — upserted 2', calls.upserted.length, 2);
  // 半导体 (1 票 5 连板 一字板 + 强动量) 应该 > 电力 (2 票 3+1 板)
  const semi = calls.upserted.find(u => u.industry === '半导体');
  const power = calls.upserted.find(u => u.industry === '电力');
  assert('半导体 found', !!semi);
  assert('电力 found', !!power);
  assert('半导体 momentum > 0', (semi?.industry_momentum_30d ?? 0) > 0);
  assert('电力 momentum < 0', (power?.industry_momentum_30d ?? 0) < 0);
}

async function testUpsertSingleThrow(): Promise<void> {
  const { ds, calls } = makeFakeDS({
    limitUpStocks: [
      { stock_code: 'A', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: true, industry: '电力' },
      { stock_code: 'B', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: true, industry: '半导体' },
    ],
    upsertThrowIndustries: new Set(['电力']),
  });
  const svc = new IndustrySentimentAggregator({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assertEqual('single throw — scanned 2', r.industries_scanned, 2);
  assertEqual('single throw — written 1', r.industries_written, 1);
  assertEqual('single throw — errors 1', r.errors.length, 1);
  assert('single throw — ok=false', r.ok === false);
  assertEqual('single throw — 半导体 upserted', calls.upserted[0].industry, '半导体');
}

async function testDryRun(): Promise<void> {
  const { ds, calls } = makeFakeDS({
    limitUpStocks: [
      { stock_code: 'A', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: true, industry: '电力' },
    ],
  });
  const svc = new IndustrySentimentAggregator({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29', dry_run: true });
  assert('dry_run — ok', r.ok === true);
  assertEqual('dry_run — written', r.industries_written, 1);
  assertEqual('dry_run — no upsert call', calls.upserted.length, 0);
}

async function testMomentumDataInsufficient(): Promise<void> {
  const { ds, calls } = makeFakeDS({
    limitUpStocks: [
      { stock_code: 'A', continuous_days: 1, limit_up_open_times: 0, is_one_word_board: true, industry: '电力' },
    ],
    bars30d: [], // 没数据
  });
  const svc = new IndustrySentimentAggregator({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('insufficient mom — ok', r.ok === true);
  assertEqual('insufficient mom — written', r.industries_written, 1);
  assertEqual('insufficient mom — momentum null', calls.upserted[0].industry_momentum_30d, null);
}

async function testListLimitUpStocksThrow(): Promise<void> {
  const { ds } = makeFakeDS({ listLimitUpStocksThrow: 'db boom' });
  const svc = new IndustrySentimentAggregator({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('top throw — ok=false', r.ok === false);
  assertEqual('top throw — errors 1', r.errors.length, 1);
  assertEqual('top throw — written 0', r.industries_written, 0);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  await testEmptyLimitUp();
  await testMultiIndustryHit();
  await testUpsertSingleThrow();
  await testDryRun();
  await testMomentumDataInsufficient();
  await testListLimitUpStocksThrow();

  console.log(`\n[industry-sentiment-aggregator] ${ok} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
})();
