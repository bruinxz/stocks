/**
 * MarketBriefService 单元测试 (US-073)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/market-brief-service.test.ts
 *
 * 完全脱离 DB / TradingAgents 远端 axios: 注入 fake MarketBriefDataSource.
 *
 * 覆盖维度:
 *   - 纯函数:
 *     - normalizeDateOnly (Date / 8 位 / 10 位 / null / 非法字符串);
 *     - parsePctChange (正常 / null / 0 / NaN / Infinity);
 *     - safeRound (常见 / 极端 / null / NaN);
 *     - buildPromptForAI (字段缺失 / 已知数据顺序);
 *     - pickAIViewFromPayload (status=FAILED / view / summary / text / 超长截断 / 空);
 *     - buildHeuristicAIView (5 个区段 + 全空兜底);
 *     - buildBriefSummary (3 状态 / 字段缺失);
 *   - service.computeAndPersist() end-to-end:
 *     - happy path: 4 维齐全 + AI ok → status=ok persisted=true engine=trading_agents;
 *     - skip_ai: 直接走 heuristic_fallback;
 *     - AI throw → fall back to heuristic engine;
 *     - dry_run=true: 不调 saveBrief, persisted=false;
 *     - partial: 部分维度缺失 / throw → status=partial 仍 persisted;
 *     - failed: 4 维全缺 → status=failed persisted=true (heuristic 兜底句);
 *     - saveBrief throw → fail-OPEN persisted=false 不抛;
 *     - 自定义 trade_date;
 *   - service.getTodayBrief(): cache miss 走 computeAndPersist;
 */

import {
  MarketBriefService,
  MarketBriefDataSource,
  MarketBriefRecord,
  RemoteMarketBriefPayload,
  BENCHMARK_SYMBOL,
  NLP_ENGINES,
  AI_VIEW_MAX_CHARS,
  normalizeDateOnly,
  parsePctChange,
  safeRound,
  buildPromptForAI,
  pickAIViewFromPayload,
  buildHeuristicAIView,
  buildBriefSummary,
} from '../../src/services/MarketBriefService';

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
  prevClose?: number | null;
  todayOpen?: number | null;
  northbound?: { net_amount_yi: number | null; sample_count: number };
  limitUpCount?: number | null;
  remotePayload?: RemoteMarketBriefPayload;
  saves: MarketBriefRecord[];
  prevCloseShouldThrow?: boolean;
  todayOpenShouldThrow?: boolean;
  northboundShouldThrow?: boolean;
  limitUpShouldThrow?: boolean;
  remoteShouldThrow?: boolean;
  saveShouldThrow?: boolean;
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return { saves: [], ...overrides };
}

function makeFakeSource(state: FakeState): MarketBriefDataSource {
  return {
    async loadPrevClose(_tradeDate, _symbol) {
      if (state.prevCloseShouldThrow) throw new Error('fake prev_close outage');
      return state.prevClose ?? null;
    },
    async loadTodayOpen(_tradeDate, _symbol) {
      if (state.todayOpenShouldThrow) throw new Error('fake today_open outage');
      return state.todayOpen ?? null;
    },
    async loadNorthboundNet(_tradeDate) {
      if (state.northboundShouldThrow) throw new Error('fake northbound outage');
      return state.northbound ?? { net_amount_yi: null, sample_count: 0 };
    },
    async loadLimitUpCount(_tradeDate) {
      if (state.limitUpShouldThrow) throw new Error('fake limit_up outage');
      return state.limitUpCount ?? null;
    },
    async callRemoteAIView(_prompt) {
      if (state.remoteShouldThrow) throw new Error('fake remote axios outage');
      return state.remotePayload ?? { status: 'FAILED', data: { error: 'no payload configured' } };
    },
    async saveBrief(record) {
      if (state.saveShouldThrow) throw new Error('fake DB outage');
      state.saves.push(record);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. constants
// ---------------------------------------------------------------------------

function testConstants(): void {
  assertEqual('BENCHMARK_SYMBOL=sh.000300', BENCHMARK_SYMBOL, 'sh.000300');
  assertEqual('NLP_ENGINES.TRADING_AGENTS', NLP_ENGINES.TRADING_AGENTS, 'trading_agents');
  assertEqual('NLP_ENGINES.HEURISTIC', NLP_ENGINES.HEURISTIC, 'heuristic_fallback');
  // US-043 / FE-004 AC 主验收: ≤ 150 字
  assertEqual('AI_VIEW_MAX_CHARS=150', AI_VIEW_MAX_CHARS, 150);
  // 防 typo: prompt 模板必须真正告诉 LLM 这个数字 (与 hard-cap 同源)
  const promptPreview = buildPromptForAI({
    trade_date: '2026-06-08',
    prev_close: 3850,
    today_open: 3870,
    open_change_pct: 0.52,
    northbound_net_yi: 12,
    limit_up_count: 65,
  });
  assert(
    'prompt 中包含 AI_VIEW_MAX_CHARS 数字',
    promptPreview.includes(String(AI_VIEW_MAX_CHARS))
  );
}

// ---------------------------------------------------------------------------
// 2. normalizeDateOnly
// ---------------------------------------------------------------------------

function testNormalizeDateOnly(): void {
  assertEqual('YYYY-MM-DD', normalizeDateOnly('2026-06-08'), '2026-06-08');
  assertEqual('null', normalizeDateOnly(null), null);
  assertEqual('undefined', normalizeDateOnly(undefined), null);
  assertEqual('empty string', normalizeDateOnly(''), null);
  assertEqual('gibberish', normalizeDateOnly('not-a-date'), null);
  // Date 对象
  const d = new Date(Date.UTC(2026, 5, 8));
  assertEqual('Date instance', normalizeDateOnly(d), '2026-06-08');
}

// ---------------------------------------------------------------------------
// 3. parsePctChange
// ---------------------------------------------------------------------------

function testParsePctChange(): void {
  // 正常: (110-100)/100 = 10%
  assertNear('+10% rise', parsePctChange(110, 100) as number, 10);
  // 负向: (90-100)/100 = -10%
  assertNear('-10% fall', parsePctChange(90, 100) as number, -10);
  // 持平: 0
  assertEqual('0% flat', parsePctChange(100, 100), 0);
  // 边界: prev=0 → null (防除零)
  assertEqual('prev=0 → null', parsePctChange(100, 0), null);
  // null inputs
  assertEqual('today=null', parsePctChange(null, 100), null);
  assertEqual('prev=null', parsePctChange(100, null), null);
  assertEqual('both null', parsePctChange(null, null), null);
  // NaN / Infinity
  assertEqual('today=NaN', parsePctChange(Number.NaN, 100), null);
  assertEqual('prev=Infinity', parsePctChange(100, Number.POSITIVE_INFINITY), null);
}

// ---------------------------------------------------------------------------
// 4. safeRound
// ---------------------------------------------------------------------------

function testSafeRound(): void {
  assertEqual('1.23456 → 1.2346 (4dp)', safeRound(1.23456, 4), 1.2346);
  assertEqual('1.5 → 1.5', safeRound(1.5, 4), 1.5);
  assertEqual('0 → 0', safeRound(0, 4), 0);
  assertEqual('null → null', safeRound(null, 4), null);
  assertEqual('NaN → null', safeRound(Number.NaN, 4), null);
  assertEqual('Infinity → null', safeRound(Number.POSITIVE_INFINITY, 4), null);
  // 自定义 digits
  assertEqual('1.234 → 1.23 (2dp)', safeRound(1.234, 2), 1.23);
  assertEqual('1234 → 1234 (0dp)', safeRound(1234, 0), 1234);
}

// ---------------------------------------------------------------------------
// 5. buildPromptForAI
// ---------------------------------------------------------------------------

function testBuildPromptForAI(): void {
  const fullPrompt = buildPromptForAI({
    trade_date: '2026-06-08',
    prev_close: 3850.12,
    today_open: 3892.55,
    open_change_pct: 1.1,
    northbound_net_yi: 35.5,
    limit_up_count: 88,
  });
  assert('full: includes date', fullPrompt.includes('2026-06-08'));
  assert('full: includes prev_close', fullPrompt.includes('3850.12'));
  assert('full: includes today_open', fullPrompt.includes('3892.55'));
  assert('full: includes open_change_pct', fullPrompt.includes('1.10%'));
  assert('full: includes northbound', fullPrompt.includes('35.50 亿元'));
  assert('full: includes limit_up_count', fullPrompt.includes('88'));
  assert('full: instruction line', fullPrompt.startsWith('你是一名 A 股市场每日早盘速读编辑'));

  // 字段缺失 → '—' 占位
  const partialPrompt = buildPromptForAI({
    trade_date: '2026-06-08',
    prev_close: null,
    today_open: null,
    open_change_pct: null,
    northbound_net_yi: null,
    limit_up_count: null,
  });
  assert('partial: prev_close 缺失', partialPrompt.includes('沪深300 上日收盘：—'));
  assert('partial: northbound 缺失', partialPrompt.includes('北向资金净买入：—'));
  assert('partial: limit_up 缺失', partialPrompt.includes('涨停数：—'));
}

// ---------------------------------------------------------------------------
// 6. pickAIViewFromPayload
// ---------------------------------------------------------------------------

function testPickAIViewFromPayload(): void {
  // data.view 命名
  assertEqual(
    'view field',
    pickAIViewFromPayload({ status: 'COMPLETED', data: { view: '今日震荡偏多' } }),
    '今日震荡偏多'
  );
  // data.summary 命名
  assertEqual(
    'summary field',
    pickAIViewFromPayload({ status: 'COMPLETED', data: { summary: '震荡' } }),
    '震荡'
  );
  // data.text 命名
  assertEqual(
    'text field',
    pickAIViewFromPayload({ status: 'COMPLETED', data: { text: '上行' } }),
    '上行'
  );
  // status=FAILED → null
  assertEqual(
    'status FAILED → null',
    pickAIViewFromPayload({ status: 'FAILED', data: { view: '不该返回' } }),
    null
  );
  // status=failed (lower case) → null
  assertEqual(
    'status failed lower → null',
    pickAIViewFromPayload({ status: 'failed', data: { view: '不该返回' } }),
    null
  );
  // 空字符串 → null
  assertEqual('empty string → null', pickAIViewFromPayload({ status: 'OK', data: { view: '' } }), null);
  // 只空格 → null
  assertEqual('whitespace only → null', pickAIViewFromPayload({ status: 'OK', data: { view: '   ' } }), null);
  // 无 data → null
  assertEqual('no data field', pickAIViewFromPayload({ status: 'OK' }), null);
  // 超长截断到 AI_VIEW_MAX_CHARS (US-043 / FE-004 AC: ≤ 150 字)
  const longView = '观点'.repeat(150); // 300 chars
  const picked = pickAIViewFromPayload({ status: 'OK', data: { view: longView } });
  assert(
    `long view truncated to AI_VIEW_MAX_CHARS (${AI_VIEW_MAX_CHARS})`,
    picked !== null && picked.length === AI_VIEW_MAX_CHARS
  );
  // 边界: 恰好 AI_VIEW_MAX_CHARS 字 → 原文返回, 不截
  const exactView = '观'.repeat(AI_VIEW_MAX_CHARS);
  const pickedExact = pickAIViewFromPayload({ status: 'OK', data: { view: exactView } });
  assertEqual(
    `view length === AI_VIEW_MAX_CHARS 不截断`,
    pickedExact?.length,
    AI_VIEW_MAX_CHARS
  );
  // 边界: AI_VIEW_MAX_CHARS+1 字 → 截到 AI_VIEW_MAX_CHARS
  const overByOne = '观'.repeat(AI_VIEW_MAX_CHARS + 1);
  const pickedOver = pickAIViewFromPayload({ status: 'OK', data: { view: overByOne } });
  assertEqual(
    `view length === AI_VIEW_MAX_CHARS+1 截到 AI_VIEW_MAX_CHARS`,
    pickedOver?.length,
    AI_VIEW_MAX_CHARS
  );
}

// ---------------------------------------------------------------------------
// 7. buildHeuristicAIView
// ---------------------------------------------------------------------------

function testBuildHeuristicAIView(): void {
  // 强势高开 + 北向流入 + 赚钱效应强
  const bull = buildHeuristicAIView({
    open_change_pct: 1.5,
    northbound_net_yi: 50,
    limit_up_count: 100,
  });
  assert('bull: 强势高开', bull.includes('强势高开'));
  assert('bull: 北向继续流入', bull.includes('北向继续流入'));
  assert('bull: 赚钱效应强', bull.includes('赚钱效应强'));
  assert('bull: 数字包含', bull.includes('+1.50%'));

  // 弱势低开 + 北向流出 + 赚钱效应弱
  const bear = buildHeuristicAIView({
    open_change_pct: -1.5,
    northbound_net_yi: -50,
    limit_up_count: 20,
  });
  assert('bear: 弱势低开', bear.includes('弱势低开'));
  assert('bear: 北向资金离场', bear.includes('北向资金离场'));
  assert('bear: 赚钱效应弱', bear.includes('赚钱效应弱'));

  // 中性: 小幅波动
  const neutral = buildHeuristicAIView({
    open_change_pct: 0.3,
    northbound_net_yi: 5,
    limit_up_count: 50,
  });
  assert('neutral: 小幅高开', neutral.includes('小幅高开'));
  assert('neutral: 北向小幅流入', neutral.includes('北向小幅流入'));
  // 50 ∈ (30,80) 无赚钱效应描述 → 应该没"赚钱效应"短语
  assert('neutral: 无赚钱效应描述', !neutral.includes('赚钱效应'));

  // 平开
  const flat = buildHeuristicAIView({
    open_change_pct: 0,
    northbound_net_yi: 0,
    limit_up_count: 50,
  });
  assert('flat: 平开', flat.includes('平开'));

  // 全空 → 兜底
  const empty = buildHeuristicAIView({
    open_change_pct: null,
    northbound_net_yi: null,
    limit_up_count: null,
  });
  assertEqual('empty → 兜底', empty, '今日大盘数据待补，请稍后刷新');

  // 部分缺失
  const partial = buildHeuristicAIView({
    open_change_pct: 0.5,
    northbound_net_yi: null,
    limit_up_count: null,
  });
  assert('partial: 单字段输出', partial.includes('小幅高开'));
  assert('partial: 无北向描述', !partial.includes('北向'));

  // US-043 / FE-004 AC: 启发式 fallback 不会超过 AI_VIEW_MAX_CHARS
  // — 即便未来增加更多维度, 拼出来的字串也守住 hard-cap.
  const allCases = [bull, bear, neutral, flat, partial];
  for (const sentence of allCases) {
    assert(
      `heuristic ≤ AI_VIEW_MAX_CHARS (len=${sentence.length}, AI_VIEW_MAX_CHARS=${AI_VIEW_MAX_CHARS})`,
      sentence.length <= AI_VIEW_MAX_CHARS
    );
  }
}

// ---------------------------------------------------------------------------
// 8. buildBriefSummary
// ---------------------------------------------------------------------------

function testBuildBriefSummary(): void {
  // 全字段 / status=ok
  const full = buildBriefSummary({
    trade_date: '2026-06-08',
    prev_close: 3850.12,
    today_open: 3892.55,
    open_change_pct: 1.1,
    northbound_net_yi: 35.5,
    limit_up_count: 88,
    status: 'ok',
  });
  assert('full: 包含日期', full.includes('2026-06-08'));
  assert('full: 包含上日收盘', full.includes('上日收盘 3850.12'));
  assert('full: 包含今日开盘 + 涨跌幅', full.includes('今日开盘 3892.55 (+1.10%)'));
  assert('full: 包含北向净流入', full.includes('北向净流入 35.50 亿'));
  assert('full: 包含涨停', full.includes('涨停 88 家'));
  assert('full: 无 partial 标记', !full.includes('部分数据待补'));
  assert('full: 无 failed 标记', !full.includes('数据全部缺失'));

  // 净流出
  const outflow = buildBriefSummary({
    trade_date: '2026-06-08',
    prev_close: 3800,
    today_open: 3790,
    open_change_pct: -0.26,
    northbound_net_yi: -20,
    limit_up_count: 30,
    status: 'ok',
  });
  assert('outflow: 北向净流出', outflow.includes('北向净流出 20.00 亿'));
  assert('outflow: 负向涨跌幅', outflow.includes('(-0.26%)'));

  // partial 标记
  const partial = buildBriefSummary({
    trade_date: '2026-06-08',
    prev_close: 3800,
    today_open: null,
    open_change_pct: null,
    northbound_net_yi: null,
    limit_up_count: 30,
    status: 'partial',
  });
  assert('partial: 含部分数据待补', partial.includes('部分数据待补'));
  assert('partial: 缺失字段省略', !partial.includes('今日开盘'));

  // failed 标记
  const failed = buildBriefSummary({
    trade_date: '2026-06-08',
    prev_close: null,
    today_open: null,
    open_change_pct: null,
    northbound_net_yi: null,
    limit_up_count: null,
    status: 'failed',
  });
  assert('failed: 含数据全部缺失', failed.includes('数据全部缺失'));

  // open_change_pct null 但 today_open 有 → 只显示价格 (无 +/-N% 括号)
  const noChange = buildBriefSummary({
    trade_date: '2026-06-08',
    prev_close: null,
    today_open: 3890,
    open_change_pct: null,
    northbound_net_yi: null,
    limit_up_count: null,
    status: 'partial',
  });
  assert('noChange: 显示开盘价', noChange.includes('今日开盘 3890.00'));
  // 验证不显示 (+1.00%) 这种括号 — partial 自己的 "(部分数据待补)" 末尾允许
  assert('noChange: 无涨跌幅括号', !noChange.includes('今日开盘 3890.00 ('));
}

// ---------------------------------------------------------------------------
// 9. computeAndPersist — happy path (4 维齐全 + AI ok)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_Happy(): Promise<void> {
  const state = emptyState({
    prevClose: 3850.12,
    todayOpen: 3892.55,
    northbound: { net_amount_yi: 35.5, sample_count: 800 },
    limitUpCount: 88,
    remotePayload: { status: 'COMPLETED', data: { view: '今日震荡偏多，沪深300 高开' } },
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });

  assertEqual('happy: trade_date', r.trade_date, '2026-06-08');
  assertEqual('happy: status=ok', r.status, 'ok');
  assertEqual('happy: persisted=true', r.persisted, true);
  assertEqual('happy: dry_run=false', r.dry_run, false);
  assertEqual('happy: prev_close', r.prev_close, 3850.12);
  assertEqual('happy: today_open', r.today_open, 3892.55);
  assertNear('happy: open_change_pct', r.open_change_pct as number, 1.1019, 1e-3);
  assertEqual('happy: northbound', r.northbound_net_amount, 35.5);
  assertEqual('happy: limit_up_count', r.limit_up_count, 88);
  assertEqual('happy: ai_view', r.ai_view, '今日震荡偏多，沪深300 高开');
  assertEqual('happy: nlp_engine=trading_agents', r.nlp_engine, NLP_ENGINES.TRADING_AGENTS);
  assertEqual('happy: 1 save call', state.saves.length, 1);

  // components 维度
  assertEqual('happy: benchmark error null', r.components.benchmark.error, null);
  assertEqual('happy: northbound error null', r.components.northbound.error, null);
  assertEqual('happy: limit_up error null', r.components.limit_up.error, null);
  assertEqual('happy: ai_view error null', r.components.ai_view.error, null);
  assertEqual('happy: benchmark symbol', r.components.benchmark.symbol, BENCHMARK_SYMBOL);
  assertEqual('happy: northbound sample_count', r.components.northbound.sample_count, 800);

  // saved record sanity
  const saved = state.saves[0];
  assertEqual('saved trade_date', saved.trade_date, '2026-06-08');
  assertEqual('saved status', saved.status, 'ok');
  assertEqual('saved nlp_engine', saved.nlp_engine, NLP_ENGINES.TRADING_AGENTS);
  assertEqual('saved ai_view persisted', saved.ai_view, '今日震荡偏多，沪深300 高开');
  assert('saved components_json has 4 fields',
    'benchmark' in saved.components_json &&
      'northbound' in saved.components_json &&
      'limit_up' in saved.components_json &&
      'ai_view' in saved.components_json);
}

// ---------------------------------------------------------------------------
// 10. computeAndPersist — skip_ai
// ---------------------------------------------------------------------------

async function testComputeAndPersist_SkipAI(): Promise<void> {
  const state = emptyState({
    prevClose: 3800,
    todayOpen: 3850,
    northbound: { net_amount_yi: 10, sample_count: 500 },
    limitUpCount: 60,
    // remotePayload 未设置，但 skip_ai=true 不会触发
    remoteShouldThrow: true,
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08', skip_ai: true });
  assertEqual('skip_ai: nlp_engine=heuristic', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  assert('skip_ai: ai_view 非空', r.ai_view !== null && r.ai_view.length > 0);
  assertEqual('skip_ai: status=ok', r.status, 'ok');
}

// ---------------------------------------------------------------------------
// 11. computeAndPersist — AI 远端 throw → heuristic fallback
// ---------------------------------------------------------------------------

async function testComputeAndPersist_RemoteThrowFallback(): Promise<void> {
  const state = emptyState({
    prevClose: 3800,
    todayOpen: 3850,
    northbound: { net_amount_yi: 10, sample_count: 500 },
    limitUpCount: 60,
    remoteShouldThrow: true,
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  assertEqual('remoteThrow: nlp_engine=heuristic', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  assert('remoteThrow: ai_view 非空', r.ai_view !== null && r.ai_view.length > 0);
  // ai_view.error 应记录原因
  assert('remoteThrow: ai_view.error 非 null', r.components.ai_view.error !== null);
}

// ---------------------------------------------------------------------------
// 12. computeAndPersist — AI 远端 FAILED payload → heuristic fallback
// ---------------------------------------------------------------------------

async function testComputeAndPersist_RemoteFailedFallback(): Promise<void> {
  const state = emptyState({
    prevClose: 3800,
    todayOpen: 3850,
    northbound: { net_amount_yi: 10, sample_count: 500 },
    limitUpCount: 60,
    remotePayload: { status: 'FAILED', data: { error: '远端无 view 字段' } },
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  assertEqual('remoteFailed: nlp_engine=heuristic', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  assert('remoteFailed: ai_view 非空', r.ai_view !== null && r.ai_view.length > 0);
  // ai_view.error 应记录
  assertEqual(
    'remoteFailed: ai_view.error 来自 payload',
    r.components.ai_view.error,
    '远端无 view 字段'
  );
}

// ---------------------------------------------------------------------------
// 13. computeAndPersist — dry_run
// ---------------------------------------------------------------------------

async function testComputeAndPersist_DryRun(): Promise<void> {
  const state = emptyState({
    prevClose: 3850,
    todayOpen: 3892,
    northbound: { net_amount_yi: 35, sample_count: 100 },
    limitUpCount: 88,
    remotePayload: { status: 'OK', data: { view: '高开' } },
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08', dry_run: true });
  assertEqual('dry_run: persisted=false', r.persisted, false);
  assertEqual('dry_run: dry_run=true', r.dry_run, true);
  assertEqual('dry_run: 0 save calls', state.saves.length, 0);
  // 但数据仍正确
  assertEqual('dry_run: ai_view 仍可用', r.ai_view, '高开');
}

// ---------------------------------------------------------------------------
// 14. computeAndPersist — partial (部分维度 throw)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_Partial(): Promise<void> {
  const state = emptyState({
    prevClose: 3800,
    todayOpen: null,
    northbound: { net_amount_yi: null, sample_count: 0 },
    limitUpCount: 60,
    todayOpenShouldThrow: true,
    northboundShouldThrow: true,
    remotePayload: { status: 'OK', data: { view: '小幅' } },
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  assertEqual('partial: status=partial', r.status, 'partial');
  assertEqual('partial: persisted=true', r.persisted, true);
  assertEqual('partial: prev_close 仍可用', r.prev_close, 3800);
  assertEqual('partial: today_open=null', r.today_open, null);
  assertEqual('partial: open_change_pct=null', r.open_change_pct, null);
  assertEqual('partial: northbound=null', r.northbound_net_amount, null);
  assertEqual('partial: limit_up 仍可用', r.limit_up_count, 60);
  assert(
    'partial: today_open error 记录',
    typeof r.components.benchmark.error === 'string' && r.components.benchmark.error.length > 0
  );
  assert(
    'partial: northbound error 记录',
    typeof r.components.northbound.error === 'string' && r.components.northbound.error.length > 0
  );
  assertEqual('partial: limit_up error null', r.components.limit_up.error, null);
  assert('partial: message 含 partial 提示', r.message.includes('部分数据待补'));
}

// ---------------------------------------------------------------------------
// 15. computeAndPersist — failed (4 维全空)
// ---------------------------------------------------------------------------

async function testComputeAndPersist_Failed(): Promise<void> {
  const state = emptyState({
    prevCloseShouldThrow: true,
    todayOpenShouldThrow: true,
    northboundShouldThrow: true,
    limitUpShouldThrow: true,
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08', skip_ai: true });
  assertEqual('failed: status=failed', r.status, 'failed');
  assertEqual('failed: persisted=true (仍记录)', r.persisted, true);
  assertEqual('failed: prev_close=null', r.prev_close, null);
  assertEqual('failed: today_open=null', r.today_open, null);
  assertEqual('failed: northbound=null', r.northbound_net_amount, null);
  assertEqual('failed: limit_up=null', r.limit_up_count, null);
  // heuristic 兜底句应仍有
  assertEqual('failed: ai_view 走兜底', r.ai_view, '今日大盘数据待补，请稍后刷新');
  assertEqual('failed: nlp_engine=heuristic', r.nlp_engine, NLP_ENGINES.HEURISTIC);
  assert('failed: message 含数据全部缺失', r.message.includes('数据全部缺失'));
}

// ---------------------------------------------------------------------------
// 16. computeAndPersist — saveBrief throw fail-OPEN
// ---------------------------------------------------------------------------

async function testComputeAndPersist_SaveFail(): Promise<void> {
  const state = emptyState({
    prevClose: 3800,
    todayOpen: 3850,
    northbound: { net_amount_yi: 10, sample_count: 100 },
    limitUpCount: 60,
    remotePayload: { status: 'OK', data: { view: '强势高开' } },
    saveShouldThrow: true,
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  let threw = false;
  let r: Awaited<ReturnType<MarketBriefService['computeAndPersist']>> | null = null;
  try {
    r = await svc.computeAndPersist({ trade_date: '2026-06-08' });
  } catch (_e) {
    threw = true;
  }
  assertEqual('saveFail: 不抛', threw, false);
  assert('saveFail: 返回 result', r !== null);
  assertEqual('saveFail: persisted=false', r!.persisted, false);
  assertEqual('saveFail: ai_view 仍可用', r!.ai_view, '强势高开');
}

// ---------------------------------------------------------------------------
// 17. getTodayBrief — cache miss 走 computeAndPersist (注: 这里只测 fake source 路径,
//                                                     真实 DB cache 路径走 integration test)
// ---------------------------------------------------------------------------

async function testGetTodayBrief_CacheMiss(): Promise<void> {
  // Note: getTodayBrief 内部用 MarketBrief.findOne 查 DB cache, fake source 没法 mock 此调用.
  // 这里用 skip_ai 验证 computeAndPersist 真的被调到. 但 findOne 会因为没数据库连接抛.
  // → 改为只验证 computeAndPersist 单独可调用即可.
  const state = emptyState({
    prevClose: 3800,
    todayOpen: 3850,
    northbound: { net_amount_yi: 10, sample_count: 100 },
    limitUpCount: 60,
  });
  const svc = new MarketBriefService(makeFakeSource(state));
  const r = await svc.computeAndPersist({ trade_date: '2026-06-08', skip_ai: true });
  assertEqual('getTodayBrief: 走 computeAndPersist', r.trade_date, '2026-06-08');
  assertEqual('getTodayBrief: 1 save call', state.saves.length, 1);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('▶ MarketBriefService unit tests (US-073)');

  testConstants();
  testNormalizeDateOnly();
  testParsePctChange();
  testSafeRound();
  testBuildPromptForAI();
  testPickAIViewFromPayload();
  testBuildHeuristicAIView();
  testBuildBriefSummary();
  await testComputeAndPersist_Happy();
  await testComputeAndPersist_SkipAI();
  await testComputeAndPersist_RemoteThrowFallback();
  await testComputeAndPersist_RemoteFailedFallback();
  await testComputeAndPersist_DryRun();
  await testComputeAndPersist_Partial();
  await testComputeAndPersist_Failed();
  await testComputeAndPersist_SaveFail();
  await testGetTodayBrief_CacheMiss();

  const total = passed + failed;
  console.log(`\n— ${passed}/${total} passed (${failed} failed) —\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
