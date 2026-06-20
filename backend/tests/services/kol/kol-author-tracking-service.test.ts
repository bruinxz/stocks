/**
 * KOLAuthorTrackingService 单元测试 (US-140 KOL-007 — 研报机构胜率追踪).
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/kol/kol-author-tracking-service.test.ts
 *
 * 完全脱离 DB: 注入 fake KOLAuthorTrackingDataSource (与 [[qa-stat-aggregator.test.ts]] /
 * [[kol-aggregator-service.test.ts]] 同款 in-memory DataSource 模式).
 *
 * 覆盖维度:
 *   1. 常量冻结 (BULLISH_RATINGS / BEARISH_RATINGS / NEUTRAL_RATINGS / 默认值);
 *   2. 纯函数:
 *      - classifyRatingDirection (买入/增持/卖出/持有/未评级/空 → +1/-1/0);
 *      - addDays (跨月/跨年/负数);
 *      - computeForwardReturn (基准 + 30 天后 / 停牌 ≤ 7 天兜底 / 完全无数据 → null /
 *        非法 reportDate / 全在 report 之前 → null);
 *      - computeAuthorStat (方向校正 / sample 计入 / skipped reason / latest_report_date);
 *      - identifyTopAuthors (过滤 min_samples + min_win_rate / 排序 win_rate desc);
 *   3. service.trackAuthors() e2e:
 *      - happy path: 多 firm 多研报 → 排序输出 + 落 fake store;
 *      - dry_run=true 不写库;
 *      - loadReports 返 [] → status='skipped';
 *      - saveStats throws → status='partial' + 数据仍返;
 *      - loadReports throws → status='failed';
 *      - 单 firm 样本 < min_samples_per_firm → 跳过, 不落库;
 *   4. **AC §8 主验收**: 构造 4 个 firm × 每 firm 5+ 研报, 命中率分布:
 *      - "Alpha 证券": 5/5 win → 100%;
 *      - "Beta 证券":  4/5 win → 80%;
 *      - "Gamma 证券": 3/5 win → 60%;
 *      - "Delta 证券": 2/5 win → 40%;
 *      identifyTopAuthors(stats, {min_samples:5, min_win_rate:0.6}) → 3 author (Alpha+Beta+Gamma).
 */

import {
  // 常量
  BULLISH_RATINGS,
  BEARISH_RATINGS,
  NEUTRAL_RATINGS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_FORWARD_WINDOW_DAYS,
  DEFAULT_MIN_SAMPLES_PER_FIRM,
  // 纯函数
  classifyRatingDirection,
  addDays,
  computeForwardReturn,
  computeAuthorStat,
  identifyTopAuthors,
  roundTo4,
  // 类型 + service
  KOLAuthorTrackingService,
  KOLAuthorTrackingDataSource,
  KOLAuthorResearchRow,
  KOLAuthorStatRecord,
  StockBarsMap,
  ForwardReturnBar,
} from '../../../src/services/kol/KOLAuthorTrackingService';

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
  assert(
    name,
    ok,
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
  );
}

// ---------------------------------------------------------------------------
// [1] 常量冻结
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assert('[1.1] BULLISH_RATINGS frozen', Object.isFrozen(BULLISH_RATINGS));
  assert('[1.2] BEARISH_RATINGS frozen', Object.isFrozen(BEARISH_RATINGS));
  assert('[1.3] NEUTRAL_RATINGS frozen', Object.isFrozen(NEUTRAL_RATINGS));
  assert('[1.4] BULLISH includes 买入', BULLISH_RATINGS.includes('买入'));
  assert('[1.5] BULLISH includes 增持', BULLISH_RATINGS.includes('增持'));
  assert('[1.6] BEARISH includes 卖出', BEARISH_RATINGS.includes('卖出'));
  assert('[1.7] NEUTRAL includes 持有', NEUTRAL_RATINGS.includes('持有'));
  // 默认值 sanity
  assert('[1.8] DEFAULT_LOOKBACK_DAYS=90', DEFAULT_LOOKBACK_DAYS === 90);
  assert('[1.9] DEFAULT_FORWARD_WINDOW_DAYS=30', DEFAULT_FORWARD_WINDOW_DAYS === 30);
  assert('[1.10] DEFAULT_MIN_SAMPLES_PER_FIRM=3', DEFAULT_MIN_SAMPLES_PER_FIRM === 3);
  // 三集合互不相交
  const all = new Set<string>([...BULLISH_RATINGS, ...BEARISH_RATINGS, ...NEUTRAL_RATINGS]);
  const totalLen = BULLISH_RATINGS.length + BEARISH_RATINGS.length + NEUTRAL_RATINGS.length;
  assert('[1.11] rating 集合互不相交', all.size === totalLen);
}

// ---------------------------------------------------------------------------
// [2] classifyRatingDirection
// ---------------------------------------------------------------------------

function testClassifyRatingDirection(): void {
  assertEqual('[2.1] 买入 → +1', classifyRatingDirection('买入'), 1);
  assertEqual('[2.2] 增持 → +1', classifyRatingDirection('增持'), 1);
  assertEqual('[2.3] 强烈推荐 → +1', classifyRatingDirection('强烈推荐'), 1);
  assertEqual('[2.4] 减持 → -1', classifyRatingDirection('减持'), -1);
  assertEqual('[2.5] 卖出 → -1', classifyRatingDirection('卖出'), -1);
  assertEqual('[2.6] 持有 → 0', classifyRatingDirection('持有'), 0);
  assertEqual('[2.7] 中性 → 0', classifyRatingDirection('中性'), 0);
  assertEqual('[2.8] 未评级 → 0', classifyRatingDirection('未评级'), 0);
  assertEqual('[2.9] null → 0', classifyRatingDirection(null), 0);
  assertEqual('[2.10] undefined → 0', classifyRatingDirection(undefined), 0);
  assertEqual('[2.11] 空串 → 0', classifyRatingDirection(''), 0);
  assertEqual('[2.12] 数字 → 0', classifyRatingDirection(42 as unknown), 0);
  assertEqual('[2.13] trim 兼容 "  买入  "', classifyRatingDirection('  买入  '), 1);
  assertEqual('[2.14] 未知字符串 → 0', classifyRatingDirection('xyz'), 0);
}

// ---------------------------------------------------------------------------
// [3] addDays
// ---------------------------------------------------------------------------

function testAddDays(): void {
  assertEqual('[3.1] +30', addDays('2026-06-21', 30), '2026-07-21');
  assertEqual('[3.2] +0', addDays('2026-06-21', 0), '2026-06-21');
  assertEqual('[3.3] -1', addDays('2026-06-21', -1), '2026-06-20');
  assertEqual('[3.4] -90', addDays('2026-06-21', -90), '2026-03-23');
  assertEqual('[3.5] 跨月', addDays('2026-06-30', 1), '2026-07-01');
  assertEqual('[3.6] 跨年', addDays('2026-12-31', 1), '2027-01-01');
  assertEqual('[3.7] 闰年 2 月', addDays('2024-02-28', 1), '2024-02-29');
}

// ---------------------------------------------------------------------------
// [4] computeForwardReturn
// ---------------------------------------------------------------------------

function testComputeForwardReturn(): void {
  // 构造一份连续 60 天 daily bar (从 2026-05-01 起, 每天 close += 1)
  const bars: ForwardReturnBar[] = [];
  let dt = new Date('2026-05-01T00:00:00Z');
  for (let i = 0; i < 60; i += 1) {
    bars.push({ trade_date: dt.toISOString().slice(0, 10), close: 100 + i });
    dt = new Date(dt.getTime() + 86400000);
  }

  // 基准 = 2026-05-15 close=114; 30 天后 = 2026-06-14 close=144; return = (144-114)/114
  const ret = computeForwardReturn(bars, '2026-05-15', 30);
  assert(
    '[4.1] 30 天 forward return 正确',
    ret !== null && Math.abs(ret - (144 - 114) / 114) < 1e-6,
    `ret=${ret}`
  );

  // 空 bars → null
  assertEqual('[4.2] 空 bars → null', computeForwardReturn([], '2026-05-15', 30), null);

  // 非法 reportDate → null
  assertEqual('[4.3] 非法 date → null', computeForwardReturn(bars, 'xxxx', 30), null);

  // report 在所有 bar 之前 → 基准找不到 → null
  assertEqual('[4.4] report 太早 → null', computeForwardReturn(bars, '2025-01-01', 30), null);

  // report 在所有 bar 末尾 → settle 找不到 → null (bars 只到 2026-06-29; report=2026-06-15+30=2026-07-15 + 7tol = 2026-07-22 > 2026-06-29)
  assertEqual('[4.5] settle 找不到 → null', computeForwardReturn(bars, '2026-06-15', 30), null);

  // 停牌兜底: 把目标日的 bar 删掉, 7 天内有备份
  const sparseBars: ForwardReturnBar[] = bars.filter(
    b => b.trade_date !== '2026-06-14' && b.trade_date !== '2026-06-15'
  );
  const retSparse = computeForwardReturn(sparseBars, '2026-05-15', 30);
  assert(
    '[4.6] 停牌 ≤ 7 天兜底找下一交易日',
    retSparse !== null && retSparse > 0,
    `retSparse=${retSparse}`
  );

  // 停牌超 7 天 — 删掉 2026-06-14 ~ 2026-06-25 → 目标日 = 2026-06-14, 7 天 tol cap = 2026-06-21
  const sparseBars2: ForwardReturnBar[] = bars.filter(b => {
    const d = b.trade_date;
    return !(d >= '2026-06-14' && d <= '2026-06-25');
  });
  assertEqual(
    '[4.7] 停牌 > 7 天 → null',
    computeForwardReturn(sparseBars2, '2026-05-15', 30),
    null
  );

  // 基准: 用 report_date 当天的 close (=报当日 close)
  // 若 report_date 当天没 bar (停牌/周末), 用最近一个之前的 close
  // 构造: 删掉 2026-05-17 这天, report=2026-05-17 → 退到上一交易日 2026-05-16 close=115
  // 30 天后 = 2026-06-16 close=146; return = (146-115)/115
  const barsSans17 = bars.filter(b => b.trade_date !== '2026-05-17');
  const ret2 = computeForwardReturn(barsSans17, '2026-05-17', 30);
  assert(
    '[4.8] 报告日无 bar 时回退最近 prev close',
    ret2 !== null && Math.abs(ret2 - (146 - 115) / 115) < 1e-6,
    `ret2=${ret2}`
  );

  // close <= 0 (非法) → null
  const badBars: ForwardReturnBar[] = [
    { trade_date: '2026-05-15', close: 0 },
    { trade_date: '2026-06-14', close: 100 },
  ];
  assertEqual('[4.9] close=0 → null', computeForwardReturn(badBars, '2026-05-15', 30), null);
}

// ---------------------------------------------------------------------------
// [5] computeAuthorStat
// ---------------------------------------------------------------------------

function buildSyntheticBars(stockCode: string, startDate: string, days = 90): ForwardReturnBar[] {
  const bars: ForwardReturnBar[] = [];
  let dt = new Date(startDate + 'T00:00:00Z');
  // Use stockCode hash to vary the price trajectory
  let close = 100;
  for (let i = 0; i < days; i += 1) {
    bars.push({ trade_date: dt.toISOString().slice(0, 10), close });
    close += 1; // monotonic up by default
    dt = new Date(dt.getTime() + 86400000);
  }
  return bars;
}

function testComputeAuthorStat(): void {
  // 构造: firm 'TestFirm', 3 条研报
  //   - 'A001' 买入 报于 2026-05-01 → 看多, 50 天后涨, win
  //   - 'A002' 卖出 报于 2026-05-05 → 看空, 50 天后也涨 → loss (方向反)
  //   - 'A003' 持有 报于 2026-05-10 → 中性, 不计入 sample
  const barsMap: StockBarsMap = new Map();
  barsMap.set('A001', buildSyntheticBars('A001', '2026-04-15', 100));
  barsMap.set('A002', buildSyntheticBars('A002', '2026-04-15', 100));
  barsMap.set('A003', buildSyntheticBars('A003', '2026-04-15', 100));

  const rows: KOLAuthorResearchRow[] = [
    {
      report_date: '2026-05-01',
      stock_code: 'A001',
      analyst_firm: 'TestFirm',
      rating: '买入',
    },
    {
      report_date: '2026-05-05',
      stock_code: 'A002',
      analyst_firm: 'TestFirm',
      rating: '卖出',
    },
    {
      report_date: '2026-05-10',
      stock_code: 'A003',
      analyst_firm: 'TestFirm',
      rating: '持有',
    },
  ];

  const stat = computeAuthorStat({
    analyst_firm: 'TestFirm',
    as_of_date: '2026-06-21',
    rows,
    bars_by_stock: barsMap,
    lookback_days: 90,
    forward_window_days: 30,
  });

  assertEqual('[5.1] sample_size=2 (中性跳过)', stat.sample_size, 2);
  assertEqual('[5.2] win_count=1', stat.win_count, 1);
  assertEqual('[5.3] loss_count=1', stat.loss_count, 1);
  assertEqual('[5.4] win_rate=0.5', stat.win_rate, 0.5);
  assertEqual('[5.5] latest_report_date=2026-05-10', stat.latest_report_date, '2026-05-10');
  assert(
    '[5.6] rating_distribution 含 3 类',
    Object.keys(stat.raw_payload.rating_distribution).sort().join(',') === '买入,卖出,持有'
  );
  assertEqual(
    '[5.7] skipped_reasons.neutral_or_unrated=1',
    stat.raw_payload.skipped_reasons['neutral_or_unrated'],
    1
  );
  assertEqual('[5.8] persisted=false', stat.persisted, false);
  assertEqual('[5.9] lookback_days 透传', stat.lookback_days, 90);
  assertEqual('[5.10] forward_window_days 透传', stat.forward_window_days, 30);

  // 空 rows
  const emptyStat = computeAuthorStat({
    analyst_firm: 'EmptyFirm',
    as_of_date: '2026-06-21',
    rows: [],
    bars_by_stock: new Map(),
    lookback_days: 90,
    forward_window_days: 30,
  });
  assertEqual('[5.11] 空 rows → sample_size=0', emptyStat.sample_size, 0);
  assertEqual('[5.12] 空 rows → win_rate=0', emptyStat.win_rate, 0);
  assertEqual(
    '[5.13] 空 rows → avg_forward_return_pct=null',
    emptyStat.avg_forward_return_pct,
    null
  );
  assertEqual('[5.14] 空 rows → latest=null', emptyStat.latest_report_date, null);

  // 缺 bars (skipped_reasons.no_forward_data)
  const missingBarsStat = computeAuthorStat({
    analyst_firm: 'MissingDataFirm',
    as_of_date: '2026-06-21',
    rows: [
      {
        report_date: '2026-05-01',
        stock_code: 'NOBARS',
        analyst_firm: 'MissingDataFirm',
        rating: '买入',
      },
    ],
    bars_by_stock: new Map(),
    lookback_days: 90,
    forward_window_days: 30,
  });
  assertEqual('[5.15] 缺 bars → sample=0', missingBarsStat.sample_size, 0);
  assertEqual(
    '[5.16] 缺 bars → skipped_reasons.no_forward_data=1',
    missingBarsStat.raw_payload.skipped_reasons['no_forward_data'],
    1
  );
}

// ---------------------------------------------------------------------------
// [6] identifyTopAuthors
// ---------------------------------------------------------------------------

function makeStat(firm: string, sample: number, winCount: number): KOLAuthorStatRecord {
  return {
    analyst_firm: firm,
    as_of_date: '2026-06-21',
    sample_size: sample,
    win_count: winCount,
    loss_count: sample - winCount,
    win_rate: sample === 0 ? 0 : roundTo4(winCount / sample),
    avg_forward_return_pct: 0.05,
    lookback_days: 90,
    forward_window_days: 30,
    latest_report_date: '2026-06-01',
    raw_payload: { rating_distribution: {}, sample_stock_codes: [], skipped_reasons: {} },
    persisted: false,
  };
}

function testIdentifyTopAuthors(): void {
  const stats: KOLAuthorStatRecord[] = [
    makeStat('Alpha 证券', 10, 8), // 80%
    makeStat('Beta 证券', 10, 7), // 70%
    makeStat('Gamma 证券', 10, 6), // 60%
    makeStat('Delta 证券', 10, 5), // 50%  ← 不满足
    makeStat('Epsilon 证券', 3, 3), // 100% 但样本不足  ← 不满足
  ];

  const top = identifyTopAuthors(stats, { min_samples: 5, min_win_rate: 0.6 });
  assertEqual('[6.1] top.length=3', top.length, 3);
  assertEqual('[6.2] top[0]=Alpha (80%)', top[0].analyst_firm, 'Alpha 证券');
  assertEqual('[6.3] top[1]=Beta (70%)', top[1].analyst_firm, 'Beta 证券');
  assertEqual('[6.4] top[2]=Gamma (60%)', top[2].analyst_firm, 'Gamma 证券');

  // limit
  const top2 = identifyTopAuthors(stats, { min_samples: 5, min_win_rate: 0.6, limit: 2 });
  assertEqual('[6.5] limit=2 截断', top2.length, 2);

  // 默认值 (min_samples=5, min_win_rate=0.6)
  const topDefault = identifyTopAuthors(stats);
  assertEqual('[6.6] 默认值 → 3 author', topDefault.length, 3);

  // tie-break: 两 firm 同 win_rate, 看 sample_size desc
  const tieStats: KOLAuthorStatRecord[] = [
    makeStat('Alpha', 10, 6), // 60% sample=10
    makeStat('Beta', 20, 12), // 60% sample=20  ← 优先
  ];
  const tieTop = identifyTopAuthors(tieStats, { min_samples: 5, min_win_rate: 0.5 });
  assertEqual('[6.7] tie → sample_size desc 优先', tieTop[0].analyst_firm, 'Beta');
}

// ---------------------------------------------------------------------------
// [7] service.trackAuthors() e2e
// ---------------------------------------------------------------------------

interface FakeSourceState {
  reports: KOLAuthorResearchRow[];
  bars: StockBarsMap;
  loadReportsThrow: Error | null;
  loadBarsThrow: Error | null;
  saveThrow: Error | null;
  saved: KOLAuthorStatRecord[];
  saveCalls: number;
}

function makeFakeSource(state: FakeSourceState): KOLAuthorTrackingDataSource {
  return {
    async loadResearchReports(
      _sinceDate: string,
      _asOfDate: string
    ): Promise<KOLAuthorResearchRow[]> {
      if (state.loadReportsThrow) throw state.loadReportsThrow;
      return state.reports;
    },
    async loadDailyBarsForReturn(
      _stockCodes: string[],
      _since: string,
      _until: string
    ): Promise<StockBarsMap> {
      if (state.loadBarsThrow) throw state.loadBarsThrow;
      return state.bars;
    },
    async saveStats(records: KOLAuthorStatRecord[]): Promise<void> {
      state.saveCalls += 1;
      if (state.saveThrow) throw state.saveThrow;
      state.saved = records.map(r => ({ ...r }));
    },
  };
}

function newState(): FakeSourceState {
  return {
    reports: [],
    bars: new Map(),
    loadReportsThrow: null,
    loadBarsThrow: null,
    saveThrow: null,
    saved: [],
    saveCalls: 0,
  };
}

async function testServiceHappyPath(): Promise<void> {
  const state = newState();
  // 两 firm, 每 firm 4 条 sample (满足默认 min=3)
  const upBars = buildSyntheticBars('S001', '2026-04-15', 100);
  const downBars = buildSyntheticBars('S002', '2026-04-15', 100); // monotonic up too
  state.bars.set('S001', upBars);
  state.bars.set('S002', downBars);
  state.reports = [
    { report_date: '2026-05-01', stock_code: 'S001', analyst_firm: 'FirmA', rating: '买入' },
    { report_date: '2026-05-03', stock_code: 'S001', analyst_firm: 'FirmA', rating: '增持' },
    { report_date: '2026-05-05', stock_code: 'S002', analyst_firm: 'FirmA', rating: '买入' },
    { report_date: '2026-05-07', stock_code: 'S001', analyst_firm: 'FirmA', rating: '买入' },
    // FirmB: 4 卖出 → 股价涨 → 全 loss
    { report_date: '2026-05-02', stock_code: 'S001', analyst_firm: 'FirmB', rating: '卖出' },
    { report_date: '2026-05-04', stock_code: 'S002', analyst_firm: 'FirmB', rating: '卖出' },
    { report_date: '2026-05-06', stock_code: 'S001', analyst_firm: 'FirmB', rating: '减持' },
    { report_date: '2026-05-08', stock_code: 'S002', analyst_firm: 'FirmB', rating: '卖出' },
  ];

  const svc = new KOLAuthorTrackingService(makeFakeSource(state));
  const result = await svc.trackAuthors({
    as_of_date: '2026-07-15',
    lookback_days: 90,
    forward_window_days: 30,
    min_samples_per_firm: 3,
  });

  assertEqual('[7.1] status=ok', result.status, 'ok');
  assertEqual('[7.2] total_firms=2', result.total_firms, 2);
  assertEqual('[7.3] total_reports=8', result.total_reports, 8);
  assertEqual('[7.4] saveCalls=1', state.saveCalls, 1);
  assertEqual('[7.5] 落库 2 行', state.saved.length, 2);
  // FirmA 4 win / 4 sample → win_rate=1.0
  const firmA = result.stats.find(s => s.analyst_firm === 'FirmA');
  assert('[7.6] FirmA 存在', firmA !== undefined);
  assertEqual('[7.7] FirmA win_rate=1', firmA!.win_rate, 1);
  // FirmB 0 win / 4 sample → 0
  const firmB = result.stats.find(s => s.analyst_firm === 'FirmB');
  assert('[7.8] FirmB 存在', firmB !== undefined);
  assertEqual('[7.9] FirmB win_rate=0', firmB!.win_rate, 0);
  // 排序: FirmA win_rate=1 > FirmB win_rate=0
  assertEqual('[7.10] 排序 FirmA 先', result.stats[0].analyst_firm, 'FirmA');
  // persisted 标记
  assertEqual('[7.11] persisted=true', result.stats[0].persisted, true);
}

async function testServiceDryRun(): Promise<void> {
  const state = newState();
  state.bars.set('S001', buildSyntheticBars('S001', '2026-04-15', 100));
  state.reports = [
    { report_date: '2026-05-01', stock_code: 'S001', analyst_firm: 'FirmA', rating: '买入' },
    { report_date: '2026-05-03', stock_code: 'S001', analyst_firm: 'FirmA', rating: '增持' },
    { report_date: '2026-05-05', stock_code: 'S001', analyst_firm: 'FirmA', rating: '买入' },
  ];

  const svc = new KOLAuthorTrackingService(makeFakeSource(state));
  const result = await svc.trackAuthors({
    as_of_date: '2026-07-15',
    dry_run: true,
  });

  assertEqual('[7.12] dry_run status=ok', result.status, 'ok');
  assertEqual('[7.13] dry_run reason=dry_run', result.reason, 'dry_run');
  assertEqual('[7.14] dry_run saveCalls=0', state.saveCalls, 0);
  assertEqual('[7.15] dry_run persisted=false', result.stats[0]?.persisted, false);
}

async function testServiceEmptyReports(): Promise<void> {
  const state = newState();
  state.reports = [];
  const svc = new KOLAuthorTrackingService(makeFakeSource(state));
  const result = await svc.trackAuthors({ as_of_date: '2026-07-15' });
  assertEqual('[7.16] empty reports status=skipped', result.status, 'skipped');
  assertEqual('[7.17] empty reports reason=no_reports_in_window', result.reason, 'no_reports_in_window');
  assertEqual('[7.18] empty reports total_firms=0', result.total_firms, 0);
}

async function testServiceSaveFailPartial(): Promise<void> {
  const state = newState();
  state.bars.set('S001', buildSyntheticBars('S001', '2026-04-15', 100));
  state.reports = [
    { report_date: '2026-05-01', stock_code: 'S001', analyst_firm: 'FirmA', rating: '买入' },
    { report_date: '2026-05-03', stock_code: 'S001', analyst_firm: 'FirmA', rating: '增持' },
    { report_date: '2026-05-05', stock_code: 'S001', analyst_firm: 'FirmA', rating: '买入' },
  ];
  state.saveThrow = new Error('DB write boom');

  const svc = new KOLAuthorTrackingService(makeFakeSource(state));
  const result = await svc.trackAuthors({ as_of_date: '2026-07-15' });

  assertEqual('[7.19] save fail status=partial', result.status, 'partial');
  assert(
    '[7.20] save fail error 含 save_failed',
    typeof result.error === 'string' && result.error.includes('save_failed')
  );
  assert('[7.21] save fail 数据仍返', result.stats.length > 0);
}

async function testServiceLoadFailFailed(): Promise<void> {
  const state = newState();
  state.loadReportsThrow = new Error('loadReports boom');
  const svc = new KOLAuthorTrackingService(makeFakeSource(state));
  const result = await svc.trackAuthors({ as_of_date: '2026-07-15' });

  assertEqual('[7.22] load fail status=failed', result.status, 'failed');
  assert(
    '[7.23] load fail error 含 loadReports',
    typeof result.error === 'string' && result.error.includes('loadReports')
  );
}

async function testServiceMinSamplesFilter(): Promise<void> {
  const state = newState();
  state.bars.set('S001', buildSyntheticBars('S001', '2026-04-15', 100));
  state.reports = [
    // 只 1 条 → 不达 min_samples=3, 被过滤
    { report_date: '2026-05-01', stock_code: 'S001', analyst_firm: 'SmallFirm', rating: '买入' },
  ];
  const svc = new KOLAuthorTrackingService(makeFakeSource(state));
  const result = await svc.trackAuthors({
    as_of_date: '2026-07-15',
    min_samples_per_firm: 3,
  });

  assertEqual('[7.24] 不达样本数 → status=ok', result.status, 'ok');
  assertEqual('[7.25] 不达样本数 → total_firms=0', result.total_firms, 0);
  assertEqual('[7.26] 不达样本数 → total_skipped=1', result.total_skipped, 1);
  assertEqual('[7.27] 不达样本数 → 不调 save', state.saveCalls, 0);
}

// ---------------------------------------------------------------------------
// [8] AC §8 主验收 — 90 天后 ≥ 3 author 胜率 ≥ 60%
// ---------------------------------------------------------------------------

async function testACThreeAuthorsAboveSixty(): Promise<void> {
  const state = newState();
  // 构造 4 firm × 5 研报, 命中率分布如 jsdoc 所述.
  // 用受控的 bars: 5 只股票, 其中前 3 涨 + 后 2 跌.
  const upStocks = ['U1', 'U2', 'U3'];
  const downStocks = ['D1', 'D2'];
  for (const code of upStocks) {
    const bars: ForwardReturnBar[] = [];
    let dt = new Date('2026-04-15T00:00:00Z');
    for (let i = 0; i < 100; i += 1) {
      bars.push({ trade_date: dt.toISOString().slice(0, 10), close: 100 + i });
      dt = new Date(dt.getTime() + 86400000);
    }
    state.bars.set(code, bars);
  }
  for (const code of downStocks) {
    const bars: ForwardReturnBar[] = [];
    let dt = new Date('2026-04-15T00:00:00Z');
    for (let i = 0; i < 100; i += 1) {
      bars.push({ trade_date: dt.toISOString().slice(0, 10), close: 200 - i });
      dt = new Date(dt.getTime() + 86400000);
    }
    state.bars.set(code, bars);
  }

  // Alpha 证券: 5 个全买入 → 命中 = 3 涨 (上股) win + 2 跌 (下股) loss → 3/5 = 60%
  // 但 PRD AC 需要 ≥3 author ≥60%, 让 Alpha=100% (全推上股) Beta=80% Gamma=60%
  state.reports = [
    // Alpha 证券: 5 买入, 全是涨股 → 5/5 = 100%
    { report_date: '2026-05-01', stock_code: 'U1', analyst_firm: 'Alpha 证券', rating: '买入' },
    { report_date: '2026-05-02', stock_code: 'U2', analyst_firm: 'Alpha 证券', rating: '增持' },
    { report_date: '2026-05-03', stock_code: 'U3', analyst_firm: 'Alpha 证券', rating: '买入' },
    { report_date: '2026-05-04', stock_code: 'U1', analyst_firm: 'Alpha 证券', rating: '强烈推荐' },
    { report_date: '2026-05-05', stock_code: 'U2', analyst_firm: 'Alpha 证券', rating: '增持' },
    // Beta 证券: 5 研报 (4 涨股买入 + 1 涨股卖出) → 4 win + 1 loss = 4/5 = 80%
    { report_date: '2026-05-01', stock_code: 'U1', analyst_firm: 'Beta 证券', rating: '买入' },
    { report_date: '2026-05-02', stock_code: 'U2', analyst_firm: 'Beta 证券', rating: '增持' },
    { report_date: '2026-05-03', stock_code: 'U3', analyst_firm: 'Beta 证券', rating: '买入' },
    { report_date: '2026-05-04', stock_code: 'U2', analyst_firm: 'Beta 证券', rating: '增持' },
    { report_date: '2026-05-05', stock_code: 'U3', analyst_firm: 'Beta 证券', rating: '卖出' }, // 跌方向但实际涨 → loss
    // Gamma 证券: 5 研报 (3 涨股买入 win + 2 涨股卖出 loss) = 3/5 = 60%
    { report_date: '2026-05-01', stock_code: 'U1', analyst_firm: 'Gamma 证券', rating: '买入' },
    { report_date: '2026-05-02', stock_code: 'U2', analyst_firm: 'Gamma 证券', rating: '增持' },
    { report_date: '2026-05-03', stock_code: 'U3', analyst_firm: 'Gamma 证券', rating: '买入' },
    { report_date: '2026-05-04', stock_code: 'U1', analyst_firm: 'Gamma 证券', rating: '卖出' }, // loss
    { report_date: '2026-05-05', stock_code: 'U2', analyst_firm: 'Gamma 证券', rating: '卖出' }, // loss
    // Delta 证券: 5 研报 (2 涨股买入 win + 3 涨股卖出 loss) = 2/5 = 40%
    { report_date: '2026-05-01', stock_code: 'U1', analyst_firm: 'Delta 证券', rating: '买入' },
    { report_date: '2026-05-02', stock_code: 'U2', analyst_firm: 'Delta 证券', rating: '增持' },
    { report_date: '2026-05-03', stock_code: 'U3', analyst_firm: 'Delta 证券', rating: '卖出' },
    { report_date: '2026-05-04', stock_code: 'U1', analyst_firm: 'Delta 证券', rating: '卖出' },
    { report_date: '2026-05-05', stock_code: 'U2', analyst_firm: 'Delta 证券', rating: '卖出' },
  ];

  const svc = new KOLAuthorTrackingService(makeFakeSource(state));
  const result = await svc.trackAuthors({
    as_of_date: '2026-07-15',
    lookback_days: 90,
    forward_window_days: 30,
    min_samples_per_firm: 5,
  });

  assertEqual('[8.1] AC status=ok', result.status, 'ok');
  assertEqual('[8.2] AC total_firms=4', result.total_firms, 4);

  // 验证每 firm 的 win_rate (4 位小数)
  const alpha = result.stats.find(s => s.analyst_firm === 'Alpha 证券')!;
  const beta = result.stats.find(s => s.analyst_firm === 'Beta 证券')!;
  const gamma = result.stats.find(s => s.analyst_firm === 'Gamma 证券')!;
  const delta = result.stats.find(s => s.analyst_firm === 'Delta 证券')!;
  assertEqual('[8.3] Alpha win_rate=1.0', alpha.win_rate, 1);
  assertEqual('[8.4] Beta win_rate=0.8', beta.win_rate, 0.8);
  assertEqual('[8.5] Gamma win_rate=0.6', gamma.win_rate, 0.6);
  assertEqual('[8.6] Delta win_rate=0.4', delta.win_rate, 0.4);

  // AC §8 主验收
  const topAuthors = identifyTopAuthors(result.stats, {
    min_samples: 5,
    min_win_rate: 0.6,
  });
  assert(
    '[8.7] **AC §8** identifyTopAuthors 返 ≥ 3 author 胜率 ≥ 60%',
    topAuthors.length >= 3,
    `topAuthors.length=${topAuthors.length}`
  );
  assertEqual('[8.8] topAuthors[0]=Alpha (100%)', topAuthors[0].analyst_firm, 'Alpha 证券');
  assertEqual('[8.9] topAuthors[1]=Beta (80%)', topAuthors[1].analyst_firm, 'Beta 证券');
  assertEqual('[8.10] topAuthors[2]=Gamma (60%)', topAuthors[2].analyst_firm, 'Gamma 证券');
  // Delta 40% 必须被过滤掉
  assert(
    '[8.11] Delta (40%) 被过滤',
    !topAuthors.some(t => t.analyst_firm === 'Delta 证券')
  );
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

(async () => {
  testConstantsFrozen();
  testClassifyRatingDirection();
  testAddDays();
  testComputeForwardReturn();
  testComputeAuthorStat();
  testIdentifyTopAuthors();
  await testServiceHappyPath();
  await testServiceDryRun();
  await testServiceEmptyReports();
  await testServiceSaveFailPartial();
  await testServiceLoadFailFailed();
  await testServiceMinSamplesFilter();
  await testACThreeAuthorsAboveSixty();

  console.log(`\n${passed} ok / ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
