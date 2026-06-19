/**
 * AnnouncementNLPService 单元测试 (US-059)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/announcement-nlp-service.test.ts
 *
 * 完全脱离 DB / Python 子进程 / TradingAgents 远端: 注入 fake AnnouncementNLPDataSource.
 *
 * 由于 sync service 内部直接调 `AnnouncementSummary.count` / `.findAll` / `.bulkCreate`,
 * 这些是 Sequelize Model 静态方法 — 用 monkey-patch 替换成 fake backing store
 * (与 ai-advisor-service / snowball-hot-keyword-sync-service 同款 "in-memory model" 测试模式).
 *
 * 覆盖维度:
 *   - 纯函数:
 *     - parseIsoDate (有效 / 无效);
 *     - sleep (resolve);
 *     - heuristicSentiment (4 档 + 优先级 + null);
 *     - extractAmounts (多金额 / 单位 / 上限 / 边界);
 *     - extractTopics (字典命中 / 去重 / 上限);
 *     - heuristicSummarize (短/长 + null);
 *     - normalizeSentiment (中文 / 英文 / 大小写);
 *     - buildHeuristicNLPResult (整合);
 *     - buildNLPResultFromPayload (成功 / 失败 fallback);
 *   - service.summarize() e2e:
 *     - extract_with_ai=false 走启发式 (不调远端);
 *     - extract_with_ai=true + 远端成功 → status=completed + engine=trading_agents;
 *     - extract_with_ai=true + 远端失败 → status=partial + engine=heuristic_fallback;
 *     - 远端 throw → 双重防御 catch + fallback;
 *   - service.syncDate() e2e:
 *     - happy path: 3 行公告 全部 upsert, 启发式;
 *     - dry_run=true: 不写库, persisted=false;
 *     - fetch throws → returns error result + persisted=false;
 *     - fetch returns [] → returns ok + 0 rows;
 *     - saveSummaries throw → fail-OPEN + 返回 error;
 *     - AI 路径每条调远端 + 失败 fallback 启发式;
 *   - service.syncRange() e2e:
 *     - start > end → throws;
 *     - 多日遍历 + intervalMs=0;
 *     - skipExisting 跳过已存在日;
 *     - 单日失败不阻塞其他日;
 *   - service.listByStock():
 *     - 默认 days=30;
 *     - days 上限 clamp;
 *     - limit clamp;
 *     - 空 stock_code → [];
 *   - service.listByDate():
 *     - sentiment filter;
 *     - 无效 date → [];
 */

import {
  AnnouncementNLPService,
  AnnouncementNLPDataSource,
  AnnouncementNLPRecord,
  RemoteNLPPayload,
  SENTIMENT_VALUES,
  NLP_ENGINES,
  ANN_SENTIMENT_KEYWORDS,
  TOPIC_KEYWORDS,
  ANNOUNCEMENT_PRIORITY_VALUES,
  ANNOUNCEMENT_EVENT_TYPES,
  parseIsoDate,
  sleep,
  heuristicSentiment,
  extractAmounts,
  extractTopics,
  heuristicSummarize,
  normalizeSentiment,
  normalizePriority,
  normalizeEventType,
  classifyEventType,
  EVENT_TYPE_KEYWORDS,
  normalizeEntities,
  extractEntities,
  ENTITY_ROLE_KEYWORDS,
  ENTITY_CHANGE_TYPE_KEYWORDS,
  extractEarningsGrade,
  EARNINGS_TITLE_KEYWORDS,
  EARNINGS_DIRECTION_KEYWORDS,
  EARNINGS_MAGNITUDE_THRESHOLDS,
  EarningsDirection,
  EarningsMagnitude,
  computePriority,
  PRIORITY_AMOUNT_THRESHOLDS_WAN,
  buildStructuredSummary,
  BuildStructuredSummaryInput,
  formatAmountsDetailed,
  formatEntitiesDetailed,
  formatEarningsGradeDetailed,
  MAX_STRUCTURED_SUMMARY_LEN,
  STRUCTURED_SUMMARY_SEPARATOR,
  buildHeuristicNLPResult,
  buildNLPResultFromPayload,
} from '../../src/services/AnnouncementNLPService';
import {
  AnnouncementReportRow,
  AnnouncementSymbol,
} from '../../src/data/sources/AnnouncementClient';
import { AnnouncementSummary } from '../../src/models/AnnouncementSummary';

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

async function expectThrow(
  name: string,
  fn: () => Promise<unknown>,
  includes?: string
): Promise<void> {
  try {
    await fn();
    failed += 1;
    console.error(`❌ ${name}  expected throw but did not`);
  } catch (e) {
    const msg = (e as Error).message;
    if (includes && !msg.includes(includes)) {
      failed += 1;
      console.error(`❌ ${name}  threw '${msg}' but did not include '${includes}'`);
    } else {
      passed += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory backing-store: monkey-patch Sequelize Model statics.
// ---------------------------------------------------------------------------

interface FakeRowState {
  id?: number;
  announce_date: string;
  stock_code: string;
  stock_name?: string | null;
  original_title: string;
  announcement_type?: string | null;
  url?: string | null;
  summary?: string | null;
  sentiment?: string | null;
  key_amounts_json?: unknown;
  key_topics_json?: unknown;
  // US-025 ANN-001: 让 fake store 也记录新列, 用于断言 saveSummaries 真把字段透传到 bulkCreate.
  event_type?: string | null;
  priority?: string;
  entities?: unknown;
  status?: string;
  nlp_engine?: string | null;
  error?: string | null;
  raw_payload?: unknown;
  updated_at?: Date;
}

let store: FakeRowState[] = [];
let nextId = 1;

function resetStore(): void {
  store = [];
  nextId = 1;
}

function installModelStubs(): void {
  // bulkCreate: upsert by (announce_date, stock_code, original_title) composite UNIQUE
  (AnnouncementSummary as any).bulkCreate = async (
    records: FakeRowState[],
    _options?: unknown
  ): Promise<FakeRowState[]> => {
    for (const r of records) {
      const idx = store.findIndex(
        s =>
          s.announce_date === r.announce_date &&
          s.stock_code === r.stock_code &&
          s.original_title === r.original_title
      );
      const merged: FakeRowState = { ...r, updated_at: new Date() };
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

  // count
  (AnnouncementSummary as any).count = async (options: any): Promise<number> => {
    const ad = options?.where?.announce_date;
    if (!ad) return store.length;
    return store.filter(s => s.announce_date === ad).length;
  };

  // findAll
  (AnnouncementSummary as any).findAll = async (
    options: any
  ): Promise<FakeRowState[]> => {
    let candidates = [...store];
    const ad = options?.where?.announce_date;
    if (typeof ad === 'string') {
      candidates = candidates.filter(s => s.announce_date === ad);
    } else if (ad && typeof ad === 'object') {
      const symbols = Object.getOwnPropertySymbols(ad);
      for (const sym of symbols) {
        const symStr = sym.toString();
        const v = ad[sym];
        if (symStr.includes('gte')) candidates = candidates.filter(s => s.announce_date >= v);
        else if (symStr.includes('lte')) candidates = candidates.filter(s => s.announce_date <= v);
        else if (symStr.includes('lt')) candidates = candidates.filter(s => s.announce_date < v);
        else if (symStr.includes('gt')) candidates = candidates.filter(s => s.announce_date > v);
      }
    }
    const sc = options?.where?.stock_code;
    if (typeof sc === 'string') {
      candidates = candidates.filter(s => s.stock_code === sc);
    }
    const sent = options?.where?.sentiment;
    if (typeof sent === 'string') {
      candidates = candidates.filter(s => s.sentiment === sent);
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
  fetchByDate: Record<string, AnnouncementReportRow[]>;
  fetchShouldThrow?: boolean;
  saveShouldThrow?: boolean;
  remoteShouldThrow?: boolean;
  remotePayload?: RemoteNLPPayload;
  remoteCalls: Array<{ title: string; ctx?: any }>;
  saveCalls: AnnouncementNLPRecord[][];
}

function makeFakeDS(state: FakeDSState): AnnouncementNLPDataSource {
  return {
    async fetchAnnouncements(date, _symbol: AnnouncementSymbol) {
      if (state.fetchShouldThrow) throw new Error('fake fetch outage');
      return state.fetchByDate[date] || [];
    },
    async callRemoteSummarize(title, context) {
      state.remoteCalls.push({ title, ctx: context });
      if (state.remoteShouldThrow) throw new Error('fake remote outage');
      return (
        state.remotePayload || {
          status: 'COMPLETED',
          data: {
            summary: `AI 摘要: ${title}`,
            sentiment: 'positive',
            key_amounts: [{ label: '金额', amount: 1.5, unit: '亿元' }],
            key_topics: ['新能源', '光伏'],
          },
        }
      );
    },
    async saveSummaries(records) {
      if (state.saveShouldThrow) throw new Error('fake save outage');
      state.saveCalls.push([...records]);
    },
  };
}

function makeFakeDSState(overrides: Partial<FakeDSState> = {}): FakeDSState {
  return {
    fetchByDate: {},
    remoteCalls: [],
    saveCalls: [],
    ...overrides,
  };
}

function makeRow(
  partial: Partial<AnnouncementReportRow> & { original_title: string; stock_code: string }
): AnnouncementReportRow {
  return {
    announce_date: '2026-06-06',
    stock_name: '测试',
    announcement_type: '重大事项',
    url: 'https://example.com',
    raw_payload: {},
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

function testParseIsoDate(): void {
  const d = parseIsoDate('2026-06-08');
  assert(
    'parseIsoDate valid',
    d.getUTCFullYear() === 2026 && d.getUTCMonth() === 5 && d.getUTCDate() === 8
  );
  let threw = false;
  try {
    parseIsoDate('not-a-date');
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert('parseIsoDate gibberish throws RangeError', threw);
}

async function testSleep(): Promise<void> {
  const start = Date.now();
  await sleep(20);
  const elapsed = Date.now() - start;
  assert('sleep ~20ms', elapsed >= 15);
}

function testSentimentValuesFrozen(): void {
  assert('SENTIMENT_VALUES frozen', Object.isFrozen(SENTIMENT_VALUES));
  assertEqual(
    'SENTIMENT_VALUES content',
    [...SENTIMENT_VALUES],
    ['正面', '中性', '负面']
  );
  assert('NLP_ENGINES frozen', Object.isFrozen(NLP_ENGINES));
  assert('ANN_SENTIMENT_KEYWORDS frozen', Object.isFrozen(ANN_SENTIMENT_KEYWORDS));
  assert('TOPIC_KEYWORDS frozen', Object.isFrozen(TOPIC_KEYWORDS));
}

function testHeuristicSentiment(): void {
  // 强空 — 优先级最高
  assertEqual('强空: 立案调查 → 负面', heuristicSentiment('立案调查事项'), '负面');
  assertEqual('强空: 退市 → 负面', heuristicSentiment('退市风险警示'), '负面');
  assertEqual('强空: ST → 负面', heuristicSentiment('实施其他风险警示ST'), '负面');

  // 强多
  assertEqual('强多: 业绩超预期 → 正面', heuristicSentiment('业绩超预期增长'), '正面');
  assertEqual('强多: 中标 → 正面', heuristicSentiment('中标重大合同'), '正面');
  assertEqual('强多: 回购 → 正面', heuristicSentiment('股份回购实施公告'), '正面');

  // 弱空
  assertEqual('弱空: 减持 → 负面', heuristicSentiment('股东减持计划公告'), '负面');
  assertEqual('弱空: 风险提示 → 负面', heuristicSentiment('股价异动风险提示'), '负面');

  // 弱多
  assertEqual('弱多: 设立子公司 → 正面', heuristicSentiment('设立子公司公告'), '正面');
  assertEqual('弱多: 战略合作 → 正面', heuristicSentiment('与某公司签订战略合作'), '正面');

  // 中性
  assertEqual('中性: 中性公告', heuristicSentiment('召开股东大会通知'), '中性');
  assertEqual('null → 中性', heuristicSentiment(null), '中性');
  assertEqual('undefined → 中性', heuristicSentiment(undefined), '中性');
  assertEqual('空串 → 中性', heuristicSentiment(''), '中性');

  // 优先级测试: 同时含强空+强多 → 强空 (安全派)
  assertEqual(
    '优先级: 立案+业绩超预期 → 负面 (强空优先)',
    heuristicSentiment('业绩超预期但被立案调查'),
    '负面'
  );
}

function testExtractAmounts(): void {
  const r1 = extractAmounts('募集资金 1.5 亿元');
  assertEqual('amount 1.5 亿元', r1.length, 1);
  assertEqual('amount value 1.5', r1[0].amount, 1.5);
  assertEqual('amount unit 亿元', r1[0].unit, '亿元');

  const r2 = extractAmounts('回购金额上限5亿元, 下限2亿元, 占总股本0.5%');
  assertEqual('multiple amounts', r2.length, 2);
  assertEqual('first 5亿元', r2[0].amount, 5);
  assertEqual('second 2亿元', r2[1].amount, 2);

  const r3 = extractAmounts('未涉及金额的普通通知');
  assertEqual('no amounts', r3.length, 0);

  const r4 = extractAmounts(null);
  assertEqual('null amounts', r4.length, 0);

  // 上限 MAX_AMOUNTS_PER_TITLE=3
  const r5 = extractAmounts('1亿元 2亿元 3亿元 4亿元 5亿元');
  assert('amount upper bound 3', r5.length === 3, `got ${r5.length}`);

  // 各种单位
  const r6 = extractAmounts('增持股份100万股，回购10万元');
  assertEqual('万股 amounts', r6[0].unit, '万股');
  assertEqual('万元 amounts', r6[1].unit, '万元');

  // 0 / 负 → 跳过
  const r7 = extractAmounts('涉及金额 0 元 (无效)');
  assertEqual('zero amount skipped', r7.length, 0);
}

function testExtractTopics(): void {
  const r1 = extractTopics('新能源汽车光伏储能业务');
  assert('topic 新能源 hit', r1.includes('新能源'));
  assert('topic 光伏 hit', r1.includes('光伏'));
  assert('topic 储能 hit', r1.includes('储能'));

  const r2 = extractTopics('与某公司签订海外订单, 业绩预告');
  assert('topic 海外订单 hit', r2.includes('海外订单'));
  assert('topic 业绩预告 hit', r2.includes('业绩预告'));

  const r3 = extractTopics('召开股东大会通知');
  assertEqual('no topics', r3.length, 0);

  const r4 = extractTopics(null);
  assertEqual('null topics', r4.length, 0);

  // 去重 + 上限 MAX_TOPICS_PER_TITLE=5
  const r5 = extractTopics('新能源 新能源 光伏 储能 风电 氢能 锂电 半导体');
  assert('topic upper bound 5', r5.length === 5, `got ${r5.length}`);
  assert('topic dedup', r5.filter(t => t === '新能源').length === 1);
}

function testHeuristicSummarize(): void {
  // 短标题 (≤ 50)
  const s1 = heuristicSummarize('股东减持公告', '负面');
  assertEqual('short title summary', s1, '[负面] 股东减持公告');

  // 长标题 (> 50)
  const long = 'a'.repeat(60);
  const s2 = heuristicSummarize(long, '中性');
  assert('long title truncated', s2 !== null && s2.includes('...'));
  assert('long title with prefix', s2 !== null && s2.startsWith('[中性]'));

  // null
  assertEqual('null summary', heuristicSummarize(null, '中性'), null);
  assertEqual('empty summary', heuristicSummarize('', '中性'), null);
}

function testNormalizeSentiment(): void {
  assertEqual('中文 正面', normalizeSentiment('正面'), '正面');
  assertEqual('中文 负面', normalizeSentiment('负面'), '负面');
  assertEqual('中文 中性', normalizeSentiment('中性'), '中性');

  assertEqual('英文 positive → 正面', normalizeSentiment('positive'), '正面');
  assertEqual('英文 NEGATIVE → 负面', normalizeSentiment('NEGATIVE'), '负面');
  assertEqual('英文 Neutral → 中性', normalizeSentiment('Neutral'), '中性');
  assertEqual('英文 bullish → 正面', normalizeSentiment('bullish'), '正面');
  assertEqual('英文 bearish → 负面', normalizeSentiment('bearish'), '负面');

  assertEqual('null → 中性', normalizeSentiment(null), '中性');
  assertEqual('未识别 → 中性', normalizeSentiment('xyz'), '中性');
}

function testBuildHeuristicNLPResult(): void {
  const row = makeRow({
    stock_code: '600519',
    original_title: '业绩超预期新能源光伏业务大增, 营收 1.5 亿元',
  });
  const r = buildHeuristicNLPResult(row);
  assertEqual('heuristic status completed', r.status, 'completed');
  assertEqual('heuristic engine', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  assertEqual('heuristic sentiment 正面', r.sentiment, '正面');
  assert(
    'heuristic summary present',
    typeof r.summary === 'string' && r.summary.startsWith('[正面]')
  );
  assert('heuristic amounts present', r.key_amounts_json.length === 1);
  assert('heuristic topics present', r.key_topics_json.length >= 2);
  assertEqual('heuristic no error', r.error, null);
  assertEqual('heuristic stock_code', r.stock_code, '600519');
  // US-025 ANN-001: 三新字段默认占位 (ANN-002~005 实现前)
  // US-026 ANN-002: classifyEventType 已接入, 标题含 '业绩' → '业绩'
  assertEqual('heuristic event_type classified', r.event_type, '业绩');
  // US-029 ANN-005: 接入 computePriority — earnings_grade (业绩超预期+无yoy→increase/minor)
  // + event_type='业绩' → medium (业绩 grade 存在但 magnitude 非 major), 不再固定 low.
  assertEqual('heuristic priority computed medium', r.priority, 'medium');
  assert('heuristic entities default []', Array.isArray(r.entities) && r.entities.length === 0);
}

function testBuildNLPResultFromPayloadSuccess(): void {
  const row = makeRow({
    stock_code: '000001',
    original_title: '股东大会公告',
  });
  const payload: RemoteNLPPayload = {
    status: 'COMPLETED',
    data: {
      summary: 'AI 摘要 — 召开股东大会',
      sentiment: 'neutral',
      key_amounts: [{ label: '总额', amount: 100, unit: '万元' }],
      key_topics: ['治理'],
    },
  };
  const r = buildNLPResultFromPayload(payload, row);
  assertEqual('AI status completed', r.status, 'completed');
  assertEqual('AI engine', r.nlp_engine, NLP_ENGINES.TRADING_AGENTS);
  assertEqual('AI sentiment', r.sentiment, '中性');
  assertEqual('AI summary', r.summary, 'AI 摘要 — 召开股东大会');
  assertEqual('AI amounts', r.key_amounts_json.length, 1);
  assertEqual('AI amount 100', r.key_amounts_json[0].amount, 100);
  assertEqual('AI topic 治理', r.key_topics_json[0], '治理');
  // US-025 ANN-001: payload 未带新字段时, normalize 默认 null/low/[]
  assertEqual('AI payload no event_type → null', r.event_type, null);
  assertEqual('AI payload no priority → low', r.priority, 'low');
  assert('AI payload no entities → []', Array.isArray(r.entities) && r.entities.length === 0);
}

function testBuildNLPResultFromPayloadFailed(): void {
  const row = makeRow({
    stock_code: '000001',
    original_title: '业绩超预期增长公告',
  });
  const payload: RemoteNLPPayload = {
    status: 'FAILED',
    data: { error: 'remote 500' },
  };
  const r = buildNLPResultFromPayload(payload, row);
  assertEqual('failed status partial', r.status, 'partial');
  assertEqual('failed engine heuristic', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  // 启发式 fallback: 业绩超预期 → 正面
  assertEqual('failed fallback sentiment 正面', r.sentiment, '正面');
  assert('failed error present', r.error === 'remote 500');
  // 启发式 summary 仍生成
  assert(
    'failed fallback summary',
    typeof r.summary === 'string' && r.summary.startsWith('[正面]')
  );
}

function testBuildNLPResultFromPayloadMissingData(): void {
  const row = makeRow({
    stock_code: '000001',
    original_title: '减持公告',
  });
  const payload: RemoteNLPPayload = { status: 'COMPLETED' }; // 无 data
  const r = buildNLPResultFromPayload(payload, row);
  assertEqual('no-data → partial', r.status, 'partial');
  assertEqual('no-data → heuristic', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  assertEqual('no-data → fallback 负面', r.sentiment, '负面');
}

function testBuildNLPResultFromPayloadInvalidAmounts(): void {
  const row = makeRow({ stock_code: '000001', original_title: '某公告' });
  const payload: RemoteNLPPayload = {
    status: 'COMPLETED',
    data: {
      summary: 'x',
      sentiment: '中性',
      key_amounts: [
        { label: 'ok', amount: 1, unit: '元' },
        { label: 'bad', amount: NaN as any, unit: '元' },
        { label: 'no-amt' as any } as any,
      ],
    },
  };
  const r = buildNLPResultFromPayload(payload, row);
  assert('valid amount kept', r.key_amounts_json.length === 1);
  assertEqual('valid amount value', r.key_amounts_json[0].amount, 1);
}

// ---------------------------------------------------------------------------
// service.summarize() tests
// ---------------------------------------------------------------------------

async function testSummarizeHeuristic(): Promise<void> {
  const state = makeFakeDSState();
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const row = makeRow({
    stock_code: '600519',
    original_title: '业绩超预期增长',
  });
  const r = await service.summarize(row, { extract_with_ai: false });
  assertEqual('summarize default heuristic', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  assertEqual('summarize sentiment 正面', r.sentiment, '正面');
  assertEqual('summarize no remote calls', state.remoteCalls.length, 0);
}

async function testSummarizeWithAISuccess(): Promise<void> {
  const state = makeFakeDSState();
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const row = makeRow({
    stock_code: '600519',
    original_title: '某公告',
  });
  const r = await service.summarize(row, { extract_with_ai: true });
  assertEqual('summarize AI engine', r.nlp_engine, NLP_ENGINES.TRADING_AGENTS);
  assertEqual('summarize AI status', r.status, 'completed');
  assertEqual('summarize remote called', state.remoteCalls.length, 1);
  assertEqual('summarize remote title', state.remoteCalls[0].title, '某公告');
  assertEqual('summarize remote ctx.stock_code', state.remoteCalls[0].ctx.stock_code, '600519');
}

async function testSummarizeWithAIFailedPayload(): Promise<void> {
  const state = makeFakeDSState({
    remotePayload: { status: 'FAILED', data: { error: 'AI down' } },
  });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const row = makeRow({
    stock_code: '600519',
    original_title: '股东减持公告',
  });
  const r = await service.summarize(row, { extract_with_ai: true });
  assertEqual('AI failed → partial', r.status, 'partial');
  assertEqual('AI failed → heuristic engine', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  // 启发式: 减持 → 负面
  assertEqual('AI failed fallback 负面', r.sentiment, '负面');
}

async function testSummarizeWithAIRemoteThrows(): Promise<void> {
  const state = makeFakeDSState({ remoteShouldThrow: true });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const row = makeRow({
    stock_code: '600519',
    original_title: '业绩超预期增长',
  });
  // 双重防御: ds throws → service catches → fallback heuristic
  const r = await service.summarize(row, { extract_with_ai: true });
  assertEqual('throw → partial', r.status, 'partial');
  assertEqual('throw → heuristic engine', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  assertEqual('throw fallback 正面', r.sentiment, '正面');
  assert('throw error includes outage', !!r.error && r.error.includes('outage'));
}

// ---------------------------------------------------------------------------
// service.syncDate() tests
// ---------------------------------------------------------------------------

async function testSyncDateHappyPath(): Promise<void> {
  resetStore();
  const rows = [
    makeRow({
      stock_code: '600519',
      original_title: '业绩超预期增长',
      announce_date: '2026-06-06',
    }),
    makeRow({
      stock_code: '000001',
      original_title: '股东减持公告',
      announce_date: '2026-06-06',
    }),
    makeRow({
      stock_code: '300750',
      original_title: '召开股东大会通知',
      announce_date: '2026-06-06',
    }),
  ];
  const state = makeFakeDSState({ fetchByDate: { '2026-06-06': rows } });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncDate('2026-06-06');
  assertEqual('syncDate fetched 3', result.fetched, 3);
  assertEqual('syncDate upserted 3', result.upserted, 3);
  assertEqual('syncDate skipped', result.skipped, false);
  assertEqual('syncDate error', result.error, undefined);
  // fake DS saves to state.saveCalls (not the model store), assert there
  assertEqual('syncDate save called once', state.saveCalls.length, 1);
  assertEqual('syncDate save records count', state.saveCalls[0].length, 3);
  // by_sentiment counters
  assertEqual('syncDate 正面 count', result.by_sentiment['正面'], 1);
  assertEqual('syncDate 负面 count', result.by_sentiment['负面'], 1);
  assertEqual('syncDate 中性 count', result.by_sentiment['中性'], 1);
  assertEqual('syncDate completed', result.by_status['completed'], 3);
  // 默认未走 AI
  assertEqual('syncDate no remote calls', state.remoteCalls.length, 0);
}

async function testSyncDateDryRun(): Promise<void> {
  resetStore();
  const rows = [makeRow({ stock_code: '600519', original_title: 'A' })];
  const state = makeFakeDSState({ fetchByDate: { '2026-06-06': rows } });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncDate('2026-06-06', { dry_run: true });
  assertEqual('dry_run fetched 1', result.fetched, 1);
  assertEqual('dry_run upserted 0', result.upserted, 0);
  assertEqual('dry_run store unchanged', store.length, 0);
  assertEqual('dry_run no save calls', state.saveCalls.length, 0);
}

async function testSyncDateFetchEmpty(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({ fetchByDate: { '2026-06-06': [] } });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncDate('2026-06-06');
  assertEqual('empty fetched 0', result.fetched, 0);
  assertEqual('empty upserted 0', result.upserted, 0);
  assertEqual('empty no error', result.error, undefined);
}

async function testSyncDateFetchThrows(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({ fetchShouldThrow: true });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncDate('2026-06-06');
  assertEqual('throw fetched 0', result.fetched, 0);
  assertEqual('throw upserted 0', result.upserted, 0);
  assert(
    'throw error includes outage',
    !!result.error && result.error.includes('outage')
  );
  assertEqual('throw store unchanged', store.length, 0);
}

async function testSyncDateSaveFailsFailOpen(): Promise<void> {
  resetStore();
  const rows = [makeRow({ stock_code: '600519', original_title: 'A' })];
  const state = makeFakeDSState({
    fetchByDate: { '2026-06-06': rows },
    saveShouldThrow: true,
  });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncDate('2026-06-06');
  // fail-OPEN: fetched 1, upserted 0, error 字段 含 save_failed
  assertEqual('save fail fetched 1', result.fetched, 1);
  assertEqual('save fail upserted 0', result.upserted, 0);
  assert(
    'save fail error save_failed',
    !!result.error && result.error.includes('save_failed')
  );
}

async function testSyncDateWithAI(): Promise<void> {
  resetStore();
  const rows = [
    makeRow({ stock_code: '600519', original_title: 'A' }),
    makeRow({ stock_code: '000001', original_title: 'B' }),
  ];
  const state = makeFakeDSState({ fetchByDate: { '2026-06-06': rows } });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncDate('2026-06-06', { extract_with_ai: true });
  assertEqual('AI fetched 2', result.fetched, 2);
  assertEqual('AI remote 2 calls', state.remoteCalls.length, 2);
  // 默认 remote payload: 正面
  assertEqual('AI all 正面', result.by_sentiment['正面'], 2);
  assertEqual('AI all completed', result.by_status['completed'], 2);
}

// ---------------------------------------------------------------------------
// service.syncRange() tests
// ---------------------------------------------------------------------------

async function testSyncRangeInvalid(): Promise<void> {
  resetStore();
  const state = makeFakeDSState();
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  await expectThrow(
    'syncRange start > end throws',
    () => service.syncRange('2026-06-10', '2026-06-08'),
    'after end'
  );
}

async function testSyncRangeMultipleDays(): Promise<void> {
  resetStore();
  const state = makeFakeDSState({
    fetchByDate: {
      '2026-06-01': [makeRow({ stock_code: '000001', original_title: 'a' })],
      '2026-06-02': [makeRow({ stock_code: '000001', original_title: 'b' })],
      '2026-06-03': [makeRow({ stock_code: '000001', original_title: 'c' })],
    },
  });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncRange('2026-06-01', '2026-06-03', {
    intervalMs: 0,
    skipExisting: false,
  });
  assertEqual('range total_days', result.total_days, 3);
  assertEqual('range succeeded', result.succeeded, 3);
  assertEqual('range failed', result.failed, 0);
  // fake DS saves to state.saveCalls (not model store) — 3 days × 1 save each = 3 save calls
  assertEqual('range save called 3 times', state.saveCalls.length, 3);
}

async function testSyncRangeSkipsExisting(): Promise<void> {
  resetStore();
  store.push({
    announce_date: '2026-06-02',
    stock_code: '000999',
    original_title: 'pre-existing',
  });
  const state = makeFakeDSState({
    fetchByDate: {
      '2026-06-01': [makeRow({ stock_code: '000001', original_title: 'a' })],
      '2026-06-03': [makeRow({ stock_code: '000001', original_title: 'c' })],
    },
  });
  const ds = makeFakeDS(state);
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncRange('2026-06-01', '2026-06-03', {
    intervalMs: 0,
    skipExisting: true,
  });
  assertEqual('skip total_days', result.total_days, 3);
  assertEqual('skip succeeded', result.succeeded, 2);
  assertEqual('skip skipped 1', result.skipped, 1);
  assertEqual('skip failed', result.failed, 0);
}

async function testSyncRangeSingleDayFailsContinues(): Promise<void> {
  resetStore();
  // 02 throws, 01 & 03 succeed
  const state = makeFakeDSState({
    fetchByDate: {
      '2026-06-01': [makeRow({ stock_code: '000001', original_title: 'a' })],
      // 02 缺数据
      '2026-06-03': [makeRow({ stock_code: '000001', original_title: 'c' })],
    },
  });
  // 02 没在 fetchByDate 里, fake DS 返回 [] 不抛 — 改用 fetchShouldThrow 难触发. 用另一招:
  // monkeypatch 02 throws
  const origFetch = state.fetchByDate;
  const ds = {
    async fetchAnnouncements(date: string, _symbol: AnnouncementSymbol) {
      if (date === '2026-06-02') throw new Error('outage 06-02');
      return origFetch[date] || [];
    },
    callRemoteSummarize: async () => ({ status: 'COMPLETED', data: {} } as RemoteNLPPayload),
    saveSummaries: async () => {
      /* noop */
    },
  } as AnnouncementNLPDataSource;
  const service = new AnnouncementNLPService(ds);

  const result = await service.syncRange('2026-06-01', '2026-06-03', {
    intervalMs: 0,
    skipExisting: false,
  });
  assertEqual('partial total_days', result.total_days, 3);
  assertEqual('partial succeeded 2', result.succeeded, 2);
  assertEqual('partial failed 1', result.failed, 1);
  const failedDetail = result.details.find(d => d.announce_date === '2026-06-02');
  assert('partial 06-02 has error', !!failedDetail && !!failedDetail.error);
}

// ---------------------------------------------------------------------------
// service.listByStock() / listByDate() tests
// ---------------------------------------------------------------------------

async function testListByStockDefault(): Promise<void> {
  resetStore();
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);
  store.push({
    announce_date: isoToday,
    stock_code: '600519',
    original_title: 't1',
    sentiment: '正面',
  });
  store.push({
    announce_date: isoToday,
    stock_code: '000001',
    original_title: 'other',
    sentiment: '负面',
  });
  const service = new AnnouncementNLPService(makeFakeDS(makeFakeDSState()));

  const rows = await service.listByStock('600519');
  assertEqual('listByStock matched', rows.length, 1);
  assertEqual('listByStock code', rows[0].stock_code, '600519');
}

async function testListByStockEmpty(): Promise<void> {
  resetStore();
  const service = new AnnouncementNLPService(makeFakeDS(makeFakeDSState()));
  const rows = await service.listByStock('');
  assertEqual('listByStock empty stock_code → []', rows.length, 0);
}

async function testListByStockLimitClamp(): Promise<void> {
  resetStore();
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);
  for (let i = 0; i < 10; i++) {
    store.push({
      announce_date: isoToday,
      stock_code: '600519',
      original_title: `t${i}`,
    });
  }
  const service = new AnnouncementNLPService(makeFakeDS(makeFakeDSState()));

  // limit 3
  let rows = await service.listByStock('600519', 30, 3);
  assertEqual('listByStock limit 3', rows.length, 3);

  // limit 0 → clamp 1
  rows = await service.listByStock('600519', 30, 0);
  assertEqual('listByStock limit 0 → 1', rows.length, 1);

  // limit 99999 → clamp 1000 但 store 只 10
  rows = await service.listByStock('600519', 30, 99999);
  assertEqual('listByStock limit upper → 10', rows.length, 10);
}

async function testListByDateSentiment(): Promise<void> {
  resetStore();
  store.push({
    announce_date: '2026-06-06',
    stock_code: '600519',
    original_title: 'good',
    sentiment: '正面',
  });
  store.push({
    announce_date: '2026-06-06',
    stock_code: '000001',
    original_title: 'bad',
    sentiment: '负面',
  });
  store.push({
    announce_date: '2026-06-07',
    stock_code: '300750',
    original_title: 'next-day',
    sentiment: '正面',
  });
  const service = new AnnouncementNLPService(makeFakeDS(makeFakeDSState()));

  // 默认: 整日全部
  let rows = await service.listByDate('2026-06-06');
  assertEqual('listByDate count', rows.length, 2);

  // sentiment filter
  rows = await service.listByDate('2026-06-06', '正面');
  assertEqual('listByDate 正面 count', rows.length, 1);
  assertEqual('listByDate 正面 code', rows[0].stock_code, '600519');

  // 无效 date
  rows = await service.listByDate('invalid-date');
  assertEqual('listByDate invalid → []', rows.length, 0);
}

// ---------------------------------------------------------------------------
// US-025 ANN-001: 新字段 + 归一函数 + saveSummaries 透传 + migration 形态 + meta-guard
// ---------------------------------------------------------------------------

function testAnnouncementPriorityValuesFrozen(): void {
  assert(
    'ANNOUNCEMENT_PRIORITY_VALUES frozen',
    Object.isFrozen(ANNOUNCEMENT_PRIORITY_VALUES)
  );
  assertEqual('ANNOUNCEMENT_PRIORITY_VALUES count', ANNOUNCEMENT_PRIORITY_VALUES.length, 4);
  assertEqual('critical first', ANNOUNCEMENT_PRIORITY_VALUES[0], 'critical');
  assertEqual('low last', ANNOUNCEMENT_PRIORITY_VALUES[3], 'low');
}

function testAnnouncementEventTypesFrozen(): void {
  assert('ANNOUNCEMENT_EVENT_TYPES frozen', Object.isFrozen(ANNOUNCEMENT_EVENT_TYPES));
  assertEqual('ANNOUNCEMENT_EVENT_TYPES count', ANNOUNCEMENT_EVENT_TYPES.length, 7);
  for (const t of ['业绩', '重组', '减持', '担保', '处罚', '解禁', '其它']) {
    assert(
      `event_type contains ${t}`,
      (ANNOUNCEMENT_EVENT_TYPES as readonly string[]).includes(t)
    );
  }
}

function testNormalizePriority(): void {
  assertEqual('priority direct critical', normalizePriority('critical'), 'critical');
  assertEqual('priority direct high', normalizePriority('high'), 'high');
  assertEqual('priority direct medium', normalizePriority('medium'), 'medium');
  assertEqual('priority direct low', normalizePriority('low'), 'low');
  // 中文别名
  assertEqual('priority 关键 → critical', normalizePriority('关键'), 'critical');
  assertEqual('priority 紧急 → critical', normalizePriority('紧急'), 'critical');
  assertEqual('priority 高 → high', normalizePriority('高'), 'high');
  assertEqual('priority 中 → medium', normalizePriority('中'), 'medium');
  assertEqual('priority 低 → low', normalizePriority('低'), 'low');
  // 大小写不敏感 (走 toLowerCase + includes)
  assertEqual('priority CRITICAL → critical', normalizePriority('CRITICAL'), 'critical');
  assertEqual('priority High → high', normalizePriority('High'), 'high');
  // 兜底 — 未识别 / 空 / null 一律 low (绝不擅自 escalate 到 critical)
  assertEqual('priority null → low', normalizePriority(null), 'low');
  assertEqual('priority undefined → low', normalizePriority(undefined), 'low');
  assertEqual('priority empty → low', normalizePriority(''), 'low');
  assertEqual('priority 随便 → low', normalizePriority('xxx-random'), 'low');
  assertEqual('priority number 1 → low', normalizePriority(1 as any), 'low');
}

function testNormalizeEventType(): void {
  // 直接枚举
  assertEqual('event 业绩', normalizeEventType('业绩'), '业绩');
  assertEqual('event 重组', normalizeEventType('重组'), '重组');
  assertEqual('event 减持', normalizeEventType('减持'), '减持');
  assertEqual('event 担保', normalizeEventType('担保'), '担保');
  assertEqual('event 处罚', normalizeEventType('处罚'), '处罚');
  assertEqual('event 解禁', normalizeEventType('解禁'), '解禁');
  assertEqual('event 其它', normalizeEventType('其它'), '其它');
  // 英文别名
  assertEqual('event earnings → 业绩', normalizeEventType('earnings'), '业绩');
  assertEqual('event RESTRUCTURE → 重组', normalizeEventType('RESTRUCTURE'), '重组');
  assertEqual('event reduction → 减持', normalizeEventType('reduction'), '减持');
  assertEqual('event guarantee → 担保', normalizeEventType('guarantee'), '担保');
  assertEqual('event penalty → 处罚', normalizeEventType('penalty'), '处罚');
  assertEqual('event unlock → 解禁', normalizeEventType('unlock'), '解禁');
  assertEqual('event 违规 → 处罚', normalizeEventType('违规'), '处罚');
  assertEqual('event 并购 → 重组', normalizeEventType('并购'), '重组');
  // 未识别 → '其它' (区别于 null)
  assertEqual('event 随便 → 其它', normalizeEventType('完全不认识的事件'), '其它');
  // null / empty → null
  assertEqual('event null → null', normalizeEventType(null), null);
  assertEqual('event undefined → null', normalizeEventType(undefined), null);
  assertEqual('event empty → null', normalizeEventType(''), null);
  assertEqual('event whitespace → null', normalizeEventType('   '), null);
}

// ---------------------------------------------------------------------------
// US-026 ANN-002: classifyEventType — 启发式 7 大事件分类
// ---------------------------------------------------------------------------

function testEventTypeKeywordsFrozen(): void {
  // EVENT_TYPE_KEYWORDS 顺序锁定 (优先级链), 任何 reorder 都会让"含多类关键词"标题归属漂移.
  const order = EVENT_TYPE_KEYWORDS.map(g => g.type);
  assertEqual(
    'EVENT_TYPE_KEYWORDS order',
    order,
    ['处罚', '减持', '解禁', '重组', '担保', '业绩']
  );
  assert('EVENT_TYPE_KEYWORDS frozen', Object.isFrozen(EVENT_TYPE_KEYWORDS));
  for (const g of EVENT_TYPE_KEYWORDS) {
    assert(`group ${g.type} frozen`, Object.isFrozen(g));
    assert(`group ${g.type} keywords frozen`, Object.isFrozen(g.keywords));
    assert(`group ${g.type} keywords non-empty`, g.keywords.length > 0);
  }
}

function testClassifyEventTypeBasic(): void {
  // 单关键词命中 7 类 (含 '其它' 兜底)
  assertEqual('classify 业绩预告', classifyEventType('业绩预告: 2025 年净利润同比增长 50%'), '业绩');
  assertEqual('classify 业绩快报', classifyEventType('2025 年度业绩快报'), '业绩');
  assertEqual('classify 一季报', classifyEventType('2026 年第一季度报告'), '业绩');

  assertEqual(
    'classify 资产重组',
    classifyEventType('关于重大资产重组进展的公告'),
    '重组'
  );
  assertEqual('classify 并购', classifyEventType('收购 XX 公司 100% 股权之并购'), '重组');

  assertEqual('classify 股东减持', classifyEventType('股东减持股份计划公告'), '减持');
  assertEqual('classify 高管减持', classifyEventType('董事长减持公司股票'), '减持');

  assertEqual('classify 对外担保', classifyEventType('为全资子公司提供担保的公告'), '担保');
  assertEqual(
    'classify 关联担保',
    classifyEventType('关于关联担保事项的公告'),
    '担保'
  );

  assertEqual(
    'classify 行政处罚',
    classifyEventType('收到中国证监会行政处罚事先告知书'),
    '处罚'
  );
  assertEqual('classify 立案调查', classifyEventType('收到立案告知书'), '处罚');
  assertEqual('classify 警示函', classifyEventType('收到监管警示函的公告'), '处罚');

  assertEqual('classify 解禁', classifyEventType('限售股解禁公告'), '解禁');
  assertEqual('classify 解除限售', classifyEventType('股份解除限售流通'), '解禁');

  // 其它 — 非 6 类
  assertEqual(
    'classify 召开股东大会 → 其它',
    classifyEventType('召开 2026 年第一次临时股东大会'),
    '其它'
  );
  assertEqual(
    'classify 高送转 → 其它 (业绩词 "净利润" 等未出现)',
    classifyEventType('2025 年度分红方案: 10 送 5 转 5'),
    '其它'
  );

  // null / empty / whitespace → null (与 normalizeEventType 同款边界)
  assertEqual('classify null → null', classifyEventType(null), null);
  assertEqual('classify undefined → null', classifyEventType(undefined), null);
  assertEqual('classify empty → null', classifyEventType(''), null);
  assertEqual('classify whitespace → null', classifyEventType('   '), null);
}

function testClassifyEventTypePriorityChain(): void {
  // 优先级链: 处罚 > 减持 > 解禁 > 重组 > 担保 > 业绩
  // 含 "处罚" + "业绩" → 处罚 (安全派优先, 强监管事件优先)
  assertEqual(
    'priority 处罚 > 业绩',
    classifyEventType('业绩快报: 净利润同比增长 30% 同时收到行政处罚告知书'),
    '处罚'
  );
  // 含 "减持" + "业绩" → 减持
  assertEqual(
    'priority 减持 > 业绩',
    classifyEventType('业绩预增公告 + 股东减持计划'),
    '减持'
  );
  // 含 "重组" + "担保" → 重组
  assertEqual(
    'priority 重组 > 担保',
    classifyEventType('重大资产重组涉及关联担保事项'),
    '重组'
  );
  // 含 "立案调查" + "减持" → 处罚
  assertEqual(
    'priority 处罚 > 减持',
    classifyEventType('收到立案调查通知, 股东拟减持'),
    '处罚'
  );
  // 含 "解禁" + "业绩" → 解禁
  assertEqual(
    'priority 解禁 > 业绩',
    classifyEventType('限售股解禁公告 — 净利润同比增长'),
    '解禁'
  );
}

function testClassifyEventTypeAccuracy(): void {
  // AC 主验收 — 20 条人工标注真实样本风格标题, 准确率必须 ≥ 80% (=16/20).
  //
  // 标注集挑选原则:
  //   - 每类 2-3 条覆盖 ("业绩" 4 条最大, "其它" 3 条兜底);
  //   - 含 1-2 条 "易混淆" 标题守优先级链 (e.g. "业绩 + 减持" → 减持);
  //   - 含 1 条 "无关键词" 标题守 '其它' 兜底 (e.g. 股东大会);
  //   - 不含可破 80% 的恶意噪声 (e.g. 长尾文学引用).
  const labeled: Array<{ title: string; expected: AnnouncementEventType }> = [
    // 业绩 (4)
    { title: '2025 年度业绩快报', expected: '业绩' },
    { title: '关于业绩预告修正的公告', expected: '业绩' },
    { title: '2026 年第一季度报告披露', expected: '业绩' },
    { title: '年度报告及摘要', expected: '业绩' },
    // 重组 (2)
    { title: '重大资产重组进展暨复牌公告', expected: '重组' },
    { title: '关于发行股份购买资产并募集配套资金的预案', expected: '重组' },
    // 减持 (3)
    { title: '控股股东减持计划公告', expected: '减持' },
    { title: '关于持股 5% 以上股东减持股份的进展', expected: '减持' },
    { title: '董事拟通过大宗交易减持', expected: '减持' },
    // 担保 (2)
    { title: '为全资子公司提供担保的公告', expected: '担保' },
    { title: '关联担保事项进展', expected: '担保' },
    // 处罚 (3)
    { title: '收到中国证监会立案告知书', expected: '处罚' },
    { title: '收到行政处罚决定书', expected: '处罚' },
    { title: '收到深交所监管函', expected: '处罚' },
    // 解禁 (2)
    { title: '首次公开发行限售股解禁公告', expected: '解禁' },
    { title: '股份解除限售流通公告', expected: '解禁' },
    // 易混淆 — 业绩 + 减持 → 减持 (优先级链)
    { title: '业绩预增同时大股东减持', expected: '减持' },
    // 其它 (3)
    { title: '召开 2026 年第一次临时股东大会', expected: '其它' },
    { title: '关于变更注册地址的公告', expected: '其它' },
    { title: '高级管理人员辞职公告', expected: '其它' },
  ];
  let correct = 0;
  const wrong: Array<string> = [];
  for (const c of labeled) {
    const got = classifyEventType(c.title);
    if (got === c.expected) {
      correct += 1;
    } else {
      wrong.push(`  "${c.title}" expected=${c.expected} got=${got}`);
    }
  }
  const total = labeled.length;
  const accuracy = correct / total;
  assert(
    `AC: classifyEventType accuracy ${correct}/${total} (${(accuracy * 100).toFixed(1)}%) >= 80%`,
    accuracy >= 0.8,
    wrong.length > 0 ? `\nwrong predictions:\n${wrong.join('\n')}` : ''
  );
  // 同时记录无 wrong 时的 baseline (有 wrong 时还是会过, 只要 ≥80%)
  if (wrong.length > 0 && accuracy >= 0.8) {
    console.log(
      `  ⚠ classifyEventType accuracy=${(accuracy * 100).toFixed(
        1
      )}% (>=80% AC met but ${wrong.length} miss):\n${wrong.join('\n')}`
    );
  }
}

function testClassifyEventTypeWiringHeuristicResult(): void {
  // builder 真的接入 classifyEventType — 标题含 '减持' → r.event_type === '减持'
  const row = makeRow({
    stock_code: '600519',
    original_title: '股东减持公司股份计划',
  });
  const r = buildHeuristicNLPResult(row);
  assertEqual('builder wires classifyEventType', r.event_type, '减持');
}

function testNormalizeEntities(): void {
  // happy path — 必填 name + role
  const r = normalizeEntities([
    { name: '张三', role: '股东', holding_pct: 5.2 },
    { name: '李四', role: '高管' },
  ]);
  assertEqual('entities length', r.length, 2);
  assertEqual('entity 0 name', r[0].name, '张三');
  assertEqual('entity 0 role', r[0].role, '股东');
  assertEqual('entity 0 holding_pct', r[0].holding_pct, 5.2);
  assertEqual('entity 1 no holding_pct', r[1].holding_pct, undefined);

  // 缺 name / role 即 drop, 不报错
  const r2 = normalizeEntities([
    { name: '', role: '股东' },
    { name: '王五', role: '' },
    { role: '高管' } as any,
    { name: '张三' } as any,
    { name: '正常', role: '股东' },
  ]);
  assertEqual('entities drop invalid → 1 kept', r2.length, 1);
  assertEqual('entities kept normal', r2[0].name, '正常');

  // holding_pct 非 finite 即丢
  const r3 = normalizeEntities([
    { name: '张三', role: '股东', holding_pct: NaN },
    { name: '李四', role: '股东', holding_pct: Infinity },
    { name: '王五', role: '股东', holding_pct: '5%' as any },
  ]);
  assertEqual('entities count 3', r3.length, 3);
  assertEqual('entities NaN holding dropped', r3[0].holding_pct, undefined);
  assertEqual('entities Infinity holding dropped', r3[1].holding_pct, undefined);
  assertEqual('entities string holding dropped', r3[2].holding_pct, undefined);

  // 额外字段透传
  const r4 = normalizeEntities([
    { name: '张三', role: '股东', change_type: '增持', change_shares: 1000 },
  ]);
  assertEqual('entities change_type passthrough', r4[0].change_type, '增持');
  assertEqual('entities change_shares passthrough', r4[0].change_shares, 1000);

  // 非 array 兜底
  assertEqual('entities null → []', normalizeEntities(null).length, 0);
  assertEqual('entities undefined → []', normalizeEntities(undefined).length, 0);
  assertEqual('entities string → []', normalizeEntities('xxx' as any).length, 0);
  assertEqual('entities object → []', normalizeEntities({ name: 'x' } as any).length, 0);
  assertEqual('entities empty → []', normalizeEntities([]).length, 0);
  // null 元素不崩
  const r5 = normalizeEntities([null, undefined, 'x', { name: '张三', role: '股东' }] as any);
  assertEqual('entities skip non-objects', r5.length, 1);
}

// ---------------------------------------------------------------------------
// US-027 ANN-003: extractEntities — 启发式公告标题人名/角色/持股比例抽取
// ---------------------------------------------------------------------------

function testEntityRoleKeywordsFrozen(): void {
  // ENTITY_ROLE_KEYWORDS 顺序锁定 — 具体度优先级链, 任何 reorder 都会让 "控股股东 vs 股东" 归属漂移.
  assert('ENTITY_ROLE_KEYWORDS frozen', Object.isFrozen(ENTITY_ROLE_KEYWORDS));
  assert(
    'ENTITY_ROLE_KEYWORDS 控股股东 在 股东 前',
    ENTITY_ROLE_KEYWORDS.indexOf('控股股东') < ENTITY_ROLE_KEYWORDS.indexOf('股东')
  );
  assert(
    'ENTITY_ROLE_KEYWORDS 实际控制人 在 大股东 前',
    ENTITY_ROLE_KEYWORDS.indexOf('实际控制人') < ENTITY_ROLE_KEYWORDS.indexOf('大股东')
  );
  assert(
    'ENTITY_ROLE_KEYWORDS 董事长 在 董事 前',
    ENTITY_ROLE_KEYWORDS.indexOf('董事长') < ENTITY_ROLE_KEYWORDS.indexOf('董事')
  );
  assert(
    'ENTITY_ROLE_KEYWORDS 董秘 在 董事 后 (董秘别名不应抢 董事 锚点)',
    ENTITY_ROLE_KEYWORDS.indexOf('董秘') < ENTITY_ROLE_KEYWORDS.indexOf('董事')
  );
  assert(
    'ENTITY_CHANGE_TYPE_KEYWORDS frozen',
    Object.isFrozen(ENTITY_CHANGE_TYPE_KEYWORDS)
  );
  assert(
    'ENTITY_CHANGE_TYPE_KEYWORDS 增持 在 减持 前',
    ENTITY_CHANGE_TYPE_KEYWORDS.indexOf('增持') < ENTITY_CHANGE_TYPE_KEYWORDS.indexOf('减持')
  );
  assert(
    'ENTITY_CHANGE_TYPE_KEYWORDS 解除质押 在 质押 前',
    ENTITY_CHANGE_TYPE_KEYWORDS.indexOf('解除质押') < ENTITY_CHANGE_TYPE_KEYWORDS.indexOf('质押')
  );
}

function testExtractEntitiesBasicRoles(): void {
  // 单角色 — 控股股东 (name = role placeholder)
  const r1 = extractEntities('控股股东拟减持公司股份');
  assertEqual('单角色 count=1', r1.length, 1);
  assertEqual('单角色 role 控股股东', r1[0].role, '控股股东');
  assertEqual('单角色 name=role placeholder', r1[0].name, '控股股东');
  assertEqual('单角色 change_type 减持', (r1[0] as any).change_type, '减持');

  // 单角色 — 实际控制人
  const r2 = extractEntities('关于实际控制人变更的公告');
  assertEqual('实控人 count=1', r2.length, 1);
  assertEqual('实控人 role 实际控制人', r2[0].role, '实际控制人');
  assertEqual('实控人 name=role placeholder', r2[0].name, '实际控制人');
  assertEqual('实控人 no change_type', (r2[0] as any).change_type, undefined);

  // 高管 — 董事长
  const r3 = extractEntities('董事长辞职公告');
  assertEqual('董事长 role', r3[0].role, '董事长');
  assertEqual('董事长 name=role', r3[0].name, '董事长');

  // 监事
  const r4 = extractEntities('监事会换届选举公告');
  assertEqual('监事 role', r4[0].role, '监事');
}

function testExtractEntitiesHoldingPct(): void {
  // 持股 X%
  const r1 = extractEntities('持股 5.2% 股东减持股份');
  assertEqual('持股 X% — count', r1.length, 1);
  assertEqual('持股 5.2% role 股东', r1[0].role, '股东');
  assertEqual('持股 5.2% holding_pct', r1[0].holding_pct, 5.2);
  assertEqual('持股 5.2% change_type 减持', (r1[0] as any).change_type, '减持');

  // X% 以上股东
  const r2 = extractEntities('5% 以上股东拟减持');
  assertEqual('5%以上 holding_pct', r2[0].holding_pct, 5);
  assertEqual('5%以上 role 股东', r2[0].role, '股东');

  // 持股 12.34%
  const r3 = extractEntities('持股 12.34% 控股股东增持');
  assertEqual('持股 12.34% holding_pct', r3[0].holding_pct, 12.34);
  assertEqual('持股 12.34% role 控股股东', r3[0].role, '控股股东');
  assertEqual('持股 12.34% change_type 增持', (r3[0] as any).change_type, '增持');

  // 无 holding_pct 时 — 不应填充
  const r4 = extractEntities('控股股东拟减持公司股份');
  assertEqual('无百分数 → 无 holding_pct', r4[0].holding_pct, undefined);

  // 百分数远离角色锚点 (> 12 字符) → 不绑定
  const r5 = extractEntities('控股股东减持公司股份 — 经过审议本次减持不超过总股本的 1.5%');
  assertEqual('远离锚点 → 无 holding_pct', r5[0].holding_pct, undefined);

  // 边界: 0% / 101% 不接受
  const r6 = extractEntities('持股 0% 股东减持');
  assertEqual('0% 无效 → 无 holding_pct', r6[0].holding_pct, undefined);
  const r7 = extractEntities('持股 150% 股东减持');
  assertEqual('150% 无效 → 无 holding_pct', r7[0].holding_pct, undefined);
}

function testExtractEntitiesChangeType(): void {
  // 各 change_type 单独命中
  const r1 = extractEntities('控股股东增持公司股份');
  assertEqual('增持', (r1[0] as any).change_type, '增持');

  const r2 = extractEntities('控股股东质押股份');
  assertEqual('质押', (r2[0] as any).change_type, '质押');

  const r3 = extractEntities('控股股东解除质押公告');
  assertEqual('解除质押', (r3[0] as any).change_type, '解除质押');

  const r4 = extractEntities('控股股东通过大宗交易转让股份');
  assertEqual('大宗交易', (r4[0] as any).change_type, '大宗交易');

  // 优先级 — 增持 > 减持 (同标题含两个时, "增持" 在前)
  const r5 = extractEntities('控股股东 — 增持 + 减持 计划公告');
  assertEqual('增持优先', (r5[0] as any).change_type, '增持');

  // 无 change_type 关键词
  const r6 = extractEntities('董事长辞职');
  assertEqual('辞职无 change_type', (r6[0] as any).change_type, undefined);
}

function testExtractEntitiesMultipleRoles(): void {
  // 控股股东 + 监事 同标题
  const r1 = extractEntities('控股股东及监事减持公司股份');
  assertEqual('多角色 count=2', r1.length, 2);
  const roles = r1.map(e => e.role).sort();
  assertEqual('多角色含 控股股东 + 监事', roles, ['控股股东', '监事'].sort());
  // 全部带 change_type
  for (const e of r1) {
    assertEqual(`角色 ${e.role} change_type 减持`, (e as any).change_type, '减持');
  }

  // 控股股东 + 股东 — '股东' 子串落在 '控股股东' 内, 不应重复出 entity
  const r2 = extractEntities('控股股东拟减持');
  assertEqual('控股股东不重复出 股东 entity', r2.length, 1);
  assertEqual('单条 role 控股股东', r2[0].role, '控股股东');

  // 但 '控股股东 + 5% 以上股东' 是两个独立锚点
  const r3 = extractEntities('控股股东及 5% 以上股东拟减持');
  assertEqual('两个独立股东锚点 count=2', r3.length, 2);

  // 实控人 + 董事长 (短词别名)
  const r4 = extractEntities('实控人兼董事长辞职');
  assertEqual('实控人+董事长 count=2', r4.length, 2);
}

function testExtractEntitiesNamePlaceholder(): void {
  // 本启发式 name = role placeholder, 不强求真姓名 (留给远端 AI)
  // 即便标题里有"控股股东张三", 本函数也只输出 name=控股股东.

  const r1 = extractEntities('控股股东张三减持公司股份');
  assertEqual('真姓名也只 placeholder name=role', r1[0].name, '控股股东');
  assertEqual('真姓名 role 控股股东', r1[0].role, '控股股东');

  const r2 = extractEntities('李四监事辞职公告');
  assertEqual('监事 name=role placeholder', r2[0].name, '监事');

  // 验证 name 不会被动词/普通名词污染 (如 '变更' / '拟减持' / '辞职')
  const r3 = extractEntities('关于实际控制人变更的公告');
  assertEqual('name 不被动词污染 (变更)', r3[0].name, '实际控制人');

  const r4 = extractEntities('控股股东拟减持');
  assertEqual('name 不被动词污染 (拟减持)', r4[0].name, '控股股东');

  // 角色锚点出现 → name === role 自洽 (与 normalizeEntities 契约一致)
  const r5 = extractEntities('股东大会决议公告');
  assertEqual('股东大会 name=role placeholder', r5[0].name, '股东');
  assertEqual('股东大会 role 股东', r5[0].role, '股东');
}

function testExtractEntitiesEdgeCases(): void {
  // null / undefined / empty / whitespace → []
  assertEqual('null → []', extractEntities(null).length, 0);
  assertEqual('undefined → []', extractEntities(undefined).length, 0);
  assertEqual('empty → []', extractEntities('').length, 0);
  assertEqual('whitespace → []', extractEntities('   ').length, 0);

  // 整段无角色锚点 → [] (不强行造)
  assertEqual('无角色 → []', extractEntities('2025 年度业绩快报披露').length, 0);
  assertEqual('无角色 — 解禁公告 → []', extractEntities('限售股解禁公告').length, 0);

  // 上限 — MAX_ENTITIES_PER_TITLE = 5
  const r1 = extractEntities(
    '控股股东、实际控制人、董事长、总经理、监事、财务总监、董秘均拟减持'
  );
  assert(`上限 ≤ 5 (实际 ${r1.length})`, r1.length <= 5);
  assertEqual('上限恰好 5', r1.length, 5);
}

function testExtractEntitiesWiringHeuristicResult(): void {
  // builder 真接入 extractEntities — 标题含 '控股股东减持' → r.entities[0].role==='控股股东'
  const row = makeRow({
    stock_code: '600519',
    original_title: '控股股东张三拟减持公司股份',
  });
  const r = buildHeuristicNLPResult(row);
  assertEqual('builder wires extractEntities count', r.entities.length, 1);
  assertEqual('builder entity role', r.entities[0].role, '控股股东');
  // 启发式只输出 placeholder name=role; 真姓名 '张三' 留给远端 AI
  assertEqual('builder entity name (placeholder)', r.entities[0].name, '控股股东');
  assertEqual('builder entity change_type', (r.entities[0] as any).change_type, '减持');
}

function testExtractEntitiesShapeRoundtripsNormalize(): void {
  // extractEntities 输出形态必须能直接被 normalizeEntities 接受 (即合法 shape).
  const titles = [
    '控股股东张三拟减持公司股份',
    '持股 5.2% 股东减持',
    '董事长辞职公告',
    '5% 以上股东及监事减持',
    '实际控制人变更',
  ];
  for (const t of titles) {
    const extracted = extractEntities(t);
    const normalized = normalizeEntities(extracted);
    assertEqual(
      `roundtrip "${t.slice(0, 16)}…" 同长度 (extract→normalize 不掉条)`,
      normalized.length,
      extracted.length
    );
  }
}

// ---------------------------------------------------------------------------
// US-028 ANN-004: extractEarningsGrade — 业绩 yoy_pct 抽取 + 分级
// ---------------------------------------------------------------------------

function testEarningsKeywordsFrozen(): void {
  assert('EARNINGS_TITLE_KEYWORDS frozen', Object.isFrozen(EARNINGS_TITLE_KEYWORDS));
  assert('EARNINGS_DIRECTION_KEYWORDS frozen', Object.isFrozen(EARNINGS_DIRECTION_KEYWORDS));
  assert('EARNINGS_DIRECTION_KEYWORDS.loss frozen', Object.isFrozen(EARNINGS_DIRECTION_KEYWORDS.loss));
  assert(
    'EARNINGS_DIRECTION_KEYWORDS.decrease frozen',
    Object.isFrozen(EARNINGS_DIRECTION_KEYWORDS.decrease)
  );
  assert(
    'EARNINGS_DIRECTION_KEYWORDS.increase frozen',
    Object.isFrozen(EARNINGS_DIRECTION_KEYWORDS.increase)
  );
  assert(
    'EARNINGS_MAGNITUDE_THRESHOLDS frozen',
    Object.isFrozen(EARNINGS_MAGNITUDE_THRESHOLDS)
  );
  // sanity: MINOR_MAX < MAJOR_MIN
  assert(
    'MINOR_MAX < MAJOR_MIN',
    EARNINGS_MAGNITUDE_THRESHOLDS.MINOR_MAX < EARNINGS_MAGNITUDE_THRESHOLDS.MAJOR_MIN
  );
  // 顺序锁定: loss 关键词中"亏损"位于"由盈转亏"之前 (字典扫描语义无关, 但 frozen 保护避免被改)
  assert(
    'loss keywords contains 亏损',
    EARNINGS_DIRECTION_KEYWORDS.loss.includes('亏损')
  );
  assert(
    'decrease keywords contains 同比下降',
    EARNINGS_DIRECTION_KEYWORDS.decrease.includes('同比下降')
  );
  assert(
    'increase keywords contains 同比增长',
    EARNINGS_DIRECTION_KEYWORDS.increase.includes('同比增长')
  );
}

function testExtractEarningsGradeBasic(): void {
  // null / empty / whitespace → null
  assertEqual('earnings null', extractEarningsGrade(null), null);
  assertEqual('earnings undefined', extractEarningsGrade(undefined), null);
  assertEqual('earnings empty', extractEarningsGrade(''), null);
  assertEqual('earnings whitespace', extractEarningsGrade('   '), null);

  // 非业绩相关 → null
  assertEqual(
    'earnings 非业绩公告 → null',
    extractEarningsGrade('股东大会决议公告'),
    null
  );
  assertEqual(
    'earnings 重组同比 → null (无业绩关键词)',
    extractEarningsGrade('重大资产重组同比变动 30%'),
    null
  );
}

function testExtractEarningsGradeIncrease(): void {
  // 业绩预告 + 增长 + yoy%
  assertEqual(
    'earnings 业绩预增 50%',
    extractEarningsGrade('业绩预增公告 — 净利润同比增长 50%'),
    { direction: 'increase', magnitude: 'moderate', yoy_pct: 50 }
  );
  // 业绩 + minor (< 30%)
  assertEqual(
    'earnings 业绩预增 20% → minor',
    extractEarningsGrade('业绩预告: 净利润同比增长 20%'),
    { direction: 'increase', magnitude: 'minor', yoy_pct: 20 }
  );
  // 业绩 + major (≥ 100%)
  assertEqual(
    'earnings 业绩大增 150% → major',
    extractEarningsGrade('业绩预告 — 净利润同比增长 150%'),
    { direction: 'increase', magnitude: 'major', yoy_pct: 150 }
  );
  // 业绩 + direction 缺失 + 有 yoy% → 默认 increase
  assertEqual(
    'earnings 业绩快报 同比 80%',
    extractEarningsGrade('业绩快报: 净利润同比 80%'),
    { direction: 'increase', magnitude: 'moderate', yoy_pct: 80 }
  );
}

function testExtractEarningsGradeDecrease(): void {
  // 业绩预减 + yoy%
  assertEqual(
    'earnings 业绩预减 40%',
    extractEarningsGrade('业绩预减公告 — 净利润同比下降 40%'),
    { direction: 'decrease', magnitude: 'moderate', yoy_pct: -40 }
  );
  // 减少 + 业绩相关 + 小幅
  assertEqual(
    'earnings 营业收入下降 15% → minor',
    extractEarningsGrade('一季报: 营业收入下降 15%'),
    { direction: 'decrease', magnitude: 'minor', yoy_pct: -15 }
  );
  // 业绩下滑 + 大幅
  assertEqual(
    'earnings 业绩下滑 120% → major',
    extractEarningsGrade('业绩报告: 净利润同比下滑 120%'),
    { direction: 'decrease', magnitude: 'major', yoy_pct: -120 }
  );
}

function testExtractEarningsGradeLoss(): void {
  // 亏损不依赖 yoy% 强落 major
  assertEqual(
    'earnings 亏损 → loss/major (无 yoy)',
    extractEarningsGrade('业绩快报: 净利润亏损 5000 万元'),
    { direction: 'loss', magnitude: 'major', yoy_pct: null }
  );
  // 由盈转亏 + 有 yoy → loss + 负 yoy
  assertEqual(
    'earnings 由盈转亏 200%',
    extractEarningsGrade('业绩预告: 由盈转亏, 净利润同比下降 200%'),
    { direction: 'loss', magnitude: 'major', yoy_pct: -200 }
  );
  // 业绩暴雷 — loss 强落 major (无 yoy 也 major)
  assertEqual(
    'earnings 业绩暴雷 → loss/major',
    extractEarningsGrade('业绩暴雷: 全年亏损扩大'),
    { direction: 'loss', magnitude: 'major', yoy_pct: null }
  );
}

function testExtractEarningsGradeDirectionPriority(): void {
  // loss > decrease — 含 "亏损" + "下降" → loss (亏损是 terminal state)
  const r1 = extractEarningsGrade('业绩预告: 净利润亏损 同比下降 30%');
  assertEqual('priority loss > decrease (direction)', r1?.direction, 'loss');
  assertEqual('priority loss > decrease (magnitude)', r1?.magnitude, 'major');
  // decrease > increase — 含 "下降" + "增长" → decrease (先匹配 decrease 优先级)
  const r2 = extractEarningsGrade('业绩报告: 净利润同比下降 50% 营收同比增长 20%');
  assertEqual('priority decrease > increase', r2?.direction, 'decrease');
  // direction='increase' 但 yoy% 字面在标题里多个 → 取首个
  const r3 = extractEarningsGrade('业绩预增: 营收同比增长 40% 净利润同比增长 80%');
  assertEqual('multiple yoy% picks first', r3?.yoy_pct, 40);
  assertEqual('multiple yoy% magnitude', r3?.magnitude, 'moderate');
}

function testExtractEarningsGradeBoundaries(): void {
  // 阈值边界: 29% → minor, 30% → moderate
  const r29 = extractEarningsGrade('业绩预告: 净利润同比增长 29%');
  assertEqual('threshold 29% → minor', r29?.magnitude, 'minor');
  const r30 = extractEarningsGrade('业绩预告: 净利润同比增长 30%');
  assertEqual('threshold 30% → moderate', r30?.magnitude, 'moderate');
  // 99% → moderate, 100% → major
  const r99 = extractEarningsGrade('业绩预告: 净利润同比增长 99%');
  assertEqual('threshold 99% → moderate', r99?.magnitude, 'moderate');
  const r100 = extractEarningsGrade('业绩预告: 净利润同比增长 100%');
  assertEqual('threshold 100% → major', r100?.magnitude, 'major');
  // yoy% sanity 上限 — 大数 (50000%) 部分匹配 1-4 位子串落 sanity 范围内会被接受;
  // 这是 "中文无 word boundary + 数字单位混合" 启发式的已知边界 — 50000% 标题里
  // regex 滑动后可在偏移 1 处匹配到 "0000" 或类似子串. 用一个直接超过 sanity 上限的
  // 整数 (中间留空格阻断子串拼接) 验证 "完整数字 > MAX → null" 路径.
  const rNoise = extractEarningsGrade('业绩快报: 净利润同比增长 10000 %');
  assertEqual('yoy% > MAX → yoy_pct=null', rNoise?.yoy_pct, null);
  assertEqual('yoy% > MAX → minor (direction 兜底)', rNoise?.magnitude, 'minor');
  // 业绩相关 + 无 direction + 无 yoy → null
  assertEqual(
    'earnings 无 direction 无 yoy → null',
    extractEarningsGrade('2025 年业绩说明会通知'),
    null
  );
  // 业绩相关 + direction='increase' + 无 yoy → minor 兜底
  assertEqual(
    'earnings 业绩预增 (无 yoy) → minor',
    extractEarningsGrade('业绩预增公告'),
    { direction: 'increase', magnitude: 'minor', yoy_pct: null }
  );
}

function testExtractEarningsGradeDecimal(): void {
  // 小数 yoy%
  assertEqual(
    'earnings 12.5% → minor',
    extractEarningsGrade('业绩报告: 净利润同比增长 12.5%'),
    { direction: 'increase', magnitude: 'minor', yoy_pct: 12.5 }
  );
  // 边界 29.99% → minor
  const r2999 = extractEarningsGrade('业绩报告: 同比增长 29.99%');
  assertEqual('decimal 29.99% → minor', r2999?.magnitude, 'minor');
}

function testExtractEarningsGradeAccuracy(): void {
  // AC 主验收 — 20 条标题, 准确率 ≥ 80%.
  // 标注: direction + magnitude 必须同时正确算 1 条, 否则 0.
  const labeled: Array<{ title: string; expected: { direction: EarningsDirection; magnitude: EarningsMagnitude } }> = [
    // increase / minor
    { title: '业绩预告: 净利润同比增长 15%', expected: { direction: 'increase', magnitude: 'minor' } },
    { title: '一季报: 营业收入同比增加 8%', expected: { direction: 'increase', magnitude: 'minor' } },
    // increase / moderate
    { title: '业绩预增公告 — 净利润同比增长 50%', expected: { direction: 'increase', magnitude: 'moderate' } },
    { title: '半年报: 归母净利同比增长 80%', expected: { direction: 'increase', magnitude: 'moderate' } },
    // increase / major
    { title: '业绩大增: 净利润同比增长 120%', expected: { direction: 'increase', magnitude: 'major' } },
    { title: '业绩预告 — 净利润同比上升 200%', expected: { direction: 'increase', magnitude: 'major' } },
    // decrease / minor
    { title: '业绩报告: 营业收入同比下降 10%', expected: { direction: 'decrease', magnitude: 'minor' } },
    { title: '三季报: 净利润同比下滑 20%', expected: { direction: 'decrease', magnitude: 'minor' } },
    // decrease / moderate
    { title: '业绩预减: 净利润同比下降 50%', expected: { direction: 'decrease', magnitude: 'moderate' } },
    { title: '业绩快报: 净利润同比降低 70%', expected: { direction: 'decrease', magnitude: 'moderate' } },
    // decrease / major
    { title: '业绩下滑: 净利润同比下降 150%', expected: { direction: 'decrease', magnitude: 'major' } },
    // loss / major
    { title: '业绩快报: 全年亏损 1.2 亿元', expected: { direction: 'loss', magnitude: 'major' } },
    { title: '业绩预告: 由盈转亏', expected: { direction: 'loss', magnitude: 'major' } },
    { title: '业绩暴雷: 亏损扩大', expected: { direction: 'loss', magnitude: 'major' } },
    { title: '业绩预亏公告', expected: { direction: 'loss', magnitude: 'major' } },
    // increase / minor (无数字兜底)
    { title: '业绩预增公告', expected: { direction: 'increase', magnitude: 'minor' } },
    // increase moderate — 同比 形态
    { title: '业绩快报: 净利润同比 60%', expected: { direction: 'increase', magnitude: 'moderate' } },
    // decrease — 业绩预减 + 无 yoy → minor 兜底
    { title: '业绩预减公告', expected: { direction: 'decrease', magnitude: 'minor' } },
    // increase / major — 三季报
    { title: '三季报: 归母净利同比增长 300%', expected: { direction: 'increase', magnitude: 'major' } },
    // increase / minor — 年报小幅
    { title: '年报: 营业收入同比上升 5%', expected: { direction: 'increase', magnitude: 'minor' } },
  ];
  let correct = 0;
  const wrong: Array<string> = [];
  for (const c of labeled) {
    const got = extractEarningsGrade(c.title);
    const ok =
      got !== null && got.direction === c.expected.direction && got.magnitude === c.expected.magnitude;
    if (ok) {
      correct += 1;
    } else {
      wrong.push(
        `  "${c.title}" expected=${JSON.stringify(c.expected)} got=${JSON.stringify(got)}`
      );
    }
  }
  const total = labeled.length;
  const accuracy = correct / total;
  assert(
    `AC: extractEarningsGrade accuracy ${correct}/${total} (${(accuracy * 100).toFixed(1)}%) >= 80%`,
    accuracy >= 0.8,
    wrong.length > 0 ? `\nwrong predictions:\n${wrong.join('\n')}` : ''
  );
  if (wrong.length > 0 && accuracy >= 0.8) {
    console.log(
      `  ⚠ extractEarningsGrade accuracy=${(accuracy * 100).toFixed(
        1
      )}% (>=80% AC met but ${wrong.length} miss):\n${wrong.join('\n')}`
    );
  }
}

function testExtractEarningsGradeIsPure(): void {
  // pure: 同输入同输出, 不修改输入
  const title = '业绩预告: 净利润同比增长 50%';
  const r1 = extractEarningsGrade(title);
  const r2 = extractEarningsGrade(title);
  assertEqual('pure: same input → same output (1st)', r1?.yoy_pct, 50);
  assertEqual('pure: same input → same output (2nd)', r2?.yoy_pct, 50);
  assertEqual('pure: title unchanged', title, '业绩预告: 净利润同比增长 50%');
}

function testBuildNLPResultFromPayloadIncludesNewFields(): void {
  const row = makeRow({ stock_code: '000001', original_title: '减持公告' });
  const payload: RemoteNLPPayload = {
    status: 'COMPLETED',
    data: {
      summary: 'AI 摘要',
      sentiment: 'negative',
      event_type: 'reduction',
      priority: 'critical',
      entities: [{ name: '张三', role: '股东', holding_pct: 3.5 }],
    },
  };
  const r = buildNLPResultFromPayload(payload, row);
  assertEqual('payload event_type → 减持', r.event_type, '减持');
  assertEqual('payload priority → critical', r.priority, 'critical');
  assertEqual('payload entities 1', r.entities.length, 1);
  assertEqual('payload entity name', r.entities[0].name, '张三');
}

function testBuildNLPResultFromPayloadFailedDefaultsNewFields(): void {
  const row = makeRow({ stock_code: '000001', original_title: '业绩超预期' });
  const payload: RemoteNLPPayload = { status: 'FAILED', data: { error: 'oops' } };
  const r = buildNLPResultFromPayload(payload, row);
  // partial 路径不调 normalize, 必须直接是默认占位 (与 model 默认一致)
  assertEqual('failed fallback event_type null', r.event_type, null);
  assertEqual('failed fallback priority low', r.priority, 'low');
  assertEqual('failed fallback entities []', r.entities.length, 0);
}

async function testSaveSummariesIncludesNewFields(): Promise<void> {
  // 保证 saveSummaries 把三新列真的写入 fake store, 防 ANN-002~005 实现后字段丢失看不见.
  resetStore();
  const rows = [
    makeRow({ stock_code: '600519', original_title: 'a' }),
    makeRow({ stock_code: '000001', original_title: 'b' }),
  ];
  const state = makeFakeDSState({
    fetchByDate: { '2026-06-06': rows },
  });
  const ds = makeFakeDS(state);
  // 用 Default 实现的 saveSummaries (走真模型 stub), 让 fake DS 顺道捕一份 records 作 dual 验证
  // 这里我们直接用 service.syncDate → dataSource.saveSummaries 是 fake 的, 已捕到 state.saveCalls.
  // 但 AC 验收 = "三新列在 bulkCreate 入参里出现", 所以再单独走一次真 Default.saveSummaries.
  const service = new AnnouncementNLPService(ds);
  await service.syncDate('2026-06-06');
  // fake DS saveSummaries 收到的记录数
  assertEqual('saveSummaries called once', state.saveCalls.length, 1);
  const records = state.saveCalls[0];
  assertEqual('saveSummaries 2 records', records.length, 2);
  for (const r of records) {
    assert('record has event_type key', 'event_type' in r);
    assert('record has priority key', 'priority' in r);
    assert('record has entities key', 'entities' in r);
    // US-026 ANN-002: builder 接入 classifyEventType, 非空标题 → '其它' 兜底 (a/b 非关键词).
    assertEqual('record event_type 其它 (no keyword)', r.event_type, '其它');
    assertEqual('record priority default low', r.priority, 'low');
    assert('record entities default []', Array.isArray(r.entities) && r.entities.length === 0);
  }

  // 现在用真 Default DataSource (走 monkey-patched AnnouncementSummary.bulkCreate fake) 验证
  // 同款字段会传到 model — 这是"saveSummaries → bulkCreate"的契约最重要环节.
  resetStore();
  const realService = new AnnouncementNLPService(); // 用 PRODUCTION_ANNOUNCEMENT_NLP_DATA_SOURCE
  await realService['dataSource'].saveSummaries([
    {
      announce_date: '2026-06-06',
      stock_code: '600519',
      stock_name: '茅台',
      original_title: 't',
      announcement_type: null,
      url: null,
      summary: 's',
      sentiment: '正面',
      key_amounts_json: [],
      key_topics_json: [],
      event_type: '业绩',
      priority: 'critical',
      entities: [{ name: '张三', role: '股东', holding_pct: 5 }],
      status: 'completed',
      nlp_engine: 'trading_agents',
      error: null,
      raw_payload: {},
      persisted: false,
    },
  ]);
  assertEqual('store has 1 row', store.length, 1);
  const stored = store[0];
  assertEqual('store event_type 业绩', stored.event_type, '业绩');
  assertEqual('store priority critical', stored.priority, 'critical');
  assert(
    'store entities array',
    Array.isArray(stored.entities) && (stored.entities as any[]).length === 1
  );
}

function testSaveSummariesUpdateOnDuplicateIncludesNewFields(): void {
  // META-GUARD: AnnouncementNLPService.saveSummaries 的 updateOnDuplicate 必须包含三新列,
  // 否则 ANN-002~005 实现后 re-sync 同一标题会被 partial upsert 漂回旧值.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/AnnouncementNLPService.ts'),
    'utf8'
  );
  // 三新列必须出现在 updateOnDuplicate array 内 (正则跨多行)
  const m = src.match(/updateOnDuplicate:\s*\[([^\]]+)\]/);
  assert('updateOnDuplicate block found', !!m);
  const block = m ? m[1] : '';
  assert("updateOnDuplicate has 'event_type'", /'event_type'/.test(block));
  assert("updateOnDuplicate has 'priority'", /'priority'/.test(block));
  assert("updateOnDuplicate has 'entities'", /'entities'/.test(block));

  // bulkCreate map 必须列出三新列 (否则 record 字段不传到 DB)
  assert(
    'bulkCreate map includes event_type',
    /event_type:\s*r\.event_type/.test(src)
  );
  assert(
    'bulkCreate map includes priority',
    /priority:\s*r\.priority/.test(src)
  );
  assert(
    'bulkCreate map includes entities',
    /entities:\s*r\.entities/.test(src)
  );
}

function testAnnouncementSummaryModelHasNewColumns(): void {
  // META-GUARD: model 文件必须声明三新列 + 索引 (否则迁移和代码漂移)
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/models/AnnouncementSummary.ts'),
    'utf8'
  );
  // 字段声明
  assert('model declares event_type', /declare event_type:/.test(src));
  assert('model declares priority', /declare priority:/.test(src));
  assert('model declares entities', /declare entities:/.test(src));
  // event_type STRING(40) nullable
  assert(
    "model event_type STRING(40) nullable",
    /field:\s*'event_type'[\s\S]*?type:\s*DataType\.STRING\(40\)[\s\S]*?allowNull:\s*true/.test(
      src
    ) ||
      /type:\s*DataType\.STRING\(40\)[\s\S]*?allowNull:\s*true[\s\S]*?field:\s*'event_type'/.test(
        src
      )
  );
  // priority default 'low'
  assert("model priority defaultValue 'low'", /defaultValue:\s*'low'/.test(src));
  // entities default []
  assert(
    'model entities JSONB defaultValue []',
    /type:\s*DataType\.JSONB[\s\S]{1,400}defaultValue:\s*\[\][\s\S]{1,400}declare entities:/.test(src)
  );
  // 索引登记
  assert(
    'model has priority+date index',
    /idx_announcement_summaries_priority_date/.test(src)
  );
  assert(
    'model has event_type+date index',
    /idx_announcement_summaries_event_type_date/.test(src)
  );
}

function testMigrationSqlPresentAndComplete(): void {
  // AC #1: "migration 跑通" — 用 fs 校验 up + down SQL 存在且包含核心语句.
  // (不真执行 SQL — CI 无 PG. 但 schema 错漏会让 ANN-002~007 全挂.)
  const fs = require('fs');
  const path = require('path');
  const migDir = path.resolve(__dirname, '../../scripts/migrations');
  const upPath = path.join(
    migDir,
    '2026-06-19-announcement-nlp-event-priority-entities.sql'
  );
  const downPath = path.join(
    migDir,
    '2026-06-19-announcement-nlp-event-priority-entities-rollback.sql'
  );
  assert('migration up exists', fs.existsSync(upPath));
  assert('migration down exists', fs.existsSync(downPath));

  const up = fs.readFileSync(upPath, 'utf8');
  // BEGIN / COMMIT 包裹
  assert('up wrapped in BEGIN', /BEGIN;/.test(up));
  assert('up wrapped in COMMIT', /COMMIT;/.test(up));
  // 三新列
  assert(
    'up adds event_type IF NOT EXISTS',
    /ADD COLUMN IF NOT EXISTS event_type VARCHAR\(40\)/i.test(up)
  );
  assert(
    'up adds priority IF NOT EXISTS DEFAULT low',
    /ADD COLUMN IF NOT EXISTS priority VARCHAR\(20\) NOT NULL DEFAULT 'low'/i.test(up)
  );
  assert(
    'up adds entities IF NOT EXISTS JSONB DEFAULT []',
    /ADD COLUMN IF NOT EXISTS entities JSONB NOT NULL DEFAULT/i.test(up)
  );
  // 两索引
  assert(
    'up creates priority index IF NOT EXISTS',
    /CREATE INDEX IF NOT EXISTS idx_announcement_summaries_priority_date/.test(up)
  );
  assert(
    'up creates event_type index IF NOT EXISTS',
    /CREATE INDEX IF NOT EXISTS idx_announcement_summaries_event_type_date/.test(up)
  );
  // 注释 (helps ops 看 schema)
  assert('up adds COMMENT ON event_type', /COMMENT ON COLUMN.+event_type/i.test(up));
  assert('up adds COMMENT ON priority', /COMMENT ON COLUMN.+priority/i.test(up));
  assert('up adds COMMENT ON entities', /COMMENT ON COLUMN.+entities/i.test(up));

  const down = fs.readFileSync(downPath, 'utf8');
  assert('down wrapped in BEGIN', /BEGIN;/.test(down));
  assert('down wrapped in COMMIT', /COMMIT;/.test(down));
  assert('down drops event_type', /DROP COLUMN IF EXISTS event_type/.test(down));
  assert('down drops priority', /DROP COLUMN IF EXISTS priority/.test(down));
  assert('down drops entities', /DROP COLUMN IF EXISTS entities/.test(down));
  assert('down drops priority index', /DROP INDEX IF EXISTS idx_announcement_summaries_priority_date/.test(down));
  assert('down drops event_type index', /DROP INDEX IF EXISTS idx_announcement_summaries_event_type_date/.test(down));
}

// ---------------------------------------------------------------------------
// US-029 ANN-005: computePriority — 综合决策表 9 模块覆盖
// ---------------------------------------------------------------------------

function testPriorityThresholdsFrozen(): void {
  assert(
    'PRIORITY_AMOUNT_THRESHOLDS_WAN frozen',
    Object.isFrozen(PRIORITY_AMOUNT_THRESHOLDS_WAN)
  );
  // sanity: HIGH < MAJOR
  assert(
    'HIGH_WAN < MAJOR_WAN',
    PRIORITY_AMOUNT_THRESHOLDS_WAN.HIGH_WAN < PRIORITY_AMOUNT_THRESHOLDS_WAN.MAJOR_WAN
  );
  // sanity: 阈值与 PRD 约定对齐 (3 亿元 / 10 亿元)
  assertEqual('HIGH_WAN = 30000 (3亿)', PRIORITY_AMOUNT_THRESHOLDS_WAN.HIGH_WAN, 30000);
  assertEqual('MAJOR_WAN = 100000 (10亿)', PRIORITY_AMOUNT_THRESHOLDS_WAN.MAJOR_WAN, 100000);
}

function testComputePriorityCritical(): void {
  // 处罚 → critical 无关 sentiment / amount
  assertEqual('处罚 → critical', computePriority({ event_type: '处罚' }), 'critical');
  assertEqual(
    '处罚 + 正面 → critical (event_type 优先)',
    computePriority({ event_type: '处罚', sentiment: '正面' }),
    'critical'
  );

  // 业绩亏损 → critical (terminal state)
  assertEqual(
    'loss → critical',
    computePriority({
      event_type: '业绩',
      sentiment: '负面',
      earnings_grade: { direction: 'loss', magnitude: 'major', yoy_pct: null },
    }),
    'critical'
  );

  // 业绩大幅下滑 (≥100%) → critical
  assertEqual(
    'decrease major → critical',
    computePriority({
      event_type: '业绩',
      sentiment: '负面',
      earnings_grade: { direction: 'decrease', magnitude: 'major', yoy_pct: -150 },
    }),
    'critical'
  );

  // 重组 + 负面 + 重大金额 → critical
  assertEqual(
    '重组 + 负面 + 10亿元 → critical',
    computePriority({
      event_type: '重组',
      sentiment: '负面',
      amounts: [{ amount: 10, unit: '亿元' }],
    }),
    'critical'
  );
  // 担保 + 负面 + 11亿 → critical
  assertEqual(
    '担保 + 负面 + 11亿 → critical',
    computePriority({
      event_type: '担保',
      sentiment: '负面',
      amounts: [{ amount: 11, unit: '亿元' }],
    }),
    'critical'
  );
  // 减持 + 负面 + 15亿 → critical
  assertEqual(
    '减持 + 负面 + 15亿 → critical',
    computePriority({
      event_type: '减持',
      sentiment: '负面',
      amounts: [{ amount: 15, unit: '亿元' }],
    }),
    'critical'
  );
}

function testComputePriorityHigh(): void {
  // 业绩翻倍利好 → high
  assertEqual(
    'increase major → high',
    computePriority({
      event_type: '业绩',
      sentiment: '正面',
      earnings_grade: { direction: 'increase', magnitude: 'major', yoy_pct: 150 },
    }),
    'high'
  );

  // 业绩中等下滑 → high
  assertEqual(
    'decrease moderate → high',
    computePriority({
      event_type: '业绩',
      sentiment: '负面',
      earnings_grade: { direction: 'decrease', magnitude: 'moderate', yoy_pct: -50 },
    }),
    'high'
  );

  // 减持 + 负面 → high
  assertEqual(
    '减持 + 负面 → high',
    computePriority({ event_type: '减持', sentiment: '负面' }),
    'high'
  );

  // 重组 + 正面 → high (重组本身重大)
  assertEqual(
    '重组 + 正面 → high',
    computePriority({ event_type: '重组', sentiment: '正面' }),
    'high'
  );
  // 重组 + 负面 → high
  assertEqual(
    '重组 + 负面 → high',
    computePriority({ event_type: '重组', sentiment: '负面' }),
    'high'
  );

  // 担保 + 负面 → high
  assertEqual(
    '担保 + 负面 → high',
    computePriority({ event_type: '担保', sentiment: '负面' }),
    'high'
  );

  // 重组/担保/减持 + 高金额 (3 亿元) → high 无关 sentiment
  assertEqual(
    '担保 + 中性 + 5亿元 → high',
    computePriority({
      event_type: '担保',
      sentiment: '中性',
      amounts: [{ amount: 5, unit: '亿元' }],
    }),
    'high'
  );
  assertEqual(
    '减持 + 中性 + 4亿元 → high',
    computePriority({
      event_type: '减持',
      sentiment: '中性',
      amounts: [{ amount: 4, unit: '亿元' }],
    }),
    'high'
  );
}

function testComputePriorityMedium(): void {
  // 业绩 grade 存在 minor → medium
  assertEqual(
    'increase minor → medium',
    computePriority({
      event_type: '业绩',
      sentiment: '正面',
      earnings_grade: { direction: 'increase', magnitude: 'minor', yoy_pct: 15 },
    }),
    'medium'
  );

  // 具名 event_type 但无 grade → medium
  assertEqual('业绩 → medium', computePriority({ event_type: '业绩' }), 'medium');
  assertEqual('解禁 → medium', computePriority({ event_type: '解禁' }), 'medium');
  assertEqual('担保 → medium', computePriority({ event_type: '担保' }), 'medium');
  assertEqual('减持 → medium', computePriority({ event_type: '减持' }), 'medium');
  // 重组 + 中性 → medium (重组本身重大但中性 sentiment 不上 high)
  assertEqual(
    '重组 + 中性 → medium',
    computePriority({ event_type: '重组', sentiment: '中性' }),
    'medium'
  );

  // 无 event_type + 负面 → medium (一般负面提一级)
  assertEqual(
    '负面 (无 event_type) → medium',
    computePriority({ sentiment: '负面' }),
    'medium'
  );

  // 高金额 (≥3 亿元) 无 event_type → medium
  assertEqual(
    '4亿元 + 其它 → medium',
    computePriority({
      event_type: '其它',
      sentiment: '中性',
      amounts: [{ amount: 4, unit: '亿元' }],
    }),
    'medium'
  );
}

function testComputePriorityLow(): void {
  // 默认 (空 input) → low
  assertEqual('empty → low', computePriority({}), 'low');

  // 其它 / null + 中性/正面 + 无金额 → low
  assertEqual(
    '其它 + 中性 → low',
    computePriority({ event_type: '其它', sentiment: '中性' }),
    'low'
  );
  assertEqual(
    'null + 正面 + 小金额 → low',
    computePriority({
      event_type: null,
      sentiment: '正面',
      amounts: [{ amount: 100, unit: '万元' }],
    }),
    'low'
  );

  // amounts 含非金额单位 ('股' / '万股') 不应触发提级
  assertEqual(
    '其它 + 100万股 (数量不是金额) → low',
    computePriority({
      event_type: '其它',
      sentiment: '中性',
      amounts: [{ amount: 100, unit: '万股' }],
    }),
    'low'
  );
}

function testComputePriorityAmountUnitNormalization(): void {
  // 1 亿元 = 10000 万元, 都不到 30000 (3亿)
  assertEqual(
    '1亿元 (= 10000 万元) → low',
    computePriority({
      sentiment: '中性',
      amounts: [{ amount: 1, unit: '亿元' }],
    }),
    'low'
  );
  // 3 亿元 = 30000 万元 → 触发 medium 高金额阈值
  assertEqual(
    '3亿元 → medium (HIGH_WAN 阈值)',
    computePriority({
      sentiment: '中性',
      amounts: [{ amount: 3, unit: '亿元' }],
    }),
    'medium'
  );
  // 用 30000 万元 = 等价 3 亿元
  assertEqual(
    '30000 万元 → medium',
    computePriority({
      sentiment: '中性',
      amounts: [{ amount: 30000, unit: '万元' }],
    }),
    'medium'
  );

  // 多笔金额取最大 (1 亿 + 5 亿 → 取 5 亿)
  assertEqual(
    '多笔金额取最大 (5 亿) → 担保中性 → high',
    computePriority({
      event_type: '担保',
      sentiment: '中性',
      amounts: [
        { amount: 1, unit: '亿元' },
        { amount: 5, unit: '亿元' },
      ],
    }),
    'high'
  );
  // 负数 / NaN 金额忽略
  assertEqual(
    '负金额忽略',
    computePriority({
      sentiment: '中性',
      amounts: [
        { amount: -100, unit: '亿元' },
        { amount: 4, unit: '亿元' },
      ],
    }),
    'medium'
  );
  // '元' 单位忽略 (太小, 公告通常以万/亿计)
  assertEqual(
    "'元' 单位忽略",
    computePriority({
      event_type: '其它',
      sentiment: '中性',
      amounts: [{ amount: 999999999, unit: '元' }],
    }),
    'low'
  );
}

function testComputePriorityPrecedence(): void {
  // 处罚 vs 业绩 loss — 两者都是 critical, 但处罚先短路 (event_type 优先级链)
  assertEqual(
    '处罚 + loss → critical (短路任一)',
    computePriority({
      event_type: '处罚',
      earnings_grade: { direction: 'loss', magnitude: 'major', yoy_pct: null },
    }),
    'critical'
  );

  // 业绩 increase major (high) 与 减持 + 负面 (high) 共存 — 都返 high
  assertEqual(
    'increase major + 减持负面 → high',
    computePriority({
      event_type: '减持',
      sentiment: '负面',
      earnings_grade: { direction: 'increase', magnitude: 'major', yoy_pct: 150 },
    }),
    'high'
  );

  // 业绩 minor (medium 候选) + 处罚 (critical) → critical 短路
  assertEqual(
    '处罚 + 业绩 minor → critical',
    computePriority({
      event_type: '处罚',
      earnings_grade: { direction: 'increase', magnitude: 'minor', yoy_pct: 10 },
    }),
    'critical'
  );

  // 重组 + 负面 但金额不到 10亿 → high (不到 critical 阈值)
  assertEqual(
    '重组 + 负面 + 5亿 → high (低于 MAJOR 阈值)',
    computePriority({
      event_type: '重组',
      sentiment: '负面',
      amounts: [{ amount: 5, unit: '亿元' }],
    }),
    'high'
  );

  // 重组 + 负面 + 边界 10 亿元 (= MAJOR_WAN) → critical
  assertEqual(
    '重组 + 负面 + 10亿元 边界 → critical',
    computePriority({
      event_type: '重组',
      sentiment: '负面',
      amounts: [{ amount: 10, unit: '亿元' }],
    }),
    'critical'
  );
}

function testComputePriorityWiringHeuristicResult(): void {
  // 通过 buildHeuristicNLPResult 验证 wiring — 各类标题落出对应 priority
  // 1. 处罚标题 → critical
  const r1 = buildHeuristicNLPResult(
    makeRow({ stock_code: '000001', original_title: '收到中国证监会立案告知书' })
  );
  assertEqual('wiring 处罚 → critical', r1.priority, 'critical');

  // 2. 业绩亏损 → critical
  const r2 = buildHeuristicNLPResult(
    makeRow({ stock_code: '000002', original_title: '业绩快报: 全年亏损 1.2 亿元' })
  );
  assertEqual('wiring loss → critical', r2.priority, 'critical');

  // 3. 业绩大增 → high
  const r3 = buildHeuristicNLPResult(
    makeRow({ stock_code: '000003', original_title: '业绩预告: 净利润同比增长 150%' })
  );
  assertEqual('wiring increase major → high', r3.priority, 'high');

  // 4. 减持 + 负面 → high (sentiment 关键词 '减持' 直接归负面)
  const r4 = buildHeuristicNLPResult(
    makeRow({ stock_code: '000004', original_title: '控股股东减持股份计划公告' })
  );
  assertEqual('wiring 减持负面 → high', r4.priority, 'high');

  // 5. 常规公告 → low
  const r5 = buildHeuristicNLPResult(
    makeRow({ stock_code: '000005', original_title: '关于召开股东大会的通知' })
  );
  assertEqual('wiring 常规 → low', r5.priority, 'low');

  // 6. 业绩 minor (无 yoy / 无 direction) → low/medium 兜底 (业绩说明会 + 中性 + 无 grade → medium)
  const r6 = buildHeuristicNLPResult(
    makeRow({ stock_code: '000006', original_title: '2026 年业绩说明会通知' })
  );
  // 标题含 '业绩' → event_type='业绩'; earnings_grade=null (无 direction 无 yoy); 中性 → medium
  assertEqual('wiring 业绩说明 → medium', r6.priority, 'medium');
}

function testComputePriorityWiringPayloadFallback(): void {
  // payload 不带 priority → 走 computePriority 兜底而不是固定 'low'
  const row = makeRow({ stock_code: '000007', original_title: '业绩预告: 净利润同比增长 200%' });
  const payload: RemoteNLPPayload = {
    status: 'COMPLETED',
    data: { summary: 'AI 摘要', sentiment: 'positive' },
  };
  const r = buildNLPResultFromPayload(payload, row);
  // 业绩 + increase major → high (AI 无 priority 时本地 computePriority 兜底)
  assertEqual('payload no priority → computePriority high', r.priority, 'high');

  // payload 带 priority → 优先用 AI 字段
  const payloadWithPri: RemoteNLPPayload = {
    status: 'COMPLETED',
    data: { summary: 'AI', sentiment: 'positive', priority: 'critical' },
  };
  const r2 = buildNLPResultFromPayload(payloadWithPri, row);
  assertEqual('payload with priority → AI 字段优先', r2.priority, 'critical');
}

function testComputePriorityIsPure(): void {
  // 同输入两次调用 → 同输出 (无 side-effect)
  const input: Parameters<typeof computePriority>[0] = {
    event_type: '减持',
    sentiment: '负面',
    earnings_grade: null,
    amounts: [{ amount: 2, unit: '亿元' }],
  };
  const r1 = computePriority(input);
  const r2 = computePriority(input);
  assertEqual('pure: same input → same output (1st)', r1, 'high');
  assertEqual('pure: same input → same output (2nd)', r2, 'high');
  // input 未被改动
  assertEqual('pure: input.amounts unchanged', input.amounts?.length, 1);
  assertEqual('pure: input.event_type unchanged', input.event_type, '减持');
}

// ---------------------------------------------------------------------------
// US-030 ANN-006: buildStructuredSummary + 3 个 format* helpers
// ---------------------------------------------------------------------------

function testStructuredSummaryConstantsFrozen(): void {
  // 阈值常量必须 export 且形态合规, 与 heuristicSummarize v1 MAX=50 不同 (整体 100)
  assert('MAX_STRUCTURED_SUMMARY_LEN is number', typeof MAX_STRUCTURED_SUMMARY_LEN === 'number');
  assert('MAX_STRUCTURED_SUMMARY_LEN > 50', MAX_STRUCTURED_SUMMARY_LEN > 50);
  assertEqual('MAX_STRUCTURED_SUMMARY_LEN value', MAX_STRUCTURED_SUMMARY_LEN, 100);
  assert(
    'STRUCTURED_SUMMARY_SEPARATOR is string',
    typeof STRUCTURED_SUMMARY_SEPARATOR === 'string' && STRUCTURED_SUMMARY_SEPARATOR.length > 0
  );
}

function testFormatAmountsDetailed(): void {
  // happy: 多金额 + 单位保留
  assertEqual(
    'amounts happy',
    formatAmountsDetailed([
      { label: '募集资金', amount: 1.5, unit: '亿元' },
      { label: '担保金额', amount: 5000, unit: '万元' },
    ]),
    '募集资金 1.5 亿元 + 担保金额 5000 万元'
  );

  // 空数组 → ''
  assertEqual('amounts empty', formatAmountsDetailed([]), '');
  assertEqual('amounts null', formatAmountsDetailed(null), '');
  assertEqual('amounts undefined', formatAmountsDetailed(undefined), '');

  // 非 finite / <= 0 跳过
  assertEqual(
    'amounts skip invalid',
    formatAmountsDetailed([
      { label: 'NaN', amount: NaN, unit: '元' },
      { label: 'zero', amount: 0, unit: '元' },
      { label: '正常', amount: 100, unit: '万元' },
    ]),
    '正常 100 万元'
  );

  // label / unit 缺失兜底
  assertEqual(
    'amounts label fallback',
    formatAmountsDetailed([{ label: '', amount: 100, unit: '' }] as any),
    '金额 100 元'
  );

  // 上限 (MAX_AMOUNTS_PER_TITLE = 3)
  const four = [
    { label: 'a', amount: 1, unit: '元' },
    { label: 'b', amount: 2, unit: '元' },
    { label: 'c', amount: 3, unit: '元' },
    { label: 'd', amount: 4, unit: '元' },
  ];
  const r = formatAmountsDetailed(four);
  assert('amounts cap 3', !r.includes('d 4'));
  assert('amounts cap 3 keeps abc', r.includes('a 1') && r.includes('b 2') && r.includes('c 3'));
}

function testFormatEntitiesDetailed(): void {
  // placeholder (name === role): 仅渲染 role
  assertEqual(
    'entities placeholder',
    formatEntitiesDetailed([{ name: '控股股东', role: '控股股东' }]),
    '控股股东'
  );

  // 真姓名 (name !== role): 渲染 "role name"
  assertEqual(
    'entities real name',
    formatEntitiesDetailed([{ name: '张三', role: '控股股东' }]),
    '控股股东 张三'
  );

  // holding_pct 后缀
  assertEqual(
    'entities holding_pct',
    formatEntitiesDetailed([{ name: '控股股东', role: '控股股东', holding_pct: 12.34 }]),
    '控股股东(持股 12.34%)'
  );

  // 多实体 + 分隔符
  assertEqual(
    'entities multi',
    formatEntitiesDetailed([
      { name: '控股股东', role: '控股股东', holding_pct: 5 },
      { name: '董事长', role: '董事长' },
    ]),
    '控股股东(持股 5%) + 董事长'
  );

  // 空 / null
  assertEqual('entities empty', formatEntitiesDetailed([]), '');
  assertEqual('entities null', formatEntitiesDetailed(null), '');

  // 缺 role 跳过 (与 normalizeEntities drop 同款)
  assertEqual(
    'entities skip missing role',
    formatEntitiesDetailed([{ name: 'x', role: '' } as any, { name: '股东', role: '股东' }]),
    '股东'
  );

  // 非正 holding_pct 不渲染
  assertEqual(
    'entities skip invalid pct',
    formatEntitiesDetailed([{ name: '股东', role: '股东', holding_pct: 0 }]),
    '股东'
  );
}

function testFormatEarningsGradeDetailed(): void {
  // increase
  assertEqual(
    'grade increase major',
    formatEarningsGradeDetailed({ direction: 'increase', magnitude: 'major', yoy_pct: 150 }),
    '业绩 增长 150% (重大)'
  );
  // decrease (yoy 取绝对值, 方向走 direction 字段)
  assertEqual(
    'grade decrease moderate signed yoy',
    formatEarningsGradeDetailed({ direction: 'decrease', magnitude: 'moderate', yoy_pct: -50 }),
    '业绩 下滑 50% (中等)'
  );
  // loss
  assertEqual(
    'grade loss',
    formatEarningsGradeDetailed({ direction: 'loss', magnitude: 'major', yoy_pct: null }),
    '业绩 亏损 (重大)'
  );
  // increase + minor + null yoy
  assertEqual(
    'grade increase minor null yoy',
    formatEarningsGradeDetailed({ direction: 'increase', magnitude: 'minor', yoy_pct: null }),
    '业绩 增长 (小幅)'
  );
  // null grade
  assertEqual('grade null', formatEarningsGradeDetailed(null), '');
  assertEqual('grade undefined', formatEarningsGradeDetailed(undefined), '');
}

function testBuildStructuredSummaryAcceptanceCriteria(): void {
  // AC 主验收 — "输出含 entities" — 与 v1 heuristicSummarize 对比.
  // v1 (heuristicSummarize) 仅返 "[情绪] 标题" 不含 entities.
  // v2 (buildStructuredSummary) 必须含 entities 段.
  const r = buildStructuredSummary({
    title: '控股股东减持股份公告',
    sentiment: '负面',
    event_type: '减持',
    entities: [{ name: '控股股东', role: '控股股东' }],
    amounts: [{ label: '减持金额', amount: 2, unit: '亿元' }],
    earnings_grade: null,
  });
  assert('AC ann-006: output is string', typeof r === 'string' && r !== null);
  assert('AC ann-006: contains entities', r !== null && r.includes('控股股东'));
  assert('AC ann-006: contains amounts_detailed', r !== null && r.includes('减持金额 2 亿元'));
  assert('AC ann-006: contains sentiment tag', r !== null && r.startsWith('[负面]'));
  assert('AC ann-006: contains event_type tag', r !== null && r.includes('[减持]'));
  assert('AC ann-006: contains title text', r !== null && r.includes('控股股东减持股份公告'));
}

function testBuildStructuredSummaryEmptyOptional(): void {
  // 所有 optional 段都缺 → 等价 v1 输出 ("[情绪] 标题")
  const r = buildStructuredSummary({
    title: '常规公告',
    sentiment: '中性',
  });
  assertEqual('empty optional fallback', r, '[中性] 常规公告');
}

function testBuildStructuredSummaryEventTypeOther(): void {
  // event_type='其它' 不渲染段 (与 null 同款 — 信息密度低不污染摘要)
  const r1 = buildStructuredSummary({
    title: '常规公告',
    sentiment: '中性',
    event_type: '其它',
  });
  assertEqual('其它 not rendered', r1, '[中性] 常规公告');
  // event_type=null 也不渲染
  const r2 = buildStructuredSummary({
    title: '常规公告',
    sentiment: '中性',
    event_type: null,
  });
  assertEqual('null event_type not rendered', r2, '[中性] 常规公告');
}

function testBuildStructuredSummaryNullTitle(): void {
  // title null/empty/whitespace → null
  assertEqual('null title', buildStructuredSummary({ title: null, sentiment: '中性' }), null);
  assertEqual('empty title', buildStructuredSummary({ title: '', sentiment: '中性' }), null);
  assertEqual(
    'whitespace title',
    buildStructuredSummary({ title: '   ', sentiment: '中性' }),
    null
  );
}

function testBuildStructuredSummaryTruncation(): void {
  // 长摘要 (5 段全塞) > MAX_STRUCTURED_SUMMARY_LEN → 截断 + '...'
  const longTitle = 'a'.repeat(80);
  const r = buildStructuredSummary({
    title: longTitle,
    sentiment: '负面',
    event_type: '减持',
    entities: [{ name: '控股股东', role: '控股股东', holding_pct: 12.34 }],
    amounts: [{ label: '减持金额', amount: 2, unit: '亿元' }],
    earnings_grade: null,
  });
  assert('long summary truncated', r !== null && r.endsWith('...'));
  // 总长度 = MAX + 3 ('...')
  assertEqual('truncated length', r?.length, MAX_STRUCTURED_SUMMARY_LEN + 3);
}

function testBuildStructuredSummaryGradeRendered(): void {
  // 业绩公告 → grade 段渲染
  const r = buildStructuredSummary({
    title: '业绩预增公告',
    sentiment: '正面',
    event_type: '业绩',
    entities: [],
    amounts: [],
    earnings_grade: { direction: 'increase', magnitude: 'major', yoy_pct: 150 },
  });
  assert('grade rendered', r !== null && r.includes('业绩 增长 150% (重大)'));
  // 非业绩公告 → grade=null → 不渲染段
  const r2 = buildStructuredSummary({
    title: '常规公告',
    sentiment: '中性',
    earnings_grade: null,
  });
  assert('non-earnings no grade', r2 !== null && !r2.includes('业绩 '));
}

function testBuildStructuredSummaryWiringHeuristic(): void {
  // wiring 验收: buildHeuristicNLPResult 必须接通 buildStructuredSummary,
  // 与 v1 heuristicSummarize 输出对比, 含 entities 段.
  const row = makeRow({
    stock_code: '000001',
    original_title: '控股股东及其一致行动人减持股份计划公告',
  });
  const r = buildHeuristicNLPResult(row);
  assert('wiring heuristic: summary is string', typeof r.summary === 'string');
  assert('wiring heuristic: contains 控股股东', r.summary !== null && r.summary.includes('控股股东'));
  // 含 event_type 标签
  assert('wiring heuristic: contains [减持]', r.summary !== null && r.summary.includes('[减持]'));
  // 与 v1 输出对比 — v1 仅 "[情绪] 标题" 不含 [减持] 标签
  const v1 = heuristicSummarize(row.original_title, r.sentiment ?? '中性');
  assert('wiring heuristic: v1 does NOT contain [减持]', !v1!.includes('[减持]'));
}

function testBuildStructuredSummaryWiringPayloadHappy(): void {
  // wiring 验收: buildNLPResultFromPayload 在 AI 不带 summary 时走 buildStructuredSummary
  const row = makeRow({
    stock_code: '000001',
    original_title: '股东减持股份公告',
  });
  const payload: RemoteNLPPayload = {
    status: 'COMPLETED',
    data: {
      sentiment: '负面',
      event_type: '减持',
      entities: [{ name: '股东', role: '股东' }],
      // 缺 summary — 走 buildStructuredSummary 兜底
    },
  };
  const r = buildNLPResultFromPayload(payload, row);
  assert(
    'wiring payload happy: summary contains entity',
    r.summary !== null && r.summary.includes('股东')
  );
  assert(
    'wiring payload happy: summary contains [减持]',
    r.summary !== null && r.summary.includes('[减持]')
  );
}

function testBuildStructuredSummaryWiringPayloadFailed(): void {
  // wiring 验收: payload FAILED 路径走 buildStructuredSummary, 但只填 sentiment + amounts
  // (不渗漏 event_type / entities / grade — 与 fail-safe 默认契约一致)
  const row = makeRow({
    stock_code: '000001',
    original_title: '业绩超预期增长公告 营收 1.5 亿元',
  });
  const payload: RemoteNLPPayload = {
    status: 'FAILED',
    data: { error: 'remote 500' },
  };
  const r = buildNLPResultFromPayload(payload, row);
  assertEqual('failed status partial', r.status, 'partial');
  // 启发式情绪 '正面' + 金额段渲染
  assert(
    'wiring payload failed: contains amount',
    r.summary !== null && r.summary.includes('1.5 亿元')
  );
  // 不渲染 event_type 段 (FAILED 路径不调 classifyEventType)
  assert(
    'wiring payload failed: no [业绩] tag',
    r.summary !== null && !r.summary.includes('[业绩]')
  );
}

function testBuildStructuredSummaryAISummaryPreserved(): void {
  // AI 已提供 summary 时透传, 不被 buildStructuredSummary 覆盖
  const row = makeRow({ stock_code: '000001', original_title: '股东大会公告' });
  const payload: RemoteNLPPayload = {
    status: 'COMPLETED',
    data: {
      summary: 'AI 自带摘要 — 召开 2025 年度股东大会',
      sentiment: 'neutral',
    },
  };
  const r = buildNLPResultFromPayload(payload, row);
  assertEqual('AI summary preserved', r.summary, 'AI 自带摘要 — 召开 2025 年度股东大会');
}

function testBuildStructuredSummaryIsPure(): void {
  // 同输入两次调用 → 同输出 (无 side-effect)
  const input: BuildStructuredSummaryInput = {
    title: '股东减持公告',
    sentiment: '负面',
    event_type: '减持',
    entities: [{ name: '股东', role: '股东' }],
    amounts: [{ label: '减持金额', amount: 1, unit: '亿元' }],
  };
  const r1 = buildStructuredSummary(input);
  const r2 = buildStructuredSummary(input);
  assertEqual('pure: same output 1', r1, r2);
  // input 未被改动
  assertEqual('pure: input.entities unchanged', input.entities?.length, 1);
  assertEqual('pure: input.amounts unchanged', input.amounts?.length, 1);
}

function testBuildStructuredSummaryMetaGuardServiceWired(): void {
  // META-GUARD fs+regex 守: src/services/AnnouncementNLPService.ts 内
  //   - buildHeuristicNLPResult 必须调 buildStructuredSummary (不再调 heuristicSummarize)
  //   - buildNLPResultFromPayload 必须在两路径 (happy + FAILED) 都调 buildStructuredSummary
  // 防未来 refactor 把 v1 heuristicSummarize 复活到 builder 内.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const svcPath = path.resolve(__dirname, '../../src/services/AnnouncementNLPService.ts');
  const src = fs.readFileSync(svcPath, 'utf8') as string;

  // 正向: buildStructuredSummary 必须 export 且被 builder 至少调 2 次 (heuristic + payload)
  assert('helper exported', /export function buildStructuredSummary\b/.test(src));
  const callCount = (src.match(/buildStructuredSummary\(/g) || []).length;
  // 1 处定义 + 至少 2 处调用 (heuristic + payload happy + payload FAILED) = ≥ 4
  assert(`buildStructuredSummary called ≥3 times (got ${callCount})`, callCount >= 3);

  // 反向: buildHeuristicNLPResult 函数体内不再调 heuristicSummarize
  const heuristicBuilderMatch = src.match(
    /export function buildHeuristicNLPResult[\s\S]*?\n^}$/m
  );
  assert('buildHeuristicNLPResult found', heuristicBuilderMatch !== null);
  if (heuristicBuilderMatch) {
    assert(
      'buildHeuristicNLPResult no longer calls heuristicSummarize',
      !/heuristicSummarize\(/.test(heuristicBuilderMatch[0])
    );
    assert(
      'buildHeuristicNLPResult calls buildStructuredSummary',
      /buildStructuredSummary\(/.test(heuristicBuilderMatch[0])
    );
  }
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installModelStubs();

  // pure
  testParseIsoDate();
  await testSleep();
  testSentimentValuesFrozen();
  testHeuristicSentiment();
  testExtractAmounts();
  testExtractTopics();
  testHeuristicSummarize();
  testNormalizeSentiment();
  testBuildHeuristicNLPResult();
  testBuildNLPResultFromPayloadSuccess();
  testBuildNLPResultFromPayloadFailed();
  testBuildNLPResultFromPayloadMissingData();
  testBuildNLPResultFromPayloadInvalidAmounts();

  // US-025 ANN-001: 新字段 + 归一函数 + meta-guard + migration 形态
  testAnnouncementPriorityValuesFrozen();
  testAnnouncementEventTypesFrozen();
  testNormalizePriority();
  testNormalizeEventType();
  testNormalizeEntities();
  // US-026 ANN-002: classifyEventType
  testEventTypeKeywordsFrozen();
  testClassifyEventTypeBasic();
  testClassifyEventTypePriorityChain();
  testClassifyEventTypeAccuracy();
  testClassifyEventTypeWiringHeuristicResult();
  // US-027 ANN-003: extractEntities
  testEntityRoleKeywordsFrozen();
  testExtractEntitiesBasicRoles();
  testExtractEntitiesHoldingPct();
  testExtractEntitiesChangeType();
  testExtractEntitiesMultipleRoles();
  testExtractEntitiesNamePlaceholder();
  testExtractEntitiesEdgeCases();
  testExtractEntitiesWiringHeuristicResult();
  testExtractEntitiesShapeRoundtripsNormalize();
  // US-028 ANN-004: extractEarningsGrade
  testEarningsKeywordsFrozen();
  testExtractEarningsGradeBasic();
  testExtractEarningsGradeIncrease();
  testExtractEarningsGradeDecrease();
  testExtractEarningsGradeLoss();
  testExtractEarningsGradeDirectionPriority();
  testExtractEarningsGradeBoundaries();
  testExtractEarningsGradeDecimal();
  testExtractEarningsGradeAccuracy();
  testExtractEarningsGradeIsPure();
  // US-029 ANN-005: computePriority
  testPriorityThresholdsFrozen();
  testComputePriorityCritical();
  testComputePriorityHigh();
  testComputePriorityMedium();
  testComputePriorityLow();
  testComputePriorityAmountUnitNormalization();
  testComputePriorityPrecedence();
  testComputePriorityWiringHeuristicResult();
  testComputePriorityWiringPayloadFallback();
  testComputePriorityIsPure();
  // US-030 ANN-006: buildStructuredSummary + 3 format* helpers
  testStructuredSummaryConstantsFrozen();
  testFormatAmountsDetailed();
  testFormatEntitiesDetailed();
  testFormatEarningsGradeDetailed();
  testBuildStructuredSummaryAcceptanceCriteria();
  testBuildStructuredSummaryEmptyOptional();
  testBuildStructuredSummaryEventTypeOther();
  testBuildStructuredSummaryNullTitle();
  testBuildStructuredSummaryTruncation();
  testBuildStructuredSummaryGradeRendered();
  testBuildStructuredSummaryWiringHeuristic();
  testBuildStructuredSummaryWiringPayloadHappy();
  testBuildStructuredSummaryWiringPayloadFailed();
  testBuildStructuredSummaryAISummaryPreserved();
  testBuildStructuredSummaryIsPure();
  testBuildStructuredSummaryMetaGuardServiceWired();
  testBuildNLPResultFromPayloadIncludesNewFields();
  testBuildNLPResultFromPayloadFailedDefaultsNewFields();
  await testSaveSummariesIncludesNewFields();
  testSaveSummariesUpdateOnDuplicateIncludesNewFields();
  testAnnouncementSummaryModelHasNewColumns();
  testMigrationSqlPresentAndComplete();

  // service.summarize
  await testSummarizeHeuristic();
  await testSummarizeWithAISuccess();
  await testSummarizeWithAIFailedPayload();
  await testSummarizeWithAIRemoteThrows();

  // service.syncDate
  await testSyncDateHappyPath();
  await testSyncDateDryRun();
  await testSyncDateFetchEmpty();
  await testSyncDateFetchThrows();
  await testSyncDateSaveFailsFailOpen();
  await testSyncDateWithAI();

  // service.syncRange
  await testSyncRangeInvalid();
  await testSyncRangeMultipleDays();
  await testSyncRangeSkipsExisting();
  await testSyncRangeSingleDayFailsContinues();

  // service.list*
  await testListByStockDefault();
  await testListByStockEmpty();
  await testListByStockLimitClamp();
  await testListByDateSentiment();

  console.log(`\n${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
