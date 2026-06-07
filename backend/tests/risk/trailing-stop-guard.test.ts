/**
 * TrailingStopGuard 单元测试 (US-048)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/trailing-stop-guard.test.ts
 *
 * 完全脱离 DB：注入 fake TrailingStopDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_TRAILING_STOP_CONFIG
 *   - 纯函数：
 *     pickEffectivePct / computeNewHighestPrice / computeTrailingStopPrice /
 *     evaluateTrailingStopTrigger / normalizeTrailingStopConfig /
 *     buildTriggerMessage
 *   - guard.updatePositionsAfterClose() end-to-end：
 *     - 启用 + 多个持仓刷新（新建 highest_price 从 avg_cost 起步 / 已有
 *       highest 时取 max）
 *     - 禁用 → 全持仓 skipped_disabled
 *     - DailyBar 缺当日数据 → skipped_no_bar
 *     - per-position trailing_stop_pct 覆盖 user 全局 pct
 *     - 多用户 / 单用户 失败 try/catch 隔离不阻塞其他用户
 *   - guard.evaluateNextDayTriggers() end-to-end：
 *     - prev_close ≤ trailing_stop_price → 触发 SELL + 写 RiskAlert
 *     - prev_close > trailing_stop_price → 无触发
 *     - dry_run=true → 不写 RiskAlert 但 trigger 仍返回
 *     - 持仓 trailing_stop_price=null (尚未跑 update) → 安全 HOLD 不触发
 *     - 禁用 user → 跳过整个 user
 *     - writeAlert 失败不应该掩盖 trigger
 *   - getConfig / updateConfig：
 *     - 默认值落地
 *     - normalize 兼容性（>1 / 负 / NaN pct → 退回默认；非 boolean enabled → 默认）
 */

import {
  DEFAULT_TRAILING_STOP_CONFIG,
  PositionSnapshot,
  PositionTrailingUpdate,
  TrailingStopConfig,
  TrailingStopDataSource,
  TrailingStopGuard,
  TrailingStopTrigger,
  buildTriggerMessage,
  computeNewHighestPrice,
  computeTrailingStopPrice,
  evaluateTrailingStopTrigger,
  normalizeTrailingStopConfig,
  pickEffectivePct,
} from '../../src/portfolio/risk/TrailingStopGuard';

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
  configs: Record<number, TrailingStopConfig>;
  positionsByUser: Record<number, PositionSnapshot[]>;
  /** Map<symbol, { close, date }> — fake returns this for loadLatestClose. */
  bars: Record<string, { close: number; date: Date } | null>;
  /** Updates collected by updatePositionTrailingFields. */
  updates: PositionTrailingUpdate[];
  /** RiskAlerts written via writeAlert. */
  alerts: Array<{ user_id: number; symbol: string; name: string; message: string }>;
  /** If true, loadOpenPositions on the matching user throws. */
  loadPositionsShouldThrowForUser?: number;
  /** If true, writeAlert throws. */
  writeAlertShouldThrow?: boolean;
  /** If true, updatePositionTrailingFields throws. */
  updateShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): TrailingStopDataSource {
  return {
    async loadAllUserIdsWithPortfolios() {
      return [...state.userIds];
    },
    async loadConfig(user_id) {
      return state.configs[user_id] ?? { ...DEFAULT_TRAILING_STOP_CONFIG };
    },
    async saveConfig(user_id, config) {
      state.configs[user_id] = { ...config };
      return { ...config };
    },
    async loadOpenPositions(user_id) {
      if (state.loadPositionsShouldThrowForUser === user_id) {
        throw new Error(`fake DB outage user=${user_id}`);
      }
      // Return a deep copy so the guard cannot mutate the test state.
      return (state.positionsByUser[user_id] || []).map(p => ({ ...p }));
    },
    async loadLatestClose(symbol) {
      return state.bars[symbol] ?? null;
    },
    async updatePositionTrailingFields(update) {
      if (state.updateShouldThrow) {
        throw new Error('fake update outage');
      }
      state.updates.push({ ...update });
      // Reflect the update in state so subsequent evaluateNextDayTriggers
      // can see it within the same test.
      for (const list of Object.values(state.positionsByUser)) {
        const p = list.find(x => x.id === update.id);
        if (p) {
          p.highest_price = update.highest_price;
          p.trailing_stop_price = update.trailing_stop_price;
        }
      }
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
    positionsByUser: {},
    bars: {},
    updates: [],
    alerts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Tests — constants
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual('DEFAULT enabled == true', DEFAULT_TRAILING_STOP_CONFIG.enabled, true);
  assertEqual('DEFAULT pct == 0.10', DEFAULT_TRAILING_STOP_CONFIG.pct, 0.1);
  // 防御性：默认对象应不可 mutate
  let mutationThrew = false;
  try {
    (DEFAULT_TRAILING_STOP_CONFIG as any).pct = 0.5;
  } catch {
    mutationThrew = true;
  }
  assert(
    'DEFAULT is frozen (strict throws OR silent no-op)',
    mutationThrew || DEFAULT_TRAILING_STOP_CONFIG.pct === 0.1
  );
  assertEqual('DEFAULT.pct after attempted mutation still == 0.10', DEFAULT_TRAILING_STOP_CONFIG.pct, 0.1);
}

// ---------------------------------------------------------------------------
//  Tests — pure helpers
// ---------------------------------------------------------------------------

async function testPickEffectivePct() {
  // Position pct present (and valid) wins over user pct & default
  assertEqual('pick: position 0.05 wins over user 0.10', pickEffectivePct(0.05, 0.1), 0.05);
  // Position pct invalid → falls to user
  assertEqual('pick: position null → user 0.15', pickEffectivePct(null, 0.15), 0.15);
  assertEqual('pick: position undefined → user 0.15', pickEffectivePct(undefined, 0.15), 0.15);
  assertEqual('pick: position NaN → user 0.15', pickEffectivePct(NaN, 0.15), 0.15);
  assertEqual('pick: position -0.05 (negative) → user 0.15', pickEffectivePct(-0.05, 0.15), 0.15);
  assertEqual('pick: position 1.5 (>1) → user 0.15', pickEffectivePct(1.5, 0.15), 0.15);
  // User pct invalid → falls to default
  assertEqual('pick: both null → DEFAULT 0.10', pickEffectivePct(null, null), 0.1);
  assertEqual('pick: user NaN → DEFAULT 0.10', pickEffectivePct(null, NaN), 0.1);
  assertEqual('pick: user 2.0 (>1) → DEFAULT 0.10', pickEffectivePct(null, 2.0), 0.1);
  // Boundary: 0 and 1 are valid
  assertEqual('pick: position 0 (safe-mode block all) honored', pickEffectivePct(0, 0.1), 0);
  assertEqual('pick: position 1 (effectively =100% drop) honored', pickEffectivePct(1, 0.1), 1);
}

async function testComputeNewHighestPrice() {
  // Prior high present → max with today_close
  assertEqual(
    'highest: prior 100, today 95 → 100 (no climb)',
    computeNewHighestPrice(100, 95, 50),
    100
  );
  assertEqual(
    'highest: prior 100, today 105 → 105 (new high)',
    computeNewHighestPrice(100, 105, 50),
    105
  );
  // Prior null → use fallback (avg_cost) as initial high
  assertEqual(
    'highest: prior null, today 95, fallback 100 → 100 (avoid trigger on day 1)',
    computeNewHighestPrice(null, 95, 100),
    100
  );
  assertEqual(
    'highest: prior null, today 105, fallback 100 → 105 (climb above avg_cost)',
    computeNewHighestPrice(null, 105, 100),
    105
  );
  // Prior null AND fallback NaN → today_close
  assertEqual(
    'highest: prior null + fallback NaN → today_close',
    computeNewHighestPrice(null, 95, NaN),
    95
  );
}

async function testComputeTrailingStopPrice() {
  assertClose(
    'trail price: 100 * (1 - 0.10) = 90.000',
    computeTrailingStopPrice(100, 0.1),
    90.0
  );
  assertClose(
    'trail price: 100 * (1 - 0.05) = 95.000',
    computeTrailingStopPrice(100, 0.05),
    95.0
  );
  assertClose(
    'trail price: 12.345 * 0.9 ≈ 11.111 (rounded to 3 dp)',
    computeTrailingStopPrice(12.345, 0.1),
    11.111
  );
  // pct=0 → trail = highest (cannot go below highest)
  assertClose('trail price: pct=0 → highest', computeTrailingStopPrice(100, 0), 100);
  // pct=1 → trail = 0 (always trips)
  assertClose('trail price: pct=1 → 0', computeTrailingStopPrice(100, 1), 0);
}

async function testEvaluateTrigger() {
  // prev_close ≤ trail → trigger
  assertEqual(
    'trigger: 89.99 < 90 → true',
    evaluateTrailingStopTrigger(89.99, 90, 100),
    true
  );
  assertEqual(
    'trigger: 90 == 90 → true (boundary ≤)',
    evaluateTrailingStopTrigger(90, 90, 100),
    true
  );
  // prev_close > trail → no trigger
  assertEqual(
    'trigger: 90.01 > 90 → false',
    evaluateTrailingStopTrigger(90.01, 90, 100),
    false
  );
  // Missing data → no trigger
  assertEqual('trigger: trail null → false', evaluateTrailingStopTrigger(50, null, 100), false);
  assertEqual('trigger: trail 0 → false', evaluateTrailingStopTrigger(50, 0, 100), false);
  assertEqual(
    'trigger: trail negative → false',
    evaluateTrailingStopTrigger(50, -10, 100),
    false
  );
  assertEqual('trigger: high null → false', evaluateTrailingStopTrigger(50, 90, null), false);
  assertEqual('trigger: prev_close NaN → false', evaluateTrailingStopTrigger(NaN, 90, 100), false);
  assertEqual('trigger: high 0 → false', evaluateTrailingStopTrigger(50, 90, 0), false);
}

async function testNormalize() {
  assertEqual('normalize: empty → defaults', normalizePositionLimitsLikeDefaults(normalizeTrailingStopConfig({})), {
    ...DEFAULT_TRAILING_STOP_CONFIG,
  });
  assertEqual('normalize: null → defaults', normalizeTrailingStopConfig(null), {
    ...DEFAULT_TRAILING_STOP_CONFIG,
  });
  assertEqual('normalize: undefined → defaults', normalizeTrailingStopConfig(undefined), {
    ...DEFAULT_TRAILING_STOP_CONFIG,
  });
  assertEqual(
    'normalize: enabled=false respected',
    normalizeTrailingStopConfig({ enabled: false, pct: 0.05 }),
    { enabled: false, pct: 0.05 }
  );
  assertEqual(
    'normalize: enabled non-boolean → default true',
    normalizeTrailingStopConfig({ enabled: 'yes' }).enabled,
    DEFAULT_TRAILING_STOP_CONFIG.enabled
  );
  assertEqual(
    'normalize: pct -0.1 → default 0.10',
    normalizeTrailingStopConfig({ pct: -0.1 }).pct,
    DEFAULT_TRAILING_STOP_CONFIG.pct
  );
  assertEqual(
    'normalize: pct 1.5 → default 0.10',
    normalizeTrailingStopConfig({ pct: 1.5 }).pct,
    DEFAULT_TRAILING_STOP_CONFIG.pct
  );
  assertEqual(
    'normalize: pct NaN → default 0.10',
    normalizeTrailingStopConfig({ pct: NaN }).pct,
    DEFAULT_TRAILING_STOP_CONFIG.pct
  );
  assertEqual(
    'normalize: pct 0 (safe-mode block all) honored',
    normalizeTrailingStopConfig({ pct: 0 }).pct,
    0
  );
  assertEqual('normalize: pct 1 (drop all) honored', normalizeTrailingStopConfig({ pct: 1 }).pct, 1);
  assertEqual(
    'normalize: pct string "0.05" coerced',
    normalizeTrailingStopConfig({ pct: '0.05' }).pct,
    0.05
  );
}

// Helper that's only used as a no-op cast for the first assertEqual above
// (to satisfy TypeScript's structural matching when we want exact-equal).
function normalizePositionLimitsLikeDefaults<T>(t: T): T {
  return t;
}

async function testBuildTriggerMessage() {
  const msg = buildTriggerMessage({
    symbol: '600519.SH',
    prev_close: 100.5,
    highest_price: 120.0,
    trailing_stop_price: 108.0,
    effective_pct: 0.1,
  });
  assert('triggerMessage includes symbol', msg.includes('600519.SH'));
  assert('triggerMessage includes prev_close', msg.includes('100.500'));
  assert('triggerMessage includes trail price', msg.includes('108.000'));
  assert('triggerMessage includes highest', msg.includes('120.000'));
  assert('triggerMessage includes pct as %', msg.includes('10.00%'));
}

// ---------------------------------------------------------------------------
//  Tests — guard.updatePositionsAfterClose
// ---------------------------------------------------------------------------

function makePosition(over: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    id: 1,
    portfolio_id: 10,
    symbol: '600519.SH',
    name: '贵州茅台',
    quantity: 100,
    avg_cost: 100,
    current_price: 100,
    highest_price: null,
    trailing_stop_pct: null,
    trailing_stop_price: null,
    ...over,
  };
}

async function testUpdateHappyPathNewPosition() {
  // 新仓 highest=null → 用 avg_cost (100) 与 today_close (95) max 取 100
  // trail = 100 * 0.9 = 90
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, avg_cost: 100 })],
    },
    bars: { '600519.SH': { close: 95, date: new Date('2026-06-07') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.updatePositionsAfterClose({ user_id: 1 });
  assertEqual('updateNew: scanned_users == 1', result.scanned_users, 1);
  assertEqual('updateNew: total_positions == 1', result.total_positions, 1);
  assertEqual('updateNew: updated_positions == 1', result.updated_positions, 1);
  assertEqual('updateNew: 1 update written', state.updates.length, 1);
  assertEqual('updateNew: highest_price = 100 (avg_cost > today_close)', state.updates[0].highest_price, 100);
  assertClose('updateNew: trailing_stop_price = 90.000', state.updates[0].trailing_stop_price, 90);
  assertEqual('updateNew: effective_pct = 0.10', state.updates[0].effective_pct, 0.1);
}

async function testUpdateClimbsToNewHigh() {
  // 已有 highest=100, today_close=110 → new highest = 110
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100, trailing_stop_price: 90 })],
    },
    bars: { '600519.SH': { close: 110, date: new Date('2026-06-07') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  await guard.updatePositionsAfterClose({ user_id: 1 });
  assertEqual('updateClimb: highest climbs to 110', state.updates[0].highest_price, 110);
  assertClose('updateClimb: trail price climbs to 99.000', state.updates[0].trailing_stop_price, 99);
}

async function testUpdateNoClimbBelowHighest() {
  // 已有 highest=100, today_close=95 → high stays at 100, trail stays at 90
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100, trailing_stop_price: 90 })],
    },
    bars: { '600519.SH': { close: 95, date: new Date('2026-06-07') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  await guard.updatePositionsAfterClose({ user_id: 1 });
  assertEqual('updateNoClimb: highest stays at 100', state.updates[0].highest_price, 100);
  assertClose('updateNoClimb: trail price stays at 90', state.updates[0].trailing_stop_price, 90);
}

async function testUpdatePerPositionPctOverride() {
  // position.trailing_stop_pct = 0.05 (5%) wins over user 0.10
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100, trailing_stop_pct: 0.05 })],
    },
    bars: { '600519.SH': { close: 110, date: new Date('2026-06-07') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  await guard.updatePositionsAfterClose({ user_id: 1 });
  assertEqual('updatePctOverride: effective_pct = 0.05', state.updates[0].effective_pct, 0.05);
  assertClose(
    'updatePctOverride: trail = 110 * 0.95 = 104.500',
    state.updates[0].trailing_stop_price,
    104.5
  );
}

async function testUpdateDisabledUser() {
  // enabled=false → all positions skipped with status='skipped_disabled'
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: false, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1 }), makePosition({ id: 2, symbol: '000001.SZ' })],
    },
    bars: {
      '600519.SH': { close: 95, date: new Date('2026-06-07') },
      '000001.SZ': { close: 10, date: new Date('2026-06-07') },
    },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.updatePositionsAfterClose({ user_id: 1 });
  assertEqual('updateDisabled: updated == 0', result.updated_positions, 0);
  assertEqual('updateDisabled: skipped == 2', result.skipped_positions, 2);
  assertEqual('updateDisabled: no updates written', state.updates.length, 0);
  const userResult = result.per_user.find(u => u.user_id === 1);
  assertEqual('updateDisabled: results have skipped_disabled status', userResult?.results[0].status, 'skipped_disabled');
}

async function testUpdateNoBar() {
  // DailyBar 缺当日 → skipped_no_bar (不 fallback 到 current_price)
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'MISSING.SH' })],
    },
    bars: {}, // no bar for MISSING.SH
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.updatePositionsAfterClose({ user_id: 1 });
  assertEqual('updateNoBar: updated == 0', result.updated_positions, 0);
  assertEqual('updateNoBar: skipped == 1', result.skipped_positions, 1);
  const userResult = result.per_user.find(u => u.user_id === 1);
  assertEqual('updateNoBar: status == skipped_no_bar', userResult?.results[0].status, 'skipped_no_bar');
}

async function testUpdateMultipleUsersIsolation() {
  // User 1 OK, User 2 loadPositions throws → User 1 still gets updated
  const state = emptyState({
    userIds: [1, 2],
    configs: {
      1: { enabled: true, pct: 0.1 },
      2: { enabled: true, pct: 0.1 },
    },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100 })],
      2: [makePosition({ id: 2, symbol: '000001.SZ', highest_price: 10 })],
    },
    bars: {
      '600519.SH': { close: 110, date: new Date('2026-06-07') },
      '000001.SZ': { close: 11, date: new Date('2026-06-07') },
    },
    loadPositionsShouldThrowForUser: 2,
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.updatePositionsAfterClose();
  assertEqual('updateMulti: scanned == 2', result.scanned_users, 2);
  assertEqual('updateMulti: user1 updated', state.updates.length, 1);
  assertEqual('updateMulti: user1 update is for position 1', state.updates[0].id, 1);
  const user2 = result.per_user.find(u => u.user_id === 2);
  assert('updateMulti: user2 has error', user2?.error !== undefined);
}

async function testUpdateScansAllWhenNoUserId() {
  const state = emptyState({
    userIds: [1, 2, 3],
    configs: {
      1: { enabled: true, pct: 0.1 },
      2: { enabled: false, pct: 0.1 },
      3: { enabled: true, pct: 0.1 },
    },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100 })],
      2: [makePosition({ id: 2, symbol: '000001.SZ' })],
      3: [makePosition({ id: 3, symbol: '601318.SH' })],
    },
    bars: {
      '600519.SH': { close: 110, date: new Date('2026-06-07') },
      '000001.SZ': { close: 11, date: new Date('2026-06-07') },
      '601318.SH': { close: 50, date: new Date('2026-06-07') },
    },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.updatePositionsAfterClose();
  assertEqual('updateAll: scanned 3 users', result.scanned_users, 3);
  assertEqual('updateAll: 2 users updated (user2 disabled)', result.updated_positions, 2);
}

// ---------------------------------------------------------------------------
//  Tests — guard.evaluateNextDayTriggers
// ---------------------------------------------------------------------------

async function testEvaluateTriggersHappy() {
  // highest=100, trail=90, prev_close=85 → triggered
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          highest_price: 100,
          trailing_stop_price: 90,
        }),
      ],
    },
    bars: { '600519.SH': { close: 85, date: new Date('2026-06-08') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers({ user_id: 1 });
  assertEqual('evalHappy: 1 triggered', result.triggered_positions, 1);
  assertEqual('evalHappy: trigger symbol = 600519.SH', result.triggers[0].symbol, '600519.SH');
  assertEqual('evalHappy: alert written', state.alerts.length, 1);
  assertEqual('evalHappy: alert symbol matches', state.alerts[0].symbol, '600519.SH');
  assert('evalHappy: alert message includes triggered keyword', state.alerts[0].message.includes('触发追踪止损'));
}

async function testEvaluateTriggersNoTrigger() {
  // highest=100, trail=90, prev_close=95 → no trigger
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          highest_price: 100,
          trailing_stop_price: 90,
        }),
      ],
    },
    bars: { '600519.SH': { close: 95, date: new Date('2026-06-08') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers({ user_id: 1 });
  assertEqual('evalNoTrigger: 0 triggered', result.triggered_positions, 0);
  assertEqual('evalNoTrigger: no alerts written', state.alerts.length, 0);
}

async function testEvaluateTriggersBoundary() {
  // boundary: prev_close == trail → trigger (≤)
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100, trailing_stop_price: 90 })],
    },
    bars: { '600519.SH': { close: 90, date: new Date('2026-06-08') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers({ user_id: 1 });
  assertEqual('evalBoundary: 90 == 90 triggers (≤ inclusive)', result.triggered_positions, 1);
}

async function testEvaluateTriggersDryRun() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100, trailing_stop_price: 90 })],
    },
    bars: { '600519.SH': { close: 80, date: new Date('2026-06-08') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers({ user_id: 1, dry_run: true });
  assertEqual('evalDryRun: 1 triggered', result.triggered_positions, 1);
  assertEqual('evalDryRun: NO alert written (dry_run)', state.alerts.length, 0);
}

async function testEvaluateSkipsNullTrailing() {
  // highest=null AND trail=null → safe HOLD (do not trigger)
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          highest_price: null,
          trailing_stop_price: null,
        }),
      ],
    },
    bars: { '600519.SH': { close: 50, date: new Date('2026-06-08') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers({ user_id: 1 });
  assertEqual('evalNullTrail: 0 triggered (safe HOLD)', result.triggered_positions, 0);
  assertEqual('evalNullTrail: no alerts', state.alerts.length, 0);
}

async function testEvaluateDisabledUserSkipped() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: false, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100, trailing_stop_price: 90 })],
    },
    bars: { '600519.SH': { close: 50, date: new Date('2026-06-08') } },
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers({ user_id: 1 });
  assertEqual('evalDisabled: 0 triggered', result.triggered_positions, 0);
  assertEqual('evalDisabled: no alerts', state.alerts.length, 0);
}

async function testEvaluateAlertFailureDoesNotMaskTrigger() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100, trailing_stop_price: 90 })],
    },
    bars: { '600519.SH': { close: 50, date: new Date('2026-06-08') } },
    writeAlertShouldThrow: true,
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers({ user_id: 1 });
  assertEqual('evalAlertFail: trigger still surfaced', result.triggered_positions, 1);
  assertEqual(
    'evalAlertFail: trigger symbol surfaced',
    result.triggers[0].symbol,
    '600519.SH'
  );
  assertEqual('evalAlertFail: no alert recorded (fake threw)', state.alerts.length, 0);
}

async function testEvaluateMultiUserIsolation() {
  const state = emptyState({
    userIds: [1, 2],
    configs: {
      1: { enabled: true, pct: 0.1 },
      2: { enabled: true, pct: 0.1 },
    },
    positionsByUser: {
      1: [makePosition({ id: 1, highest_price: 100, trailing_stop_price: 90 })],
      2: [makePosition({ id: 2, symbol: '000001.SZ', highest_price: 10, trailing_stop_price: 9 })],
    },
    bars: {
      '600519.SH': { close: 80, date: new Date('2026-06-08') },
      '000001.SZ': { close: 8, date: new Date('2026-06-08') },
    },
    loadPositionsShouldThrowForUser: 2,
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers();
  // User 1 should still trigger, user 2 should error but not block user 1.
  assertEqual('evalMulti: user1 triggered despite user2 error', result.triggered_positions, 1);
  assert(
    'evalMulti: user2 error captured',
    result.per_user_errors.find(e => e.user_id === 2) !== undefined
  );
}

async function testEvaluateSkipsNoBar() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'MISSING.SH', highest_price: 100, trailing_stop_price: 90 })],
    },
    bars: {},
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const result = await guard.evaluateNextDayTriggers({ user_id: 1 });
  assertEqual('evalNoBar: 0 triggered', result.triggered_positions, 0);
}

// ---------------------------------------------------------------------------
//  Tests — getConfig / updateConfig
// ---------------------------------------------------------------------------

async function testGetConfigDefault() {
  const state = emptyState({ userIds: [1] });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const config = await guard.getConfig(1);
  assertEqual('getConfig: returns defaults', config, { ...DEFAULT_TRAILING_STOP_CONFIG });
}

async function testUpdateConfigRoundTrip() {
  const state = emptyState({ userIds: [1] });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const updated = await guard.updateConfig(1, { enabled: true, pct: 0.05 });
  assertEqual('updateConfig: returns normalized', updated, { enabled: true, pct: 0.05 });
  const after = await guard.getConfig(1);
  assertEqual('updateConfig: persisted (re-read matches)', after, { enabled: true, pct: 0.05 });
}

async function testUpdateConfigGarbageSanitized() {
  const state = emptyState({ userIds: [1] });
  const guard = new TrailingStopGuard(makeFakeSource(state));
  const updated = await guard.updateConfig(1, {
    enabled: 'maybe', // non-boolean → default true
    pct: 5, // > 1 → default 0.10
  });
  assertEqual('updateConfig garbage → defaults', updated, { ...DEFAULT_TRAILING_STOP_CONFIG });
}

async function testUpdateThenEvaluateE2E() {
  // E2E: build a fake DB scenario where one trading day climbs, the next
  // tanks below the trail price → trigger fires.
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1 } },
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          symbol: 'X.SH',
          avg_cost: 100,
          highest_price: null,
          trailing_stop_price: null,
        }),
      ],
    },
    bars: { 'X.SH': { close: 120, date: new Date('2026-06-07') } }, // day 1: climb to 120
  });
  const guard = new TrailingStopGuard(makeFakeSource(state));

  // Day 1: close 120 → highest = max(100, 120) = 120, trail = 108
  await guard.updatePositionsAfterClose({ user_id: 1, asOfDate: new Date('2026-06-07') });
  assertEqual('E2E day1: highest = 120', state.updates[0].highest_price, 120);
  assertClose('E2E day1: trail = 108', state.updates[0].trailing_stop_price, 108);

  // Day 2: close 100 (below 108) → trigger
  state.bars['X.SH'] = { close: 100, date: new Date('2026-06-08') };
  state.updates.length = 0;
  const triggerResult = await guard.evaluateNextDayTriggers({
    user_id: 1,
    asOfDate: new Date('2026-06-08'),
  });
  assertEqual('E2E day2: triggered', triggerResult.triggered_positions, 1);
  assertEqual('E2E day2: alert written', state.alerts.length, 1);
  assertEqual('E2E day2: trigger prev_close = 100', triggerResult.triggers[0].prev_close, 100);
}

// ---------------------------------------------------------------------------
//  Driver
// ---------------------------------------------------------------------------

async function main() {
  await testConstants();
  await testPickEffectivePct();
  await testComputeNewHighestPrice();
  await testComputeTrailingStopPrice();
  await testEvaluateTrigger();
  await testNormalize();
  await testBuildTriggerMessage();

  await testUpdateHappyPathNewPosition();
  await testUpdateClimbsToNewHigh();
  await testUpdateNoClimbBelowHighest();
  await testUpdatePerPositionPctOverride();
  await testUpdateDisabledUser();
  await testUpdateNoBar();
  await testUpdateMultipleUsersIsolation();
  await testUpdateScansAllWhenNoUserId();

  await testEvaluateTriggersHappy();
  await testEvaluateTriggersNoTrigger();
  await testEvaluateTriggersBoundary();
  await testEvaluateTriggersDryRun();
  await testEvaluateSkipsNullTrailing();
  await testEvaluateDisabledUserSkipped();
  await testEvaluateAlertFailureDoesNotMaskTrigger();
  await testEvaluateMultiUserIsolation();
  await testEvaluateSkipsNoBar();

  await testGetConfigDefault();
  await testUpdateConfigRoundTrip();
  await testUpdateConfigGarbageSanitized();
  await testUpdateThenEvaluateE2E();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exitCode = 1;
});
