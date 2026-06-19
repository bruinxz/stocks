/**
 * QAStatAggregator 单元测试 (US-038 QA-002 EastMoneyQAStat model + aggregator)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/qa/qa-stat-aggregator.test.ts
 *
 * 完全脱离 DB / Python 子进程: 注入 fake QAStatAggregatorDataSource +
 * monkey-patch EastMoneyQAStat Sequelize Model 静态方法成内存 store
 * (与 east-money-qa-topic-service / announcement-nlp-service 同款 in-memory model 模式).
 *
 * 覆盖维度:
 *   - 模板字典常量冻结 (TEMPLATE_ANSWER_KEYWORDS) + 阈值正确;
 *   - 纯函数:
 *     - detectTemplateAnswer (空 / 极短 / strong 命中 / moderate 命中 / 无命中);
 *     - pickTopSubtopic (max-count + tie-break priority + 空 → other_general);
 *     - roundTo3 (3 位小数 + 非有限兜底);
 *     - sleep (resolve);
 *     - aggregateForWeek (单周 / 多周 / 无回答 / 全模板回答 / since_date filter /
 *       排序 / 无效 question_time / 空数组 / template_hits_sample cap 5 / 默认 nlp_engine);
 *   - aggregator.aggregateForStock() e2e:
 *     - happy path: N 条问题 → 多周聚合 → upsert;
 *     - dry_run=true: 不写库;
 *     - 无效 stock_code → error 字段;
 *     - fetch 返回 [] → 0 行 + no error;
 *     - saveStats throws → fail-OPEN + error 字段;
 *     - fetch throws → 双重防御 catch + error 字段;
 *   - aggregator.aggregateForStocks():
 *     - 批量遍历 + intervalMs=0 加速;
 *     - 单股失败 continue_on_error=true 不阻塞;
 *     - 全部 invalid code (continue 默认) → failed = N;
 *   - aggregator.listByStock():
 *     - 默认 weeks; 非法 stock_code → []; weeks clamp 不抛.
 */

import {
  detectTemplateAnswer,
  pickTopSubtopic,
  roundTo3,
  sleep,
  aggregateForWeek,
  AggregatedWeekStat,
  QAStatAggregator,
  QAStatAggregatorDataSource,
  TEMPLATE_ANSWER_KEYWORDS,
  TEMPLATE_SHORT_ANSWER_THRESHOLD,
  DEFAULT_QA_STAT_FETCH_LIMIT,
  DEFAULT_QA_STAT_LIST_WEEKS,
} from '../../../src/services/qa/QAStatAggregator';
import {
  TOPIC_SUBCATEGORIES,
  NLP_ENGINES,
  SubtopicCategory,
} from '../../../src/services/EastMoneyQATopicService';
import { StockQARow } from '../../../src/data/sources/StockQAClient';
import { EastMoneyQAStat } from '../../../src/models/EastMoneyQAStat';

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
// In-memory backing store for EastMoneyQAStat model static method stubs
// ---------------------------------------------------------------------------

interface FakeStatRow {
  id?: number;
  stock_code: string;
  stock_name?: string | null;
  week_start: string;
  questions_count: number;
  answer_count: number;
  answer_rate: number;
  top_subtopic: string;
  avg_question_sentiment: number;
  avg_answer_sentiment: number | null;
  answer_template_score: number | null;
  nlp_engine?: string | null;
  raw_payload?: unknown;
  updated_at?: Date;
}

let store: FakeStatRow[] = [];
let nextId = 1;

function resetStore(): void {
  store = [];
  nextId = 1;
}

function installModelStubs(): void {
  // bulkCreate — upsert by (stock_code, week_start)
  (EastMoneyQAStat as any).bulkCreate = async (
    records: FakeStatRow[],
    _options?: unknown
  ): Promise<FakeStatRow[]> => {
    for (const r of records) {
      const idx = store.findIndex(
        s => s.stock_code === r.stock_code && s.week_start === r.week_start
      );
      const merged: FakeStatRow = { ...r, updated_at: new Date() };
      if (idx >= 0) {
        merged.id = store[idx].id;
        store[idx] = merged;
      } else {
        merged.id = nextId++;
        store.push(merged);
      }
    }
    return records;
  };

  // findAll — supports where.stock_code + where.week_start gte + order
  (EastMoneyQAStat as any).findAll = async (options: any): Promise<FakeStatRow[]> => {
    let candidates = [...store];
    const sc = options?.where?.stock_code;
    if (typeof sc === 'string') {
      candidates = candidates.filter(s => s.stock_code === sc);
    }
    const ws = options?.where?.week_start;
    if (ws && typeof ws === 'object') {
      const symbols = Object.getOwnPropertySymbols(ws);
      for (const sym of symbols) {
        const symStr = sym.toString();
        const v = ws[sym];
        if (symStr.includes('gte')) candidates = candidates.filter(s => s.week_start >= v);
        else if (symStr.includes('lte')) candidates = candidates.filter(s => s.week_start <= v);
      }
    }
    if (options?.order) {
      for (const ord of options.order.slice().reverse()) {
        const [field, dir] = ord;
        candidates.sort((a: any, b: any) => {
          const av = a[field];
          const bv = b[field];
          if (av === bv) return 0;
          return dir === 'DESC' ? (av < bv ? 1 : -1) : av < bv ? -1 : 1;
        });
      }
    }
    return candidates;
  };
}

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeDSState {
  fetchByStock: Record<string, StockQARow[]>;
  fetchShouldThrowFor?: Set<string>;
  saveShouldThrow?: boolean;
  saveCalls: AggregatedWeekStat[][];
  fetchCalls: Array<{ stock_code: string; limit?: number }>;
}

function makeFakeDSState(overrides: Partial<FakeDSState> = {}): FakeDSState {
  return {
    fetchByStock: {},
    saveCalls: [],
    fetchCalls: [],
    ...overrides,
  };
}

function makeFakeDS(state: FakeDSState): QAStatAggregatorDataSource {
  return {
    async fetchForStock(stockCode: string, limit?: number) {
      state.fetchCalls.push({ stock_code: stockCode, limit });
      if (state.fetchShouldThrowFor && state.fetchShouldThrowFor.has(stockCode)) {
        throw new Error(`fake fetch outage for ${stockCode}`);
      }
      return state.fetchByStock[stockCode] || [];
    },
    async saveStats(rows: AggregatedWeekStat[]) {
      if (state.saveShouldThrow) throw new Error('fake save outage');
      state.saveCalls.push([...rows]);
    },
  };
}

function makeQARow(
  partial: Partial<StockQARow> & { question: string; question_time: string }
): StockQARow {
  const fallbackId = `qid:${partial.question_time}:${partial.question.slice(0, 8)}`;
  return {
    stock_code: '600519',
    stock_name: '贵州茅台',
    industry: '白酒',
    questioner: 'irm123',
    source: '网站',
    question_id: fallbackId,
    answer: null,
    answerer: null,
    raw_payload: {},
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// 模板字典常量冻结
// ---------------------------------------------------------------------------

function testTemplateKeywordsFrozen(): void {
  assert('TEMPLATE_ANSWER_KEYWORDS frozen', Object.isFrozen(TEMPLATE_ANSWER_KEYWORDS));
  assert(
    'TEMPLATE_ANSWER_KEYWORDS.strong frozen',
    Object.isFrozen(TEMPLATE_ANSWER_KEYWORDS.strong)
  );
  assert(
    'TEMPLATE_ANSWER_KEYWORDS.moderate frozen',
    Object.isFrozen(TEMPLATE_ANSWER_KEYWORDS.moderate)
  );
  assert(
    'strong dict 非空',
    TEMPLATE_ANSWER_KEYWORDS.strong.length > 0
  );
  assert(
    'moderate dict 非空',
    TEMPLATE_ANSWER_KEYWORDS.moderate.length > 0
  );
  assert(
    'TEMPLATE_SHORT_ANSWER_THRESHOLD ≥ 1',
    TEMPLATE_SHORT_ANSWER_THRESHOLD >= 1
  );
}

// ---------------------------------------------------------------------------
// detectTemplateAnswer
// ---------------------------------------------------------------------------

function testDetectTemplateAnswer(): void {
  assertEqual('detectTemplateAnswer null → 1', detectTemplateAnswer(null), 1);
  assertEqual('detectTemplateAnswer undefined → 1', detectTemplateAnswer(undefined), 1);
  assertEqual('detectTemplateAnswer "" → 1', detectTemplateAnswer(''), 1);
  assertEqual(
    'detectTemplateAnswer 全空白 → 1',
    detectTemplateAnswer('   \t  '),
    1
  );
  // 极短回答 (< THRESHOLD)
  assertEqual(
    'detectTemplateAnswer 极短回答 → 1',
    detectTemplateAnswer('好'),
    1
  );
  // strong 命中
  assertEqual(
    'detectTemplateAnswer 感谢关注 → 1',
    detectTemplateAnswer('感谢关注本公司, 详情请联系投资者关系部门进一步交流。'),
    1
  );
  assertEqual(
    'detectTemplateAnswer 详见公告 → 1',
    detectTemplateAnswer('请详见公告披露内容, 不再赘述。具体以官方披露为准。'),
    1
  );
  assertEqual(
    'detectTemplateAnswer 投资有风险 → 1',
    detectTemplateAnswer('投资有风险, 入市需谨慎, 请投资者注意相关风险。'),
    1
  );
  // moderate 命中
  assertEqual(
    'detectTemplateAnswer 暂无相关计划 → 0.5',
    detectTemplateAnswer('公司暂无相关明确计划, 后续如有变化将依规则披露。'),
    0.5
  );
  assertEqual(
    'detectTemplateAnswer 请持续关注 → 0.5',
    detectTemplateAnswer('请持续关注公司后续披露的官方信息渠道发布。'),
    0.5
  );
  // 无命中 (高质量回答 — 包含数字 / 业务事实, 不出现字典词)
  assertEqual(
    'detectTemplateAnswer 高质量 → 0',
    detectTemplateAnswer(
      '公司 Q1 营收 12.3 亿元同比增长 18%, 主要由海外订单驱动, 新签合同 8.7 亿元。'
    ),
    0
  );
  // strong 优先于 moderate
  assertEqual(
    'detectTemplateAnswer strong+moderate 同时命中 → 1',
    detectTemplateAnswer('感谢关注, 我们正常推进相关进度。'),
    1
  );
}

// ---------------------------------------------------------------------------
// pickTopSubtopic
// ---------------------------------------------------------------------------

function testPickTopSubtopic(): void {
  // 全空 → OTHER_GENERAL 兜底
  assertEqual(
    'pickTopSubtopic 空 counts → other_general',
    pickTopSubtopic({}),
    TOPIC_SUBCATEGORIES.OTHER_GENERAL
  );
  // 单 subcategory
  assertEqual(
    'pickTopSubtopic 单项',
    pickTopSubtopic({ [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 5 }),
    TOPIC_SUBCATEGORIES.EARNINGS_FORECAST
  );
  // max-count 胜出
  assertEqual(
    'pickTopSubtopic max-count',
    pickTopSubtopic({
      [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 2,
      [TOPIC_SUBCATEGORIES.NEW_PRODUCT]: 5,
      [TOPIC_SUBCATEGORIES.MAJOR_CONTRACT]: 1,
    }),
    TOPIC_SUBCATEGORIES.NEW_PRODUCT
  );
  // tie-break: TOPIC_SUBCATEGORY_PRIORITY (lower wins)
  // EARNINGS_FORECAST 是财务 subcategory, 通常优先级较高
  const tieResult = pickTopSubtopic({
    [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 3,
    [TOPIC_SUBCATEGORIES.OTHER_GENERAL]: 3,
  });
  // EARNINGS_FORECAST 优先级一定 < OTHER_GENERAL
  assertEqual(
    'pickTopSubtopic tie-break by priority',
    tieResult,
    TOPIC_SUBCATEGORIES.EARNINGS_FORECAST
  );
}

// ---------------------------------------------------------------------------
// roundTo3
// ---------------------------------------------------------------------------

function testRoundTo3(): void {
  assertEqual('roundTo3 0 → 0', roundTo3(0), 0);
  assertEqual('roundTo3 0.1234 → 0.123', roundTo3(0.1234), 0.123);
  assertEqual('roundTo3 0.5675 → 0.568', roundTo3(0.5675), 0.568);
  assertEqual('roundTo3 -0.3334 → -0.333', roundTo3(-0.3334), -0.333);
  assertEqual('roundTo3 NaN → 0', roundTo3(NaN), 0);
  assertEqual('roundTo3 Infinity → 0', roundTo3(Infinity), 0);
  assertEqual('roundTo3 -Infinity → 0', roundTo3(-Infinity), 0);
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

async function testSleep(): Promise<void> {
  const start = Date.now();
  await sleep(5);
  const elapsed = Date.now() - start;
  assert('sleep 5ms 至少 4ms', elapsed >= 4);
}

// ---------------------------------------------------------------------------
// aggregateForWeek — pure transform
// ---------------------------------------------------------------------------

function testAggregateForWeekHappyPath(): void {
  // 同一周 (2026-06-15 周一) 多条 Q&A
  const rows: StockQARow[] = [
    makeQARow({
      question: '公司本季度业绩预增情况如何? 是否会公告 业绩预告',
      question_time: '2026-06-15 09:30:00',
      answer: '感谢关注, 详见公司公告披露的相关内容。',
    }),
    makeQARow({
      question: '产品新一轮定价调整有什么影响? 价格变动趋势',
      question_time: '2026-06-16 10:00:00',
      answer:
        '本次定价调整后, 公司新一代产品出厂价上调 5% 应对原料涨价压力, 终端售价同步联动。',
    }),
    makeQARow({
      question: '请问业绩同比增速?',
      question_time: '2026-06-17 11:00:00',
      answer: null, // 未回答
      question_id: 'qid3',
    }),
  ];

  const result = aggregateForWeek(rows, {
    stock_code: '600519',
    stock_name: '贵州茅台',
  });
  assertEqual('aggregateForWeek 1 row (单周)', result.length, 1);

  const w = result[0];
  assertEqual('aggregateForWeek stock_code', w.stock_code, '600519');
  assertEqual('aggregateForWeek stock_name', w.stock_name, '贵州茅台');
  assertEqual('aggregateForWeek week_start (周一 2026-06-15)', w.week_start, '2026-06-15');
  assertEqual('aggregateForWeek questions_count = 3', w.questions_count, 3);
  assertEqual('aggregateForWeek answer_count = 2', w.answer_count, 2);
  assertEqual(
    'aggregateForWeek answer_rate = 0.667',
    w.answer_rate,
    roundTo3(2 / 3)
  );
  // 1 个 strong (1.0) + 1 个高质量 (0) → 0.5 均值
  assertEqual(
    'aggregateForWeek answer_template_score 均值 = 0.5',
    w.answer_template_score,
    0.5
  );
  assert(
    'aggregateForWeek avg_answer_sentiment 非 null',
    w.avg_answer_sentiment !== null
  );
  assert(
    'aggregateForWeek answer_template_score 非 null',
    w.answer_template_score !== null
  );
  // nlp_engine 默认 = HEURISTIC
  assertEqual(
    'aggregateForWeek nlp_engine default',
    w.nlp_engine,
    NLP_ENGINES.HEURISTIC
  );
  // raw_payload 含 subtopic_distribution + template_hits_sample + sample_question_ids
  assert(
    'raw_payload.subtopic_distribution 非空',
    Object.keys(w.raw_payload.subtopic_distribution).length > 0
  );
  assert(
    'raw_payload.sample_question_ids ≤ 5',
    w.raw_payload.sample_question_ids.length <= 5
  );
  assertEqual('aggregateForWeek persisted=false 初始', w.persisted, false);
}

function testAggregateForWeekMultiWeek(): void {
  const rows: StockQARow[] = [
    makeQARow({
      question: '本周业绩业绩预告',
      question_time: '2026-06-15 09:00:00',
      answer: '感谢关注', // strong + 极短? "感谢关注" 长度 4 → 极短走 1.0
    }),
    makeQARow({
      question: '上周业绩业绩预告',
      question_time: '2026-06-08 09:00:00',
      answer: '产品价格调整对营收影响 12.3% 销量同比增长。',
      question_id: 'qid-2',
    }),
  ];
  const result = aggregateForWeek(rows, { stock_code: '000001' });
  assertEqual('aggregateForWeek 2 weeks', result.length, 2);
  // sorted desc by week_start
  assert(
    'aggregateForWeek sorted desc',
    result[0].week_start > result[1].week_start
  );
}

function testAggregateForWeekNoAnswers(): void {
  const rows: StockQARow[] = [
    makeQARow({
      question: '本周业绩业绩预告',
      question_time: '2026-06-15 09:00:00',
      answer: null,
    }),
    makeQARow({
      question: '上周业绩业绩预告',
      question_time: '2026-06-15 09:30:00',
      answer: '   ', // 全空白视为无回答
      question_id: 'qid-blank',
    }),
  ];
  const result = aggregateForWeek(rows, { stock_code: '000001' });
  assertEqual('aggregateForWeek 1 week', result.length, 1);
  const w = result[0];
  assertEqual('answer_count = 0', w.answer_count, 0);
  assertEqual('answer_rate = 0', w.answer_rate, 0);
  assertEqual(
    'avg_answer_sentiment = null',
    w.avg_answer_sentiment,
    null
  );
  assertEqual(
    'answer_template_score = null',
    w.answer_template_score,
    null
  );
}

function testAggregateForWeekAllTemplate(): void {
  const rows: StockQARow[] = [
    makeQARow({
      question: '业绩业绩预告',
      question_time: '2026-06-15 09:00:00',
      answer: '感谢关注本次提问, 详见后续公告披露。',
    }),
    makeQARow({
      question: '业绩业绩预告',
      question_time: '2026-06-15 10:00:00',
      answer: '感谢您的提问, 请投资者注意投资风险。',
      question_id: 'qid-2',
    }),
  ];
  const result = aggregateForWeek(rows, { stock_code: '000001' });
  assertEqual('aggregateForWeek 1 week', result.length, 1);
  assertEqual(
    'answer_template_score = 1 (全模板)',
    result[0].answer_template_score,
    1
  );
  // 命中样本应有 2 条
  assertEqual(
    'template_hits_sample.length = 2',
    result[0].raw_payload.template_hits_sample.length,
    2
  );
}

function testAggregateForWeekSinceFilter(): void {
  const rows: StockQARow[] = [
    makeQARow({
      question: '本周业绩业绩预告',
      question_time: '2026-06-15 09:00:00',
      answer: null,
    }),
    makeQARow({
      question: '老旧业绩业绩预告',
      question_time: '2025-01-01 09:00:00', // 早于 since_date
      answer: null,
      question_id: 'qid-old',
    }),
  ];
  const result = aggregateForWeek(rows, {
    stock_code: '000001',
    since_date: '2026-01-01',
  });
  assertEqual('aggregateForWeek 1 week (sinceFilter)', result.length, 1);
  assertEqual('questions_count = 1', result[0].questions_count, 1);
}

function testAggregateForWeekInvalidQuestionTime(): void {
  const rows: StockQARow[] = [
    makeQARow({
      question: 'good',
      question_time: '2026-06-15 09:00:00',
    }),
    makeQARow({
      question: 'bad',
      question_time: 'not-a-date',
      question_id: 'qid-bad',
    }),
    makeQARow({
      question: 'empty time',
      question_time: '', // 空 question_time → skip
      question_id: 'qid-empty',
    }),
  ];
  const result = aggregateForWeek(rows, { stock_code: '000001' });
  // 只有 1 条有效 (computeWeekStart throw 的被 catch 掉; 空 question_time 直接 skip)
  assertEqual('aggregateForWeek invalid 跳过', result.length, 1);
  assertEqual('aggregateForWeek questions_count = 1', result[0].questions_count, 1);
}

function testAggregateForWeekEmpty(): void {
  const result = aggregateForWeek([], { stock_code: '000001' });
  assertEqual('aggregateForWeek 空 array → []', result.length, 0);
}

function testAggregateForWeekSampleQuestionIdsCap(): void {
  const rows: StockQARow[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push(
      makeQARow({
        question: `业绩业绩预告 ${i}`,
        question_time: '2026-06-15 09:00:00',
        question_id: `qid-${i}`,
      })
    );
  }
  const result = aggregateForWeek(rows, { stock_code: '000001' });
  assertEqual('sample_question_ids cap 5', result[0].raw_payload.sample_question_ids.length, 5);
}

function testAggregateForWeekTemplateHitsSampleCap(): void {
  const rows: StockQARow[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push(
      makeQARow({
        question: `业绩业绩预告 ${i}`,
        question_time: '2026-06-15 09:00:00',
        question_id: `qid-${i}`,
        answer: '感谢关注本公司的相关业务关注, 详见近期公告披露内容。', // strong → 1.0
      })
    );
  }
  const result = aggregateForWeek(rows, { stock_code: '000001' });
  assertEqual(
    'template_hits_sample cap 5',
    result[0].raw_payload.template_hits_sample.length,
    5
  );
}

function testAggregateForWeekCustomEngine(): void {
  const rows: StockQARow[] = [
    makeQARow({
      question: '业绩业绩预告',
      question_time: '2026-06-15 09:00:00',
    }),
  ];
  const result = aggregateForWeek(rows, {
    stock_code: '000001',
    nlp_engine: 'openai',
  });
  assertEqual('aggregateForWeek custom nlp_engine', result[0].nlp_engine, 'openai');
}

// ---------------------------------------------------------------------------
// aggregator.aggregateForStock — e2e
// ---------------------------------------------------------------------------

async function testAggregateForStockHappyPath(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchByStock: {
      '600519': [
        makeQARow({
          question: '业绩业绩预告',
          question_time: '2026-06-15 09:00:00',
          answer:
            '公司本季度营收 12.3 亿元同比增长 18%, 海外订单显著贡献,新签合同 8.7 亿元。',
        }),
        makeQARow({
          question: '产品价格调整',
          question_time: '2026-06-08 10:00:00',
          answer: '感谢关注本次提问, 详见公司公告披露。',
          question_id: 'qid-2',
        }),
      ],
    },
  });
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStock('600519');

  assertEqual('aggregateForStock fetched=2', result.fetched, 2);
  assertEqual('aggregateForStock weeks_aggregated=2', result.weeks_aggregated, 2);
  assertEqual('aggregateForStock rows_upserted=2', result.rows_upserted, 2);
  assertEqual('aggregateForStock no error', !result.error, true);
  // 走的是 fake DS, 不写真 model store, 只看 saveCalls
  assertEqual('saveCalls.length=1', state.saveCalls.length, 1);
  assertEqual('saveCalls[0].length=2', state.saveCalls[0].length, 2);
  // 默认 limit=DEFAULT_QA_STAT_FETCH_LIMIT
  assertEqual(
    'fetchCalls 默认 limit',
    state.fetchCalls[0].limit,
    DEFAULT_QA_STAT_FETCH_LIMIT
  );
}

async function testAggregateForStockDryRun(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchByStock: {
      '600519': [
        makeQARow({
          question: '业绩业绩预告',
          question_time: '2026-06-15 09:00:00',
          answer: '正常回答。',
        }),
      ],
    },
  });
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStock('600519', { dry_run: true });

  assertEqual('aggregateForStock dry_run fetched=1', result.fetched, 1);
  assertEqual('aggregateForStock dry_run rows_upserted=0', result.rows_upserted, 0);
  assertEqual('aggregateForStock dry_run no error', !result.error, true);
  assertEqual('saveStats 未被调用 (dry_run)', state.saveCalls.length, 0);
}

async function testAggregateForStockInvalidCode(): Promise<void> {
  resetStore();
  const state = makeFakeDSState();
  const aggregator = new QAStatAggregator(makeFakeDS(state));

  let result = await aggregator.aggregateForStock('');
  assert('aggregateForStock 空 → error', !!result.error);
  result = await aggregator.aggregateForStock('BAD');
  assert('aggregateForStock BAD → error', !!result.error);
  result = await aggregator.aggregateForStock('12345'); // 5 位
  assert('aggregateForStock 5 位 → error', !!result.error);
  result = await aggregator.aggregateForStock('1234567'); // 7 位
  assert('aggregateForStock 7 位 → error', !!result.error);

  // 不应触发 fetchForStock
  assertEqual('Invalid 不触发 fetch', state.fetchCalls.length, 0);
}

async function testAggregateForStockFetchEmpty(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({ fetchByStock: { '600519': [] } });
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStock('600519');
  assertEqual('aggregateForStock fetch empty fetched=0', result.fetched, 0);
  assertEqual('aggregateForStock fetch empty rows_upserted=0', result.rows_upserted, 0);
  assertEqual('aggregateForStock fetch empty no error', !!result.error, false);
  // saveStats 不应被调用 (空就返回)
  assertEqual('saveStats 不调 (空数据)', state.saveCalls.length, 0);
}

async function testAggregateForStockSaveFailOpen(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    saveShouldThrow: true,
    fetchByStock: {
      '600519': [
        makeQARow({
          question: '业绩业绩预告',
          question_time: '2026-06-15 09:00:00',
        }),
      ],
    },
  });
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStock('600519');
  assertEqual('saveFailOpen fetched=1', result.fetched, 1);
  assertEqual('saveFailOpen rows_upserted=0', result.rows_upserted, 0);
  assert('saveFailOpen error 字段包含 save_failed', /save_failed/.test(result.error || ''));
}

async function testAggregateForStockFetchThrows(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchShouldThrowFor: new Set(['600519']),
  });
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStock('600519');
  assertEqual('fetchThrows fetched=0', result.fetched, 0);
  assert('fetchThrows error 非空', !!result.error);
}

// ---------------------------------------------------------------------------
// aggregator.aggregateForStocks
// ---------------------------------------------------------------------------

async function testAggregateForStocksAllSucceed(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchByStock: {
      '600519': [
        makeQARow({
          question: 'A 业绩业绩预告',
          question_time: '2026-06-15 09:00:00',
        }),
      ],
      '000001': [
        makeQARow({
          question: 'B 业绩业绩预告',
          question_time: '2026-06-15 10:00:00',
          stock_code: '000001',
          stock_name: '平安银行',
          question_id: 'qid-b',
        }),
      ],
    },
  });
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStocks(['600519', '000001'], {
    interval_ms: 0,
  });
  assertEqual('aggregateForStocks total=2', result.total_stocks, 2);
  assertEqual('aggregateForStocks succeeded=2', result.succeeded, 2);
  assertEqual('aggregateForStocks failed=0', result.failed, 0);
}

async function testAggregateForStocksContinueOnError(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchShouldThrowFor: new Set(['600519']),
    fetchByStock: {
      '000001': [
        makeQARow({
          question: 'B 业绩业绩预告',
          question_time: '2026-06-15 10:00:00',
        }),
      ],
    },
  });
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStocks(['600519', '000001'], {
    interval_ms: 0,
    continue_on_error: true,
  });
  assertEqual('continueOnError total=2', result.total_stocks, 2);
  assertEqual('continueOnError succeeded=1', result.succeeded, 1);
  assertEqual('continueOnError failed=1', result.failed, 1);
}

async function testAggregateForStocksStopOnFirstError(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchShouldThrowFor: new Set(['600519']),
    fetchByStock: {
      '000001': [
        makeQARow({
          question: 'ok',
          question_time: '2026-06-15 10:00:00',
        }),
      ],
    },
  });
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStocks(['600519', '000001'], {
    interval_ms: 0,
    continue_on_error: false,
  });
  assertEqual('stopOnFirstError total=2', result.total_stocks, 2);
  assertEqual('stopOnFirstError succeeded=0', result.succeeded, 0);
  assertEqual('stopOnFirstError failed=1', result.failed, 1);
  // details 只跑了 1 个 (停在第 1 个失败)
  assertEqual('stopOnFirstError details.length=1', result.details.length, 1);
}

async function testAggregateForStocksAllInvalid(): Promise<void> {
  resetStore();
  const state = makeFakeDSState();
  const aggregator = new QAStatAggregator(makeFakeDS(state));
  const result = await aggregator.aggregateForStocks(['BAD1', 'BAD2'], {
    interval_ms: 0,
  });
  assertEqual('AllInvalid total=2', result.total_stocks, 2);
  assertEqual('AllInvalid failed=2', result.failed, 2);
  assertEqual('AllInvalid succeeded=0', result.succeeded, 0);
}

// ---------------------------------------------------------------------------
// aggregator.listByStock
// ---------------------------------------------------------------------------

async function testListByStockDefault(): Promise<void> {
  resetStore();
  // 直接插一行
  const isoToday = new Date().toISOString().slice(0, 10);
  store.push({
    stock_code: '600519',
    week_start: isoToday,
    questions_count: 3,
    answer_count: 2,
    answer_rate: 0.667,
    top_subtopic: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST,
    avg_question_sentiment: 0.2,
    avg_answer_sentiment: 0.5,
    answer_template_score: 0.4,
    nlp_engine: NLP_ENGINES.HEURISTIC,
    raw_payload: {},
  });
  store.push({
    stock_code: '000001',
    week_start: isoToday,
    questions_count: 1,
    answer_count: 0,
    answer_rate: 0,
    top_subtopic: TOPIC_SUBCATEGORIES.OTHER_GENERAL,
    avg_question_sentiment: 0,
    avg_answer_sentiment: null,
    answer_template_score: null,
    nlp_engine: NLP_ENGINES.HEURISTIC,
    raw_payload: {},
  });

  const aggregator = new QAStatAggregator(makeFakeDS(makeFakeDSState()));
  const rows = await aggregator.listByStock('600519');
  assertEqual('listByStock 1 row', rows.length, 1);
  assertEqual('listByStock code', rows[0].stock_code, '600519');
}

async function testListByStockEmptyOrInvalid(): Promise<void> {
  resetStore();
  const aggregator = new QAStatAggregator(makeFakeDS(makeFakeDSState()));
  let rows = await aggregator.listByStock('');
  assertEqual('listByStock 空 → []', rows.length, 0);
  rows = await aggregator.listByStock('BADCODE');
  assertEqual('listByStock BADCODE → []', rows.length, 0);
}

async function testListByStockWeeksClamp(): Promise<void> {
  resetStore();
  const aggregator = new QAStatAggregator(makeFakeDS(makeFakeDSState()));
  // 不抛 + 默认/越界都正确处理
  await aggregator.listByStock('600519', 9999);
  await aggregator.listByStock('600519', 0);
  await aggregator.listByStock('600519', -10);
  await aggregator.listByStock('600519', 1);
  await aggregator.listByStock('600519');
  assert('listByStock 多 weeks 值都不抛', true);
  // DEFAULT_QA_STAT_LIST_WEEKS sanity
  assert('DEFAULT_QA_STAT_LIST_WEEKS ≥ 1', DEFAULT_QA_STAT_LIST_WEEKS >= 1);
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installModelStubs();

  // 常量冻结
  testTemplateKeywordsFrozen();

  // pure helpers
  testDetectTemplateAnswer();
  testPickTopSubtopic();
  testRoundTo3();
  await testSleep();
  testAggregateForWeekHappyPath();
  testAggregateForWeekMultiWeek();
  testAggregateForWeekNoAnswers();
  testAggregateForWeekAllTemplate();
  testAggregateForWeekSinceFilter();
  testAggregateForWeekInvalidQuestionTime();
  testAggregateForWeekEmpty();
  testAggregateForWeekSampleQuestionIdsCap();
  testAggregateForWeekTemplateHitsSampleCap();
  testAggregateForWeekCustomEngine();

  // service e2e
  await testAggregateForStockHappyPath();
  await testAggregateForStockDryRun();
  await testAggregateForStockInvalidCode();
  await testAggregateForStockFetchEmpty();
  await testAggregateForStockSaveFailOpen();
  await testAggregateForStockFetchThrows();

  // batch
  await testAggregateForStocksAllSucceed();
  await testAggregateForStocksContinueOnError();
  await testAggregateForStocksStopOnFirstError();
  await testAggregateForStocksAllInvalid();

  // listByStock
  await testListByStockDefault();
  await testListByStockEmptyOrInvalid();
  await testListByStockWeeksClamp();

  console.log(`\n${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});

// Avoid unused-import warning for type-only SubtopicCategory reference.
const _typecheck: SubtopicCategory = TOPIC_SUBCATEGORIES.OTHER_GENERAL;
void _typecheck;
