/**
 * ConceptLinkageAnalyzer 单元测试 (US-141 KOL-008 — 同板块联动分析).
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/kol/concept-linkage-analyzer.test.ts
 *
 * 完全脱离 DB: 注入 fake ConceptLinkageDataSource (与 [[kol-author-tracking-service.test.ts]] /
 * [[kol-aggregator-service.test.ts]] 同款 in-memory DataSource 模式).
 *
 * 覆盖维度:
 *   1. 常量冻结 (DEFAULT_LINKAGE_LOOKBACK_DAYS / DEFAULT_MIN_MEMBERS_PER_CONCEPT /
 *      DEFAULT_STRONG_LINKAGE_MIN_SCORE / HOT_CONCEPT_KOL_NAME_PREFIX / XQ_HOT_CONCEPT_SOURCE);
 *   2. 纯函数:
 *      - computeDailyReturn (基准 + 当天 / 缺数据 / 非法 close / 非法 asOfDate);
 *      - computeReturnStats (空 / 单 / 多 / NaN 兜底 / Bessel n-1);
 *      - computeDirectionalCohesion (avg>0 / avg<0 / avg=0 / 空);
 *      - computeConceptLinkageStat (成员部分缺数据 / 全 down 同向 / 涨跌混合);
 *      - identifyStrongLinkages (过滤 min_samples + min_score / 排序 score desc);
 *      - addDays (跨月/跨年/负数);
 *   3. service.analyzeLinkages() e2e:
 *      - happy path: 多 concept 多成员 → 排序输出;
 *      - dry_run=true 不影响计算 + reason='dry_run';
 *      - loadConceptMembers 返空 → status='skipped';
 *      - loadConceptMembers throws → status='failed';
 *      - 单 concept 成员 < min_members_per_concept → 跳过;
 *      - 单 concept 成员有效数 < min_members (有 bars 的不够) → 跳过;
 *   4. **AC §"输出" 主验收**: 构造 4 个 concept × 每 concept 5+ 成员, 联动度分布:
 *      - "AI 芯片":   5/5 同向 → cohesion=1.0;
 *      - "新能源车":  4/5 同向 → cohesion=0.8;
 *      - "白酒":      3/5 同向 → cohesion=0.6;
 *      - "光伏":      2/5 同向 → cohesion=0.4;
 *      identifyStrongLinkages(stats, {min_samples:5, min_score:0.7}) → 2 concept (AI 芯片+新能源车).
 */

import {
  // 常量
  DEFAULT_LINKAGE_LOOKBACK_DAYS,
  DEFAULT_MIN_MEMBERS_PER_CONCEPT,
  DEFAULT_STRONG_LINKAGE_MIN_SAMPLES,
  DEFAULT_STRONG_LINKAGE_MIN_SCORE,
  DEFAULT_STRONG_LINKAGE_LIMIT,
  HOT_CONCEPT_KOL_NAME_PREFIX,
  XQ_HOT_CONCEPT_SOURCE,
  // 纯函数
  computeDailyReturn,
  computeReturnStats,
  computeDirectionalCohesion,
  computeConceptLinkageStat,
  identifyStrongLinkages,
  addDays,
  roundTo4,
  // 类型 + service
  ConceptLinkageAnalyzer,
  ConceptLinkageDataSource,
  ConceptLinkageStatRecord,
  StockBarsMap,
  DailyBarRow,
} from '../../../src/services/kol/ConceptLinkageAnalyzer';

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

function assertApprox(name: string, actual: number, expected: number, tol = 1e-6): void {
  const ok = Math.abs(actual - expected) <= tol;
  assert(name, ok, `actual=${actual} expected=${expected} tol=${tol}`);
}

// ---------------------------------------------------------------------------
// [1] 常量
// ---------------------------------------------------------------------------

function testConstants(): void {
  assert('[1.1] DEFAULT_LINKAGE_LOOKBACK_DAYS=7', DEFAULT_LINKAGE_LOOKBACK_DAYS === 7);
  assert(
    '[1.2] DEFAULT_MIN_MEMBERS_PER_CONCEPT=3',
    DEFAULT_MIN_MEMBERS_PER_CONCEPT === 3
  );
  assert(
    '[1.3] DEFAULT_STRONG_LINKAGE_MIN_SAMPLES=3',
    DEFAULT_STRONG_LINKAGE_MIN_SAMPLES === 3
  );
  assert(
    '[1.4] DEFAULT_STRONG_LINKAGE_MIN_SCORE=0.7',
    DEFAULT_STRONG_LINKAGE_MIN_SCORE === 0.7
  );
  assert('[1.5] DEFAULT_STRONG_LINKAGE_LIMIT=20', DEFAULT_STRONG_LINKAGE_LIMIT === 20);
  assert(
    '[1.6] HOT_CONCEPT_KOL_NAME_PREFIX=市场热议·',
    HOT_CONCEPT_KOL_NAME_PREFIX === '市场热议·'
  );
  assert('[1.7] XQ_HOT_CONCEPT_SOURCE=xq_hot_concept', XQ_HOT_CONCEPT_SOURCE === 'xq_hot_concept');
}

// ---------------------------------------------------------------------------
// [2] computeDailyReturn
// ---------------------------------------------------------------------------

function testComputeDailyReturn(): void {
  // 正常: 100 → 105 → 5%
  const bars1: DailyBarRow[] = [
    { trade_date: '2026-06-19', close: 100 },
    { trade_date: '2026-06-20', close: 105 },
  ];
  assertApprox('[2.1] 100→105 = 5%', computeDailyReturn(bars1, '2026-06-20')!, 0.05);

  // 跌幅
  const bars2: DailyBarRow[] = [
    { trade_date: '2026-06-19', close: 100 },
    { trade_date: '2026-06-20', close: 95 },
  ];
  assertApprox('[2.2] 100→95 = -5%', computeDailyReturn(bars2, '2026-06-20')!, -0.05);

  // asOfDate 取 ≤ 的最后 — 测周末兜底
  const bars3: DailyBarRow[] = [
    { trade_date: '2026-06-18', close: 100 },
    { trade_date: '2026-06-19', close: 110 },
  ];
  assertApprox(
    '[2.3] asOfDate 周日 → settle 用周五',
    computeDailyReturn(bars3, '2026-06-21')!,
    0.1
  );

  // 单 bar → null (无 prev)
  assert('[2.4] 单 bar → null', computeDailyReturn([{ trade_date: '2026-06-20', close: 100 }], '2026-06-20') === null);

  // 空 → null
  assert('[2.5] 空 bars → null', computeDailyReturn([], '2026-06-20') === null);

  // 非数组 → null
  assert('[2.6] 非数组 → null', computeDailyReturn(null as any, '2026-06-20') === null);

  // 非法 asOfDate → null
  assert('[2.7] 非法 asOfDate → null', computeDailyReturn(bars1, 'not-a-date') === null);

  // close=0 → null
  const bars4: DailyBarRow[] = [
    { trade_date: '2026-06-19', close: 0 },
    { trade_date: '2026-06-20', close: 100 },
  ];
  assert('[2.8] prev close=0 → null', computeDailyReturn(bars4, '2026-06-20') === null);

  // close=NaN → null
  const bars5: DailyBarRow[] = [
    { trade_date: '2026-06-19', close: 100 },
    { trade_date: '2026-06-20', close: NaN },
  ];
  assert('[2.9] settle close=NaN → null', computeDailyReturn(bars5, '2026-06-20') === null);

  // 全部在 asOfDate 之后 → null
  const bars6: DailyBarRow[] = [
    { trade_date: '2026-06-21', close: 100 },
    { trade_date: '2026-06-22', close: 105 },
  ];
  assert('[2.10] 全 bars > asOfDate → null', computeDailyReturn(bars6, '2026-06-20') === null);
}

// ---------------------------------------------------------------------------
// [3] computeReturnStats
// ---------------------------------------------------------------------------

function testComputeReturnStats(): void {
  // 空 → null/null
  const e = computeReturnStats([]);
  assert('[3.1] 空 → mean=null', e.mean === null);
  assert('[3.2] 空 → std=null', e.std === null);

  // 单 → mean=x, std=0
  const s = computeReturnStats([0.05]);
  assertApprox('[3.3] 单 → mean=0.05', s.mean!, 0.05);
  assert('[3.4] 单 → std=0', s.std === 0);

  // 多 (Bessel 校正): [1, 2, 3] → mean=2, std=1
  const m = computeReturnStats([1, 2, 3]);
  assertApprox('[3.5] [1,2,3] mean=2', m.mean!, 2);
  assertApprox('[3.6] [1,2,3] std=1 (Bessel n-1)', m.std!, 1);

  // 含 NaN → null/null
  const n = computeReturnStats([0.01, NaN, 0.03]);
  assert('[3.7] 含 NaN → mean=null', n.mean === null);
  assert('[3.8] 含 NaN → std=null', n.std === null);

  // 全相同 → std=0
  const same = computeReturnStats([0.02, 0.02, 0.02]);
  assertApprox('[3.9] 全相同 mean=0.02', same.mean!, 0.02);
  assert('[3.10] 全相同 std=0', same.std === 0);
}

// ---------------------------------------------------------------------------
// [4] computeDirectionalCohesion
// ---------------------------------------------------------------------------

function testComputeDirectionalCohesion(): void {
  // avg>0, 全正
  assert(
    '[4.1] avg>0 全正 → 1',
    computeDirectionalCohesion([0.01, 0.02, 0.03], 0.02) === 1
  );

  // avg>0, 部分正
  assert(
    '[4.2] avg>0 3/4正 → 0.75',
    computeDirectionalCohesion([0.01, 0.02, 0.03, -0.04], 0.005) === 0.75
  );

  // avg<0, 全负
  assert(
    '[4.3] avg<0 全负 → 1',
    computeDirectionalCohesion([-0.01, -0.02, -0.03], -0.02) === 1
  );

  // avg<0, 3/5 负
  assertApprox(
    '[4.4] avg<0 3/5 → 0.6',
    computeDirectionalCohesion([-0.01, -0.02, -0.03, 0.04, 0.05], -0.0014),
    0.6
  );

  // avg=0 → 0
  assert(
    '[4.5] avg=0 → 0',
    computeDirectionalCohesion([0.01, -0.01], 0) === 0
  );

  // avg=null → 0
  assert('[4.6] avg=null → 0', computeDirectionalCohesion([0.01], null) === 0);

  // 空 → 0
  assert('[4.7] 空 → 0', computeDirectionalCohesion([], 0.05) === 0);

  // r=0 不计入同向 (avg>0): 2 个 > 0, 0 不算 → 2/3
  assertApprox(
    '[4.8] avg>0 r=0 不算同向 → 2/3',
    computeDirectionalCohesion([0.01, 0, 0.02], 0.01),
    2 / 3
  );
}

// ---------------------------------------------------------------------------
// [5] computeConceptLinkageStat
// ---------------------------------------------------------------------------

function buildMonotonicBars(startClose: number, dayCount: number, dailyPct: number): DailyBarRow[] {
  // 从 2026-06-13 开始连续 dayCount 个交易日, 每天涨 dailyPct
  const start = new Date('2026-06-13T00:00:00Z');
  const bars: DailyBarRow[] = [];
  let close = startClose;
  for (let i = 0; i < dayCount; i += 1) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    bars.push({ trade_date: d.toISOString().slice(0, 10), close });
    close = close * (1 + dailyPct);
  }
  return bars;
}

function testComputeConceptLinkageStat(): void {
  // 5 成员, 3 涨 (1%/天) + 2 跌 (1%/天 跌) — avg ≈ 0.6/5 = 0.012, cohesion=3/5=0.6
  const bars: StockBarsMap = new Map();
  bars.set('S001', buildMonotonicBars(100, 10, 0.01));
  bars.set('S002', buildMonotonicBars(100, 10, 0.01));
  bars.set('S003', buildMonotonicBars(100, 10, 0.01));
  bars.set('S004', buildMonotonicBars(100, 10, -0.01));
  bars.set('S005', buildMonotonicBars(100, 10, -0.01));

  const stat = computeConceptLinkageStat({
    concept_name: '测试概念',
    as_of_date: '2026-06-22',
    member_stock_codes: ['S001', 'S002', 'S003', 'S004', 'S005'],
    bars_by_stock: bars,
  });

  assertEqual('[5.1] concept_name 透传', stat.concept_name, '测试概念');
  assertEqual('[5.2] as_of_date 透传', stat.as_of_date, '2026-06-22');
  assertEqual('[5.3] sample_size=5', stat.sample_size, 5);
  // avg = (0.01*3 + -0.01*2) / 5 = 0.002 (但每日复利后实际略有偏差)
  assert('[5.4] avg_return_pct > 0 (3 涨 2 跌)', stat.avg_return_pct! > 0);
  assert('[5.5] std_dev_pct > 0', stat.std_dev_pct! > 0);
  // cohesion = 3 涨 / 5 = 0.6
  assertEqual('[5.6] directional_cohesion=0.6', stat.directional_cohesion, 0.6);
  assertEqual('[5.7] linkage_score=0.6', stat.linkage_score, 0.6);

  // 成员部分缺数据
  const bars2: StockBarsMap = new Map();
  bars2.set('S001', buildMonotonicBars(100, 10, 0.01));
  bars2.set('S002', buildMonotonicBars(100, 10, 0.01));
  // S003, S004 没有 bars
  const stat2 = computeConceptLinkageStat({
    concept_name: '缺数据',
    as_of_date: '2026-06-22',
    member_stock_codes: ['S001', 'S002', 'S003', 'S004'],
    bars_by_stock: bars2,
  });
  assertEqual('[5.8] sample_size=2 (2 缺 bars)', stat2.sample_size, 2);
  assertEqual('[5.9] skipped_no_bars=2', stat2.raw_payload.skipped_no_bars, 2);
  // 2 个都涨 → cohesion=1.0
  assertEqual('[5.10] 2 涨 cohesion=1', stat2.directional_cohesion, 1);

  // 全 down 同向
  const barsDown: StockBarsMap = new Map();
  barsDown.set('S001', buildMonotonicBars(100, 10, -0.01));
  barsDown.set('S002', buildMonotonicBars(100, 10, -0.01));
  barsDown.set('S003', buildMonotonicBars(100, 10, -0.01));
  const statDown = computeConceptLinkageStat({
    concept_name: '全跌',
    as_of_date: '2026-06-22',
    member_stock_codes: ['S001', 'S002', 'S003'],
    bars_by_stock: barsDown,
  });
  assertEqual('[5.11] 全跌 sample_size=3', statDown.sample_size, 3);
  assert('[5.12] 全跌 avg < 0', statDown.avg_return_pct! < 0);
  assertEqual('[5.13] 全跌 cohesion=1', statDown.directional_cohesion, 1);

  // 全缺数据 → sample_size=0
  const statEmpty = computeConceptLinkageStat({
    concept_name: '空',
    as_of_date: '2026-06-22',
    member_stock_codes: ['X1', 'X2', 'X3'],
    bars_by_stock: new Map(),
  });
  assertEqual('[5.14] 全缺 sample_size=0', statEmpty.sample_size, 0);
  assertEqual('[5.15] 全缺 cohesion=0', statEmpty.directional_cohesion, 0);
  assert('[5.16] 全缺 avg=null', statEmpty.avg_return_pct === null);
  assert('[5.17] 全缺 std=null', statEmpty.std_dev_pct === null);
  assertEqual('[5.18] 全缺 skipped_no_bars=3', statEmpty.raw_payload.skipped_no_bars, 3);
}

// ---------------------------------------------------------------------------
// [6] identifyStrongLinkages
// ---------------------------------------------------------------------------

function makeStat(name: string, sample: number, score: number): ConceptLinkageStatRecord {
  return {
    concept_name: name,
    as_of_date: '2026-06-22',
    sample_size: sample,
    avg_return_pct: 0.01,
    std_dev_pct: 0.01,
    directional_cohesion: score,
    linkage_score: score,
    member_stock_codes: [],
    raw_payload: {
      member_count_total: sample,
      skipped_no_bars: 0,
      skipped_invalid_close: 0,
      returns_distribution: [],
    },
  };
}

function testIdentifyStrongLinkages(): void {
  const stats: ConceptLinkageStatRecord[] = [
    makeStat('A', 5, 0.9),
    makeStat('B', 5, 0.8),
    makeStat('C', 5, 0.7),
    makeStat('D', 5, 0.5), // 低于默认 0.7 阈值
    makeStat('E', 2, 0.9), // 样本不足 (默认 min=3)
  ];

  const top = identifyStrongLinkages(stats);
  assertEqual('[6.1] 默认 → 3 concept', top.length, 3);
  assertEqual('[6.2] 排序 score desc [0]=A', top[0].concept_name, 'A');
  assertEqual('[6.3] 排序 [1]=B', top[1].concept_name, 'B');
  assertEqual('[6.4] 排序 [2]=C', top[2].concept_name, 'C');

  // 自定 min_score=0.85
  const high = identifyStrongLinkages(stats, { min_score: 0.85 });
  assertEqual('[6.5] min_score=0.85 → 1', high.length, 1);

  // 自定 min_samples=10 → 全过滤
  const heavy = identifyStrongLinkages(stats, { min_samples: 10 });
  assertEqual('[6.6] min_samples=10 → 0', heavy.length, 0);

  // tie-break: 同 score 按 sample_size desc
  const tieStats: ConceptLinkageStatRecord[] = [
    makeStat('X', 5, 0.8),
    makeStat('Y', 10, 0.8),
  ];
  const tie = identifyStrongLinkages(tieStats);
  assertEqual('[6.7] tie → sample_size desc 优先', tie[0].concept_name, 'Y');

  // limit 截断
  const many: ConceptLinkageStatRecord[] = [];
  for (let i = 0; i < 50; i += 1) many.push(makeStat(`C${i}`, 5, 0.8));
  const lim = identifyStrongLinkages(many, { limit: 5 });
  assertEqual('[6.8] limit=5 → 5', lim.length, 5);
}

// ---------------------------------------------------------------------------
// [7] addDays
// ---------------------------------------------------------------------------

function testAddDays(): void {
  assertEqual('[7.1] addDays +1', addDays('2026-06-21', 1), '2026-06-22');
  assertEqual('[7.2] addDays -1', addDays('2026-06-21', -1), '2026-06-20');
  assertEqual('[7.3] addDays 跨月', addDays('2026-06-30', 1), '2026-07-01');
  assertEqual('[7.4] addDays 跨年', addDays('2026-12-31', 1), '2027-01-01');
  assertEqual('[7.5] addDays -30', addDays('2026-06-30', -30), '2026-05-31');
  assertEqual('[7.6] addDays 0', addDays('2026-06-21', 0), '2026-06-21');
}

// ---------------------------------------------------------------------------
// [8] service.analyzeLinkages() e2e
// ---------------------------------------------------------------------------

interface FakeSourceState {
  members: Map<string, string[]>;
  bars: StockBarsMap;
  loadMembersThrow: Error | null;
  loadBarsThrow: Error | null;
}

function makeFakeSource(state: FakeSourceState): ConceptLinkageDataSource {
  return {
    async loadConceptMembers(_since: string, _asOf: string): Promise<Map<string, string[]>> {
      if (state.loadMembersThrow) throw state.loadMembersThrow;
      return state.members;
    },
    async loadDailyBarsForStocks(
      _codes: string[],
      _since: string,
      _asOf: string
    ): Promise<StockBarsMap> {
      if (state.loadBarsThrow) throw state.loadBarsThrow;
      return state.bars;
    },
  };
}

function newState(): FakeSourceState {
  return {
    members: new Map(),
    bars: new Map(),
    loadMembersThrow: null,
    loadBarsThrow: null,
  };
}

async function testServiceHappyPath(): Promise<void> {
  const state = newState();
  // 2 concept, 每个 5 成员
  for (let i = 1; i <= 5; i += 1) {
    state.bars.set(`UP${i}`, buildMonotonicBars(100, 10, 0.01));
    state.bars.set(`DN${i}`, buildMonotonicBars(100, 10, -0.01));
  }
  state.members.set('涨概念', ['UP1', 'UP2', 'UP3', 'UP4', 'UP5']);
  state.members.set('跌概念', ['DN1', 'DN2', 'DN3', 'DN4', 'DN5']);

  const svc = new ConceptLinkageAnalyzer(makeFakeSource(state));
  const result = await svc.analyzeLinkages({
    as_of_date: '2026-06-22',
    lookback_days: 7,
    min_members_per_concept: 3,
  });

  assertEqual('[8.1] status=ok', result.status, 'ok');
  assertEqual('[8.2] total_concepts=2', result.total_concepts, 2);
  assertEqual('[8.3] total_members_evaluated=10', result.total_members_evaluated, 10);
  // 两个 concept 都 5/5 同向 → linkage_score=1, sample_size tie → 字母序
  assertEqual('[8.4] stats[0].linkage_score=1', result.stats[0].linkage_score, 1);
  assertEqual('[8.5] stats[1].linkage_score=1', result.stats[1].linkage_score, 1);
}

async function testServiceDryRun(): Promise<void> {
  const state = newState();
  for (let i = 1; i <= 5; i += 1) {
    state.bars.set(`U${i}`, buildMonotonicBars(100, 10, 0.01));
  }
  state.members.set('涨概念', ['U1', 'U2', 'U3', 'U4', 'U5']);

  const svc = new ConceptLinkageAnalyzer(makeFakeSource(state));
  const result = await svc.analyzeLinkages({
    as_of_date: '2026-06-22',
    dry_run: true,
  });

  assertEqual('[8.6] dry_run status=ok', result.status, 'ok');
  assertEqual('[8.7] dry_run reason=dry_run', result.reason, 'dry_run');
  assertEqual('[8.8] dry_run 仍含 stats', result.stats.length, 1);
}

async function testServiceEmptyMembers(): Promise<void> {
  const state = newState();
  const svc = new ConceptLinkageAnalyzer(makeFakeSource(state));
  const result = await svc.analyzeLinkages({ as_of_date: '2026-06-22' });
  assertEqual('[8.9] 空 members status=skipped', result.status, 'skipped');
  assertEqual('[8.10] reason=no_concept_members_in_window', result.reason, 'no_concept_members_in_window');
  assertEqual('[8.11] stats=[]', result.stats.length, 0);
}

async function testServiceLoadThrows(): Promise<void> {
  const state = newState();
  state.loadMembersThrow = new Error('db boom');
  const svc = new ConceptLinkageAnalyzer(makeFakeSource(state));
  const result = await svc.analyzeLinkages({ as_of_date: '2026-06-22' });
  assertEqual('[8.12] loadMembers throws → status=failed', result.status, 'failed');
  assert('[8.13] error 含 boom', (result.error || '').includes('boom'));
}

async function testServiceMinMembersFilter(): Promise<void> {
  const state = newState();
  for (let i = 1; i <= 5; i += 1) {
    state.bars.set(`U${i}`, buildMonotonicBars(100, 10, 0.01));
  }
  state.members.set('够人', ['U1', 'U2', 'U3', 'U4', 'U5']);
  state.members.set('不够人', ['U1', 'U2']);

  const svc = new ConceptLinkageAnalyzer(makeFakeSource(state));
  const result = await svc.analyzeLinkages({
    as_of_date: '2026-06-22',
    min_members_per_concept: 3,
  });
  assertEqual('[8.14] 2 concept 1 跳过', result.total_concepts, 1);
  assertEqual('[8.15] total_skipped=1', result.total_skipped_concepts, 1);
  assertEqual('[8.16] 留下来 = 够人', result.stats[0].concept_name, '够人');
}

async function testServiceMembersFineButBarsThin(): Promise<void> {
  // concept 名义 5 成员, 但只有 2 个有 bars → 不达 min_members=3, 整体跳过
  const state = newState();
  state.bars.set('U1', buildMonotonicBars(100, 10, 0.01));
  state.bars.set('U2', buildMonotonicBars(100, 10, 0.01));
  // U3, U4, U5 无 bars
  state.members.set('伪联动', ['U1', 'U2', 'U3', 'U4', 'U5']);

  const svc = new ConceptLinkageAnalyzer(makeFakeSource(state));
  const result = await svc.analyzeLinkages({
    as_of_date: '2026-06-22',
    min_members_per_concept: 3,
  });
  assertEqual('[8.17] 伪联动 被跳过', result.total_concepts, 0);
  assertEqual('[8.18] total_skipped=1', result.total_skipped_concepts, 1);
}

// ---------------------------------------------------------------------------
// [9] AC §"输出" 主验收: 4 concept × ≥5 成员 → identifyStrongLinkages 返合格
// ---------------------------------------------------------------------------

async function testACStrongLinkages(): Promise<void> {
  const state = newState();
  // 构造 4 concept × 5 成员, 联动度分别 100% / 80% / 60% / 40%
  // 用 monotonic up/down bars + 不同的 up/down 配比

  // AI 芯片: 5 涨 → cohesion=1.0
  for (let i = 1; i <= 5; i += 1) state.bars.set(`AI${i}`, buildMonotonicBars(100, 10, 0.01));
  state.members.set('AI 芯片', ['AI1', 'AI2', 'AI3', 'AI4', 'AI5']);

  // 新能源车: 4 涨 + 1 跌 → cohesion=0.8
  for (let i = 1; i <= 4; i += 1) state.bars.set(`NEV${i}`, buildMonotonicBars(100, 10, 0.01));
  state.bars.set('NEV5', buildMonotonicBars(100, 10, -0.01));
  state.members.set('新能源车', ['NEV1', 'NEV2', 'NEV3', 'NEV4', 'NEV5']);

  // 白酒: 3 涨 + 2 跌 → cohesion=0.6
  for (let i = 1; i <= 3; i += 1) state.bars.set(`LIQ${i}`, buildMonotonicBars(100, 10, 0.01));
  for (let i = 4; i <= 5; i += 1) state.bars.set(`LIQ${i}`, buildMonotonicBars(100, 10, -0.005));
  state.members.set('白酒', ['LIQ1', 'LIQ2', 'LIQ3', 'LIQ4', 'LIQ5']);

  // 光伏: 2 涨 + 3 跌 → avg<0, cohesion=3 跌/5=0.6, 但因为 sample 多数是下跌, 真实 cohesion 应该看 avg 方向
  // 这里让光伏 2 涨 0.5%, 3 跌 1% — avg<0, 同向=3 跌 → 0.6
  // 改成: 让 avg<0, 但实际相反方向比例不足 0.7 — 用 2 大涨 + 3 小跌, avg>0, cohesion=2/5=0.4
  for (let i = 1; i <= 2; i += 1) state.bars.set(`PV${i}`, buildMonotonicBars(100, 10, 0.02));
  for (let i = 3; i <= 5; i += 1) state.bars.set(`PV${i}`, buildMonotonicBars(100, 10, -0.005));
  state.members.set('光伏', ['PV1', 'PV2', 'PV3', 'PV4', 'PV5']);

  const svc = new ConceptLinkageAnalyzer(makeFakeSource(state));
  const result = await svc.analyzeLinkages({
    as_of_date: '2026-06-22',
    lookback_days: 7,
    min_members_per_concept: 5,
  });

  assertEqual('[9.1] status=ok', result.status, 'ok');
  assertEqual('[9.2] total_concepts=4', result.total_concepts, 4);

  const ai = result.stats.find(s => s.concept_name === 'AI 芯片')!;
  const nev = result.stats.find(s => s.concept_name === '新能源车')!;
  const liq = result.stats.find(s => s.concept_name === '白酒')!;
  const pv = result.stats.find(s => s.concept_name === '光伏')!;

  assertEqual('[9.3] AI 芯片 cohesion=1.0', ai.linkage_score, 1);
  assertEqual('[9.4] 新能源车 cohesion=0.8', nev.linkage_score, 0.8);
  assertEqual('[9.5] 白酒 cohesion=0.6', liq.linkage_score, 0.6);
  assertEqual('[9.6] 光伏 cohesion=0.4', pv.linkage_score, 0.4);

  // AC §"输出" 主验收: identifyStrongLinkages(min_score=0.7) → 2 concept
  const strong = identifyStrongLinkages(result.stats, {
    min_samples: 5,
    min_score: 0.7,
  });
  assert(
    '[9.7] **AC §输出** identifyStrongLinkages 返 ≥ 2 concept (linkage ≥ 70%)',
    strong.length >= 2,
    `strong.length=${strong.length}`
  );
  assertEqual('[9.8] strong[0]=AI 芯片 (100%)', strong[0].concept_name, 'AI 芯片');
  assertEqual('[9.9] strong[1]=新能源车 (80%)', strong[1].concept_name, '新能源车');
  // 白酒/光伏 必须被过滤
  assert(
    '[9.10] 白酒 (60%) 被过滤',
    !strong.some(s => s.concept_name === '白酒')
  );
  assert(
    '[9.11] 光伏 (40%) 被过滤',
    !strong.some(s => s.concept_name === '光伏')
  );
}

// ---------------------------------------------------------------------------
// [10] roundTo4
// ---------------------------------------------------------------------------

function testRoundTo4(): void {
  assertEqual('[10.1] roundTo4(0.123456)', roundTo4(0.123456), 0.1235);
  assertEqual('[10.2] roundTo4(0.1)', roundTo4(0.1), 0.1);
  assertEqual('[10.3] roundTo4(NaN)→0', roundTo4(NaN), 0);
  assertEqual('[10.4] roundTo4(Infinity)→0', roundTo4(Infinity), 0);
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

(async () => {
  testConstants();
  testComputeDailyReturn();
  testComputeReturnStats();
  testComputeDirectionalCohesion();
  testComputeConceptLinkageStat();
  testIdentifyStrongLinkages();
  testAddDays();
  testRoundTo4();
  await testServiceHappyPath();
  await testServiceDryRun();
  await testServiceEmptyMembers();
  await testServiceLoadThrows();
  await testServiceMinMembersFilter();
  await testServiceMembersFineButBarsThin();
  await testACStrongLinkages();

  console.log(`\n${passed} ok / ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
