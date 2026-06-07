/**
 * EarningsForecastWatcher 单元测试 (US-064 飞书业绩预告即时提醒)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/earnings-forecast-watcher-service.test.ts
 *
 * 完全脱离 DB / 网络：注入 fake EarningsForecastWatcherDataSource。
 *
 * 覆盖维度（参考 daily-trading-digest-service.test.ts 模板）：
 *   - 常量冻结 (EARNINGS_FORECAST_STATUS / EARNINGS_FORECAST_PATH)
 *   - 纯函数：
 *     - normalizeEarningsForecastConfig（缺失 / 部分字段 / 静默退回 default）
 *     - shouldSendEarningsForUser（4 路径：未启用 / earnings_alert 关 / 缺 URL / 通过）
 *     - stripSymbolSuffix（'sh.600519' / '600519.SH' / '600519' / 数字 / 无后缀）
 *     - pickForecastsForHolders（空 / 子集 / 非持仓股过滤掉）
 *     - pickForecastsForWatchers（自选 - 持仓 / sort by is_surprise then forecast_type then code）
 *     - signatureForForecast（HELD / WATCHLIST 前缀不同 / 同 PK 同签名）
 *     - mergeSeenForecastSignatures（FIFO LRU / bump dedup / 超限 trim / 非法字符串过滤）
 *     - buildForecastDeeplink（URL 编码 / base 缺省 / trailing slash）
 *     - buildForecastEventId（YYYYMMDD 拆 / rand4 padding / path 后缀）
 *     - formatProfitChangeRange（全有 / 仅 low / 仅 high / 都没 / 负值 / 0）
 *     - buildAnalystConsensusLine（consensus=null / 数值格式 / forecast_year null）
 *     - buildEarningsForecastMessage（surprise tag / null forecast_type）
 *     - buildEarningsForecastCard（surprise 红色 / positive 红色 / negative 绿色 / 默认蓝色 /
 *       原因 truncate / deeplink action）
 *     - buildEarningsForecastDigestCard（surprise 计数 / orange header / 多条聚合）
 *   - service.scanHeldStocks() e2e:
 *     - 无 user → scanned=0；
 *     - user 持仓有匹配预告 + 无 dedup 命中 → status='sent' sent=true；
 *     - user 持仓无匹配预告 → events=[]；
 *     - user earnings_alert=false → user 整体 skip；
 *     - 缺 webhook + 无 env fallback → user 整体 skip；
 *     - dedup buffer 命中 → status='skipped' skip_reason 含 'dedup'；
 *     - sendFeishuCard throw → fail-OPEN → status='failed' error 填充；
 *     - sendFeishuCard 返回 success=false → status='partial'；
 *     - dry_run=true → status='sent' 但 sent=false skip_reason='dry_run'，dedup 不更新；
 *     - listEligibleUsers throw → 顶层 catch → 返回空 per_event；
 *     - 多个 user：A 成功 + B 失败 → per_event 各自独立 status；
 *     - 同 user 同 stock 多 report_period（年报 + Q1）→ 每个 report_period 单独 push；
 *     - 修订公告（新 announce_date）→ 不被旧 signature 阻止；
 *     - loadAnalystConsensus throw → consensus=null 但 push 不阻塞；
 *     - dedup buffer 写入成功后 saveSeenSignatures 被调用 + LRU 维护正确；
 *   - service.scanWatchlistStocks() e2e:
 *     - 无自选股 → status='skipped'；
 *     - 自选 + 当日新预告 + 无 held 重复 → status='sent' sent=true（digest card）；
 *     - 持仓 + 自选 overlap → digest 排除持仓股，避免双推；
 *     - 当日 digest dedup → 第二次扫描 status='skipped'；
 *     - 自选无新预告 → status='skipped'；
 *     - dry_run=true → status='sent' sent=false skip_reason='dry_run'。
 */

import {
  EarningsForecastWatcher,
  EarningsForecastWatcherDataSource,
  EarningsForecastRow,
  EarningsForecastEventPayload,
  EarningsForecastWatchlistPayload,
  AnalystConsensus,
  EARNINGS_FORECAST_STATUS,
  EARNINGS_FORECAST_PATH,
  EARNINGS_FORECAST_SEEN_LRU_LIMIT,
  normalizeEarningsForecastConfig,
  shouldSendEarningsForUser,
  stripSymbolSuffix,
  pickForecastsForHolders,
  pickForecastsForWatchers,
  signatureForForecast,
  mergeSeenForecastSignatures,
  buildForecastDeeplink,
  buildForecastEventId,
  formatProfitChangeRange,
  buildAnalystConsensusLine,
  buildEarningsForecastMessage,
  buildEarningsForecastCard,
  buildEarningsForecastDigestCard,
} from '../../src/services/EarningsForecastWatcher';
import {
  NotificationChannelsConfig,
  DEFAULT_NOTIFICATION_CONFIG,
} from '../../src/services/DailyTradingDigestService';
import { FeishuBotWebhookSendResult } from '../../src/services/FeishuBotWebhookService';

let passed = 0;
let failed = 0;

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
// Fake DataSource state
// ---------------------------------------------------------------------------

interface FakeState {
  users?: Array<{ user_id: number; username: string; config: NotificationChannelsConfig }>;
  /** user_id → held stock codes Set. */
  held?: Record<number, Set<string>>;
  /** user_id → watchlist stock codes Set. */
  watch?: Record<number, Set<string>>;
  /** recent forecasts 通用 array (callers pass union of held∪watch). */
  forecasts?: EarningsForecastRow[];
  /** user_id → seen signatures array. */
  seen?: Record<number, string[]>;
  /** stock_code → consensus (null = 缺数据). */
  consensus?: Record<string, AnalystConsensus | null>;
  /** sendFeishuCard 模拟（payload → result）；fn override 时优先 */
  sendResult?:
    | FeishuBotWebhookSendResult
    | ((payload: any, url: string) => FeishuBotWebhookSendResult);
  /** sendFeishuCard throw 模拟 */
  sendShouldThrow?: boolean;
  /** listEligibleUsers throw 模拟 */
  listShouldThrow?: boolean;
  /** loadAnalystConsensus throw 模拟（stock_code 粒度） */
  consensusShouldThrowFor?: Set<string>;
  /** loadHeldStockCodes throw 模拟 */
  heldShouldThrowFor?: Set<number>;
  /** loadWatchlistStockCodes throw 模拟 */
  watchShouldThrowFor?: Set<number>;
  /** 记录已发送 payloads */
  sentLog?: Array<{ webhook_url: string; payload: any; kind: 'single' | 'digest' }>;
  /** 记录 saveSeenSignatures 调用 */
  saveSeenLog?: Array<{ user_id: number; signatures: string[] }>;
}

function makeFakeDataSource(state: FakeState): {
  ds: EarningsForecastWatcherDataSource;
  state: FakeState;
} {
  state.sentLog = [];
  state.saveSeenLog = [];
  const ds: EarningsForecastWatcherDataSource = {
    async listEligibleUsers(opts) {
      if (state.listShouldThrow) throw new Error('mock listEligibleUsers throw');
      let users = state.users || [];
      if (opts?.user_id !== undefined) {
        users = users.filter(u => u.user_id === opts.user_id);
      }
      return users;
    },
    async loadHeldStockCodes(user_id) {
      if (state.heldShouldThrowFor && state.heldShouldThrowFor.has(user_id)) {
        throw new Error('mock loadHeldStockCodes throw');
      }
      return state.held?.[user_id] || new Set();
    },
    async loadWatchlistStockCodes(user_id) {
      if (state.watchShouldThrowFor && state.watchShouldThrowFor.has(user_id)) {
        throw new Error('mock loadWatchlistStockCodes throw');
      }
      return state.watch?.[user_id] || new Set();
    },
    async loadRecentForecasts(input) {
      const all = state.forecasts || [];
      if (!input.stock_codes || input.stock_codes.size === 0) return all.slice();
      return all.filter(f => input.stock_codes!.has(f.stock_code));
    },
    async loadAnalystConsensus(stock_code, _asOfDate) {
      if (state.consensusShouldThrowFor && state.consensusShouldThrowFor.has(stock_code)) {
        throw new Error('mock loadAnalystConsensus throw');
      }
      const c = state.consensus?.[stock_code];
      return c ?? null;
    },
    async loadSeenSignatures(user_id) {
      return (state.seen?.[user_id] || []).slice();
    },
    async saveSeenSignatures(user_id, signatures) {
      state.saveSeenLog!.push({ user_id, signatures: signatures.slice() });
      if (!state.seen) state.seen = {};
      state.seen[user_id] = signatures.slice();
    },
    async sendFeishuCard(payload, webhook_url) {
      if (state.sendShouldThrow) throw new Error('mock sendFeishuCard throw');
      state.sentLog!.push({ webhook_url, payload, kind: 'single' });
      if (typeof state.sendResult === 'function') {
        return (state.sendResult as any)(payload, webhook_url);
      }
      return state.sendResult || { success: true };
    },
    async sendFeishuDigestCard(payload, webhook_url) {
      if (state.sendShouldThrow) throw new Error('mock sendFeishuDigestCard throw');
      state.sentLog!.push({ webhook_url, payload, kind: 'digest' });
      if (typeof state.sendResult === 'function') {
        return (state.sendResult as any)(payload, webhook_url);
      }
      return state.sendResult || { success: true };
    },
  };
  return { ds, state };
}

function makeBaseConfig(
  overrides: Partial<NotificationChannelsConfig['feishu']> = {}
): NotificationChannelsConfig {
  return {
    feishu: {
      enabled: true,
      webhook_url: 'https://hooks.example.com/webhook-A',
      daily_digest: true,
      earnings_alert: true,
      risk_alert: true,
      ...overrides,
    },
    email: { ...DEFAULT_NOTIFICATION_CONFIG.email },
    wechat: { ...DEFAULT_NOTIFICATION_CONFIG.wechat },
  };
}

function makeForecast(overrides: Partial<EarningsForecastRow> = {}): EarningsForecastRow {
  return {
    announce_date: '2026-06-08',
    stock_code: '600519',
    stock_name: '贵州茅台',
    report_period: '2026-03-31',
    forecast_type: '预增',
    profit_change_low: 50,
    profit_change_high: 80,
    profit_low: 100000000,
    profit_high: 150000000,
    forecast_reason: '主营业务收入增长',
    is_surprise: true,
    ...overrides,
  };
}

function makeConsensus(overrides: Partial<AnalystConsensus> = {}): AnalystConsensus {
  return {
    consensus_eps_y1: 60.5,
    report_count: 8,
    latest_report_date: '2026-06-05',
    forecast_year_y1: 2026,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants frozen
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assertEqual('EARNINGS_FORECAST_STATUS keys', Object.keys(EARNINGS_FORECAST_STATUS).sort(), [
    'FAILED',
    'PARTIAL',
    'SENT',
    'SKIPPED',
  ]);
  assert('STATUS frozen', Object.isFrozen(EARNINGS_FORECAST_STATUS));
  assert('PATH frozen', Object.isFrozen(EARNINGS_FORECAST_PATH));
  assertEqual('PATH.HELD', EARNINGS_FORECAST_PATH.HELD, 'held');
  assertEqual('PATH.WATCHLIST', EARNINGS_FORECAST_PATH.WATCHLIST, 'watchlist');
  assertEqual('LRU limit', EARNINGS_FORECAST_SEEN_LRU_LIMIT, 200);
}

// ---------------------------------------------------------------------------
// normalizeEarningsForecastConfig (delegated to normalizeNotificationConfig)
// ---------------------------------------------------------------------------

function testNormalizeConfig(): void {
  const def = normalizeEarningsForecastConfig(null);
  assertEqual('null → default earnings_alert true', def.feishu.earnings_alert, true);

  const off = normalizeEarningsForecastConfig({
    notification_channels: { feishu: { earnings_alert: false } },
  });
  assertEqual('partial off', off.feishu.earnings_alert, false);
  assertEqual('partial enabled fallback', off.feishu.enabled, true);
}

// ---------------------------------------------------------------------------
// shouldSendEarningsForUser
// ---------------------------------------------------------------------------

function testShouldSendForUser(): void {
  const ok = shouldSendEarningsForUser(makeBaseConfig(), false);
  assertEqual('happy path', ok.shouldSend, true);

  const disabled = shouldSendEarningsForUser(makeBaseConfig({ enabled: false }), false);
  assertEqual('disabled → no', disabled.shouldSend, false);
  assert('disabled reason 未启用', String(disabled.reason).includes('未启用'));

  const alertOff = shouldSendEarningsForUser(makeBaseConfig({ earnings_alert: false }), false);
  assertEqual('alert off → no', alertOff.shouldSend, false);
  assert('alert off reason 关闭', String(alertOff.reason).includes('关闭'));

  const noUrl = shouldSendEarningsForUser(makeBaseConfig({ webhook_url: '' }), false);
  assertEqual('no url no env → no', noUrl.shouldSend, false);
  assert('no url reason 未配置', String(noUrl.reason).includes('未配置'));

  const envFallback = shouldSendEarningsForUser(makeBaseConfig({ webhook_url: '' }), true);
  assertEqual('env fallback → yes', envFallback.shouldSend, true);
}

// ---------------------------------------------------------------------------
// stripSymbolSuffix
// ---------------------------------------------------------------------------

function testStripSymbolSuffix(): void {
  assertEqual('sh.600519', stripSymbolSuffix('sh.600519'), '600519');
  assertEqual('SZ.000001', stripSymbolSuffix('SZ.000001'), '000001');
  assertEqual('600519.SH', stripSymbolSuffix('600519.SH'), '600519');
  assertEqual('300750.SZ', stripSymbolSuffix('300750.SZ'), '300750');
  assertEqual('bj.835174', stripSymbolSuffix('bj.835174'), '835174');
  assertEqual('600519', stripSymbolSuffix('600519'), '600519');
  assertEqual('empty', stripSymbolSuffix(''), '');
}

// ---------------------------------------------------------------------------
// pickForecastsForHolders / pickForecastsForWatchers
// ---------------------------------------------------------------------------

function testPickForHolders(): void {
  const f1 = makeForecast({ stock_code: '600519' });
  const f2 = makeForecast({ stock_code: '000001' });
  const f3 = makeForecast({ stock_code: '300750' });

  const empty = pickForecastsForHolders([], new Set(['600519']));
  assertEqual('empty forecasts', empty.length, 0);

  const noHeld = pickForecastsForHolders([f1, f2, f3], new Set());
  assertEqual('no held → empty', noHeld.length, 0);

  const partial = pickForecastsForHolders([f1, f2, f3], new Set(['600519', '300750']));
  assertEqual('partial held → 2 picks', partial.length, 2);
  assertEqual('first is 600519', partial[0].stock_code, '600519');
  assertEqual('second is 300750', partial[1].stock_code, '300750');

  const all = pickForecastsForHolders([f1, f2, f3], new Set(['600519', '000001', '300750']));
  assertEqual('all held → 3 picks', all.length, 3);
}

function testPickForWatchers(): void {
  const surpriseUp = makeForecast({
    stock_code: '600519',
    is_surprise: true,
    forecast_type: '预增',
  });
  const normalUp = makeForecast({
    stock_code: '000001',
    is_surprise: false,
    forecast_type: '预增',
  });
  const normalDown = makeForecast({
    stock_code: '300750',
    is_surprise: false,
    forecast_type: '预减',
  });
  const heldStock = makeForecast({
    stock_code: '002594',
    is_surprise: true,
    forecast_type: '预增',
  });

  const all = pickForecastsForWatchers(
    [surpriseUp, normalUp, normalDown, heldStock],
    new Set(['600519', '000001', '300750', '002594']),
    new Set(['002594'])
  );
  assertEqual('excludes held', all.length, 3);
  assert('held stock not in result', all.every(f => f.stock_code !== '002594'));
  // sort: is_surprise desc → forecast_type alpha → code alpha
  // surpriseUp (is_surprise=true) first; normalDown (预减 < 预增 字典) before normalUp (预增)
  assertEqual('first is surprise', all[0].stock_code, '600519');
  assertEqual('second is 预减 (alphabetic before 预增)', all[1].forecast_type, '预减');
  assertEqual('third is 预增 normal', all[2].forecast_type, '预增');

  const noWatch = pickForecastsForWatchers([surpriseUp], new Set(), new Set());
  assertEqual('no watch → empty', noWatch.length, 0);
}

// ---------------------------------------------------------------------------
// signatureForForecast / mergeSeenForecastSignatures
// ---------------------------------------------------------------------------

function testSignatureForForecast(): void {
  const h = signatureForForecast({
    path: EARNINGS_FORECAST_PATH.HELD,
    stock_code: '600519',
    announce_date: '2026-06-08',
    report_period: '2026-03-31',
  });
  assert('held prefix', h.startsWith('HELD::ANN::'));
  assert('contains code', h.includes('600519'));
  assert('contains announce_date', h.includes('2026-06-08'));
  assert('contains report_period', h.includes('2026-03-31'));

  const w = signatureForForecast({
    path: EARNINGS_FORECAST_PATH.WATCHLIST,
    stock_code: '600519',
    announce_date: '2026-06-08',
    report_period: '2026-03-31',
  });
  assert('watchlist prefix', w.startsWith('WATCHLIST::ANN::'));
  assert('held vs watchlist differ', h !== w);

  // 修订公告（新 announce_date）→ 新 signature
  const revised = signatureForForecast({
    path: EARNINGS_FORECAST_PATH.HELD,
    stock_code: '600519',
    announce_date: '2026-06-15',
    report_period: '2026-03-31',
  });
  assert('revised differs', revised !== h);

  // 同股不同 report_period → 不同 signature
  const otherPeriod = signatureForForecast({
    path: EARNINGS_FORECAST_PATH.HELD,
    stock_code: '600519',
    announce_date: '2026-06-08',
    report_period: '2025-12-31',
  });
  assert('other period differs', otherPeriod !== h);
}

function testMergeSeenSignatures(): void {
  const r1 = mergeSeenForecastSignatures(null, ['a', 'b', 'c']);
  assertEqual('append from empty', r1, ['a', 'b', 'c']);

  const r2 = mergeSeenForecastSignatures(['a', 'b'], ['c', 'd']);
  assertEqual('append new', r2, ['a', 'b', 'c', 'd']);

  // bump existing to end
  const r3 = mergeSeenForecastSignatures(['a', 'b', 'c'], ['a']);
  assertEqual('bump a to end', r3, ['b', 'c', 'a']);

  // LRU trim from head
  const long = Array.from({ length: 250 }, (_, i) => `sig-${i}`);
  const r4 = mergeSeenForecastSignatures(long, ['new']);
  assertEqual('LRU trim 200', r4.length, 200);
  assertEqual('last is new', r4[r4.length - 1], 'new');
  assertEqual('first is sig-51 (200 most recent)', r4[0], 'sig-51');

  // ignore non-string
  const r5 = mergeSeenForecastSignatures(
    ['a'],
    ['b', null as any, undefined as any, 42 as any, 'c']
  );
  assertEqual('filter non-string', r5, ['a', 'b', 'c']);

  // invalid limit fallback
  const r6 = mergeSeenForecastSignatures(['a'], ['b'], -1);
  assertEqual('invalid limit fallback', r6, ['a', 'b']);
}

// ---------------------------------------------------------------------------
// buildForecastDeeplink / buildForecastEventId
// ---------------------------------------------------------------------------

function testBuildDeeplink(): void {
  const url = buildForecastDeeplink('600519', '2026-06-08', '2026-03-31', 'https://app.example.com');
  assert('contains ai param', url.includes('ai=600519'));
  assert('contains announce', url.includes('announce=2026-06-08'));
  assert('contains period', url.includes('period=2026-03-31'));
  assert('contains type', url.includes('type=earnings_forecast'));
  assert('starts with base', url.startsWith('https://app.example.com/workspace/portfolio?'));

  const trail = buildForecastDeeplink('600519', '2026-06-08', '2026-03-31', 'https://app.example.com///');
  assert('trailing slashes stripped', !trail.includes('com///'));

  const def = buildForecastDeeplink('600519', '2026-06-08', '2026-03-31');
  assert('default base used', def.includes('/workspace/portfolio'));
}

function testBuildEventId(): void {
  const id = buildForecastEventId(42, EARNINGS_FORECAST_PATH.HELD, '2026-06-08', 'ab12');
  assertEqual('basic', id, 'EARN-42-HELD-20260608-ab12');

  const w = buildForecastEventId(7, EARNINGS_FORECAST_PATH.WATCHLIST, '2026-06-08', 'cd');
  assertEqual('pad rand', w, 'EARN-7-WATCHLIST-20260608-00cd');

  const trunc = buildForecastEventId(1, EARNINGS_FORECAST_PATH.HELD, '2026-06-08', 'abcdef');
  assertEqual('truncate rand', trunc, 'EARN-1-HELD-20260608-abcd');
}

// ---------------------------------------------------------------------------
// formatProfitChangeRange
// ---------------------------------------------------------------------------

function testFormatProfitChangeRange(): void {
  assertEqual('both', formatProfitChangeRange(50, 80), '+50.0% ~ +80.0%');
  assertEqual('low only', formatProfitChangeRange(50, null), '≥ +50.0%');
  assertEqual('high only', formatProfitChangeRange(null, 80), '≤ +80.0%');
  assertEqual('none', formatProfitChangeRange(null, null), '—');
  assertEqual('negative', formatProfitChangeRange(-50, -30), '-50.0% ~ -30.0%');
  assertEqual('zero', formatProfitChangeRange(0, 10), '0.0% ~ +10.0%');
  assertEqual('NaN low', formatProfitChangeRange(NaN, 80), '≤ +80.0%');
}

// ---------------------------------------------------------------------------
// buildAnalystConsensusLine / buildEarningsForecastMessage
// ---------------------------------------------------------------------------

function testBuildConsensusLine(): void {
  assertEqual('null → —', buildAnalystConsensusLine(null), '—');

  const ok = buildAnalystConsensusLine(makeConsensus());
  assert('contains EPS', ok.includes('EPS=60.500'));
  assert('contains report_count', ok.includes('8 家'));
  assert('contains forecast_year', ok.includes('2026 年度'));

  const noYear = buildAnalystConsensusLine(makeConsensus({ forecast_year_y1: null }));
  assert('no year suffix', !noYear.includes('年度'));
}

function testBuildMessage(): void {
  const m = buildEarningsForecastMessage({
    symbol: '600519',
    stock_name: '贵州茅台',
    forecast: makeForecast(),
    analyst_consensus: makeConsensus(),
    deeplink_url: 'https://example.com/x',
  });
  assert('contains surprise tag', m.includes('【超预期】'));
  assert('contains symbol+name', m.includes('600519（贵州茅台）'));
  assert('contains forecast_type', m.includes('预增'));
  assert('contains range', m.includes('+50.0% ~ +80.0%'));
  assert('contains deeplink', m.includes('https://example.com/x'));

  const noSurprise = buildEarningsForecastMessage({
    symbol: '000001',
    stock_name: 'A',
    forecast: makeForecast({ is_surprise: false, forecast_type: null }),
    analyst_consensus: null,
    deeplink_url: 'https://x',
  });
  assert('no surprise tag', !noSurprise.includes('【超预期】'));
  assert('null type → 未知', noSurprise.includes('未知类型'));
  assert('null consensus → —', noSurprise.includes('一致预期：—'));
}

// ---------------------------------------------------------------------------
// buildEarningsForecastCard
// ---------------------------------------------------------------------------

function testBuildCard(): void {
  // surprise → red
  const surprisePayload: EarningsForecastEventPayload = {
    event_id: 'EARN-1',
    user_id: 1,
    username: 'lym',
    path: 'held',
    symbol: '600519',
    stock_name: '贵州茅台',
    forecast: makeForecast({ is_surprise: true, forecast_type: '预增' }),
    analyst_consensus: makeConsensus(),
    deeplink_url: 'https://x/deep',
    pushed_at: '2026-06-08 10:30:00',
  };
  const surpriseCard = buildEarningsForecastCard(surprisePayload);
  assertEqual('surprise → red header', surpriseCard.card.header.template, 'red');
  assert('header title contains symbol', surpriseCard.card.header.title.content.includes('600519'));

  // negative (预减) → green
  const negativePayload = {
    ...surprisePayload,
    forecast: makeForecast({ is_surprise: false, forecast_type: '预减' }),
  };
  const neg = buildEarningsForecastCard(negativePayload);
  assertEqual('negative → green', neg.card.header.template, 'green');

  // unknown type → blue
  const unknownPayload = {
    ...surprisePayload,
    forecast: makeForecast({ is_surprise: false, forecast_type: '不确定' }),
  };
  const unk = buildEarningsForecastCard(unknownPayload);
  assertEqual('unknown → blue', unk.card.header.template, 'blue');

  // positive 略增 → red
  const lightUp = {
    ...surprisePayload,
    forecast: makeForecast({ is_surprise: false, forecast_type: '略增' }),
  };
  const lup = buildEarningsForecastCard(lightUp);
  assertEqual('light up → red', lup.card.header.template, 'red');

  // verify action button exists with deeplink
  const actionEl = surpriseCard.card.elements.find((e: any) => e.tag === 'action');
  assert('has action element', !!actionEl);
  if (actionEl) {
    const btn = (actionEl as any).actions[0];
    assertEqual('button url matches deeplink', btn.url, 'https://x/deep');
  }

  // verify forecast_reason rendered
  const hasReason = surpriseCard.card.elements.some(
    (e: any) => e.text && String(e.text.content).includes('业绩变动原因')
  );
  assert('renders reason section', hasReason);

  // null forecast_reason 不渲染 reason 段
  const noReasonPayload = {
    ...surprisePayload,
    forecast: makeForecast({ forecast_reason: null }),
  };
  const nr = buildEarningsForecastCard(noReasonPayload);
  const hasReason2 = nr.card.elements.some(
    (e: any) => e.text && String(e.text.content).includes('业绩变动原因')
  );
  assert('no reason section when null', !hasReason2);
}

function testBuildDigestCard(): void {
  const payload: EarningsForecastWatchlistPayload = {
    event_id: 'EARN-1',
    user_id: 1,
    username: 'lym',
    trade_date: '2026-06-08',
    rows: [
      {
        forecast: makeForecast({ stock_code: '600519', is_surprise: true }),
        analyst_consensus: makeConsensus(),
        deeplink_url: 'https://x/600519',
      },
      {
        forecast: makeForecast({ stock_code: '000001', is_surprise: false }),
        analyst_consensus: null,
        deeplink_url: 'https://x/000001',
      },
    ],
    pushed_at: '2026-06-08 15:35:00',
  };
  const card = buildEarningsForecastDigestCard(payload);
  assertEqual('digest header orange (has surprise)', card.card.header.template, 'orange');
  assert('header title contains date', card.card.header.title.content.includes('2026-06-08'));
  // count line
  const countEl = card.card.elements[0];
  assert('count line is 2 共', String((countEl as any).text.content).includes('共 2 条'));
  assert('count line shows surprise', String((countEl as any).text.content).includes('1 条超预期'));

  // no surprise → blue
  const noSurprisePayload: EarningsForecastWatchlistPayload = {
    ...payload,
    rows: [
      {
        forecast: makeForecast({ is_surprise: false }),
        analyst_consensus: null,
        deeplink_url: 'https://x',
      },
    ],
  };
  const noSurpriseCard = buildEarningsForecastDigestCard(noSurprisePayload);
  assertEqual('no surprise → blue', noSurpriseCard.card.header.template, 'blue');
}

// ---------------------------------------------------------------------------
// service.scanHeldStocks() e2e
// ---------------------------------------------------------------------------

async function testScanHeldEmptyUsers(): Promise<void> {
  const { ds } = makeFakeDataSource({ users: [] });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('empty users scanned=0', r.scanned_users, 0);
  assertEqual('per_event empty', r.per_event.length, 0);
}

async function testScanHeldHappyPath(): Promise<void> {
  const f = makeForecast({ stock_code: '600519' });
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    held: { 42: new Set(['600519']) },
    forecasts: [f],
    consensus: { '600519': makeConsensus() },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('scanned 1 user', r.scanned_users, 1);
  assertEqual('sent 1', r.sent_count, 1);
  assertEqual('one event recorded', r.per_event.length, 1);
  assertEqual('status sent', r.per_event[0].status, 'sent');
  assertEqual('sent=true', r.per_event[0].sent, true);
  assertEqual('webhook called once', state.sentLog!.length, 1);
  assertEqual('saved seen signatures', state.saveSeenLog!.length, 1);
  assertEqual('saved sig count = 1', state.saveSeenLog![0].signatures.length, 1);
}

async function testScanHeldNoMatchingForecast(): Promise<void> {
  const f = makeForecast({ stock_code: '999999' });
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    held: { 42: new Set(['600519']) },
    forecasts: [f],
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('no event', r.per_event.length, 0);
  assertEqual('no webhook call', state.sentLog!.length, 0);
}

async function testScanHeldAlertOff(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [
      { user_id: 42, username: 'lym', config: makeBaseConfig({ earnings_alert: false }) },
    ],
    held: { 42: new Set(['600519']) },
    forecasts: [f],
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  // listEligibleUsers (default impl) filters out alert=false but fake DS doesn't —
  // shouldSendForUser gate inside scanOneUserHeld returns shouldSend=false → events=[]
  assertEqual('no event when alert off', r.per_event.length, 0);
  assertEqual('webhook NOT called', state.sentLog!.length, 0);
}

async function testScanHeldDedupHit(): Promise<void> {
  const f = makeForecast({ stock_code: '600519' });
  const existingSig = signatureForForecast({
    path: EARNINGS_FORECAST_PATH.HELD,
    stock_code: '600519',
    announce_date: f.announce_date,
    report_period: f.report_period,
  });
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    held: { 42: new Set(['600519']) },
    forecasts: [f],
    seen: { 42: [existingSig] },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('1 event', r.per_event.length, 1);
  assertEqual('status skipped (dedup)', r.per_event[0].status, 'skipped');
  assert('skip_reason mentions dedup', String(r.per_event[0].skip_reason || '').includes('dedup'));
  assertEqual('webhook NOT called', state.sentLog!.length, 0);
  assertEqual('NOT saved seen (no new sig)', state.saveSeenLog!.length, 0);
}

async function testScanHeldSendThrows(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    held: { 42: new Set(['600519']) },
    forecasts: [f],
    sendShouldThrow: true,
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('1 event', r.per_event.length, 1);
  assertEqual('status failed', r.per_event[0].status, 'failed');
  assert('error captured', String(r.per_event[0].error).includes('飞书 webhook'));
  // sendShouldThrow → sentLog not appended
  assertEqual('no sent log', state.sentLog!.length, 0);
  // dedup NOT updated on failure
  assertEqual('no seen save on failure', state.saveSeenLog!.length, 0);
}

async function testScanHeldSendReturnsFailure(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    held: { 42: new Set(['600519']) },
    forecasts: [f],
    sendResult: { success: false, message: 'feishu returned 9499' },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('1 event', r.per_event.length, 1);
  assertEqual('status partial', r.per_event[0].status, 'partial');
  assert('error has feishu message', String(r.per_event[0].error).includes('9499'));
  // dedup NOT updated on partial
  assertEqual('no seen save on partial', state.saveSeenLog!.length, 0);
}

async function testScanHeldDryRun(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    held: { 42: new Set(['600519']) },
    forecasts: [f],
    consensus: { '600519': makeConsensus() },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08', dry_run: true });
  assertEqual('dry_run sent_count=1', r.sent_count, 1);
  assertEqual('status sent (dry_run)', r.per_event[0].status, 'sent');
  assertEqual('sent=false on dry_run', r.per_event[0].sent, false);
  assertEqual('skip_reason=dry_run', r.per_event[0].skip_reason, 'dry_run');
  // payload still constructed for preview
  assert('payload exists', !!r.per_event[0].payload);
  // webhook NOT called
  assertEqual('webhook NOT called', state.sentLog!.length, 0);
  // dedup NOT updated
  assertEqual('seen NOT saved on dry_run', state.saveSeenLog!.length, 0);
}

async function testScanHeldListThrowsTopLevel(): Promise<void> {
  const { ds } = makeFakeDataSource({ listShouldThrow: true });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('scanned 0', r.scanned_users, 0);
  assertEqual('per_event empty', r.per_event.length, 0);
}

async function testScanHeldMultiUserIsolated(): Promise<void> {
  const f = makeForecast({ stock_code: '600519' });
  const { ds, state } = makeFakeDataSource({
    users: [
      { user_id: 1, username: 'a', config: makeBaseConfig() },
      { user_id: 2, username: 'b', config: makeBaseConfig() },
    ],
    held: { 1: new Set(['600519']), 2: new Set(['600519']) },
    forecasts: [f],
    sendResult: (payload: any) => {
      // user_id=2 → throw via fail-OPEN
      if (payload.user_id === 2) return { success: false, message: 'B failed' };
      return { success: true };
    },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('scanned 2', r.scanned_users, 2);
  assertEqual('one sent + one partial', r.sent_count + r.failed_count, 2);
  const a = r.per_event.find(e => e.user_id === 1);
  const b = r.per_event.find(e => e.user_id === 2);
  assertEqual('A sent', a?.status, 'sent');
  assertEqual('B partial', b?.status, 'partial');
  // saveSeen only for A (succeeded)
  assertEqual('saveSeen only for A', state.saveSeenLog!.length, 1);
  assertEqual('saveSeen.user_id=1', state.saveSeenLog![0].user_id, 1);
}

async function testScanHeldMultipleReportPeriods(): Promise<void> {
  const f1 = makeForecast({
    stock_code: '600519',
    announce_date: '2026-06-08',
    report_period: '2026-03-31',
  });
  const f2 = makeForecast({
    stock_code: '600519',
    announce_date: '2026-06-08',
    report_period: '2025-12-31',
  });
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    held: { 1: new Set(['600519']) },
    forecasts: [f1, f2],
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('2 events for 2 periods', r.per_event.length, 2);
  assertEqual('2 webhook calls', state.sentLog!.length, 2);
  // both signatures different (report_period in sig)
  const sigs = new Set(r.per_event.map(e => e.signature));
  assertEqual('2 distinct signatures', sigs.size, 2);
}

async function testScanHeldRevisedAnnouncement(): Promise<void> {
  // 旧公告已 dedup，新公告 (修订) announce_date 不同 → 新 signature → 通过
  const oldF = makeForecast({
    stock_code: '600519',
    announce_date: '2026-06-08',
    report_period: '2026-03-31',
  });
  const newF = makeForecast({
    stock_code: '600519',
    announce_date: '2026-06-15',
    report_period: '2026-03-31',
    profit_change_low: 80,
    profit_change_high: 120,
  });
  const oldSig = signatureForForecast({
    path: EARNINGS_FORECAST_PATH.HELD,
    stock_code: '600519',
    announce_date: oldF.announce_date,
    report_period: oldF.report_period,
  });
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    held: { 1: new Set(['600519']) },
    forecasts: [oldF, newF],
    seen: { 1: [oldSig] },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-15' });
  assertEqual('2 events: 1 skipped + 1 sent', r.per_event.length, 2);
  const skipped = r.per_event.find(e => e.status === 'skipped');
  const sent = r.per_event.find(e => e.status === 'sent');
  assert('old is skipped', !!skipped);
  assert('new is sent', !!sent);
  assertEqual('sent webhook=1', state.sentLog!.length, 1);
}

async function testScanHeldConsensusThrows(): Promise<void> {
  const f = makeForecast({ stock_code: '600519' });
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    held: { 1: new Set(['600519']) },
    forecasts: [f],
    consensusShouldThrowFor: new Set(['600519']),
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('still sent', r.sent_count, 1);
  assertEqual('payload consensus=null', r.per_event[0].payload!.analyst_consensus, null);
  assertEqual('webhook called', state.sentLog!.length, 1);
}

async function testScanHeldNoEnvNoWebhook(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig({ webhook_url: '' }) }],
    held: { 1: new Set(['600519']) },
    forecasts: [f],
  });
  // clear env
  const origEnv = process.env.FEISHU_BOT_WEBHOOK;
  const origEnv2 = process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  delete process.env.FEISHU_BOT_WEBHOOK;
  delete process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  try {
    const svc = new EarningsForecastWatcher(ds);
    const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
    assertEqual('no event (gated)', r.per_event.length, 0);
    assertEqual('no webhook call', state.sentLog!.length, 0);
  } finally {
    if (origEnv !== undefined) process.env.FEISHU_BOT_WEBHOOK = origEnv;
    if (origEnv2 !== undefined) process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = origEnv2;
  }
}

async function testScanHeldNoHeldPositions(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    held: { 1: new Set() },
    forecasts: [f],
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('no event (no held)', r.per_event.length, 0);
  assertEqual('no webhook', state.sentLog!.length, 0);
}

async function testScanHeldHeldLoadThrows(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    held: { 1: new Set(['600519']) },
    forecasts: [f],
    heldShouldThrowFor: new Set([1]),
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanHeldStocks({ trade_date: '2026-06-08' });
  assertEqual('no event (held load failed)', r.per_event.length, 0);
  assertEqual('no webhook', state.sentLog!.length, 0);
}

// ---------------------------------------------------------------------------
// service.scanWatchlistStocks() e2e
// ---------------------------------------------------------------------------

async function testScanWatchlistEmptyWatch(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    watch: { 1: new Set() },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanWatchlistStocks({ trade_date: '2026-06-08' });
  assertEqual('one user scanned', r.scanned_users, 1);
  assertEqual('skip', r.per_user[0].status, 'skipped');
  assert('skip_reason 无自选股', String(r.per_user[0].skip_reason).includes('无自选股'));
  assertEqual('no webhook', state.sentLog!.length, 0);
}

async function testScanWatchlistHappyPath(): Promise<void> {
  const f1 = makeForecast({ stock_code: '600519' });
  const f2 = makeForecast({ stock_code: '000001', is_surprise: false, forecast_type: '预减' });
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    watch: { 1: new Set(['600519', '000001']) },
    held: { 1: new Set() },
    forecasts: [f1, f2],
    consensus: { '600519': makeConsensus(), '000001': null },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanWatchlistStocks({ trade_date: '2026-06-08' });
  assertEqual('sent', r.per_user[0].status, 'sent');
  assertEqual('sent=true', r.per_user[0].sent, true);
  assertEqual('forecast_count=2', r.per_user[0].forecast_count, 2);
  assertEqual('one digest call', state.sentLog!.length, 1);
  assertEqual('kind=digest', state.sentLog![0].kind, 'digest');
  assertEqual('saved seen', state.saveSeenLog!.length, 1);
}

async function testScanWatchlistExcludesHeld(): Promise<void> {
  const fHeld = makeForecast({ stock_code: '600519' });
  const fWatch = makeForecast({ stock_code: '000001' });
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    watch: { 1: new Set(['600519', '000001']) },
    held: { 1: new Set(['600519']) },
    forecasts: [fHeld, fWatch],
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanWatchlistStocks({ trade_date: '2026-06-08' });
  assertEqual('sent', r.per_user[0].status, 'sent');
  assertEqual('only 1 row (held excluded)', r.per_user[0].forecast_count, 1);
  assertEqual('symbols only watch', r.per_user[0].symbols, ['000001']);
  // digest card 内 rows 也只有 1
  const sent = state.sentLog![0].payload as EarningsForecastWatchlistPayload;
  assertEqual('digest payload 1 row', sent.rows.length, 1);
}

async function testScanWatchlistDedupSameDay(): Promise<void> {
  const f = makeForecast({ stock_code: '600519' });
  const baseSig = `WATCHLIST::DIGEST::1::2026-06-08`;
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    watch: { 1: new Set(['600519']) },
    forecasts: [f],
    seen: { 1: [baseSig] },
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanWatchlistStocks({ trade_date: '2026-06-08' });
  assertEqual('skipped (dedup)', r.per_user[0].status, 'skipped');
  assert('skip_reason dedup', String(r.per_user[0].skip_reason).includes('dedup'));
  assertEqual('no webhook', state.sentLog!.length, 0);
}

async function testScanWatchlistNoNewForecasts(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    watch: { 1: new Set(['600519']) },
    forecasts: [],
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanWatchlistStocks({ trade_date: '2026-06-08' });
  assertEqual('skipped', r.per_user[0].status, 'skipped');
  assert('skip_reason 无新业绩', String(r.per_user[0].skip_reason).includes('无新业绩预告'));
  assertEqual('no webhook', state.sentLog!.length, 0);
}

async function testScanWatchlistDryRun(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'a', config: makeBaseConfig() }],
    watch: { 1: new Set(['600519']) },
    forecasts: [f],
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanWatchlistStocks({ trade_date: '2026-06-08', dry_run: true });
  assertEqual('sent (dry_run)', r.per_user[0].status, 'sent');
  assertEqual('sent=false (dry_run)', r.per_user[0].sent, false);
  assertEqual('skip_reason=dry_run', r.per_user[0].skip_reason, 'dry_run');
  assertEqual('no webhook', state.sentLog!.length, 0);
  assertEqual('no save seen', state.saveSeenLog!.length, 0);
  // payload still constructed for preview
  assert('payload exists', !!r.per_user[0].payload);
}

async function testScanWatchlistGateOff(): Promise<void> {
  const f = makeForecast();
  const { ds, state } = makeFakeDataSource({
    users: [
      { user_id: 1, username: 'a', config: makeBaseConfig({ earnings_alert: false }) },
    ],
    watch: { 1: new Set(['600519']) },
    forecasts: [f],
  });
  const svc = new EarningsForecastWatcher(ds);
  const r = await svc.scanWatchlistStocks({ trade_date: '2026-06-08' });
  assertEqual('skipped (gate)', r.per_user[0].status, 'skipped');
  assert('skip_reason 关闭', String(r.per_user[0].skip_reason).includes('关闭'));
  assertEqual('no webhook', state.sentLog!.length, 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testConstantsFrozen();
  testNormalizeConfig();
  testShouldSendForUser();
  testStripSymbolSuffix();
  testPickForHolders();
  testPickForWatchers();
  testSignatureForForecast();
  testMergeSeenSignatures();
  testBuildDeeplink();
  testBuildEventId();
  testFormatProfitChangeRange();
  testBuildConsensusLine();
  testBuildMessage();
  testBuildCard();
  testBuildDigestCard();
  await testScanHeldEmptyUsers();
  await testScanHeldHappyPath();
  await testScanHeldNoMatchingForecast();
  await testScanHeldAlertOff();
  await testScanHeldDedupHit();
  await testScanHeldSendThrows();
  await testScanHeldSendReturnsFailure();
  await testScanHeldDryRun();
  await testScanHeldListThrowsTopLevel();
  await testScanHeldMultiUserIsolated();
  await testScanHeldMultipleReportPeriods();
  await testScanHeldRevisedAnnouncement();
  await testScanHeldConsensusThrows();
  await testScanHeldNoEnvNoWebhook();
  await testScanHeldNoHeldPositions();
  await testScanHeldHeldLoadThrows();
  await testScanWatchlistEmptyWatch();
  await testScanWatchlistHappyPath();
  await testScanWatchlistExcludesHeld();
  await testScanWatchlistDedupSameDay();
  await testScanWatchlistNoNewForecasts();
  await testScanWatchlistDryRun();
  await testScanWatchlistGateOff();

  console.log(`\n────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`────────────────────────────────────`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
