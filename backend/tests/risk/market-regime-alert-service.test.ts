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
  detectConsecutiveLimitDownHalt,
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
    level: 'MEDIUM' | 'HIGH' | 'CRITICAL';
    message: string;
  }>;
  /** US-132 — 跌停股计数序列（OLDEST→NEWEST），不设置则返空数组. */
  limitDownCounts?: number[];
  /** US-132 — 模拟 loadConsecutiveLimitDownCounts 抛错. */
  loadLimitDownShouldThrow?: boolean;
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
    async loadConsecutiveLimitDownCounts(_asOfDate: Date, days: number) {
      if (state.loadLimitDownShouldThrow) {
        throw new Error('fake limit-down load outage');
      }
      if (!state.limitDownCounts) return [];
      // 复刻生产实现的 slice(-days) 语义.
      return state.limitDownCounts.slice(-days);
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
//  Tests — US-132 [PR-017] detectConsecutiveLimitDownHalt
// ---------------------------------------------------------------------------

async function testDetectConsecutiveLimitDownHalt() {
  // Insufficient data → unknown (safe HOLD, 不触发)
  assertEqual(
    'halt: empty array N=3 → unknown',
    detectConsecutiveLimitDownHalt([], 3, 100),
    'unknown'
  );
  assertEqual(
    'halt: 2 entries N=3 → unknown (insufficient)',
    detectConsecutiveLimitDownHalt([150, 200], 3, 100),
    'unknown'
  );
  assertEqual('halt: null → unknown', detectConsecutiveLimitDownHalt(null, 3, 100), 'unknown');
  assertEqual(
    'halt: undefined → unknown',
    detectConsecutiveLimitDownHalt(undefined, 3, 100),
    'unknown'
  );

  // Dirty data → unknown (NaN / 负数 / 非整数)
  assertEqual(
    'halt: NaN in window → unknown',
    detectConsecutiveLimitDownHalt([150, NaN, 200], 3, 100),
    'unknown'
  );
  assertEqual(
    'halt: negative in window → unknown',
    detectConsecutiveLimitDownHalt([150, -10, 200], 3, 100),
    'unknown'
  );
  assertEqual(
    'halt: non-int in window → unknown',
    detectConsecutiveLimitDownHalt([150, 100.5, 200], 3, 100),
    'unknown'
  );

  // Bad config args → unknown
  assertEqual(
    'halt: consecutive_days 0 → unknown',
    detectConsecutiveLimitDownHalt([150, 200, 300], 0, 100),
    'unknown'
  );
  assertEqual(
    'halt: consecutive_days -1 → unknown',
    detectConsecutiveLimitDownHalt([150, 200, 300], -1, 100),
    'unknown'
  );
  assertEqual(
    'halt: count_threshold negative → unknown',
    detectConsecutiveLimitDownHalt([150, 200, 300], 3, -5),
    'unknown'
  );

  // ★ AC 主验收 — 严格大于边界 (与 PRD "跌停股 > 100" 字面对齐).
  // 100 不触发 (恰好等于阈值, 仍属边缘) / 101 触发.
  assertEqual(
    'halt: 100/100/100 = threshold (boundary not triggered) → no_halt',
    detectConsecutiveLimitDownHalt([100, 100, 100], 3, 100),
    'no_halt'
  );
  assertEqual(
    'halt: 101/101/101 > threshold (just over) → halt_buy',
    detectConsecutiveLimitDownHalt([101, 101, 101], 3, 100),
    'halt_buy'
  );

  // ★ 主 happy path — 连续 3 日远超阈值
  assertEqual(
    'halt: 150/200/300 N=3 thr=100 → halt_buy',
    detectConsecutiveLimitDownHalt([150, 200, 300], 3, 100),
    'halt_buy'
  );

  // One day below threshold → no halt (任何一日断链)
  assertEqual(
    'halt: 150/80/200 (mid day below) → no_halt',
    detectConsecutiveLimitDownHalt([150, 80, 200], 3, 100),
    'no_halt'
  );
  assertEqual(
    'halt: 150/200/80 (last day below) → no_halt',
    detectConsecutiveLimitDownHalt([150, 200, 80], 3, 100),
    'no_halt'
  );
  assertEqual(
    'halt: 80/150/200 (first day below) → no_halt',
    detectConsecutiveLimitDownHalt([80, 150, 200], 3, 100),
    'no_halt'
  );

  // 取最后 N 天 (历史窗口外不计)
  assertEqual(
    'halt: tail-window 5 entries N=3 last 3 trigger → halt_buy',
    detectConsecutiveLimitDownHalt([10, 20, 150, 200, 300], 3, 100),
    'halt_buy'
  );
  assertEqual(
    'halt: tail-window 5 entries N=3 last day below → no_halt',
    detectConsecutiveLimitDownHalt([300, 300, 300, 300, 50], 3, 100),
    'no_halt'
  );

  // N=1 (单日恐慌)
  assertEqual(
    'halt: N=1 single day >threshold → halt_buy',
    detectConsecutiveLimitDownHalt([101], 1, 100),
    'halt_buy'
  );
  assertEqual(
    'halt: N=1 single day == threshold → no_halt',
    detectConsecutiveLimitDownHalt([100], 1, 100),
    'no_halt'
  );

  // 0 是合法 count (零跌停股, 显然不触发)
  assertEqual(
    'halt: 0/0/0 → no_halt',
    detectConsecutiveLimitDownHalt([0, 0, 0], 3, 100),
    'no_halt'
  );

  // 阈值 = 0 (任何 >0 都触发)
  assertEqual(
    'halt: threshold=0 + 1/1/1 → halt_buy',
    detectConsecutiveLimitDownHalt([1, 1, 1], 3, 0),
    'halt_buy'
  );
  assertEqual(
    'halt: threshold=0 + 0/0/0 → no_halt (strict >)',
    detectConsecutiveLimitDownHalt([0, 0, 0], 3, 0),
    'no_halt'
  );
}

async function testPickRegimeAlertsHaltBuy() {
  const cfg = { ...DEFAULT_MARKET_REGIME_ALERT_CONFIG };

  // ★ HALT_BUY only (limit_down_counts trigger; 跌幅 / MA 全无)
  const haltOnly = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.05,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
    limit_down_counts: [150, 200, 300],
  });
  assertEqual('pick: halt only → 1 alert', haltOnly.length, 1);
  assertEqual('pick: halt only type HALT_BUY', haltOnly[0].type, 'HALT_BUY');
  assertEqual('pick: halt only level CRITICAL', haltOnly[0].level, 'CRITICAL');
  assertEqual(
    'pick: halt sentinel symbol',
    haltOnly[0].symbol,
    'SYSTEM:MARKET_REGIME_HALT_BUY'
  );
  assert('pick: halt message contains 暂停建仓', haltOnly[0].message.includes('暂停建仓'));
  assert('pick: halt message contains 150', haltOnly[0].message.includes('150'));

  // Boundary: 100/100/100 (= threshold) → 不触发
  const haltBoundary = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.05,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
    limit_down_counts: [100, 100, 100],
  });
  assertEqual('pick: halt boundary 100=thr → 0 (strict >)', haltBoundary.length, 0);

  // 数据不足 → 不触发
  const haltShort = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.05,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
    limit_down_counts: [500, 500],
  });
  assertEqual('pick: halt only 2 days N=3 → 0 (unknown)', haltShort.length, 0);

  // limit_down_counts 未传 → 不触发
  const haltMissing = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.05,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
  });
  assertEqual('pick: halt counts undefined → 0', haltMissing.length, 0);

  // enable_halt_buy_on_panic=false → 即使触发条件也不产 HALT_BUY
  const haltDisabled = pickRegimeAlerts({
    config: { ...cfg, enable_halt_buy_on_panic: false },
    benchmark_name: '上证指数',
    return_3d_pct: -0.01,
    return_20d_pct: -0.05,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
    limit_down_counts: [200, 300, 400],
  });
  assertEqual('pick: halt disabled → 0', haltDisabled.length, 0);

  // ★ 多信号并列 — DROP_3D + HALT_BUY 同时触发 (恐慌日通常伴随大盘跌幅)
  const both = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.08,
    return_20d_pct: -0.05,
    ma20_today: null,
    ma60_today: null,
    ma20_yesterday: null,
    ma60_yesterday: null,
    limit_down_counts: [150, 200, 300],
  });
  assertEqual('pick: drop3d + halt_buy → 2 alerts', both.length, 2);
  const halt = both.find(a => a.type === 'HALT_BUY');
  const drop3d = both.find(a => a.type === 'DROP_3D');
  assert('pick: drop3d present in multi', !!drop3d);
  assert('pick: halt_buy present in multi', !!halt);
  assertEqual('pick: halt_buy level CRITICAL in multi', halt?.level, 'CRITICAL');

  // 4 信号全触发 (典型恐慌日, AC 验所有维度互不抢)
  const allFour = pickRegimeAlerts({
    config: cfg,
    benchmark_name: '上证指数',
    return_3d_pct: -0.08,
    return_20d_pct: -0.18,
    ma20_today: 95,
    ma60_today: 100,
    ma20_yesterday: 101,
    ma60_yesterday: 100,
    limit_down_counts: [150, 200, 300],
  });
  assertEqual('pick: all 4 triggered → 4', allFour.length, 4);
  const types = allFour.map(a => a.type).sort();
  assertEqual(
    'pick: all 4 types complete',
    types,
    ['DEATH_CROSS', 'DROP_20D', 'DROP_3D', 'HALT_BUY']
  );
}

async function testNormalizeHaltBuyConfig() {
  // defaults — 新增 3 字段
  assertEqual(
    'normalize default enable_halt_buy_on_panic == true',
    DEFAULT_MARKET_REGIME_ALERT_CONFIG.enable_halt_buy_on_panic,
    true
  );
  assertEqual(
    'normalize default halt_buy_limit_down_count_threshold == 100',
    DEFAULT_MARKET_REGIME_ALERT_CONFIG.halt_buy_limit_down_count_threshold,
    100
  );
  assertEqual(
    'normalize default halt_buy_consecutive_days == 3',
    DEFAULT_MARKET_REGIME_ALERT_CONFIG.halt_buy_consecutive_days,
    3
  );

  // explicit valid override
  const valid = normalizeMarketRegimeAlertConfig({
    enable_halt_buy_on_panic: false,
    halt_buy_limit_down_count_threshold: 200,
    halt_buy_consecutive_days: 5,
  });
  assertEqual('normalize: halt disabled saved', valid.enable_halt_buy_on_panic, false);
  assertEqual('normalize: threshold 200 saved', valid.halt_buy_limit_down_count_threshold, 200);
  assertEqual('normalize: consecutive 5 saved', valid.halt_buy_consecutive_days, 5);

  // garbage → defaults
  const bad = normalizeMarketRegimeAlertConfig({
    enable_halt_buy_on_panic: 'yes',
    halt_buy_limit_down_count_threshold: -5,
    halt_buy_consecutive_days: 0,
  });
  assertEqual(
    'normalize: non-bool halt enable → default',
    bad.enable_halt_buy_on_panic,
    true
  );
  assertEqual('normalize: negative thr → default 100', bad.halt_buy_limit_down_count_threshold, 100);
  assertEqual('normalize: 0 days → default 3', bad.halt_buy_consecutive_days, 3);

  const bad2 = normalizeMarketRegimeAlertConfig({
    halt_buy_limit_down_count_threshold: 'abc',
    halt_buy_consecutive_days: 3.5, // 非整数
  });
  assertEqual(
    'normalize: NaN thr → default',
    bad2.halt_buy_limit_down_count_threshold,
    100
  );
  assertEqual('normalize: non-int days → default', bad2.halt_buy_consecutive_days, 3);
}

async function testBuildHaltBuyMessage() {
  const msg = buildAlertMessage({
    type: 'HALT_BUY',
    benchmark_name: '上证指数',
    reduce_position_pct: 0.3,
    limit_down_counts: [150, 200, 300],
    limit_down_threshold: 100,
    consecutive_days: 3,
  });
  assert('halt msg contains 恐慌', msg.includes('恐慌'));
  assert('halt msg contains 暂停建仓', msg.includes('暂停建仓'));
  assert('halt msg contains 100', msg.includes('100'));
  assert('halt msg contains 150/200/300', msg.includes('150/200/300'));
  assert('halt msg contains CRITICAL', msg.includes('CRITICAL'));
  assert('halt msg contains 连续 3 日', msg.includes('连续 3 日'));
}

async function testStatusHaltBuyTrigger() {
  // 4 bars makes return_3d -6% (DROP_3D triggers), 同时 limit_down_counts 触发 HALT_BUY.
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({
    benchmarkBars: bars,
    limitDownCounts: [150, 200, 300],
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assert('status halt: limit_down_counts populated', Array.isArray(s.limit_down_counts));
  assertEqual('status halt: limit_down_counts.length == 3', s.limit_down_counts?.length, 3);
  // 2 alerts: DROP_3D + HALT_BUY
  assertEqual('status halt: 2 alerts (drop3d + halt)', s.alerts.length, 2);
  const halt = s.alerts.find(a => a.type === 'HALT_BUY');
  assert('status halt: HALT_BUY present', !!halt);
  assertEqual('status halt: HALT_BUY level CRITICAL', halt?.level, 'CRITICAL');
}

async function testStatusHaltBuyDisabledNoFetch() {
  // enable_halt_buy_on_panic=false → 不调 loadConsecutiveLimitDownCounts
  // (limit_down_counts 字段保持 null + 即使 fake source 有数据也不发 HALT_BUY)
  const bars = makeBars(4, i => (i < 3 ? 100 : 99));
  const state = emptyState({
    benchmarkBars: bars,
    limitDownCounts: [200, 300, 400], // would trigger if asked
    globalConfig: {
      ...DEFAULT_MARKET_REGIME_ALERT_CONFIG,
      enable_halt_buy_on_panic: false,
    },
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertEqual('status halt-disabled: limit_down_counts null', s.limit_down_counts, null);
  const halt = s.alerts.find(a => a.type === 'HALT_BUY');
  assertEqual('status halt-disabled: no HALT_BUY alert', halt, undefined);
}

async function testStatusHaltBuyFetchFailureFailOpen() {
  // loadConsecutiveLimitDownCounts 抛错 → status.limit_down_counts=null + 不影响其它 3 信号
  const bars = makeBars(4, i => (i < 3 ? 100 : 94));
  const state = emptyState({
    benchmarkBars: bars,
    loadLimitDownShouldThrow: true,
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertEqual('status halt-throw: limit_down_counts null', s.limit_down_counts, null);
  // DROP_3D 仍然触发 (3 类原信号不受影响)
  assertEqual('status halt-throw: DROP_3D still triggered', s.alerts.length, 1);
  assertEqual('status halt-throw: alert type DROP_3D', s.alerts[0].type, 'DROP_3D');
}

async function testStatusHaltBuyInsufficientData() {
  // limit_down_counts=[]（DataSource 返空, 数据不足）→ null + 不触发 HALT_BUY
  const bars = makeBars(4, i => (i < 3 ? 100 : 99));
  const state = emptyState({
    benchmarkBars: bars,
    limitDownCounts: [], // empty
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const s = await svc.getMarketRegimeStatus();
  assertEqual('status halt-empty: limit_down_counts null', s.limit_down_counts, null);
  const halt = s.alerts.find(a => a.type === 'HALT_BUY');
  assertEqual('status halt-empty: no HALT_BUY', halt, undefined);
}

async function testEvaluateHaltBuyFanOut() {
  // 全 CRITICAL HALT_BUY 信号触发 + 多用户 fan-out
  // mild stable bars 让 DROP_* / DEATH_CROSS 不触发 — 只让 HALT_BUY 单独跑.
  const bars = makeBars(4, () => 100);
  const state = emptyState({
    benchmarkBars: bars,
    userIds: [1, 2],
    limitDownCounts: [150, 200, 300],
  });
  const svc = new MarketRegimeAlertService(makeFakeSource(state));
  const r = await svc.evaluateAfterOpen();
  assertEqual('evaluate halt: 1 alert in status', r.status.alerts.length, 1);
  assertEqual('evaluate halt: alert type HALT_BUY', r.status.alerts[0].type, 'HALT_BUY');
  assertEqual('evaluate halt: scanned 2', r.scanned_users, 2);
  assertEqual('evaluate halt: alerted 2', r.alerted_users, 2);
  assertEqual('evaluate halt: 2 alerts written total', state.alerts.length, 2);
  assertEqual(
    'evaluate halt: written alert level CRITICAL',
    state.alerts[0].level,
    'CRITICAL'
  );
  assertEqual(
    'evaluate halt: written alert symbol SYSTEM:MARKET_REGIME_HALT_BUY',
    state.alerts[0].symbol,
    'SYSTEM:MARKET_REGIME_HALT_BUY'
  );
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
  // US-132 [PR-017] — HALT_BUY 4th detector
  await testDetectConsecutiveLimitDownHalt();
  await testPickRegimeAlertsHaltBuy();
  await testNormalizeHaltBuyConfig();
  await testBuildHaltBuyMessage();
  await testStatusHaltBuyTrigger();
  await testStatusHaltBuyDisabledNoFetch();
  await testStatusHaltBuyFetchFailureFailOpen();
  await testStatusHaltBuyInsufficientData();
  await testEvaluateHaltBuyFanOut();

  const total = passed + failed;
  console.log(`\n${passed} ok, ${failed} failed (of ${total})`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test driver crashed:', err);
  process.exit(2);
});
