/**
 * DrawdownCircuitBreaker 单元测试 (US-049)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/drawdown-circuit-breaker.test.ts
 *
 * 完全脱离 DB：注入 fake DrawdownBreakerDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_DRAWDOWN_BREAKER_CONFIG
 *   - 纯函数：
 *     computePeakValue / computeDrawdownPct / pickDrawdownLevel /
 *     computeGainRatio / pickLevel2TrimTargets / pickLevel3LiquidateTargets /
 *     normalizeDrawdownBreakerConfig / buildDrawdownMessage / isPauseActive
 *   - guard.evaluateAfterClose() end-to-end：
 *     - LEVEL_1 触发（≥10%）→ 写 paused_until + 写 RiskAlert
 *     - LEVEL_2 触发（≥15%）→ 选涨幅最大的 50% 持仓 + 写 RiskAlert
 *     - LEVEL_3 触发（≥20%）→ 全持仓 trigger + 写 RiskAlert
 *     - boundary case：恰好等于阈值（≥ 包含）
 *     - peak < current → drawdown=0 → NONE
 *     - 用户禁用 → NONE
 *     - 用户无 portfolio → NONE
 *     - 多用户 / 单用户失败 try/catch 隔离
 *     - dry_run=true → 不写 RiskAlert / paused_until
 *     - writeAlert 失败不应该掩盖 trigger
 *     - LEVEL_3 优先于 LEVEL_2 / LEVEL_2 优先于 LEVEL_1（高级别覆盖低）
 *   - guard.checkBuyAllowed() end-to-end：
 *     - 暂停未生效 → ok=true
 *     - 暂停生效 + 新开仓 → ok=false
 *     - 暂停生效 + 加仓既有持仓 → ok=true
 *     - 暂停过期 → ok=true
 *     - paused_until = null / 非法 → ok=true
 *     - DB outage → fail open（保守放行）
 *     - 用户禁用 → ok=true 即使有 paused_until
 *   - getConfig / updateConfig：
 *     - 默认值落地
 *     - normalize 兼容性（>1 / 负 / NaN → 默认；非 boolean enabled → 默认）
 *   - clearPause：手动清除 paused_until
 */

import {
  DEFAULT_DRAWDOWN_BREAKER_CONFIG,
  DrawdownBreakerConfig,
  DrawdownBreakerDataSource,
  DrawdownCircuitBreaker,
  DrawdownPositionSnapshot,
  PortfolioHeader,
  PortfolioSnapshotRow,
  buildDrawdownMessage,
  computeDrawdownPct,
  computeGainRatio,
  computePeakValue,
  isPauseActive,
  normalizeDrawdownBreakerConfig,
  pickDrawdownLevel,
  pickLevel2TrimTargets,
  pickLevel3LiquidateTargets,
} from '../../src/portfolio/risk/DrawdownCircuitBreaker';

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
  userIds: number[];
  configs: Record<number, DrawdownBreakerConfig>;
  portfolios: Record<number, PortfolioHeader | null>;
  snapshotsByPortfolio: Record<number, PortfolioSnapshotRow[]>;
  positionsByUser: Record<number, DrawdownPositionSnapshot[]>;
  pausedUntilByUser: Record<number, string | null>;
  alerts: Array<{
    user_id: number;
    portfolio_ids: number[];
    symbol: string;
    name: string;
    message: string;
  }>;
  savedPausedUntil: Array<{ user_id: number; paused_until: string | null }>;
  /** Force loadConfig on this user to throw. */
  loadConfigShouldThrowForUser?: number;
  /** Force loadPortfolio on this user to throw. */
  loadPortfolioShouldThrowForUser?: number;
  /** Force writeAlert to throw. */
  writeAlertShouldThrow?: boolean;
  /** Force savePausedUntil to throw. */
  savePausedUntilShouldThrow?: boolean;
  /** Force loadPausedUntil to throw (for checkBuyAllowed fail-open test). */
  loadPausedUntilShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): DrawdownBreakerDataSource {
  return {
    async loadAllUserIdsWithPortfolios() {
      return [...state.userIds];
    },
    async loadConfig(user_id) {
      if (state.loadConfigShouldThrowForUser === user_id) {
        throw new Error(`fake config outage user=${user_id}`);
      }
      return state.configs[user_id] ?? { ...DEFAULT_DRAWDOWN_BREAKER_CONFIG };
    },
    async saveConfig(user_id, config) {
      state.configs[user_id] = { ...config };
      return { ...config };
    },
    async loadPortfolio(user_id) {
      if (state.loadPortfolioShouldThrowForUser === user_id) {
        throw new Error(`fake portfolio outage user=${user_id}`);
      }
      return state.portfolios[user_id] ?? null;
    },
    async loadRecentSnapshots(portfolio_id) {
      return [...(state.snapshotsByPortfolio[portfolio_id] || [])];
    },
    async loadOpenPositions(user_id) {
      return (state.positionsByUser[user_id] || []).map(p => ({ ...p }));
    },
    async loadPausedUntil(user_id) {
      if (state.loadPausedUntilShouldThrow) {
        throw new Error('fake pause-load outage');
      }
      return state.pausedUntilByUser[user_id] ?? null;
    },
    async savePausedUntil(user_id, pausedUntil) {
      if (state.savePausedUntilShouldThrow) {
        throw new Error('fake pause-save outage');
      }
      state.savedPausedUntil.push({ user_id, paused_until: pausedUntil });
      state.pausedUntilByUser[user_id] = pausedUntil;
    },
    async hasExistingPosition(user_id, symbol) {
      const positions = state.positionsByUser[user_id] || [];
      return positions.some(p => p.symbol === symbol && p.quantity > 0);
    },
    async writeAlert(input) {
      if (state.writeAlertShouldThrow) {
        throw new Error('fake alert outage');
      }
      state.alerts.push({ ...input });
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    userIds: [],
    configs: {},
    portfolios: {},
    snapshotsByPortfolio: {},
    positionsByUser: {},
    pausedUntilByUser: {},
    alerts: [],
    savedPausedUntil: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Tests — constants
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual('DEFAULT enabled == true', DEFAULT_DRAWDOWN_BREAKER_CONFIG.enabled, true);
  assertEqual('DEFAULT level1_pct == 0.10', DEFAULT_DRAWDOWN_BREAKER_CONFIG.level1_pct, 0.1);
  assertEqual('DEFAULT level2_pct == 0.15', DEFAULT_DRAWDOWN_BREAKER_CONFIG.level2_pct, 0.15);
  assertEqual('DEFAULT level3_pct == 0.20', DEFAULT_DRAWDOWN_BREAKER_CONFIG.level3_pct, 0.2);
  assertEqual(
    'DEFAULT level1_pause_ms == 24h',
    DEFAULT_DRAWDOWN_BREAKER_CONFIG.level1_pause_ms,
    24 * 60 * 60 * 1000
  );
  // 防御性：默认对象应不可 mutate
  let mutationThrew = false;
  try {
    (DEFAULT_DRAWDOWN_BREAKER_CONFIG as any).level1_pct = 0.5;
  } catch {
    mutationThrew = true;
  }
  assert(
    'DEFAULT is frozen (strict throws OR silent no-op)',
    mutationThrew || DEFAULT_DRAWDOWN_BREAKER_CONFIG.level1_pct === 0.1
  );
  assertEqual(
    'DEFAULT.level1_pct after attempted mutation still == 0.10',
    DEFAULT_DRAWDOWN_BREAKER_CONFIG.level1_pct,
    0.1
  );
}

// ---------------------------------------------------------------------------
//  Tests — pure helpers
// ---------------------------------------------------------------------------

async function testComputePeakValue() {
  // current > all snapshots
  assertEqual(
    'peak: snapshots [100,110,105], current 120 → 120',
    computePeakValue(
      [
        { date: '2024-01-01', total_value: 100 },
        { date: '2024-01-02', total_value: 110 },
        { date: '2024-01-03', total_value: 105 },
      ],
      120
    ),
    120
  );
  // snapshots max > current
  assertEqual(
    'peak: snapshots [100,200,150], current 120 → 200',
    computePeakValue(
      [
        { date: '2024-01-01', total_value: 100 },
        { date: '2024-01-02', total_value: 200 },
        { date: '2024-01-03', total_value: 150 },
      ],
      120
    ),
    200
  );
  // no snapshots
  assertEqual('peak: no snapshots, current 100 → 100', computePeakValue([], 100), 100);
  // snapshots with garbage values filtered
  assertEqual(
    'peak: snapshots with NaN / negative filtered',
    computePeakValue(
      [
        { date: '2024-01-01', total_value: NaN },
        { date: '2024-01-02', total_value: -50 },
        { date: '2024-01-03', total_value: 150 },
      ],
      120
    ),
    150
  );
  // all garbage current
  assertEqual('peak: current NaN, snapshots empty → 0', computePeakValue([], NaN), 0);
  assertEqual('peak: current 0, snapshots empty → 0', computePeakValue([], 0), 0);
  // current negative → treated as 0 but snapshots win
  assertEqual(
    'peak: current negative, snapshot 100 → 100',
    computePeakValue([{ date: '2024-01-01', total_value: 100 }], -50),
    100
  );
}

async function testComputeDrawdownPct() {
  assertClose('drawdown: peak 100, current 90 → 0.10', computeDrawdownPct(100, 90), 0.1);
  assertClose('drawdown: peak 200, current 170 → 0.15', computeDrawdownPct(200, 170), 0.15);
  assertClose('drawdown: peak 100, current 80 → 0.20', computeDrawdownPct(100, 80), 0.2);
  // current >= peak → 0
  assertEqual('drawdown: peak 100, current 100 → 0', computeDrawdownPct(100, 100), 0);
  assertEqual('drawdown: peak 100, current 150 → 0', computeDrawdownPct(100, 150), 0);
  // peak <= 0 → 0 (no divide by zero)
  assertEqual('drawdown: peak 0 → 0', computeDrawdownPct(0, 50), 0);
  assertEqual('drawdown: peak -10 → 0', computeDrawdownPct(-10, 50), 0);
  // NaN / Infinity defense
  assertEqual('drawdown: peak NaN → 0', computeDrawdownPct(NaN, 50), 0);
  assertEqual('drawdown: current NaN → 0', computeDrawdownPct(100, NaN), 0);
}

async function testPickDrawdownLevel() {
  const cfg = { ...DEFAULT_DRAWDOWN_BREAKER_CONFIG };
  // exactly at thresholds (≥ includes boundary)
  assertEqual('level: 0.10 exactly → LEVEL_1', pickDrawdownLevel(0.1, cfg), 'LEVEL_1');
  assertEqual('level: 0.15 exactly → LEVEL_2', pickDrawdownLevel(0.15, cfg), 'LEVEL_2');
  assertEqual('level: 0.20 exactly → LEVEL_3', pickDrawdownLevel(0.2, cfg), 'LEVEL_3');
  // just below
  assertEqual('level: 0.0999 → NONE', pickDrawdownLevel(0.0999, cfg), 'NONE');
  assertEqual('level: 0.1499 → LEVEL_1', pickDrawdownLevel(0.1499, cfg), 'LEVEL_1');
  assertEqual('level: 0.1999 → LEVEL_2', pickDrawdownLevel(0.1999, cfg), 'LEVEL_2');
  // way above
  assertEqual('level: 0.50 → LEVEL_3', pickDrawdownLevel(0.5, cfg), 'LEVEL_3');
  // boundary edge cases
  assertEqual('level: 0 → NONE', pickDrawdownLevel(0, cfg), 'NONE');
  assertEqual('level: negative → NONE', pickDrawdownLevel(-0.05, cfg), 'NONE');
  assertEqual('level: NaN → NONE', pickDrawdownLevel(NaN, cfg), 'NONE');
}

async function testComputeGainRatio() {
  assertClose(
    'gain: cost 1000 (100*10), market 1100 → 0.10',
    computeGainRatio({
      id: 1,
      symbol: 'A',
      quantity: 100,
      avg_cost: 10,
      current_price: 11,
      market_value: 1100,
    }),
    0.1
  );
  assertClose(
    'gain: cost 1000, market 900 → -0.10 (loss)',
    computeGainRatio({
      id: 1,
      symbol: 'A',
      quantity: 100,
      avg_cost: 10,
      current_price: 9,
      market_value: 900,
    }),
    -0.1
  );
  // cost = 0 (defensive)
  assertEqual(
    'gain: cost 0 → 0',
    computeGainRatio({
      id: 1,
      symbol: 'A',
      quantity: 0,
      avg_cost: 0,
      current_price: 10,
      market_value: 0,
    }),
    0
  );
  // market_value NaN defended
  assertEqual(
    'gain: market NaN → -1 (treated as 0)',
    computeGainRatio({
      id: 1,
      symbol: 'A',
      quantity: 100,
      avg_cost: 10,
      current_price: 11,
      market_value: NaN,
    }),
    -1
  );
}

async function testPickLevel2TrimTargets() {
  // 4 positions, half = 2; pick top-2 gains
  const positions: DrawdownPositionSnapshot[] = [
    { id: 1, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 }, // +10%
    { id: 2, symbol: 'B', quantity: 100, avg_cost: 10, current_price: 12, market_value: 1200 }, // +20%
    { id: 3, symbol: 'C', quantity: 100, avg_cost: 10, current_price: 9, market_value: 900 }, // -10%
    { id: 4, symbol: 'D', quantity: 100, avg_cost: 10, current_price: 15, market_value: 1500 }, // +50%
  ];
  const trims = pickLevel2TrimTargets(positions);
  assertEqual('LEVEL_2 trim: 4 positions → 2 picked', trims.length, 2);
  assertEqual('LEVEL_2 trim: first pick D (+50%)', trims[0].symbol, 'D');
  assertEqual('LEVEL_2 trim: second pick B (+20%)', trims[1].symbol, 'B');

  // 3 positions, half = ceil(1.5) = 2
  const trims3 = pickLevel2TrimTargets(positions.slice(0, 3));
  assertEqual('LEVEL_2 trim: 3 positions → 2 picked (ceil)', trims3.length, 2);

  // 1 position, half = ceil(0.5) = 1 (strong disposal path)
  const trims1 = pickLevel2TrimTargets([positions[0]]);
  assertEqual('LEVEL_2 trim: 1 position → 1 picked', trims1.length, 1);

  // 0 positions
  const trims0 = pickLevel2TrimTargets([]);
  assertEqual('LEVEL_2 trim: 0 positions → empty', trims0.length, 0);

  // tie-break by symbol asc
  const tiePositions: DrawdownPositionSnapshot[] = [
    { id: 1, symbol: 'B', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
    { id: 2, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
  ];
  const tieTrims = pickLevel2TrimTargets(tiePositions);
  assertEqual('LEVEL_2 trim: tie-break by symbol asc — A first', tieTrims[0].symbol, 'A');

  // filter out quantity = 0
  const withZero: DrawdownPositionSnapshot[] = [
    ...positions,
    { id: 5, symbol: 'Z', quantity: 0, avg_cost: 10, current_price: 100, market_value: 0 },
  ];
  const trimsFiltered = pickLevel2TrimTargets(withZero);
  assert('LEVEL_2 trim: quantity=0 filtered out', !trimsFiltered.some(t => t.symbol === 'Z'));
}

async function testPickLevel3LiquidateTargets() {
  const positions: DrawdownPositionSnapshot[] = [
    { id: 1, symbol: 'B', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
    { id: 2, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 9, market_value: 900 },
    { id: 3, symbol: 'C', quantity: 0, avg_cost: 10, current_price: 12, market_value: 0 },
  ];
  const liq = pickLevel3LiquidateTargets(positions);
  assertEqual('LEVEL_3 liquidate: 2 quantity>0 positions', liq.length, 2);
  assertEqual('LEVEL_3 liquidate: sort by symbol asc — A first', liq[0].symbol, 'A');
  assertEqual('LEVEL_3 liquidate: B second', liq[1].symbol, 'B');
}

async function testNormalizeDrawdownBreakerConfig() {
  // empty / null → defaults
  assertEqual('normalize: null → defaults', normalizeDrawdownBreakerConfig(null), {
    ...DEFAULT_DRAWDOWN_BREAKER_CONFIG,
  });
  assertEqual('normalize: undefined → defaults', normalizeDrawdownBreakerConfig(undefined), {
    ...DEFAULT_DRAWDOWN_BREAKER_CONFIG,
  });
  assertEqual('normalize: {} → defaults', normalizeDrawdownBreakerConfig({}), {
    ...DEFAULT_DRAWDOWN_BREAKER_CONFIG,
  });
  // valid partial input
  const c = normalizeDrawdownBreakerConfig({
    level1_pct: 0.05,
    level2_pct: 0.12,
    level3_pct: 0.25,
  });
  assertEqual('normalize: partial valid → kept', c.level1_pct, 0.05);
  assertEqual('normalize: partial valid level2 → 0.12', c.level2_pct, 0.12);
  assertEqual('normalize: partial valid level3 → 0.25', c.level3_pct, 0.25);
  assertEqual('normalize: missing enabled → DEFAULT true', c.enabled, true);
  // invalid pct (negative / >1 / NaN / non-number) → default
  const bad = normalizeDrawdownBreakerConfig({
    level1_pct: -0.1,
    level2_pct: 1.5,
    level3_pct: 'abc',
    level1_pause_ms: -1,
    enabled: 'yes',
  });
  assertEqual('normalize: negative pct → default', bad.level1_pct, 0.1);
  assertEqual('normalize: >1 pct → default', bad.level2_pct, 0.15);
  assertEqual('normalize: non-number pct → default', bad.level3_pct, 0.2);
  assertEqual(
    'normalize: negative pause_ms → default',
    bad.level1_pause_ms,
    24 * 60 * 60 * 1000
  );
  assertEqual('normalize: non-boolean enabled → default true', bad.enabled, true);
  // explicit false enabled preserved
  const disabled = normalizeDrawdownBreakerConfig({ enabled: false });
  assertEqual('normalize: explicit false enabled preserved', disabled.enabled, false);
  // pct = 0 (block all) and pct = 1 (never) are valid safe-modes
  const safe = normalizeDrawdownBreakerConfig({ level1_pct: 0, level3_pct: 1 });
  assertEqual('normalize: pct 0 preserved (safe-mode)', safe.level1_pct, 0);
  assertEqual('normalize: pct 1 preserved (never-trigger mode)', safe.level3_pct, 1);
  // non-integer pause_ms → default
  const fract = normalizeDrawdownBreakerConfig({ level1_pause_ms: 60.5 });
  assertEqual(
    'normalize: non-integer pause_ms → default',
    fract.level1_pause_ms,
    24 * 60 * 60 * 1000
  );
}

async function testBuildDrawdownMessage() {
  const msg = buildDrawdownMessage({
    level: 'LEVEL_2',
    peak_value: 250000,
    current_value: 200000,
    drawdown_pct: 0.2,
    threshold_pct: 0.15,
    action_detail: '已建议减仓至 50%（3 只标的）。',
  });
  assert('msg contains LEVEL_2', msg.includes('LEVEL_2'));
  assert('msg contains peak', msg.includes('250000'));
  assert('msg contains current', msg.includes('200000'));
  assert('msg contains 20.00%', msg.includes('20.00%'));
  assert('msg contains 15.00%', msg.includes('15.00%'));
  assert('msg contains action_detail', msg.includes('已建议减仓至 50%'));
}

async function testIsPauseActive() {
  const now = 1_000_000_000_000;
  // null / undefined / non-string
  assertEqual('pause: null → false', isPauseActive(null, now), false);
  assertEqual('pause: undefined → false', isPauseActive(undefined, now), false);
  assertEqual('pause: non-iso string → false', isPauseActive('garbage', now), false);
  // expired
  const past = new Date(now - 1000).toISOString();
  assertEqual('pause: expired → false', isPauseActive(past, now), false);
  // active
  const future = new Date(now + 1000).toISOString();
  assertEqual('pause: future → true', isPauseActive(future, now), true);
  // exact equal → false (strict <)
  const exact = new Date(now).toISOString();
  assertEqual('pause: exactly now → false (strict <)', isPauseActive(exact, now), false);
}

// ---------------------------------------------------------------------------
//  Tests — guard.evaluateAfterClose end-to-end
// ---------------------------------------------------------------------------

async function testEvaluateLevel1Trigger() {
  // peak = 100k, current = 90k → drawdown = 10% → LEVEL_1
  const state = emptyState({
    userIds: [42],
    portfolios: { 42: { id: 1, total_value: 90000 } },
    snapshotsByPortfolio: {
      1: [
        { date: '2024-01-01', total_value: 80000 },
        { date: '2024-01-15', total_value: 100000 },
      ],
    },
    positionsByUser: {
      42: [
        { id: 11, symbol: '600519', quantity: 100, avg_cost: 100, current_price: 90, market_value: 9000 },
      ],
    },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('L1: scanned 1 user', r.scanned_users, 1);
  assertEqual('L1: triggered 1 user', r.triggered_users, 1);
  assertEqual('L1: per_user[0].level == LEVEL_1', r.per_user[0].level, 'LEVEL_1');
  assertClose('L1: drawdown_pct ≈ 0.10', r.per_user[0].drawdown_pct, 0.1);
  assertEqual('L1: triggers is empty (only pause, no SELL)', r.per_user[0].triggers.length, 0);
  assert('L1: paused_until set', !!r.per_user[0].paused_until);
  assertEqual('L1: alerts written 1', state.alerts.length, 1);
  assert('L1: alert message contains LEVEL_1', state.alerts[0].message.includes('LEVEL_1'));
  assertEqual('L1: savePausedUntil called once', state.savedPausedUntil.length, 1);
  assertEqual('L1: saved user_id == 42', state.savedPausedUntil[0].user_id, 42);
  assert(
    'L1: saved paused_until is ISO string',
    typeof state.savedPausedUntil[0].paused_until === 'string'
  );
}

async function testEvaluateLevel2Trigger() {
  // peak = 200k, current = 170k → drawdown = 15% → LEVEL_2
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 170000 } },
    snapshotsByPortfolio: {
      1: [{ date: '2024-01-15', total_value: 200000 }],
    },
    positionsByUser: {
      1: [
        // 4 positions, half = 2 → top 2 gains kept (D +50%, B +20%)
        { id: 11, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
        { id: 12, symbol: 'B', quantity: 100, avg_cost: 10, current_price: 12, market_value: 1200 },
        { id: 13, symbol: 'C', quantity: 100, avg_cost: 10, current_price: 9, market_value: 900 },
        { id: 14, symbol: 'D', quantity: 100, avg_cost: 10, current_price: 15, market_value: 1500 },
      ],
    },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('L2: triggered 1 user', r.triggered_users, 1);
  assertEqual('L2: per_user[0].level == LEVEL_2', r.per_user[0].level, 'LEVEL_2');
  assertClose('L2: drawdown_pct ≈ 0.15', r.per_user[0].drawdown_pct, 0.15);
  assertEqual('L2: triggers length == 2 (top half of 4)', r.per_user[0].triggers.length, 2);
  assertEqual('L2: trigger[0].symbol == D (+50% gain)', r.per_user[0].triggers[0].symbol, 'D');
  assertEqual('L2: trigger[1].symbol == B (+20% gain)', r.per_user[0].triggers[1].symbol, 'B');
  assertEqual('L2: trigger reason == "减仓 (LEVEL_2)"', r.per_user[0].triggers[0].reason, '减仓 (LEVEL_2)');
  assertEqual('L2: aggregate triggers list len == 2', r.triggers.length, 2);
  assertEqual('L2: alerts written 1', state.alerts.length, 1);
  assert('L2: alert message contains LEVEL_2', state.alerts[0].message.includes('LEVEL_2'));
  assert(
    'L2: alert message contains "减仓"',
    state.alerts[0].message.includes('减仓')
  );
  // No paused_until on LEVEL_2
  assertEqual('L2: savePausedUntil NOT called', state.savedPausedUntil.length, 0);
}

async function testEvaluateLevel3Trigger() {
  // peak = 200k, current = 160k → drawdown = 20% → LEVEL_3
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 160000 } },
    snapshotsByPortfolio: {
      1: [{ date: '2024-01-15', total_value: 200000 }],
    },
    positionsByUser: {
      1: [
        { id: 11, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
        { id: 12, symbol: 'B', quantity: 100, avg_cost: 10, current_price: 12, market_value: 1200 },
        { id: 13, symbol: 'C', quantity: 100, avg_cost: 10, current_price: 9, market_value: 900 },
      ],
    },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('L3: level == LEVEL_3', r.per_user[0].level, 'LEVEL_3');
  assertClose('L3: drawdown_pct ≈ 0.20', r.per_user[0].drawdown_pct, 0.2);
  assertEqual('L3: triggers length == 3 (full liquidation)', r.per_user[0].triggers.length, 3);
  assertEqual('L3: trigger[0].symbol == A (alphabetical)', r.per_user[0].triggers[0].symbol, 'A');
  assertEqual('L3: trigger[1].symbol == B', r.per_user[0].triggers[1].symbol, 'B');
  assertEqual('L3: trigger[2].symbol == C', r.per_user[0].triggers[2].symbol, 'C');
  assertEqual(
    'L3: trigger reason == "清仓 (LEVEL_3)"',
    r.per_user[0].triggers[0].reason,
    '清仓 (LEVEL_3)'
  );
  assertEqual('L3: alerts written 1', state.alerts.length, 1);
  assert('L3: alert message contains LEVEL_3', state.alerts[0].message.includes('LEVEL_3'));
  assert('L3: alert message contains "清仓"', state.alerts[0].message.includes('清仓'));
}

async function testEvaluateNoTrigger() {
  // peak = 100, current = 95 → drawdown 5% (below LEVEL_1) → NONE
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 95000 } },
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 100000 }] },
    positionsByUser: { 1: [] },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('NONE: triggered 0 users', r.triggered_users, 0);
  assertEqual('NONE: per_user[0].level == NONE', r.per_user[0].level, 'NONE');
  assertEqual('NONE: no triggers', r.triggers.length, 0);
  assertEqual('NONE: no alerts', state.alerts.length, 0);
  assertEqual('NONE: no pause set', state.savedPausedUntil.length, 0);
}

async function testEvaluateBoundary() {
  // Boundary: peak 100k, current 90k → exactly 10% → LEVEL_1
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 90000 } },
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 100000 }] },
    positionsByUser: { 1: [] },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('boundary 10% → LEVEL_1', r.per_user[0].level, 'LEVEL_1');

  // Boundary: 14.9999% → LEVEL_1 (NOT yet LEVEL_2)
  const state2 = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 85001 } }, // peak 100k drop 14.999%
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 100000 }] },
    positionsByUser: { 1: [] },
  });
  const guard2 = new DrawdownCircuitBreaker(makeFakeSource(state2));
  const r2 = await guard2.evaluateAfterClose({});
  assertEqual('boundary 14.999% → LEVEL_1 (not L2)', r2.per_user[0].level, 'LEVEL_1');

  // Boundary: 15% exact → LEVEL_2
  const state3 = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 85000 } },
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 100000 }] },
    positionsByUser: {
      1: [
        { id: 11, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
      ],
    },
  });
  const guard3 = new DrawdownCircuitBreaker(makeFakeSource(state3));
  const r3 = await guard3.evaluateAfterClose({});
  assertEqual('boundary 15% exact → LEVEL_2', r3.per_user[0].level, 'LEVEL_2');
}

async function testEvaluateUserDisabled() {
  const state = emptyState({
    userIds: [1],
    configs: {
      1: { ...DEFAULT_DRAWDOWN_BREAKER_CONFIG, enabled: false },
    },
    portfolios: { 1: { id: 1, total_value: 80000 } },
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 200000 }] },
    positionsByUser: {
      1: [{ id: 1, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 9, market_value: 900 }],
    },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('disabled: level == NONE', r.per_user[0].level, 'NONE');
  assertEqual('disabled: no alerts', state.alerts.length, 0);
  assertEqual('disabled: no pause', state.savedPausedUntil.length, 0);
}

async function testEvaluateNoPortfolio() {
  const state = emptyState({
    userIds: [99],
    portfolios: { 99: null },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('no portfolio: level == NONE', r.per_user[0].level, 'NONE');
  assertEqual('no portfolio: portfolio_id null', r.per_user[0].portfolio_id, null);
}

async function testEvaluateMultiUserIsolation() {
  // One user throws on loadConfig; others continue
  const state = emptyState({
    userIds: [1, 2, 3],
    loadConfigShouldThrowForUser: 2,
    portfolios: {
      1: { id: 1, total_value: 90000 }, // L1 trigger
      3: { id: 3, total_value: 100000 }, // no trigger
    },
    snapshotsByPortfolio: {
      1: [{ date: '2024-01-15', total_value: 100000 }],
      3: [{ date: '2024-01-15', total_value: 100000 }],
    },
    positionsByUser: { 1: [], 3: [] },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('multi: scanned 3', r.scanned_users, 3);
  assertEqual('multi: triggered 1 (only user 1)', r.triggered_users, 1);
  const u1 = r.per_user.find(u => u.user_id === 1);
  const u2 = r.per_user.find(u => u.user_id === 2);
  const u3 = r.per_user.find(u => u.user_id === 3);
  assertEqual('multi: u1 LEVEL_1', u1?.level, 'LEVEL_1');
  assertEqual('multi: u2 error captured', !!u2?.error, true);
  assertEqual('multi: u3 NONE', u3?.level, 'NONE');
  assertEqual('multi: 1 alert (only u1)', state.alerts.length, 1);
}

async function testEvaluateDryRun() {
  // LEVEL_3 trigger but dry_run=true → no alerts / no pause
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 75000 } },
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 100000 }] },
    positionsByUser: {
      1: [
        { id: 1, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
      ],
    },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({ dry_run: true });
  assertEqual('dry_run: level == LEVEL_3', r.per_user[0].level, 'LEVEL_3');
  assertEqual('dry_run: triggers still returned', r.per_user[0].triggers.length, 1);
  assertEqual('dry_run: NO alerts written', state.alerts.length, 0);
  assertEqual('dry_run: NO pause saved', state.savedPausedUntil.length, 0);
}

async function testEvaluateWriteAlertFailureNotMaskingTrigger() {
  // LEVEL_3 triggers; writeAlert throws; trigger still returned
  const state = emptyState({
    userIds: [1],
    writeAlertShouldThrow: true,
    portfolios: { 1: { id: 1, total_value: 75000 } },
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 100000 }] },
    positionsByUser: {
      1: [
        { id: 1, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
      ],
    },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('alert-fail: still LEVEL_3', r.per_user[0].level, 'LEVEL_3');
  assertEqual('alert-fail: trigger still returned', r.per_user[0].triggers.length, 1);
  // Alert array unchanged because write threw
  assertEqual('alert-fail: alerts array empty (write failed silently)', state.alerts.length, 0);
}

async function testEvaluateSavePausedFailureNotMaskingAlert() {
  // LEVEL_1 triggers; savePausedUntil throws; alert + result still produced
  const state = emptyState({
    userIds: [1],
    savePausedUntilShouldThrow: true,
    portfolios: { 1: { id: 1, total_value: 90000 } },
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 100000 }] },
    positionsByUser: { 1: [] },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('pause-fail: still LEVEL_1', r.per_user[0].level, 'LEVEL_1');
  assertEqual('pause-fail: alert still written', state.alerts.length, 1);
}

async function testEvaluateHighestLevelWins() {
  // drawdown 25% — should match L3 only, not cascade through L1+L2+L3
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 75000 } },
    snapshotsByPortfolio: { 1: [{ date: '2024-01-15', total_value: 100000 }] },
    positionsByUser: {
      1: [
        { id: 1, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 11, market_value: 1100 },
      ],
    },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.evaluateAfterClose({});
  assertEqual('cascade: level == LEVEL_3 only', r.per_user[0].level, 'LEVEL_3');
  assertEqual('cascade: 1 alert (not 3)', state.alerts.length, 1);
  assertEqual('cascade: paused_until NOT set (LEVEL_3 doesn\'t pause)', state.savedPausedUntil.length, 0);
}

// ---------------------------------------------------------------------------
//  Tests — guard.checkBuyAllowed end-to-end
// ---------------------------------------------------------------------------

async function testCheckBuyAllowedNoPause() {
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 100000 } },
    positionsByUser: { 1: [] },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: 'A' });
  assertEqual('no-pause: ok=true', r.ok, true);
}

async function testCheckBuyAllowedExpiredPause() {
  const past = new Date(Date.now() - 60_000).toISOString();
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 100000 } },
    pausedUntilByUser: { 1: past },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: 'A' });
  assertEqual('expired-pause: ok=true', r.ok, true);
}

async function testCheckBuyAllowedActivePauseNewHolding() {
  const future = new Date(Date.now() + 60_000).toISOString();
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 100000 } },
    pausedUntilByUser: { 1: future },
    positionsByUser: { 1: [] }, // no existing position in A
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: 'A' });
  assertEqual('active-pause-new: ok=false', r.ok, false);
  assertEqual('active-pause-new: is_new_holding=true', r.is_new_holding, true);
  assertEqual('active-pause-new: paused_until matches', r.paused_until, future);
  assert('active-pause-new: reason mentions LEVEL_1 pause', (r.reason || '').includes('回撤熔断'));
  assert('active-pause-new: reason mentions symbol', (r.reason || '').includes('A'));
}

async function testCheckBuyAllowedActivePauseAddOn() {
  // already holding — pause allows top-up (avoid breaking 策略 add-on)
  const future = new Date(Date.now() + 60_000).toISOString();
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 100000 } },
    pausedUntilByUser: { 1: future },
    positionsByUser: {
      1: [
        { id: 11, symbol: 'A', quantity: 100, avg_cost: 10, current_price: 10, market_value: 1000 },
      ],
    },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: 'A' });
  assertEqual('active-pause-addon: ok=true (existing position)', r.ok, true);
  assertEqual('active-pause-addon: is_new_holding=false', r.is_new_holding, false);
}

async function testCheckBuyAllowedDisabledUser() {
  // user disabled the breaker entirely → pause inactive even if set
  const future = new Date(Date.now() + 60_000).toISOString();
  const state = emptyState({
    userIds: [1],
    configs: { 1: { ...DEFAULT_DRAWDOWN_BREAKER_CONFIG, enabled: false } },
    portfolios: { 1: { id: 1, total_value: 100000 } },
    pausedUntilByUser: { 1: future },
    positionsByUser: { 1: [] },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: 'A' });
  assertEqual('disabled-user: ok=true (breaker off)', r.ok, true);
}

async function testCheckBuyAllowedFailOpen() {
  // DB outage in loadPausedUntil → guard should fail CLOSED (throw RiskGuardUnavailableError)
  // BETA-7 (2026-06-18, audit M-13): changed from fail-OPEN to fail-CLOSED.
  // Risk-guard DB outage = 拒单 + 写 HIGH RiskAlert (caller responsibility), 不能
  // 让风控故障悄悄放行 (与 memory sprint-27-28-29 fail-open 教训呼应)。
  const state = emptyState({
    userIds: [1],
    loadPausedUntilShouldThrow: true,
    portfolios: { 1: { id: 1, total_value: 100000 } },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  let caught: unknown = null;
  try {
    await guard.checkBuyAllowed({ user_id: 1, symbol: 'A' });
  } catch (err) {
    caught = err;
  }
  assertEqual(
    'fail-CLOSED: throws RiskGuardUnavailableError (BETA-7, audit M-13)',
    caught !== null && (caught as any)?.code === 'RISK_GUARD_UNAVAILABLE',
    true
  );
}

async function testCheckBuyAllowedInvalidPausedUntil() {
  // non-string / garbage paused_until → treated as no pause
  const state = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 100000 } },
    pausedUntilByUser: { 1: 'garbage-not-iso' as any },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: 'A' });
  assertEqual('invalid-paused-until: ok=true', r.ok, true);
}

// ---------------------------------------------------------------------------
//  Tests — getConfig / updateConfig / clearPause
// ---------------------------------------------------------------------------

async function testGetUpdateConfig() {
  const state = emptyState();
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  // get on fresh user → defaults
  const c = await guard.getConfig(99);
  assertEqual('getConfig fresh user → defaults', c.level1_pct, 0.1);
  // update with valid values
  const saved = await guard.updateConfig(99, {
    enabled: true,
    level1_pct: 0.08,
    level2_pct: 0.12,
    level3_pct: 0.18,
    level1_pause_ms: 60_000,
  });
  assertEqual('updateConfig: level1_pct saved', saved.level1_pct, 0.08);
  assertEqual('updateConfig: level1_pause_ms saved', saved.level1_pause_ms, 60_000);
  // re-fetch
  const refetch = await guard.getConfig(99);
  assertEqual('updateConfig: refetch level1_pct == 0.08', refetch.level1_pct, 0.08);
  // update with garbage → falls back to defaults
  const sanitized = await guard.updateConfig(99, {
    level1_pct: -10,
    level2_pct: 'foo',
    level3_pct: 5,
  });
  assertEqual('updateConfig garbage: level1_pct → default 0.10', sanitized.level1_pct, 0.1);
  assertEqual('updateConfig garbage: level2_pct → default 0.15', sanitized.level2_pct, 0.15);
  assertEqual('updateConfig garbage: level3_pct → default 0.20', sanitized.level3_pct, 0.2);
}

async function testClearPause() {
  const future = new Date(Date.now() + 60_000).toISOString();
  const state = emptyState({
    userIds: [1],
    pausedUntilByUser: { 1: future },
  });
  const guard = new DrawdownCircuitBreaker(makeFakeSource(state));
  await guard.clearPause(1);
  assertEqual('clearPause: pausedUntilByUser[1] == null', state.pausedUntilByUser[1], null);
  // Subsequent checkBuyAllowed should be ok=true
  const state2 = emptyState({
    userIds: [1],
    portfolios: { 1: { id: 1, total_value: 100000 } },
    pausedUntilByUser: { 1: null },
  });
  const guard2 = new DrawdownCircuitBreaker(makeFakeSource(state2));
  const r = await guard2.checkBuyAllowed({ user_id: 1, symbol: 'A' });
  assertEqual('clearPause then check: ok=true', r.ok, true);
}

// ---------------------------------------------------------------------------
//  Main driver
// ---------------------------------------------------------------------------

async function main() {
  // Constants & helpers
  await testConstants();
  await testComputePeakValue();
  await testComputeDrawdownPct();
  await testPickDrawdownLevel();
  await testComputeGainRatio();
  await testPickLevel2TrimTargets();
  await testPickLevel3LiquidateTargets();
  await testNormalizeDrawdownBreakerConfig();
  await testBuildDrawdownMessage();
  await testIsPauseActive();
  // evaluateAfterClose
  await testEvaluateLevel1Trigger();
  await testEvaluateLevel2Trigger();
  await testEvaluateLevel3Trigger();
  await testEvaluateNoTrigger();
  await testEvaluateBoundary();
  await testEvaluateUserDisabled();
  await testEvaluateNoPortfolio();
  await testEvaluateMultiUserIsolation();
  await testEvaluateDryRun();
  await testEvaluateWriteAlertFailureNotMaskingTrigger();
  await testEvaluateSavePausedFailureNotMaskingAlert();
  await testEvaluateHighestLevelWins();
  // checkBuyAllowed
  await testCheckBuyAllowedNoPause();
  await testCheckBuyAllowedExpiredPause();
  await testCheckBuyAllowedActivePauseNewHolding();
  await testCheckBuyAllowedActivePauseAddOn();
  await testCheckBuyAllowedDisabledUser();
  await testCheckBuyAllowedFailOpen();
  await testCheckBuyAllowedInvalidPausedUntil();
  // Config / clearPause
  await testGetUpdateConfig();
  await testClearPause();

  const total = passed + failed;
  console.log(`\n${passed} ok, ${failed} failed (of ${total})`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test driver crashed:', err);
  process.exit(2);
});
