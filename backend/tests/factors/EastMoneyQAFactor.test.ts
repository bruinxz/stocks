/**
 * EastMoneyQAFactor 单元测试 (US-034).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/EastMoneyQAFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 mean (空数组 / 1 个 / 多个 / 负数混合)
 *   - 纯函数 isoDateMinusDays (正常 / 跨月 / 跨年 / 负 days clamp)
 *   - 纯函数 computePostCountRatio:
 *       - 空 observations → null
 *       - 缺 asOfDate → null
 *       - recent ≥ total 边界 (退化) → null
 *       - 总观测 < MIN_OBSERVATIONS_TOTAL → null
 *       - recent 0 条 → null
 *       - baseline 0 条 → null
 *       - baseline avg ≈ 0 → null（避免比率爆炸）
 *       - 数据卫生：负数 / NaN / null / undefined / string post_count 安全跳过
 *       - 超总窗口的 trade_date 被剔除
 *       - 未来 trade_date 被剔除（lookahead bias guard）
 *       - ratio = 1.0 / 1.2 / 0.8 等典型场景值验证
 *   - Factor metadata (name / category / description / 已注册 / 从 registry get)
 *   - 4 个常量校验
 *   - 端到端业务校验：模拟 30 日数据 → recent 5 日 平均高于 30 日均值 → ratio > 1
 *   - 空 universe 路径不爆 (compute() ctx.universe=[] → 空 Map)
 */

import {
  eastMoneyQAFactor,
  computePostCountRatio,
  mean,
  isoDateMinusDays,
  RECENT_WINDOW_DAYS,
  TOTAL_WINDOW_DAYS,
  MIN_OBSERVATIONS_TOTAL,
  BASELINE_ZERO_THRESHOLD,
  SentimentInput,
} from '../../src/quant/factors/library/EastMoneyQAFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记
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

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-9) {
  assert(name, near(actual, expected, eps), `expected≈${expected}, got=${actual}`);
}

console.log('\n## mean()');
expectClose('空数组 → 0', mean([]), 0);
expectClose('单元素 [42] → 42', mean([42]), 42);
expectClose('[1,2,3,4,5] → 3', mean([1, 2, 3, 4, 5]), 3);
expectClose('[-2, -1, 0, 1, 2] → 0', mean([-2, -1, 0, 1, 2]), 0);
expectClose('[100, 200, 300] → 200', mean([100, 200, 300]), 200);

console.log('\n## isoDateMinusDays()');
assert(
  'asOf=2026-06-07 -4d → 2026-06-03 (近 5 日 = [asOf-4, asOf])',
  isoDateMinusDays(new Date('2026-06-07T00:00:00Z'), 4) === '2026-06-03'
);
assert(
  'asOf=2026-06-07 -29d → 2026-05-09 (近 30 日 = [asOf-29, asOf])',
  isoDateMinusDays(new Date('2026-06-07T00:00:00Z'), 29) === '2026-05-09'
);
assert(
  'asOf=2026-01-15 -29d → 2025-12-17 (跨年)',
  isoDateMinusDays(new Date('2026-01-15T00:00:00Z'), 29) === '2025-12-17'
);
assert(
  'days=0 → 同日',
  isoDateMinusDays(new Date('2026-06-07T00:00:00Z'), 0) === '2026-06-07'
);
assert(
  'days<0 → clamp 0',
  isoDateMinusDays(new Date('2026-06-07T00:00:00Z'), -5) === '2026-06-07'
);
assert(
  'asOf=2026-03-01 -29d → 2026-01-31 (跨月)',
  isoDateMinusDays(new Date('2026-03-01T00:00:00Z'), 29) === '2026-01-31'
);

console.log('\n## computePostCountRatio() — 边界 / 退化路径');

assert('空 observations → null', computePostCountRatio([], '2026-06-07') === null);
assert('null observations → null', computePostCountRatio(null as any, '2026-06-07') === null);
assert(
  '空 asOfDate → null',
  computePostCountRatio([{ trade_date: '2026-06-01', post_count: 100 }], '') === null
);
assert(
  'recent 窗口 = 0 → null（guard）',
  computePostCountRatio(
    [{ trade_date: '2026-06-01', post_count: 100 }],
    '2026-06-07',
    0,
    30
  ) === null
);
assert(
  'recent ≥ total → null（退化）',
  computePostCountRatio(
    [{ trade_date: '2026-06-01', post_count: 100 }],
    '2026-06-07',
    30,
    30
  ) === null
);
assert(
  'recent > total → null（退化）',
  computePostCountRatio(
    [{ trade_date: '2026-06-01', post_count: 100 }],
    '2026-06-07',
    50,
    30
  ) === null
);

console.log('\n## computePostCountRatio() — 基本场景');

const AS_OF = '2026-06-07';

// 场景：30 日内有效观测充足，recent 5 日均值 = 120，baseline 25 日均值 = 100
// ratio = 1.2 (热度上升 +20 %)
{
  const obs: SentimentInput[] = [];
  // baseline 区间 [2026-05-09, 2026-06-02]，post_count 全 100
  for (let i = 5; i <= 29; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  // recent 区间 [2026-06-03, 2026-06-07]，post_count 全 120
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 120,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('30 日数据 + recent 上升 20% → ratio = 1.2', result !== null);
  if (result) {
    expectClose('recent_avg=120', result.recent_avg, 120);
    expectClose('baseline_avg=100', result.baseline_avg, 100);
    expectClose('ratio=1.2', result.ratio, 1.2, 1e-12);
    assert('recent_count=5', result.recent_count === 5);
    assert('baseline_count=25', result.baseline_count === 25);
  }
}

// 场景：recent 5 日下跌 20% → ratio = 0.8
{
  const obs: SentimentInput[] = [];
  for (let i = 5; i <= 29; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 80,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('30 日数据 + recent 下跌 20% → ratio = 0.8', result !== null);
  if (result) {
    expectClose('ratio=0.8', result.ratio, 0.8, 1e-12);
  }
}

// 场景：稳定 → ratio = 1.0
{
  const obs: SentimentInput[] = [];
  for (let i = 0; i <= 29; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 500,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('稳定 → ratio = 1.0', result !== null);
  if (result) {
    expectClose('ratio=1.0', result.ratio, 1.0, 1e-12);
  }
}

console.log('\n## computePostCountRatio() — 失效路径');

// 总观测 < MIN_OBSERVATIONS_TOTAL → null
{
  const obs: SentimentInput[] = [
    { trade_date: '2026-06-03', post_count: 100 },
    { trade_date: '2026-06-04', post_count: 100 },
    { trade_date: '2026-06-05', post_count: 100 },
  ];
  const result = computePostCountRatio(obs, AS_OF);
  assert(`总观测 ${obs.length} < MIN_OBSERVATIONS_TOTAL=${MIN_OBSERVATIONS_TOTAL} → null`, result === null);
}

// recent 0 条（所有观测都在 baseline 区间）→ null
{
  const obs: SentimentInput[] = [];
  for (let i = 5; i <= 29; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('recent 0 条 → null', result === null);
}

// baseline 0 条（所有观测都在 recent 区间）→ null（但 recent 必须 ≥ MIN_OBS）
{
  const obs: SentimentInput[] = [];
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  // 5 < MIN_OBSERVATIONS_TOTAL=10，先被 MIN_OBS 拦截，但即使 MIN_OBS=5 也会被 baseline=0 拦截
  const result = computePostCountRatio(obs, AS_OF, RECENT_WINDOW_DAYS, TOTAL_WINDOW_DAYS, 5);
  assert('baseline 0 条 → null', result === null);
}

// baseline avg = 0 → null（避免比率爆炸）
{
  const obs: SentimentInput[] = [];
  for (let i = 5; i <= 29; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 0,
    });
  }
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('baseline avg=0 < BASELINE_ZERO_THRESHOLD=1.0 → null', result === null);
}

// baseline avg = 0.5 < BASELINE_ZERO_THRESHOLD=1.0 → null
{
  const obs: SentimentInput[] = [];
  for (let i = 5; i <= 29; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 0.5,
    });
  }
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('baseline avg=0.5 < 1.0 → null', result === null);
}

// baseline avg 恰等 BASELINE_ZERO_THRESHOLD=1.0 → null（严格 < threshold 通过）
{
  const obs: SentimentInput[] = [];
  for (let i = 5; i <= 29; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 1.0,
    });
  }
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  // |1.0| < 1.0 是 false → 通过；说明 boundary 严格 < 检查（恰等不拦截）
  assert('baseline avg=1.0 恰等 threshold → 通过', result !== null);
  if (result) {
    expectClose('ratio=100/1=100', result.ratio, 100, 1e-12);
  }
}

console.log('\n## computePostCountRatio() — 数据卫生（NaN / null / undefined / 负数 / string）');

// 缺数据 / NaN / 负数 record 跳过；恰好够 MIN_OBS 的有效数据通过
{
  const obs: SentimentInput[] = [];
  // 5 条无效（污染）：null / undefined / NaN / 负数 / 字符串 "abc"
  obs.push({ trade_date: '2026-05-20', post_count: null });
  obs.push({ trade_date: '2026-05-21', post_count: undefined });
  obs.push({ trade_date: '2026-05-22', post_count: NaN });
  obs.push({ trade_date: '2026-05-23', post_count: -100 }); // 负数无效
  obs.push({ trade_date: '2026-05-24', post_count: 'abc' as any }); // 字符串
  // 5 条有效 baseline (post_count = 100)
  for (let i = 5; i <= 9; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  // 5 条有效 recent (post_count = 200)
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 200,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('5 污染条 + 10 有效 → 通过 MIN_OBS=10', result !== null);
  if (result) {
    expectClose('ratio=200/100=2.0 (污染条被忽略)', result.ratio, 2.0, 1e-12);
    assert('baseline_count=5 (仅有效)', result.baseline_count === 5);
    assert('recent_count=5', result.recent_count === 5);
  }
}

// 超总窗口 (> 30 天前) 的 record 跳过
{
  const obs: SentimentInput[] = [];
  // 100 天前 — 超出总窗口
  obs.push({
    trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), 100),
    post_count: 999999,
  });
  // baseline 区间
  for (let i = 5; i <= 14; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  // recent 区间
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 120,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('超窗 100 天前的极端值被剔除 → 不污染 baseline', result !== null);
  if (result) {
    expectClose('ratio=120/100=1.2 (未被 999999 污染)', result.ratio, 1.2, 1e-12);
    assert('baseline_count=10 (超窗剔除)', result.baseline_count === 10);
  }
}

// 未来日期 trade_date 被剔除（防 lookahead bias，US-030 范式）
{
  const obs: SentimentInput[] = [];
  // 未来日期 — 必须剔除
  obs.push({ trade_date: '2026-06-10', post_count: 999999 });
  // baseline
  for (let i = 5; i <= 14; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  // recent
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 120,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('未来日期被剔除 → 不受未来值污染', result !== null);
  if (result) {
    expectClose('ratio=120/100=1.2 (未受未来值污染)', result.ratio, 1.2, 1e-12);
  }
}

// 空 trade_date 字符串被跳过
{
  const obs: SentimentInput[] = [];
  obs.push({ trade_date: '', post_count: 999999 });
  for (let i = 5; i <= 14; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 100,
    });
  }
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 120,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('空 trade_date 字符串被跳过', result !== null);
  if (result) {
    expectClose('ratio=1.2 (未被空 date 污染)', result.ratio, 1.2, 1e-12);
  }
}

console.log('\n## Factor metadata + 注册');
assert('name = east_money_qa', eastMoneyQAFactor.name === 'east_money_qa');
assert('category = sentiment', eastMoneyQAFactor.category === 'sentiment');
assert(
  'description 非空且含 "5 日" 或 "30 日" 关键词',
  typeof eastMoneyQAFactor.description === 'string' &&
    eastMoneyQAFactor.description.length > 0 &&
    eastMoneyQAFactor.description.includes('5 日') &&
    eastMoneyQAFactor.description.includes('30 日')
);
assert(
  'description 含 "代理" 标注（US-031/US-032 范式）',
  eastMoneyQAFactor.description.includes('代理')
);
assert('compute 是函数', typeof eastMoneyQAFactor.compute === 'function');
assert('已注册到 factorRegistry', factorRegistry.has('east_money_qa'));
assert(
  '已纳入 listNames()',
  factorRegistry.listNames().includes('east_money_qa')
);
assert(
  'registry get 同一对象',
  factorRegistry.get('east_money_qa') === eastMoneyQAFactor
);

console.log('\n## 常量');
assert('RECENT_WINDOW_DAYS=5', RECENT_WINDOW_DAYS === 5);
assert('TOTAL_WINDOW_DAYS=30', TOTAL_WINDOW_DAYS === 30);
assert('MIN_OBSERVATIONS_TOTAL=10', MIN_OBSERVATIONS_TOTAL === 10);
assert('BASELINE_ZERO_THRESHOLD=1.0', BASELINE_ZERO_THRESHOLD === 1.0);

console.log('\n## 既有因子未被破坏');
const allNames = factorRegistry.listNames();
const expectedFactors = [
  'analyst_consensus',
  'dragon_tiger',
  'earnings_surprise',
  'east_money_qa',
  'growth',
  'liquidity',
  'low_vol',
  'momentum',
  'momentum_reversal',
  'money_flow',
  'northbound',
  'quality',
  'quality_high',
  'value',
];
for (const f of expectedFactors) {
  assert(`factor "${f}" 存在`, allNames.includes(f));
}
assert(
  `总数 = ${expectedFactors.length}`,
  allNames.length === expectedFactors.length,
  `actual=${allNames.length} names=[${allNames.join(',')}]`
);

console.log('\n## 空 universe 路径不爆');
{
  const result = eastMoneyQAFactor.compute({ as_of_date: AS_OF, universe: [] });
  // result is a Promise<Map>
  result.then(m => {
    assert('空 universe → 空 Map', m.size === 0);
  });
}

console.log('\n## 端到端：模拟 30 日散户关注度从 800 → 1200 的渐变');
{
  // 散户关注度先平稳 (post_count=800)，最近 5 日上升到 1200
  // 30 日内 baseline (5-29 日前) 共 25 个观测 = 800，recent (0-4 日前) 共 5 个 = 1200
  // ratio = 1200/800 = 1.5 (关注度上升 50%)
  const obs: SentimentInput[] = [];
  for (let i = 5; i <= 29; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 800,
    });
  }
  for (let i = 0; i <= 4; i++) {
    obs.push({
      trade_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), i),
      post_count: 1200,
    });
  }
  const result = computePostCountRatio(obs, AS_OF);
  assert('端到端：渐变场景 → ratio = 1.5', result !== null);
  if (result) {
    expectClose('recent_avg=1200', result.recent_avg, 1200);
    expectClose('baseline_avg=800', result.baseline_avg, 800);
    expectClose('ratio=1.5', result.ratio, 1.5, 1e-12);
  }
}

console.log('\n========================================');
console.log(`Total: passed=${passed}  failed=${failed}`);
console.log('========================================');

setTimeout(() => {
  if (failed > 0) {
    console.error('\n❌ tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ all tests pass');
    process.exit(0);
  }
}, 100); // allow the空 universe Promise to settle
