/**
 * MarketRegimeAlertService 单元测试 (US-050)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/market-regime-alert-service.test.ts
 *
 * 完全脱离 DB：注入 fake MarketRegimeAlertDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_MARKET_REGIME_ALERT_CONFIG
 *   - 纯函数：
 *     computeReturnPct / computeMovingAverage / detectDeathCross /
 *     pickRegimeAlerts / normalizeMarketRegimeAlertConfig / buildAlertMessage
 *   - service.getMarketRegimeStatus()：
 *     - bars 不足时各信号返回 null + cross_signal=unknown
 *     - 3 日跌幅 = 阈值 → DROP_3D 触发
 *     - 月度跌幅 = 阈值 → DROP_20D 触发
 *     - 死叉 → DEATH_CROSS 触发
 *     - 多信号并列触发
 *     - benchmark bar load 失败 → status.error 不抛
 *     - 禁用配置 → 无 alert
 *   - service.evaluateAfterOpen() end-to-end：
 *     - 多用户 fan-out
 *     - dry_run=true → 不写 alert 但 per_user 显示
 *     - writeAlert 失败 try/catch 隔离
 *     - 单 user 失败不阻塞其他
 *     - 用户禁用 → 跳过该用户
 *     - 无 alert → per_user 空数组
 *   - getConfig / updateConfig：
 *     - 默认值落地
 *     - normalize 兼容性（>1 / 负 / NaN / 非 boolean → 默认）
 */

import {
  DEFAULT_MARKET_REGIME_ALERT_CONFIG,
  MarketRegimeAlertConfig,
  MarketRegimeAlertDataSource,
  MarketRegimeAlertService,
  BenchmarkBar,
  buildAlertMessage,
  computeMovingAverage,
  computeReturnPct,
  detectDeathCross,
  normalizeMarketRegimeAlertConfig,
  pickRegimeAlerts,
} from '../../src/portfolio/risk/MarketRegimeAlertService';

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

function assertClose(name: string, actual: number, expected: number, eps = 0.001): void {
  const ok = Math.abs(actual - expected) < eps;
  assert(name, ok, `actual=${actual} expected≈${expected} eps=${eps}`);
}

// ---------------------------------------------------------------------------
//  Fake DataSource
// ---------------------------------------------------------------------------

interface FakeState {
  globalConfig?: MarketRegimeAlertConfig;
  configs: Record<number, MarketRegimeAlertConfig>;
  benchmarkBars: BenchmarkBar[];
  benchmarkName: string;
  userIds: number[];
  alerts: Array<{
    user_id: number;
    symbol: string;
    name: string;
    level: 'MEDIUM' | 'HIGH';
    message: string;
  }>;
  /** Force loadBenchmarkBars to throw. */
  loadBenchmarkBarsShouldThrow?: boolean;
  /** Force loadConfig on this user to throw. */
  loadConfigShouldThrowForUser?: number;
  /** Force writeAlert to throw for this user. */
  writeAlertShouldThrowForUser?: number;
}

function makeFakeSource(state: FakeState): MarketRegimeAlertDataSource {
  return {
    async loadConfig(user_id) {
      if (state.loadConfigShouldThrowForUser === user_id) {
        throw new Error(`fake config outage user=${user_id}`);
      }
      return state.configs[user_id] ?? { ...DEFAULT_MARKET_REGIME_ALERT_CONFIG };
    },
    async saveConfig(user_id, config) {
      state.configs[user_id] = { ...config };
      return { ...config };
    },
    async loadGlobalConfig() {
      return state.globalConfig ?? { ...DEFAULT_MARKET_REGIME_ALERT_CONFIG };
    },
    async loadBenchmarkBars() {
      if (state.loadBenchmarkBarsShouldThrow) {
        throw new Error('fake bar load outage');
      }
      return [...state.benchmarkBars];
    },
    async loadBenchmarkName() {
      return state.benchmarkName;
    },
    async loadAllUserIdsWithPortfolios() {
      return [...state.userIds];
    },
    async writeAlert(input) {
      if (state.writeAlertShouldThrowForUser === input.user_id) {
        throw new Error(`fake alert outage user=${input.user_id}`);
      }
      state.alerts.push({ ...input });
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    configs: {},
    benchmarkBars: [],
    benchmarkName: '上证指数',
    userIds: [],
    alerts: [],
    ...overrides,
  };
}

/** Generate N bars with constant close (helper for MA/death-cross tests). */
function constBars(n: number, value: number): BenchmarkBar[] {
  const out: BenchmarkBar[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      close: value,
    });
  }
  return out;
}

/** Generate N bars with a custom close fn (i = 0..N-1). */
function makeBars(n: number, closeFn: (i: number) => number): BenchmarkBar[] {
  const out: BenchmarkBar[] = [];
  for (let i = 0; i < n; i++) {
    // Pretend each bar is +1 day; use ISO month-rolling via Date math.
    const base = new Date(Date.UTC(2024, 0, 1)).getTime();
    const dateStr = new Date(base + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    out.push({ date: dateStr, close: closeFn(i) });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Tests — constants
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual('DEFAULT enabled', DEFAULT_MARKET_REGIME_ALERT_CONFIG.enabled, true);
  assertEqual(
    'DEFAULT benchmark_symbol',
    DEFAULT_MARKET_REGIME_ALERT_CONFIG.benchmark_symbol,
    'sh.000001'
  );
  assertEqual(
    'DEFAULT drop_3d_pct == 0.05',
    DEFAULT_MARKET_REGIME_ALERT_CONFIG.drop_3d_pct,
    0.05
  );
  assertEqual(
    'DEFAULT drop_20d_pct == 0.15',
    DEFAULT_MARKET_REGIME_ALERT_CONFIG.drop_20d_pct,
    0.15
  );
  assertEqual(
    'DEFAULT enable_death_cross',
    DEFAULT_MARKET_REGIME_ALERT_CONFIG.enable_death_cross,
    true
  );
  assertEqual(
    'DEFAULT reduce_position_pct == 0.30',
    DEFAULT_MARKET_REGIME_ALERT_CONFIG.reduce_position_pct,
    0.3
  );
  // 防御性：默认对象应不可 mutate
  let mutationThrew = false;
  try {
    (DEFAULT_MARKET_REGIME_ALERT_CONFIG as any).drop_3d_pct = 0.5;
  } catch {
    mutationThrew = true;
  }
  assert(
    'DEFAULT is frozen (strict throws OR silent no-op)',
    mutationThrew || DEFAULT_MARKET_REGIME_ALERT_CONFIG.drop_3d_pct === 0.05
  );
}

// ---------------------------------------------------------------------------
//  Tests — pure helpers
// ---------------------------------------------------------------------------

async function testComputeReturnPct() {
  assertClose('return: 100 → 90 = -0.10', computeReturnPct(90, 100) as number, -0.1);
  assertClose('return: 100 → 110 = +0.10', computeReturnPct(110, 100) as number, 0.1);
  assertEqual('return: prior 0 → null', computeReturnPct(50, 0), null);
  assertEqual('return: prior negative → null', computeReturnPct(50, -10), null);
  assertEqual('return: prior NaN → null', computeReturnPct(50, NaN), null);
  assertEqual('return: latest NaN → null', computeReturnPct(NaN, 100), null);
  assertEqual('return: same value → 0', computeReturnPct(100, 100), 0);
}

async function testComputeMovingAverage() {
  assertEqual('MA: empty → null', computeMovingAverage([], 5), null);
  assertEqual('MA: 4 closes period 5 → null', computeMovingAverage([1, 2, 3, 4], 5), null);
  assertClose(
    'MA: [1,2,3,4,5] period 5 → 3.0',
    computeMovingAverage([1, 2, 3, 4, 5], 5) as number,
    3
  );
  assertClose(
    'MA: last 5 of [10,20,1,2,3,4,5] period 5 → 3.0',
    computeMovingAverage([10, 20, 1, 2, 3, 4, 5], 5) as number,
    3
  );
  assertEqual('MA: period 0 → null', computeMovingAverage([1, 2, 3], 0), null);
  assertEqual('MA: period -1 → null', computeMovingAverage([1, 2, 3], -1), null);
  assertEqual('MA: period 2.5 (non-int) → null', computeMovingAverage([1, 2, 3], 2.5), null);
  assertEqual(
    'MA: NaN in window → null',
    computeMovingAverage([1, 2, NaN, 4, 5], 5),
    null
  );
}

async function testDetectDeathCross() {
  // Classic death cross: yesterday MA20 above MA60, today MA20 below
  assertEqual(
    'death cross: yest 10>=9, today 8<9 → death_cross',
    detectDeathCross(8, 9, 10, 9),
    'death_cross'
  );
  // Boundary: yesterday exactly equal (>=) → still death_cross
  assertEqual(
    'death cross: yest 10==10, today 9<10 → death_cross',
    detectDeathCross(9, 10, 10, 10),
    'death_cross'
  );
  // Already below yesterday → not a fresh cross
  assertEqual(
    'death cross: yest 8<9 → no_cross',
    detectDeathCross(7, 9, 8, 9),
    'no_cross'
  );
  // Above today → no cross
  assertEqual(
    'death cross: today 10>9 → no_cross',
    detectDeathCross(10, 9, 10, 9),
    'no_cross'
  );
  // Equal today (strict <) → no_cross
  assertEqual(
    'death cross: today 10==10 (strict <) → no_cross',
    detectDeathCross(10, 10, 10, 10),
    'no_cross'
  );
  // Insufficient data → unknown
  assertEqual('death cross: null ma20Today → unknown', detectDeathCross(null, 9, 10, 9), 'unknown');
  assertEqual('death cross: null ma60Today → unknown', detectDeathCross(8, null, 10, 9), 'unknown');
  assertEqual('death cross: null yest → unknown', detectDeathCross(8, 9, null, 9), 'unknown');
  assertEqual(
    'death cross: NaN → unknown',
    detectDeathCross(NaN, 9, 10, 9),
    'unknown'
  );
}

async function testBuildAlertMessage() {
  const drop3d = buildAlertMessage({
    type: 'DROP_3D',
    benchmark_name: '上证指数',
    return_pct: -0.06,
    threshold_pct: 0.05,
    reduce_position_pct: 0.3,
  });
  assert('drop3d msg contains 上证指数', drop3d.includes('上证指数'));
  assert('drop3d msg contains -6.00%', drop3d.includes('-6.00%'));
  assert('drop3d msg contains 30%', drop3d.includes('30%'));
  assert('drop3d msg contains 3 日', drop3d.includes('3 日'));

  const drop20d = buildAlertMessage({
    type: 'DROP_20D',
    benchmark_name: '上证指数',
    return_pct: -0.18,
    threshold_pct: 0.15,
    reduce_position_pct: 0.3,
  });
  assert('drop20d msg contains 月度', drop20d.includes('月度'));
  assert('drop20d msg contains -18.00%', drop20d.includes('-18.00%'));

  const dc = buildAlertMessage({
    type: 'DEATH_CROSS',
    benchmark_name: '上证指数',
    ma20: 3000,
    ma60: 3100,
    reduce_position_pct: 0.3,
  });
  assert('dc msg contains 死叉', dc.includes('死叉'));
  assert('dc msg contains MA20', dc.includes('MA20'));
  assert('dc msg contains MA60', dc.includes('MA60'));
  assert('dc msg contains 3000.00', dc.includes('3000.00'));
}

async function testPickRegimeAlerts() {
  const cfg = { ...DEFAULT_MARKET_REGIME_ALERT_CONFIG };

  // None triggered
  const none = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.05,
    ma20_today: 100,
    ma60_today: 99,
    ma20_yesterday: 100,
    ma60_yesterday: 99,
  });
  assertEqual('pick: none triggered → []', none.length, 0);

  // DROP_3D only (-5% boundary)
  const d3 = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.05,
    return_20d_pct: -0.05,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
  });
  assertEqual('pick: 3d == -5% boundary → DROP_3D', d3.length, 1);
  assertEqual('pick: 3d alert type', d3[0].type, 'DROP_3D');
  assertEqual('pick: 3d alert level == MEDIUM', d3[0].level, 'MEDIUM');

  // DROP_20D only (-15% boundary)
  const d20 = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.15,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
  });
  assertEqual('pick: 20d == -15% boundary → DROP_20D', d20.length, 1);
  assertEqual('pick: 20d alert level == HIGH', d20[0].level, 'HIGH');

  // Both DROP_3D + DROP_20D
  const both = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.06,
    return_20d_pct: -0.16,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
  });
  assertEqual('pick: both 3d + 20d → 2 alerts', both.length, 2);

  // DEATH_CROSS only
  const dc = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.05,
    ma20_today: 95,
    ma60_today: 100,
    ma20_yesterday: 101,
    ma60_yesterday: 100,
  });
  assertEqual('pick: death cross only → 1', dc.length, 1);
  assertEqual('pick: death cross type', dc[0].type, 'DEATH_CROSS');

  // All three
  const all = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.06,
    return_20d_pct: -0.16,
    ma20_today: 95,
    ma60_today: 100,
    ma20_yesterday: 101,
    ma60_yesterday: 100,
  });
  assertEqual('pick: all three triggered → 3', all.length, 3);

  // Death cross disabled in config
  const dcDisabled = pickRegimeAlerts({
    config: { ...cfg, enable_death_cross: false },
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.05,
    ma20_today: 95,
    ma60_today: 100,
    ma20_yesterday: 101,
    ma60_yesterday: 100,
  });
  assertEqual('pick: dc disabled → 0', dcDisabled.length, 0);

  // 3d return null (insufficient data) → no DROP_3D even at huge drop
  const noData = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: null,
    return_20d_pct: null,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
  });
  assertEqual('pick: all null returns → 0', noData.length, 0);

  // SYSTEM: sentinel symbol
  const alerts = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.06,
    return_20d_pct: null,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
  });
  assert(
    'pick: sentinel symbol starts with SYSTEM:',
    alerts[0].symbol.startsWith('SYSTEM:')
  );
  assertEqual(
    'pick: sentinel symbol exact match',
    alerts[0].symbol,
    'SYSTEM:MARKET_REGIME_DROP_3D'
  );
}

async function testNormalizeMarketRegimeAlertConfig() {
  assertEqual('normalize: null → defaults', normalizeMarketRegimeAlertConfig(null), {
    ...DEFAULT_MARKET_REGIME_ALERT_CONFIG,
  });
  assertEqual('normalize: undefined → defaults', normalizeMarketRegimeAlertConfig(undefined), {
    ...DEFAULT_MARKET_REGIME_ALERT_CONFIG,
  });
  assertEqual('normalize: {} → defaults', normalizeMarketRegimeAlertConfig({}), {
    ...DEFAULT_MARKET_REGIME_ALERT_CONFIG,
  });
  // valid partial
  const c = normalizeMarketRegimeAlertConfig({
    drop_3d_pct: 0.08,
    drop_20d_pct: 0.2,
    reduce_position_pct: 0.5,
    benchmark_symbol: 'sh.000300',
    enable_death_cross: false,
  });
  assertEqual('normalize: 3d 0.08 saved', c.drop_3d_pct, 0.08);
  assertEqual('normalize: 20d 0.2 saved', c.drop_20d_pct, 0.2);
  assertEqual('normalize: reduce 0.5 saved', c.reduce_position_pct, 0.5);
  assertEqual('normalize: benchmark symbol saved', c.benchmark_symbol, 'sh.000300');
  assertEqual('normalize: dc disabled saved', c.enable_death_cross, false);
  assertEqual('normalize: enabled missing → default', c.enabled, true);
  // garbage
  const bad = normalizeMarketRegimeAlertConfig({
    drop_3d_pct: -0.1,
    drop_20d_pct: 1.5,
    reduce_position_pct: 'abc',
    benchmark_symbol: 42,
    enable_death_cross: 'true',
    enabled: 'yes',
  });
  assertEqual('normalize: negative pct → default', bad.drop_3d_pct, 0.05);
  assertEqual('normalize: >1 pct → default', bad.drop_20d_pct, 0.15);
  assertEqual('normalize: non-number reduce → default', bad.reduce_position_pct, 0.3);
  assertEqual('normalize: non-string benchmark → default', bad.benchmark_symbol, 'sh.000001');
  assertEqual('normalize: non-boolean dc → default', bad.enable_death_cross, true);
  assertEqual('normalize: non-boolean enabled → default', bad.enabled, true);
  // explicit false enabled preserved
  const disabled = normalizeMarketRegimeAlertConfig({ enabled: false });
  assertEqual('normalize: explicit false enabled preserved', disabled.enabled, false);
  // pct = 0 (block all) and pct = 1 are safe modes
  const safe = normalizeMarketRegimeAlertConfig({ drop_3d_pct: 0, reduce_position_pct: 1 });
  assertEqual('normalize: pct 0 preserved', safe.drop_3d_pct, 0);
  assertEqual('normalize: pct 1 preserved', safe.reduce_position_pct, 1);
}

// ---------------------------------------------------------------------------
//  Tests — service.getMarketRegimeStatus
// ---------------------------------------------------------------------------

async function testStatusNoBars() {
  const state = emptyState({ benchmarkBars: [] });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertEqual('status no bars: latest_close == null', s.latest_close, null);
  assertEqual('status no bars: return_3d_pct == null', s.return_3d_pct, null);
  assertEqual('status no bars: cross_signal == unknown', s.cross_signal, 'unknown');
  assertEqual('status no bars: alerts empty', s.alerts.length, 0);
  assertEqual('status no bars: bar_count == 0', s.bar_count, 0);
  assertEqual('status no bars: as_of == null', s.as_of, null);
}

async function testStatusInsufficientBars() {
  // 3 bars → no 3d return (need 4), no MA20, no DROP_*
  const state = emptyState({ benchmarkBars: constBars(3, 100) });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertEqual('status 3 bars: return_3d null', s.return_3d_pct, null);
  assertEqual('status 3 bars: return_20d null', s.return_20d_pct, null);
  assertEqual('status 3 bars: ma20 null', s.ma20, null);
  assertEqual('status 3 bars: ma60 null', s.ma60, null);
  assertEqual('status 3 bars: alerts empty (insufficient)', s.alerts.length, 0);
}

async function testStatusDrop3DTrigger() {
  // 4 bars: 100, 100, 100, 94 → 3-day return = (94-100)/100 = -6% → DROP_3D
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({ benchmarkBars: bars });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertClose('status 3d drop: return_3d ≈ -0.06', s.return_3d_pct as number, -0.06);
  assertEqual('status 3d drop: 1 alert', s.alerts.length, 1);
  assertEqual('status 3d drop: alert type DROP_3D', s.alerts[0].type, 'DROP_3D');
  assertEqual('status 3d drop: alert level MEDIUM', s.alerts[0].level, 'MEDIUM');
}

async function testStatusDrop20DTrigger() {
  // 21 bars: index 0 = 100, then linear down to bar 20 = 80 → 20d return = -20%
  const bars = makeBars(21, i => 100 - i);
  const state = emptyState({ benchmarkBars: bars });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertClose('status 20d drop: return_20d ≈ -0.20', s.return_20d_pct as number, -0.2);
  // 3d return = (80 - 83)/83 = -3.6% → not DROP_3D (threshold 5%)
  // 20d return ≤ -15% → DROP_20D HIGH
  const drop20 = s.alerts.find(a => a.type === 'DROP_20D');
  assert('status 20d drop: DROP_20D alert present', !!drop20);
  assertEqual('status 20d drop: alert level HIGH', drop20?.level, 'HIGH');
}

async function testStatusDeathCrossTrigger() {
  // We need 61 bars to compute ma60_yesterday. Design close such that
  // MA20 yesterday >= MA60 yesterday, but MA20 today < MA60 today.
  //
  // Approach: bars 0..60 are 100 (so MAs equal at 100 yesterday).
  // Then bar 60 (today) crashes to 50 → today MA20 drops more than MA60.
  const bars: BenchmarkBar[] = [];
  for (let i = 0; i < 60; i++) {
    bars.push({
      date: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      close: 100,
    });
  }
  bars.push({
    date: new Date(Date.UTC(2024, 0, 1) + 60 * 86400000).toISOString().slice(0, 10),
    close: 50,
  });
  // Now closes.length == 61; today MA20 = (50 + 100*19)/20 = 1950/20 = 97.5
  //                       today MA60 = (50 + 100*59)/60 = 5950/60 ≈ 99.17
  // yesterday MA20 = 100 (all 100s)
  // yesterday MA60 = 100 (all 100s)
  // → yest MA20 (100) ≥ yest MA60 (100), today MA20 (97.5) < today MA60 (99.17) → death cross
  const state = emptyState({ benchmarkBars: bars });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertEqual('status dc: cross_signal == death_cross', s.cross_signal, 'death_cross');
  const dc = s.alerts.find(a => a.type === 'DEATH_CROSS');
  assert('status dc: DEATH_CROSS alert present', !!dc);
  assertEqual('status dc: alert level MEDIUM', dc?.level, 'MEDIUM');
}

async function testStatusDisabledNoAlerts() {
  // Even with a 6% drop, disabled config → no alerts
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({
    benchmarkBars: bars,
    globalConfig: { ...DEFAULT_MARKET_REGIME_ALERT_CONFIG, enabled: false },
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertEqual('status disabled: alerts empty', s.alerts.length, 0);
  // Status fields still computed for visibility
  assertClose('status disabled: return_3d still computed', s.return_3d_pct as number, -0.06);
}

async function testStatusBarLoadFailure() {
  const state = emptyState({ loadBenchmarkBarsShouldThrow: true });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertEqual('status bar fail: bar_count == 0', s.bar_count, 0);
  assert('status bar fail: error set', !!s.error);
  assertEqual('status bar fail: alerts empty', s.alerts.length, 0);
}

// ---------------------------------------------------------------------------
//  Tests — service.evaluateAfterOpen end-to-end
// ---------------------------------------------------------------------------

async function testEvaluateNoAlertsTriggered() {
  // mild drop, no signals
  const bars = makeBars(4, i => (i < 3 ? 100 : 99));
  const state = emptyState({ benchmarkBars: bars, userIds: [1, 2, 3] });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen();
  assertEqual('evaluate none: scanned 0 (short-circuit)', r.scanned_users, 0);
  assertEqual('evaluate none: per_user empty', r.per_user.length, 0);
  assertEqual('evaluate none: 0 alerts written', state.alerts.length, 0);
}

async function testEvaluateFanOut() {
  // 6% drop → 1 alert each user
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({ benchmarkBars: bars, userIds: [1, 2, 3] });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen();
  assertEqual('evaluate fan-out: scanned 3', r.scanned_users, 3);
  assertEqual('evaluate fan-out: alerted 3', r.alerted_users, 3);
  assertEqual('evaluate fan-out: 3 alerts written total', state.alerts.length, 3);
  assertEqual('evaluate fan-out: per_user 3 entries', r.per_user.length, 3);
  assertEqual('evaluate fan-out: each user got 1 alert', r.per_user[0].alerts_written, 1);
  // Verify SYSTEM: sentinel symbol
  assert(
    'evaluate fan-out: alert symbol SYSTEM: prefix',
    state.alerts[0].symbol.startsWith('SYSTEM:')
  );
}

async function testEvaluateMultiAlertPerUser() {
  // Both DROP_3D + DROP_20D triggered → 2 alerts per user
  const bars = makeBars(21, i => {
    // 0..17 = 100, then 18 = 90, 19 = 85, 20 = 80
    if (i < 18) return 100;
    if (i === 18) return 90;
    if (i === 19) return 85;
    return 80;
  });
  // 3-day return = (80 - 100) / 100 = -20% → DROP_3D triggered
  // 20-day return = (80 - 100) / 100 = -20% → DROP_20D triggered
  const state = emptyState({ benchmarkBars: bars, userIds: [1] });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen();
  assert('evaluate multi: ≥2 alerts in status', r.status.alerts.length >= 2);
  // each user receives all alerts
  assertEqual(
    'evaluate multi: alerts written == alerts.length',
    state.alerts.length,
    r.status.alerts.length
  );
}

async function testEvaluateDryRun() {
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({ benchmarkBars: bars, userIds: [1, 2] });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen({ dry_run: true });
  assertEqual('evaluate dry: status.alerts.length == 1', r.status.alerts.length, 1);
  assertEqual('evaluate dry: scanned_users 2', r.scanned_users, 2);
  assertEqual('evaluate dry: per_user 2 entries', r.per_user.length, 2);
  // dry_run still reports alerts_written count for UI
  assertEqual('evaluate dry: per_user alerts_written == 1', r.per_user[0].alerts_written, 1);
  // No alerts actually written
  assertEqual('evaluate dry: no alerts written to DB', state.alerts.length, 0);
}

async function testEvaluateWriteAlertFailureIsolated() {
  // user 2's writeAlert fails — should not block user 1 or user 3
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({
    benchmarkBars: bars,
    userIds: [1, 2, 3],
    writeAlertShouldThrowForUser: 2,
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen();
  assertEqual('evaluate isolation: scanned 3', r.scanned_users, 3);
  // 2 users succeeded (1, 3), 1 user got 0 alerts
  assertEqual('evaluate isolation: alerted 2', r.alerted_users, 2);
  assertEqual('evaluate isolation: 2 alerts written (user 2 failed)', state.alerts.length, 2);
  const u2 = r.per_user.find(u => u.user_id === 2);
  assertEqual('evaluate isolation: u2 alerts_written 0', u2?.alerts_written, 0);
}

async function testEvaluateUserConfigOutageIsolated() {
  // user 2's loadConfig throws → that user skipped via try/catch, others fine
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({
    benchmarkBars: bars,
    userIds: [1, 2, 3],
    loadConfigShouldThrowForUser: 2,
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen();
  assertEqual('evaluate config-fail: scanned 3', r.scanned_users, 3);
  const u2 = r.per_user.find(u => u.user_id === 2);
  assert('evaluate config-fail: u2 error set', !!u2?.error);
  // u1 + u3 got alerts (u2 had no config write)
  assertEqual('evaluate config-fail: 2 alerts written', state.alerts.length, 2);
}

async function testEvaluateUserDisabledSkipped() {
  // user 2 has alerts disabled
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({
    benchmarkBars: bars,
    userIds: [1, 2],
    configs: { 2: { ...DEFAULT_MARKET_REGIME_ALERT_CONFIG, enabled: false } },
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen();
  assertEqual('evaluate user-disabled: scanned 2', r.scanned_users, 2);
  // only user 1 alerted
  assertEqual('evaluate user-disabled: alerted 1', r.alerted_users, 1);
  assertEqual('evaluate user-disabled: 1 alert written', state.alerts.length, 1);
  const u2 = r.per_user.find(u => u.user_id === 2);
  assertEqual('evaluate user-disabled: u2 alerts_written 0', u2?.alerts_written, 0);
}

async function testEvaluateSingleUserOnly() {
  // user_id option narrows fan-out
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({
    benchmarkBars: bars,
    userIds: [1, 2, 3],
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen({ user_id: 2 });
  assertEqual('evaluate single-user: scanned 1', r.scanned_users, 1);
  assertEqual('evaluate single-user: 1 alert written', state.alerts.length, 1);
  assertEqual('evaluate single-user: alert.user_id == 2', state.alerts[0].user_id, 2);
}

// ---------------------------------------------------------------------------
//  Tests — getConfig / updateConfig
// ---------------------------------------------------------------------------

async function testGetUpdateConfig() {
  const state = emptyState();
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  // get fresh user → defaults
  const c = await svc.getConfig(99);
  assertEqual('getConfig fresh user → drop_3d default', c.drop_3d_pct, 0.05);
  assertEqual('getConfig fresh user → enabled default', c.enabled, true);
  // update valid
  const saved = await svc.updateConfig(99, {
    enabled: true,
    drop_3d_pct: 0.06,
    drop_20d_pct: 0.2,
    reduce_position_pct: 0.5,
    enable_death_cross: false,
    benchmark_symbol: 'sh.000300',
  });
  assertEqual('updateConfig: drop_3d 0.06 saved', saved.drop_3d_pct, 0.06);
  assertEqual('updateConfig: dc disabled saved', saved.enable_death_cross, false);
  assertEqual('updateConfig: benchmark saved', saved.benchmark_symbol, 'sh.000300');
  // re-fetch
  const refetch = await svc.getConfig(99);
  assertEqual('updateConfig: refetch drop_3d == 0.06', refetch.drop_3d_pct, 0.06);
  // garbage → defaults
  const sanitized = await svc.updateConfig(99, {
    drop_3d_pct: -1,
    drop_20d_pct: 'foo',
    reduce_position_pct: 100,
    benchmark_symbol: null,
  });
  assertEqual('updateConfig garbage: drop_3d → default', sanitized.drop_3d_pct, 0.05);
  assertEqual('updateConfig garbage: drop_20d → default', sanitized.drop_20d_pct, 0.15);
  assertEqual('updateConfig garbage: reduce → default', sanitized.reduce_position_pct, 0.3);
  assertEqual('updateConfig garbage: benchmark → default', sanitized.benchmark_symbol, 'sh.000001');
}

// ---------------------------------------------------------------------------
//  Main driver
// ---------------------------------------------------------------------------

async function main() {
  // Constants & helpers
  await testConstants();
  await testComputeReturnPct();
  await testComputeMovingAverage();
  await testDetectDeathCross();
  await testBuildAlertMessage();
  await testPickRegimeAlerts();
  await testNormalizeMarketRegimeAlertConfig();
  // service.getMarketRegimeStatus
  await testStatusNoBars();
  await testStatusInsufficientBars();
  await testStatusDrop3DTrigger();
  await testStatusDrop20DTrigger();
  await testStatusDeathCrossTrigger();
  await testStatusDisabledNoAlerts();
  await testStatusBarLoadFailure();
  // service.evaluateAfterOpen
  await testEvaluateNoAlertsTriggered();
  await testEvaluateFanOut();
  await testEvaluateMultiAlertPerUser();
  await testEvaluateDryRun();
  await testEvaluateWriteAlertFailureIsolated();
  await testEvaluateUserConfigOutageIsolated();
  await testEvaluateUserDisabledSkipped();
  await testEvaluateSingleUserOnly();
  // Config
  await testGetUpdateConfig();

  const total = passed + failed;
  console.log(`\n${passed} ok, ${failed} failed (of ${total})`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test driver crashed:', err);
  process.exit(2);
});
