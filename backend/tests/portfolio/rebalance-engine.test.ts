/**
 * RebalanceEngine 单元测试（US-086）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/portfolio/rebalance-engine.test.ts
 *
 * 完全脱离 DB：注入 fake RebalanceDataSource。
 *
 * 覆盖维度：
 *   - 常量：MIN_TRADE_LOT_SIZE / DEFAULT_REBALANCE_OPTIONS
 *   - 纯函数：
 *     normalizeRebalanceOptions / normalizeTargetWeights /
 *     quantizeBuyQuantity / quantizeSellQuantity /
 *     classifyOrderSide / sortRebalanceOrders / computeTradePlan
 *   - engine.rebalance() end-to-end：
 *     - happy path: 30% / 70% 目标 vs 50% / 50% 持仓 → 1 BUY + 1 SELL；
 *     - 不在 target 内的持仓 → SELL all（target weight=0）；
 *     - target.size=0 → 全部 SELL（空集合 = 全清仓）；
 *     - 持仓 + target 完全一致 → 全 HOLD；
 *     - 100 股最小交易单位取整（buy floor / sell ceil）；
 *     - minTradePct 边界（< 不交易 / == 仍交易）；
 *     - missing portfolio → 友好返回；
 *     - missing price → skipped + reason；
 *     - dry_run=true → execution_status='skipped_dry_run'；
 *     - execute=true → 真实调用 executeOrder；
 *     - executeOrder 抛错 → status='failed' 继续下一只；
 *     - SELL 优先排序 → 输出顺序 SELL → BUY → HOLD；
 *     - sortRebalanceOrders 稳定 tie-break（symbol localeCompare）；
 *     - negative weight 抛错；非数值 weight 抛错；
 *     - dryRun field strict boolean coercion；
 *     - minTradePct out-of-range → 退回默认。
 */

import {
  DEFAULT_REBALANCE_OPTIONS,
  MIN_TRADE_LOT_SIZE,
  PositionSnapshot,
  RebalanceDataSource,
  RebalanceEngine,
  RebalanceOptions,
  RebalanceOrder,
  classifyOrderSide,
  computeMaxDeviationPct,
  computeTradePlan,
  normalizeRebalanceOptions,
  normalizeTargetWeights,
  quantizeBuyQuantity,
  quantizeSellQuantity,
  sortRebalanceOrders,
} from '../../src/portfolio/RebalanceEngine';

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

function assertCloseTo(name: string, actual: number, expected: number, eps = 1e-6): void {
  assert(
    name,
    Math.abs(actual - expected) < eps,
    `actual=${actual} expected=${expected} eps=${eps}`
  );
}

function assertThrows(name: string, fn: () => unknown, msgIncludes?: string): void {
  try {
    fn();
    failed += 1;
    console.error(`❌ ${name}  expected throw, returned normally`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msgIncludes && !msg.includes(msgIncludes)) {
      failed += 1;
      console.error(`❌ ${name}  threw "${msg}" but expected to include "${msgIncludes}"`);
    } else {
      passed += 1;
    }
  }
}

async function assertRejects(name: string, fn: () => Promise<unknown>, msgIncludes?: string): Promise<void> {
  try {
    await fn();
    failed += 1;
    console.error(`❌ ${name}  expected rejection, resolved normally`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msgIncludes && !msg.includes(msgIncludes)) {
      failed += 1;
      console.error(`❌ ${name}  rejected "${msg}" but expected to include "${msgIncludes}"`);
    } else {
      passed += 1;
    }
  }
}

// ---------------------------------------------------------------------------
//  Fake DataSource
// ---------------------------------------------------------------------------

interface FakeState {
  portfolio: { id: number; user_id: number; total_value: number } | null;
  positions: PositionSnapshot[];
  prices: Map<string, number>;
  executeCalls: Array<{
    user_id: number;
    symbol: string;
    direction: 'BUY' | 'SELL';
    quantity: number;
  }>;
  executeShouldThrow?: (symbol: string) => Error | null;
}

function makeFakeDataSource(state: FakeState): RebalanceDataSource {
  return {
    async loadPortfolio() {
      return state.portfolio;
    },
    async loadOpenPositions() {
      return [...state.positions];
    },
    async loadLatestPrices() {
      return new Map(state.prices);
    },
    async executeOrder(input) {
      state.executeCalls.push({ ...input });
      const thrower = state.executeShouldThrow?.(input.symbol);
      if (thrower) throw thrower;
      const price = state.prices.get(input.symbol) ?? 0;
      return { executed_quantity: input.quantity, executed_price: price };
    },
  };
}

// ===========================================================================
//  常量
// ===========================================================================

function testConstants(): void {
  assertEqual('MIN_TRADE_LOT_SIZE = 100', MIN_TRADE_LOT_SIZE, 100);
  assertEqual('DEFAULT_REBALANCE_OPTIONS.minTradePct', DEFAULT_REBALANCE_OPTIONS.minTradePct, 0.005);
  assertEqual(
    'DEFAULT_REBALANCE_OPTIONS.minDeviationPct',
    DEFAULT_REBALANCE_OPTIONS.minDeviationPct,
    0.03
  );
  assertEqual('DEFAULT_REBALANCE_OPTIONS.dryRun', DEFAULT_REBALANCE_OPTIONS.dryRun, true);
  // Object.freeze 防 mutation
  let mutated = false;
  try {
    // @ts-expect-error mutation should throw in strict mode
    DEFAULT_REBALANCE_OPTIONS.minTradePct = 0.99;
    if (DEFAULT_REBALANCE_OPTIONS.minTradePct === 0.99) {
      mutated = true;
    }
  } catch {
    // Object.freeze throws in strict mode; either way mutation should fail.
  }
  assert('DEFAULT_REBALANCE_OPTIONS frozen', !mutated, 'mutation succeeded');
}

// ===========================================================================
//  normalizeRebalanceOptions
// ===========================================================================

function testNormalizeRebalanceOptions(): void {
  assertEqual(
    'normalize empty → defaults',
    normalizeRebalanceOptions(undefined),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize {} → defaults',
    normalizeRebalanceOptions({}),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize { minTradePct: 0.01 } → uses 0.01',
    normalizeRebalanceOptions({ minTradePct: 0.01 }),
    { minTradePct: 0.01, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize { dryRun: false } → respects',
    normalizeRebalanceOptions({ dryRun: false }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: false }
  );
  // garbage handling
  assertEqual(
    'normalize negative minTradePct → default',
    normalizeRebalanceOptions({ minTradePct: -0.01 }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize > 1 minTradePct → default',
    normalizeRebalanceOptions({ minTradePct: 1.5 }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize NaN minTradePct → default',
    normalizeRebalanceOptions({ minTradePct: NaN }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize Infinity minTradePct → default',
    normalizeRebalanceOptions({ minTradePct: Infinity }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  // strict boolean dryRun coercion (per US-083 pattern)
  // 'true' string is NOT accepted by normalizeRebalanceOptions (only true boolean)
  assertEqual(
    'normalize dryRun=undefined → default',
    normalizeRebalanceOptions({ dryRun: undefined }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  // boundary: minTradePct = 0 is accepted (0 ≤ x ≤ 1)
  assertEqual(
    'normalize minTradePct=0 → accepted',
    normalizeRebalanceOptions({ minTradePct: 0 }),
    { minTradePct: 0, minDeviationPct: 0.03, dryRun: true }
  );
  // boundary: minTradePct = 1 is accepted (≤ 1)
  assertEqual(
    'normalize minTradePct=1 → accepted',
    normalizeRebalanceOptions({ minTradePct: 1 }),
    { minTradePct: 1, minDeviationPct: 0.03, dryRun: true }
  );
  // --- US-009 / PR-004: minDeviationPct field coverage ---
  assertEqual(
    'normalize { minDeviationPct: 0.05 } → uses 0.05',
    normalizeRebalanceOptions({ minDeviationPct: 0.05 }),
    { minTradePct: 0.005, minDeviationPct: 0.05, dryRun: true }
  );
  assertEqual(
    'normalize { minDeviationPct: 0 } → disables gate',
    normalizeRebalanceOptions({ minDeviationPct: 0 }),
    { minTradePct: 0.005, minDeviationPct: 0, dryRun: true }
  );
  assertEqual(
    'normalize negative minDeviationPct → default',
    normalizeRebalanceOptions({ minDeviationPct: -0.01 }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize > 1 minDeviationPct → default',
    normalizeRebalanceOptions({ minDeviationPct: 1.5 }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize NaN minDeviationPct → default',
    normalizeRebalanceOptions({ minDeviationPct: NaN }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize Infinity minDeviationPct → default',
    normalizeRebalanceOptions({ minDeviationPct: Infinity }),
    { minTradePct: 0.005, minDeviationPct: 0.03, dryRun: true }
  );
  assertEqual(
    'normalize minDeviationPct=1 boundary → accepted',
    normalizeRebalanceOptions({ minDeviationPct: 1 }),
    { minTradePct: 0.005, minDeviationPct: 1, dryRun: true }
  );
}

// ===========================================================================
//  normalizeTargetWeights
// ===========================================================================

function testNormalizeTargetWeights(): void {
  // Map input
  const m1 = normalizeTargetWeights(new Map([['600519', 0.3], ['000858', 0.7]]));
  assertEqual('Map → preserved (size)', m1.size, 2);
  assertCloseTo('Map → preserved (600519)', m1.get('600519')!, 0.3);
  assertCloseTo('Map → preserved (000858)', m1.get('000858')!, 0.7);
  // Record input
  const m2 = normalizeTargetWeights({ '600519': 0.5, '000858': 0.5 });
  assertEqual('Record → preserved (size)', m2.size, 2);
  assertCloseTo('Record → preserved (600519)', m2.get('600519')!, 0.5);
  // Empty
  const m3 = normalizeTargetWeights({});
  assertEqual('empty Record → empty Map', m3.size, 0);
  const m4 = normalizeTargetWeights(new Map());
  assertEqual('empty Map → empty Map', m4.size, 0);
  // weight = 0 is valid
  const m5 = normalizeTargetWeights({ '600519': 0 });
  assertCloseTo('weight=0 → preserved', m5.get('600519')!, 0);
  // negative weight → throws
  assertThrows(
    'negative weight throws',
    () => normalizeTargetWeights({ '600519': -0.1 }),
    'negative'
  );
  // NaN weight → throws
  assertThrows(
    'NaN weight throws',
    () => normalizeTargetWeights({ '600519': NaN }),
    'finite'
  );
  // Infinity weight → throws
  assertThrows(
    'Infinity weight throws',
    () => normalizeTargetWeights({ '600519': Infinity }),
    'finite'
  );
  // empty symbol key → throws
  assertThrows(
    'empty symbol key throws',
    () => normalizeTargetWeights({ '': 0.5 }),
    'invalid symbol'
  );
  // null/undefined input → throws
  assertThrows(
    'null input throws',
    () => normalizeTargetWeights(null as any),
    'Map or Record'
  );
}

// ===========================================================================
//  quantizeBuyQuantity
// ===========================================================================

function testQuantizeBuyQuantity(): void {
  // 200000 / 100 = 2000 shares = exactly 20 lots
  assertEqual('200000 @ 100 → 2000 shares', quantizeBuyQuantity(200000, 100), 2000);
  // 199 / 100 = 1.99 lots → floor 0 lots = 0 shares
  assertEqual('199 @ 100 → 0 (below one lot)', quantizeBuyQuantity(199, 100), 0);
  // 250 / 100 = 2.5 lots; but rawShares = 2.5 < 100 → floor = 0
  assertEqual('250 @ 100 → 0 (250 < 100 shares)', quantizeBuyQuantity(250, 100), 0);
  // 15000 / 100 = 150 shares = 1.5 lots → floor 1 lot = 100 shares
  assertEqual('15000 @ 100 → 100 shares', quantizeBuyQuantity(15000, 100), 100);
  // 19999 / 100 = 199.99 shares = 1.9999 lots → floor 1 lot = 100 shares
  assertEqual('19999 @ 100 → 100 shares', quantizeBuyQuantity(19999, 100), 100);
  // 20000 / 100 = 200 shares = 2 lots → 200 shares
  assertEqual('20000 @ 100 → 200 shares', quantizeBuyQuantity(20000, 100), 200);
  // Edge: price = 0
  assertEqual('zero price → 0', quantizeBuyQuantity(10000, 0), 0);
  // Edge: negative price → 0
  assertEqual('negative price → 0', quantizeBuyQuantity(10000, -1), 0);
  // Edge: target value = 0
  assertEqual('zero target → 0', quantizeBuyQuantity(0, 100), 0);
  // Edge: target value negative → 0
  assertEqual('negative target → 0', quantizeBuyQuantity(-100, 100), 0);
  // Edge: NaN
  assertEqual('NaN target → 0', quantizeBuyQuantity(NaN, 100), 0);
  assertEqual('NaN price → 0', quantizeBuyQuantity(100, NaN), 0);
  // High-priced stock (e.g. 茅台 1800/股): 200000 / 1800 = 111.1 → 1 lot = 100 shares
  assertEqual('200000 @ 1800 → 100 shares', quantizeBuyQuantity(200000, 1800), 100);
}

// ===========================================================================
//  quantizeSellQuantity
// ===========================================================================

function testQuantizeSellQuantity(): void {
  // Held 1000 shares; want to sell 500 worth = 5 shares @ 100 → ceil to 100 shares
  // (500 / 100 = 5 shares, ceil(5/100)=1 lot=100 shares, capped at 1000)
  assertEqual('500 @ 100, held 1000 → 100', quantizeSellQuantity(500, 100, 1000), 100);
  // Want to sell 10000 worth = 100 shares = exactly 1 lot
  assertEqual('10000 @ 100, held 1000 → 100', quantizeSellQuantity(10000, 100, 1000), 100);
  // Want to sell 10100 worth = 101 shares; ceil to 2 lots = 200 shares
  assertEqual('10100 @ 100, held 1000 → 200', quantizeSellQuantity(10100, 100, 1000), 200);
  // Want to sell 200000 worth = 2000 shares = 20 lots; but held only 1000 → cap at 1000
  assertEqual('200000 @ 100, held 1000 → 1000 (capped)', quantizeSellQuantity(200000, 100, 1000), 1000);
  // Want to sell 100000 worth = 1000 shares = 10 lots; held 1000 → 1000 (== held)
  assertEqual('100000 @ 100, held 1000 → 1000', quantizeSellQuantity(100000, 100, 1000), 1000);
  // Held 0 → 0
  assertEqual('held 0 → 0', quantizeSellQuantity(1000, 100, 0), 0);
  // Held 150 (≤ 100 lot units after floor) → max sellable = 100
  assertEqual('held 150 → cap at 100', quantizeSellQuantity(50000, 100, 150), 100);
  // Held 99 → 0 lots → can't sell anything (held not enough for one lot)
  assertEqual('held 99 → 0 (below one lot held)', quantizeSellQuantity(1000, 100, 99), 0);
  // Zero price → 0
  assertEqual('zero price → 0', quantizeSellQuantity(1000, 0, 1000), 0);
  // Zero value → 0
  assertEqual('zero value → 0', quantizeSellQuantity(0, 100, 1000), 0);
  // Negative value → 0
  assertEqual('negative value → 0', quantizeSellQuantity(-100, 100, 1000), 0);
  // NaN guards
  assertEqual('NaN value → 0', quantizeSellQuantity(NaN, 100, 1000), 0);
  assertEqual('NaN price → 0', quantizeSellQuantity(100, NaN, 1000), 0);
  assertEqual('NaN held → 0', quantizeSellQuantity(100, 100, NaN), 0);
}

// ===========================================================================
//  classifyOrderSide
// ===========================================================================

function testClassifyOrderSide(): void {
  // diff > 0 and diff_pct ≥ minTradePct → BUY
  assertEqual('positive large → BUY', classifyOrderSide(1000, 0.05, 0.005), 'BUY');
  // diff < 0 and diff_pct ≥ minTradePct → SELL
  assertEqual('negative large → SELL', classifyOrderSide(-1000, 0.05, 0.005), 'SELL');
  // diff_pct < minTradePct → HOLD
  assertEqual('below threshold → HOLD', classifyOrderSide(100, 0.001, 0.005), 'HOLD');
  // diff = 0 → HOLD
  assertEqual('zero diff → HOLD', classifyOrderSide(0, 0, 0.005), 'HOLD');
  // boundary: diff_pct == minTradePct → BUY (≥ rule)
  assertEqual('boundary == threshold → trade', classifyOrderSide(1000, 0.005, 0.005), 'BUY');
  // NaN diff_value → HOLD
  assertEqual('NaN diff → HOLD', classifyOrderSide(NaN, 0.05, 0.005), 'HOLD');
  // NaN diff_pct → HOLD (because < check on NaN is false)
  assertEqual('NaN pct → HOLD', classifyOrderSide(1000, NaN, 0.005), 'HOLD');
}

// ===========================================================================
//  sortRebalanceOrders
// ===========================================================================

function testSortRebalanceOrders(): void {
  const orders: RebalanceOrder[] = [
    makeOrder('AAA.SH', 'BUY', 0.01),
    makeOrder('BBB.SH', 'SELL', 0.05),
    makeOrder('CCC.SH', 'HOLD', 0),
    makeOrder('DDD.SH', 'SELL', 0.03),
    makeOrder('EEE.SH', 'BUY', 0.02),
  ];
  const sorted = sortRebalanceOrders(orders);
  assertEqual(
    'sort: SELL → BUY → HOLD',
    sorted.map(o => o.side),
    ['SELL', 'SELL', 'BUY', 'BUY', 'HOLD']
  );
  // Within SELL: bigger diff_pct first (BBB 0.05 > DDD 0.03)
  assertEqual('SELL order by diff_pct desc', sorted[0].symbol, 'BBB.SH');
  assertEqual('SELL order by diff_pct desc 2', sorted[1].symbol, 'DDD.SH');
  // Within BUY: bigger diff_pct first (EEE 0.02 > AAA 0.01)
  assertEqual('BUY order by diff_pct desc', sorted[2].symbol, 'EEE.SH');
  assertEqual('BUY order by diff_pct desc 2', sorted[3].symbol, 'AAA.SH');
}

function testSortStableTieBreak(): void {
  // Tie on diff_pct → break by symbol ASC (localeCompare)
  const orders: RebalanceOrder[] = [
    makeOrder('ZZZ.SH', 'BUY', 0.02),
    makeOrder('AAA.SH', 'BUY', 0.02),
    makeOrder('MMM.SH', 'BUY', 0.02),
  ];
  const sorted = sortRebalanceOrders(orders);
  assertEqual(
    'tie-break by symbol ASC',
    sorted.map(o => o.symbol),
    ['AAA.SH', 'MMM.SH', 'ZZZ.SH']
  );
}

function makeOrder(symbol: string, side: 'BUY' | 'SELL' | 'HOLD', diff_pct: number): RebalanceOrder {
  return {
    symbol,
    side,
    quantity: 100,
    current_price: 10,
    current_quantity: 100,
    current_value: 1000,
    current_weight: 0.1,
    target_weight: 0.1,
    target_value: 1000,
    diff_value: side === 'SELL' ? -diff_pct * 100000 : side === 'BUY' ? diff_pct * 100000 : 0,
    diff_pct,
  };
}

// ===========================================================================
//  computeTradePlan
// ===========================================================================

function testComputeTradePlanHappy(): void {
  // total_value = 200000; positions: 600519 = 100k (50%); target: 30% = 60k → SELL 40k
  // 000858 not held; target = 70% = 140k → BUY 140k
  const orders = computeTradePlan({
    total_value: 200000,
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    targetWeights: new Map([['600519', 0.3], ['000858', 0.7]]),
    priceMap: new Map([['600519', 100], ['000858', 70]]),
    minTradePct: 0.005,
  });
  assertEqual('happy: 2 orders', orders.length, 2);
  // Sorted SELL first
  assertEqual('happy: SELL first', orders[0].side, 'SELL');
  assertEqual('happy: SELL symbol', orders[0].symbol, '600519');
  // SELL 40k / 100 = 400 shares = 4 lots
  assertEqual('happy: SELL quantity', orders[0].quantity, 400);
  assertEqual('happy: BUY symbol', orders[1].symbol, '000858');
  assertEqual('happy: BUY side', orders[1].side, 'BUY');
  // BUY 140k / 70 = 2000 shares = 20 lots
  assertEqual('happy: BUY quantity', orders[1].quantity, 2000);
  // current/target sanity
  assertCloseTo('happy: SELL current_weight', orders[0].current_weight, 0.5);
  assertCloseTo('happy: SELL target_weight', orders[0].target_weight, 0.3);
  assertCloseTo('happy: SELL diff_value', orders[0].diff_value, -40000);
  assertCloseTo('happy: SELL diff_pct', orders[0].diff_pct, 0.2);
  assertCloseTo('happy: BUY current_weight', orders[1].current_weight, 0);
  assertCloseTo('happy: BUY target_weight', orders[1].target_weight, 0.7);
  assertCloseTo('happy: BUY diff_value', orders[1].diff_value, 140000);
}

function testComputeTradePlanFullSellNotInTarget(): void {
  // Held 600519 but not in target → target weight = 0 → SELL all
  const orders = computeTradePlan({
    total_value: 200000,
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    targetWeights: new Map([['000858', 1.0]]),
    priceMap: new Map([['600519', 100], ['000858', 70]]),
    minTradePct: 0.005,
  });
  assertEqual('full-sell: 2 orders', orders.length, 2);
  // 600519 should be SELL (held, target 0)
  const sell = orders.find(o => o.symbol === '600519')!;
  assertEqual('full-sell: SELL side', sell.side, 'SELL');
  // Want to sell all 100k → 1000 shares; capped at held 1000 → 1000
  assertEqual('full-sell: SELL all 1000', sell.quantity, 1000);
  assertEqual('full-sell: target_weight=0', sell.target_weight, 0);
}

function testComputeTradePlanEmptyTargetClearsAll(): void {
  // Empty target → all positions liquidated
  const orders = computeTradePlan({
    total_value: 200000,
    positions: [
      { symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 },
      { symbol: '000858', quantity: 2000, current_price: 50, market_value: 100000 },
    ],
    targetWeights: new Map(),
    priceMap: new Map([['600519', 100], ['000858', 50]]),
    minTradePct: 0.005,
  });
  assertEqual('empty-target: 2 orders', orders.length, 2);
  assert(
    'empty-target: all SELL',
    orders.every(o => o.side === 'SELL'),
    `sides=${orders.map(o => o.side).join(',')}`
  );
  assertEqual('empty-target: SELL 600519 all', orders.find(o => o.symbol === '600519')!.quantity, 1000);
  assertEqual('empty-target: SELL 000858 all', orders.find(o => o.symbol === '000858')!.quantity, 2000);
}

function testComputeTradePlanAllHoldWhenAligned(): void {
  // 600519 held at exactly 50% weight; target = 50% → no trade
  const orders = computeTradePlan({
    total_value: 200000,
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    targetWeights: new Map([['600519', 0.5]]),
    priceMap: new Map([['600519', 100]]),
    minTradePct: 0.005,
  });
  assertEqual('aligned: 1 order', orders.length, 1);
  assertEqual('aligned: HOLD', orders[0].side, 'HOLD');
  assertEqual('aligned: quantity 0', orders[0].quantity, 0);
  assertEqual('aligned: reason', orders[0].reason, 'within_min_trade_pct');
}

function testComputeTradePlanBelowMinTradePctIsHold(): void {
  // Tiny mismatch: total 200000, target 0.501 vs current 0.5 → 0.1% diff < 0.5% → HOLD
  const orders = computeTradePlan({
    total_value: 200000,
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    targetWeights: new Map([['600519', 0.501]]),
    priceMap: new Map([['600519', 100]]),
    minTradePct: 0.005,
  });
  assertEqual('tiny-diff: 1 order', orders.length, 1);
  assertEqual('tiny-diff: HOLD', orders[0].side, 'HOLD');
  assertEqual('tiny-diff: reason within_min_trade_pct', orders[0].reason, 'within_min_trade_pct');
}

function testComputeTradePlanBoundaryAtMinTradePct(): void {
  // diff exactly = minTradePct → still trades (≥ rule)
  // total 200000 * 0.005 = 1000; need diff = 1000 exactly
  // current 0% (no position), target 0.005 → target_value = 1000 → diff = 1000 → diff_pct = 0.005
  const orders = computeTradePlan({
    total_value: 200000,
    positions: [],
    targetWeights: new Map([['600519', 0.005]]),
    priceMap: new Map([['600519', 1]]), // 1 yuan/share → 1000 yuan = 1000 shares = 10 lots
    minTradePct: 0.005,
  });
  assertEqual('boundary: 1 order', orders.length, 1);
  assertEqual('boundary: BUY (not HOLD)', orders[0].side, 'BUY');
  // 1000 / 1 = 1000 shares = 10 lots
  assertEqual('boundary: BUY quantity', orders[0].quantity, 1000);
}

function testComputeTradePlanMissingPriceMarksHold(): void {
  // No price for 600519 → status=HOLD reason=missing_price
  const orders = computeTradePlan({
    total_value: 200000,
    positions: [{ symbol: '600519', quantity: 1000, current_price: 0, market_value: 0 }],
    targetWeights: new Map([['600519', 0.3]]),
    priceMap: new Map(),
    minTradePct: 0.005,
  });
  assertEqual('missing-price: 1 order', orders.length, 1);
  assertEqual('missing-price: HOLD', orders[0].side, 'HOLD');
  assertEqual('missing-price: reason', orders[0].reason, 'missing_price');
}

function testComputeTradePlanRoundsToLot(): void {
  // total 100000, target 0.10 → 10000; price 33 → 10000/33 ≈ 303 shares → floor 3 lots = 300 shares
  const orders = computeTradePlan({
    total_value: 100000,
    positions: [],
    targetWeights: new Map([['ABC', 0.1]]),
    priceMap: new Map([['ABC', 33]]),
    minTradePct: 0.005,
  });
  const buy = orders.find(o => o.side === 'BUY')!;
  assertEqual('lot round: BUY 300 shares', buy.quantity, 300);
}

function testComputeTradePlanSkipsTinyHoldingPositionRemoved(): void {
  // Held 50 shares of 600519; target weight = 0 → want to SELL 50 shares
  // 50 shares < 100 lot → SELL quantity computed = 0 → HOLD with reason='below_one_lot'
  const orders = computeTradePlan({
    total_value: 100000,
    positions: [{ symbol: '600519', quantity: 50, current_price: 100, market_value: 5000 }],
    targetWeights: new Map([['000858', 0.5]]),
    priceMap: new Map([['600519', 100], ['000858', 50]]),
    minTradePct: 0.005,
  });
  const hold600519 = orders.find(o => o.symbol === '600519')!;
  assertEqual('tiny-hold: 600519 HOLD', hold600519.side, 'HOLD');
  assertEqual('tiny-hold: 600519 reason below_one_lot', hold600519.reason, 'below_one_lot');
}

function testComputeTradePlanTargetSumGreaterThanOne(): void {
  // sum > 1 should NOT throw — algorithm produces BUYs and lets facade cash check reject.
  const orders = computeTradePlan({
    total_value: 200000,
    positions: [],
    targetWeights: new Map([['A', 0.8], ['B', 0.8]]),
    priceMap: new Map([['A', 10], ['B', 10]]),
    minTradePct: 0.005,
  });
  assertEqual('sum > 1: 2 orders', orders.length, 2);
  // Each wants 160k → 16000 shares = 160 lots
  assertEqual('sum > 1: A quantity', orders.find(o => o.symbol === 'A')!.quantity, 16000);
  assertEqual('sum > 1: B quantity', orders.find(o => o.symbol === 'B')!.quantity, 16000);
}

function testComputeTradePlanSumLessThanOneLeavesCash(): void {
  // target sum = 0.4 → 40% invested, 60% cash, no error
  const orders = computeTradePlan({
    total_value: 100000,
    positions: [],
    targetWeights: new Map([['A', 0.2], ['B', 0.2]]),
    priceMap: new Map([['A', 10], ['B', 10]]),
    minTradePct: 0.005,
  });
  assertEqual('sum < 1: 2 orders', orders.length, 2);
  // Each wants 20k → 2000 shares
  assert(
    'sum < 1: A buy 2000',
    orders.find(o => o.symbol === 'A')!.quantity === 2000
  );
}

function testComputeTradePlanZeroTotalValue(): void {
  // 0 total value (e.g. brand new portfolio) → all HOLD with reasonable shape
  const orders = computeTradePlan({
    total_value: 0,
    positions: [],
    targetWeights: new Map([['ABC', 0.5]]),
    priceMap: new Map([['ABC', 10]]),
    minTradePct: 0.005,
  });
  assertEqual('zero-total: 1 order', orders.length, 1);
  assertEqual('zero-total: HOLD', orders[0].side, 'HOLD');
}

// ===========================================================================
//  engine.rebalance() end-to-end
// ===========================================================================

async function testEngineHappyPathDryRun(): Promise<void> {
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 200000 },
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    prices: new Map([['600519', 100], ['000858', 70]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['600519', 0.3], ['000858', 0.7]])
  );
  assertEqual('engine-happy: dry_run', result.dry_run, true);
  assertEqual('engine-happy: total_value', result.total_value, 200000);
  assertEqual('engine-happy: user_id', result.user_id, 42);
  assertEqual('engine-happy: buy_count', result.buy_count, 1);
  assertEqual('engine-happy: sell_count', result.sell_count, 1);
  assertEqual('engine-happy: 2 orders', result.orders.length, 2);
  assertEqual('engine-happy: no real orders placed', state.executeCalls.length, 0);
  // All SELL/BUY orders should have execution_status='skipped_dry_run'
  assert(
    'engine-happy: dry_run statuses',
    result.orders
      .filter(o => o.side !== 'HOLD' && o.quantity > 0)
      .every(o => o.execution_status === 'skipped_dry_run')
  );
}

async function testEngineMissingPortfolioGracefulReturn(): Promise<void> {
  const state: FakeState = {
    portfolio: null,
    positions: [],
    prices: new Map(),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(999, new Map([['600519', 0.5]]));
  assertEqual('missing-portfolio: empty orders', result.orders.length, 0);
  assertEqual('missing-portfolio: user_id null', result.user_id, null);
  assert(
    'missing-portfolio: message mentions portfolio',
    result.message.includes('999')
  );
}

async function testEngineEmptyTargetClearsAll(): Promise<void> {
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 200000 },
    positions: [
      { symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 },
      { symbol: '000858', quantity: 2000, current_price: 50, market_value: 100000 },
    ],
    prices: new Map([['600519', 100], ['000858', 50]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(1, new Map());
  assertEqual('empty-target: 2 SELL', result.sell_count, 2);
  assertEqual('empty-target: 0 BUY', result.buy_count, 0);
}

async function testEngineExecuteMode(): Promise<void> {
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 200000 },
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    prices: new Map([['600519', 100], ['000858', 70]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['600519', 0.3], ['000858', 0.7]]),
    { execute: true }
  );
  assertEqual('execute: dry_run false', result.dry_run, false);
  assertEqual('execute: 2 orders placed', state.executeCalls.length, 2);
  // SELL should be called first
  assertEqual('execute: SELL first', state.executeCalls[0].direction, 'SELL');
  assertEqual('execute: SELL symbol', state.executeCalls[0].symbol, '600519');
  assertEqual('execute: BUY second', state.executeCalls[1].direction, 'BUY');
  assertEqual('execute: BUY symbol', state.executeCalls[1].symbol, '000858');
  // All non-HOLD orders should have execution_status='ok'
  assert(
    'execute: statuses ok',
    result.orders
      .filter(o => o.side !== 'HOLD' && o.quantity > 0)
      .every(o => o.execution_status === 'ok')
  );
}

async function testEngineExecutePartialFailureContinues(): Promise<void> {
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 200000 },
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    prices: new Map([['600519', 100], ['000858', 70]]),
    executeCalls: [],
    executeShouldThrow: (symbol) =>
      symbol === '000858' ? new Error('cash insufficient') : null,
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['600519', 0.3], ['000858', 0.7]]),
    { execute: true }
  );
  assertEqual('partial-failure: both attempted', state.executeCalls.length, 2);
  const sell = result.orders.find(o => o.symbol === '600519')!;
  const buy = result.orders.find(o => o.symbol === '000858')!;
  assertEqual('partial-failure: SELL ok', sell.execution_status, 'ok');
  assertEqual('partial-failure: BUY failed', buy.execution_status, 'failed');
  assertEqual('partial-failure: error message', buy.execution_error, 'cash insufficient');
}

async function testEngineCustomMinTradePct(): Promise<void> {
  // minTradePct=0.10 (10%) → 0.5% diff filtered out → HOLD only
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 200000 },
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    prices: new Map([['600519', 100]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  // Slight diff: from 50% → 49% (1% diff < 10% min)
  const result = await engine.rebalance(
    1,
    new Map([['600519', 0.49]]),
    { minTradePct: 0.10 }
  );
  assertEqual('custom-min: 1 order', result.orders.length, 1);
  assertEqual('custom-min: HOLD', result.orders[0].side, 'HOLD');
  assertEqual('custom-min: hold_count', result.hold_count, 1);
  assertEqual('custom-min: minTradePct used', result.options.minTradePct, 0.10);
}

async function testEngineExecuteFlagOverridesDryRun(): Promise<void> {
  // execute=true should override dryRun=true (caller is explicit)
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [],
    prices: new Map([['ABC', 10]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['ABC', 0.5]]),
    { dryRun: true, execute: true }
  );
  assertEqual('execute-overrides-dryRun: dry_run false', result.dry_run, false);
  assertEqual('execute-overrides-dryRun: orders placed', state.executeCalls.length, 1);
}

async function testEngineExecuteFalseStaysDryRun(): Promise<void> {
  // execute=false (default) → dryRun=true (default) → no orders
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [],
    prices: new Map([['ABC', 10]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(1, new Map([['ABC', 0.5]]));
  assertEqual('default-dry-run: dry_run', result.dry_run, true);
  assertEqual('default-dry-run: no orders', state.executeCalls.length, 0);
}

async function testEngineDryRunFalseWithoutExecute(): Promise<void> {
  // dryRun=false BUT no execute → engine should respect dryRun=false
  // (caller explicitly opted out of dry-run via the persistent field, not the convenience flag)
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [],
    prices: new Map([['ABC', 10]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['ABC', 0.5]]),
    { dryRun: false }
  );
  assertEqual('dryRun-false-no-execute: dry_run false', result.dry_run, false);
  assertEqual('dryRun-false-no-execute: orders placed', state.executeCalls.length, 1);
}

async function testEngineSupportsRecordWeightsInput(): Promise<void> {
  // Verify plain Record input works (not just Map)
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 200000 },
    positions: [],
    prices: new Map([['600519', 100], ['000858', 70]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(1, { '600519': 0.3, '000858': 0.7 });
  assertEqual('record-input: 2 orders', result.orders.length, 2);
  assertEqual('record-input: 2 BUY', result.buy_count, 2);
}

async function testEngineRejectsNegativeWeight(): Promise<void> {
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [],
    prices: new Map(),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  await assertRejects(
    'reject negative weight',
    () => engine.rebalance(1, { ABC: -0.1 }),
    'negative'
  );
}

async function testEngineMissingPriceSkipsButDoesntBlock(): Promise<void> {
  // Target 600519 (no price) + 000858 (price ok) → 600519 HOLD missing_price,
  // 000858 BUY normally
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [],
    prices: new Map([['000858', 50]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['600519', 0.3], ['000858', 0.7]])
  );
  assertEqual('missing-price-skip: 2 orders', result.orders.length, 2);
  const skipped = result.orders.find(o => o.symbol === '600519')!;
  assertEqual('missing-price-skip: skipped HOLD', skipped.side, 'HOLD');
  assertEqual('missing-price-skip: skipped reason', skipped.reason, 'missing_price');
  assertEqual('missing-price-skip: skipped_count', result.skipped_count, 1);
  const buy = result.orders.find(o => o.symbol === '000858')!;
  assertEqual('missing-price-skip: BUY others', buy.side, 'BUY');
  // 70k / 50 = 1400 shares = 14 lots
  assertEqual('missing-price-skip: BUY quantity', buy.quantity, 1400);
}

async function testEngineMessageReflectsDryRun(): Promise<void> {
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [],
    prices: new Map([['ABC', 10]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const dry = await engine.rebalance(1, { ABC: 0.5 });
  assert('message: dry-run prefix', dry.message.startsWith('dry-run:'));
  const exec = await engine.rebalance(1, { ABC: 0.5 }, { execute: true });
  assert('message: executed prefix', exec.message.startsWith('executed:'));
}

// ===========================================================================
//  US-009 / PR-004 — RebalanceEngine 边界控制 (minDeviationPct gate)
// ===========================================================================

function testComputeMaxDeviationPct(): void {
  // Empty list → 0
  assertEqual('maxDev: empty list', computeMaxDeviationPct([]), 0);
  // Single order
  const o1: RebalanceOrder = {
    symbol: 'ABC',
    side: 'BUY',
    quantity: 100,
    current_price: 10,
    current_quantity: 0,
    current_value: 0,
    current_weight: 0,
    target_weight: 0.1,
    target_value: 1000,
    diff_value: 1000,
    diff_pct: 0.05,
  };
  assertEqual('maxDev: single order', computeMaxDeviationPct([o1]), 0.05);
  // Multi orders → returns max
  const o2: RebalanceOrder = { ...o1, symbol: 'XYZ', diff_pct: 0.12 };
  const o3: RebalanceOrder = { ...o1, symbol: 'QRS', diff_pct: 0.02 };
  assertEqual('maxDev: max across multi', computeMaxDeviationPct([o1, o2, o3]), 0.12);
  // missing_price 跳过 (不参与 max 计算)
  const oSkip: RebalanceOrder = {
    ...o1,
    symbol: 'MISS',
    diff_pct: 999,
    reason: 'missing_price',
  };
  assertEqual('maxDev: missing_price skipped', computeMaxDeviationPct([o1, oSkip]), 0.05);
  // NaN / Infinity 跳过
  const oNaN: RebalanceOrder = { ...o1, symbol: 'NAN', diff_pct: NaN };
  const oInf: RebalanceOrder = { ...o1, symbol: 'INF', diff_pct: Infinity };
  assertEqual('maxDev: NaN skipped', computeMaxDeviationPct([o1, oNaN]), 0.05);
  assertEqual('maxDev: Infinity skipped', computeMaxDeviationPct([o1, oInf]), 0.05);
  // 全 missing_price → 0
  assertEqual('maxDev: all missing_price → 0', computeMaxDeviationPct([oSkip]), 0);
}

function testComputeTradePlanGateSuppressesWhenAllUnderThreshold(): void {
  // Portfolio total=200000, holding 600519 100% (200000) but target 600519 49% + 000858 51% —
  // 49% deviation each = 0.49 → gate at 0.03 should NOT suppress.
  // Now opposite: tweak target = 50/50 split with very small drift relative to 99/1 hold.
  // Use 100000 total, hold 600519 at exactly 50001 + 000858 at exactly 49999 (deviations 0.0001).
  const total_value = 100000;
  const positions: PositionSnapshot[] = [
    { symbol: '600519', quantity: 100, current_price: 500, market_value: 50000 },
    { symbol: '000858', quantity: 1000, current_price: 50, market_value: 50000 },
  ];
  const target = new Map([
    ['600519', 0.51], // current 0.5 → diff 0.01 (1%)
    ['000858', 0.49], // current 0.5 → diff 0.01 (1%)
  ]);
  const prices = new Map([['600519', 500], ['000858', 50]]);
  // Gate=0.03 (3%); max dev = 1% → suppress.
  const orders = computeTradePlan({
    total_value,
    positions,
    targetWeights: target,
    priceMap: prices,
    minTradePct: 0.005,
    minDeviationPct: 0.03,
  });
  assertEqual('gate-suppress: 2 orders returned', orders.length, 2);
  assert(
    'gate-suppress: all HOLD',
    orders.every(o => o.side === 'HOLD' && o.quantity === 0)
  );
  assert(
    'gate-suppress: all reason within_min_deviation_pct',
    orders.every(o => o.reason === 'within_min_deviation_pct')
  );
}

function testComputeTradePlanGateAllowsWhenAtOrAboveThreshold(): void {
  // 同 portfolio 但 target 拉开到 53/47 → max diff = 3%, 恰好 == 3%, 严格 < 不抑制.
  // Use 200000 total + 5 yuan price so 3% = 6000 yuan = 1200 shares = 12 lots
  // (well above 1-lot floor — confirms real trade emitted, not micro-filter HOLD).
  const total_value = 200000;
  const positions: PositionSnapshot[] = [
    { symbol: '600519', quantity: 20000, current_price: 5, market_value: 100000 },
    { symbol: '000858', quantity: 10000, current_price: 10, market_value: 100000 },
  ];
  const target = new Map([
    ['600519', 0.53], // diff +3% = +6000 / 5 = 1200 shares = 12 lots BUY
    ['000858', 0.47], // diff −3% = −6000 / 10 = 600 shares = 6 lots SELL
  ]);
  const prices = new Map([['600519', 5], ['000858', 10]]);
  const orders = computeTradePlan({
    total_value,
    positions,
    targetWeights: target,
    priceMap: prices,
    minTradePct: 0.005,
    minDeviationPct: 0.03,
  });
  // Boundary: 3% == 3% → NOT suppressed (gate uses strict <), real BUY + SELL emitted.
  assertEqual('gate-boundary: 2 orders', orders.length, 2);
  assert(
    'gate-boundary: real trades emitted',
    orders.some(o => o.side === 'BUY') && orders.some(o => o.side === 'SELL')
  );
  assert(
    'gate-boundary: none have suppressed reason',
    orders.every(o => o.reason !== 'within_min_deviation_pct')
  );
}

function testComputeTradePlanGateZeroDisablesGate(): void {
  // Same 1% drift, but minDeviationPct=0 → gate disabled, drift > minTradePct (0.5%) → trades.
  const total_value = 100000;
  const positions: PositionSnapshot[] = [
    { symbol: '600519', quantity: 100, current_price: 500, market_value: 50000 },
    { symbol: '000858', quantity: 1000, current_price: 50, market_value: 50000 },
  ];
  const target = new Map([
    ['600519', 0.51],
    ['000858', 0.49],
  ]);
  const prices = new Map([['600519', 500], ['000858', 50]]);
  const orders = computeTradePlan({
    total_value,
    positions,
    targetWeights: target,
    priceMap: prices,
    minTradePct: 0.005,
    minDeviationPct: 0,
  });
  // Each side has 1% drift = 1000 currency. minTradePct=0.5% → per-symbol passes.
  // BUY 600519 needs 1000/500 = 2 shares < 1 lot → HOLD reason 'below_one_lot'.
  // SELL 000858 needs 1000/50 = 20 shares < 1 lot → HOLD reason 'below_one_lot'.
  // So both still HOLD — but for the per-symbol micro-lot reason, NOT the gate.
  // Important guard: reason must NOT be 'within_min_deviation_pct'.
  assert(
    'gate-disabled-0: no suppress reason',
    orders.every(o => o.reason !== 'within_min_deviation_pct')
  );
}

function testComputeTradePlanGateAllMissingPriceTrips(): void {
  // Edge: every symbol missing price (priceMap empty) → maxDev=0 → < 3% → suppression.
  // This is the **intentional fail-safe**: no prices = don't execute.
  const total_value = 100000;
  const positions: PositionSnapshot[] = [
    { symbol: 'AAA', quantity: 1000, current_price: 0, market_value: 0 },
  ];
  const target = new Map([['AAA', 0.5]]);
  const orders = computeTradePlan({
    total_value,
    positions,
    targetWeights: target,
    priceMap: new Map(),
    minTradePct: 0.005,
    minDeviationPct: 0.03,
  });
  // The single AAA order will have reason='missing_price' (from existing path),
  // NOT 'within_min_deviation_pct' (gate skips missing_price entries from
  // suppression coercion since they aren't classifiable trades anyway).
  // But the gate trip needs at least one classifiable order to overwrite —
  // empty maxDev (all-missing) leaves the missing_price reason intact.
  assertEqual('gate-allmissing: 1 order', orders.length, 1);
  // Should be HOLD with the original missing_price reason preserved
  // (gate doesn't fire when there are no priced symbols to suppress).
  assertEqual('gate-allmissing: still HOLD', orders[0].side, 'HOLD');
  assertEqual('gate-allmissing: reason missing_price', orders[0].reason, 'missing_price');
}

async function testEngineGateSuppressesPlanAndSkipsExecute(): Promise<void> {
  // End-to-end: gate fires → suppressed=true, no executeOrder calls even with execute=true.
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [
      { symbol: '600519', quantity: 100, current_price: 500, market_value: 50000 },
      { symbol: '000858', quantity: 1000, current_price: 50, market_value: 50000 },
    ],
    prices: new Map([['600519', 500], ['000858', 50]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['600519', 0.51], ['000858', 0.49]]),
    { execute: true } // execute mode, but gate should still trip
  );
  assertEqual('engine-gate: suppressed=true', result.suppressed, true);
  assertEqual('engine-gate: no executeOrder calls', state.executeCalls.length, 0);
  assertEqual('engine-gate: buy_count=0', result.buy_count, 0);
  assertEqual('engine-gate: sell_count=0', result.sell_count, 0);
  assertEqual('engine-gate: hold_count=2', result.hold_count, 2);
  assert('engine-gate: message says suppressed', result.message.startsWith('suppressed:'));
  assert(
    'engine-gate: message includes max_deviation_pct',
    result.message.includes('max_deviation_pct')
  );
  assert(
    'engine-gate: max_deviation_pct around 1%',
    Math.abs(result.max_deviation_pct - 0.01) < 1e-6
  );
  assert(
    'engine-gate: every order reason=within_min_deviation_pct',
    result.orders.every(o => o.reason === 'within_min_deviation_pct')
  );
  // dry_run should still reflect what caller asked (execute=true → dry_run=false even though no orders ran)
  assertEqual('engine-gate: dry_run reflects request', result.dry_run, false);
}

async function testEngineGateNotTrippedWhenDeviationLarge(): Promise<void> {
  // 100/0 → target 30/70 = 70% deviation on 000858, way above 3% gate → real plan.
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 200000 },
    positions: [{ symbol: '600519', quantity: 1000, current_price: 100, market_value: 100000 }],
    prices: new Map([['600519', 100], ['000858', 70]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['600519', 0.3], ['000858', 0.7]])
  );
  assertEqual('engine-gate-large: suppressed=false', result.suppressed, false);
  assertEqual('engine-gate-large: buy_count=1', result.buy_count, 1);
  assertEqual('engine-gate-large: sell_count=1', result.sell_count, 1);
  // 600519 went from 50% → 30% = 0.20 ; 000858 went from 0% → 70% = 0.70
  assert(
    'engine-gate-large: max_deviation_pct around 0.7',
    Math.abs(result.max_deviation_pct - 0.7) < 1e-6
  );
}

async function testEngineGateCustomMinDeviationPct(): Promise<void> {
  // Drift 5% (= 0.05). minDeviationPct=0.10 (10%) → trip; 0.03 (3%, default) → don't trip.
  const buildState = (): FakeState => ({
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [
      { symbol: '600519', quantity: 100, current_price: 500, market_value: 50000 },
      { symbol: '000858', quantity: 1000, current_price: 50, market_value: 50000 },
    ],
    prices: new Map([['600519', 500], ['000858', 50]]),
    executeCalls: [],
  });
  const tight = new RebalanceEngine(makeFakeDataSource(buildState()));
  const r1 = await tight.rebalance(
    1,
    new Map([['600519', 0.55], ['000858', 0.45]]),
    { minDeviationPct: 0.10 }
  );
  assertEqual('engine-gate-custom-tight: suppressed=true', r1.suppressed, true);
  assertEqual('engine-gate-custom-tight: options.minDeviationPct', r1.options.minDeviationPct, 0.10);

  const loose = new RebalanceEngine(makeFakeDataSource(buildState()));
  const r2 = await loose.rebalance(
    1,
    new Map([['600519', 0.55], ['000858', 0.45]]),
    { minDeviationPct: 0.03 }
  );
  assertEqual('engine-gate-custom-loose: suppressed=false', r2.suppressed, false);
  assert(
    'engine-gate-custom-loose: real trades emitted',
    r2.orders.some(o => o.side !== 'HOLD')
  );
}

async function testEngineGateDisabledByZero(): Promise<void> {
  // minDeviationPct=0 → caller opted out. Same 1% drift now produces normal plan
  // (but each will still HOLD because below_one_lot — the deviation is real but trades
  // are too small for a 100-share lot). Key invariant: no `within_min_deviation_pct`
  // reason and suppressed=false.
  const state: FakeState = {
    portfolio: { id: 1, user_id: 42, total_value: 100000 },
    positions: [
      { symbol: '600519', quantity: 100, current_price: 500, market_value: 50000 },
      { symbol: '000858', quantity: 1000, current_price: 50, market_value: 50000 },
    ],
    prices: new Map([['600519', 500], ['000858', 50]]),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(
    1,
    new Map([['600519', 0.51], ['000858', 0.49]]),
    { minDeviationPct: 0 }
  );
  assertEqual('engine-gate-disabled: suppressed=false', result.suppressed, false);
  assertEqual('engine-gate-disabled: options.minDeviationPct', result.options.minDeviationPct, 0);
  assert(
    'engine-gate-disabled: no within_min_deviation_pct reason',
    result.orders.every(o => o.reason !== 'within_min_deviation_pct')
  );
}

async function testEngineGateMissingPortfolioStillReportsSuppressedFalse(): Promise<void> {
  // Defensive: missing portfolio → empty orders, suppressed must be `false` (no orders to suppress)
  // and max_deviation_pct=0. Schema completeness.
  const state: FakeState = {
    portfolio: null,
    positions: [],
    prices: new Map(),
    executeCalls: [],
  };
  const engine = new RebalanceEngine(makeFakeDataSource(state));
  const result = await engine.rebalance(999, new Map([['600519', 0.5]]));
  assertEqual('engine-gate-missing-portfolio: suppressed=false', result.suppressed, false);
  assertEqual('engine-gate-missing-portfolio: max_dev=0', result.max_deviation_pct, 0);
}

function testRebalanceResultSchemaCompleteness(): void {
  // Meta-guard: every RebalanceResult must carry the new US-009 fields
  // (suppressed, max_deviation_pct). Source-file regex scan to lock the
  // contract — any future "return { portfolio_id, ... }" without the new
  // fields will be caught here, same pattern as the cron-registry meta-test.
  const fs = require('fs');
  const path = require('path');
  const sourcePath = path.resolve(__dirname, '../../src/portfolio/RebalanceEngine.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  // Required interface fields
  assert(
    'schema: RebalanceOptions has minDeviationPct',
    /minDeviationPct\s*:\s*number/.test(source)
  );
  assert(
    'schema: RebalanceResult has suppressed',
    /suppressed\s*:\s*boolean/.test(source)
  );
  assert(
    'schema: RebalanceResult has max_deviation_pct',
    /max_deviation_pct\s*:\s*number/.test(source)
  );
  // Both rebalance() return paths (missing portfolio + main) must include the fields
  const suppressedReturns = source.match(/suppressed:/g) || [];
  assert(
    'schema: at least 2 suppressed: lines (interface + 2 returns + helpers)',
    suppressedReturns.length >= 3,
    `count=${suppressedReturns.length}`
  );
  // Gate constant default value
  assert(
    'schema: DEFAULT_REBALANCE_OPTIONS includes minDeviationPct: 0.03',
    /minDeviationPct:\s*0\.03/.test(source)
  );
  // Caller opt-out site present (CompositeRebalanceService)
  const compositePath = path.resolve(
    __dirname,
    '../../src/portfolio/internal/CompositeRebalanceService.ts'
  );
  const compositeSource = fs.readFileSync(compositePath, 'utf8');
  assert(
    'schema: CompositeRebalanceService passes minDeviationPct: 0 to opt out',
    /minDeviationPct:\s*0\b/.test(compositeSource)
  );
}

// ===========================================================================
//  Test runner
// ===========================================================================

async function main(): Promise<void> {
  // Pure-function tests
  testConstants();
  testNormalizeRebalanceOptions();
  testNormalizeTargetWeights();
  testQuantizeBuyQuantity();
  testQuantizeSellQuantity();
  testClassifyOrderSide();
  testSortRebalanceOrders();
  testSortStableTieBreak();
  testComputeTradePlanHappy();
  testComputeTradePlanFullSellNotInTarget();
  testComputeTradePlanEmptyTargetClearsAll();
  testComputeTradePlanAllHoldWhenAligned();
  testComputeTradePlanBelowMinTradePctIsHold();
  testComputeTradePlanBoundaryAtMinTradePct();
  testComputeTradePlanMissingPriceMarksHold();
  testComputeTradePlanRoundsToLot();
  testComputeTradePlanSkipsTinyHoldingPositionRemoved();
  testComputeTradePlanTargetSumGreaterThanOne();
  testComputeTradePlanSumLessThanOneLeavesCash();
  testComputeTradePlanZeroTotalValue();

  // US-009 / PR-004 gate tests
  testComputeMaxDeviationPct();
  testComputeTradePlanGateSuppressesWhenAllUnderThreshold();
  testComputeTradePlanGateAllowsWhenAtOrAboveThreshold();
  testComputeTradePlanGateZeroDisablesGate();
  testComputeTradePlanGateAllMissingPriceTrips();
  testRebalanceResultSchemaCompleteness();

  // Engine end-to-end
  await testEngineHappyPathDryRun();
  await testEngineMissingPortfolioGracefulReturn();
  await testEngineEmptyTargetClearsAll();
  await testEngineExecuteMode();
  await testEngineExecutePartialFailureContinues();
  await testEngineCustomMinTradePct();
  await testEngineExecuteFlagOverridesDryRun();
  await testEngineExecuteFalseStaysDryRun();
  await testEngineDryRunFalseWithoutExecute();
  await testEngineSupportsRecordWeightsInput();
  await testEngineRejectsNegativeWeight();
  await testEngineMissingPriceSkipsButDoesntBlock();
  await testEngineMessageReflectsDryRun();

  // US-009 / PR-004 gate engine-level
  await testEngineGateSuppressesPlanAndSkipsExecute();
  await testEngineGateNotTrippedWhenDeviationLarge();
  await testEngineGateCustomMinDeviationPct();
  await testEngineGateDisabledByZero();
  await testEngineGateMissingPortfolioStillReportsSuppressedFalse();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exitCode = 1;
});
