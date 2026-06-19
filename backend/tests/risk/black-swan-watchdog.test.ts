/**
 * BlackSwanWatchdog 单元测试 (US-053)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/black-swan-watchdog.test.ts
 *
 * 完全脱离 DB + AKShare：注入 fake BlackSwanDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_BLACK_SWAN_CONFIG + BLACK_SWAN_SEEN_LRU_LIMIT
 *   - 纯函数：
 *     stripSymbolSuffix / detectKeywordHits / computeNewsRecencyHours /
 *     signatureForEvent / hashTitle / pickDistinctEvents / mergeSeenSignatures /
 *     normalizeBlackSwanConfig / buildSTMessage / buildSuspendedMessage /
 *     buildNewsKeywordMessage
 *   - guard.evaluateAfterOpen() end-to-end：
 *     - happy path 1: ST 命中 → 触发 + 写 alert + notify；
 *     - happy path 2: 停牌命中 → 触发；
 *     - happy path 3: 新闻关键词命中 → 触发；
 *     - 持仓不在 ST/停牌/无关键词 → no_event；
 *     - 已 seen signature → skipped_seen 不重复触发；
 *     - 24h 之外的老新闻不触发；
 *     - dry_run=true 不写 alert / notify 但 triggers 仍返回；
 *     - 0 持仓 → 0 触发；
 *     - 禁用 user → 全持仓 skipped_disabled；
 *     - scan_st=false → ST 命中不触发；
 *     - scan_suspended=false → 停牌命中不触发；
 *     - scan_news=false → 新闻命中不触发；
 *     - dedupe_enabled=false → seen 不生效，重复触发；
 *     - writeAlert 失败不掩盖 trigger 返回；
 *     - notify 失败不阻塞剩余 trigger；
 *   - 多用户：
 *     - 单 user loadOpenPositions 失败 try/catch 隔离不阻塞其他 user；
 *     - 默认 scope = 全用户；user_id 指定单 user；
 *     - 同一 ST/停牌 list 跨用户共享 fetch（fetch 次数 = 1 不是 N）；
 *   - getConfig / updateConfig：
 *     - 默认值落地；
 *     - normalize 兼容性（非 boolean / 非 array / 非整数 → 默认）；
 *   - mergeSeenSignatures LRU：
 *     - 超过 limit 从 head pop；
 *     - 已有 signature 移到尾部刷新 LRU 位置。
 */

import {
  BLACK_SWAN_SEEN_LRU_LIMIT,
  BlackSwanConfig,
  BlackSwanDataSource,
  BlackSwanEventType,
  BlackSwanTrigger,
  BlackSwanWatchdog,
  DEFAULT_BLACK_SWAN_CONFIG,
  ShareholderReductionRow,
  buildNewsKeywordMessage,
  buildSTMessage,
  buildShareholderReductionMessage,
  buildSuspendedMessage,
  computeNewsRecencyHours,
  detectKeywordHits,
  hashTitle,
  mergeSeenSignatures,
  normalizeBlackSwanConfig,
  pickDistinctEvents,
  shareholderReductionWindowStart,
  shouldTriggerShareholderReduction,
  signatureForEvent,
  stripSymbolSuffix,
  summarizeShareholderReductions,
} from '../../src/portfolio/risk/BlackSwanWatchdog';
import {
  STStockRow,
  StockNewsRow,
  SuspendedStockRow,
} from '../../src/data/sources/BlackSwanClient';

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

function assertClose(name: string, actual: number, expected: number, eps = 0.0001): void {
  const ok = Math.abs(actual - expected) < eps;
  assert(name, ok, `actual=${actual} expected≈${expected} eps=${eps}`);
}

// ---------------------------------------------------------------------------
//  Fake DataSource
// ---------------------------------------------------------------------------

interface FakePosition {
  id: number;
  portfolio_id: number;
  symbol: string;
  name: string;
}

interface FakeState {
  userIds: number[];
  configs: Record<number, BlackSwanConfig>;
  portfolioIds: Record<number, number | null>;
  positionsByUser: Record<number, FakePosition[]>;
  seenByUser: Record<number, string[]>;
  /** Saved signatures from saveSeenSignatures. */
  savedSeenByUser: Record<number, string[]>;
  stList: STStockRow[];
  suspendedList: SuspendedStockRow[];
  /** Map<6-digit code, news rows> — fake returns this for fetchStockNews. */
  newsByCode: Record<string, StockNewsRow[]>;
  alerts: Array<{ user_id: number; symbol: string; name: string; message: string }>;
  notifies: BlackSwanTrigger[];
  /** Number of times fetchSTList called (for shared-fetch test). */
  stFetchCalls: number;
  /** Number of times fetchSuspendedList called. */
  suspendedFetchCalls: number;
  /** Number of times fetchStockNews called per code. */
  newsFetchCallsByCode: Record<string, number>;
  /** If set, loadOpenPositions on the matching user throws. */
  loadPositionsShouldThrowForUser?: number;
  /** If true, writeAlert throws. */
  writeAlertShouldThrow?: boolean;
  /** If true, notify throws. */
  notifyShouldThrow?: boolean;
  /** If true, fetchSTList throws (fail-OPEN test). */
  fetchSTShouldThrow?: boolean;
  /** US-013 shareholder reductions list returned from fetchShareholderReductions. */
  reductionRows?: ShareholderReductionRow[];
  /** If true, fetchShareholderReductions throws (fail-OPEN test). */
  reductionShouldThrow?: boolean;
  /** Number of times fetchShareholderReductions called (for shared-fetch test). */
  reductionFetchCalls?: number;
}

function makeFakeSource(state: FakeState): BlackSwanDataSource {
  return {
    async loadAllUserIdsWithPortfolios() {
      return [...state.userIds];
    },
    async loadConfig(user_id) {
      return state.configs[user_id]
        ? cloneConfig(state.configs[user_id])
        : cloneConfig(DEFAULT_BLACK_SWAN_CONFIG);
    },
    async saveConfig(user_id, config) {
      state.configs[user_id] = cloneConfig(config);
      return cloneConfig(config);
    },
    async loadPortfolioId(user_id) {
      if (state.portfolioIds[user_id] === undefined) return 1000 + user_id;
      return state.portfolioIds[user_id];
    },
    async loadOpenPositions(user_id) {
      if (state.loadPositionsShouldThrowForUser === user_id) {
        throw new Error(`fake DB outage user=${user_id}`);
      }
      return (state.positionsByUser[user_id] || []).map(p => ({ ...p }));
    },
    async loadSeenSignatures(user_id) {
      return [...(state.seenByUser[user_id] || [])];
    },
    async saveSeenSignatures(user_id, signatures) {
      state.savedSeenByUser[user_id] = [...signatures];
      state.seenByUser[user_id] = [...signatures];
    },
    async fetchSTList() {
      state.stFetchCalls += 1;
      if (state.fetchSTShouldThrow) {
        // Production default DataSource swallows + returns [] — fake does the same to mirror.
        return [];
      }
      return state.stList.map(r => ({ ...r }));
    },
    async fetchSuspendedList() {
      state.suspendedFetchCalls += 1;
      return state.suspendedList.map(r => ({ ...r }));
    },
    async fetchStockNews(stock_code) {
      state.newsFetchCallsByCode[stock_code] =
        (state.newsFetchCallsByCode[stock_code] || 0) + 1;
      return (state.newsByCode[stock_code] || []).map(r => ({ ...r }));
    },
    async fetchShareholderReductions(stockCodes, _windowStartDate) {
      state.reductionFetchCalls = (state.reductionFetchCalls || 0) + 1;
      if (state.reductionShouldThrow) {
        // Production DataSource swallows + returns []; mirror that.
        return [];
      }
      const set = new Set(stockCodes);
      return (state.reductionRows || [])
        .filter(r => set.has(r.stock_code))
        .map(r => ({ ...r }));
    },
    async writeAlert(input) {
      if (state.writeAlertShouldThrow) {
        throw new Error('fake alert outage');
      }
      state.alerts.push({ ...input });
    },
    async notify(payload) {
      if (state.notifyShouldThrow) {
        throw new Error('fake notify outage');
      }
      state.notifies.push({ ...payload });
    },
  };
}

function cloneConfig(c: BlackSwanConfig): BlackSwanConfig {
  return { ...c, news_keywords: [...c.news_keywords] };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    userIds: [],
    configs: {},
    portfolioIds: {},
    positionsByUser: {},
    seenByUser: {},
    savedSeenByUser: {},
    stList: [],
    suspendedList: [],
    newsByCode: {},
    alerts: [],
    notifies: [],
    stFetchCalls: 0,
    suspendedFetchCalls: 0,
    newsFetchCallsByCode: {},
    reductionRows: [],
    reductionFetchCalls: 0,
    ...overrides,
  };
}

function makePosition(over: Partial<FakePosition> = {}): FakePosition {
  return {
    id: 1,
    portfolio_id: 1001,
    symbol: '600519.SH',
    name: '贵州茅台',
    ...over,
  };
}

// ---------------------------------------------------------------------------
//  Tests — constants
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual('DEFAULT enabled == true', DEFAULT_BLACK_SWAN_CONFIG.enabled, true);
  assertEqual('DEFAULT scan_st == true', DEFAULT_BLACK_SWAN_CONFIG.scan_st, true);
  assertEqual('DEFAULT scan_suspended == true', DEFAULT_BLACK_SWAN_CONFIG.scan_suspended, true);
  assertEqual('DEFAULT scan_news == true', DEFAULT_BLACK_SWAN_CONFIG.scan_news, true);
  // US-013 expanded keyword list to 9 (added 诉讼 / 仲裁 / 终止上市 / 退市风险)
  assertEqual(
    'DEFAULT news_keywords == 9 items (US-013 expanded)',
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.length,
    9
  );
  assert(
    'DEFAULT news_keywords contains 立案',
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.includes('立案')
  );
  assert(
    'DEFAULT news_keywords contains 退市',
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.includes('退市')
  );
  assert(
    'DEFAULT news_keywords contains 重大违规',
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.includes('重大违规')
  );
  assert(
    'DEFAULT news_keywords contains 诉讼 (US-013)',
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.includes('诉讼')
  );
  assert(
    'DEFAULT news_keywords contains 仲裁 (US-013)',
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.includes('仲裁')
  );
  assert(
    'DEFAULT news_keywords contains 终止上市 (US-013)',
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.includes('终止上市')
  );
  assert(
    'DEFAULT news_keywords contains 退市风险 (US-013)',
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.includes('退市风险')
  );
  assertEqual('DEFAULT news_lookback_hours == 24', DEFAULT_BLACK_SWAN_CONFIG.news_lookback_hours, 24);
  assertEqual('DEFAULT news_per_stock_limit == 50', DEFAULT_BLACK_SWAN_CONFIG.news_per_stock_limit, 50);
  // US-013 shareholder reduction defaults
  assertEqual(
    'DEFAULT scan_shareholder_reduction == true (US-013)',
    DEFAULT_BLACK_SWAN_CONFIG.scan_shareholder_reduction,
    true
  );
  assertEqual(
    'DEFAULT shareholder_reduction_lookback_days == 30',
    DEFAULT_BLACK_SWAN_CONFIG.shareholder_reduction_lookback_days,
    30
  );
  assertEqual(
    'DEFAULT shareholder_reduction_amount_threshold == 1 亿',
    DEFAULT_BLACK_SWAN_CONFIG.shareholder_reduction_amount_threshold,
    100_000_000
  );
  assertEqual(
    'DEFAULT shareholder_reduction_pct_threshold == 1.0',
    DEFAULT_BLACK_SWAN_CONFIG.shareholder_reduction_pct_threshold,
    1.0
  );
  assertEqual('DEFAULT dedupe_enabled == true', DEFAULT_BLACK_SWAN_CONFIG.dedupe_enabled, true);
  assertEqual('BLACK_SWAN_SEEN_LRU_LIMIT == 200', BLACK_SWAN_SEEN_LRU_LIMIT, 200);

  // Object.freeze sanity
  let mutated = false;
  try {
    (DEFAULT_BLACK_SWAN_CONFIG as any).enabled = false;
    mutated = (DEFAULT_BLACK_SWAN_CONFIG as any).enabled === false;
  } catch {
    // strict mode throws — fine, that's frozen behavior
    mutated = false;
  }
  assert('DEFAULT config is frozen (cannot mutate)', !mutated);
}

// ---------------------------------------------------------------------------
//  Tests — pure functions
// ---------------------------------------------------------------------------

async function testStripSymbolSuffix() {
  assertEqual('strip .SH suffix', stripSymbolSuffix('600519.SH'), '600519');
  assertEqual('strip .SZ suffix', stripSymbolSuffix('000001.SZ'), '000001');
  assertEqual('strip .BJ suffix', stripSymbolSuffix('872925.BJ'), '872925');
  assertEqual('no suffix passthrough', stripSymbolSuffix('600519'), '600519');
  assertEqual('empty string passthrough', stripSymbolSuffix(''), '');
}

async function testDetectKeywordHits() {
  const kws = ['立案', '退市', '重大违规'];
  assertEqual(
    'hit 立案 in title',
    detectKeywordHits('证监会立案调查 XX 公司', null, kws),
    ['立案']
  );
  assertEqual(
    'hit 退市 in content',
    detectKeywordHits('财报公告', '该公司面临退市风险警示', kws),
    ['退市']
  );
  assertEqual(
    'first keyword wins (立案 before 退市)',
    detectKeywordHits('立案 + 退市同步发生', null, kws),
    ['立案']
  );
  assertEqual(
    'no hit',
    detectKeywordHits('公司利好财报发布', '业绩超预期', kws),
    []
  );
  assertEqual('empty keywords array → no hit', detectKeywordHits('立案调查', null, []), []);
  assertEqual('null title + null content → no hit', detectKeywordHits(null, null, kws), []);
  assertEqual(
    'case-insensitive (英文 keyword)',
    detectKeywordHits('SEC NOTICE issued', 'official', ['sec notice']),
    ['sec notice']
  );
  // Empty keyword in list shouldn't false-positive (everything contains '')
  assertEqual(
    'empty-string keyword in list ignored',
    detectKeywordHits('normal news', null, ['', '立案']),
    []
  );
}

async function testComputeNewsRecencyHours() {
  const now = new Date('2026-06-08T10:00:00Z').getTime();
  const asOf = new Date(now);
  // Use full ISO + Z to be timezone-independent (matches what we'd want anyway —
  // ambiguous "YYYY-MM-DD HH:mm:ss" parses as LOCAL time per ECMAScript and the
  // host TZ would make the test flaky. AKShare publish_time strings are de facto
  // Beijing time, but the helper treats them as wallclock so production parses
  // them in the server's TZ uniformly — what matters is the SAME tz on both sides).
  assertClose(
    '1h ago',
    computeNewsRecencyHours('2026-06-08T09:00:00Z', asOf) as number,
    1
  );
  assertClose(
    '24h ago',
    computeNewsRecencyHours('2026-06-07T10:00:00Z', asOf) as number,
    24
  );
  assertEqual('null publish_time → null', computeNewsRecencyHours(null, asOf), null);
  assertEqual('empty string → null', computeNewsRecencyHours('', asOf), null);
  assertEqual('garbage string → null', computeNewsRecencyHours('not-a-date', asOf), null);
  // ISO with T separator (no Z = local TZ — assert sign only, not magnitude)
  const hLocal = computeNewsRecencyHours('2026-06-08T09:00:00', asOf);
  assert(
    'ISO T format (no Z) parses to a number',
    typeof hLocal === 'number' && Number.isFinite(hLocal)
  );
}

async function testSignatureAndHash() {
  // ST signature
  assertEqual(
    'ST sig is stable',
    signatureForEvent({ event_type: 'ST', symbol: '600519' }),
    'ST::600519'
  );
  // SUSPENDED signature
  assertEqual(
    'SUSPENDED sig is stable',
    signatureForEvent({ event_type: 'SUSPENDED', symbol: '000001' }),
    'SUSPENDED::000001'
  );
  // NEWS signature differs by title
  const sigA = signatureForEvent({
    event_type: 'NEWS_KEYWORD',
    symbol: '600519',
    keyword: '立案',
    title: '证监会立案调查公告 A',
  });
  const sigB = signatureForEvent({
    event_type: 'NEWS_KEYWORD',
    symbol: '600519',
    keyword: '立案',
    title: '证监会立案调查公告 B',
  });
  assert('NEWS sig differs by title', sigA !== sigB);
  // Same title → same sig
  const sigC = signatureForEvent({
    event_type: 'NEWS_KEYWORD',
    symbol: '600519',
    keyword: '立案',
    title: '证监会立案调查公告 A',
  });
  assertEqual('Same title → same sig', sigA, sigC);
  // hashTitle deterministic
  assertEqual('hashTitle deterministic', hashTitle('hello'), hashTitle('hello'));
  assert('hashTitle differs for different strings', hashTitle('a') !== hashTitle('b'));
  assertEqual('hashTitle empty', hashTitle(''), hashTitle(''));
}

async function testPickDistinctEvents() {
  const t1: BlackSwanTrigger = {
    user_id: 1,
    position_id: 1,
    symbol: '600519.SH',
    name: '茅台',
    event_type: 'ST',
    detail: {},
    signature: 'ST::600519',
    message: 'msg',
  };
  const t2: BlackSwanTrigger = { ...t1, position_id: 2 };
  const t3: BlackSwanTrigger = { ...t1, signature: 'ST::600519' }; // dup
  const t4: BlackSwanTrigger = { ...t1, signature: 'SUSPENDED::000001' };
  const out = pickDistinctEvents([t1, t2, t3, t4]);
  assertEqual('dedupe 4 → 2 by signature', out.length, 2);
  assertEqual('first wins (t1 kept)', out[0].position_id, 1);
  assertEqual('t4 kept', out[1].signature, 'SUSPENDED::000001');

  assertEqual('empty array', pickDistinctEvents([]), []);
}

async function testMergeSeenSignatures() {
  // Basic append
  const merged = mergeSeenSignatures(['a', 'b'], ['c', 'd']);
  assertEqual('append new', merged, ['a', 'b', 'c', 'd']);

  // Existing one moves to tail
  const merged2 = mergeSeenSignatures(['a', 'b', 'c'], ['a']);
  assertEqual('existing bumps to tail', merged2, ['b', 'c', 'a']);

  // LRU trim from head when over limit
  const merged3 = mergeSeenSignatures(['a', 'b', 'c', 'd', 'e'], ['f', 'g'], 4);
  assertEqual('LRU trim from head', merged3, ['d', 'e', 'f', 'g']);

  // null existing → empty start
  assertEqual('null existing', mergeSeenSignatures(null, ['x']), ['x']);
  assertEqual('undefined existing', mergeSeenSignatures(undefined, ['x']), ['x']);

  // non-string filtered out
  const merged5 = mergeSeenSignatures(['a', null as any, 'b'], ['c', 42 as any, 'd']);
  assertEqual('non-string filtered', merged5, ['a', 'b', 'c', 'd']);

  // invalid limit → default
  const merged6 = mergeSeenSignatures(['a', 'b'], ['c'], 0);
  assertEqual('invalid limit (0) → default', merged6, ['a', 'b', 'c']);
}

async function testNormalizeConfig() {
  // Empty raw → defaults
  const def = normalizeBlackSwanConfig(undefined);
  assertEqual('undefined raw → enabled default', def.enabled, true);
  assertEqual(
    'undefined raw → news_keywords default',
    def.news_keywords.length,
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.length
  );

  // Non-boolean enabled → default
  const c1 = normalizeBlackSwanConfig({ enabled: 'yes' });
  assertEqual('non-boolean enabled → default true', c1.enabled, true);

  // Custom enabled false
  const c2 = normalizeBlackSwanConfig({ enabled: false });
  assertEqual('explicit false honored', c2.enabled, false);

  // Non-array keywords → default
  const c3 = normalizeBlackSwanConfig({ news_keywords: 'not-array' });
  assertEqual(
    'non-array keywords → defaults',
    c3.news_keywords.length,
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.length
  );

  // Custom keywords array honored, empty strings filtered
  const c4 = normalizeBlackSwanConfig({ news_keywords: ['  hello  ', '', '  ', 'world'] });
  assertEqual('whitespace-only filtered', c4.news_keywords, ['hello', 'world']);

  // Empty array → defaults (empty would disable scan; we keep defaults instead)
  const c5 = normalizeBlackSwanConfig({ news_keywords: [] });
  assertEqual(
    'empty array → defaults restored',
    c5.news_keywords.length,
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.length
  );

  // Negative lookback → default
  const c6 = normalizeBlackSwanConfig({ news_lookback_hours: -5 });
  assertEqual('negative lookback → default', c6.news_lookback_hours, 24);

  // 0 lookback → default (must be >= 1)
  const c7 = normalizeBlackSwanConfig({ news_lookback_hours: 0 });
  assertEqual('zero lookback → default', c7.news_lookback_hours, 24);

  // Non-int → default
  const c8 = normalizeBlackSwanConfig({ news_per_stock_limit: 3.5 });
  assertEqual('non-integer per-stock-limit → default', c8.news_per_stock_limit, 50);

  // Valid custom value
  const c9 = normalizeBlackSwanConfig({ news_lookback_hours: 48, news_per_stock_limit: 100 });
  assertEqual('custom lookback honored', c9.news_lookback_hours, 48);
  assertEqual('custom limit honored', c9.news_per_stock_limit, 100);
}

async function testMessageBuilders() {
  const st = buildSTMessage({
    symbol: '600519.SH',
    name: '贵州茅台',
    raw_name: '*ST 茅台',
    change_pct: -9.99,
  });
  assert('ST message contains symbol', st.includes('600519.SH'));
  assert('ST message contains *ST 茅台', st.includes('*ST 茅台'));
  assert('ST message contains -9.99', st.includes('-9.99'));

  const sus = buildSuspendedMessage({
    symbol: '000001.SZ',
    name: '平安银行',
    latest_price: 12.345,
  });
  assert('SUSPENDED message contains 停牌', sus.includes('停牌'));
  assert('SUSPENDED message contains 12.345', sus.includes('12.345'));

  const news = buildNewsKeywordMessage({
    symbol: '600519.SH',
    name: '贵州茅台',
    keyword: '立案',
    title: '证监会立案调查公告',
    source: '财联社',
    publish_time: '2026-06-08T09:00:00Z',
  });
  assert('NEWS message contains keyword', news.includes('立案'));
  assert('NEWS message contains title', news.includes('证监会立案调查公告'));
  assert('NEWS message contains source', news.includes('财联社'));

  // null change_pct / price → graceful
  const stNull = buildSTMessage({
    symbol: '600519.SH',
    name: '贵州茅台',
    raw_name: null,
    change_pct: null,
  });
  assert('ST message handles null change_pct', stNull.includes('—'));
  const susNull = buildSuspendedMessage({
    symbol: '000001.SZ',
    name: '平安银行',
    latest_price: null,
  });
  assert('SUSPENDED message handles null price', susNull.includes('—'));
}

// ---------------------------------------------------------------------------
//  Tests — guard.evaluateAfterOpen end-to-end
// ---------------------------------------------------------------------------

async function testHappyPathST() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('happy ST: scanned 1 user', result.scanned_users, 1);
  assertEqual('happy ST: triggered 1 user', result.triggered_users, 1);
  assertEqual('happy ST: 1 trigger', result.triggers.length, 1);
  assertEqual('happy ST: event_type ST', result.triggers[0].event_type, 'ST');
  assertEqual('happy ST: 1 alert written', state.alerts.length, 1);
  assertEqual('happy ST: alert level == HIGH (in name)', state.alerts[0].name.startsWith('黑天鹅'), true);
  assertEqual('happy ST: 1 notify call', state.notifies.length, 1);
  // Seen sigs persisted
  assertEqual('happy ST: seen sig persisted', state.savedSeenByUser[1]?.length, 1);
}

async function testHappyPathSuspended() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '000001.SZ', name: '平安银行' })] },
    suspendedList: [
      {
        stock_code: '000001',
        stock_name: '平安银行',
        latest_price: 12.34,
        change_pct: -3.0,
        raw_payload: {},
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('happy SUSPENDED: 1 trigger', result.triggers.length, 1);
  assertEqual('happy SUSPENDED: event_type SUSPENDED', result.triggers[0].event_type, 'SUSPENDED');
  assertEqual('happy SUSPENDED: 1 alert written', state.alerts.length, 1);
}

async function testHappyPathNews() {
  const asOf = new Date('2026-06-08T10:00:00Z');
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    newsByCode: {
      '600519': [
        {
          title: '证监会对贵州茅台立案调查',
          content: '公告称已被立案。',
          publish_time: '2026-06-08T09:00:00Z', // 1h ago
          source: '财联社',
          url: 'http://example.com',
          raw_payload: {},
        },
      ],
    },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('happy NEWS: 1 trigger', result.triggers.length, 1);
  assertEqual('happy NEWS: event_type NEWS_KEYWORD', result.triggers[0].event_type, 'NEWS_KEYWORD');
  assertEqual(
    'happy NEWS: keyword in detail',
    (result.triggers[0].detail as any).keyword,
    '立案'
  );
  assertEqual('happy NEWS: 1 alert written', state.alerts.length, 1);
}

async function testNoEvent() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    newsByCode: { '600519': [] },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('no event: 0 triggers', result.triggers.length, 0);
  assertEqual('no event: 0 alerts', state.alerts.length, 0);
  assertEqual('no event: per_position[0].status no_event', result.per_user[0].per_position[0].status, 'no_event');
}

async function testDedupSkipped() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
    // already seen ST signature
    seenByUser: { 1: ['ST::600519'] },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('dedup ST: 0 triggers', result.triggers.length, 0);
  assertEqual('dedup ST: 0 alerts', state.alerts.length, 0);
  assertEqual(
    'dedup ST: per_position skipped_seen',
    result.per_user[0].per_position[0].status,
    'skipped_seen'
  );
}

async function testOldNewsIgnored() {
  const asOf = new Date('2026-06-08T10:00:00Z');
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    newsByCode: {
      '600519': [
        {
          title: '证监会立案调查',
          content: null,
          publish_time: '2026-06-01T09:00:00Z', // 7 days ago > 24h
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('old news ignored: 0 triggers', result.triggers.length, 0);
}

async function testDryRun() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ dry_run: true });
  assertEqual('dry_run: still 1 trigger', result.triggers.length, 1);
  assertEqual('dry_run: 0 alerts written', state.alerts.length, 0);
  assertEqual('dry_run: 0 notify calls', state.notifies.length, 0);
  // seen sigs NOT persisted in dry-run
  assertEqual('dry_run: seen sig NOT persisted', state.savedSeenByUser[1], undefined);
  assertEqual('dry_run: result.dry_run flag', result.dry_run, true);
}

async function testEmptyPortfolio() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [] },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('empty portfolio: 0 triggers', result.triggers.length, 0);
  assertEqual('empty portfolio: open_positions_count 0', result.per_user[0].open_positions_count, 0);
}

async function testDisabledUser() {
  const cfg: BlackSwanConfig = {
    ...DEFAULT_BLACK_SWAN_CONFIG,
    enabled: false,
    news_keywords: [...DEFAULT_BLACK_SWAN_CONFIG.news_keywords],
  };
  const state = emptyState({
    userIds: [1],
    configs: { 1: cfg },
    positionsByUser: { 1: [makePosition()] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('disabled user: 0 triggers', result.triggers.length, 0);
  assertEqual('disabled user: per_position skipped_disabled', result.per_user[0].per_position[0].status, 'skipped_disabled');
}

async function testScanSTOff() {
  const cfg: BlackSwanConfig = {
    ...DEFAULT_BLACK_SWAN_CONFIG,
    scan_st: false,
    news_keywords: [...DEFAULT_BLACK_SWAN_CONFIG.news_keywords],
  };
  const state = emptyState({
    userIds: [1],
    configs: { 1: cfg },
    positionsByUser: { 1: [makePosition()] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('scan_st=false: 0 triggers', result.triggers.length, 0);
}

async function testScanSuspendedOff() {
  const cfg: BlackSwanConfig = {
    ...DEFAULT_BLACK_SWAN_CONFIG,
    scan_suspended: false,
    news_keywords: [...DEFAULT_BLACK_SWAN_CONFIG.news_keywords],
  };
  const state = emptyState({
    userIds: [1],
    configs: { 1: cfg },
    positionsByUser: { 1: [makePosition()] },
    suspendedList: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        latest_price: 1200,
        change_pct: -3,
        raw_payload: {},
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('scan_suspended=false: 0 triggers', result.triggers.length, 0);
}

async function testScanNewsOff() {
  const cfg: BlackSwanConfig = {
    ...DEFAULT_BLACK_SWAN_CONFIG,
    scan_news: false,
    news_keywords: [...DEFAULT_BLACK_SWAN_CONFIG.news_keywords],
  };
  const asOf = new Date('2026-06-08T10:00:00Z');
  const state = emptyState({
    userIds: [1],
    configs: { 1: cfg },
    positionsByUser: { 1: [makePosition()] },
    newsByCode: {
      '600519': [
        {
          title: '证监会立案',
          content: null,
          publish_time: '2026-06-08T09:00:00Z',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('scan_news=false: 0 triggers', result.triggers.length, 0);
  // News fetch should NOT happen when scan_news=false
  assertEqual(
    'scan_news=false: 0 news fetch calls',
    state.newsFetchCallsByCode['600519'],
    undefined
  );
}

async function testDedupeDisabled() {
  const cfg: BlackSwanConfig = {
    ...DEFAULT_BLACK_SWAN_CONFIG,
    dedupe_enabled: false,
    news_keywords: [...DEFAULT_BLACK_SWAN_CONFIG.news_keywords],
  };
  const state = emptyState({
    userIds: [1],
    configs: { 1: cfg },
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
    seenByUser: { 1: ['ST::600519'] }, // would dedupe if enabled
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  // Even with already-seen sig, dedupe disabled → still triggers
  assertEqual('dedupe_disabled: 1 trigger despite seen', result.triggers.length, 1);
  // Should NOT persist new seen sigs when dedupe off
  assertEqual('dedupe_disabled: no seen sig persist', state.savedSeenByUser[1], undefined);
}

async function testWriteAlertFailureNotMasksTrigger() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition()] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
    writeAlertShouldThrow: true,
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  // Trigger still returned; alert write failed silently
  assertEqual('write fail: trigger still returned', result.triggers.length, 1);
  assertEqual('write fail: 0 alerts persisted', state.alerts.length, 0);
  // Notify still attempted regardless of alert write failure
  assertEqual('write fail: notify still called', state.notifies.length, 1);
}

async function testNotifyFailureDoesNotBlockOthers() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: '600519.SH', name: '茅台' }),
        makePosition({ id: 2, symbol: '000001.SZ', name: '平安' }),
      ],
    },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
      {
        stock_code: '000001',
        stock_name: 'ST 平安',
        latest_price: 12.0,
        change_pct: -9.0,
        raw_payload: {},
      },
    ],
    notifyShouldThrow: true,
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('notify fail: 2 triggers still', result.triggers.length, 2);
  assertEqual('notify fail: 2 alerts persisted', state.alerts.length, 2);
  // notify attempted N times but all threw — still 0 successful notifies
  assertEqual('notify fail: 0 successful notifies', state.notifies.length, 0);
}

async function testMultiUserIsolation() {
  const state = emptyState({
    userIds: [1, 2, 3],
    positionsByUser: {
      1: [makePosition({ symbol: '600519.SH', name: '茅台' })],
      2: [makePosition({ symbol: '000001.SZ', name: '平安' })],
      3: [makePosition({ symbol: '300750.SZ', name: '宁德时代' })],
    },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
    loadPositionsShouldThrowForUser: 2, // user 2 breaks
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('multi-user: 3 scanned', result.scanned_users, 3);
  assertEqual('multi-user: 1 triggered (user 1)', result.triggered_users, 1);
  assertEqual('multi-user: user 2 has error', !!result.per_user[1].error, true);
  // user 3 still processed despite user 2 breaking
  assertEqual('multi-user: user 3 processed', result.per_user[2].error, undefined);
  assertEqual('multi-user: user 3 open_positions_count', result.per_user[2].open_positions_count, 1);
}

async function testFetchSharedAcrossUsers() {
  const state = emptyState({
    userIds: [1, 2, 3],
    positionsByUser: {
      1: [makePosition()],
      2: [makePosition({ id: 2, symbol: '000001.SZ', name: '平安' })],
      3: [makePosition({ id: 3, symbol: '300750.SZ', name: '宁德时代' })],
    },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  await guard.evaluateAfterOpen();
  // ST/Suspended fetched exactly once total, not 3x
  assertEqual('shared fetch: stFetchCalls == 1', state.stFetchCalls, 1);
  assertEqual('shared fetch: suspendedFetchCalls == 1', state.suspendedFetchCalls, 1);
}

async function testSingleUserScope() {
  const state = emptyState({
    userIds: [1, 2, 3],
    positionsByUser: {
      1: [makePosition()],
      2: [makePosition({ id: 2, symbol: '000001.SZ', name: '平安' })],
    },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ user_id: 2 });
  // Even though state has 3 user_ids, options.user_id=2 narrows scope
  assertEqual('single-user scope: scanned 1', result.scanned_users, 1);
  assertEqual('single-user scope: per_user.length == 1', result.per_user.length, 1);
  assertEqual('single-user scope: user_id == 2', result.per_user[0].user_id, 2);
}

async function testGetConfigDefault() {
  const state = emptyState({ userIds: [1] });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const cfg = await guard.getConfig(1);
  assertEqual('default getConfig enabled', cfg.enabled, true);
  assertEqual(
    'default getConfig news_keywords',
    cfg.news_keywords.length,
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.length
  );
}

async function testUpdateConfigNormalize() {
  const state = emptyState({ userIds: [1] });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const saved = await guard.updateConfig(1, {
    enabled: false,
    news_keywords: ['custom1', 'custom2'],
    news_lookback_hours: 48,
  });
  assertEqual('updateConfig saved enabled false', saved.enabled, false);
  assertEqual('updateConfig saved keywords', saved.news_keywords, ['custom1', 'custom2']);
  assertEqual('updateConfig saved lookback 48', saved.news_lookback_hours, 48);

  // Bad input normalize to defaults
  const saved2 = await guard.updateConfig(1, {
    enabled: 'not-boolean',
    news_keywords: 'not-array',
    news_lookback_hours: -10,
  });
  assertEqual('updateConfig bad enabled → true default', saved2.enabled, true);
  assertEqual(
    'updateConfig bad keywords → defaults',
    saved2.news_keywords.length,
    DEFAULT_BLACK_SWAN_CONFIG.news_keywords.length
  );
  assertEqual('updateConfig bad lookback → 24 default', saved2.news_lookback_hours, 24);
}

async function testEventPriority() {
  // ST + SUSPENDED + NEWS all hit same position → only first event (ST) fires.
  const asOf = new Date('2026-06-08T10:00:00Z');
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
    suspendedList: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        latest_price: 1200,
        change_pct: -3,
        raw_payload: {},
      },
    ],
    newsByCode: {
      '600519': [
        {
          title: '立案调查',
          content: null,
          publish_time: '2026-06-08T09:00:00Z',
          source: 'src',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('event priority: 1 trigger (not 3)', result.triggers.length, 1);
  assertEqual('event priority: ST wins', result.triggers[0].event_type, 'ST');
}

// ---------------------------------------------------------------------------
//  US-013 — shareholder reduction (减持暴增) helpers
// ---------------------------------------------------------------------------

async function testSummarizeShareholderReductions() {
  const rows: ShareholderReductionRow[] = [
    {
      announce_date: '2026-06-01',
      stock_code: '600519',
      shareholder_name: '股东A',
      trade_amount: 50_000_000,
      pct_of_float_shares: 0.4,
    },
    {
      announce_date: '2026-06-05',
      stock_code: '600519',
      shareholder_name: '股东B',
      trade_amount: 80_000_000,
      pct_of_float_shares: 0.6,
    },
    {
      announce_date: '2026-06-06',
      stock_code: '600519',
      shareholder_name: '股东A',
      trade_amount: 20_000_000,
      pct_of_float_shares: 0.1,
    },
    {
      announce_date: '2026-06-02',
      stock_code: '000001',
      shareholder_name: '股东C',
      trade_amount: 5_000_000,
      pct_of_float_shares: 0.05,
    },
  ];
  const out = summarizeShareholderReductions(rows);
  assertEqual('summarize: 2 stock_code buckets', out.size, 2);
  const s600519 = out.get('600519')!;
  assertEqual('600519 total_amount sums', s600519.total_amount, 150_000_000);
  assertClose('600519 total_pct_of_float sums', s600519.total_pct_of_float, 1.1, 1e-9);
  assertEqual('600519 unique_shareholders == 2', s600519.unique_shareholders, 2);
  assertEqual('600519 row_count == 3', s600519.row_count, 3);
  assertEqual(
    '600519 top contributor name (largest)',
    s600519.top_contributors[0].shareholder_name,
    '股东B'
  );
  assertEqual(
    '600519 top contributor amount',
    s600519.top_contributors[0].trade_amount,
    80_000_000
  );

  // null / NaN guarded
  const messy: ShareholderReductionRow[] = [
    {
      announce_date: '2026-06-01',
      stock_code: '300750',
      shareholder_name: 'X',
      trade_amount: null,
      pct_of_float_shares: null,
    },
    {
      announce_date: '2026-06-02',
      stock_code: '300750',
      shareholder_name: 'X',
      trade_amount: Number.NaN as any,
      pct_of_float_shares: 0.5,
    },
  ];
  const messyOut = summarizeShareholderReductions(messy);
  const s300750 = messyOut.get('300750')!;
  assertEqual('messy: total_amount 0 (null + NaN ignored)', s300750.total_amount, 0);
  assertClose('messy: pct sums 0.5 (null ignored)', s300750.total_pct_of_float, 0.5, 1e-9);
  assertEqual('messy: unique_shareholders == 1', s300750.unique_shareholders, 1);

  // Empty input
  assertEqual('summarize empty → 0 entries', summarizeShareholderReductions([]).size, 0);

  // Defensive: bad row missing stock_code skipped
  const bad: any[] = [
    {
      stock_code: '',
      shareholder_name: 'X',
      trade_amount: 100,
      pct_of_float_shares: 0.1,
    },
    null,
    {
      stock_code: '600000',
      shareholder_name: 'Y',
      trade_amount: 200,
      pct_of_float_shares: 0.2,
    },
  ];
  const badOut = summarizeShareholderReductions(bad);
  assertEqual('bad rows: only 1 bucket (600000)', badOut.size, 1);
  assert('bad rows: 600000 present', badOut.has('600000'));
}

async function testShouldTriggerShareholderReduction() {
  const summary = {
    stock_code: '600519',
    total_amount: 120_000_000,
    total_pct_of_float: 0.5,
    unique_shareholders: 2,
    row_count: 3,
    top_contributors: [],
  };
  assert(
    'amount over threshold → trigger',
    shouldTriggerShareholderReduction(summary, 100_000_000, 1.0)
  );
  assert(
    'amount under + pct under → no trigger',
    !shouldTriggerShareholderReduction(summary, 200_000_000, 1.0)
  );
  // Pct path
  const summary2 = {
    ...summary,
    total_amount: 50_000_000,
    total_pct_of_float: 2.0,
  };
  assert(
    'pct over threshold → trigger (amount under)',
    shouldTriggerShareholderReduction(summary2, 100_000_000, 1.0)
  );
  // Either disabled threshold (<=0) is ignored
  assert(
    'amount threshold 0 ignored, pct hits',
    shouldTriggerShareholderReduction(summary2, 0, 1.0)
  );
  assert(
    'both thresholds 0 → never trigger',
    !shouldTriggerShareholderReduction(summary2, 0, 0)
  );
}

async function testShareholderReductionWindowStart() {
  const asOf = new Date('2026-06-30T15:00:00Z');
  assertEqual(
    '30-day window from 2026-06-30 == 2026-05-31',
    shareholderReductionWindowStart(asOf, 30),
    '2026-05-31'
  );
  assertEqual(
    '1-day window from 2026-06-30 == 2026-06-29',
    shareholderReductionWindowStart(asOf, 1),
    '2026-06-29'
  );
  // 0 or negative clamps to 1
  assertEqual(
    '0-day window clamps to 1 → 2026-06-29',
    shareholderReductionWindowStart(asOf, 0),
    '2026-06-29'
  );
}

async function testBuildShareholderReductionMessage() {
  const msg = buildShareholderReductionMessage({
    symbol: '600519.SH',
    name: '茅台',
    lookback_days: 30,
    total_amount: 250_000_000,
    total_pct_of_float: 1.85,
    unique_shareholders: 4,
    top_contributors: [
      { shareholder_name: '股东A', trade_amount: 150_000_000, pct_of_float_shares: 1.0 },
      { shareholder_name: '股东B', trade_amount: 80_000_000, pct_of_float_shares: 0.6 },
    ],
  });
  assert('msg contains symbol', msg.includes('600519.SH'));
  assert('msg contains 30 日', msg.includes('30'));
  assert('msg contains 2.50 亿', msg.includes('2.50'));
  assert('msg contains 1.85%', msg.includes('1.85'));
  assert('msg contains 股东A', msg.includes('股东A'));
  assert('msg contains 减持暴增', msg.includes('减持暴增'));
}

async function testSignatureShareholderReduction() {
  const a = signatureForEvent({
    event_type: 'SHAREHOLDER_REDUCTION',
    symbol: '600519',
    windowStartDate: '2026-05-31',
  });
  const b = signatureForEvent({
    event_type: 'SHAREHOLDER_REDUCTION',
    symbol: '600519',
    windowStartDate: '2026-05-31',
  });
  const c = signatureForEvent({
    event_type: 'SHAREHOLDER_REDUCTION',
    symbol: '600519',
    windowStartDate: '2026-06-01',
  });
  assertEqual('same window → same sig', a, b);
  assert('different window → different sig', a !== c);
  assert('sig contains type', a.startsWith('SHAREHOLDER_REDUCTION::'));
}

async function testNormalizeShareholderFields() {
  // Defaults when absent
  const def = normalizeBlackSwanConfig({});
  assertEqual(
    'normalize default scan_shareholder_reduction',
    def.scan_shareholder_reduction,
    true
  );
  assertEqual('normalize default lookback_days', def.shareholder_reduction_lookback_days, 30);
  assertEqual(
    'normalize default amount_threshold',
    def.shareholder_reduction_amount_threshold,
    100_000_000
  );
  assertEqual(
    'normalize default pct_threshold',
    def.shareholder_reduction_pct_threshold,
    1.0
  );

  // Custom valid
  const c = normalizeBlackSwanConfig({
    scan_shareholder_reduction: false,
    shareholder_reduction_lookback_days: 7,
    shareholder_reduction_amount_threshold: 50_000_000,
    shareholder_reduction_pct_threshold: 0.5,
  });
  assertEqual('normalize custom scan flag false', c.scan_shareholder_reduction, false);
  assertEqual('normalize custom lookback 7', c.shareholder_reduction_lookback_days, 7);
  assertEqual(
    'normalize custom amount 50M',
    c.shareholder_reduction_amount_threshold,
    50_000_000
  );
  assertEqual('normalize custom pct 0.5', c.shareholder_reduction_pct_threshold, 0.5);

  // Bad input → defaults
  const bad = normalizeBlackSwanConfig({
    scan_shareholder_reduction: 'yes',
    shareholder_reduction_lookback_days: -5,
    shareholder_reduction_amount_threshold: -100,
    shareholder_reduction_pct_threshold: 0,
  });
  assertEqual('bad scan flag → default true', bad.scan_shareholder_reduction, true);
  assertEqual('bad lookback → default 30', bad.shareholder_reduction_lookback_days, 30);
  assertEqual(
    'bad amount → default 1 亿',
    bad.shareholder_reduction_amount_threshold,
    100_000_000
  );
  assertEqual('bad pct 0 → default 1.0', bad.shareholder_reduction_pct_threshold, 1.0);
}

async function testHappyPathShareholderReduction() {
  const asOf = new Date('2026-06-30T15:00:00Z');
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    // 150M > 100M default → trigger
    reductionRows: [
      {
        announce_date: '2026-06-15',
        stock_code: '600519',
        shareholder_name: '股东A',
        trade_amount: 90_000_000,
        pct_of_float_shares: 0.5,
      },
      {
        announce_date: '2026-06-25',
        stock_code: '600519',
        shareholder_name: '股东B',
        trade_amount: 70_000_000,
        pct_of_float_shares: 0.4,
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('reduction: 1 trigger', result.triggers.length, 1);
  assertEqual(
    'reduction: event_type SHAREHOLDER_REDUCTION',
    result.triggers[0].event_type,
    'SHAREHOLDER_REDUCTION'
  );
  assertEqual(
    'reduction: total_amount in detail',
    (result.triggers[0].detail as any).total_amount,
    160_000_000
  );
  assertEqual(
    'reduction: unique_shareholders in detail',
    (result.triggers[0].detail as any).unique_shareholders,
    2
  );
  assertEqual('reduction: 1 alert written', state.alerts.length, 1);
  // signature should be persisted for dedup
  assertEqual('reduction: 1 seen sig persisted', state.savedSeenByUser[1]?.length, 1);
  // single-call batch fetch across positions (per user, once)
  assertEqual('reduction: fetchShareholderReductions called once', state.reductionFetchCalls, 1);
}

async function testReductionBelowThreshold() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    // 50M < 100M default + 0.3% < 1.0% default → no trigger
    reductionRows: [
      {
        announce_date: '2026-06-15',
        stock_code: '600519',
        shareholder_name: '股东A',
        trade_amount: 50_000_000,
        pct_of_float_shares: 0.3,
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('reduction below: 0 triggers', result.triggers.length, 0);
  assertEqual(
    'reduction below: no_event',
    result.per_user[0].per_position[0].status,
    'no_event'
  );
}

async function testReductionPctThresholdOnly() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    // amount 30M < 100M but pct 1.5% >= 1.0% → trigger via pct path
    reductionRows: [
      {
        announce_date: '2026-06-15',
        stock_code: '600519',
        shareholder_name: '股东A',
        trade_amount: 30_000_000,
        pct_of_float_shares: 1.5,
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('reduction pct: 1 trigger', result.triggers.length, 1);
  assertEqual(
    'reduction pct: event_type',
    result.triggers[0].event_type,
    'SHAREHOLDER_REDUCTION'
  );
}

async function testReductionScanOff() {
  const cfg: BlackSwanConfig = {
    ...DEFAULT_BLACK_SWAN_CONFIG,
    scan_shareholder_reduction: false,
    news_keywords: [...DEFAULT_BLACK_SWAN_CONFIG.news_keywords],
  };
  const state = emptyState({
    userIds: [1],
    configs: { 1: cfg },
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    reductionRows: [
      {
        announce_date: '2026-06-15',
        stock_code: '600519',
        shareholder_name: '股东A',
        trade_amount: 500_000_000,
        pct_of_float_shares: 10,
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('reduction scan off: 0 triggers', result.triggers.length, 0);
  assertEqual(
    'reduction scan off: fetchShareholderReductions NOT called',
    state.reductionFetchCalls,
    0
  );
}

async function testReductionDedup() {
  const asOf = new Date('2026-06-30T15:00:00Z');
  const windowStart = shareholderReductionWindowStart(asOf, 30);
  const sig = signatureForEvent({
    event_type: 'SHAREHOLDER_REDUCTION',
    symbol: '600519',
    windowStartDate: windowStart,
  });
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    reductionRows: [
      {
        announce_date: '2026-06-15',
        stock_code: '600519',
        shareholder_name: '股东A',
        trade_amount: 200_000_000,
        pct_of_float_shares: 2.0,
      },
    ],
    seenByUser: { 1: [sig] },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('reduction dedup: 0 triggers', result.triggers.length, 0);
  assertEqual(
    'reduction dedup: skipped_seen',
    result.per_user[0].per_position[0].status,
    'skipped_seen'
  );
}

async function testReductionEventLowerPriorityThanST() {
  // ST + REDUCTION both hit → ST wins (priority order)
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    stList: [
      {
        stock_code: '600519',
        stock_name: 'ST 茅台',
        latest_price: 1200,
        change_pct: -9.99,
        raw_payload: {},
      },
    ],
    reductionRows: [
      {
        announce_date: '2026-06-15',
        stock_code: '600519',
        shareholder_name: '股东A',
        trade_amount: 500_000_000,
        pct_of_float_shares: 5,
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('priority: 1 trigger', result.triggers.length, 1);
  assertEqual('priority: ST wins over REDUCTION', result.triggers[0].event_type, 'ST');
}

async function testReductionBatchedPerUser() {
  // 2 held positions, both with reductions → still 1 batch fetch per user (not N)
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: '600519.SH', name: '茅台' }),
        makePosition({ id: 2, symbol: '000001.SZ', name: '平安' }),
      ],
    },
    reductionRows: [
      {
        announce_date: '2026-06-15',
        stock_code: '600519',
        shareholder_name: '股东A',
        trade_amount: 200_000_000,
        pct_of_float_shares: 2,
      },
      {
        announce_date: '2026-06-20',
        stock_code: '000001',
        shareholder_name: '股东B',
        trade_amount: 150_000_000,
        pct_of_float_shares: 1.5,
      },
    ],
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen();
  assertEqual('batched: 2 triggers (one per held code)', result.triggers.length, 2);
  assertEqual('batched: fetch called only once for user', state.reductionFetchCalls, 1);
}

async function testNewsExtendedKeywordsLitigationAndDelisting() {
  // US-013 expanded keywords: '诉讼' and '终止上市' should now match.
  const asOf = new Date('2026-06-08T10:00:00Z');
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    newsByCode: {
      '600519': [
        {
          title: '公司收到法院重大诉讼通知',
          content: null,
          publish_time: '2026-06-08T09:00:00Z',
          source: '财联社',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const guard = new BlackSwanWatchdog(makeFakeSource(state));
  const result = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('litigation keyword: 1 trigger', result.triggers.length, 1);
  assertEqual(
    'litigation: keyword in detail',
    (result.triggers[0].detail as any).keyword,
    '诉讼'
  );

  // Reset + try 终止上市
  const state2 = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ symbol: '600519.SH', name: '茅台' })] },
    newsByCode: {
      '600519': [
        {
          title: '深交所启动终止上市程序',
          content: null,
          publish_time: '2026-06-08T09:00:00Z',
          source: '证监会',
          url: null,
          raw_payload: {},
        },
      ],
    },
  });
  const guard2 = new BlackSwanWatchdog(makeFakeSource(state2));
  const result2 = await guard2.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('delisting keyword: 1 trigger', result2.triggers.length, 1);
  // text '深交所启动终止上市程序' contains '终止上市' but not '退市', so the
  // first matching keyword in the default array is '终止上市'.
  assertEqual(
    'delisting: keyword in detail',
    (result2.triggers[0].detail as any).keyword,
    '终止上市'
  );
}

// ---------------------------------------------------------------------------
//  Runner
// ---------------------------------------------------------------------------

async function main() {
  await testConstants();
  await testStripSymbolSuffix();
  await testDetectKeywordHits();
  await testComputeNewsRecencyHours();
  await testSignatureAndHash();
  await testPickDistinctEvents();
  await testMergeSeenSignatures();
  await testNormalizeConfig();
  await testMessageBuilders();
  await testHappyPathST();
  await testHappyPathSuspended();
  await testHappyPathNews();
  await testNoEvent();
  await testDedupSkipped();
  await testOldNewsIgnored();
  await testDryRun();
  await testEmptyPortfolio();
  await testDisabledUser();
  await testScanSTOff();
  await testScanSuspendedOff();
  await testScanNewsOff();
  await testDedupeDisabled();
  await testWriteAlertFailureNotMasksTrigger();
  await testNotifyFailureDoesNotBlockOthers();
  await testMultiUserIsolation();
  await testFetchSharedAcrossUsers();
  await testSingleUserScope();
  await testGetConfigDefault();
  await testUpdateConfigNormalize();
  await testEventPriority();

  // US-013 — shareholder reduction + extended keywords
  await testSummarizeShareholderReductions();
  await testShouldTriggerShareholderReduction();
  await testShareholderReductionWindowStart();
  await testBuildShareholderReductionMessage();
  await testSignatureShareholderReduction();
  await testNormalizeShareholderFields();
  await testHappyPathShareholderReduction();
  await testReductionBelowThreshold();
  await testReductionPctThresholdOnly();
  await testReductionScanOff();
  await testReductionDedup();
  await testReductionEventLowerPriorityThanST();
  await testReductionBatchedPerUser();
  await testNewsExtendedKeywordsLitigationAndDelisting();

  console.log('\n──────────────────────────────────────────────');
  console.log(`✅ passed=${passed}  ❌ failed=${failed}`);
  console.log('──────────────────────────────────────────────');
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Unhandled test error:', err);
  process.exitCode = 1;
});
