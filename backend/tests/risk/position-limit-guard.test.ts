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

import { readFileSync } from 'fs';
import { resolve } from 'path';
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
    'DEFAULT_POSITION_LIMITS.max_single_stock_pct == 0.15',
    DEFAULT_POSITION_LIMITS.max_single_stock_pct,
    0.15
  );
  assertEqual(
    'DEFAULT_POSITION_LIMITS.max_single_industry_pct == 0.25',
    DEFAULT_POSITION_LIMITS.max_single_industry_pct,
    0.25
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
  assertEqual(
    'guard count: max_positions is a business-state rejection and writes no HIGH alert',
    state.writeAlertCalls.length,
    0
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
  // 15.001% > PR-M4 default 15% → violation
  const result = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 15001,
  });
  assertEqual('guard single-stock: ok==false', result.ok, false);
  assertEqual(
    'guard single-stock: violation rule == max_single_stock_pct',
    result.violation?.rule,
    'max_single_stock_pct'
  );
  assertEqual('guard single-stock: alert written', state.writeAlertCalls.length, 1);
  // 5% < 15% → ok
  state.writeAlertCalls.length = 0;
  const result2 = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 5000,
  });
  assertEqual('guard single-stock: 5% < 15% → ok', result2.ok, true);
  assertEqual('guard single-stock: no alert when ok', state.writeAlertCalls.length, 0);
}

async function testGuardIndustryViolation() {
  const state = emptyState({
    portfolio: { total_value: 100000 },
    positions: [
      { symbol: 'X.SH', market_value: 15000, industry: '白酒' },
      { symbol: 'Y.SH', market_value: 5000, industry: '白酒' },
    ],
    industryFor: { 'A.SH': '白酒' },
  });
  const guard = new PositionLimitGuard(makeFakeSource(state));
  // 20000 (existing 白酒) + 8000 (new) = 28% > PR-M4 default 25% → violation
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

  // 20000 + 4000 = 24% < 25% → ok
  state.writeAlertCalls.length = 0;
  const result2 = await guard.checkBuyOrder({
    user_id: 1,
    symbol: 'A.SH',
    proposed_value: 4000,
  });
  assertEqual('guard industry: 24% < 25% → ok', result2.ok, true);
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
//  PR-002 / US-007 — 阈值持久化端到端 + 反 hardcode meta-test guard
// ---------------------------------------------------------------------------

/**
 * PR-002 端到端：用户在 risk_config 里把上限收紧 → 默认下放行的订单被卡掉；
 * 用户把上限放宽 → 默认下卡掉的订单被放行。证明 guard 真正读用户配置而非
 * 写死的 DEFAULT_POSITION_LIMITS。
 *
 * 此测试是 PR-002 "阈值持久化、配置驱动" AC 的代理 — 跑通即视为持久化路径
 * （updateConfig → saveConfig → loadConfig → checkBuyOrder.config）联通无缝。
 */
async function testCustomizedConfigDrivesEnforcement() {
  // ---- 1. 用户收紧 single-stock 到 5%：默认 10% 下放行的 8% 单被卡掉 ----
  {
    const state = emptyState({
      portfolio: { total_value: 100000 },
      industryFor: { 'A.SH': '白酒' },
    });
    const guard = new PositionLimitGuard(makeFakeSource(state));

    // baseline: default 10% — 8000/100000=8% < 10% → 放行
    const baseline = await guard.checkBuyOrder({
      user_id: 7,
      symbol: 'A.SH',
      proposed_value: 8000,
    });
    assertEqual('PR-002 baseline 8% < default 10% → ok', baseline.ok, true);

    // 用户收紧到 5%
    await guard.updateConfig(7, { max_single_stock_pct: 0.05 });

    const enforced = await guard.checkBuyOrder({
      user_id: 7,
      symbol: 'A.SH',
      proposed_value: 8000,
    });
    assertEqual('PR-002 收紧到 5% 后 8% → ok=false', enforced.ok, false);
    assertEqual(
      'PR-002 enforce 命中 single_stock 规则 (而非 default)',
      enforced.violation?.rule,
      'max_single_stock_pct'
    );
    assertEqual(
      'PR-002 enforce config.max_single_stock_pct = 0.05 (custom 不是 default 0.10)',
      enforced.config.max_single_stock_pct,
      0.05
    );
    assertEqual(
      'PR-002 enforce alert 被写入',
      state.writeAlertCalls.length,
      1
    );
  }

  // ---- 2. 用户放宽 max_positions 到 50：默认 20 下卡掉的 21 只新股放行 ----
  {
    const positions: HeldPositionSnapshot[] = Array.from({ length: 20 }, (_, i) => ({
      symbol: `S${i}.SH`,
      market_value: 1000,
    }));
    const state = emptyState({
      portfolio: { total_value: 1000000 },
      positions,
      industryFor: { 'NEW.SH': '白酒' },
    });
    const guard = new PositionLimitGuard(makeFakeSource(state));

    // baseline: default max_positions=20, 已 20 只 → 新开第 21 应卡
    const baseline = await guard.checkBuyOrder({
      user_id: 8,
      symbol: 'NEW.SH',
      proposed_value: 1000,
    });
    assertEqual('PR-002 baseline 20/20 默认上限 → 卡掉', baseline.ok, false);
    assertEqual(
      'PR-002 baseline 命中 max_positions',
      baseline.violation?.rule,
      'max_positions'
    );

    // 用户放宽到 50
    await guard.updateConfig(8, { max_positions: 50 });
    state.writeAlertCalls.length = 0;

    const relaxed = await guard.checkBuyOrder({
      user_id: 8,
      symbol: 'NEW.SH',
      proposed_value: 1000,
    });
    assertEqual('PR-002 放宽到 50 后 20/50 + 新开第 21 → ok', relaxed.ok, true);
    assertEqual(
      'PR-002 放宽后 config.max_positions = 50 (持久化生效)',
      relaxed.config.max_positions,
      50
    );
    assertEqual(
      'PR-002 放宽后 no alert written',
      state.writeAlertCalls.length,
      0
    );
  }

  // ---- 3. 不同 user 的 config 互相隔离 (持久化要按 user_id key) ----
  {
    const state = emptyState({
      portfolio: { total_value: 100000 },
      industryFor: { 'A.SH': '白酒' },
    });
    const guard = new PositionLimitGuard(makeFakeSource(state));
    // userA 收紧 single-stock 到 1%
    await guard.updateConfig(101, { max_single_stock_pct: 0.01 });
    // userB 用默认 (不调 updateConfig — fake loadConfig 返回 state.config)
    // 注意 fake 状态共享是 fake 测试限制 — 真实生产 loadConfig 按 user_id 查 User 表
    // 此 case 主要验"writeAlert 含正确 user_id" + "config 字段透传"
    const result = await guard.checkBuyOrder({
      user_id: 101,
      symbol: 'A.SH',
      proposed_value: 2000, // 2% > 1%
    });
    assertEqual('PR-002 userA 收紧后 2% > 1% → 卡掉', result.ok, false);
    assertEqual(
      'PR-002 alert user_id 正确透传',
      state.writeAlertCalls[state.writeAlertCalls.length - 1].user_id,
      101
    );
  }
}

/**
 * Meta-test (PR-002): 用 fs.readFileSync 直接扫 PositionLimitGuard.ts 源文件,
 * 防止未来 refactor 把"读 User.risk_config"路径误删 / 退回 hardcoded.
 *
 * 这是项目 Codebase Patterns 推荐姿势 (cron-registry [5] +
 * portfolio-construction-adapter [meta-test guard] 同款). PR-002 的
 * "配置驱动" 验收靠这个 guard 把"持久化 wire-in"真正变成 CI 守卫.
 */
async function testNoHardcodedThresholdsMetaGuard() {
  const guardSrcPath = resolve(__dirname, '../../src/portfolio/risk/PositionLimitGuard.ts');
  const src = readFileSync(guardSrcPath, 'utf8');

  // [1] DefaultPositionLimitDataSource.loadConfig 必须读 user.risk_config.position_limits
  // 用 `async loadConfig` 锚定具体方法实现 (避开 interface 同名 declaration)
  const loadConfigMatch = src.match(/async loadConfig[\s\S]*?\n  \}/);
  assert(
    'meta-guard: DefaultPositionLimitDataSource.loadConfig 方法实现可定位',
    loadConfigMatch !== null && loadConfigMatch.length > 0
  );
  const loadConfigBody = loadConfigMatch?.[0] || '';
  assert(
    'meta-guard: loadConfig 真去读 User.findByPk',
    /User\.findByPk/.test(loadConfigBody)
  );
  assert(
    'meta-guard: loadConfig 真消费 user.risk_config.position_limits 字段',
    /risk_config\??\.position_limits/.test(loadConfigBody)
  );
  assert(
    'meta-guard: loadConfig 走 normalizePositionLimitsConfig (脏数据回退默认)',
    /normalizePositionLimitsConfig/.test(loadConfigBody)
  );

  // [2] saveConfig 必须用 JSONB changed() pattern 持久化 (US-017 约定)
  const saveConfigMatch = src.match(/async saveConfig[\s\S]*?\n  \}/);
  const saveConfigBody = saveConfigMatch?.[0] || '';
  assert(
    'meta-guard: saveConfig 方法实现可定位',
    saveConfigMatch !== null && saveConfigMatch.length > 0
  );
  assert(
    'meta-guard: saveConfig 写 user.risk_config (JSONB merge)',
    /user\.risk_config\s*=/.test(saveConfigBody)
  );
  assert(
    'meta-guard: saveConfig 调 user.changed("risk_config", true) (US-017 JSONB pattern)',
    /changed\s*\(\s*['"]risk_config['"]\s*,\s*true\s*\)/.test(saveConfigBody)
  );
  assert(
    'meta-guard: saveConfig 真 await user.save() 持久化',
    /await\s+user\.save\(\)/.test(saveConfigBody)
  );

  // [3] guard.checkBuyOrder 必须从 source.loadConfig 拿 config 而非直接用 DEFAULT_POSITION_LIMITS
  const checkBuyMatch = src.match(/async checkBuyOrder[\s\S]*?\n  \}/);
  const checkBuyBody = checkBuyMatch?.[0] || '';
  assert(
    'meta-guard: checkBuyOrder 方法可定位',
    checkBuyMatch !== null && checkBuyMatch.length > 0
  );
  assert(
    'meta-guard: checkBuyOrder 调 this.source.loadConfig(user_id) (按用户读)',
    /this\.source\.loadConfig\(\s*input\.user_id\s*\)/.test(checkBuyBody)
  );
  assert(
    'meta-guard: checkBuyOrder body 不再直接引用 DEFAULT_POSITION_LIMITS (避免硬编码绕过)',
    !/DEFAULT_POSITION_LIMITS/.test(checkBuyBody)
  );

  // [4] DEFAULT_POSITION_LIMITS 必须 Object.freeze (防止任何 caller 误 mutate 共享对象)
  assert(
    'meta-guard: DEFAULT_POSITION_LIMITS 由 Object.freeze 包裹',
    /DEFAULT_POSITION_LIMITS[^=]*=\s*Object\.freeze\(/.test(src)
  );

  // [5] updateConfig 必须先 normalize 再 saveConfig (脏数据不进 DB)
  const updateConfigMatch = src.match(/async updateConfig[\s\S]*?\n  \}/);
  const updateConfigBody = updateConfigMatch?.[0] || '';
  assert(
    'meta-guard: updateConfig 方法可定位',
    updateConfigMatch !== null && updateConfigMatch.length > 0
  );
  assert(
    'meta-guard: updateConfig 调 normalizePositionLimitsConfig 在 saveConfig 前',
    /normalizePositionLimitsConfig[\s\S]*?saveConfig/.test(updateConfigBody)
  );

  // [6] 与 PR-002 / US-007 标识同步 (帮助未来 grep)
  assert(
    'meta-guard: 源码注释含 US-047 标识 (PositionLimitGuard 出生 story)',
    /US-047/.test(src)
  );
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
  await testCustomizedConfigDrivesEnforcement();
  await testNoHardcodedThresholdsMetaGuard();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exitCode = 1;
});
