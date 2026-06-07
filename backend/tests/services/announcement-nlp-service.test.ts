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
  parseIsoDate,
  sleep,
  heuristicSentiment,
  extractAmounts,
  extractTopics,
  heuristicSummarize,
  normalizeSentiment,
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
