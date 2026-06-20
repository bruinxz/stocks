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
  KOLETFFlowRow,
  KOLPolicyRow,
  KOL_SOURCES,
  RATING_SENTIMENT_MAP,
  SENTIMENT_KEYWORDS,
  SOURCE_AUTHORITY,
  SOURCE_AUTHORITY_DEFAULT,
  POLICY_DIRECTION_KEYWORDS,
  POLICY_TOPIC_KEYWORDS,
  TIME_DECAY_HALF_LIFE_DAYS,
  getSourceAuthority,
  authorityWeightedSentiment,
  daysBetweenIsoDates,
  timeDecayFactor,
  decayedAuthorityWeightedSentiment,
  ratingToSentiment,
  scoreNewsSentiment,
  conceptRankToSentiment,
  normalizeDateOnly,
  isoDateMinusDays,
  dedupeAndSort,
  mapResearchToOpinions,
  mapNewsToOpinions,
  mapHotConceptsToOpinions,
  mapETFFlowToOpinions,
  mapPolicyToOpinions,
  netInflowToSentiment,
  scorePolicySentiment,
  inferPolicyIssuer,
  filterPolicyFromNews,
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
  etfByCode: Record<string, KOLETFFlowRow[]>;
  policyByCode: Record<string, KOLPolicyRow[]>;
  saves: KOLOpinionRecord[][];
  saveShouldThrow?: boolean;
  researchShouldThrow?: boolean;
  newsShouldThrow?: boolean;
  conceptsShouldThrow?: boolean;
  etfShouldThrow?: boolean;
  policyShouldThrow?: boolean;
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
    async fetchETFFlow(stockCode, _sinceDate) {
      if (state.etfShouldThrow) throw new Error('fake etf outage');
      return state.etfByCode[stockCode] || [];
    },
    async fetchPolicyDirectives(stockCode, _sinceDate) {
      if (state.policyShouldThrow) throw new Error('fake policy outage');
      return state.policyByCode[stockCode] || [];
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
    etfByCode: {},
    policyByCode: {},
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
  assertEqual('KOL_SOURCES.ETF_FLOW', KOL_SOURCES.ETF_FLOW, 'etf_flow');
  assertEqual('KOL_SOURCES.POLICY_DOC', KOL_SOURCES.POLICY_DOC, 'policy_doc');
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
    etfShouldThrow: true,
    policyShouldThrow: true,
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
// US-035 [KOL-003] ETF flow + 政策集成
// ---------------------------------------------------------------------------

function testNetInflowToSentiment(): void {
  // 阈值: 1e8 → ±1.0, 1e7 → ±0.5, 其它非零 → ±0.2
  assertEqual('netInflow null → 0', netInflowToSentiment(null), 0);
  assertEqual('netInflow undefined → 0', netInflowToSentiment(undefined), 0);
  assertEqual('netInflow NaN → 0', netInflowToSentiment(NaN), 0);
  assertEqual('netInflow 0 → 0', netInflowToSentiment(0), 0);
  // 强信号 (>= 1 亿)
  assertEqual('netInflow +2 亿 → +1.0', netInflowToSentiment(2e8), 1.0);
  assertEqual('netInflow -1.5 亿 → -1.0', netInflowToSentiment(-1.5e8), -1.0);
  // 中信号 (>= 1000 万 < 1 亿)
  assertEqual('netInflow +3000 万 → +0.5', netInflowToSentiment(3e7), 0.5);
  assertEqual('netInflow -1500 万 → -0.5', netInflowToSentiment(-1.5e7), -0.5);
  // 弱信号
  assertEqual('netInflow +100 万 → +0.2', netInflowToSentiment(1e6), 0.2);
  assertEqual('netInflow -50 万 → -0.2', netInflowToSentiment(-5e5), -0.2);
  // 边界值: 恰好等于 1e7 / 1e8 → 取强档
  assertEqual('netInflow 1e7 → +0.5', netInflowToSentiment(1e7), 0.5);
  assertEqual('netInflow 1e8 → +1.0', netInflowToSentiment(1e8), 1.0);
}

function testMapETFFlowToOpinions(): void {
  const rows: KOLETFFlowRow[] = [
    {
      trade_date: '2026-06-08',
      etf_code: '159995',
      etf_name: '芯片ETF华夏',
      underlying_industry: '半导体',
      net_inflow: 2e8, // 强多
      aum: 1.2e10,
      raw_payload: { source: 'ETFFlow' },
    },
    {
      trade_date: '2026-06-08',
      etf_code: '512760',
      etf_name: '芯片ETF国联安',
      underlying_industry: '半导体',
      net_inflow: -5e7, // 强空
      aum: 8e9,
      raw_payload: {},
    },
    {
      trade_date: '2026-06-07',
      etf_code: '510050',
      etf_name: '上证50ETF',
      underlying_industry: '宽基',
      net_inflow: null,
      aum: null,
      raw_payload: {},
    },
    // 必填项缺失 → 跳过
    {
      trade_date: '',
      etf_code: '',
      etf_name: 'bad',
      underlying_industry: '',
      net_inflow: 0,
      aum: 0,
      raw_payload: {},
    },
  ];
  const opinions = mapETFFlowToOpinions('600519', rows);
  assertEqual('etf mapper 跳过必填缺失', opinions.length, 3);
  assertEqual('etf mapper kol_source', opinions[0].kol_source, 'etf_flow');
  assertEqual(
    'etf mapper kol_name prefix',
    opinions[0].kol_name,
    'ETF 资金流·半导体'
  );
  assertEqual('etf mapper net inflow → sentiment', opinions[0].sentiment_score, 1.0);
  assertEqual('etf mapper net outflow → -sentiment', opinions[1].sentiment_score, -0.5);
  assertEqual('etf mapper null inflow sentiment=0', opinions[2].sentiment_score, 0);
  assert(
    'etf mapper summary 含 "净申购"',
    opinions[0].opinion_summary.includes('净申购')
  );
  assert(
    'etf mapper summary 含 "净赎回"',
    opinions[1].opinion_summary.includes('净赎回')
  );
  assert(
    'etf mapper null inflow summary 含 "数据缺失"',
    opinions[2].opinion_summary.includes('数据缺失')
  );
  assert(
    'etf mapper opinion_date YYYY-MM-DD',
    /^\d{4}-\d{2}-\d{2}$/.test(opinions[0].opinion_date)
  );
}

function testScorePolicySentiment(): void {
  assertEqual('policy null → 0', scorePolicySentiment(null), 0);
  assertEqual('policy 空字符串 → 0', scorePolicySentiment(''), 0);
  assertEqual(
    'policy 正向 支持/鼓励',
    scorePolicySentiment('国务院发文支持半导体产业发展'),
    0.7
  );
  assertEqual(
    'policy 正向 减税',
    scorePolicySentiment('财政部减税降费持续推进'),
    0.7
  );
  assertEqual(
    'policy 负向 收紧',
    scorePolicySentiment('监管收紧网游审批节奏'),
    -0.7
  );
  assertEqual(
    'policy 负向 禁止',
    scorePolicySentiment('禁止外资进入战略行业'),
    -0.7
  );
  // 负向词在正向词前命中 → 取负 (负向优先 = 安全)
  assertEqual(
    'policy 正负兼有 → 取负 (安全派)',
    scorePolicySentiment('鼓励发展但限制规模'),
    -0.7
  );
  assertEqual('policy 无关 → 0', scorePolicySentiment('某公司高管离职'), 0);
}

function testInferPolicyIssuer(): void {
  assertEqual('issuer 国务院', inferPolicyIssuer('国务院发布产业规划'), '国务院');
  assertEqual('issuer 央行', inferPolicyIssuer('央行降准 0.5pct'), '中国人民银行');
  assertEqual(
    'issuer 人民银行',
    inferPolicyIssuer('中国人民银行公开市场操作'),
    '中国人民银行'
  );
  assertEqual('issuer 证监会', inferPolicyIssuer('证监会修订上市规则'), '证监会');
  assertEqual('issuer 发改委', inferPolicyIssuer('国家发改委推进示范工程'), '国家发改委');
  assertEqual('issuer 工信部', inferPolicyIssuer('工信部部署专项规划'), '工信部');
  assertEqual('issuer 财政部', inferPolicyIssuer('财政部加大补贴力度'), '财政部');
  assertEqual('issuer 银保监', inferPolicyIssuer('银保监会出台办法'), '银保监会');
  assertEqual('issuer fallback', inferPolicyIssuer('行业出现新政策'), '政策研判');
  assertEqual('issuer null fallback', inferPolicyIssuer(null), '政策研判');
}

function testFilterPolicyFromNews(): void {
  const news: KOLNewsRow[] = [
    {
      title: '国务院发布支持半导体产业政策',
      content: '推进国产替代',
      publish_time: '2026-06-05',
      source: '财联社',
      url: 'http://news/1',
      raw_payload: {},
    },
    {
      title: '公司发布Q3季报',
      content: null,
      publish_time: '2026-06-05',
      source: null,
      url: null,
      raw_payload: {},
    },
    {
      title: '工信部出台办法收紧网游审批',
      content: null,
      publish_time: '2026-06-04',
      source: null,
      url: null,
      raw_payload: {},
    },
    // since 之前 → 应被过滤
    {
      title: '财政部发布意见',
      content: null,
      publish_time: '2025-01-01',
      source: null,
      url: null,
      raw_payload: {},
    },
  ];
  const policies = filterPolicyFromNews(news, '2026-01-01');
  assertEqual('filterPolicy 命中政策标题数', policies.length, 2);
  assertEqual('filterPolicy 第 1 条 issuing_org', policies[0].issuing_org, '国务院');
  assertEqual('filterPolicy 第 1 条 sentiment', policies[0].sentiment, 'positive');
  assertEqual('filterPolicy 第 2 条 sentiment 负向', policies[1].sentiment, 'negative');
}

function testMapPolicyToOpinions(): void {
  const rows: KOLPolicyRow[] = [
    {
      publish_date: '2026-06-08',
      issuing_org: '国务院',
      title: '国务院发布支持半导体产业政策',
      summary: '推进国产替代,加大投入',
      sentiment: 'positive',
      url: 'http://gov/1',
      raw_payload: {},
    },
    {
      publish_date: '2026-06-07',
      issuing_org: '工信部',
      title: '工信部收紧网游审批',
      summary: null,
      sentiment: 'negative',
      url: null,
      raw_payload: {},
    },
    {
      publish_date: '2026-06-06',
      issuing_org: '政策研判',
      title: '产业资讯',
      summary: '行业最新动态',
      sentiment: 'neutral',
      url: null,
      raw_payload: {},
    },
    // 必填项缺失 → 跳过
    {
      publish_date: '',
      issuing_org: '应被跳过',
      title: 'skip me',
      summary: null,
      sentiment: 'neutral',
      url: null,
      raw_payload: {},
    },
  ];
  const opinions = mapPolicyToOpinions('600519', rows);
  assertEqual('policy mapper 跳过缺失', opinions.length, 3);
  assertEqual('policy mapper kol_source', opinions[0].kol_source, 'policy_doc');
  assertEqual('policy mapper kol_name = issuing_org', opinions[0].kol_name, '国务院');
  assertEqual('policy mapper positive sentiment_score', opinions[0].sentiment_score, 0.7);
  assertEqual('policy mapper negative sentiment_score', opinions[1].sentiment_score, -0.7);
  assertEqual('policy mapper neutral sentiment_score', opinions[2].sentiment_score, 0);
  assert(
    'policy mapper summary 含 title',
    opinions[0].opinion_summary.includes('国务院发布支持半导体产业政策')
  );
  assert(
    'policy mapper summary 含 summary tail',
    opinions[0].opinion_summary.includes('推进国产替代')
  );
}

function testPolicyKeywordsConstants(): void {
  assert('POLICY_TOPIC_KEYWORDS contains 政策', POLICY_TOPIC_KEYWORDS.includes('政策'));
  assert('POLICY_TOPIC_KEYWORDS contains 国务院', POLICY_TOPIC_KEYWORDS.includes('国务院'));
  assert(
    'POLICY_DIRECTION_KEYWORDS.positive 含 支持',
    POLICY_DIRECTION_KEYWORDS.positive.includes('支持')
  );
  assert(
    'POLICY_DIRECTION_KEYWORDS.negative 含 收紧',
    POLICY_DIRECTION_KEYWORDS.negative.includes('收紧')
  );
}

/**
 * US-035 AC 主验收: "5 类来源非空".
 *
 * 注入 fake 在 5 种来源各自非空, aggregate 应返 by_source 5 项全 > 0,
 * total_collected 等于 5 项之和.
 */
async function testAggregate_FiveSourcesNonEmpty(): Promise<void> {
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
          content: '营收稳定',
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
    etfByCode: {
      '600519': [
        {
          trade_date: '2026-06-08',
          etf_code: '512690',
          etf_name: '酒ETF',
          underlying_industry: '白酒',
          net_inflow: 2e8,
          aum: 5e9,
          raw_payload: {},
        },
      ],
    },
    policyByCode: {
      '600519': [
        {
          publish_date: '2026-06-07',
          issuing_org: '财政部',
          title: '财政部减税降费扶持消费',
          summary: '加大行业补贴',
          sentiment: 'positive',
          url: 'http://gov/1',
          raw_payload: {},
        },
      ],
    },
  });
  const service = new KOLAggregatorService(makeFakeSource(state));
  const result = await service.aggregateForStock('600519', {
    limit: 20,
    asOfDate: '2026-06-08',
  });
  // 5 类来源全非空
  assert('5-source research_report > 0', result.by_source.research_report > 0);
  assert('5-source east_money_news > 0', result.by_source.east_money_news > 0);
  assert('5-source xq_hot_concept > 0', result.by_source.xq_hot_concept > 0);
  assert('5-source etf_flow > 0', result.by_source.etf_flow > 0);
  assert('5-source policy_doc > 0', result.by_source.policy_doc > 0);
  assertEqual('5-source total_collected = 5', result.total_collected, 5);
  // 排序: opinion_date desc → concept @ 06-08 / etf @ 06-08 同日, policy_doc(auth 0.8) > etf_flow(0.5) > concept(0.4)
  // 因为 etf 和 concept 都 06-08, etf authority 0.5 > concept 0.4, etf 先;
  // 不强断顺序细节, 只断 5 来源各 1 条
  assertEqual('5-source persisted=true', result.persisted, true);
  assert('5-source no error', result.error === undefined);
}

/**
 * US-035: ETF / Policy 单源失败时仍出其余 4 类来源结果, 不抛.
 */
async function testAggregate_ETFAndPolicySourceFailure(): Promise<void> {
  const state = emptyState({
    etfShouldThrow: true,
    policyShouldThrow: true,
    newsByCode: {
      '600519': [
        {
          title: 'n',
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
  assertEqual('etf+policy 失败 etf=0', result.by_source.etf_flow, 0);
  assertEqual('etf+policy 失败 policy=0', result.by_source.policy_doc, 0);
  assertEqual('etf+policy 失败 news 仍出', result.by_source.east_money_news, 1);
  assert('etf+policy 失败 无 outer error', result.error === undefined);
}

/**
 * META-GUARD — 守 US-035 的 5 来源接入清单:
 * 1. KOL_SOURCES 含 ETF_FLOW / POLICY_DOC;
 * 2. DataSource interface 含 fetchETFFlow / fetchPolicyDirectives 方法;
 * 3. aggregateForStock 主流程并发 fetch 5 来源 + map 5 来源;
 * 4. safeFetchETFFlow / safeFetchPolicyDirectives 私有方法存在 (try/catch fail-OPEN);
 * 5. countBySource / emptyBySource 含 etf_flow / policy_doc 0 兜底.
 */
function testFiveSourceMetaGuard(): void {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/KOLAggregatorService.ts'),
    'utf8'
  );

  // 1. KOL_SOURCES 含新两类
  assert('KOL_SOURCES 含 ETF_FLOW', /ETF_FLOW:\s*'etf_flow'/.test(src));
  assert('KOL_SOURCES 含 POLICY_DOC', /POLICY_DOC:\s*'policy_doc'/.test(src));

  // 2. DataSource interface 含 5 方法
  assert(
    'DataSource interface 含 fetchETFFlow',
    /fetchETFFlow\(stockCode: string, sinceDate: string\): Promise<KOLETFFlowRow\[\]>/.test(
      src
    )
  );
  assert(
    'DataSource interface 含 fetchPolicyDirectives',
    /fetchPolicyDirectives\(stockCode: string, sinceDate: string\): Promise<KOLPolicyRow\[\]>/.test(
      src
    )
  );

  // 3. aggregateForStock 主流程并发 5 来源 + map 5 来源
  const aggregateFn = src.match(/async aggregateForStock\([\s\S]+?\n  \}\n/);
  assert('aggregateForStock 函数被找到', !!aggregateFn);
  if (aggregateFn) {
    assert(
      'aggregateForStock 主流程并发 safeFetchETFFlow',
      /safeFetchETFFlow\(/.test(aggregateFn[0])
    );
    assert(
      'aggregateForStock 主流程并发 safeFetchPolicyDirectives',
      /safeFetchPolicyDirectives\(/.test(aggregateFn[0])
    );
    assert(
      'aggregateForStock map mapETFFlowToOpinions',
      /mapETFFlowToOpinions\(/.test(aggregateFn[0])
    );
    assert(
      'aggregateForStock map mapPolicyToOpinions',
      /mapPolicyToOpinions\(/.test(aggregateFn[0])
    );
  }

  // 4. safeFetchETFFlow / safeFetchPolicyDirectives 私有方法存在
  assert(
    'safeFetchETFFlow private method 存在',
    /private async safeFetchETFFlow/.test(src)
  );
  assert(
    'safeFetchPolicyDirectives private method 存在',
    /private async safeFetchPolicyDirectives/.test(src)
  );

  // 5. countBySource / emptyBySource 含 etf_flow / policy_doc 0 兜底
  assert(
    'countBySource 含 etf_flow: 0',
    /(?:emptyBySource|countBySource)[\s\S]{0,400}etf_flow:\s*0/.test(src)
  );
  assert(
    'countBySource 含 policy_doc: 0',
    /(?:emptyBySource|countBySource)[\s\S]{0,400}policy_doc:\s*0/.test(src)
  );

  // 6. DefaultKOLAggregatorDataSource 含 5 个 fetch 实现
  assert(
    'Default DataSource 含 fetchETFFlow 实现',
    /async fetchETFFlow\(stockCode: string, sinceDate: string\)/.test(src)
  );
  assert(
    'Default DataSource 含 fetchPolicyDirectives 实现',
    /async fetchPolicyDirectives\(stockCode: string, sinceDate: string\)/.test(src)
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
// US-119 [KOL-005] time_decay — weight × exp(-days_old / 7)
// ---------------------------------------------------------------------------

function approxEqual(name: string, actual: number, expected: number, eps = 1e-6): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= eps;
  assert(name, ok, `actual=${actual} expected=${expected} eps=${eps}`);
}

function testTimeDecayConstants(): void {
  // AC: 公式 `/ 7` 固定, 任何业务方改这个常数都要走 PR review
  assertEqual('TIME_DECAY_HALF_LIFE_DAYS = 7', TIME_DECAY_HALF_LIFE_DAYS, 7);
}

function testDaysBetweenIsoDates(): void {
  // 同日 → 0
  assertEqual('days same day', daysBetweenIsoDates('2026-06-20', '2026-06-20'), 0);
  // 隔 1 天
  assertEqual('days +1', daysBetweenIsoDates('2026-06-19', '2026-06-20'), 1);
  // 隔 7 天
  assertEqual('days +7', daysBetweenIsoDates('2026-06-13', '2026-06-20'), 7);
  // 跨月
  assertEqual('days cross-month', daysBetweenIsoDates('2026-05-30', '2026-06-05'), 6);
  // 跨年
  assertEqual('days cross-year', daysBetweenIsoDates('2025-12-25', '2026-01-05'), 11);
  // 未来日期 → 负数 (timeDecayFactor 处理为 1.0)
  assertEqual('days future negative', daysBetweenIsoDates('2026-06-25', '2026-06-20'), -5);
  // 异常输入 fail-OPEN → 0
  assertEqual('days bad opinion fallback', daysBetweenIsoDates('not-a-date', '2026-06-20'), 0);
  assertEqual('days bad asOf fallback', daysBetweenIsoDates('2026-06-20', 'bad'), 0);
  assertEqual('days empty input', daysBetweenIsoDates('', '2026-06-20'), 0);
  // 月份越界 → 0 (不能拼 NaN 月份漏到下游)
  assertEqual('days month out of range', daysBetweenIsoDates('2026-13-01', '2026-06-20'), 0);
}

function testTimeDecayFactor(): void {
  // 同日 / 未来日期 → 1.0 (不衰减)
  assertEqual('decay same day = 1', timeDecayFactor('2026-06-20', '2026-06-20'), 1);
  assertEqual('decay future = 1', timeDecayFactor('2026-06-25', '2026-06-20'), 1);

  // AC 边界: days_old=7 → exp(-1) ≈ 0.3678794
  approxEqual(
    'decay 7d = 1/e',
    timeDecayFactor('2026-06-13', '2026-06-20'),
    Math.exp(-1)
  );
  // days_old=14 → exp(-2) ≈ 0.1353
  approxEqual(
    'decay 14d = exp(-2)',
    timeDecayFactor('2026-06-06', '2026-06-20'),
    Math.exp(-2)
  );
  // days_old=30 → exp(-30/7) ≈ 0.0136
  approxEqual(
    'decay 30d',
    timeDecayFactor('2026-05-21', '2026-06-20'),
    Math.exp(-30 / 7)
  );
  // days_old=1 → exp(-1/7) ≈ 0.866 (短期内仍有大权重)
  approxEqual(
    'decay 1d',
    timeDecayFactor('2026-06-19', '2026-06-20'),
    Math.exp(-1 / 7)
  );

  // 单调性: 越老越衰减
  const d1 = timeDecayFactor('2026-06-19', '2026-06-20');
  const d7 = timeDecayFactor('2026-06-13', '2026-06-20');
  const d30 = timeDecayFactor('2026-05-21', '2026-06-20');
  assert('decay 单调 1>7>30', d1 > d7 && d7 > d30);
  // 始终在 (0, 1]
  assert('decay 30d still > 0', d30 > 0);
  assert('decay 30d < 1', d30 < 1);
}

function testDecayedAuthorityWeightedSentiment(): void {
  // research +1.0 同日 → 0.6 * 1.0 * 1.0 = 0.6 (不衰减)
  approxEqual(
    'decayed research +1 same day',
    decayedAuthorityWeightedSentiment(
      makeRec({
        kol_source: KOL_SOURCES.RESEARCH_REPORT,
        sentiment_score: 1.0,
        opinion_date: '2026-06-20',
      }),
      '2026-06-20'
    ),
    0.6
  );

  // research +1.0 7 天前 → 0.6 * exp(-1) ≈ 0.2207
  approxEqual(
    'decayed research +1 7d ago',
    decayedAuthorityWeightedSentiment(
      makeRec({
        kol_source: KOL_SOURCES.RESEARCH_REPORT,
        sentiment_score: 1.0,
        opinion_date: '2026-06-13',
      }),
      '2026-06-20'
    ),
    0.6 * Math.exp(-1)
  );

  // policy -0.5 14 天前 → 0.8 * 0.5 * exp(-2) ≈ 0.0541
  approxEqual(
    'decayed policy -0.5 14d ago',
    decayedAuthorityWeightedSentiment(
      makeRec({
        kol_source: KOL_SOURCES.POLICY_DOC,
        sentiment_score: -0.5,
        opinion_date: '2026-06-06',
      }),
      '2026-06-20'
    ),
    0.8 * 0.5 * Math.exp(-2)
  );

  // sentiment=0 → 整体 0 (短路, 不必算 decay)
  assertEqual(
    'decayed 0 sentiment = 0',
    decayedAuthorityWeightedSentiment(
      makeRec({
        kol_source: KOL_SOURCES.RESEARCH_REPORT,
        sentiment_score: 0,
        opinion_date: '2026-06-13',
      }),
      '2026-06-20'
    ),
    0
  );

  // sentiment=null → 0
  assertEqual(
    'decayed null sentiment = 0',
    decayedAuthorityWeightedSentiment(
      makeRec({
        kol_source: KOL_SOURCES.RESEARCH_REPORT,
        sentiment_score: null,
        opinion_date: '2026-06-13',
      }),
      '2026-06-20'
    ),
    0
  );

  // 新 vs 老对比: 新闻 +0.5 今天 vs 研报 +0.5 30 天前
  //   新闻今天 = 0.3 * 0.5 * 1 = 0.15
  //   研报 30d = 0.6 * 0.5 * exp(-30/7) ≈ 0.0041
  // → 新闻今天权重更大 (验证 time_decay 真的让"新且弱"压过"老且权威")
  const newsFresh = decayedAuthorityWeightedSentiment(
    makeRec({
      kol_source: KOL_SOURCES.EAST_MONEY_NEWS,
      sentiment_score: 0.5,
      opinion_date: '2026-06-20',
    }),
    '2026-06-20'
  );
  const researchStale = decayedAuthorityWeightedSentiment(
    makeRec({
      kol_source: KOL_SOURCES.RESEARCH_REPORT,
      sentiment_score: 0.5,
      opinion_date: '2026-05-21',
    }),
    '2026-06-20'
  );
  assert('decay 让"新且弱"压过"老且权威"', newsFresh > researchStale);

  // 默认 asOfDate fallback = todayLocalIso(): 至少不抛 + 返回有限数
  const today = todayLocalIso();
  const defaulted = decayedAuthorityWeightedSentiment(
    makeRec({
      kol_source: KOL_SOURCES.RESEARCH_REPORT,
      sentiment_score: 0.5,
      opinion_date: today,
    })
  );
  assert('decay 默认 asOfDate 不抛', Number.isFinite(defaulted));
  approxEqual('decay 默认 asOfDate 同日 = base', defaulted, 0.3);
}

function testTimeDecayMetaGuard(): void {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/KOLAggregatorService.ts'),
    'utf8'
  );
  // 三件套 export
  assert(
    'service exports TIME_DECAY_HALF_LIFE_DAYS',
    /export\s+const\s+TIME_DECAY_HALF_LIFE_DAYS\s*=\s*7\b/.test(src)
  );
  assert(
    'service exports timeDecayFactor',
    /export\s+function\s+timeDecayFactor/.test(src)
  );
  assert(
    'service exports decayedAuthorityWeightedSentiment',
    /export\s+function\s+decayedAuthorityWeightedSentiment/.test(src)
  );
  assert(
    'service exports daysBetweenIsoDates',
    /export\s+function\s+daysBetweenIsoDates/.test(src)
  );
  // 公式 `exp(-days / 7)` 必须真出现在源码 — AC 锁定
  assert(
    'time_decay uses Math.exp(-... / TIME_DECAY_HALF_LIFE_DAYS)',
    /Math\.exp\(-[A-Za-z_]+\s*\/\s*TIME_DECAY_HALF_LIFE_DAYS\)/.test(src)
  );
  // decayedAuthorityWeightedSentiment 必须真的乘 authorityWeightedSentiment × timeDecayFactor
  const decayedFn = src.match(
    /export function decayedAuthorityWeightedSentiment[\s\S]+?\n\}\n/
  );
  assert('decayedAuthorityWeightedSentiment 函数被找到', !!decayedFn);
  if (decayedFn) {
    assert(
      'decayed 调 authorityWeightedSentiment',
      /authorityWeightedSentiment\(/.test(decayedFn[0])
    );
    assert(
      'decayed 调 timeDecayFactor',
      /timeDecayFactor\(/.test(decayedFn[0])
    );
  }
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

  // US-119 [KOL-005] time_decay
  testTimeDecayConstants();
  testDaysBetweenIsoDates();
  testTimeDecayFactor();
  testDecayedAuthorityWeightedSentiment();
  testTimeDecayMetaGuard();

  // US-035 [KOL-003] ETF + 政策集成
  testNetInflowToSentiment();
  testMapETFFlowToOpinions();
  testScorePolicySentiment();
  testInferPolicyIssuer();
  testFilterPolicyFromNews();
  testMapPolicyToOpinions();
  testPolicyKeywordsConstants();
  testFiveSourceMetaGuard();

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

  // US-035 [KOL-003] aggregateForStock e2e with ETF + policy
  await testAggregate_FiveSourcesNonEmpty();
  await testAggregate_ETFAndPolicySourceFailure();

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
