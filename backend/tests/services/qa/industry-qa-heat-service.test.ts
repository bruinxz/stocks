/**
 * IndustryQAHeatService 单元测试 (US-121 QA-004).
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/qa/industry-qa-heat-service.test.ts
 *
 * DB-less — 全程注入 fake IndustryQAHeatDataSource (与 qa-leading-signal-detector 同款模式),
 * 不动 Sequelize.
 *
 * 覆盖维度:
 *   - WEIGHTS 常量冻结 + 数值精度;
 *   - 纯函数:
 *     - computeActiveScore (零/负 questions / rate 边界 [0,1] / 公式正确);
 *     - clampLookbackDays / clampTopN 边界;
 *     - pickTopSubtopicFromStats (raw_payload 优先 / 降级 top_subtopic / tie-break /
 *       空数组 / 未知 subtopic 跳过);
 *     - aggregateStatsByStock (多周 sum / answer_rate 加权 / stock_name 取最近一周非空 /
 *       answer_count > questions_count 兜底 clamp);
 *     - rankTopActive (排序 / tie-break 多级 / active_score=0 剔除 / top N 截取);
 *     - rowToStatLike / stripSymbolSuffix;
 *     - getSinceIso;
 *   - service.getHotStocksInIndustry:
 *     - happy path: 行业 + 多 stock + 多周 → top 10 排序 + 数据完整 (AC 主验收);
 *     - 行业空字符串 throw;
 *     - 行业无 stock → items=[] total_stocks=0;
 *     - 行业有 stock 但无 stat → items=[] total_stocks=N;
 *     - listStatsForStocksSince throw → fail-OPEN items=[] error 字段;
 *     - listStocksByIndustry throw → fail-OPEN items=[] error 字段;
 *     - 跨行业脏 stat 数据 guard (stat.stock_code 不在 industry 内 → 忽略);
 *     - active_score=0 stock 剔除 (零问题不展示);
 *     - top N 限制 (5 stock 但 top=2 → 只返 2);
 *     - stock_name 优先 Stock.name (DataSource), 退化 stat.stock_name.
 */

import {
  WEIGHTS,
  DEFAULT_LOOKBACK_DAYS,
  MAX_LOOKBACK_DAYS,
  DEFAULT_TOP_N,
  MAX_TOP_N,
  computeActiveScore,
  clampLookbackDays,
  clampTopN,
  pickTopSubtopicFromStats,
  aggregateStatsByStock,
  rankTopActive,
  rowToStatLike,
  stripSymbolSuffix,
  getSinceIso,
  StatLike,
  StockActiveSnapshot,
  StockBasicLike,
  IndustryQAHeatDataSource,
  IndustryQAHeatService,
} from '../../../src/services/qa/IndustryQAHeatService';
import { TOPIC_SUBCATEGORIES } from '../../../src/services/EastMoneyQATopicService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function assertClose(name: string, actual: number, expected: number, tol = 1e-6): void {
  const diff = Math.abs(actual - expected);
  assert(name, diff <= tol, `actual=${actual} expected=${expected} diff=${diff}`);
}

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

function stat(
  code: string,
  week: string,
  q: number,
  a: number,
  rate: number,
  topSub: string,
  opts: { stock_name?: string | null; raw_payload?: Record<string, unknown> | null } = {}
): StatLike {
  return {
    stock_code: code,
    stock_name: opts.stock_name === undefined ? null : opts.stock_name,
    week_start: week,
    questions_count: q,
    answer_count: a,
    answer_rate: rate,
    top_subtopic: topSub,
    raw_payload: opts.raw_payload === undefined ? null : opts.raw_payload,
  };
}

// ---------------------------------------------------------------------------
// 常量冻结
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assert('WEIGHTS frozen', Object.isFrozen(WEIGHTS));
  assert('ANSWER_RATE_WEIGHT = 0.5', WEIGHTS.ANSWER_RATE_WEIGHT === 0.5);
  assert('DEFAULT_LOOKBACK_DAYS = 7', DEFAULT_LOOKBACK_DAYS === 7);
  assert('MAX_LOOKBACK_DAYS = 365', MAX_LOOKBACK_DAYS === 365);
  assert('DEFAULT_TOP_N = 10', DEFAULT_TOP_N === 10);
  assert('MAX_TOP_N = 100', MAX_TOP_N === 100);
}

// ---------------------------------------------------------------------------
// computeActiveScore
// ---------------------------------------------------------------------------

function testComputeActiveScore(): void {
  assertEqual('q=0 → 0', computeActiveScore(0, 0.5), 0);
  assertEqual('q<0 → 0', computeActiveScore(-5, 0.5), 0);
  assertEqual('q=NaN → 0', computeActiveScore(NaN, 0.5), 0);
  // q=10, rate=0 → 10 * 1.0 = 10
  assertEqual('rate=0 baseline', computeActiveScore(10, 0), 10);
  // q=10, rate=1 → 10 * 1.5 = 15
  assertEqual('rate=1 max', computeActiveScore(10, 1), 15);
  // q=10, rate=0.5 → 10 * 1.25 = 12.5
  assertEqual('rate=0.5', computeActiveScore(10, 0.5), 12.5);
  // rate 负数 clamp 到 0
  assertEqual('rate<0 clamp 0', computeActiveScore(10, -0.5), 10);
  // rate>1 clamp 到 1
  assertEqual('rate>1 clamp 1', computeActiveScore(10, 2.0), 15);
  // rate=NaN → 视为 0
  assertEqual('rate=NaN → q', computeActiveScore(10, NaN), 10);
}

// ---------------------------------------------------------------------------
// clampLookbackDays / clampTopN
// ---------------------------------------------------------------------------

function testClampLookbackDays(): void {
  assertEqual('undef → 默认 7', clampLookbackDays(undefined), 7);
  assertEqual('合法 30', clampLookbackDays(30), 30);
  assertEqual('< 1 → 1', clampLookbackDays(0), 1);
  assertEqual('负数 → 1', clampLookbackDays(-100), 1);
  assertEqual('> max → cap', clampLookbackDays(99999), MAX_LOOKBACK_DAYS);
  assertEqual('NaN → 默认', clampLookbackDays(NaN), DEFAULT_LOOKBACK_DAYS);
  assertEqual('小数向下', clampLookbackDays(7.9), 7);
}

function testClampTopN(): void {
  assertEqual('undef → 默认 10', clampTopN(undefined), 10);
  assertEqual('合法 5', clampTopN(5), 5);
  assertEqual('0 → 1', clampTopN(0), 1);
  assertEqual('负数 → 1', clampTopN(-3), 1);
  assertEqual('> max → cap', clampTopN(999), MAX_TOP_N);
  assertEqual('NaN → 默认', clampTopN(NaN), DEFAULT_TOP_N);
  assertEqual('小数向下', clampTopN(10.7), 10);
}

// ---------------------------------------------------------------------------
// pickTopSubtopicFromStats
// ---------------------------------------------------------------------------

function testPickTopSubtopicEmpty(): void {
  assertEqual('空 → other_general', pickTopSubtopicFromStats([]), TOPIC_SUBCATEGORIES.OTHER_GENERAL);
  assertEqual(
    '非数组 → other_general',
    pickTopSubtopicFromStats(null as any),
    TOPIC_SUBCATEGORIES.OTHER_GENERAL
  );
}

function testPickTopSubtopicRawPayloadPriority(): void {
  // 用 raw_payload subtopic_distribution: earnings_forecast=10, new_product=5
  const stats: StatLike[] = [
    stat('600519', '2026-06-15', 15, 10, 0.67, TOPIC_SUBCATEGORIES.OTHER_GENERAL, {
      raw_payload: {
        subtopic_distribution: {
          [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 10,
          [TOPIC_SUBCATEGORIES.NEW_PRODUCT]: 5,
        },
      },
    }),
  ];
  assertEqual(
    'raw_payload subtopic 优先',
    pickTopSubtopicFromStats(stats),
    TOPIC_SUBCATEGORIES.EARNINGS_FORECAST
  );
}

function testPickTopSubtopicFallbackToTopSubtopic(): void {
  // 无 raw_payload 时, 用 top_subtopic 出现次数
  const stats: StatLike[] = [
    stat('600519', '2026-06-08', 5, 2, 0.4, TOPIC_SUBCATEGORIES.NEW_PRODUCT),
    stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.NEW_PRODUCT),
    stat('600519', '2026-06-22', 8, 3, 0.375, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST),
  ];
  // NEW_PRODUCT 2 次 > EARNINGS_FORECAST 1 次
  assertEqual(
    'fallback top_subtopic 次数',
    pickTopSubtopicFromStats(stats),
    TOPIC_SUBCATEGORIES.NEW_PRODUCT
  );
}

function testPickTopSubtopicTieBreakPriority(): void {
  // 两 subtopic 同分, 按 TOPIC_SUBCATEGORY_PRIORITY (earnings_forecast 优先级最高)
  const stats: StatLike[] = [
    stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL, {
      raw_payload: {
        subtopic_distribution: {
          [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 5,
          [TOPIC_SUBCATEGORIES.NEW_PRODUCT]: 5,
        },
      },
    }),
  ];
  assertEqual(
    'tie → priority 高者',
    pickTopSubtopicFromStats(stats),
    TOPIC_SUBCATEGORIES.EARNINGS_FORECAST
  );
}

function testPickTopSubtopicUnknownSkipped(): void {
  // 未知 subtopic 字符串应跳过, 不污染统计
  const stats: StatLike[] = [
    stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL, {
      raw_payload: {
        subtopic_distribution: {
          unknown_topic: 100,
          [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 1,
        },
      },
    }),
  ];
  assertEqual(
    '未知 subtopic 跳过',
    pickTopSubtopicFromStats(stats),
    TOPIC_SUBCATEGORIES.EARNINGS_FORECAST
  );
}

function testPickTopSubtopicSumAcrossWeeks(): void {
  // 多周 raw_payload 加和: w1 EF=3, w2 EF=4, w2 NP=10 → NP 胜 (10 > 7)
  const stats: StatLike[] = [
    stat('600519', '2026-06-08', 3, 1, 0.33, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, {
      raw_payload: { subtopic_distribution: { [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 3 } },
    }),
    stat('600519', '2026-06-15', 14, 5, 0.36, TOPIC_SUBCATEGORIES.NEW_PRODUCT, {
      raw_payload: {
        subtopic_distribution: {
          [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 4,
          [TOPIC_SUBCATEGORIES.NEW_PRODUCT]: 10,
        },
      },
    }),
  ];
  assertEqual(
    '多周 sum, NP 胜',
    pickTopSubtopicFromStats(stats),
    TOPIC_SUBCATEGORIES.NEW_PRODUCT
  );
}

// ---------------------------------------------------------------------------
// aggregateStatsByStock
// ---------------------------------------------------------------------------

function testAggregateBasic(): void {
  const map = new Map<string, StatLike[]>();
  map.set('600519', [
    stat('600519', '2026-06-08', 10, 4, 0.4, TOPIC_SUBCATEGORIES.NEW_PRODUCT, { stock_name: '茅台' }),
    stat('600519', '2026-06-15', 20, 16, 0.8, TOPIC_SUBCATEGORIES.NEW_PRODUCT, { stock_name: '茅台' }),
  ]);
  const out = aggregateStatsByStock(map);
  const a = out.get('600519')!;
  assertEqual('q sum 30', a.questions_count_7d, 30);
  assertEqual('a sum 20', a.answer_count_7d, 20);
  // weighted rate = 20/30 ≈ 0.667
  assertClose('weighted rate', a.answer_rate_7d, 0.667, 0.001);
  assertEqual('top NEW_PRODUCT', a.top_subtopic_7d, TOPIC_SUBCATEGORIES.NEW_PRODUCT);
  // active = 30 * (1 + 0.5 * 2/3) = 30 * 1.333 = 40
  assertClose('active score', a.active_score, 40, 0.5);
  assertEqual('weeks_covered 2', a.weeks_covered, 2);
  assertEqual('stock_name 茅台', a.stock_name, '茅台');
}

function testAggregateZeroQuestions(): void {
  const map = new Map<string, StatLike[]>();
  map.set('600519', [stat('600519', '2026-06-15', 0, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL)]);
  const out = aggregateStatsByStock(map);
  const a = out.get('600519')!;
  assertEqual('q sum 0', a.questions_count_7d, 0);
  assertEqual('rate 0', a.answer_rate_7d, 0);
  assertEqual('active 0', a.active_score, 0);
}

function testAggregateAnswerExceedsQuestions(): void {
  // DB 漂移防御: answer_count > questions_count → clamp answer_count = questions_count
  const map = new Map<string, StatLike[]>();
  map.set('600519', [stat('600519', '2026-06-15', 10, 50, 5.0, TOPIC_SUBCATEGORIES.OTHER_GENERAL)]);
  const out = aggregateStatsByStock(map);
  const a = out.get('600519')!;
  assertEqual('a clamp to q', a.answer_count_7d, 10);
  assertEqual('rate clamp to 1', a.answer_rate_7d, 1);
}

function testAggregateStockNameLatestWeek(): void {
  // 多周 stock_name 不同, 取 week_start 最近的一周非空
  const map = new Map<string, StatLike[]>();
  map.set('600519', [
    stat('600519', '2026-06-08', 5, 2, 0.4, TOPIC_SUBCATEGORIES.OTHER_GENERAL, { stock_name: '旧名' }),
    stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL, { stock_name: '新名' }),
  ]);
  const out = aggregateStatsByStock(map);
  assertEqual('最近周名字', out.get('600519')!.stock_name, '新名');
}

function testAggregateStockNameSkipEmpty(): void {
  // 最近周 stock_name 是 null, 应回退到上一周非空
  const map = new Map<string, StatLike[]>();
  map.set('600519', [
    stat('600519', '2026-06-08', 5, 2, 0.4, TOPIC_SUBCATEGORIES.OTHER_GENERAL, { stock_name: '有名字' }),
    stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL, { stock_name: null }),
  ]);
  const out = aggregateStatsByStock(map);
  assertEqual('回退到上一周', out.get('600519')!.stock_name, '有名字');
}

function testAggregateEmptyArray(): void {
  const map = new Map<string, StatLike[]>();
  map.set('600519', []);
  const out = aggregateStatsByStock(map);
  assertEqual('空数组 skip', out.size, 0);
}

// ---------------------------------------------------------------------------
// rankTopActive
// ---------------------------------------------------------------------------

function makeSnap(
  code: string,
  active: number,
  q: number,
  rate: number
): StockActiveSnapshot {
  return {
    stock_code: code,
    stock_name: null,
    industry: '电池',
    questions_count_7d: q,
    answer_count_7d: Math.round(q * rate),
    answer_rate_7d: rate,
    top_subtopic_7d: TOPIC_SUBCATEGORIES.OTHER_GENERAL,
    active_score: active,
    weeks_covered: 1,
  };
}

function testRankSorting(): void {
  const snaps = [
    makeSnap('600003', 30, 20, 0.5),
    makeSnap('600001', 100, 80, 0.5),
    makeSnap('600002', 50, 40, 0.5),
  ];
  const out = rankTopActive(snaps, 10);
  assertEqual('rank 0 = 600001', out[0].stock_code, '600001');
  assertEqual('rank 1 = 600002', out[1].stock_code, '600002');
  assertEqual('rank 2 = 600003', out[2].stock_code, '600003');
}

function testRankTieBreak(): void {
  // 同 active_score → questions_count desc
  const snaps = [
    makeSnap('600002', 30, 20, 0.5),
    makeSnap('600001', 30, 30, 0.0),
  ];
  const out = rankTopActive(snaps, 10);
  assertEqual('tie active → q desc', out[0].stock_code, '600001');
}

function testRankTieBreakBystockCode(): void {
  // 同 active + 同 q + 同 rate → stock_code asc
  const snaps = [
    makeSnap('600002', 30, 20, 0.5),
    makeSnap('600001', 30, 20, 0.5),
  ];
  const out = rankTopActive(snaps, 10);
  assertEqual('tie 全部 → stock_code asc', out[0].stock_code, '600001');
}

function testRankFilterZeroScore(): void {
  const snaps = [
    makeSnap('600001', 0, 0, 0),
    makeSnap('600002', 10, 5, 0.5),
  ];
  const out = rankTopActive(snaps, 10);
  assertEqual('零分剔除', out.length, 1);
  assertEqual('保留 600002', out[0].stock_code, '600002');
}

function testRankTopNLimit(): void {
  const snaps: StockActiveSnapshot[] = [];
  for (let i = 1; i <= 5; i++) {
    snaps.push(makeSnap(`60000${i}`, i * 10, i * 5, 0.5));
  }
  const out = rankTopActive(snaps, 2);
  assertEqual('top 2 截取', out.length, 2);
  assertEqual('rank 0 最高分', out[0].stock_code, '600005');
}

// ---------------------------------------------------------------------------
// rowToStatLike / stripSymbolSuffix / getSinceIso
// ---------------------------------------------------------------------------

function testRowToStatLike(): void {
  const r: any = {
    stock_code: '600519',
    stock_name: '茅台',
    week_start: '2026-06-15',
    questions_count: '10',
    answer_count: '5',
    answer_rate: '0.500',
    top_subtopic: 'earnings_forecast',
    raw_payload: { subtopic_distribution: { earnings_forecast: 10 } },
  };
  const out = rowToStatLike(r);
  assert('q 转 number', typeof out.questions_count === 'number' && out.questions_count === 10);
  assert('rate 转 number', typeof out.answer_rate === 'number' && out.answer_rate === 0.5);
  assertEqual('raw_payload 保留', out.raw_payload, { subtopic_distribution: { earnings_forecast: 10 } });
}

function testStripSymbolSuffix(): void {
  assertEqual('SH 后缀', stripSymbolSuffix('600519.SH'), '600519');
  assertEqual('sh 前缀', stripSymbolSuffix('sh.600519'), '600519');
  assertEqual('SZ 后缀', stripSymbolSuffix('000001.SZ'), '000001');
  assertEqual('纯 6 位', stripSymbolSuffix('600519'), '600519');
  assertEqual('未知保留', stripSymbolSuffix('ABCDEF'), 'ABCDEF');
  assertEqual('空字符串', stripSymbolSuffix(''), '');
}

function testGetSinceIso(): void {
  const now = new Date('2026-06-19T00:00:00Z');
  assertEqual('7 天前', getSinceIso(7, now), '2026-06-12');
  assertEqual('0 天 = 今天 UTC', getSinceIso(0, now), '2026-06-19');
  assertEqual('30 天前', getSinceIso(30, now), '2026-05-20');
}

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeDSState {
  stocksByIndustry: Record<string, StockBasicLike[]>;
  statsByStock: Record<string, StatLike[]>;
  throwOnListStocks?: boolean;
  throwOnListStats?: boolean;
}

function makeFakeDS(state: FakeDSState): IndustryQAHeatDataSource {
  return {
    async listStocksByIndustry(industry: string): Promise<StockBasicLike[]> {
      if (state.throwOnListStocks) throw new Error('fake: listStocksByIndustry boom');
      return state.stocksByIndustry[industry] ?? [];
    },
    async listStatsForStocksSince(
      stockCodes: string[],
      _sinceIso: string
    ): Promise<StatLike[]> {
      if (state.throwOnListStats) throw new Error('fake: listStatsForStocksSince boom');
      const out: StatLike[] = [];
      for (const code of stockCodes) {
        const stats = state.statsByStock[code] ?? [];
        out.push(...stats);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// service.getHotStocksInIndustry
// ---------------------------------------------------------------------------

async function testServiceHappyPath(): Promise<void> {
  // AC 主验收: 行业内 5 只股票, 多周 stat → top 10 排序 + 完整数据
  const stocks: StockBasicLike[] = [
    { stock_code: '600001', stock_name: '银行 A' },
    { stock_code: '600002', stock_name: '银行 B' },
    { stock_code: '600003', stock_name: '银行 C' },
    { stock_code: '600004', stock_name: '银行 D' },
    { stock_code: '600005', stock_name: '银行 E' },
  ];
  const ds = makeFakeDS({
    stocksByIndustry: { 银行: stocks },
    statsByStock: {
      '600001': [stat('600001', '2026-06-15', 100, 80, 0.8, TOPIC_SUBCATEGORIES.FINANCE_OTHER)],
      '600002': [stat('600002', '2026-06-15', 50, 20, 0.4, TOPIC_SUBCATEGORIES.FINANCE_OTHER)],
      '600003': [stat('600003', '2026-06-15', 30, 5, 0.167, TOPIC_SUBCATEGORIES.FINANCE_OTHER)],
      '600004': [stat('600004', '2026-06-15', 10, 1, 0.1, TOPIC_SUBCATEGORIES.FINANCE_OTHER)],
      '600005': [stat('600005', '2026-06-15', 0, 0, 0, TOPIC_SUBCATEGORIES.FINANCE_OTHER)],
    },
  });
  const svc = new IndustryQAHeatService(ds);
  const result = await svc.getHotStocksInIndustry('银行', {
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('industry 行业名', result.industry, '银行');
  assertEqual('lookback_days 默认 7', result.lookback_days, 7);
  assertEqual('top_n 默认 10', result.top_n, 10);
  assertEqual('total_stocks 5', result.total_stocks, 5);
  // active = q * (1 + 0.5 * rate); 600001=100*1.4=140, 600002=50*1.2=60, 600003=30*1.0835~32.5
  // 600004=10*1.05=10.5, 600005=0
  assertEqual('items 4 个 (600005 零分剔除)', result.items.length, 4);
  assertEqual('rank 0 = 600001', result.items[0].stock_code, '600001');
  assertEqual('rank 0 active 140', result.items[0].active_score, 140);
  assertEqual('rank 0 stock_name 银行 A', result.items[0].stock_name, '银行 A');
  assertEqual('rank 0 industry 银行', result.items[0].industry, '银行');
  assertEqual('rank 1 = 600002', result.items[1].stock_code, '600002');
  assert('error undefined happy', result.error === undefined);
}

async function testServiceTopNLimit(): Promise<void> {
  const stocks: StockBasicLike[] = [];
  const statsByStock: Record<string, StatLike[]> = {};
  for (let i = 1; i <= 5; i++) {
    const code = `60000${i}`;
    stocks.push({ stock_code: code, stock_name: `name-${i}` });
    statsByStock[code] = [stat(code, '2026-06-15', i * 10, i * 5, 0.5, TOPIC_SUBCATEGORIES.FINANCE_OTHER)];
  }
  const ds = makeFakeDS({ stocksByIndustry: { 电池: stocks }, statsByStock });
  const svc = new IndustryQAHeatService(ds);
  const result = await svc.getHotStocksInIndustry('电池', {
    top: 2,
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('top=2 截取', result.items.length, 2);
  assertEqual('top_n 2', result.top_n, 2);
  assertEqual('rank 0 = 600005 (最高活跃)', result.items[0].stock_code, '600005');
}

async function testServiceEmptyIndustryThrows(): Promise<void> {
  const ds = makeFakeDS({ stocksByIndustry: {}, statsByStock: {} });
  const svc = new IndustryQAHeatService(ds);
  let threw = false;
  try {
    await svc.getHotStocksInIndustry('');
  } catch (e: any) {
    threw = true;
    assert('throw msg 包含 industry', String(e.message).includes('industry'));
  }
  assert('空 industry throw', threw);

  // 仅空格也算空
  let threw2 = false;
  try {
    await svc.getHotStocksInIndustry('   ');
  } catch {
    threw2 = true;
  }
  assert('全空格 throw', threw2);
}

async function testServiceNoStocksInIndustry(): Promise<void> {
  const ds = makeFakeDS({ stocksByIndustry: {}, statsByStock: {} });
  const svc = new IndustryQAHeatService(ds);
  const result = await svc.getHotStocksInIndustry('不存在的行业', {
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('total 0', result.total_stocks, 0);
  assertEqual('items 空', result.items.length, 0);
  assert('error undefined (合法空)', result.error === undefined);
}

async function testServiceNoStats(): Promise<void> {
  // 行业有 stock 但 lookback 内无 stat
  const ds = makeFakeDS({
    stocksByIndustry: { 电池: [{ stock_code: '600001', stock_name: 'A' }] },
    statsByStock: {},
  });
  const svc = new IndustryQAHeatService(ds);
  const result = await svc.getHotStocksInIndustry('电池', {
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('total 1', result.total_stocks, 1);
  assertEqual('items 空', result.items.length, 0);
  assert('error undefined', result.error === undefined);
}

async function testServiceListStatsThrows(): Promise<void> {
  // fail-OPEN: listStatsForStocksSince throw → items=[] + error
  const ds = makeFakeDS({
    stocksByIndustry: { 电池: [{ stock_code: '600001', stock_name: 'A' }] },
    statsByStock: {},
    throwOnListStats: true,
  });
  const svc = new IndustryQAHeatService(ds);
  const result = await svc.getHotStocksInIndustry('电池', {
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('total 1 (stock listing 已成功)', result.total_stocks, 1);
  assertEqual('items 空', result.items.length, 0);
  assert('error 字段存在', typeof result.error === 'string');
  assert('error 提示 stats unavailable', result.error?.includes('stats unavailable') === true);
}

async function testServiceListStocksThrows(): Promise<void> {
  // fail-OPEN: listStocksByIndustry throw → 外层 catch
  const ds = makeFakeDS({
    stocksByIndustry: {},
    statsByStock: {},
    throwOnListStocks: true,
  });
  const svc = new IndustryQAHeatService(ds);
  const result = await svc.getHotStocksInIndustry('电池', {
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('total 0 (listing 失败)', result.total_stocks, 0);
  assertEqual('items 空', result.items.length, 0);
  assert('error 字段存在', typeof result.error === 'string');
}

async function testServiceCrossIndustryStatGuard(): Promise<void> {
  // stat 数据带 stock_code 不在 industry stock 列表内 → 应忽略
  const ds = makeFakeDS({
    stocksByIndustry: { 电池: [{ stock_code: '600001', stock_name: 'A' }] },
    statsByStock: {
      '600001': [stat('600001', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL)],
      // listStatsForStocksSince 在 fake 里只对传入 codes 返回数据;
      // 模拟脏数据: 注入一条不该出现的 stat
    },
  });
  // 拦截 listStatsForStocksSince 多返一条跨行业 stat
  const dirty: IndustryQAHeatDataSource = {
    listStocksByIndustry: ds.listStocksByIndustry.bind(ds),
    async listStatsForStocksSince(): Promise<StatLike[]> {
      return [
        stat('600001', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL),
        stat('999999', '2026-06-15', 100, 80, 0.8, TOPIC_SUBCATEGORIES.OTHER_GENERAL),
      ];
    },
  };
  const svc = new IndustryQAHeatService(dirty);
  const result = await svc.getHotStocksInIndustry('电池', {
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('total 1', result.total_stocks, 1);
  assertEqual('items 仅 600001', result.items.length, 1);
  assertEqual('items[0] code 600001', result.items[0].stock_code, '600001');
}

async function testServiceStockNameFallback(): Promise<void> {
  // Stock.name (DataSource) 是 null, stat.stock_name 是 '名字 B' → 取 stat
  const ds = makeFakeDS({
    stocksByIndustry: { 电池: [{ stock_code: '600001', stock_name: null }] },
    statsByStock: {
      '600001': [
        stat('600001', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL, {
          stock_name: '名字 B',
        }),
      ],
    },
  });
  const svc = new IndustryQAHeatService(ds);
  const result = await svc.getHotStocksInIndustry('电池', {
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('Stock.name null → stat.stock_name', result.items[0].stock_name, '名字 B');
}

async function testServiceLookbackOptionPassed(): Promise<void> {
  // lookback_days=30 应被 service 接受 + clamp
  const ds = makeFakeDS({
    stocksByIndustry: { 电池: [{ stock_code: '600001', stock_name: 'A' }] },
    statsByStock: {
      '600001': [stat('600001', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL)],
    },
  });
  const svc = new IndustryQAHeatService(ds);
  const result = await svc.getHotStocksInIndustry('电池', {
    lookback_days: 30,
    top: 5,
    now: new Date('2026-06-20T00:00:00Z'),
  });
  assertEqual('lookback_days 30', result.lookback_days, 30);
  assertEqual('top_n 5', result.top_n, 5);
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testConstantsFrozen();
  testComputeActiveScore();
  testClampLookbackDays();
  testClampTopN();
  testPickTopSubtopicEmpty();
  testPickTopSubtopicRawPayloadPriority();
  testPickTopSubtopicFallbackToTopSubtopic();
  testPickTopSubtopicTieBreakPriority();
  testPickTopSubtopicUnknownSkipped();
  testPickTopSubtopicSumAcrossWeeks();
  testAggregateBasic();
  testAggregateZeroQuestions();
  testAggregateAnswerExceedsQuestions();
  testAggregateStockNameLatestWeek();
  testAggregateStockNameSkipEmpty();
  testAggregateEmptyArray();
  testRankSorting();
  testRankTieBreak();
  testRankTieBreakBystockCode();
  testRankFilterZeroScore();
  testRankTopNLimit();
  testRowToStatLike();
  testStripSymbolSuffix();
  testGetSinceIso();

  await testServiceHappyPath();
  await testServiceTopNLimit();
  await testServiceEmptyIndustryThrows();
  await testServiceNoStocksInIndustry();
  await testServiceNoStats();
  await testServiceListStatsThrows();
  await testServiceListStocksThrows();
  await testServiceCrossIndustryStatGuard();
  await testServiceStockNameFallback();
  await testServiceLookbackOptionPassed();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
