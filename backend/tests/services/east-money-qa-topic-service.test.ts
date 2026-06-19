/**
 * EastMoneyQATopicService 单元测试 (US-060 AI 东财问答 NLP 与个股关注度)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/east-money-qa-topic-service.test.ts
 *
 * 完全脱离 DB / Python 子进程 / TradingAgents 远端: 注入 fake EastMoneyQATopicDataSource +
 * monkey-patch EastMoneyQATopic Sequelize Model 静态方法成内存 store
 * (与 announcement-nlp-service / snowball-hot-keyword-sync-service / ai-advisor-service
 * 同款 in-memory model 测试模式).
 *
 * 覆盖维度:
 *   - 常量冻结校验 (TOPIC_VALUES / TOPIC_PRIORITY / NLP_ENGINES / TOPIC_KEYWORDS /
 *     QA_SENTIMENT_KEYWORDS);
 *   - 纯函数:
 *     - sleep (resolve);
 *     - computeWeekStart (周一 ISO / 周日 / 周末 / 跨月跨年 / 带时间 / 非法 throw);
 *     - classifyTopic (各 6 类命中 + 兜底 + 优先级 + null);
 *     - detectTopicByKeyword (命中 / 未命中 / null);
 *     - scoreSentiment (4 档 + 优先级强空最优先 + null);
 *     - normalizeTopic (中文 / 英文 / 大小写 / 未识别);
 *     - aggregateWeekly (按周聚合 / 平均分 / breakdown / sample_ids / sinceDate filter /
 *       useAI 路径 / 空数组 / 无效 question_time / 排序);
 *     - parseRemoteClassify (success / FAILED / 无 data / 非有限 score / clamp);
 *   - service.syncStock() e2e:
 *     - happy path: 启发式 N 条问题 → M 周聚合 → upsert;
 *     - dry_run=true: 不写库;
 *     - 无效 stock_code → error;
 *     - fetch 返回 [] → 0 行 + no error;
 *     - useAI=true: 每条问题调远端 + AI map 优先 + fallback 启发式;
 *     - AI 远端 throw → 双重防御 catch + fallback 启发式;
 *     - saveTopics throws → fail-OPEN + error 字段;
 *   - service.syncStocks() e2e:
 *     - 批量遍历 + 节流;
 *     - 单股失败 continue_on_error=true 不阻塞;
 *     - continue_on_error=false 第一只失败即停;
 *   - service.listByStock() e2e:
 *     - 默认 weeks=26;
 *     - 非法 stock_code → [];
 *     - weeks 上限 clamp;
 */

import {
  EastMoneyQATopicService,
  EastMoneyQATopicDataSource,
  AggregatedTopicRow,
  RemoteQATopicPayload,
  TOPIC_CATEGORIES,
  TOPIC_VALUES,
  TOPIC_PRIORITY,
  TOPIC_KEYWORDS,
  QA_SENTIMENT_KEYWORDS,
  NLP_ENGINES,
  DEFAULT_FETCH_LIMIT,
  DEFAULT_LIST_WEEKS,
  TopicCategory,
  TOPIC_SUBCATEGORIES,
  SUBTOPIC_VALUES,
  TOPIC_SUBCATEGORY_OF,
  TOPIC_SUBCATEGORY_KEYWORDS,
  TOPIC_SUBCATEGORY_PRIORITY,
  SUBTOPICS_BY_TOPIC,
  TOPIC_OTHER_SUBCATEGORY,
  SubtopicCategory,
  sleep,
  computeWeekStart,
  classifyTopic,
  detectTopicByKeyword,
  scoreSentiment,
  normalizeTopic,
  aggregateWeekly,
  parseRemoteClassify,
  classifySubtopic,
  detectSubtopicByKeyword,
  deriveTopicFromSubtopic,
} from '../../src/services/EastMoneyQATopicService';
import { StockQARow } from '../../src/data/sources/StockQAClient';
import { EastMoneyQATopic } from '../../src/models/EastMoneyQATopic';

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
// In-memory backing-store for EastMoneyQATopic model static method stubs
// ---------------------------------------------------------------------------

interface FakeTopicRow {
  id?: number;
  stock_code: string;
  stock_name?: string | null;
  week_start: string;
  topic: string;
  mention_count: number;
  sentiment_score: number;
  nlp_engine?: string | null;
  raw_payload?: unknown;
  updated_at?: Date;
}

let store: FakeTopicRow[] = [];
let nextId = 1;

function resetStore(): void {
  store = [];
  nextId = 1;
}

function installModelStubs(): void {
  // bulkCreate — upsert by (stock_code, week_start, topic)
  (EastMoneyQATopic as any).bulkCreate = async (
    records: FakeTopicRow[],
    _options?: unknown
  ): Promise<FakeTopicRow[]> => {
    for (const r of records) {
      const idx = store.findIndex(
        s =>
          s.stock_code === r.stock_code &&
          s.week_start === r.week_start &&
          s.topic === r.topic
      );
      const merged: FakeTopicRow = { ...r, updated_at: new Date() };
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

  // findAll — supports where.stock_code + where.week_start gte/lte + order
  (EastMoneyQATopic as any).findAll = async (options: any): Promise<FakeTopicRow[]> => {
    let candidates = [...store];
    const sc = options?.where?.stock_code;
    if (typeof sc === 'string') {
      candidates = candidates.filter(s => s.stock_code === sc);
    }
    const ws = options?.where?.week_start;
    if (typeof ws === 'string') {
      candidates = candidates.filter(s => s.week_start === ws);
    } else if (ws && typeof ws === 'object') {
      const symbols = Object.getOwnPropertySymbols(ws);
      for (const sym of symbols) {
        const symStr = sym.toString();
        const v = ws[sym];
        if (symStr.includes('gte')) candidates = candidates.filter(s => s.week_start >= v);
        else if (symStr.includes('lte')) candidates = candidates.filter(s => s.week_start <= v);
        else if (symStr.includes('lt')) candidates = candidates.filter(s => s.week_start < v);
        else if (symStr.includes('gt')) candidates = candidates.filter(s => s.week_start > v);
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
    if (options?.limit) {
      candidates = candidates.slice(0, options.limit);
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
  remoteShouldThrow?: boolean;
  remotePayload?: RemoteQATopicPayload;
  remoteCalls: Array<{ question: string; ctx?: { stock_code?: string } }>;
  saveCalls: AggregatedTopicRow[][];
}

function makeFakeDS(state: FakeDSState): EastMoneyQATopicDataSource {
  return {
    async fetchForStock(stockCode: string, _limit?: number) {
      if (state.fetchShouldThrowFor && state.fetchShouldThrowFor.has(stockCode)) {
        throw new Error(`fake fetch outage for ${stockCode}`);
      }
      return state.fetchByStock[stockCode] || [];
    },
    async callRemoteClassify(question: string, context) {
      state.remoteCalls.push({ question, ctx: context });
      if (state.remoteShouldThrow) throw new Error('fake remote outage');
      return (
        state.remotePayload || {
          status: 'COMPLETED',
          data: {
            topic: '财务',
            sentiment_score: 0.8,
          },
        }
      );
    },
    async saveTopics(rows: AggregatedTopicRow[]) {
      if (state.saveShouldThrow) throw new Error('fake save outage');
      state.saveCalls.push([...rows]);
    },
  };
}

function makeFakeDSState(overrides: Partial<FakeDSState> = {}): FakeDSState {
  return {
    fetchByStock: {},
    remoteCalls: [],
    saveCalls: [],
    ...overrides,
  };
}

function makeQARow(
  partial: Partial<StockQARow> & { question: string; question_time: string }
): StockQARow {
  // Provide a deterministic question_id when caller doesn't pass one
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
// Constant-freeze tests
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assert('TOPIC_CATEGORIES frozen', Object.isFrozen(TOPIC_CATEGORIES));
  assert('TOPIC_VALUES frozen', Object.isFrozen(TOPIC_VALUES));
  assert('TOPIC_PRIORITY frozen', Object.isFrozen(TOPIC_PRIORITY));
  assert('NLP_ENGINES frozen', Object.isFrozen(NLP_ENGINES));
  assert('TOPIC_KEYWORDS frozen', Object.isFrozen(TOPIC_KEYWORDS));
  assert('QA_SENTIMENT_KEYWORDS frozen', Object.isFrozen(QA_SENTIMENT_KEYWORDS));

  // AC 要求 6 类
  assertEqual('TOPIC_VALUES length 6', TOPIC_VALUES.length, 6);
  // FINANCE 必须最高优先级
  assertEqual(
    'TOPIC_PRIORITY FINANCE = 0',
    TOPIC_PRIORITY[TOPIC_CATEGORIES.FINANCE],
    0
  );
  // OTHER 必须最低优先级
  assert(
    'TOPIC_PRIORITY OTHER 最低',
    TOPIC_PRIORITY[TOPIC_CATEGORIES.OTHER] >=
      Math.max(
        ...Object.entries(TOPIC_PRIORITY)
          .filter(([k]) => k !== TOPIC_CATEGORIES.OTHER)
          .map(([, v]) => v)
      )
  );
}

function testDefaultsSanity(): void {
  assert('DEFAULT_FETCH_LIMIT > 0', DEFAULT_FETCH_LIMIT > 0);
  assert('DEFAULT_LIST_WEEKS > 0', DEFAULT_LIST_WEEKS > 0);
  assert('DEFAULT_LIST_WEEKS ≤ 104', DEFAULT_LIST_WEEKS <= 104);
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

async function testSleep(): Promise<void> {
  const start = Date.now();
  await sleep(20);
  const elapsed = Date.now() - start;
  assert('sleep ~20ms', elapsed >= 15);
}

function testComputeWeekStart(): void {
  // 2026-06-08 是周一 → self
  assertEqual('周一 self', computeWeekStart('2026-06-08'), '2026-06-08');
  // 2026-06-09 周二 → 2026-06-08
  assertEqual('周二 → 周一', computeWeekStart('2026-06-09'), '2026-06-08');
  // 2026-06-14 周日 → 2026-06-08
  assertEqual('周日 → 上周一', computeWeekStart('2026-06-14'), '2026-06-08');
  // 2026-06-04 周四 → 2026-06-01
  assertEqual('周四 → 周一', computeWeekStart('2026-06-04'), '2026-06-01');
  // 带时间戳 (cninfo 实际返回格式) 'YYYY-MM-DD HH:mm:ss'
  assertEqual(
    '带时间戳的周三',
    computeWeekStart('2026-06-10 14:30:25'),
    '2026-06-08'
  );
  // 跨月: 2026-07-02 周四 → 2026-06-29 (周一)
  assertEqual('跨月', computeWeekStart('2026-07-02'), '2026-06-29');
  // 跨年: 2026-01-01 周四 → 2025-12-29 (周一)
  assertEqual('跨年', computeWeekStart('2026-01-01'), '2025-12-29');
  // Date object 输入
  assertEqual(
    'Date object',
    computeWeekStart(new Date(Date.UTC(2026, 5, 12))), // 2026-06-12 周五
    '2026-06-08'
  );

  // 非法格式 throws
  let threw = false;
  try {
    computeWeekStart('not-a-date');
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert('computeWeekStart 非法 throws RangeError', threw);
}

function testClassifyTopic(): void {
  // 单字典命中
  assertEqual('财务: 营收', classifyTopic('上半年营收预期如何'), '财务');
  assertEqual('产品: 新品', classifyTopic('新品什么时候量产'), '产品');
  assertEqual('订单: 合同', classifyTopic('海外订单合同签订进展'), '订单');
  assertEqual('人事: 高管', classifyTopic('高管变动通知'), '人事');
  assertEqual('政策: 监管', classifyTopic('行业监管政策影响'), '政策');

  // 兜底
  assertEqual('其它: 兜底', classifyTopic('您好'), '其它');
  assertEqual('null → 其它', classifyTopic(null), '其它');
  assertEqual('undefined → 其它', classifyTopic(undefined), '其它');
  assertEqual('空串 → 其它', classifyTopic(''), '其它');
  assertEqual('空白串 → 其它', classifyTopic('   '), '其它');

  // 命中数多者胜: 含 3 个财务词 + 1 个产品词 → 财务
  assertEqual(
    '命中数多胜: 财务多',
    classifyTopic('请问营收 净利 现金流 与新产品规划'),
    '财务'
  );

  // 平手按优先级: 财务 1 + 产品 1 → 财务 (FINANCE 优先)
  assertEqual(
    '平手: 财务 vs 产品 → 财务',
    classifyTopic('营收与产品规划'),
    '财务'
  );
  // 平手 ORDER vs PRODUCT → ORDER (ORDER 优先级高于 PRODUCT)
  assertEqual(
    '平手: 订单 vs 产品 → 订单',
    classifyTopic('订单与产品的关系'),
    '订单'
  );
  // 平手 POLICY vs PERSONNEL → POLICY
  assertEqual(
    '平手: 政策 vs 人事 → 政策',
    classifyTopic('政策与高管变化'),
    '政策'
  );
}

function testDetectTopicByKeyword(): void {
  assert('detect 财务 hit', detectTopicByKeyword('营收同比增长', TOPIC_CATEGORIES.FINANCE));
  assert(
    'detect 财务 miss',
    !detectTopicByKeyword('召开股东大会', TOPIC_CATEGORIES.FINANCE)
  );
  assert('detect null → false', !detectTopicByKeyword(null, TOPIC_CATEGORIES.FINANCE));
  // OTHER 字典是空 → 永远 false
  assert(
    'detect 其它 字典 empty → false',
    !detectTopicByKeyword('随便什么话题', TOPIC_CATEGORIES.OTHER)
  );
}

function testScoreSentiment(): void {
  // 强空 = -1.0
  assertEqual('强空: 立案 → -1', scoreSentiment('公司被立案调查'), -1.0);
  assertEqual('强空: 退市 → -1', scoreSentiment('退市风险警示'), -1.0);
  assertEqual('强空: ST → -1', scoreSentiment('实施 ST 警示'), -1.0);
  // 强多 = +1.0
  assertEqual('强多: 业绩超预期 → +1', scoreSentiment('业绩超预期增长'), 1.0);
  assertEqual('强多: 中标 → +1', scoreSentiment('中标某合同'), 1.0);
  assertEqual('强多: 回购 → +1', scoreSentiment('实施股份回购'), 1.0);
  // 弱空 = -0.5
  assertEqual('弱空: 减持 → -0.5', scoreSentiment('股东减持计划'), -0.5);
  assertEqual('弱空: 下滑 → -0.5', scoreSentiment('业绩下滑'), -0.5);
  // 弱多 = +0.5
  assertEqual('弱多: 增长 → +0.5', scoreSentiment('收入增长稳定'), 0.5);
  assertEqual('弱多: 战略合作 → +0.5', scoreSentiment('与某公司战略合作'), 0.5);
  // 中性
  assertEqual('中性: 提问', scoreSentiment('请问财务状况'), 0);
  assertEqual('null → 0', scoreSentiment(null), 0);
  assertEqual('undefined → 0', scoreSentiment(undefined), 0);
  assertEqual('空串 → 0', scoreSentiment(''), 0);

  // 优先级: 同时含强空+强多 → 强空 (安全派)
  assertEqual(
    '优先级 强空 > 强多',
    scoreSentiment('业绩超预期但被立案调查'),
    -1.0
  );
  // 强空 > 弱空
  assertEqual('优先级 强空 > 弱空', scoreSentiment('立案 + 减持'), -1.0);
  // 强多 > 弱空 (按代码: strongNeg → strongPos → weakNeg → weakPos)
  assertEqual('优先级 强多 > 弱空', scoreSentiment('回购 + 减持'), 1.0);
}

function testNormalizeTopic(): void {
  // 中文
  assertEqual('中文 财务', normalizeTopic('财务'), '财务');
  assertEqual('中文 产品类', normalizeTopic('产品类'), '产品');
  assertEqual('中文 订单', normalizeTopic('订单'), '订单');
  assertEqual('中文 人事变动', normalizeTopic('人事变动'), '人事');
  assertEqual('中文 政策面', normalizeTopic('政策面'), '政策');
  assertEqual('中文 其它', normalizeTopic('其它'), '其它');

  // 英文
  assertEqual('英文 finance → 财务', normalizeTopic('finance'), '财务');
  assertEqual('英文 FINANCIAL → 财务', normalizeTopic('FINANCIAL'), '财务');
  assertEqual('英文 product → 产品', normalizeTopic('product'), '产品');
  assertEqual('英文 Tech → 产品', normalizeTopic('Tech'), '产品');
  assertEqual('英文 order → 订单', normalizeTopic('order'), '订单');
  assertEqual('英文 contract → 订单', normalizeTopic('contract'), '订单');
  assertEqual('英文 customer → 订单', normalizeTopic('customer'), '订单');
  assertEqual('英文 personnel → 人事', normalizeTopic('personnel'), '人事');
  assertEqual('英文 HR → 人事', normalizeTopic('HR'), '人事');
  assertEqual('英文 executive → 人事', normalizeTopic('executive'), '人事');
  assertEqual('英文 policy → 政策', normalizeTopic('policy'), '政策');
  assertEqual('英文 regulation → 政策', normalizeTopic('regulation'), '政策');
  assertEqual('英文 subsidy → 政策', normalizeTopic('subsidy'), '政策');

  // 未识别
  assertEqual('未识别 → 其它', normalizeTopic('xyz'), '其它');
  assertEqual('null → 其它', normalizeTopic(null), '其它');
  assertEqual('undefined → 其它', normalizeTopic(undefined), '其它');
  assertEqual('空串 → 其它', normalizeTopic(''), '其它');
  assertEqual('空白 → 其它', normalizeTopic('   '), '其它');
}

// ---------------------------------------------------------------------------
// QA-001 subcategory tests (TOPIC_SUBCATEGORIES + classifySubtopic)
// ---------------------------------------------------------------------------

/**
 * 100 条人工标注语料 (question, expected_subtopic) — AC: 准确率 ≥ 80%.
 *
 * 覆盖 6 个父类下 24 个 actionable subtopic + 兜底 *_other (含 other_general).
 * 真实 cninfo 互动易 / 东财股吧高频问题精简改写.
 */
const SUBTOPIC_LABELED_CORPUS: Array<{
  q: string;
  expected: SubtopicCategory;
}> = [
  // ---- FINANCE: earnings_forecast (8) ----
  { q: '请问公司今年的业绩预告会预增还是预减?', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '业绩快报什么时候出?', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '业绩预增的幅度大约多少', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '今年是否会业绩预减', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '业绩超预期的概率高不高', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '会不会业绩低于预期', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '是否会发业绩预告', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '公司业绩指引方向', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  // ---- FINANCE: quarterly_report (5) ----
  { q: '请问一季报披露时间', expected: TOPIC_SUBCATEGORIES.QUARTERLY_REPORT },
  { q: '半年报什么时候发布', expected: TOPIC_SUBCATEGORIES.QUARTERLY_REPORT },
  { q: '三季报披露日期', expected: TOPIC_SUBCATEGORIES.QUARTERLY_REPORT },
  { q: '年报披露安排', expected: TOPIC_SUBCATEGORIES.QUARTERLY_REPORT },
  { q: '中报披露时间能否确认', expected: TOPIC_SUBCATEGORIES.QUARTERLY_REPORT },
  // ---- FINANCE: dividend_buyback (5) ----
  { q: '今年的分红方案如何', expected: TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK },
  { q: '公司是否会回购股份', expected: TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK },
  { q: '大股东会增持吗', expected: TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK },
  { q: '会不会高送转', expected: TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK },
  { q: '现金分红比例多少', expected: TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK },
  // ---- FINANCE: capital_action (4) ----
  { q: '是否有定增计划', expected: TOPIC_SUBCATEGORIES.CAPITAL_ACTION },
  { q: '可转债会发行吗', expected: TOPIC_SUBCATEGORIES.CAPITAL_ACTION },
  { q: '配股安排', expected: TOPIC_SUBCATEGORIES.CAPITAL_ACTION },
  { q: '募投项目进展', expected: TOPIC_SUBCATEGORIES.CAPITAL_ACTION },
  // ---- FINANCE: cashflow_concern (3) ----
  { q: '应收账款是否过高', expected: TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN },
  { q: '存货周转情况', expected: TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN },
  { q: '负债率水平如何', expected: TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN },
  // ---- PRODUCT: new_product (5) ----
  { q: '新车型上市发布时间', expected: TOPIC_SUBCATEGORIES.NEW_PRODUCT },
  { q: '新品发布会安排', expected: TOPIC_SUBCATEGORIES.NEW_PRODUCT },
  { q: '新一代产品规划', expected: TOPIC_SUBCATEGORIES.NEW_PRODUCT },
  { q: '新机型量产时间', expected: TOPIC_SUBCATEGORIES.NEW_PRODUCT },
  { q: '新规格产品何时上市', expected: TOPIC_SUBCATEGORIES.NEW_PRODUCT },
  // ---- PRODUCT: capacity (5) ----
  { q: '产能扩张到什么程度', expected: TOPIC_SUBCATEGORIES.CAPACITY },
  { q: '在建产线进度', expected: TOPIC_SUBCATEGORIES.CAPACITY },
  { q: '工厂稼动率多少', expected: TOPIC_SUBCATEGORIES.CAPACITY },
  { q: '扩建项目何时投产', expected: TOPIC_SUBCATEGORIES.CAPACITY },
  { q: '试产顺利吗', expected: TOPIC_SUBCATEGORIES.CAPACITY },
  // ---- PRODUCT: rd_progress (4) ----
  { q: '研发项目临床进度', expected: TOPIC_SUBCATEGORIES.RD_PROGRESS },
  { q: '专利申请情况', expected: TOPIC_SUBCATEGORIES.RD_PROGRESS },
  { q: '技术突破方向', expected: TOPIC_SUBCATEGORIES.RD_PROGRESS },
  { q: 'IND申请进展', expected: TOPIC_SUBCATEGORIES.RD_PROGRESS },
  // ---- PRODUCT: quality_recall (3) ----
  { q: '产品召回如何处理', expected: TOPIC_SUBCATEGORIES.QUALITY_RECALL },
  { q: '近期投诉是否影响销量', expected: TOPIC_SUBCATEGORIES.QUALITY_RECALL },
  { q: '产品缺陷召回事件', expected: TOPIC_SUBCATEGORIES.QUALITY_RECALL },
  // ---- ORDER: major_contract (4) ----
  { q: '近期是否有大订单中标', expected: TOPIC_SUBCATEGORIES.MAJOR_CONTRACT },
  { q: '中标公告何时发布', expected: TOPIC_SUBCATEGORIES.MAJOR_CONTRACT },
  { q: '亿元订单的客户是谁', expected: TOPIC_SUBCATEGORIES.MAJOR_CONTRACT },
  { q: '重大合同签订进展', expected: TOPIC_SUBCATEGORIES.MAJOR_CONTRACT },
  // ---- ORDER: export (4) ----
  { q: '海外业务收入占比', expected: TOPIC_SUBCATEGORIES.EXPORT },
  { q: '出口订单是否增加', expected: TOPIC_SUBCATEGORIES.EXPORT },
  { q: '北美市场拓展情况', expected: TOPIC_SUBCATEGORIES.EXPORT },
  { q: '东南亚业务进展', expected: TOPIC_SUBCATEGORIES.EXPORT },
  // ---- ORDER: new_customer (3) ----
  { q: '是否有新的大客户导入', expected: TOPIC_SUBCATEGORIES.NEW_CUSTOMER },
  { q: '新客户开发情况', expected: TOPIC_SUBCATEGORIES.NEW_CUSTOMER },
  { q: '战略客户合作进展', expected: TOPIC_SUBCATEGORIES.NEW_CUSTOMER },
  // ---- ORDER: delivery (3) ----
  { q: '在手订单交付进度', expected: TOPIC_SUBCATEGORIES.DELIVERY },
  { q: '订单发货排产', expected: TOPIC_SUBCATEGORIES.DELIVERY },
  { q: '装机交付时点', expected: TOPIC_SUBCATEGORIES.DELIVERY },
  // ---- POLICY: subsidy (4) ----
  { q: '行业补贴是否会退坡', expected: TOPIC_SUBCATEGORIES.SUBSIDY },
  { q: '政府补助力度', expected: TOPIC_SUBCATEGORIES.SUBSIDY },
  { q: '退税政策的影响', expected: TOPIC_SUBCATEGORIES.SUBSIDY },
  { q: '产业补贴目录变化', expected: TOPIC_SUBCATEGORIES.SUBSIDY },
  // ---- POLICY: tariff (3) ----
  { q: '关税加征对公司的影响', expected: TOPIC_SUBCATEGORIES.TARIFF },
  { q: '反倾销调查进展', expected: TOPIC_SUBCATEGORIES.TARIFF },
  { q: '出口管制是否影响业务', expected: TOPIC_SUBCATEGORIES.TARIFF },
  // ---- POLICY: regulation (3) ----
  { q: '行业准入资质审批进度', expected: TOPIC_SUBCATEGORIES.REGULATION },
  { q: '监管牌照获批情况', expected: TOPIC_SUBCATEGORIES.REGULATION },
  { q: '环保整改是否到位', expected: TOPIC_SUBCATEGORIES.REGULATION },
  // ---- POLICY: macro (3) ----
  { q: '降息对公司估值影响', expected: TOPIC_SUBCATEGORIES.MACRO },
  { q: '货币政策方向', expected: TOPIC_SUBCATEGORIES.MACRO },
  { q: '逆周期调控影响', expected: TOPIC_SUBCATEGORIES.MACRO },
  // ---- PERSONNEL: executive_change (4) ----
  { q: '高管离任的接任者', expected: TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE },
  { q: '董事长辞职原因', expected: TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE },
  { q: '总经理变动详情', expected: TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE },
  { q: 'CEO离任后管理过渡', expected: TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE },
  // ---- PERSONNEL: incentive (3) ----
  { q: '股权激励计划解锁条件', expected: TOPIC_SUBCATEGORIES.INCENTIVE },
  { q: '员工持股计划是否落地', expected: TOPIC_SUBCATEGORIES.INCENTIVE },
  { q: '限制性股票授予价', expected: TOPIC_SUBCATEGORIES.INCENTIVE },
  // ---- PERSONNEL: controversy (2) ----
  { q: '股权之争的最新进展', expected: TOPIC_SUBCATEGORIES.CONTROVERSY },
  { q: '高管被举报内幕交易', expected: TOPIC_SUBCATEGORIES.CONTROVERSY },
  // ---- OTHER: other_general (5) ----
  { q: '你好', expected: TOPIC_SUBCATEGORIES.OTHER_GENERAL },
  { q: '近期股价走势', expected: TOPIC_SUBCATEGORIES.OTHER_GENERAL },
  { q: '什么时候开股东会', expected: TOPIC_SUBCATEGORIES.OTHER_GENERAL },
  { q: '请问公司的发展前景如何', expected: TOPIC_SUBCATEGORIES.OTHER_GENERAL },
  { q: '请回答一下', expected: TOPIC_SUBCATEGORIES.OTHER_GENERAL },
  // ---- 父类正确但 subcategory 兜底 *_other (6) ----
  { q: '请问公司毛利率水平', expected: TOPIC_SUBCATEGORIES.FINANCE_OTHER },
  { q: '产品的工艺水平如何', expected: TOPIC_SUBCATEGORIES.PRODUCT_OTHER },
  { q: '签约的客户行业分布', expected: TOPIC_SUBCATEGORIES.ORDER_OTHER },
  { q: '行业法规修订方向', expected: TOPIC_SUBCATEGORIES.REGULATION }, // 含"法规" → regulation 命中, 非 _other
  { q: '团队建设进展', expected: TOPIC_SUBCATEGORIES.PERSONNEL_OTHER },
  { q: '应对市场风险的策略', expected: TOPIC_SUBCATEGORIES.OTHER_GENERAL },
  // ---- 补充 (覆盖 100 条 AC + 复测易错) ----
  { q: '业绩预告披露的具体时间', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '预增公告何时正式发布', expected: TOPIC_SUBCATEGORIES.EARNINGS_FORECAST },
  { q: '现金分红是否会持续提高', expected: TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK },
  { q: '股息率水平如何', expected: TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK },
  { q: '可转换债募投资金用途', expected: TOPIC_SUBCATEGORIES.CAPITAL_ACTION },
  { q: '股权融资进展', expected: TOPIC_SUBCATEGORIES.CAPITAL_ACTION },
  { q: '经营现金流改善幅度', expected: TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN },
  { q: '应收账款回款情况', expected: TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN },
  { q: '新型号产品的市场反响', expected: TOPIC_SUBCATEGORIES.NEW_PRODUCT },
  { q: '产能GWh扩张时间表', expected: TOPIC_SUBCATEGORIES.CAPACITY },
  { q: '在建产线投产时间表', expected: TOPIC_SUBCATEGORIES.CAPACITY },
  { q: '上市许可申请进展', expected: TOPIC_SUBCATEGORIES.RD_PROGRESS },
  { q: '中试线放大进展', expected: TOPIC_SUBCATEGORIES.RD_PROGRESS },
  { q: '一带一路项目进展', expected: TOPIC_SUBCATEGORIES.EXPORT },
  { q: '中东订单情况', expected: TOPIC_SUBCATEGORIES.EXPORT },
  { q: '供应商资质入围情况', expected: TOPIC_SUBCATEGORIES.NEW_CUSTOMER },
  { q: '在手订单规模', expected: TOPIC_SUBCATEGORIES.DELIVERY },
  { q: '订单确认状态', expected: TOPIC_SUBCATEGORIES.DELIVERY },
  { q: '专项资金到位时间', expected: TOPIC_SUBCATEGORIES.SUBSIDY },
  { q: '税收优惠政策落地情况', expected: TOPIC_SUBCATEGORIES.SUBSIDY },
  { q: '加征关税对毛利影响', expected: TOPIC_SUBCATEGORIES.TARIFF },
  { q: '行业准入审批进度', expected: TOPIC_SUBCATEGORIES.REGULATION },
  { q: '降准对融资成本影响', expected: TOPIC_SUBCATEGORIES.MACRO },
  { q: 'MLF操作对行业利率影响', expected: TOPIC_SUBCATEGORIES.MACRO },
  { q: 'CFO离任的影响', expected: TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE },
  { q: '激励计划行权条件', expected: TOPIC_SUBCATEGORIES.INCENTIVE },
  { q: '高管被立案调查最新进展', expected: TOPIC_SUBCATEGORIES.CONTROVERSY },
  { q: '今天天气怎么样', expected: TOPIC_SUBCATEGORIES.OTHER_GENERAL },
];

function testSubtopicConstantsFrozen(): void {
  assert('TOPIC_SUBCATEGORIES frozen', Object.isFrozen(TOPIC_SUBCATEGORIES));
  assert('SUBTOPIC_VALUES frozen', Object.isFrozen(SUBTOPIC_VALUES));
  assert('TOPIC_SUBCATEGORY_OF frozen', Object.isFrozen(TOPIC_SUBCATEGORY_OF));
  assert('TOPIC_SUBCATEGORY_KEYWORDS frozen', Object.isFrozen(TOPIC_SUBCATEGORY_KEYWORDS));
  assert('TOPIC_SUBCATEGORY_PRIORITY frozen', Object.isFrozen(TOPIC_SUBCATEGORY_PRIORITY));
  assert('SUBTOPICS_BY_TOPIC frozen', Object.isFrozen(SUBTOPICS_BY_TOPIC));
  assert('TOPIC_OTHER_SUBCATEGORY frozen', Object.isFrozen(TOPIC_OTHER_SUBCATEGORY));

  // AC: 24+ subcategory
  assert(
    `SUBTOPIC_VALUES >= 24 (含 *_other), got ${SUBTOPIC_VALUES.length}`,
    SUBTOPIC_VALUES.length >= 24
  );
  // Actionable subtopic 数 (排除 *_other / other_general) 也应 >= 18 (doc 83 §B.1 列了 24 个, 这里聚合到 21 keys)
  const actionable = SUBTOPIC_VALUES.filter(s => {
    const kws = TOPIC_SUBCATEGORY_KEYWORDS[s];
    return kws && kws.length > 0;
  });
  assert(
    `actionable subtopic >= 18 (有字典), got ${actionable.length}`,
    actionable.length >= 18
  );

  // 父类映射完整
  for (const sub of SUBTOPIC_VALUES) {
    const parent = TOPIC_SUBCATEGORY_OF[sub];
    assert(`${sub} 有 parent topic`, !!parent);
    // SUBTOPICS_BY_TOPIC[parent] 必须包含此 sub
    const siblings = SUBTOPICS_BY_TOPIC[parent];
    assert(
      `${sub} 在 SUBTOPICS_BY_TOPIC[${parent}] 中`,
      !!siblings && siblings.includes(sub)
    );
  }

  // 每个父类都有 *_other 兜底
  for (const topic of TOPIC_VALUES) {
    const fallback = TOPIC_OTHER_SUBCATEGORY[topic];
    assert(`${topic} 有 fallback subcategory`, !!fallback);
    assertEqual(
      `${topic} fallback 父类自洽`,
      TOPIC_SUBCATEGORY_OF[fallback],
      topic
    );
  }
}

function testDetectSubtopicByKeyword(): void {
  assert(
    'detect earnings_forecast hit',
    detectSubtopicByKeyword('公司业绩预告', TOPIC_SUBCATEGORIES.EARNINGS_FORECAST)
  );
  assert(
    'detect earnings_forecast miss',
    !detectSubtopicByKeyword('公司财报', TOPIC_SUBCATEGORIES.EARNINGS_FORECAST)
  );
  assert('detect null', !detectSubtopicByKeyword(null, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST));
  assert(
    'detect *_other 字典空 → false',
    !detectSubtopicByKeyword('anything', TOPIC_SUBCATEGORIES.FINANCE_OTHER)
  );
  assert(
    'detect other_general 字典空 → false',
    !detectSubtopicByKeyword('anything', TOPIC_SUBCATEGORIES.OTHER_GENERAL)
  );
}

function testClassifySubtopicEdgeCases(): void {
  assertEqual(
    'null → other_general',
    classifySubtopic(null),
    TOPIC_SUBCATEGORIES.OTHER_GENERAL
  );
  assertEqual(
    'undefined → other_general',
    classifySubtopic(undefined),
    TOPIC_SUBCATEGORIES.OTHER_GENERAL
  );
  assertEqual('空串 → other_general', classifySubtopic(''), TOPIC_SUBCATEGORIES.OTHER_GENERAL);
  assertEqual(
    '空白 → other_general',
    classifySubtopic('   '),
    TOPIC_SUBCATEGORIES.OTHER_GENERAL
  );
  // OTHER 父类 → other_general (无 sub 字典命中)
  assertEqual(
    '你好 → other_general',
    classifySubtopic('你好'),
    TOPIC_SUBCATEGORIES.OTHER_GENERAL
  );
}

function testClassifySubtopicParentChild(): void {
  // classifySubtopic 输出 sub, 反推 parent (TOPIC_SUBCATEGORY_OF) 必须是合法 TopicCategory.
  // 注意: subtopic 字典比 parent 字典更细 — 仅靠 subtopic 命中即可定 sub, 此时
  // classifyTopic(q) 可能返回 OTHER (e.g. "一季报" 不在 parent 字典中). 故只断言
  // sub→parent 一致性, 不强求与 classifyTopic 同结果. 但若 classifyTopic 返回非 OTHER,
  // 则与 sub-derived parent 必须一致 (不能 contradict).
  const samples = [
    '业绩预告',
    '一季报',
    '分红',
    '定增',
    '现金流紧张',
    '新品发布',
    '产能扩张',
    '研发临床',
    '召回事件',
    '中标公告',
    '海外业务',
    '战略客户',
    '订单交付',
    '政府补贴',
    '关税加征',
    '监管准入',
    '货币政策降息',
    '高管离任',
    '股权激励',
    '股权之争',
    '你好',
    '请教',
  ];
  for (const q of samples) {
    const sub = classifySubtopic(q);
    const subParent = deriveTopicFromSubtopic(sub);
    const topicCalc = classifyTopic(q);
    assert(
      `${q} sub→parent 合法 (${sub} → ${subParent})`,
      TOPIC_VALUES.includes(subParent)
    );
    if (topicCalc !== TOPIC_CATEGORIES.OTHER) {
      assertEqual(
        `${q} parent 不冲突 (classifyTopic=${topicCalc} vs sub-derived=${subParent})`,
        subParent,
        topicCalc
      );
    }
  }
}

function testClassifySubtopicTieBreakPriority(): void {
  // 平手时 (命中数相同) TOPIC_SUBCATEGORY_PRIORITY 升序决定胜者.
  // "业绩预告" + "分红" → earnings_forecast (priority 10) vs dividend_buyback (12)
  //   各命中 1 次 → 选 earnings_forecast.
  assertEqual(
    '平手: 业绩预告优先于分红',
    classifySubtopic('业绩预告与分红规划'),
    TOPIC_SUBCATEGORIES.EARNINGS_FORECAST
  );
  // "定增" + "回购" → capital_action (11) vs dividend_buyback (12) → capital_action
  assertEqual(
    '平手: 定增优先于回购',
    classifySubtopic('定增与回购计划'),
    TOPIC_SUBCATEGORIES.CAPITAL_ACTION
  );
  // "海外" + "新客户" → export (31) vs new_customer (32) → export
  assertEqual(
    '平手: 海外优先于新客户',
    classifySubtopic('海外的新客户进展'),
    TOPIC_SUBCATEGORIES.EXPORT
  );
  // 反推: deriveTopicFromSubtopic 与 TOPIC_SUBCATEGORY_OF 一致
  assertEqual(
    'derive earnings_forecast → 财务',
    deriveTopicFromSubtopic(TOPIC_SUBCATEGORIES.EARNINGS_FORECAST),
    TOPIC_CATEGORIES.FINANCE
  );
  assertEqual(
    'derive other_general → 其它',
    deriveTopicFromSubtopic(TOPIC_SUBCATEGORIES.OTHER_GENERAL),
    TOPIC_CATEGORIES.OTHER
  );
}

function testClassifySubtopicAccuracyCorpus(): void {
  // AC: 100 条标注语料 准确率 ≥ 80%
  let correct = 0;
  const wrongs: string[] = [];
  for (const item of SUBTOPIC_LABELED_CORPUS) {
    const got = classifySubtopic(item.q);
    if (got === item.expected) {
      correct += 1;
    } else {
      wrongs.push(`"${item.q}" expected=${item.expected} got=${got}`);
    }
  }
  const total = SUBTOPIC_LABELED_CORPUS.length;
  const acc = correct / total;
  console.log(
    `\nQA-001 subtopic accuracy: ${correct}/${total} = ${(acc * 100).toFixed(1)}%`
  );
  if (wrongs.length > 0 && wrongs.length <= 20) {
    console.log('Misclassifications:');
    for (const w of wrongs) console.log('  - ' + w);
  }
  assert(`subtopic accuracy ≥ 80% (got ${(acc * 100).toFixed(1)}%)`, acc >= 0.8);
  // 语料数量 >= 100 (AC: "100 条标注问答")
  assert(`语料数 >= 100, got ${total}`, total >= 100);
  // 至少覆盖 18 个 actionable subcategory
  const covered = new Set<SubtopicCategory>();
  for (const item of SUBTOPIC_LABELED_CORPUS) covered.add(item.expected);
  assert(
    `标注语料覆盖 subcategory ≥ 18, got ${covered.size}`,
    covered.size >= 18
  );
}

function testAggregateWeeklyHappyPath(): void {
  // 3 条问题 同周 同 topic
  const rows: StockQARow[] = [
    makeQARow({
      question: '上半年营收预期',
      question_time: '2026-06-08 10:00:00',
      question_id: 'q1',
    }),
    makeQARow({
      question: '净利同比增长多少',
      question_time: '2026-06-09 11:00:00',
      question_id: 'q2',
    }),
    makeQARow({
      question: '现金流情况',
      question_time: '2026-06-10 12:00:00',
      question_id: 'q3',
    }),
  ];
  const out = aggregateWeekly(rows, {
    stock_code: '600519',
    stock_name: '贵州茅台',
  });
  // 3 条同周 → 1 行 (财务 topic)
  assertEqual('aggregate 1 行', out.length, 1);
  assertEqual('aggregate stock_code', out[0].stock_code, '600519');
  assertEqual('aggregate stock_name', out[0].stock_name, '贵州茅台');
  assertEqual('aggregate week_start', out[0].week_start, '2026-06-08');
  assertEqual('aggregate topic', out[0].topic, '财务');
  assertEqual('aggregate mention_count', out[0].mention_count, 3);
  // sentiment 计算:
  //   q1 "上半年营收预期" → "预期" 命中 weakPos → +0.5
  //   q2 "净利同比增长多少" → "增长" 命中 weakPos → +0.5
  //   q3 "现金流情况" → 无 sentiment 关键词 → 0
  //   平均 (0.5 + 0.5 + 0) / 3 = 0.333
  assert(
    'aggregate sentiment_score ≈ 0.333',
    Math.abs(out[0].sentiment_score - 0.333) < 0.01,
    `got ${out[0].sentiment_score}`
  );
  // raw_payload check
  assertEqual('aggregate total_questions', out[0].raw_payload.total_questions, 3);
  assertEqual(
    'aggregate sample_question_ids length',
    out[0].raw_payload.sample_question_ids!.length,
    3
  );
  // engine 默认 heuristic
  assertEqual('aggregate engine heuristic', out[0].nlp_engine, NLP_ENGINES.HEURISTIC);
}

function testAggregateWeeklyMultiWeekMultiTopic(): void {
  const rows: StockQARow[] = [
    // 周 1: 财务 × 2
    makeQARow({ question: '营收', question_time: '2026-06-01 10:00:00', question_id: 'a' }),
    makeQARow({ question: '净利', question_time: '2026-06-02 10:00:00', question_id: 'b' }),
    // 周 1: 产品 × 1
    makeQARow({ question: '新品规划', question_time: '2026-06-03 10:00:00', question_id: 'c' }),
    // 周 2: 订单 × 1
    makeQARow({ question: '海外订单', question_time: '2026-06-08 10:00:00', question_id: 'd' }),
  ];
  const out = aggregateWeekly(rows, { stock_code: '600519' });
  // 周 1 财务 (2) + 周 1 产品 (1) + 周 2 订单 (1) = 3 行
  assertEqual('multi: 3 行', out.length, 3);
  // 按 week_start desc 排序 → 周 2 在最前
  assertEqual('multi: 第一行是 06-08', out[0].week_start, '2026-06-08');
  assertEqual('multi: 第一行 topic 订单', out[0].topic, '订单');
}

function testAggregateWeeklyEmpty(): void {
  const out = aggregateWeekly([], { stock_code: '600519' });
  assertEqual('empty input → []', out.length, 0);
}

function testAggregateWeeklySinceFilter(): void {
  const rows: StockQARow[] = [
    makeQARow({ question: '营收', question_time: '2026-05-15 10:00:00', question_id: 'a' }),
    makeQARow({ question: '净利', question_time: '2026-06-01 10:00:00', question_id: 'b' }),
    makeQARow({ question: '现金流', question_time: '2026-06-08 10:00:00', question_id: 'c' }),
  ];
  // since=2026-06-01 → 保留 06-01 与 06-08
  const out = aggregateWeekly(rows, {
    stock_code: '600519',
    since_date: '2026-06-01',
  });
  let total = 0;
  for (const r of out) total += r.mention_count;
  assertEqual('since filter 保留 2 条', total, 2);
}

function testAggregateWeeklyInvalidQuestionTime(): void {
  const rows: StockQARow[] = [
    makeQARow({ question: '营收', question_time: '2026-06-01 10:00:00', question_id: 'a' }),
    // invalid time → skipped
    {
      ...makeQARow({ question: '净利', question_time: 'bogus', question_id: 'b' }),
    },
    // missing question_time → skipped
    {
      ...makeQARow({ question: '现金流', question_time: '2026-06-08 10:00:00', question_id: 'c' }),
      question_time: '',
    },
    // missing question → skipped
    {
      ...makeQARow({ question: '', question_time: '2026-06-08 10:00:00', question_id: 'd' }),
    },
  ];
  const out = aggregateWeekly(rows, { stock_code: '600519' });
  // 仅 1 条有效 → 1 行
  let total = 0;
  for (const r of out) total += r.mention_count;
  assertEqual('invalid filter 保留 1 条', total, 1);
}

function testAggregateWeeklyUseAI(): void {
  const rows: StockQARow[] = [
    makeQARow({ question: '提问 1', question_time: '2026-06-08 10:00:00', question_id: 'q1' }),
    makeQARow({ question: '提问 2', question_time: '2026-06-09 10:00:00', question_id: 'q2' }),
    makeQARow({ question: '提问 3', question_time: '2026-06-10 10:00:00', question_id: 'q3' }),
  ];
  const aiMap = new Map<string, { topic: TopicCategory; sentiment_score: number }>();
  aiMap.set('q1', { topic: TOPIC_CATEGORIES.ORDER, sentiment_score: 0.8 });
  aiMap.set('q2', { topic: TOPIC_CATEGORIES.ORDER, sentiment_score: -0.3 });
  // q3 NOT in aiMap → fallback heuristic ("提问 3" — 兜底 OTHER, score 0)

  const out = aggregateWeekly(rows, {
    stock_code: '600519',
    nlp_engine: NLP_ENGINES.TRADING_AGENTS,
    useAI: true,
    aiClassifications: aiMap,
  });
  // 期望: ORDER (2 条, 平均 = 0.25) + OTHER (1 条, 0) = 2 行
  assertEqual('AI: 2 行', out.length, 2);
  assertEqual('AI engine', out[0].nlp_engine, NLP_ENGINES.TRADING_AGENTS);

  const orderRow = out.find(r => r.topic === '订单');
  assert('AI: 有订单行', !!orderRow);
  if (orderRow) {
    assertEqual('AI: 订单 mention_count', orderRow.mention_count, 2);
    // 平均 (0.8 + (-0.3)) / 2 = 0.25
    assertEqual('AI: 订单 score 0.25', orderRow.sentiment_score, 0.25);
  }
  const otherRow = out.find(r => r.topic === '其它');
  assert('AI: 有其它行 (fallback)', !!otherRow);
  if (otherRow) {
    assertEqual('AI: 其它 mention_count', otherRow.mention_count, 1);
  }
}

function testAggregateWeeklyBreakdown(): void {
  // 5 个不同情绪档位但保证全部落 "财务" topic — 在 question 里加 "营收" 关键词
  // 让 classifyTopic 都命中财务避免被分散到其他 topic.
  const rows: StockQARow[] = [
    // strong_neg: 立案
    makeQARow({
      question: '营收 立案调查',
      question_time: '2026-06-08 10:00:00',
      question_id: 'a',
    }),
    // strong_pos: 业绩超预期
    makeQARow({
      question: '业绩超预期营收',
      question_time: '2026-06-08 11:00:00',
      question_id: 'b',
    }),
    // weak_neg: 减持
    makeQARow({ question: '减持营收', question_time: '2026-06-09 10:00:00', question_id: 'c' }),
    // weak_pos: 增长
    makeQARow({ question: '营收增长', question_time: '2026-06-09 11:00:00', question_id: 'd' }),
    // neutral: 普通财务问题 — 注意 "预期" "同比" 都不在 sentiment 字典里
    makeQARow({ question: '营收 同比', question_time: '2026-06-10 10:00:00', question_id: 'e' }),
  ];
  const out = aggregateWeekly(rows, { stock_code: '600519' });
  // 全是财务 topic + 同周 → 1 行
  assertEqual('breakdown: 1 行', out.length, 1);
  const r = out[0];
  assertEqual('breakdown total_questions', r.raw_payload.total_questions, 5);
  assertEqual('breakdown strong_neg=1', r.raw_payload.sentiment_breakdown.strong_neg, 1);
  assertEqual('breakdown strong_pos=1', r.raw_payload.sentiment_breakdown.strong_pos, 1);
  assertEqual('breakdown weak_neg=1', r.raw_payload.sentiment_breakdown.weak_neg, 1);
  assertEqual('breakdown weak_pos=1', r.raw_payload.sentiment_breakdown.weak_pos, 1);
  assertEqual('breakdown neutral=1', r.raw_payload.sentiment_breakdown.neutral, 1);
}

function testAggregateWeeklySampleIdsCap(): void {
  // 6 条同周同 topic → sample_ids 上限 5
  const rows: StockQARow[] = [];
  for (let i = 0; i < 6; i++) {
    rows.push(
      makeQARow({
        question: '营收',
        question_time: '2026-06-08 10:00:00',
        question_id: `q${i}`,
      })
    );
  }
  const out = aggregateWeekly(rows, { stock_code: '600519' });
  assertEqual('sample_ids cap 5', out[0].raw_payload.sample_question_ids!.length, 5);
}

function testAggregateWeeklySorting(): void {
  const rows: StockQARow[] = [
    // 周 1 财务
    makeQARow({ question: '营收', question_time: '2026-06-01 10:00:00', question_id: 'a' }),
    // 周 2 产品
    makeQARow({ question: '新品', question_time: '2026-06-08 10:00:00', question_id: 'b' }),
    // 周 2 财务
    makeQARow({ question: '净利', question_time: '2026-06-09 10:00:00', question_id: 'c' }),
  ];
  const out = aggregateWeekly(rows, { stock_code: '600519' });
  // 期望排序: week_start desc, topic priority asc
  // 周 2 财务 → 周 2 产品 → 周 1 财务
  assertEqual('sort: out length', out.length, 3);
  assertEqual('sort[0] week 周 2', out[0].week_start, '2026-06-08');
  assertEqual('sort[0] topic 财务', out[0].topic, '财务');
  assertEqual('sort[1] week 周 2', out[1].week_start, '2026-06-08');
  assertEqual('sort[1] topic 产品', out[1].topic, '产品');
  assertEqual('sort[2] week 周 1', out[2].week_start, '2026-06-01');
}

function testParseRemoteClassify(): void {
  // success
  const r1 = parseRemoteClassify({
    status: 'COMPLETED',
    data: { topic: 'finance', sentiment_score: 0.7 },
  });
  assert('parse: success 非 null', r1 !== null);
  if (r1) {
    assertEqual('parse: topic 财务', r1.topic, '财务');
    assertEqual('parse: score 0.7', r1.sentiment_score, 0.7);
  }

  // 中文 + 范围内 score
  const r2 = parseRemoteClassify({
    status: 'COMPLETED',
    data: { topic: '订单', sentiment_score: -0.5 },
  });
  assert('parse: 中文 topic', r2 !== null && r2.topic === '订单');

  // FAILED → null
  const r3 = parseRemoteClassify({ status: 'FAILED', data: { error: 'remote 500' } });
  assertEqual('parse: FAILED → null', r3, null);

  // 无 data → null
  const r4 = parseRemoteClassify({ status: 'COMPLETED' });
  assertEqual('parse: no data → null', r4, null);

  // score = NaN → 0
  const r5 = parseRemoteClassify({
    status: 'COMPLETED',
    data: { topic: 'product', sentiment_score: NaN as unknown as number },
  });
  assert('parse: NaN → score 0', r5 !== null && r5.sentiment_score === 0);

  // score = Infinity → 0
  const r6 = parseRemoteClassify({
    status: 'COMPLETED',
    data: { topic: 'product', sentiment_score: Infinity as unknown as number },
  });
  assert('parse: Infinity → score 0', r6 !== null && r6.sentiment_score === 0);

  // score 超界 → clamp
  const r7 = parseRemoteClassify({
    status: 'COMPLETED',
    data: { topic: 'product', sentiment_score: 5.0 },
  });
  assert('parse: 5.0 → clamp 1.0', r7 !== null && r7.sentiment_score === 1.0);

  const r8 = parseRemoteClassify({
    status: 'COMPLETED',
    data: { topic: 'product', sentiment_score: -10.0 },
  });
  assert('parse: -10.0 → clamp -1.0', r8 !== null && r8.sentiment_score === -1.0);

  // missing topic → 其它
  const r9 = parseRemoteClassify({
    status: 'COMPLETED',
    data: { sentiment_score: 0.5 },
  });
  assert('parse: missing topic → 其它', r9 !== null && r9.topic === '其它');
}

// ---------------------------------------------------------------------------
// service.syncStock() tests
// ---------------------------------------------------------------------------

async function testSyncStockHappyPath(): Promise<void> {
  resetStore();
  const rows: StockQARow[] = [
    makeQARow({
      question: '上半年营收预期',
      question_time: '2026-06-08 10:00:00',
      question_id: 'q1',
    }),
    makeQARow({
      question: '海外订单进展',
      question_time: '2026-06-09 11:00:00',
      question_id: 'q2',
    }),
    makeQARow({
      question: '高管离职原因',
      question_time: '2026-06-10 12:00:00',
      question_id: 'q3',
    }),
  ];
  const state = makeFakeDSState({ fetchByStock: { '600519': rows } });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519');
  assertEqual('syncStock fetched 3', result.fetched, 3);
  // 同周 3 条 — 财务 1 / 订单 1 / 人事 1 → 3 行
  assertEqual('syncStock rows_upserted 3', result.rows_upserted, 3);
  assertEqual('syncStock weeks 1', result.weeks_aggregated, 1);
  assert('syncStock no error', !result.error);
  // by_topic 6 类各自计数
  assertEqual('syncStock by_topic 财务', result.by_topic['财务'], 1);
  assertEqual('syncStock by_topic 订单', result.by_topic['订单'], 1);
  assertEqual('syncStock by_topic 人事', result.by_topic['人事'], 1);
  // save 调用 1 次
  assertEqual('syncStock save called once', state.saveCalls.length, 1);
  // 未走 AI
  assertEqual('syncStock no remote', state.remoteCalls.length, 0);
}

async function testSyncStockInvalidCode(): Promise<void> {
  const state = makeFakeDSState();
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  // 7 位 (太长)
  let result = await service.syncStock('1234567');
  assert('syncStock invalid 7 位 error', !!result.error && result.error.includes('Invalid'));
  assertEqual('syncStock invalid fetched 0', result.fetched, 0);

  // 含字母
  result = await service.syncStock('60051A');
  assert('syncStock invalid 字母 error', !!result.error);

  // 空串
  result = await service.syncStock('');
  assert('syncStock 空串 error', !!result.error);

  // 带前缀 sh. (service 不 strip)
  result = await service.syncStock('sh.600519');
  assert('syncStock 前缀 error (CLI 已 strip)', !!result.error);
}

async function testSyncStockFetchEmpty(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({ fetchByStock: {} });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519');
  assertEqual('empty fetched 0', result.fetched, 0);
  assertEqual('empty upserted 0', result.rows_upserted, 0);
  assert('empty no error', !result.error);
  assertEqual('empty no save', state.saveCalls.length, 0);
}

async function testSyncStockDryRun(): Promise<void> {
  resetStore();
  const rows = [
    makeQARow({ question: '营收', question_time: '2026-06-08 10:00:00', question_id: 'q1' }),
  ];
  const state = makeFakeDSState({ fetchByStock: { '600519': rows } });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519', { dry_run: true });
  assertEqual('dry_run fetched 1', result.fetched, 1);
  assertEqual('dry_run upserted 0', result.rows_upserted, 0);
  assertEqual('dry_run no save', state.saveCalls.length, 0);
}

async function testSyncStockWithAI(): Promise<void> {
  resetStore();
  const rows = [
    makeQARow({ question: '问题 1', question_time: '2026-06-08 10:00:00', question_id: 'q1' }),
    makeQARow({ question: '问题 2', question_time: '2026-06-09 10:00:00', question_id: 'q2' }),
  ];
  // 默认 remotePayload 返回 财务 + 0.8
  const state = makeFakeDSState({ fetchByStock: { '600519': rows } });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519', { extract_with_ai: true });
  assertEqual('AI fetched 2', result.fetched, 2);
  assertEqual('AI remote 2 calls', state.remoteCalls.length, 2);
  // AI 给所有 q 都贴上 财务
  assertEqual('AI by_topic 财务=1', result.by_topic['财务'], 1);
  // 校验 saved rows engine 标签
  const saved = state.saveCalls[0];
  assertEqual('AI saved engine trading_agents', saved[0].nlp_engine, NLP_ENGINES.TRADING_AGENTS);
}

async function testSyncStockAIRemoteFailedPayload(): Promise<void> {
  resetStore();
  const rows = [
    makeQARow({
      question: '营收预期',
      question_time: '2026-06-08 10:00:00',
      question_id: 'q1',
    }),
  ];
  // 远端返回 FAILED → parseRemoteClassify 返回 null → aggregateWeekly fallback 启发式
  const state = makeFakeDSState({
    fetchByStock: { '600519': rows },
    remotePayload: { status: 'FAILED', data: { error: 'remote 500' } },
  });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519', { extract_with_ai: true });
  assertEqual('AI failed fetched 1', result.fetched, 1);
  // fallback 启发式: 营收 → 财务
  assertEqual('AI failed by_topic 财务', result.by_topic['财务'], 1);
}

async function testSyncStockAIRemoteThrows(): Promise<void> {
  resetStore();
  const rows = [
    makeQARow({
      question: '营收',
      question_time: '2026-06-08 10:00:00',
      question_id: 'q1',
    }),
  ];
  // 远端 throw → service 内层 catch → fallback 启发式
  const state = makeFakeDSState({
    fetchByStock: { '600519': rows },
    remoteShouldThrow: true,
  });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519', { extract_with_ai: true });
  assertEqual('AI throws fetched 1', result.fetched, 1);
  // 即便 throw 也走 fallback
  assertEqual('AI throws by_topic 财务', result.by_topic['财务'], 1);
  assertEqual('AI throws upserted 1', result.rows_upserted, 1);
}

async function testSyncStockSaveFailOpen(): Promise<void> {
  resetStore();
  const rows = [
    makeQARow({ question: '营收', question_time: '2026-06-08 10:00:00', question_id: 'q1' }),
  ];
  const state = makeFakeDSState({
    fetchByStock: { '600519': rows },
    saveShouldThrow: true,
  });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519');
  assertEqual('save fail fetched 1', result.fetched, 1);
  assertEqual('save fail upserted 0', result.rows_upserted, 0);
  assert(
    'save fail error save_failed',
    !!result.error && result.error.includes('save_failed')
  );
}

async function testSyncStockFetchThrows(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchShouldThrowFor: new Set(['600519']),
  });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519');
  assertEqual('fetch throws fetched 0', result.fetched, 0);
  assertEqual('fetch throws upserted 0', result.rows_upserted, 0);
  assert(
    'fetch throws error outage',
    !!result.error && result.error.includes('outage')
  );
}

async function testSyncStockSinceFilter(): Promise<void> {
  resetStore();
  const rows = [
    makeQARow({
      question: '营收 老',
      question_time: '2026-05-01 10:00:00',
      question_id: 'old',
    }),
    makeQARow({
      question: '营收 新',
      question_time: '2026-06-08 10:00:00',
      question_id: 'new',
    }),
  ];
  const state = makeFakeDSState({ fetchByStock: { '600519': rows } });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStock('600519', { since_date: '2026-06-01' });
  assertEqual('since: fetched 仍 2', result.fetched, 2);
  // 仅 1 条 (新) 进聚合 → 1 行 / 1 周
  assertEqual('since: rows_upserted 1', result.rows_upserted, 1);
  assertEqual('since: weeks 1', result.weeks_aggregated, 1);
}

// ---------------------------------------------------------------------------
// service.syncStocks() tests
// ---------------------------------------------------------------------------

async function testSyncStocksAllSucceed(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchByStock: {
      '600519': [
        makeQARow({
          question: '营收',
          question_time: '2026-06-08 10:00:00',
          question_id: 'a',
        }),
      ],
      '000001': [
        makeQARow({
          stock_code: '000001',
          stock_name: '平安银行',
          question: '净利',
          question_time: '2026-06-08 11:00:00',
          question_id: 'b',
        }),
      ],
    },
  });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStocks(['600519', '000001'], {
    interval_ms: 0,
  });
  assertEqual('syncStocks total 2', result.total_stocks, 2);
  assertEqual('syncStocks succeeded 2', result.succeeded, 2);
  assertEqual('syncStocks failed 0', result.failed, 0);
  assertEqual('syncStocks details 2', result.details.length, 2);
}

async function testSyncStocksContinueOnError(): Promise<void> {
  resetStore();
  // 600519 OK, 000001 throws
  const state = makeFakeDSState({
    fetchByStock: {
      '600519': [
        makeQARow({
          question: '营收',
          question_time: '2026-06-08 10:00:00',
          question_id: 'a',
        }),
      ],
    },
    fetchShouldThrowFor: new Set(['000001']),
  });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStocks(['600519', '000001', '300750'], {
    interval_ms: 0,
    continue_on_error: true,
  });
  assertEqual('continue total 3', result.total_stocks, 3);
  assertEqual('continue succeeded 2', result.succeeded, 2);
  assertEqual('continue failed 1', result.failed, 1);
  assertEqual('continue details 3', result.details.length, 3);
  const failedDetail = result.details.find(d => d.stock_code === '000001');
  assert('failed 000001 has error', !!failedDetail && !!failedDetail.error);
}

async function testSyncStocksStopOnFirstError(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchByStock: {
      '300750': [
        makeQARow({
          question: '营收',
          question_time: '2026-06-08 10:00:00',
          question_id: 'a',
        }),
      ],
    },
    fetchShouldThrowFor: new Set(['000001']),
  });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStocks(['000001', '300750'], {
    interval_ms: 0,
    continue_on_error: false,
  });
  // 000001 失败 → break, 300750 未遍历
  assertEqual('stop: details 1', result.details.length, 1);
  assertEqual('stop: failed 1', result.failed, 1);
}

async function testSyncStocksInvalidCodeContinue(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchByStock: {
      '600519': [
        makeQARow({
          question: '营收',
          question_time: '2026-06-08 10:00:00',
          question_id: 'a',
        }),
      ],
    },
  });
  const ds = makeFakeDS(state);
  const service = new EastMoneyQATopicService(ds);

  const result = await service.syncStocks(['BADCODE', '600519'], {
    interval_ms: 0,
    continue_on_error: true,
  });
  assertEqual('invalid+ok: failed 1', result.failed, 1);
  assertEqual('invalid+ok: succeeded 1', result.succeeded, 1);
}

// ---------------------------------------------------------------------------
// service.listByStock() tests
// ---------------------------------------------------------------------------

async function testListByStockDefault(): Promise<void> {
  resetStore();
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);
  store.push({
    stock_code: '600519',
    week_start: isoToday,
    topic: '财务',
    mention_count: 3,
    sentiment_score: 0.5,
    nlp_engine: 'heuristic_fallback',
    raw_payload: { total_questions: 3 },
  });
  store.push({
    stock_code: '000001',
    week_start: isoToday,
    topic: '产品',
    mention_count: 2,
    sentiment_score: 0,
    nlp_engine: 'heuristic_fallback',
    raw_payload: {},
  });
  const service = new EastMoneyQATopicService(makeFakeDS(makeFakeDSState()));

  const rows = await service.listByStock('600519');
  assertEqual('listByStock 1 row', rows.length, 1);
  assertEqual('listByStock code', rows[0].stock_code, '600519');
}

async function testListByStockEmpty(): Promise<void> {
  resetStore();
  const service = new EastMoneyQATopicService(makeFakeDS(makeFakeDSState()));
  let rows = await service.listByStock('');
  assertEqual('listByStock empty → []', rows.length, 0);
  rows = await service.listByStock('BADCODE');
  assertEqual('listByStock BADCODE → []', rows.length, 0);
}

async function testListByStockWeeksClamp(): Promise<void> {
  resetStore();
  const service = new EastMoneyQATopicService(makeFakeDS(makeFakeDSState()));

  // weeks 上限 104; 应不抛
  const rows = await service.listByStock('600519', 9999);
  assertEqual('listByStock weeks clamp 不抛', rows.length, 0);

  // weeks ≤ 0 应 clamp 到 1 (不抛)
  await service.listByStock('600519', 0);
  await service.listByStock('600519', -10);
  // weeks=1 应不抛
  await service.listByStock('600519', 1);
  // weeks=未传 (使用 default)
  await service.listByStock('600519');
  // OK as long as no throws
  assert('listByStock 多 weeks 值都不抛', true);
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installModelStubs();

  // constants & defaults
  testConstantsFrozen();
  testDefaultsSanity();

  // pure helpers
  await testSleep();
  testComputeWeekStart();
  testClassifyTopic();
  testDetectTopicByKeyword();
  testScoreSentiment();
  testNormalizeTopic();
  // QA-001 subcategory pure helper tests
  testSubtopicConstantsFrozen();
  testDetectSubtopicByKeyword();
  testClassifySubtopicEdgeCases();
  testClassifySubtopicParentChild();
  testClassifySubtopicTieBreakPriority();
  testClassifySubtopicAccuracyCorpus();
  testAggregateWeeklyHappyPath();
  testAggregateWeeklyMultiWeekMultiTopic();
  testAggregateWeeklyEmpty();
  testAggregateWeeklySinceFilter();
  testAggregateWeeklyInvalidQuestionTime();
  testAggregateWeeklyUseAI();
  testAggregateWeeklyBreakdown();
  testAggregateWeeklySampleIdsCap();
  testAggregateWeeklySorting();
  testParseRemoteClassify();

  // service.syncStock
  await testSyncStockHappyPath();
  await testSyncStockInvalidCode();
  await testSyncStockFetchEmpty();
  await testSyncStockDryRun();
  await testSyncStockWithAI();
  await testSyncStockAIRemoteFailedPayload();
  await testSyncStockAIRemoteThrows();
  await testSyncStockSaveFailOpen();
  await testSyncStockFetchThrows();
  await testSyncStockSinceFilter();

  // service.syncStocks
  await testSyncStocksAllSucceed();
  await testSyncStocksContinueOnError();
  await testSyncStocksStopOnFirstError();
  await testSyncStocksInvalidCodeContinue();

  // service.listByStock
  await testListByStockDefault();
  await testListByStockEmpty();
  await testListByStockWeeksClamp();

  console.log(`\n${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
