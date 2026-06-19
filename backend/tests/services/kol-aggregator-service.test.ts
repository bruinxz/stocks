/**
 * KOLAggregatorService 单元测试 (US-056)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/services/kol-aggregator-service.test.ts
 *
 * 完全脱离 DB / Python 子进程：注入 fake KOLAggregatorDataSource。
 *
 * 覆盖维度：
 *   - 纯函数:
 *     - ratingToSentiment (7 档评级 + 模糊匹配 + null + 空字符串);
 *     - scoreNewsSentiment (4 档关键词 + 无命中 + null);
 *     - conceptRankToSentiment (rank 1-5+ + 无效值);
 *     - normalizeDateOnly (多种格式 + fallback);
 *     - isoDateMinusDays (跨月 / 跨年);
 *     - dedupeAndSort (composite PK 去重 + 时间 desc + source priority + tie-break);
 *     - mapResearchToOpinions / mapNewsToOpinions / mapHotConceptsToOpinions.
 *   - service.aggregateForStock() end-to-end:
 *     - happy path: 3 来源都有数据 → opinions ≤ limit, persisted=true;
 *     - dry-run: 不调 saveOpinions, persisted=false;
 *     - 单源失败: 其余 2 来源仍出结果, 不抛;
 *     - lookback 过滤: 老数据被剔除;
 *     - limit 裁剪: total_collected ≤ limit;
 *     - 无效 stock_code 早返回 + error 字段;
 *     - saveOpinions throw → fail-OPEN, persisted=false, 无 error 字段;
 *     - asOfDate 控时间;
 *     - by_source counter 正确.
 *   - service.aggregateForStocks(): 批量串行 + interval, succeeded/failed 计数.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  KOLAggregatorService,
  KOLAggregatorDataSource,
  KOLOpinionRecord,
  KOLNewsRow,
  KOLHotConceptRow,
  KOLResearchRow,
  KOL_SOURCES,
  RATING_SENTIMENT_MAP,
  SENTIMENT_KEYWORDS,
  SOURCE_AUTHORITY,
  SOURCE_AUTHORITY_DEFAULT,
  getSourceAuthority,
  authorityWeightedSentiment,
  ratingToSentiment,
  scoreNewsSentiment,
  conceptRankToSentiment,
  normalizeDateOnly,
  isoDateMinusDays,
  dedupeAndSort,
  mapResearchToOpinions,
  mapNewsToOpinions,
  mapHotConceptsToOpinions,
  todayLocalIso,
} from '../../src/services/KOLAggregatorService';

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

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeState {
  researchByCode: Record<string, KOLResearchRow[]>;
  newsByCode: Record<string, KOLNewsRow[]>;
  conceptsByCode: Record<string, KOLHotConceptRow[]>;
  saves: KOLOpinionRecord[][];
  saveShouldThrow?: boolean;
  researchShouldThrow?: boolean;
  newsShouldThrow?: boolean;
  conceptsShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): KOLAggregatorDataSource {
  return {
    async loadResearchReports(stockCode, _sinceDate) {
      if (state.researchShouldThrow) throw new Error('fake research outage');
      return state.researchByCode[stockCode] || [];
    },
    async fetchNews(stockCode, _limit) {
      if (state.newsShouldThrow) throw new Error('fake news outage');
      return state.newsByCode[stockCode] || [];
    },
    async fetchHotConcepts(stockCode, _limit) {
      if (state.conceptsShouldThrow) throw new Error('fake concepts outage');
      return state.conceptsByCode[stockCode] || [];
    },
    async saveOpinions(records) {
      if (state.saveShouldThrow) throw new Error('fake DB outage');
      state.saves.push([...records]);
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    researchByCode: {},
    newsByCode: {},
    conceptsByCode: {},
    saves: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. constants
// ---------------------------------------------------------------------------

function testConstants(): void {
  assertEqual('KOL_SOURCES.RESEARCH_REPORT', KOL_SOURCES.RESEARCH_REPORT, 'research_report');
  assertEqual('KOL_SOURCES.EAST_MONEY_NEWS', KOL_SOURCES.EAST_MONEY_NEWS, 'east_money_news');
  assertEqual('KOL_SOURCES.XQ_HOT_CONCEPT', KOL_SOURCES.XQ_HOT_CONCEPT, 'xq_hot_concept');
  assertEqual('rating map 买入', RATING_SENTIMENT_MAP['买入'], 1.0);
  assertEqual('rating map 减持', RATING_SENTIMENT_MAP['减持'], -0.6);
  assertEqual('rating map 卖出', RATING_SENTIMENT_MAP['卖出'], -1.0);
  assert(
    'SENTIMENT_KEYWORDS.strongNeg has 立案',
    SENTIMENT_KEYWORDS.strongNeg.includes('立案')
  );
  assert(
    'SENTIMENT_KEYWORDS.strongPos has 业绩超预期',
    SENTIMENT_KEYWORDS.strongPos.includes('业绩超预期')
  );
}

// ---------------------------------------------------------------------------
// 2. ratingToSentiment
// ---------------------------------------------------------------------------

function testRatingToSentiment(): void {
  assertEqual('rating 买入', ratingToSentiment('买入'), 1.0);
  assertEqual('rating 增持', ratingToSentiment('增持'), 0.6);
  assertEqual('rating 中性', ratingToSentiment('中性'), 0.0);
  assertEqual('rating 持有', ratingToSentiment('持有'), 0.0);
  assertEqual('rating 减持', ratingToSentiment('减持'), -0.6);
  assertEqual('rating 卖出', ratingToSentiment('卖出'), -1.0);
  // 模糊匹配
  assertEqual('rating 维持买入', ratingToSentiment('维持买入'), 1.0);
  assertEqual('rating 首次覆盖增持', ratingToSentiment('首次覆盖增持'), 0.6);
  assertEqual('rating 上调至卖出', ratingToSentiment('上调至卖出'), -1.0);
  // 空 / null / 未识别
  assertEqual('rating null', ratingToSentiment(null), null);
  assertEqual('rating undefined', ratingToSentiment(undefined), null);
  assertEqual('rating empty string', ratingToSentiment(''), null);
  assertEqual('rating whitespace', ratingToSentiment('  '), null);
  assertEqual('rating 未评级', ratingToSentiment('未评级'), null);
  assertEqual('rating gibberish', ratingToSentiment('xxx'), null);
  // 首尾空白 trim
  assertEqual('rating "  买入  "', ratingToSentiment('  买入  '), 1.0);
}

// ---------------------------------------------------------------------------
// 3. scoreNewsSentiment
// ---------------------------------------------------------------------------

function testScoreNewsSentiment(): void {
  // 强空
  assertEqual('news 强空 立案', scoreNewsSentiment('公司被立案调查'), -1.0);
  assertEqual('news 强空 退市', scoreNewsSentiment('面临退市风险'), -1.0);
  assertEqual('news 强空 黑天鹅', scoreNewsSentiment('遭遇黑天鹅事件'), -1.0);
  // 强多
  assertEqual(
    'news 强多 业绩超预期',
    scoreNewsSentiment('Q3 业绩超预期，营收同比 30%+'),
    1.0
  );
  assertEqual('news 强多 中标', scoreNewsSentiment('中标 50 亿大单'), 1.0);
  // 弱空
  assertEqual('news 弱空 下跌', scoreNewsSentiment('股价短期下跌'), -0.5);
  assertEqual('news 弱空 解禁', scoreNewsSentiment('面临解禁压力'), -0.5);
  // 弱多
  assertEqual('news 弱多 上涨', scoreNewsSentiment('行业景气度推动股价上涨'), 0.5);
  assertEqual('news 弱多 合作', scoreNewsSentiment('与华为达成合作'), 0.5);
  // 中性 / 无命中
  assertEqual('news 中性', scoreNewsSentiment('召开股东大会'), 0);
  // null / 空
  assertEqual('news null', scoreNewsSentiment(null), 0);
  assertEqual('news empty', scoreNewsSentiment(''), 0);
  // 优先级: 强空 > 强多 (同时命中, 强空胜)
  assertEqual(
    'news 强空优先 (业绩超预期 + 立案)',
    scoreNewsSentiment('业绩超预期但公司被立案'),
    -1.0
  );
  // 强多 > 弱空 (同时命中, 强多胜)
  assertEqual(
    'news 强多优先 (业绩超预期 + 调整)',
    scoreNewsSentiment('业绩超预期但近期调整'),
    1.0
  );
}

// ---------------------------------------------------------------------------
// 4. conceptRankToSentiment
// ---------------------------------------------------------------------------

function testConceptRankToSentiment(): void {
  assertEqual('rank 1', conceptRankToSentiment(1), 0.5);
  assertEqual('rank 2', conceptRankToSentiment(2), 0.4);
  assertEqual('rank 3', conceptRankToSentiment(3), 0.3);
  assertEqual('rank 4', conceptRankToSentiment(4), 0.2);
  assertEqual('rank 5', conceptRankToSentiment(5), 0.1);
  assertEqual('rank 10', conceptRankToSentiment(10), 0.1);
  assertEqual('rank 0 (无效)', conceptRankToSentiment(0), 0.1);
  assertEqual('rank null', conceptRankToSentiment(null), 0.1);
  assertEqual('rank undefined', conceptRankToSentiment(undefined), 0.1);
  assertEqual('rank NaN', conceptRankToSentiment(Number.NaN), 0.1);
}

// ---------------------------------------------------------------------------
// 5. normalizeDateOnly
// ---------------------------------------------------------------------------

function testNormalizeDateOnly(): void {
  assertEqual(
    'YYYY-MM-DD HH:mm:ss',
    normalizeDateOnly('2026-06-08 09:35:12', '2099-01-01'),
    '2026-06-08'
  );
  assertEqual('YYYY-MM-DD', normalizeDateOnly('2026-06-08', '2099-01-01'), '2026-06-08');
  assertEqual('YYYY/MM/DD', normalizeDateOnly('2026/06/08', '2099-01-01'), '2026-06-08');
  assertEqual('YYYY.MM.DD', normalizeDateOnly('2026.06.08', '2099-01-01'), '2026-06-08');
  assertEqual('YYYYMMDD', normalizeDateOnly('20260608', '2099-01-01'), '2026-06-08');
  assertEqual('null fallback', normalizeDateOnly(null, '2099-01-01'), '2099-01-01');
  assertEqual('empty fallback', normalizeDateOnly('', '2099-01-01'), '2099-01-01');
  assertEqual(
    'gibberish fallback',
    normalizeDateOnly('not a date', '2099-01-01'),
    '2099-01-01'
  );
  // 单位补零
  assertEqual('YYYY-M-D padding', normalizeDateOnly('2026-6-8', '2099-01-01'), '2026-06-08');
}

// ---------------------------------------------------------------------------
// 6. isoDateMinusDays
// ---------------------------------------------------------------------------

function testIsoDateMinusDays(): void {
  assertEqual('minus 0', isoDateMinusDays('2026-06-08', 0), '2026-06-08');
  assertEqual('minus 7', isoDateMinusDays('2026-06-08', 7), '2026-06-01');
  assertEqual('minus 30 跨月', isoDateMinusDays('2026-06-08', 30), '2026-05-09');
  assertEqual('minus 90 跨季度', isoDateMinusDays('2026-06-08', 90), '2026-03-10');
  assertEqual('minus 365 跨年', isoDateMinusDays('2026-06-08', 365), '2025-06-08');
  // 跨闰年 (2024 是闰年, 2025 不是)
  assertEqual('minus 1 跨日', isoDateMinusDays('2026-01-01', 1), '2025-12-31');
}

// ---------------------------------------------------------------------------
// 7. dedupeAndSort
// ---------------------------------------------------------------------------

function makeRec(over: Partial<KOLOpinionRecord>): KOLOpinionRecord {
  return {
    stock_code: '600519',
    kol_name: 'KOL_A',
    opinion_date: '2026-06-01',
    kol_source: KOL_SOURCES.RESEARCH_REPORT,
    opinion_summary: 'default',
    sentiment_score: 0.5,
    url: null,
    raw_payload: {},
    ...over,
  };
}

function testDedupeAndSort(): void {
  // === 时间 desc 排序 ===
  const sorted = dedupeAndSort(
    [
      makeRec({ kol_name: 'A', opinion_date: '2026-06-01' }),
      makeRec({ kol_name: 'B', opinion_date: '2026-06-05' }),
      makeRec({ kol_name: 'C', opinion_date: '2026-06-03' }),
    ],
    10
  );
  assertEqual(
    'dedupe sort 时间 desc',
    sorted.map(r => r.opinion_date),
    ['2026-06-05', '2026-06-03', '2026-06-01']
  );

  // === source authority desc: research(0.6) > concept(0.4) > news(0.3) (同日, US-034) ===
  const sourceSort = dedupeAndSort(
    [
      makeRec({ kol_name: 'A', kol_source: KOL_SOURCES.EAST_MONEY_NEWS }),
      makeRec({ kol_name: 'B', kol_source: KOL_SOURCES.XQ_HOT_CONCEPT }),
      makeRec({ kol_name: 'C', kol_source: KOL_SOURCES.RESEARCH_REPORT }),
    ],
    10
  );
  assertEqual(
    'dedupe sort source authority desc',
    sourceSort.map(r => r.kol_source),
    ['research_report', 'xq_hot_concept', 'east_money_news']
  );

  // === 同 authority 同 date, 强观点 (|sentiment| 大) 优先 (US-034) ===
  const weakStrong = dedupeAndSort(
    [
      makeRec({
        kol_name: 'weak',
        opinion_date: '2026-06-01',
        kol_source: KOL_SOURCES.RESEARCH_REPORT,
        sentiment_score: 0.0,
      }),
      makeRec({
        kol_name: 'strong',
        opinion_date: '2026-06-01',
        kol_source: KOL_SOURCES.RESEARCH_REPORT,
        sentiment_score: 1.0,
      }),
    ],
    10
  );
  assertEqual(
    'dedupe 同权威同日 强观点优先',
    weakStrong.map(r => r.kol_name),
    ['strong', 'weak']
  );

  // === 去重: composite PK (stock_code|kol_name|opinion_date) ===
  // 信息量更高的优先 (sentiment_score 非 null + summary 更长)
  const deduped = dedupeAndSort(
    [
      makeRec({
        kol_name: 'A',
        opinion_date: '2026-06-01',
        sentiment_score: null,
        opinion_summary: 'short',
      }),
      makeRec({
        kol_name: 'A',
        opinion_date: '2026-06-01',
        sentiment_score: 0.6,
        opinion_summary: 'longer detailed summary',
      }),
    ],
    10
  );
  assertEqual('dedupe 信息量优先 length', deduped.length, 1);
  assertEqual(
    'dedupe 信息量优先 保留有 score 的',
    deduped[0].opinion_summary,
    'longer detailed summary'
  );

  // === limit 裁剪 ===
  const sliced = dedupeAndSort(
    [
      makeRec({ kol_name: 'A', opinion_date: '2026-06-05' }),
      makeRec({ kol_name: 'B', opinion_date: '2026-06-04' }),
      makeRec({ kol_name: 'C', opinion_date: '2026-06-03' }),
      makeRec({ kol_name: 'D', opinion_date: '2026-06-02' }),
      makeRec({ kol_name: 'E', opinion_date: '2026-06-01' }),
    ],
    3
  );
  assertEqual('dedupe limit=3', sliced.length, 3);
  assertEqual('dedupe limit 取最新 3', sliced[0].opinion_date, '2026-06-05');

  // === 同日同源稳定 tie-break by kol_name ===
  const tieBreak = dedupeAndSort(
    [
      makeRec({ kol_name: '中信证券', opinion_date: '2026-06-01' }),
      makeRec({ kol_name: '诚通证券', opinion_date: '2026-06-01' }),
      makeRec({ kol_name: '中金公司', opinion_date: '2026-06-01' }),
    ],
    10
  );
  assertEqual(
    'dedupe tie-break by kol_name (中文 localeCompare)',
    tieBreak.map(r => r.kol_name),
    ['诚通证券', '中金公司', '中信证券']
  );
}

// ---------------------------------------------------------------------------
// 8. mappers
// ---------------------------------------------------------------------------

function testMapResearchToOpinions(): void {
  const rows: KOLResearchRow[] = [
    {
      report_date: '2026-06-01',
      analyst_firm: '中信证券',
      rating: '买入',
      report_title: 'Q3 业绩点评',
      report_pdf_url: 'https://pdf.dfcfw.com/test.pdf',
      raw_payload: { x: 1 },
    },
    {
      report_date: '2026-05-20',
      analyst_firm: '中金公司',
      rating: null,
      report_title: null,
      report_pdf_url: null,
      raw_payload: {},
    },
    // 必填项缺失 → 跳过
    {
      report_date: '',
      analyst_firm: '应被跳过',
      rating: '买入',
      report_title: 'skip me',
      report_pdf_url: null,
      raw_payload: {},
    },
  ];
  const opinions = mapResearchToOpinions('600519', rows);
  assertEqual('research mapper 跳过缺失', opinions.length, 2);
  assertEqual('research mapper 评级映射', opinions[0].sentiment_score, 1.0);
  assertEqual('research mapper summary 含评级', opinions[0].opinion_summary, 'Q3 业绩点评 [买入]');
  assertEqual('research mapper url', opinions[0].url, 'https://pdf.dfcfw.com/test.pdf');
  assertEqual('research mapper kol_source', opinions[0].kol_source, 'research_report');
  assertEqual('research mapper kol_name = firm', opinions[0].kol_name, '中信证券');
  assertEqual('research mapper null rating → 默认 summary', opinions[1].opinion_summary, '研报');
  assertEqual('research mapper null rating sentiment', opinions[1].sentiment_score, null);
}

function testMapNewsToOpinions(): void {
  const rows: KOLNewsRow[] = [
    {
      title: 'Q3 业绩超预期',
      content: '营收同比+30%, 净利润同比+50%',
      publish_time: '2026-06-08 09:35:12',
      source: '财联社',
      url: 'http://example.com/1',
      raw_payload: { a: 1 },
    },
    {
      title: '股价下跌',
      content: null,
      publish_time: null,
      source: null,
      url: null,
      raw_payload: {},
    },
    // 标题缺失 → 跳过
    {
      title: '',
      content: 'no title',
      publish_time: '2026-06-01',
      source: 'whatever',
      url: null,
      raw_payload: {},
    },
  ];
  const opinions = mapNewsToOpinions('600519', rows, '2099-01-01');
  assertEqual('news mapper 跳过空标题', opinions.length, 2);
  assertEqual('news mapper kol_source', opinions[0].kol_source, 'east_money_news');
  assertEqual('news mapper kol_name from source', opinions[0].kol_name, '财联社');
  assertEqual('news mapper publish_time → date', opinions[0].opinion_date, '2026-06-08');
  assertEqual('news mapper 强多 sentiment', opinions[0].sentiment_score, 1.0);
  assertEqual(
    'news mapper summary 含 content',
    opinions[0].opinion_summary.startsWith('Q3 业绩超预期 — 营收同比'),
    true
  );
  assertEqual('news mapper null source fallback', opinions[1].kol_name, '财经媒体');
  assertEqual('news mapper null publish_time fallback', opinions[1].opinion_date, '2099-01-01');
  assertEqual('news mapper 弱空 sentiment', opinions[1].sentiment_score, -0.5);
}

function testMapHotConceptsToOpinions(): void {
  const rows: KOLHotConceptRow[] = [
    {
      snapshot_time: '2026-06-08 02:00:00',
      concept_name: '白酒',
      concept_code: 'BK0896',
      heat: 11639,
      rank: 1,
      raw_payload: {},
    },
    {
      snapshot_time: '2026-06-08 02:00:00',
      concept_name: '电商概念',
      concept_code: 'BK0665',
      heat: 263,
      rank: 3,
      raw_payload: {},
    },
    // 概念名缺失 → 跳过
    {
      snapshot_time: '2026-06-08',
      concept_name: '',
      concept_code: 'BK_X',
      heat: 99,
      rank: 99,
      raw_payload: {},
    },
  ];
  const opinions = mapHotConceptsToOpinions('600519', rows, '2099-01-01');
  assertEqual('concept mapper 跳过空名', opinions.length, 2);
  assertEqual('concept mapper kol_source', opinions[0].kol_source, 'xq_hot_concept');
  assertEqual('concept mapper kol_name 前缀', opinions[0].kol_name, '市场热议·白酒');
  assertEqual('concept mapper rank=1 sentiment', opinions[0].sentiment_score, 0.5);
  assertEqual('concept mapper rank=3 sentiment', opinions[1].sentiment_score, 0.3);
  assertEqual('concept mapper url null', opinions[0].url, null);
  assert(
    'concept mapper summary 含 rank',
    opinions[0].opinion_summary.includes('热度第 1')
  );
  assert(
    'concept mapper summary 含 heat',
    opinions[0].opinion_summary.includes('热度值 11639')
  );
}

// ---------------------------------------------------------------------------
// 9. aggregateForStock e2e
// ---------------------------------------------------------------------------

async function testAggregate_HappyPath(): Promise<void> {
  const state = emptyState({
    researchByCode: {
      '600519': [
        {
          report_date: '2026-06-05',
          analyst_firm: '中信证券',
          rating: '买入',
          report_title: '高端白酒龙头',
          report_pdf_url: 'http://pdf/test',
          raw_payload: {},
        },
      ],
    },
    newsByCode: {
      '600519': [
        {
          title: '业绩超预期',
          content: '营收稳定增长',
          publish_time: '2026-06-04',
          source: '财联社',
          url: 'http://news/1',
          raw_payload: {},
        },
      ],
    },
    conceptsByCode: {
      '600519': [
        {
          snapshot_time: '2026-06-08',
          concept_name: '白酒',
          concept_code: 'BK0896',
          heat: 10000,
          rank: 1,
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', {
    limit: 10,
    asOfDate: '2026-06-08',
  });
  assertEqual('happy total_collected', result.total_collected, 3);
  assertEqual('happy by_source research', result.by_source.research_report, 1);
  assertEqual('happy by_source news', result.by_source.east_money_news, 1);
  assertEqual('happy by_source concept', result.by_source.xq_hot_concept, 1);
  assertEqual('happy persisted', result.persisted, true);
  assertEqual('happy saves called once', state.saves.length, 1);
  assertEqual('happy saves rows', state.saves[0].length, 3);
  assert('happy no error', result.error === undefined);
  // 排序: opinion_date desc 优先。concept @ 2026-06-08 > research @ 2026-06-05 > news @ 2026-06-04
  assertEqual('happy first opinion = latest date (concept)', result.opinions[0].kol_source, 'xq_hot_concept');
  assertEqual('happy second opinion = research', result.opinions[1].kol_source, 'research_report');
  assertEqual('happy third opinion = news', result.opinions[2].kol_source, 'east_money_news');
}

async function testAggregate_DryRun(): Promise<void> {
  const state = emptyState({
    newsByCode: {
      '600519': [
        {
          title: '中标 50 亿',
          content: null,
          publish_time: '2026-06-05',
          source: '上证报',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', {
    limit: 5,
    dryRun: true,
    asOfDate: '2026-06-08',
  });
  assertEqual('dry-run total', result.total_collected, 1);
  assertEqual('dry-run persisted=false', result.persisted, false);
  assertEqual('dry-run saves not called', state.saves.length, 0);
}

async function testAggregate_SingleSourceFailure(): Promise<void> {
  const state = emptyState({
    researchShouldThrow: true,
    newsByCode: {
      '600519': [
        {
          title: '业绩超预期',
          content: null,
          publish_time: '2026-06-05',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
    },
    conceptsByCode: {
      '600519': [
        {
          snapshot_time: '2026-06-08',
          concept_name: '白酒',
          concept_code: 'BK0896',
          heat: 10000,
          rank: 1,
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', { asOfDate: '2026-06-08' });
  assertEqual('single source failure 总数=2', result.total_collected, 2);
  assertEqual('single source failure research=0', result.by_source.research_report, 0);
  assertEqual('single source failure news=1', result.by_source.east_money_news, 1);
  assertEqual('single source failure concept=1', result.by_source.xq_hot_concept, 1);
  assert('single source failure no error 字段', result.error === undefined);
}

async function testAggregate_AllSourcesFailure(): Promise<void> {
  const state = emptyState({
    researchShouldThrow: true,
    newsShouldThrow: true,
    conceptsShouldThrow: true,
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', { asOfDate: '2026-06-08' });
  assertEqual('all sources fail total=0', result.total_collected, 0);
  assertEqual('all sources fail persisted=false', result.persisted, false);
  assertEqual('all sources fail opinions=[]', result.opinions.length, 0);
  // 注意: 每个 source 都被 safeFetch* 内层 catch, aggregate 不收到 throw, error 字段为空
  assert('all sources fail 无 outer error', result.error === undefined);
  // saveOpinions 不该被调用 (无 records)
  assertEqual('all sources fail saves not called', state.saves.length, 0);
}

async function testAggregate_LookbackFilter(): Promise<void> {
  const state = emptyState({
    newsByCode: {
      '600519': [
        {
          title: '最近新闻',
          content: null,
          publish_time: '2026-06-05',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
        {
          title: '老新闻',
          content: null,
          publish_time: '2025-01-01', // 超出 90 天 lookback
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', {
    lookbackDays: 90,
    asOfDate: '2026-06-08',
  });
  assertEqual('lookback 老新闻被剔除', result.total_collected, 1);
  assertEqual('lookback 剩下最新的', result.opinions[0].opinion_summary.startsWith('最近新闻'), true);
}

async function testAggregate_LimitCap(): Promise<void> {
  const news: KOLNewsRow[] = Array.from({ length: 15 }).map((_, i) => ({
    title: `新闻 ${i}`,
    content: null,
    publish_time: `2026-06-${String(8 - (i % 7)).padStart(2, '0')}`,
    source: `源${i % 5}`,
    url: null,
    raw_payload: {},
  }));
  const state = emptyState({
    newsByCode: { '600519': news },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', { limit: 5, asOfDate: '2026-06-08' });
  assertEqual('limit cap = 5', result.total_collected, 5);
  assertEqual('limit cap opinions length', result.opinions.length, 5);
}

async function testAggregate_InvalidCode(): Promise<void> {
  const service = new KOLAggregatorService(makeFakeSource(emptyState()));
  const result = await service.aggregateForStock('XX', {});
  assertEqual('invalid code total=0', result.total_collected, 0);
  assert('invalid code has error', typeof result.error === 'string');
  assert('invalid code error mentions format', String(result.error).includes('format'));
}

async function testAggregate_SaveFailFailOPEN(): Promise<void> {
  const state = emptyState({
    saveShouldThrow: true,
    newsByCode: {
      '600519': [
        {
          title: '业绩超预期',
          content: null,
          publish_time: '2026-06-05',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', { asOfDate: '2026-06-08' });
  // fail-OPEN: 还是返回数据 + persisted=false, 不抛
  assertEqual('save fail total=1', result.total_collected, 1);
  assertEqual('save fail persisted=false', result.persisted, false);
  assert('save fail 无 error 字段 (fail-OPEN)', result.error === undefined);
}

async function testAggregate_AsOfDate(): Promise<void> {
  // 同样的 fixture, 给两个不同 asOfDate, 验证 lookback 起点不同
  const state = emptyState({
    newsByCode: {
      '600519': [
        {
          title: '2026 新闻',
          content: null,
          publish_time: '2026-05-01',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
        {
          title: '2025 新闻',
          content: null,
          publish_time: '2025-12-01',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  // asOfDate=2026-06-01, lookback=90 → since=2026-03-03, 只保留 2026 新闻
  const r1 = await service.aggregateForStock('600519', {
    lookbackDays: 90,
    asOfDate: '2026-06-01',
  });
  assertEqual('asOfDate 2026-06-01 lookback 90 → 1 row', r1.total_collected, 1);
  // asOfDate=2026-06-01, lookback=365 → since=2025-06-01, 两条都保留 (PK 去重: 标题不同, kol_name 同, date 不同 → 不重复)
  const state2 = emptyState({
    newsByCode: {
      '600519': [
        {
          title: '2026 新闻',
          content: null,
          publish_time: '2026-05-01',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
        {
          title: '2025 新闻',
          content: null,
          publish_time: '2025-12-01',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const service2 = new KOLAggregatorService(makeFakeSource(state2));
  const r2 = await service2.aggregateForStock('600519', {
    lookbackDays: 365,
    asOfDate: '2026-06-01',
  });
  assertEqual('asOfDate 2026-06-01 lookback 365 → 2 rows', r2.total_collected, 2);
}

async function testAggregate_BySourceCounter(): Promise<void> {
  const state = emptyState({
    researchByCode: {
      '600519': [
        {
          report_date: '2026-06-01',
          analyst_firm: 'firm1',
          rating: '买入',
          report_title: 't1',
          report_pdf_url: null,
          raw_payload: {},
        },
        {
          report_date: '2026-06-02',
          analyst_firm: 'firm2',
          rating: '增持',
          report_title: 't2',
          report_pdf_url: null,
          raw_payload: {},
        },
      ],
    },
    newsByCode: {
      '600519': [
        {
          title: 'n1',
          content: null,
          publish_time: '2026-06-03',
          source: 'src1',
          url: null,
          raw_payload: {},
        },
      ],
    },
    conceptsByCode: {
      '600519': [
        {
          snapshot_time: '2026-06-04',
          concept_name: 'c1',
          concept_code: 'BK1',
          heat: 100,
          rank: 1,
          raw_payload: {},
        },
        {
          snapshot_time: '2026-06-04',
          concept_name: 'c2',
          concept_code: 'BK2',
          heat: 50,
          rank: 2,
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', { limit: 20, asOfDate: '2026-06-08' });
  assertEqual('by_source research count', result.by_source.research_report, 2);
  assertEqual('by_source news count', result.by_source.east_money_news, 1);
  assertEqual('by_source concept count', result.by_source.xq_hot_concept, 2);
  assertEqual('total = sum of by_source', result.total_collected, 5);
}

// ---------------------------------------------------------------------------
// 10. aggregateForStocks (批量串行)
// ---------------------------------------------------------------------------

async function testAggregateBatch(): Promise<void> {
  const state = emptyState({
    newsByCode: {
      '600519': [
        {
          title: '业绩超预期',
          content: null,
          publish_time: '2026-06-05',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
      '000001': [
        {
          title: '中标 50 亿',
          content: null,
          publish_time: '2026-06-04',
          source: '证券时报',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const summary = await service.aggregateForStocks(['600519', '000001', 'XXX'], {
    intervalMs: 0,
    asOfDate: '2026-06-08',
  });
  assertEqual('batch total', summary.total, 3);
  assertEqual('batch succeeded', summary.succeeded, 2);
  assertEqual('batch failed (invalid code)', summary.failed, 1);
  assertEqual('batch details length', summary.details.length, 3);
  assertEqual('batch details[2] has error', !!summary.details[2].error, true);
}

// ---------------------------------------------------------------------------
// 11. todayLocalIso shape check
// ---------------------------------------------------------------------------

function testTodayLocalIso(): void {
  const iso = todayLocalIso();
  assert(
    `todayLocalIso shape (got ${iso})`,
    /^\d{4}-\d{2}-\d{2}$/.test(iso)
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// US-034 [KOL-002] SOURCE_AUTHORITY 权重 — 显式契约 + helper + META-GUARD
// ---------------------------------------------------------------------------

function testSourceAuthorityConstants(): void {
  // === AC: research 0.6 / news 0.3 / kol 0.4 / etf 0.5 / policy 0.8 ===
  assertEqual('SOURCE_AUTHORITY research_report', SOURCE_AUTHORITY.research_report, 0.6);
  assertEqual('SOURCE_AUTHORITY east_money_news', SOURCE_AUTHORITY.east_money_news, 0.3);
  assertEqual('SOURCE_AUTHORITY xq_hot_concept', SOURCE_AUTHORITY.xq_hot_concept, 0.4);
  assertEqual('SOURCE_AUTHORITY kol', SOURCE_AUTHORITY.kol, 0.4);
  assertEqual('SOURCE_AUTHORITY etf_flow', SOURCE_AUTHORITY.etf_flow, 0.5);
  assertEqual('SOURCE_AUTHORITY policy_doc', SOURCE_AUTHORITY.policy_doc, 0.8);
  assertEqual('SOURCE_AUTHORITY_DEFAULT', SOURCE_AUTHORITY_DEFAULT, 0.3);

  // 冻结契约 — 用户/上游不能擅自改权重值 (改了就要走 PR review)
  let mutated = false;
  try {
    (SOURCE_AUTHORITY as Record<string, number>).research_report = 0.99;
    mutated = SOURCE_AUTHORITY.research_report === 0.99;
  } catch {
    /* frozen → throw 也算契约成立 */
  }
  assert('SOURCE_AUTHORITY frozen 不可变', !mutated);

  // 政策口径权威性最大 (与 dedupeAndSort 文档注释一致)
  const max = Math.max(
    SOURCE_AUTHORITY.research_report,
    SOURCE_AUTHORITY.east_money_news,
    SOURCE_AUTHORITY.xq_hot_concept,
    SOURCE_AUTHORITY.kol,
    SOURCE_AUTHORITY.etf_flow,
    SOURCE_AUTHORITY.policy_doc
  );
  assertEqual('policy_doc is max authority', SOURCE_AUTHORITY.policy_doc, max);
}

function testGetSourceAuthority(): void {
  assertEqual('known source research', getSourceAuthority('research_report'), 0.6);
  assertEqual('known source policy', getSourceAuthority('policy_doc'), 0.8);
  // 未识别 source → fallback default, 不 throw
  assertEqual('unknown source fallback', getSourceAuthority('alien_source'), 0.3);
  assertEqual('null source fallback', getSourceAuthority(null), 0.3);
  assertEqual('undefined source fallback', getSourceAuthority(undefined), 0.3);
  assertEqual('empty string fallback', getSourceAuthority(''), 0.3);
}

function testAuthorityWeightedSentiment(): void {
  // |sentiment| * authority
  assertEqual(
    'weighted research +1.0',
    authorityWeightedSentiment(
      makeRec({ kol_source: KOL_SOURCES.RESEARCH_REPORT, sentiment_score: 1.0 })
    ),
    0.6
  );
  assertEqual(
    'weighted news -0.5 (abs)',
    authorityWeightedSentiment(
      makeRec({ kol_source: KOL_SOURCES.EAST_MONEY_NEWS, sentiment_score: -0.5 })
    ),
    0.15
  );
  // null sentiment → 0 (不抢 ranking)
  assertEqual(
    'weighted null sentiment → 0',
    authorityWeightedSentiment(
      makeRec({ kol_source: KOL_SOURCES.RESEARCH_REPORT, sentiment_score: null })
    ),
    0
  );
  // NaN sentiment → 0
  assertEqual(
    'weighted NaN sentiment → 0',
    authorityWeightedSentiment(
      makeRec({ kol_source: KOL_SOURCES.RESEARCH_REPORT, sentiment_score: NaN })
    ),
    0
  );
}

/**
 * META-GUARD — 用 fs+regex 守 KOLAggregatorService.ts 的关键契约, 防止有人改 dedupeAndSort 时
 * 漏掉 SOURCE_AUTHORITY 接入. 与 cron-registry / sizing-limit-consistency / feasibility-gate
 * 测里的 META-GUARD 同款套路.
 */
function testSourceAuthorityMetaGuard(): void {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/KOLAggregatorService.ts'),
    'utf8'
  );

  // 必须 export 三件套
  assert(
    'service exports SOURCE_AUTHORITY',
    /export\s+const\s+SOURCE_AUTHORITY/.test(src)
  );
  assert(
    'service exports getSourceAuthority',
    /export\s+function\s+getSourceAuthority/.test(src)
  );
  assert(
    'service exports authorityWeightedSentiment',
    /export\s+function\s+authorityWeightedSentiment/.test(src)
  );

  // dedupeAndSort 必须真的调 getSourceAuthority / authorityWeightedSentiment
  // (而非沿用旧 SOURCE_PRIORITY 表)
  const dedupeFn = src.match(/export function dedupeAndSort[\s\S]+?\n\}\n/);
  assert('dedupeAndSort 函数被找到', !!dedupeFn);
  if (dedupeFn) {
    assert(
      'dedupeAndSort 调 getSourceAuthority',
      /getSourceAuthority\(/.test(dedupeFn[0])
    );
    assert(
      'dedupeAndSort 调 authorityWeightedSentiment',
      /authorityWeightedSentiment\(/.test(dedupeFn[0])
    );
    // 反向: 旧 SOURCE_PRIORITY 字面量已下线
    assert(
      'dedupeAndSort 不再用旧 SOURCE_PRIORITY 表',
      !/SOURCE_PRIORITY/.test(dedupeFn[0])
    );
  }

  // Object.freeze 守不可变契约
  assert(
    'SOURCE_AUTHORITY 用 Object.freeze',
    /SOURCE_AUTHORITY[\s\S]{0,200}Object\.freeze\(\{/.test(src)
  );

  // AC 5 来源权重值必须在源文件中显式出现
  assert('source value research_report 0.6 in src', /research_report:\s*0\.6/.test(src));
  assert('source value east_money_news 0.3 in src', /east_money_news:\s*0\.3/.test(src));
  assert('source value kol 0.4 in src', /\bkol:\s*0\.4/.test(src));
  assert('source value etf_flow 0.5 in src', /etf_flow:\s*0\.5/.test(src));
  assert('source value policy_doc 0.8 in src', /policy_doc:\s*0\.8/.test(src));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Pure functions
  testConstants();
  testRatingToSentiment();
  testScoreNewsSentiment();
  testConceptRankToSentiment();
  testNormalizeDateOnly();
  testIsoDateMinusDays();
  testDedupeAndSort();
  testMapResearchToOpinions();
  testMapNewsToOpinions();
  testMapHotConceptsToOpinions();
  testTodayLocalIso();

  // US-034 source_authority 权重
  testSourceAuthorityConstants();
  testGetSourceAuthority();
  testAuthorityWeightedSentiment();
  testSourceAuthorityMetaGuard();

  // End-to-end with fake DataSource
  await testAggregate_HappyPath();
  await testAggregate_DryRun();
  await testAggregate_SingleSourceFailure();
  await testAggregate_AllSourcesFailure();
  await testAggregate_LookbackFilter();
  await testAggregate_LimitCap();
  await testAggregate_InvalidCode();
  await testAggregate_SaveFailFailOPEN();
  await testAggregate_AsOfDate();
  await testAggregate_BySourceCounter();
  await testAggregateBatch();

  console.log(
    `\n✅ ${passed} passed  ${failed > 0 ? '❌ ' + failed + ' failed' : '0 failed'}  ` +
      `total=${passed + failed}`
  );
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
