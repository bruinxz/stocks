/**
 * MarketSentimentIndexService 单元测试 (US-057)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/market-sentiment-index-service.test.ts
 *
 * 完全脱离 DB / Python 子进程: 注入 fake MarketSentimentDataSource.
 *
 * 覆盖维度:
 *   - 纯函数:
 *     - normalizeDateOnly (Date / 8 位 / 10 位 / null);
 *     - isoDateMinusDays (跨月 / 跨年 / 边界);
 *     - mean (空 / 单元素 / 常见);
 *     - sampleStddev (空 / 单元素 / 已知数列);
 *     - computeZScore (已知数列 / 数据不足 / stddev 近 0 / NaN target);
 *     - sigmoidNormalize (raw=0 / +scale / -scale / 极端 / 非有限);
 *     - computeDailyDiffs (空 / 单元素 / 已知时序);
 *     - buildSummaryMessage (5 个 grade 区段 + partial 标记);
 *   - service.computeAndPersist() end-to-end:
 *     - happy path: 4 维度齐全 → status=ok, persisted=true;
 *     - dry_run: 不调 saveIndex, persisted=false;
 *     - 部分维度缺失: status=partial 仍 persisted;
 *     - 全部维度缺失: status=failed 仍 persisted;
 *     - saveIndex throw → fail-OPEN persisted=false 不抛;
 *     - 自定义 lookback / min_observations / sigmoid_scale 传入;
 *     - 默认 trade_date (今日);
 *     - lookback 不足 5 样本: z-score=null (中性 0 贡献);
 *     - components_json 正确写入.
 *   - service.listRecentIndex(): days 上限/下限 clamping (不调 DB, 走默认 mock).
 */

import {
  MarketSentimentIndexService,
  MarketSentimentDataSource,
  MarketSentimentIndexRecord,
  MarketSentimentIndexResult,
  SENTIMENT_WEIGHTS,
  DEFAULT_PARAMS,
  normalizeDateOnly,
  isoDateMinusDays,
  mean,
  sampleStddev,
  computeZScore,
  sigmoidNormalize,
  computeDailyDiffs,
  buildSummaryMessage,
} from '../../src/services/MarketSentimentIndexService';

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

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function assertNear(name: string, actual: number, expected: number, tol = 1e-4): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) < tol;
  assert(name, ok, `actual=${actual} expected=${expected} tol=${tol}`);
}

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeState {
  limitUpCount?: number;
  limitDownCount?: number;
  northSeries?: Array<{ date: string; total: number }>;
  marginSeries?: Array<{ date: string; net_buy_yi: number }>;
  qaSeries?: Array<{ date: string; total: number }>;
  saves: MarketSentimentIndexRecord[];
  limitUpShouldThrow?: boolean;
  limitDownShouldThrow?: boolean;
  northShouldThrow?: boolean;
  marginShouldThrow?: boolean;
  qaShouldThrow?: boolean;
  saveShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): MarketSentimentDataSource {
  return {
    async loadLimitUpCount(_tradeDate) {
      if (state.limitUpShouldThrow) throw new Error('fake limit-up outage');
      return state.limitUpCount ?? 0;
    },
    async fetchLimitDownCount(_tradeDate) {
      if (state.limitDownShouldThrow) throw new Error('fake limit-down outage');
      return state.limitDownCount ?? 0;
    },
    async loadNorthboundDailyTotal(_start, _end) {
      if (state.northShouldThrow) throw new Error('fake north outage');
      return state.northSeries ?? [];
    },
    async fetchMarginDailyNetBuy(_start, _end) {
      if (state.marginShouldThrow) throw new Error('fake margin outage');
      return state.marginSeries ?? [];
    },
    async loadQADailyTotal(_start, _end) {
      if (state.qaShouldThrow) throw new Error('fake qa outage');
      return state.qaSeries ?? [];
    },
    async saveIndex(record) {
      if (state.saveShouldThrow) throw new Error('fake DB outage');
      state.saves.push(record);
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    saves: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. constants
// ---------------------------------------------------------------------------

function testConstants(): void {
  assertEqual('SENTIMENT_WEIGHTS.limit_diff', SENTIMENT_WEIGHTS.limit_diff, 0.3);
  assertEqual('SENTIMENT_WEIGHTS.northbound', SENTIMENT_WEIGHTS.northbound, 0.3);
  assertEqual('SENTIMENT_WEIGHTS.margin', SENTIMENT_WEIGHTS.margin, 0.2);
  assertEqual('SENTIMENT_WEIGHTS.qa_heat', SENTIMENT_WEIGHTS.qa_heat, 0.2);
  // 权重和 = 1.0
  const sum =
    SENTIMENT_WEIGHTS.limit_diff +
    SENTIMENT_WEIGHTS.northbound +
    SENTIMENT_WEIGHTS.margin +
    SENTIMENT_WEIGHTS.qa_heat;
  assertEqual('weights sum to 1.0', sum, 1.0);

  assertEqual('DEFAULT_PARAMS.lookback_days', DEFAULT_PARAMS.lookback_days, 60);
  assertEqual('DEFAULT_PARAMS.min_observations', DEFAULT_PARAMS.min_observations, 5);
  assertEqual('DEFAULT_PARAMS.sigmoid_scale', DEFAULT_PARAMS.sigmoid_scale, 30);
}

// ---------------------------------------------------------------------------
// 2. normalizeDateOnly
// ---------------------------------------------------------------------------

function testNormalizeDateOnly(): void {
  assertEqual('YYYY-MM-DD', normalizeDateOnly('2026-06-08'), '2026-06-08');
  assertEqual('YYYY-MM-DD HH:mm', normalizeDateOnly('2026-06-08 09:35:12'), '2026-06-08');
  assertEqual('YYYYMMDD', normalizeDateOnly('20260608'), '2026-06-08');
  assertEqual('null', normalizeDateOnly(null), null);
  assertEqual('undefined', normalizeDateOnly(undefined), null);
  assertEqual('empty string', normalizeDateOnly(''), null);
  assertEqual('gibberish', normalizeDateOnly('not-a-date'), null);
  // Date 对象
  const d = new Date(Date.UTC(2026, 5, 8));
  assertEqual('Date instance', normalizeDateOnly(d), '2026-06-08');
}

// ---------------------------------------------------------------------------
// 3. isoDateMinusDays
// ---------------------------------------------------------------------------

function testIsoDateMinusDays(): void {
  assertEqual('minus 0', isoDateMinusDays('2026-06-08', 0), '2026-06-08');
  assertEqual('minus 1', isoDateMinusDays('2026-06-08', 1), '2026-06-07');
  assertEqual('minus 7', isoDateMinusDays('2026-06-08', 7), '2026-06-01');
  assertEqual('minus 30 跨月', isoDateMinusDays('2026-06-08', 30), '2026-05-09');
  assertEqual('minus 365 跨年', isoDateMinusDays('2026-06-08', 365), '2025-06-08');
  assertEqual('minus 1 跨年', isoDateMinusDays('2026-01-01', 1), '2025-12-31');
}

// ---------------------------------------------------------------------------
// 4. mean
// ---------------------------------------------------------------------------

function testMean(): void {
  assert('mean([]) is NaN', Number.isNaN(mean([])));
  assertEqual('mean([5])', mean([5]), 5);
  assertEqual('mean([1,2,3])', mean([1, 2, 3]), 2);
  assertEqual('mean([0,0,0])', mean([0, 0, 0]), 0);
  assertNear('mean([1.5,2.5,3.5])', mean([1.5, 2.5, 3.5]), 2.5);
  assertEqual('mean negative', mean([-1, -2, -3]), -2);
}

// ---------------------------------------------------------------------------
// 5. sampleStddev
// ---------------------------------------------------------------------------

function testSampleStddev(): void {
  assert('stddev([]) is NaN', Number.isNaN(sampleStddev([])));
  assert('stddev([5]) is NaN', Number.isNaN(sampleStddev([5])));
  assertEqual('stddev([1,1])', sampleStddev([1, 1]), 0);
  // 已知数列: [2,4,4,4,5,5,7,9] → mean=5, var(sample)=32/7, sd=sqrt(32/7)=2.138
  assertNear('stddev classic', sampleStddev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 1e-2);
  // [1,2,3,4,5] → mean=3, var=2.5, sd=sqrt(2.5)=1.5811
  assertNear('stddev [1..5]', sampleStddev([1, 2, 3, 4, 5]), 1.5811, 1e-3);
}

// ---------------------------------------------------------------------------
// 6. computeZScore
// ---------------------------------------------------------------------------

function testComputeZScore(): void {
  // 数据不足 (< minObs) → null
  assertEqual('z-score history 太少', computeZScore([1, 2], 5, 5), null);
  // stddev = 0 → null
  assertEqual('z-score 常数序列', computeZScore([3, 3, 3, 3, 3], 3, 5), null);
  // 已知数列 [1,2,3,4,5] mean=3 sd=1.5811; target=5 → z=(5-3)/1.5811≈1.265
  const z1 = computeZScore([1, 2, 3, 4, 5], 5, 5);
  assert('z-score [1..5], target=5 ≈ 1.265', z1 !== null && Math.abs(z1 - 1.265) < 1e-2);
  // target = mean → z = 0
  const z0 = computeZScore([1, 2, 3, 4, 5], 3, 5);
  assert('z-score target=mean=0', z0 !== null && Math.abs(z0 - 0) < 1e-9);
  // target NaN → null
  assertEqual('z-score NaN target', computeZScore([1, 2, 3, 4, 5], Number.NaN, 5), null);
  // 历史含 NaN 应被过滤掉; 剩余样本数 < minObs → null
  assertEqual(
    'z-score NaN history filtered',
    computeZScore([1, 2, Number.NaN, Number.NaN, Number.NaN], 5, 5),
    null
  );
  // history 含 1 个 NaN 但剩余 ≥ minObs 仍可算
  const z2 = computeZScore([1, 2, 3, 4, 5, Number.NaN], 5, 5);
  assert('z-score 1 NaN filtered ≥ minObs', z2 !== null);
}

// ---------------------------------------------------------------------------
// 7. sigmoidNormalize
// ---------------------------------------------------------------------------

function testSigmoidNormalize(): void {
  assertNear('sigmoid raw=0 → 50', sigmoidNormalize(0, 30), 50);
  // raw=+scale → 100/(1+e^-1)=100*0.7311=73.11
  assertNear('sigmoid raw=+scale → ~73.1', sigmoidNormalize(30, 30), 73.1058, 1e-2);
  // raw=-scale → 100/(1+e^1)=100*0.2689=26.89
  assertNear('sigmoid raw=-scale → ~26.9', sigmoidNormalize(-30, 30), 26.8941, 1e-2);
  // raw 极大 → 100
  assertNear('sigmoid raw=+huge → 100', sigmoidNormalize(10000, 30), 100, 1e-2);
  // raw 极小 → 0
  assertNear('sigmoid raw=-huge → 0', sigmoidNormalize(-10000, 30), 0, 1e-2);
  // 非有限值 → 50 (中性, impl 早返回)
  assertEqual('sigmoid raw=NaN → 50', sigmoidNormalize(Number.NaN, 30), 50);
  assertEqual('sigmoid raw=+Infinity → 50 (非有限 → 中性)', sigmoidNormalize(Number.POSITIVE_INFINITY, 30), 50);
  assertEqual('sigmoid raw=-Infinity → 50 (非有限 → 中性)', sigmoidNormalize(Number.NEGATIVE_INFINITY, 30), 50);
  // scale<=0 → 50
  assertEqual('sigmoid scale=0 → 50', sigmoidNormalize(10, 0), 50);
  assertEqual('sigmoid scale<0 → 50', sigmoidNormalize(10, -1), 50);
  assertEqual('sigmoid scale=NaN → 50', sigmoidNormalize(10, Number.NaN), 50);
}

// ---------------------------------------------------------------------------
// 8. computeDailyDiffs
// ---------------------------------------------------------------------------

function testComputeDailyDiffsNaN(): void {
  const d = computeDailyDiffs([
    { date: '2026-06-01', total: 100 },
    { date: '2026-06-02', total: Number.NaN },
    { date: '2026-06-03', total: 110 },
  ]);
  // 期望: 0 (两端 finite 才 emit)
  assertEqual('diffs NaN strict filter — should be 0', d.length, 0);
}

// ---------------------------------------------------------------------------
// 9. buildSummaryMessage
// ---------------------------------------------------------------------------

function makeComponents(over: Partial<{
  limit_up_count: number | null;
  limit_down_count: number | null;
  northZ: number | null;
  marginZ: number | null;
  qaZ: number | null;
}> = {}): MarketSentimentIndexResult['components'] {
  // 用 'northZ' in over 区分"未传"和"显式 null"
  const northZ = 'northZ' in over ? over.northZ! : 1.5;
  const marginZ = 'marginZ' in over ? over.marginZ! : 0.5;
  const qaZ = 'qaZ' in over ? over.qaZ! : -0.3;
  const luc = 'limit_up_count' in over ? over.limit_up_count! : 50;
  const ldc = 'limit_down_count' in over ? over.limit_down_count! : 5;
  return {
    limit_diff: {
      raw_value: 10,
      z_score: null,
      weight: 0.3,
      contribution: 3.0,
      observation_count: 1,
      error: null,
      limit_up_count: luc,
      limit_down_count: ldc,
    },
    northbound: {
      raw_value: 100,
      z_score: northZ,
      weight: 0.3,
      contribution: 0.45,
      observation_count: 30,
      error: null,
    },
    margin: {
      raw_value: 10,
      z_score: marginZ,
      weight: 0.2,
      contribution: 0.1,
      observation_count: 30,
      error: null,
    },
    qa_heat: {
      raw_value: 1000,
      z_score: qaZ,
      weight: 0.2,
      contribution: -0.06,
      observation_count: 30,
      error: null,
    },
  };
}

function testBuildSummaryMessage(): void {
  // 5 个 grade 区段
  const m85 = buildSummaryMessage({
    trade_date: '2026-06-08',
    index_value: 85,
    status: 'ok',
    components: makeComponents(),
  });
  assert('grade 极度乐观 (>=80)', m85.includes('极度乐观'));

  const m65 = buildSummaryMessage({
    trade_date: '2026-06-08',
    index_value: 65,
    status: 'ok',
    components: makeComponents(),
  });
  assert('grade 偏多 (>=60)', m65.includes('偏多'));

  const m50 = buildSummaryMessage({
    trade_date: '2026-06-08',
    index_value: 50,
    status: 'ok',
    components: makeComponents(),
  });
  assert('grade 中性 (>=40)', m50.includes('中性'));

  const m25 = buildSummaryMessage({
    trade_date: '2026-06-08',
    index_value: 25,
    status: 'ok',
    components: makeComponents(),
  });
  assert('grade 偏空 (>=20)', m25.includes('偏空'));

  const m10 = buildSummaryMessage({
    trade_date: '2026-06-08',
    index_value: 10,
    status: 'ok',
    components: makeComponents(),
  });
  assert('grade 极度悲观 (<20)', m10.includes('极度悲观'));

  // partial 标记
  const mPartial = buildSummaryMessage({
    trade_date: '2026-06-08',
    index_value: 50,
    status: 'partial',
    components: makeComponents(),
  });
  assert('partial 标记', mPartial.includes('partial'));

  // 数字格式
  assert('include trade_date', m50.includes('2026-06-08'));
  assert('include 涨停数', m50.includes('涨停50'));
  assert('include 跌停数', m50.includes('跌停5'));
  assert('include 北向 z', m50.includes('北向z='));

  // null z-score → '-'
  const mNull = buildSummaryMessage({
    trade_date: '2026-06-08',
    index_value: 50,
    status: 'ok',
    components: makeComponents({ northZ: null, marginZ: null, qaZ: null }),
  });
  assert('null z displays as -', mNull.includes('北向z=-'));
}

// ---------------------------------------------------------------------------
// 10. computeAndPersist — happy path (4 维度齐全)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_Happy(): Promise<void> {
  // 构造 7 天 northbound + margin + qa 时序, target 当日有数据
  const dates = [
    '2026-06-01',
    '2026-06-02',
    '2026-06-03',
    '2026-06-04',
    '2026-06-05',
    '2026-06-06',
    '2026-06-07',
    '2026-06-08',
  ];
  // northbound 持仓 — diff 之后是 [1,2,3,4,5,6,7] (mean=4, sd=2.16, target=7 → z≈1.39)
  const northSeries = dates.map((d, i) => ({ date: d, total: 1000 + i * (i + 1) }));
  // i=0:1000 i=1:1002 i=2:1006 i=3:1012 i=4:1020 i=5:1030 i=6:1042 i=7:1056
  // diffs: 2,4,6,8,10,12,14 — target=14, history=[2,4,6,8,10,12] mean=7 sd≈3.74 z≈1.87

  // margin: 直接的 净买入 时序
  const marginSeries = dates.map((d, i) => ({ date: d, net_buy_yi: 10 + i * 2 }));
  // 10,12,14,16,18,20,22,24 — target=24, history=[10..22] mean=16 sd=4.32 z≈1.85

  const qaSeries = dates.map((d, i) => ({ date: d, total: 1000 + i * 100 }));

  const state = emptyState({
    limitUpCount: 80,
    limitDownCount: 5,
    northSeries,
    marginSeries,
    qaSeries,
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({
    trade_date: '2026-06-08',
    lookback_days: 7,
    min_observations: 5,
    sigmoid_scale: 30,
  });

  assertEqual('happy: trade_date', r.trade_date, '2026-06-08');
  assertEqual('happy: status=ok', r.status, 'ok');
  assertEqual('happy: persisted=true', r.persisted, true);
  assertEqual('happy: dry_run=false', r.dry_run, false);
  assertEqual('happy: 1 save call', state.saves.length, 1);
  assert(
    'happy: limit_up & limit_down components',
    r.components.limit_diff.limit_up_count === 80 &&
      r.components.limit_diff.limit_down_count === 5
  );
  assert(
    'happy: limit_diff.contribution = (80-5)*0.3 = 22.5',
    Math.abs(r.components.limit_diff.contribution - 22.5) < 1e-6
  );
  assert(
    'happy: northbound z_score 非 null',
    r.components.northbound.z_score !== null
  );
  assert('happy: margin z_score 非 null', r.components.margin.z_score !== null);
  assert('happy: qa_heat z_score 非 null', r.components.qa_heat.z_score !== null);
  // index_value 介于 0-100
  assert('happy: index_value 在 [0,100]', r.index_value >= 0 && r.index_value <= 100);
  // raw_score = 0.3*75 + 0.3*northZ + 0.2*marginZ + 0.2*qaZ
  // ≈ 22.5 + ~1.3 → sigmoid(~23.8, 30) ≈ 68 (偏多)
  assert('happy: index_value > 60 (偏多)', r.index_value > 60);
  // saved record sanity
  const saved = state.saves[0];
  assertEqual('saved trade_date', saved.trade_date, '2026-06-08');
  assertEqual('saved status', saved.status, 'ok');
  assertEqual('saved limit_up_count', saved.limit_up_count, 80);
  assertEqual('saved limit_down_count', saved.limit_down_count, 5);
  assert('saved components_json has 4 fields',
    'limit_diff' in saved.components_json &&
    'northbound' in saved.components_json &&
    'margin' in saved.components_json &&
    'qa_heat' in saved.components_json
  );
}

// ---------------------------------------------------------------------------
// 11. computeAndPersist — dry_run
// ---------------------------------------------------------------------------

async function testComputeAndPersist_DryRun(): Promise<void> {
  const state = emptyState({
    limitUpCount: 30,
    limitDownCount: 10,
    northSeries: [
      { date: '2026-06-01', total: 100 },
      { date: '2026-06-02', total: 110 },
      { date: '2026-06-03', total: 120 },
      { date: '2026-06-04', total: 130 },
      { date: '2026-06-05', total: 140 },
      { date: '2026-06-06', total: 150 },
      { date: '2026-06-07', total: 160 },
      { date: '2026-06-08', total: 170 },
    ],
    marginSeries: [],
    qaSeries: [],
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({
    trade_date: '2026-06-08',
    lookback_days: 7,
    dry_run: true,
  });
  assertEqual('dry_run: persisted=false', r.persisted, false);
  assertEqual('dry_run: dry_run=true', r.dry_run, true);
  assertEqual('dry_run: 0 save calls', state.saves.length, 0);
}

// ---------------------------------------------------------------------------
// 12. computeAndPersist — partial (北向 + 融资 + 问答 全空)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_Partial(): Promise<void> {
  // 仅 limit_up & limit_down 可用, 其他 3 维度空时序 → 3 个 z=null
  const state = emptyState({
    limitUpCount: 50,
    limitDownCount: 5,
    northSeries: [],
    marginSeries: [],
    qaSeries: [],
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  // limit_diff 可用 → 1/4 dimension available → partial
  assertEqual('partial: status=partial', r.status, 'partial');
  assertEqual('partial: persisted=true', r.persisted, true);
  // 3 个 z_score 是 null
  assertEqual('partial: north z null', r.components.northbound.z_score, null);
  assertEqual('partial: margin z null', r.components.margin.z_score, null);
  assertEqual('partial: qa z null', r.components.qa_heat.z_score, null);
  // limit_diff contribution = (50-5)*0.3 = 13.5
  assert(
    'partial: limit_diff contribution=13.5',
    Math.abs(r.components.limit_diff.contribution - 13.5) < 1e-6
  );
  // raw_score = 13.5 (其他 3 维度贡献=0)
  assert('partial: raw_score=13.5', Math.abs(r.raw_score - 13.5) < 1e-6);
}

// ---------------------------------------------------------------------------
// 13. computeAndPersist — failed (4 维度全部不可用)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_Failed(): Promise<void> {
  // limit-up & limit-down 都抛异常 + 其他 3 维度空时序 → 4 / 4 unavailable → failed
  const state = emptyState({
    limitUpShouldThrow: true,
    limitDownShouldThrow: true,
    northSeries: [],
    marginSeries: [],
    qaSeries: [],
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  // 注意: safeAwait 把 throw 捕获,limit_up & limit_down 都被标 error
  // → limit_diff dimension unavailable
  assertEqual('failed: status=failed', r.status, 'failed');
  assertEqual('failed: persisted=true (仍记录)', r.persisted, true);
  assertEqual('failed: index_value=50 (raw=0 中性)', r.index_value, 50);
  assertEqual('failed: raw_score=0', r.raw_score, 0);
}

// ---------------------------------------------------------------------------
// 14. computeAndPersist — saveIndex throw 时 fail-OPEN
// ---------------------------------------------------------------------------

async function testComputeAndPersist_SaveFailFailOPEN(): Promise<void> {
  const state = emptyState({
    limitUpCount: 30,
    limitDownCount: 5,
    saveShouldThrow: true,
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  // 应该不抛, 返回 persisted=false
  let threw = false;
  let r: MarketSentimentIndexResult | null = null;
  try {
    r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  } catch (e) {
    threw = true;
  }
  assertEqual('saveFail: 不抛', threw, false);
  assert('saveFail: 返回 result', r !== null);
  assertEqual('saveFail: persisted=false', r!.persisted, false);
  // 但 result 内的指数仍可用
  assert('saveFail: index_value 仍可读', r!.index_value > 0);
}

// ---------------------------------------------------------------------------
// 15. computeAndPersist — lookback 不足 (< minObs)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_LookbackTooShort(): Promise<void> {
  // 仅 3 天 northbound (diffs 仅 2 个), minObs=5 → z=null
  const state = emptyState({
    limitUpCount: 20,
    limitDownCount: 10,
    northSeries: [
      { date: '2026-06-06', total: 100 },
      { date: '2026-06-07', total: 110 },
      { date: '2026-06-08', total: 120 },
    ],
    marginSeries: [],
    qaSeries: [],
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({
    trade_date: '2026-06-08',
    lookback_days: 7,
    min_observations: 5,
  });
  // limit_diff 是 1/4 available, northbound 因 lookback 不足是 null → 仍 partial
  assertEqual('lookback short: north z null', r.components.northbound.z_score, null);
  assertEqual('lookback short: status=partial', r.status, 'partial');
}

// ---------------------------------------------------------------------------
// 16. computeAndPersist — 默认 params merging
// ---------------------------------------------------------------------------

async function testComputeAndPersist_DefaultParams(): Promise<void> {
  const state = emptyState({
    limitUpCount: 10,
    limitDownCount: 5,
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  assertEqual('default lookback_days', r.params.lookback_days, 60);
  assertEqual('default min_observations', r.params.min_observations, 5);
  assertEqual('default sigmoid_scale', r.params.sigmoid_scale, 30);
}

// ---------------------------------------------------------------------------
// 17. computeAndPersist — 自定义 params
// ---------------------------------------------------------------------------

async function testComputeAndPersist_CustomParams(): Promise<void> {
  const state = emptyState({
    limitUpCount: 100,
    limitDownCount: 0,
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({
    trade_date: '2026-06-08',
    lookback_days: 90,
    min_observations: 3,
    sigmoid_scale: 50,
  });
  assertEqual('custom lookback', r.params.lookback_days, 90);
  assertEqual('custom min_obs', r.params.min_observations, 3);
  assertEqual('custom scale', r.params.sigmoid_scale, 50);
  // index_value 计算 = sigmoid(100*0.3, 50) = sigmoid(30, 50) = 100/(1+e^-0.6) ≈ 64.57
  assertNear('custom scale → index ≈ 64.57', r.index_value, 64.5656, 1e-2);
}

// ---------------------------------------------------------------------------
// 18. computeAndPersist — components_json 完整性
// ---------------------------------------------------------------------------

async function testComputeAndPersist_ComponentsJsonStructure(): Promise<void> {
  const state = emptyState({
    limitUpCount: 5,
    limitDownCount: 2,
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  assert('result.components 4 字段',
    'limit_diff' in r.components &&
    'northbound' in r.components &&
    'margin' in r.components &&
    'qa_heat' in r.components
  );
  // saved.components_json 应该有 params 字段
  assert('saved components_json has params',
    state.saves[0] && 'params' in state.saves[0].components_json
  );
  const params = state.saves[0].components_json.params as Record<string, unknown>;
  assertEqual('params.lookback_days', params.lookback_days, 60);
  assertEqual('params.min_observations', params.min_observations, 5);
  assertEqual('params.sigmoid_scale', params.sigmoid_scale, 30);
  assert('params.start_date is ISO', typeof params.start_date === 'string');
}

// ---------------------------------------------------------------------------
// 19. computeAndPersist — 单维度抛错不阻塞其他
// ---------------------------------------------------------------------------

async function testComputeAndPersist_SingleDimensionError(): Promise<void> {
  // margin 维度抛错, 其他 3 维度正常
  // 故意让 northbound diffs 不全相等 (避免 stddev=0 → z=null)
  // total = [100, 110, 130, 160, 200, 250, 310, 380]
  // diffs = [10, 20, 30, 40, 50, 60, 70]
  const state = emptyState({
    limitUpCount: 50,
    limitDownCount: 5,
    marginShouldThrow: true,
    northSeries: [
      { date: '2026-06-01', total: 100 },
      { date: '2026-06-02', total: 110 },
      { date: '2026-06-03', total: 130 },
      { date: '2026-06-04', total: 160 },
      { date: '2026-06-05', total: 200 },
      { date: '2026-06-06', total: 250 },
      { date: '2026-06-07', total: 310 },
      { date: '2026-06-08', total: 380 },
    ],
    // qa: 增长率非线性, 避免常数序列
    qaSeries: [
      { date: '2026-06-01', total: 1000 },
      { date: '2026-06-02', total: 1100 },
      { date: '2026-06-03', total: 1250 },
      { date: '2026-06-04', total: 1450 },
      { date: '2026-06-05', total: 1700 },
      { date: '2026-06-06', total: 2000 },
      { date: '2026-06-07', total: 2350 },
      { date: '2026-06-08', total: 2750 },
    ],
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({
    trade_date: '2026-06-08',
    lookback_days: 7,
    min_observations: 5,
  });
  // margin error 应该被记录在 error 字段
  assert('single-dim err: margin error 非 null', r.components.margin.error !== null);
  // 其他 3 维度 ok → 3/4 available → partial
  assertEqual('single-dim err: status=partial', r.status, 'partial');
  // margin z=null
  assertEqual('single-dim err: margin z null', r.components.margin.z_score, null);
  // 其他 z 非 null
  assert('single-dim err: north z 非 null', r.components.northbound.z_score !== null);
  assert('single-dim err: qa z 非 null', r.components.qa_heat.z_score !== null);
}

// ---------------------------------------------------------------------------
// 20. computeAndPersist — 默认 trade_date (今日)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_DefaultTradeDate(): Promise<void> {
  const state = emptyState({ limitUpCount: 0, limitDownCount: 0 });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({});
  // 默认 trade_date 应该是今日 ISO (YYYY-MM-DD 长度 10)
  assert('default trade_date is ISO format', /^\d{4}-\d{2}-\d{2}$/.test(r.trade_date));
}

// ---------------------------------------------------------------------------
// 21. computeAndPersist — index_value rounding (3 位小数)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_Rounding(): Promise<void> {
  const state = emptyState({
    limitUpCount: 50,
    limitDownCount: 5,
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  // 小数位数 ≤ 3
  const str = r.index_value.toString();
  const decimalPart = str.split('.')[1] || '';
  assert('index_value ≤ 3 小数位', decimalPart.length <= 3);
  // raw_score ≤ 4 小数位
  const rawStr = r.raw_score.toString();
  const rawDec = rawStr.split('.')[1] || '';
  assert('raw_score ≤ 4 小数位', rawDec.length <= 4);
}

// ---------------------------------------------------------------------------
// 22. computeAndPersist — limit_diff 仅 limit_up_count 错 (limit_down ok)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_OnlyLimitUpError(): Promise<void> {
  const state = emptyState({
    limitUpShouldThrow: true,
    limitDownCount: 10,
  });
  const svc = new MarketSentimentIndexService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  // limit_up_count=null (因为 error), limit_down_count=10
  assertEqual('only-lu-err: limit_up_count null', r.components.limit_diff.limit_up_count, null);
  assertEqual('only-lu-err: limit_down_count=10', r.components.limit_diff.limit_down_count, 10);
  // limit_diff dimension 仍 available (limitDiffMissing 需要 BOTH error)
  // diff = 0 - 10 = -10 (fallback to 0 for limitUpCount)
  // raw_score = -10 * 0.3 = -3
  assertEqual('only-lu-err: raw_score=-3', r.raw_score, -3);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 纯函数
  testConstants();
  testNormalizeDateOnly();
  testIsoDateMinusDays();
  testMean();
  testSampleStddev();
  testComputeZScore();
  testSigmoidNormalize();
  testComputeDailyDiffsNaN();
  // 修正 NaN 分支后再跑 normal happy path
  testComputeDailyDiffsHappy();
  testBuildSummaryMessage();

  // service end-to-end
  await testComputeAndPersist_Happy();
  await testComputeAndPersist_DryRun();
  await testComputeAndPersist_Partial();
  await testComputeAndPersist_Failed();
  await testComputeAndPersist_SaveFailFailOPEN();
  await testComputeAndPersist_LookbackTooShort();
  await testComputeAndPersist_DefaultParams();
  await testComputeAndPersist_CustomParams();
  await testComputeAndPersist_ComponentsJsonStructure();
  await testComputeAndPersist_SingleDimensionError();
  await testComputeAndPersist_DefaultTradeDate();
  await testComputeAndPersist_Rounding();
  await testComputeAndPersist_OnlyLimitUpError();

  console.log(
    `\n✅ ${passed} passed  ${failed > 0 ? '❌ ' + failed + ' failed' : '0 failed'}  ` +
      `total=${passed + failed}`
  );
  if (failed > 0) process.exit(1);
}

// 拆分: testComputeDailyDiffs 的 happy path 独立
function testComputeDailyDiffsHappy(): void {
  assertEqual('diffs empty', computeDailyDiffs([]), []);
  assertEqual(
    'diffs single',
    computeDailyDiffs([{ date: '2026-06-01', total: 100 }]),
    []
  );
  const d = computeDailyDiffs([
    { date: '2026-06-01', total: 100 },
    { date: '2026-06-02', total: 110 },
    { date: '2026-06-03', total: 105 },
  ]);
  assertEqual('diffs n=3 len=2', d.length, 2);
  assertEqual('diffs[0]', d[0], { date: '2026-06-02', diff: 10 });
  assertEqual('diffs[1]', d[1], { date: '2026-06-03', diff: -5 });
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
