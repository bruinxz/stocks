/**
 * PositionLimitGuard 单元测试（US-047）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/position-limit-guard.test.ts
 *
 * 完全脱离 DB：注入 fake PositionLimitDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_POSITION_LIMITS
 *   - 纯函数：
 *     isNewHolding / evaluatePositionCount / evaluateSingleStock /
 *     evaluateSingleIndustry / pickSingleViolation / normalizePositionLimitsConfig
 *   - guard.checkBuyOrder() end-to-end：
 *     - happy path（无违规）
 *     - 超持仓数（新开仓 → 拒绝；加仓 → 放行）
 *     - 超单股仓位（含 strict > 边界）
 *     - 超单行业仓位
 *     - 行业未知 → 跳过行业检查
 *     - 优先级：count > single_stock > industry（只报第一个）
 *     - portfolio 缺失 → 放行（让上层 placeOrder 报"未找到模拟盘"）
 *     - total_value=0 → 放行
 *     - 违规时 writeAlert 被调用 1 次（level=HIGH 由 DataSource 实现固定）
 *     - writeAlert 失败不应该掩盖 violation
 *   - getConfig / updateConfig：
 *     - 默认值落地
 *     - normalize 兼容性（负数 / NaN / >1 percentage → 退回默认）
 */

import {
  DEFAULT_POSITION_LIMITS,
  HeldPositionSnapshot,
  OrderContext,
  PositionLimitDataSource,
  PositionLimitGuard,
  PositionLimitsConfig,
  evaluatePositionCount,
  evaluateSingleIndustry,
  evaluateSingleStock,
  isNewHolding,
  normalizePositionLimitsConfig,
  pickSingleViolation,
} from '../../src/portfolio/risk/PositionLimitGuard';

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

// ---------------------------------------------------------------------------
//  Fake DataSource for end-to-end guard tests
// ---------------------------------------------------------------------------

interface FakeState {
  portfolio: { total_value: number } | null;
  positions: HeldPositionSnapshot[];
  industryFor: Record<string, string | null>;
  config: PositionLimitsConfig;
  user: Record<number, any>;
  /** counts of side-effect calls so tests can assert "exactly N" */
  writeAlertCalls: Array<{
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }>;
  /** force writeAlert to reject (for "even if alert fails, violation still raised" test) */
  writeAlertShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): PositionLimitDataSource {
  return {
    async loadPortfolio() {
      return state.portfolio;
    },
    async loadPositions() {
      return state.positions;
    },
    async loadIndustryForSymbol(symbol: string) {
      return state.industryFor[symbol] ?? null;
    },
    async loadConfig() {
      return state.config;
    },
    async saveConfig(user_id, config) {
      state.user[user_id] = { position_limits: config };
      state.config = config;
      return { ...config };
    },
    async writeAlert(input) {
      if (state.writeAlertShouldThrow) {
        throw new Error('fake DB outage');
      }
      state.writeAlertCalls.push({ ...input });
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    portfolio: { total_value: 200000 },
    positions: [],
    industryFor: {},
    config: { ...DEFAULT_POSITION_LIMITS },
    user: {},
    writeAlertCalls: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Test groups
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual(
    'DEFAULT_POSITION_LIMITS.max_positions == 20',
    DEFAULT_POSITION_LIMITS.max_positions,
    20
  );
  assertEqual(
    'DEFAULT_POSITION_LIMITS.max_single_stock_pct == 0.1',
    DEFAULT_POSITION_LIMITS.max_single_stock_pct,
    0.1
  );
  assertEqual(
    'DEFAULT_POSITION_LIMITS.max_single_industry_pct == 0.3',
    DEFAULT_POSITION_LIMITS.max_single_industry_pct,
    0.3
  );
  // 防御性：默认对象应不可 mutate
  let mutationThrew = false;
  try {
    (DEFAULT_POSITION_LIMITS as any).max_positions = 5;
  } catch {
    mutationThrew = true;
  }
  // In non-strict mode the assignment silently fails, but the value should
  // still be 20 afterwards either way.  Strict mode throws.  Either is OK.
  assert(
    'DEFAULT_POSITION_LIMITS is frozen (strict mode throws OR silently no-ops)',
    mutationThrew || DEFAULT_POSITION_LIMITS.max_positions === 20
  );
  assertEqual(
    'DEFAULT_POSITION_LIMITS.max_positions after attempted mutation still == 20',
    DEFAULT_POSITION_LIMITS.max_positions,
    20
  );
}

async function testIsNewHolding() {
  assertEqual('isNewHolding empty positions returns true', isNewHolding('600519.SH', []), true);
  assertEqual(
    'isNewHolding non-matching positions returns true',
    isNewHolding('600519.SH', [
      { symbol: '000001.SZ', market_value: 1000 },
      { symbol: '600036.SH', market_value: 2000 },
    ]),
    true
  );
  assertEqual(
    'isNewHolding matching position returns false',
    isNewHolding('600519.SH', [
      { symbol: '600519.SH', market_value: 1000 },
      { symbol: '600036.SH', market_value: 2000 },
    ]),
    false
  );
}

async function testEvaluatePositionCount() {
  const config: PositionLimitsConfig = {
    max_positions: 3,
    max_single_stock_pct: 1.0,
    max_single_industry_pct: 1.0,
  };

  // Below cap, new symbol → ok
  const ctx1: OrderContext = {
    user_id: 1,
    symbol: 'NEW.SH',
    proposed_value: 10000,
    total_value: 200000,
    positions: [
      { symbol: 'A.SH', market_value: 1000 },
      { symbol: 'B.SH', market_value: 1000 },
    ],
  };
  assertEqual('count: 2 of 3, new symbol → null', evaluatePositionCount(ctx1, config), null);

  // At cap (3 of 3), new symbol → violation
  const ctx2: OrderContext = {
    ...ctx1,
    positions: [
      { symbol: 'A.SH', market_value: 1000 },
      { symbol: 'B.SH', market_value: 1000 },
      { symbol: 'C.SH', market_value: 1000 },
    ],
  };
  const v2 = evaluatePositionCount(ctx2, config);
  assert('count: 3 of 3, new symbol → violation present', v2 !== null);
  assertEqual('count: violation rule == max_positions', v2?.rule, 'max_positions');
  assertEqual('count: detail.current_count == 3', v2?.detail.current_count, 3);
  assertEqual('count: detail.max_positions == 3', v2?.detail.max_positions, 3);

  // At cap, but symbol IS already held → NO violation (加仓 doesn't add new holding)
  const ctx3: OrderContext = {
    ...ctx2,
    symbol: 'A.SH', // already in positions
  };
  assertEqual(
    'count: 3 of 3, ADDING to existing symbol → null',
    evaluatePositionCount(ctx3, config),
    null
  );

  // Over cap (e.g. 4 of 3 — shouldn't normally happen but defensive) → still violation for new
  const ctx4: OrderContext = {
    ...ctx2,
    positions: [
      { symbol: 'A.SH', market_value: 1000 },
      { symbol: 'B.SH', market_value: 1000 },
      { symbol: 'C.SH', market_value: 1000 },
      { symbol: 'D.SH', market_value: 1000 },
    ],
  };
  assert(
    'count: 4 of 3, new symbol → still violation',
    evaluatePositionCount(ctx4, config) !== null
  );
}

async function testEvaluateSingleStock() {
  const config: PositionLimitsConfig = {
    max_positions: 100,
    max_single_stock_pct: 0.1, // 10%
    max_single_industry_pct: 1.0,
  };

  // 10000 / 200000 = 5% < 10% → ok
  const ctx1: OrderContext = {
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 10000,
    total_value: 200000,
    positions: [],
  };
  assertEqual('single-stock: 5% < 10% → null', evaluateSingleStock(ctx1, config), null);

  // 20000 / 200000 = 10% — strict > so 等于 boundary 不算违规
  const ctx2: OrderContext = { ...ctx1, proposed_value: 20000 };
  assertEqual(
    'single-stock: exactly 10% (boundary) → null (strict > used)',
    evaluateSingleStock(ctx2, config),
    null
  );

  // 20001 / 200000 ≈ 10.0005% > 10% → violation
  const ctx3: OrderContext = { ...ctx1, proposed_value: 20001 };
  const v3 = evaluateSingleStock(ctx3, config);
  assert('single-stock: 10.0005% > 10% → violation present', v3 !== null);
  assertEqual('single-stock: violation rule == max_single_stock_pct', v3?.rule, 'max_single_stock_pct');

  // existing 15000 + new 6000 = 21000 / 200000 = 10.5% > 10% → violation
  const ctx4: OrderContext = {
    ...ctx1,
    proposed_value: 6000,
    positions: [{ symbol: 'A.SH', market_value: 15000 }],
  };
  const v4 = evaluateSingleStock(ctx4, config);
  assert('single-stock: existing 15k + new 6k = 10.5% > 10% → violation', v4 !== null);
  assertEqual('single-stock: existing factored in', v4?.detail.existing_value, 15000);

  // total_value 0 → null (避免除零)
  const ctx5: OrderContext = { ...ctx1, total_value: 0 };
  assertEqual('single-stock: total_value=0 → null', evaluateSingleStock(ctx5, config), null);

  // total_value 负 → null
  const ctx6: OrderContext = { ...ctx1, total_value: -100 };
  assertEqual('single-stock: total_value<0 → null', evaluateSingleStock(ctx6, config), null);

  // existing positions for *other* symbols shouldn't inflate this stock's exposure
  const ctx7: OrderContext = {
    ...ctx1,
    proposed_value: 10000,
    positions: [
      { symbol: 'B.SH', market_value: 90000 },
      { symbol: 'C.SH', market_value: 90000 },
    ],
  };
  assertEqual(
    'single-stock: existing OTHER stocks irrelevant (only same-symbol counted)',
    evaluateSingleStock(ctx7, config),
    null
  );
}

async function testEvaluateSingleIndustry() {
  const config: PositionLimitsConfig = {
    max_positions: 100,
    max_single_stock_pct: 1.0,
    max_single_industry_pct: 0.3, // 30%
  };

  // No industry → skipped
  const ctx1: OrderContext = {
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 30000,
    total_value: 100000,
    positions: [],
  };
  assertEqual('industry: missing industry → null', evaluateSingleIndustry(ctx1, config), null);
  const ctx1b: OrderContext = { ...ctx1, industry: '' };
  assertEqual('industry: empty string industry → null', evaluateSingleIndustry(ctx1b, config), null);
  const ctx1c: OrderContext = { ...ctx1, industry: '   ' };
  assertEqual(
    'industry: whitespace-only industry → null',
    evaluateSingleIndustry(ctx1c, config),
    null
  );

  // 30000 / 100000 = 30% exactly → strict > → null
  const ctx2: OrderContext = { ...ctx1, industry: '白酒' };
  assertEqual('industry: exactly 30% (boundary) → null', evaluateSingleIndustry(ctx2, config), null);

  // 30001 / 100000 = 30.001% → violation
  const ctx3: OrderContext = { ...ctx2, proposed_value: 30001 };
  const v3 = evaluateSingleIndustry(ctx3, config);
  assert('industry: 30.001% > 30% → violation present', v3 !== null);
  assertEqual('industry: violation rule == max_single_industry_pct', v3?.rule, 'max_single_industry_pct');
  assertEqual('industry: detail.industry == 白酒', v3?.detail.industry, '白酒');

  // existing same industry counted
  const ctx4: OrderContext = {
    ...ctx2,
    proposed_value: 10000,
    positions: [
      { symbol: 'X.SH', market_value: 25000, industry: '白酒' },
      { symbol: 'Y.SH', market_value: 1000, industry: '半导体' }, // different industry, ignored
    ],
  };
  // 25000 (industry total) + 10000 = 35000 / 100000 = 35% > 30% → violation
  const v4 = evaluateSingleIndustry(ctx4, config);
  assert('industry: 25k existing + 10k new = 35% > 30% → violation', v4 !== null);
  assertEqual('industry: detail.existing_industry_value == 25000', v4?.detail.existing_industry_value, 25000);

  // other industry positions ignored
  const ctx5: OrderContext = {
    ...ctx2,
    proposed_value: 10000,
    positions: [{ symbol: 'X.SH', market_value: 90000, industry: '半导体' }],
  };
  assertEqual(
    'industry: positions in other industry ignored',
    evaluateSingleIndustry(ctx5, config),
    null
  );

  // industry .trim() works on existing positions too
  const ctx6: OrderContext = {
    ...ctx2,
    proposed_value: 10000,
    positions: [
      { symbol: 'X.SH', market_value: 25000, industry: ' 白酒 ' }, // trailing/leading spaces
    ],
  };
  const v6 = evaluateSingleIndustry(ctx6, config);
  assert('industry: existing positions with trimmable industry counted', v6 !== null);
}

async function testPickSingleViolation() {
  const config: PositionLimitsConfig = {
    max_positions: 1,
    max_single_stock_pct: 0.05,
    max_single_industry_pct: 0.1,
  };

  // Trigger ALL THREE rules simultaneously; we expect only the first
  // (max_positions) to be returned (priority chain).
  const ctx: OrderContext = {
    user_id: 1,
    symbol: 'NEW.SH',
    proposed_value: 20000,
    total_value: 100000,
    positions: [{ symbol: 'A.SH', market_value: 1000, industry: '白酒' }],
    industry: '白酒',
  };
  const v = pickSingleViolation(ctx, config);
  assert('pickSingle: ALL 3 rules tripped → first returned', v !== null);
  assertEqual('pickSingle: priority gives max_positions first', v?.rule, 'max_positions');

  // Loosen count; should now return max_single_stock_pct
  const config2 = { ...config, max_positions: 100 };
  const v2 = pickSingleViolation(ctx, config2);
  assertEqual('pickSingle: only stock+industry trip → stock first', v2?.rule, 'max_single_stock_pct');

  // Loosen stock; should return industry
  const config3 = { ...config2, max_single_stock_pct: 1.0 };
  const v3 = pickSingleViolation(ctx, config3);
  assertEqual('pickSingle: only industry trips → industry returned', v3?.rule, 'max_single_industry_pct');

  // Loosen all; null
  const config4 = { ...config3, max_single_industry_pct: 1.0 };
  assertEqual('pickSingle: nothing trips → null', pickSingleViolation(ctx, config4), null);
}

async function testNormalize() {
  assertEqual(
    'normalize: empty input → defaults',
    normalizePositionLimitsConfig({}),
    { ...DEFAULT_POSITION_LIMITS }
  );
  assertEqual(
    'normalize: null → defaults',
    normalizePositionLimitsConfig(null),
    { ...DEFAULT_POSITION_LIMITS }
  );
  assertEqual(
    'normalize: undefined → defaults',
    normalizePositionLimitsConfig(undefined),
    { ...DEFAULT_POSITION_LIMITS }
  );
  assertEqual(
    'normalize: passes valid values through',
    normalizePositionLimitsConfig({
      max_positions: 15,
      max_single_stock_pct: 0.05,
      max_single_industry_pct: 0.25,
    }),
    { max_positions: 15, max_single_stock_pct: 0.05, max_single_industry_pct: 0.25 }
  );
  assertEqual(
    'normalize: negative count → default',
    normalizePositionLimitsConfig({ max_positions: -5 }).max_positions,
    DEFAULT_POSITION_LIMITS.max_positions
  );
  assertEqual(
    'normalize: zero count → default (count must be ≥ 1)',
    normalizePositionLimitsConfig({ max_positions: 0 }).max_positions,
    DEFAULT_POSITION_LIMITS.max_positions
  );
  assertEqual(
    'normalize: non-integer count → default',
    normalizePositionLimitsConfig({ max_positions: 3.5 }).max_positions,
    DEFAULT_POSITION_LIMITS.max_positions
  );
  assertEqual(
    'normalize: NaN pct → default',
    normalizePositionLimitsConfig({ max_single_stock_pct: NaN }).max_single_stock_pct,
    DEFAULT_POSITION_LIMITS.max_single_stock_pct
  );
  assertEqual(
    'normalize: pct > 1 → default',
    normalizePositionLimitsConfig({ max_single_stock_pct: 1.5 }).max_single_stock_pct,
    DEFAULT_POSITION_LIMITS.max_single_stock_pct
  );
  assertEqual(
    'normalize: pct < 0 → default',
    normalizePositionLimitsConfig({ max_single_industry_pct: -0.1 })
      .max_single_industry_pct,
    DEFAULT_POSITION_LIMITS.max_single_industry_pct
  );
  assertEqual(
    'normalize: pct = 0 allowed (safe-mode: block all buys)',
    normalizePositionLimitsConfig({ max_single_stock_pct: 0 }).max_single_stock_pct,
    0
  );
  assertEqual(
    'normalize: pct = 1 allowed (no cap)',
    normalizePositionLimitsConfig({ max_single_stock_pct: 1 }).max_single_stock_pct,
    1
  );
  assertEqual(
    'normalize: string number coerced',
    normalizePositionLimitsConfig({
      max_positions: '15',
      max_single_stock_pct: '0.05',
    }).max_positions,
    15
  );
  assertEqual(
    'normalize: string pct coerced',
    normalizePositionLimitsConfig({ max_single_stock_pct: '0.05' }).max_single_stock_pct,
    0.05
  );
}

async function testGuardHappyPath() {
  const state = emptyState({
    positions: [],
    industryFor: { 'A.SH': '白酒' },
  });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 10000,
  });
  assertEqual('guard happy: ok==true', result.ok, true);
  assertEqual('guard happy: no violation', result.violation, undefined);
  assertEqual('guard happy: writeAlert not called', state.writeAlertCalls.length, 0);
}

async function testGuardCountViolation() {
  const positions: HeldPositionSnapshot[] = Array.from({ length: 20 }, (_, i) => ({
    symbol: `S${i}.SH`,
    market_value: 1000,
  }));
  const state = emptyState({
    portfolio: { total_value: 200000 },
    positions,
    industryFor: { 'NEW.SH': '白酒' },
  });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'NEW.SH',
    proposed_value: 10000,
  });
  assertEqual('guard count: ok==false', result.ok, false);
  assertEqual('guard count: violation rule == max_positions', result.violation?.rule, 'max_positions');
  assertEqual('guard count: writeAlert called once', state.writeAlertCalls.length, 1);
  assert(
    'guard count: alert symbol == NEW.SH',
    state.writeAlertCalls[0].symbol === 'NEW.SH'
  );
  // 加仓到已持有的股票（即便满 20 只）应放行
  const result2 = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'S0.SH', // already held
    proposed_value: 1000,
  });
  assertEqual('guard count: adding to existing holding → ok', result2.ok, true);
}

async function testGuardSingleStockViolation() {
  const state = emptyState({
    portfolio: { total_value: 100000 },
    positions: [],
    industryFor: { 'A.SH': '白酒' },
  });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  // 15% > 10% → violation
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 15000,
  });
  assertEqual('guard single-stock: ok==false', result.ok, false);
  assertEqual(
    'guard single-stock: violation rule == max_single_stock_pct',
    result.violation?.rule,
    'max_single_stock_pct'
  );
  assertEqual('guard single-stock: alert written', state.writeAlertCalls.length, 1);
  // 5% < 10% → ok
  state.writeAlertCalls.length = 0;
  const result2 = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 5000,
  });
  assertEqual('guard single-stock: 5% < 10% → ok', result2.ok, true);
  assertEqual('guard single-stock: no alert when ok', state.writeAlertCalls.length, 0);
}

async function testGuardIndustryViolation() {
  const state = emptyState({
    portfolio: { total_value: 100000 },
    positions: [
      { symbol: 'X.SH', market_value: 20000, industry: '白酒' },
      { symbol: 'Y.SH', market_value: 5000, industry: '白酒' },
    ],
    industryFor: { 'A.SH': '白酒' },
  });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  // 25000 (existing 白酒) + 8000 (new) = 33000 / 100000 = 33% > 30% → violation
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 8000,
  });
  assertEqual('guard industry: ok==false', result.ok, false);
  assertEqual(
    'guard industry: violation rule == max_single_industry_pct',
    result.violation?.rule,
    'max_single_industry_pct'
  );
  assertEqual('guard industry: alert written', state.writeAlertCalls.length, 1);

  // 25000 + 4000 = 29000 / 100000 = 29% < 30% → ok
  state.writeAlertCalls.length = 0;
  const result2 = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 4000,
  });
  assertEqual('guard industry: 29% < 30% → ok', result2.ok, true);
}

async function testGuardUnknownIndustrySkipped() {
  const state = emptyState({
    portfolio: { total_value: 100000 },
    positions: [
      // Even if many 白酒 holdings exist, NEW symbol has unknown industry → industry check skipped
      { symbol: 'X.SH', market_value: 90000, industry: '白酒' },
    ],
    industryFor: { 'NEW.SH': null }, // unknown
  });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  // 3% < 10% single-stock → would only trip on industry, but industry unknown skip
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'NEW.SH',
    proposed_value: 3000,
  });
  assertEqual('guard unknown industry: skipped → ok', result.ok, true);
}

async function testGuardNoPortfolio() {
  const state = emptyState({ portfolio: null });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 100000,
  });
  assertEqual('guard no-portfolio: ok==true (defer to placeOrder)', result.ok, true);
  assertEqual('guard no-portfolio: no alert written', state.writeAlertCalls.length, 0);
}

async function testGuardZeroTotalValue() {
  const state = emptyState({ portfolio: { total_value: 0 } });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 100,
  });
  assertEqual('guard zero total_value: ok==true', result.ok, true);
}

async function testGuardAlertFailureDoesNotMaskViolation() {
  const state = emptyState({
    portfolio: { total_value: 100000 },
    industryFor: { 'A.SH': '白酒' },
    writeAlertShouldThrow: true,
  });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 20000, // 20% > 10%
  });
  assertEqual('guard alert-fail: ok still==false', result.ok, false);
  assertEqual(
    'guard alert-fail: violation still surfaced',
    result.violation?.rule,
    'max_single_stock_pct'
  );
  // writeAlertCalls stays empty because the fake threw before recording
  assertEqual('guard alert-fail: alert NOT recorded (fake threw)', state.writeAlertCalls.length, 0);
}

async function testGetConfigAndUpdate() {
  const state = emptyState();
  const guard = new PositionLimitGuard(makeFakeSource(state));

  // Initial getConfig returns defaults
  const initial = await guard.getConfig(1);
  assertEqual('getConfig initial == defaults', initial, { ...DEFAULT_POSITION_LIMITS });

  // updateConfig persists normalized values
  const updated = await guard.updateConfig(1, {
    max_positions: 15,
    max_single_stock_pct: 0.05,
    max_single_industry_pct: 0.4,
  });
  assertEqual('updateConfig returns normalized', updated, {
    max_positions: 15,
    max_single_stock_pct: 0.05,
    max_single_industry_pct: 0.4,
  });

  // Persisted on state.user[1]
  assertEqual('updateConfig persisted to user', state.user[1].position_limits, {
    max_positions: 15,
    max_single_stock_pct: 0.05,
    max_single_industry_pct: 0.4,
  });

  // getConfig now returns the saved values
  const after = await guard.getConfig(1);
  assertEqual('getConfig after update returns saved', after, {
    max_positions: 15,
    max_single_stock_pct: 0.05,
    max_single_industry_pct: 0.4,
  });

  // updateConfig with garbage normalizes to defaults
  const sanitized = await guard.updateConfig(1, {
    max_positions: 'foo',
    max_single_stock_pct: 5, // > 1
    max_single_industry_pct: -1,
  });
  assertEqual('updateConfig garbage → defaults', sanitized, { ...DEFAULT_POSITION_LIMITS });
}

// ---------------------------------------------------------------------------
//  Driver — IIFE-free async sequencing per US-037 codebase pattern
// ---------------------------------------------------------------------------

async function main() {
  await testConstants();
  await testIsNewHolding();
  await testEvaluatePositionCount();
  await testEvaluateSingleStock();
  await testEvaluateSingleIndustry();
  await testPickSingleViolation();
  await testNormalize();
  await testGuardHappyPath();
  await testGuardCountViolation();
  await testGuardSingleStockViolation();
  await testGuardIndustryViolation();
  await testGuardUnknownIndustrySkipped();
  await testGuardNoPortfolio();
  await testGuardZeroTotalValue();
  await testGuardAlertFailureDoesNotMaskViolation();
  await testGetConfigAndUpdate();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exitCode = 1;
});
