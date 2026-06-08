/**
 * RestrictedShareWatchdog 单元测试 (US-089)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/restricted-share-watchdog.test.ts
 *
 * 完全脱离 DB + AKShare：注入 fake RestrictedShareDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_RESTRICTED_SHARE_CONFIG + RESTRICTED_SHARE_SEEN_LRU_LIMIT
 *   - 纯函数：
 *     stripSymbolSuffix / normalizeRestrictedShareConfig /
 *     computeWindowEndDate / aggregateReleaseByStock / computeReleaseRatio /
 *     signatureForRelease / mergeSeenSignatures / buildRestrictedShareMessage
 *   - guard.evaluateAfterOpen() end-to-end：
 *     - happy path: 持仓股 release_ratio > threshold → 触发 + 写 alert + 持久化 seen；
 *     - 阈值边界：release_ratio == threshold → below_threshold (严格 >)；
 *     - 0 持仓 → 0 triggers；
 *     - 持仓股无解禁 → no_release；
 *     - 持仓股流通市值缺失 → missing_market_cap 不发 alert；
 *     - 多批次同股聚合 → batch_count 累加，total_value 求和；
 *     - 已 seen signature → skipped_seen 不重复触发；
 *     - 不同窗口 (window_end 变化) → seen 失效 → 再次触发；
 *     - dedupe_enabled=false → seen 不生效，重复触发；
 *     - dry_run=true 不写 alert + 不持久化 seen 但 triggers 仍返回；
 *     - disabled user → enabled=false，0 触发；
 *     - 多用户：fetchReleasesInWindow 跨用户共享 (fetch 次数 = 1)；
 *     - 单 user loadOpenPositions 失败 try/catch 隔离不阻塞其他 user；
 *     - writeAlert 失败不掩盖 trigger 返回；
 *   - getConfig / updateConfig：
 *     - 默认值落地；
 *     - normalize 兼容性（非 boolean / 非数字 / 越界 → 默认）；
 *   - mergeSeenSignatures LRU：
 *     - 超过 limit 从 head pop；
 *     - 已有 signature 移到尾部刷新 LRU 位置。
 */

import {
  DEFAULT_RESTRICTED_SHARE_CONFIG,
  RESTRICTED_SHARE_SEEN_LRU_LIMIT,
  RestrictedShareConfig,
  RestrictedShareDataSource,
  RestrictedShareWatchdog,
  aggregateReleaseByStock,
  buildRestrictedShareMessage,
  computeReleaseRatio,
  computeWindowEndDate,
  mergeSeenSignatures,
  normalizeRestrictedShareConfig,
  signatureForRelease,
  stripSymbolSuffix,
} from '../../src/portfolio/risk/RestrictedShareWatchdog';

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
  circulating_market_cap: number | null;
}

interface FakeRelease {
  stock_code: string;
  ex_date: string;
  release_market_value: number | null;
}

interface FakeState {
  userIds: number[];
  configs: Record<number, RestrictedShareConfig>;
  portfolioIds: Record<number, number | null>;
  positionsByUser: Record<number, FakePosition[]>;
  seenByUser: Record<number, string[]>;
  /** Saved signatures from saveSeenSignatures. */
  savedSeenByUser: Record<number, string[]>;
  /** Releases shared across all users (date-range query). */
  releases: FakeRelease[];
  alerts: Array<{ user_id: number; symbol: string; name: string; message: string }>;
  /** Number of times fetchReleasesInWindow called (cross-user share check). */
  releasesFetchCalls: number;
  /** If set, loadOpenPositionsWithMarketCap on the matching user throws. */
  loadPositionsShouldThrowForUser?: number;
  /** If true, writeAlert throws. */
  writeAlertShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): RestrictedShareDataSource {
  return {
    async loadAllUserIdsWithPortfolios() {
      return [...state.userIds];
    },
    async loadConfig(user_id) {
      return state.configs[user_id]
        ? cloneConfig(state.configs[user_id])
        : cloneConfig(DEFAULT_RESTRICTED_SHARE_CONFIG);
    },
    async saveConfig(user_id, config) {
      state.configs[user_id] = cloneConfig(config);
      return cloneConfig(config);
    },
    async loadPortfolioId(user_id) {
      if (state.portfolioIds[user_id] === undefined) return 1000 + user_id;
      return state.portfolioIds[user_id];
    },
    async loadOpenPositionsWithMarketCap(user_id) {
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
    async fetchReleasesInWindow(_startDate, _endDate) {
      state.releasesFetchCalls += 1;
      return state.releases.map(r => ({ ...r }));
    },
    async writeAlert(input) {
      if (state.writeAlertShouldThrow) {
        throw new Error('fake alert outage');
      }
      state.alerts.push({ ...input });
    },
  };
}

function cloneConfig(c: RestrictedShareConfig): RestrictedShareConfig {
  return { ...c };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    userIds: [],
    configs: {},
    portfolioIds: {},
    positionsByUser: {},
    seenByUser: {},
    savedSeenByUser: {},
    releases: [],
    alerts: [],
    releasesFetchCalls: 0,
    ...overrides,
  };
}

function makePosition(over: Partial<FakePosition> = {}): FakePosition {
  return {
    id: 1,
    portfolio_id: 1001,
    symbol: '600519.SH',
    name: '贵州茅台',
    circulating_market_cap: 1_000_000_000, // 10 亿元
    ...over,
  };
}

// ---------------------------------------------------------------------------
//  Tests — constants
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual('DEFAULT enabled == true', DEFAULT_RESTRICTED_SHARE_CONFIG.enabled, true);
  assertEqual(
    'DEFAULT release_threshold == 0.10',
    DEFAULT_RESTRICTED_SHARE_CONFIG.release_threshold,
    0.1
  );
  assertEqual(
    'DEFAULT lookforward_trading_days == 5',
    DEFAULT_RESTRICTED_SHARE_CONFIG.lookforward_trading_days,
    5
  );
  assertEqual(
    'DEFAULT dedupe_enabled == true',
    DEFAULT_RESTRICTED_SHARE_CONFIG.dedupe_enabled,
    true
  );
  assertEqual('RESTRICTED_SHARE_SEEN_LRU_LIMIT == 200', RESTRICTED_SHARE_SEEN_LRU_LIMIT, 200);

  // Object.freeze sanity
  let mutated = false;
  try {
    (DEFAULT_RESTRICTED_SHARE_CONFIG as any).enabled = false;
    mutated = (DEFAULT_RESTRICTED_SHARE_CONFIG as any).enabled === false;
  } catch {
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
  assertEqual('no suffix passthrough', stripSymbolSuffix('600519'), '600519');
  assertEqual('empty string passthrough', stripSymbolSuffix(''), '');
}

async function testNormalizeConfig() {
  assertEqual(
    'undefined → defaults',
    normalizeRestrictedShareConfig(undefined),
    { ...DEFAULT_RESTRICTED_SHARE_CONFIG }
  );
  assertEqual(
    'null → defaults',
    normalizeRestrictedShareConfig(null),
    { ...DEFAULT_RESTRICTED_SHARE_CONFIG }
  );
  assertEqual(
    'empty object → defaults',
    normalizeRestrictedShareConfig({}),
    { ...DEFAULT_RESTRICTED_SHARE_CONFIG }
  );
  // partial override
  const partial = normalizeRestrictedShareConfig({
    enabled: false,
    release_threshold: 0.05,
  });
  assertEqual('partial: enabled override', partial.enabled, false);
  assertClose('partial: release_threshold override', partial.release_threshold, 0.05);
  assertEqual(
    'partial: lookforward_trading_days fallback',
    partial.lookforward_trading_days,
    DEFAULT_RESTRICTED_SHARE_CONFIG.lookforward_trading_days
  );
  // invalid types fall back silently
  const garbage = normalizeRestrictedShareConfig({
    enabled: 'yes', // non-boolean
    release_threshold: -0.5, // out of (0, 1]
    lookforward_trading_days: 0, // not >= 1
    dedupe_enabled: 0, // non-boolean
  });
  assertEqual('garbage: enabled fallback', garbage.enabled, true);
  assertClose('garbage: threshold fallback', garbage.release_threshold, 0.1);
  assertEqual('garbage: lookforward fallback', garbage.lookforward_trading_days, 5);
  assertEqual('garbage: dedupe fallback', garbage.dedupe_enabled, true);
  // boundary: threshold == 1 should pass
  const boundary = normalizeRestrictedShareConfig({ release_threshold: 1 });
  assertClose('boundary: threshold=1.0 accepted', boundary.release_threshold, 1);
  // boundary: threshold == 0 must reject (must be > 0)
  const zeroT = normalizeRestrictedShareConfig({ release_threshold: 0 });
  assertClose('boundary: threshold=0 rejected → default', zeroT.release_threshold, 0.1);
  // boundary: threshold > 1 must reject
  const overT = normalizeRestrictedShareConfig({ release_threshold: 1.5 });
  assertClose('boundary: threshold=1.5 rejected → default', overT.release_threshold, 0.1);
  // boundary: lookforward must be integer
  const floatLookfwd = normalizeRestrictedShareConfig({ lookforward_trading_days: 3.5 });
  assertEqual('boundary: lookforward=3.5 rejected → default', floatLookfwd.lookforward_trading_days, 5);
}

async function testComputeWindowEndDate() {
  // 5 trading days → ceil(5*7/5) = 7 calendar days
  const asOf = new Date('2026-06-08T00:00:00Z');
  const end5 = computeWindowEndDate(asOf, 5);
  assertEqual('5 trading days → +7 calendar days', end5, '2026-06-15');
  // 10 trading days → ceil(10*7/5) = 14 calendar days
  const end10 = computeWindowEndDate(asOf, 10);
  assertEqual('10 trading days → +14 calendar days', end10, '2026-06-22');
  // 1 trading day → ceil(1*7/5) = 2 calendar days
  const end1 = computeWindowEndDate(asOf, 1);
  assertEqual('1 trading day → +2 calendar days', end1, '2026-06-10');
  // Invalid (0 / negative / non-int) → defaults to 5 → +7 days
  const endZero = computeWindowEndDate(asOf, 0);
  assertEqual('0 trading days → fallback to default (5 → +7)', endZero, '2026-06-15');
  const endNeg = computeWindowEndDate(asOf, -1);
  assertEqual('-1 trading days → fallback', endNeg, '2026-06-15');
  const endFloat = computeWindowEndDate(asOf, 3.5);
  assertEqual('3.5 trading days → fallback', endFloat, '2026-06-15');
}

async function testAggregateReleaseByStock() {
  const empty = aggregateReleaseByStock([]);
  assertEqual('empty input → empty Map', empty.size, 0);

  const releases: FakeRelease[] = [
    { stock_code: '600519', ex_date: '2026-06-10', release_market_value: 1_000_000_000 }, // 10 亿
    { stock_code: '600519', ex_date: '2026-06-12', release_market_value: 500_000_000 }, // 5 亿
    { stock_code: '000001', ex_date: '2026-06-11', release_market_value: 200_000_000 }, // 2 亿
    { stock_code: '600519', ex_date: '2026-06-09', release_market_value: null }, // null → 0
  ];
  const agg = aggregateReleaseByStock(releases);
  assertEqual('agg size = 2 distinct stocks', agg.size, 2);

  const m600519 = agg.get('600519')!;
  assertEqual('600519 batch_count = 3', m600519.batch_count, 3);
  assertClose('600519 total_value = 15 亿', m600519.total_value, 1_500_000_000);
  assertEqual('600519 earliest_ex_date = 2026-06-09', m600519.earliest_ex_date, '2026-06-09');

  const m000001 = agg.get('000001')!;
  assertEqual('000001 batch_count = 1', m000001.batch_count, 1);
  assertClose('000001 total_value = 2 亿', m000001.total_value, 200_000_000);

  // Skip rows with empty stock_code
  const withEmpty = aggregateReleaseByStock([
    { stock_code: '', ex_date: '2026-06-10', release_market_value: 1e9 },
    { stock_code: '   ', ex_date: '2026-06-10', release_market_value: 1e9 },
    { stock_code: '600519', ex_date: '2026-06-10', release_market_value: 1e9 },
  ]);
  assertEqual('empty/whitespace stock_code skipped', withEmpty.size, 1);
}

async function testComputeReleaseRatio() {
  // happy path
  assertClose('5亿 / 50亿 = 0.10', computeReleaseRatio(500_000_000, 5_000_000_000)!, 0.1);
  assertClose('15亿 / 100亿 = 0.15', computeReleaseRatio(1_500_000_000, 10_000_000_000)!, 0.15);

  // 0 release → 0 (not null)
  assertEqual('0 release → 0', computeReleaseRatio(0, 1e10), 0);

  // null / 0 / negative float cap → null
  assertEqual('null cap → null', computeReleaseRatio(1e9, null), null);
  assertEqual('undefined cap → null', computeReleaseRatio(1e9, undefined), null);
  assertEqual('0 cap → null', computeReleaseRatio(1e9, 0), null);
  assertEqual('negative cap → null', computeReleaseRatio(1e9, -1), null);

  // non-finite release → null
  assertEqual('NaN release → null', computeReleaseRatio(Number.NaN, 1e10), null);
  assertEqual('Infinity release → null', computeReleaseRatio(Infinity, 1e10), null);
}

async function testSignatureForRelease() {
  const sig1 = signatureForRelease({ symbol: '600519.SH', window_end: '2026-06-15' });
  assertEqual('signature format', sig1, 'RESTRICTED::600519.SH::2026-06-15');
  // different window_end → different signature
  const sig2 = signatureForRelease({ symbol: '600519.SH', window_end: '2026-06-22' });
  assert('different window_end → different signature', sig1 !== sig2);
  // different symbol → different signature
  const sig3 = signatureForRelease({ symbol: '000001.SZ', window_end: '2026-06-15' });
  assert('different symbol → different signature', sig1 !== sig3);
}

async function testMergeSeenSignatures() {
  // null / undefined existing → empty + newOnes
  assertEqual(
    'null existing → newOnes only',
    mergeSeenSignatures(null, ['a', 'b']),
    ['a', 'b']
  );
  assertEqual(
    'undefined existing → newOnes only',
    mergeSeenSignatures(undefined, ['x']),
    ['x']
  );
  // No new signatures → existing unchanged
  assertEqual(
    'empty newOnes → existing passthrough',
    mergeSeenSignatures(['a', 'b'], []),
    ['a', 'b']
  );
  // New signature appended to end
  assertEqual(
    'new sig appended',
    mergeSeenSignatures(['a', 'b'], ['c']),
    ['a', 'b', 'c']
  );
  // Repeated signature bumped to end (LRU)
  assertEqual(
    'repeated sig bumped to end',
    mergeSeenSignatures(['a', 'b', 'c'], ['a']),
    ['b', 'c', 'a']
  );
  // LRU trim from head when over limit
  assertEqual(
    'LRU trim limit=3',
    mergeSeenSignatures(['a', 'b', 'c'], ['d', 'e'], 3),
    ['c', 'd', 'e']
  );
  // Invalid limit (0 / negative / non-int) → fallback
  const fallback = mergeSeenSignatures(['a'], ['b'], -1);
  assert('invalid limit falls back without error', fallback.length === 2);
  // Non-string newOnes elements are skipped
  assertEqual(
    'non-string newOnes elements skipped',
    mergeSeenSignatures(['a'], [123 as any, null as any, 'b']),
    ['a', 'b']
  );
}

async function testBuildRestrictedShareMessage() {
  const msg = buildRestrictedShareMessage({
    symbol: '600519.SH',
    name: '贵州茅台',
    total_release_market_value: 1_250_000_000,
    current_float_market_cap: 10_000_000_000,
    release_ratio: 0.125,
    batch_count: 2,
    earliest_ex_date: '2026-06-15',
    lookforward_trading_days: 5,
  });
  assert('message contains symbol', msg.includes('600519.SH'));
  assert('message contains name', msg.includes('贵州茅台'));
  assert('message contains lookforward 5', msg.includes('5'));
  assert('message contains 2 批', msg.includes('2'));
  assert('message contains 亿元 (large value)', msg.includes('亿元'));
  assert('message contains ratio 12.50%', msg.includes('12.50%'));
  assert('message contains earliest ex_date', msg.includes('2026-06-15'));

  // small value uses 万元
  const small = buildRestrictedShareMessage({
    symbol: '300001.SZ',
    name: '某创业板',
    total_release_market_value: 5_000_000, // 500 万
    current_float_market_cap: 30_000_000,
    release_ratio: 0.16666,
    batch_count: 1,
    earliest_ex_date: '2026-06-15',
    lookforward_trading_days: 5,
  });
  assert('small value uses 万元', small.includes('万元'));
}

// ---------------------------------------------------------------------------
//  Tests — guard.evaluateAfterOpen end-to-end
// ---------------------------------------------------------------------------

async function testHappyPath() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [makePosition({ id: 10, symbol: '600519.SH', name: '贵州茅台', circulating_market_cap: 1e10 })],
    },
    releases: [
      // 15 亿解禁 vs 100 亿流通市值 = 15% > 10% 阈值
      { stock_code: '600519', ex_date: '2026-06-12', release_market_value: 1_000_000_000 },
      { stock_code: '600519', ex_date: '2026-06-14', release_market_value: 500_000_000 },
    ],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({
    asOfDate: new Date('2026-06-08T00:00:00Z'),
  });

  assertEqual('happy: scanned 1 user', res.scanned_users, 1);
  assertEqual('happy: 1 triggered user', res.triggered_users, 1);
  assertEqual('happy: 1 trigger', res.triggers.length, 1);
  const t = res.triggers[0];
  assertEqual('trigger.symbol = 600519.SH', t.symbol, '600519.SH');
  assertEqual('trigger.stock_code = 600519', t.stock_code, '600519');
  assertClose('trigger.release_ratio = 0.15', t.release_ratio, 0.15);
  assertEqual('trigger.batch_count = 2', t.batch_count, 2);
  assertEqual('trigger.earliest_ex_date = 2026-06-12', t.earliest_ex_date, '2026-06-12');
  assertEqual('trigger.signature contains symbol', t.signature.includes('600519.SH'), true);
  // alert written
  assertEqual('1 alert written', state.alerts.length, 1);
  assertEqual('alert.user_id = 1', state.alerts[0].user_id, 1);
  // seen signature persisted
  assert('saved seen signatures', !!state.savedSeenByUser[1]);
  assertEqual('saved 1 signature', state.savedSeenByUser[1].length, 1);
}

async function testBelowThreshold() {
  // 9 亿 / 100 亿 = 9% < 10% threshold → no trigger
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [makePosition({ circulating_market_cap: 1e10 })],
    },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 900_000_000 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('below threshold: 0 triggers', res.triggered_users, 0);
  assertEqual('below threshold: per_position 1', res.per_user[0].per_position.length, 1);
  assertEqual(
    'below threshold: status = below_threshold',
    res.per_user[0].per_position[0].status,
    'below_threshold'
  );
  // No alert written
  assertEqual('no alert below threshold', state.alerts.length, 0);
}

async function testExactThresholdNotTriggered() {
  // 10 亿 / 100 亿 = exactly 10% — must NOT trigger (strict > semantics)
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [makePosition({ circulating_market_cap: 1e10 })],
    },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 1_000_000_000 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('exact threshold: 0 triggers (strict >)', res.triggered_users, 0);
  assertEqual(
    'exact threshold: status = below_threshold',
    res.per_user[0].per_position[0].status,
    'below_threshold'
  );
}

async function testNoRelease() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition()] },
    releases: [], // no releases in window
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('no_release: 0 triggers', res.triggered_users, 0);
  assertEqual(
    'no_release: status = no_release',
    res.per_user[0].per_position[0].status,
    'no_release'
  );
}

async function testMissingMarketCap() {
  // Position has null circulating_market_cap — cannot compute ratio → missing_market_cap
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [makePosition({ circulating_market_cap: null })],
    },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 1e10 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('missing_market_cap: 0 triggers', res.triggered_users, 0);
  assertEqual(
    'missing_market_cap: status = missing_market_cap',
    res.per_user[0].per_position[0].status,
    'missing_market_cap'
  );
}

async function testZeroPositions() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [] },
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('0 positions: 0 triggers', res.triggered_users, 0);
  assertEqual('0 positions: open_positions_count = 0', res.per_user[0].open_positions_count, 0);
  assertEqual('0 positions: per_position empty', res.per_user[0].per_position.length, 0);
}

async function testDisabledUser() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { ...DEFAULT_RESTRICTED_SHARE_CONFIG, enabled: false } },
    positionsByUser: { 1: [makePosition({ circulating_market_cap: 1e10 })] },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 5e9 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('disabled: 0 triggers even with large release', res.triggered_users, 0);
  assertEqual('disabled: enabled=false', res.per_user[0].enabled, false);
  assertEqual('disabled: no alert', state.alerts.length, 0);
}

async function testSeenSignatureDedup() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ circulating_market_cap: 1e10 })] },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 2e9 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const asOf = new Date('2026-06-08T00:00:00Z');

  // First call: triggers + saves seen
  const r1 = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('dedup: first call triggers', r1.triggered_users, 1);
  assertEqual('dedup: first call writes alert', state.alerts.length, 1);

  // Second call same day: seen → skipped_seen
  const r2 = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('dedup: second call no new trigger', r2.triggered_users, 0);
  assertEqual('dedup: still only 1 alert total', state.alerts.length, 1);
  assertEqual(
    'dedup: status = skipped_seen',
    r2.per_user[0].per_position[0].status,
    'skipped_seen'
  );

  // Third call different week → different window_end → fresh signature → triggers again
  const laterAsOf = new Date('2026-06-15T00:00:00Z');
  // need to re-seed releases for new window
  state.releases = [{ stock_code: '600519', ex_date: '2026-06-20', release_market_value: 2e9 }];
  const r3 = await guard.evaluateAfterOpen({ asOfDate: laterAsOf });
  assertEqual('dedup: new window triggers again', r3.triggered_users, 1);
  assertEqual('dedup: 2 alerts total now', state.alerts.length, 2);
}

async function testDedupeDisabled() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { ...DEFAULT_RESTRICTED_SHARE_CONFIG, dedupe_enabled: false } },
    positionsByUser: { 1: [makePosition({ circulating_market_cap: 1e10 })] },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 2e9 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const asOf = new Date('2026-06-08T00:00:00Z');

  // First call
  await guard.evaluateAfterOpen({ asOfDate: asOf });
  // Second call same day — should still trigger (no dedupe)
  const r2 = await guard.evaluateAfterOpen({ asOfDate: asOf });
  assertEqual('dedupe_disabled: 2nd call still triggers', r2.triggered_users, 1);
  assertEqual('dedupe_disabled: 2 alerts total', state.alerts.length, 2);
}

async function testDryRun() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ circulating_market_cap: 1e10 })] },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 2e9 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({
    asOfDate: new Date('2026-06-08T00:00:00Z'),
    dry_run: true,
  });
  assertEqual('dry_run: triggered_users still 1', res.triggered_users, 1);
  assertEqual('dry_run: triggers length 1', res.triggers.length, 1);
  assertEqual('dry_run: dry_run flag set', res.dry_run, true);
  // No alert written, no seen persisted
  assertEqual('dry_run: 0 alerts written', state.alerts.length, 0);
  assert('dry_run: no saved seen signatures', state.savedSeenByUser[1] === undefined);
}

async function testMultiUserSharedFetch() {
  // 2 users → fetchReleasesInWindow called exactly once (shared)
  const state = emptyState({
    userIds: [1, 2],
    positionsByUser: {
      1: [makePosition({ id: 10, circulating_market_cap: 1e10 })],
      2: [makePosition({ id: 20, portfolio_id: 1002, circulating_market_cap: 1e10 })],
    },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 2e9 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });

  assertEqual('shared fetch: fetchReleasesInWindow called once', state.releasesFetchCalls, 1);
  assertEqual('shared fetch: 2 triggered users', res.triggered_users, 2);
  assertEqual('shared fetch: 2 alerts', state.alerts.length, 2);
}

async function testSingleUserIsolation() {
  // user 1 loadOpenPositions throws → continue to user 2 unaffected
  const state = emptyState({
    userIds: [1, 2],
    positionsByUser: {
      2: [makePosition({ id: 20, portfolio_id: 1002, circulating_market_cap: 1e10 })],
    },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 2e9 }],
    loadPositionsShouldThrowForUser: 1,
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('isolation: scanned both users', res.scanned_users, 2);
  assertEqual('isolation: 1 triggered user (user 2)', res.triggered_users, 1);
  const u1 = res.per_user.find(u => u.user_id === 1)!;
  assert('isolation: user 1 error set', !!u1.error);
  const u2 = res.per_user.find(u => u.user_id === 2)!;
  assertEqual('isolation: user 2 triggered', u2.triggered_count, 1);
}

async function testWriteAlertFailureDoesNotMaskTrigger() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ circulating_market_cap: 1e10 })] },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 2e9 }],
    writeAlertShouldThrow: true,
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('alert fail: triggered_users still 1', res.triggered_users, 1);
  assertEqual('alert fail: triggers still returned', res.triggers.length, 1);
  assertEqual('alert fail: 0 alerts persisted', state.alerts.length, 0);
}

async function testMultiBatchAggregation() {
  // 3 batches same stock — total = 9e8 → 9% < 10% (not triggered)
  // 4 batches — total = 12e8 → 12% > 10% (triggered)
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ circulating_market_cap: 1e10 })] },
    releases: [
      { stock_code: '600519', ex_date: '2026-06-09', release_market_value: 3e8 },
      { stock_code: '600519', ex_date: '2026-06-10', release_market_value: 3e8 },
      { stock_code: '600519', ex_date: '2026-06-11', release_market_value: 3e8 },
      { stock_code: '600519', ex_date: '2026-06-12', release_market_value: 3e8 }, // total 12 亿
    ],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('multi-batch: 1 trigger', res.triggered_users, 1);
  const t = res.triggers[0];
  assertEqual('multi-batch: batch_count = 4', t.batch_count, 4);
  assertClose('multi-batch: total_value = 12 亿', t.total_release_market_value, 1.2e9);
  assertEqual('multi-batch: earliest_ex_date = 2026-06-09', t.earliest_ex_date, '2026-06-09');
}

async function testNonHeldStockNotTriggered() {
  // Position is 600519; release is for 000001 — should not trigger
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [makePosition({ circulating_market_cap: 1e10 })] },
    releases: [{ stock_code: '000001', ex_date: '2026-06-12', release_market_value: 1e10 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('non-held: 0 triggers', res.triggered_users, 0);
  assertEqual('non-held: 600519 → no_release', res.per_user[0].per_position[0].status, 'no_release');
}

async function testUserIdScoping() {
  // 3 users registered, but user_id=2 specified — only that one evaluated
  const state = emptyState({
    userIds: [1, 2, 3],
    positionsByUser: {
      1: [makePosition({ id: 10, circulating_market_cap: 1e10 })],
      2: [makePosition({ id: 20, portfolio_id: 1002, circulating_market_cap: 1e10 })],
      3: [makePosition({ id: 30, portfolio_id: 1003, circulating_market_cap: 1e10 })],
    },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 2e9 }],
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({
    asOfDate: new Date('2026-06-08T00:00:00Z'),
    user_id: 2,
  });
  assertEqual('user_id scope: scanned 1', res.scanned_users, 1);
  assertEqual('user_id scope: per_user length 1', res.per_user.length, 1);
  assertEqual('user_id scope: only user 2 evaluated', res.per_user[0].user_id, 2);
}

async function testCustomThresholdConfig() {
  // 5% threshold: 6% release → trigger; 4% release → no trigger
  const state = emptyState({
    userIds: [1],
    configs: { 1: { ...DEFAULT_RESTRICTED_SHARE_CONFIG, release_threshold: 0.05 } },
    positionsByUser: { 1: [makePosition({ circulating_market_cap: 1e10 })] },
    releases: [{ stock_code: '600519', ex_date: '2026-06-12', release_market_value: 6e8 }], // 6%
  });
  const guard = new RestrictedShareWatchdog(makeFakeSource(state));
  const res = await guard.evaluateAfterOpen({ asOfDate: new Date('2026-06-08T00:00:00Z') });
  assertEqual('custom threshold 5%: 6% triggers', res.triggered_users, 1);
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

async function main() {
  await testConstants();
  await testStripSymbolSuffix();
  await testNormalizeConfig();
  await testComputeWindowEndDate();
  await testAggregateReleaseByStock();
  await testComputeReleaseRatio();
  await testSignatureForRelease();
  await testMergeSeenSignatures();
  await testBuildRestrictedShareMessage();
  await testHappyPath();
  await testBelowThreshold();
  await testExactThresholdNotTriggered();
  await testNoRelease();
  await testMissingMarketCap();
  await testZeroPositions();
  await testDisabledUser();
  await testSeenSignatureDedup();
  await testDedupeDisabled();
  await testDryRun();
  await testMultiUserSharedFetch();
  await testSingleUserIsolation();
  await testWriteAlertFailureDoesNotMaskTrigger();
  await testMultiBatchAggregation();
  await testNonHeldStockNotTriggered();
  await testUserIdScoping();
  await testCustomThresholdConfig();

  console.log(`\n${passed} ok / ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
