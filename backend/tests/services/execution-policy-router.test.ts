/**
 * ExecutionPolicyRouter 单元测试 (Sprint 41-E):
 *   - normalizeExecutionPolicyOptions
 *   - shouldSkip (vol / 涨停 / spread)
 *   - shouldWait (gap_up + urgency)
 *   - pickSizeBasedPolicy (LIMIT / TWAP / VWAP / POV)
 *   - routeExecutionPolicy (端到端 + 优先级)
 *   - estimateCostPct
 *
 * 不依赖 jest:
 *   cd backend && npx ts-node --transpile-only tests/services/execution-policy-router.test.ts
 */

import {
  DEFAULT_EXECUTION_POLICY_OPTIONS,
  normalizeExecutionPolicyOptions,
  shouldSkip,
  shouldWait,
  pickSizeBasedPolicy,
  routeExecutionPolicy,
  ExecutionPolicyRouter,
} from '../../src/services/execution/ExecutionPolicyRouter';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}
function close(name: string, a: number, b: number, eps = 1e-6): void {
  assert(name, Math.abs(a - b) < eps, `actual=${a} expected=${b}`);
}
function eq<T>(name: string, a: T, b: T): void {
  assert(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
}

const baseInput = {
  symbol: '600519',
  side: 'BUY' as const,
  amount_yuan: 100000,
  avg_daily_turnover: 100000000, // 1 亿
  current_volatility: 0.02,
  spread_pct: 0.001,
  is_gap_up: false,
  close_to_limit_up_pct: 0.08,
};

// ===========================================================================
// normalizeExecutionPolicyOptions
// ===========================================================================

function testNormalize(): void {
  console.log('# normalizeExecutionPolicyOptions');
  eq('空 input → default', normalizeExecutionPolicyOptions(), DEFAULT_EXECUTION_POLICY_OPTIONS);
  const overridden = normalizeExecutionPolicyOptions({ skip_volatility_threshold: 0.1 });
  close('override skip_vol', overridden.skip_volatility_threshold, 0.1);
  close('未 override 字段保留', overridden.small_order_pct_of_turnover, 0.005);
  // 负值过滤
  const neg = normalizeExecutionPolicyOptions({ skip_volatility_threshold: -1 as any });
  close('负数被忽略', neg.skip_volatility_threshold, 0.05);
  // NaN 过滤
  const nan = normalizeExecutionPolicyOptions({ pov_participation_rate: NaN as any });
  close('NaN 被忽略', nan.pov_participation_rate, 0.1);
}

// ===========================================================================
// shouldSkip
// ===========================================================================

function testShouldSkip(): void {
  console.log('# shouldSkip');
  const opts = DEFAULT_EXECUTION_POLICY_OPTIONS;
  // 正常 vol → 不 skip
  const r1 = shouldSkip(baseInput, opts);
  assert('正常 vol → 不 skip', !r1.skip);

  // vol >= threshold → skip
  const r2 = shouldSkip({ ...baseInput, current_volatility: 0.06 }, opts);
  assert('vol 6% >= 5% → skip', r2.skip);

  // BUY 临近涨停 → skip
  const r3 = shouldSkip({ ...baseInput, close_to_limit_up_pct: 0.01 }, opts);
  assert('BUY 距涨停 1% → skip', r3.skip);
  // SELL 距涨停近不 skip (反向)
  const r4 = shouldSkip({ ...baseInput, side: 'SELL', close_to_limit_up_pct: 0.01 }, opts);
  assert('SELL 距涨停近不 skip', !r4.skip);

  // 大单 spread 高 → skip
  const r5 = shouldSkip(
    { ...baseInput, amount_yuan: 5000000, spread_pct: 0.01 }, // 5%/1亿=5%, spread 1%
    opts
  );
  assert('大单 spread 1% → skip', r5.skip);
  // 小单 spread 高 → 不 skip (spread 限制仅 medium+)
  const r6 = shouldSkip({ ...baseInput, amount_yuan: 100000, spread_pct: 0.01 }, opts);
  assert('小单 spread 高不 skip', !r6.skip);
}

// ===========================================================================
// shouldWait
// ===========================================================================

function testShouldWait(): void {
  console.log('# shouldWait');
  const opts = DEFAULT_EXECUTION_POLICY_OPTIONS;
  // 不跳空 → 不等
  eq('不跳空 wait=0', shouldWait(baseInput, opts).wait_minutes, 0);
  // 跳空 + high urgency → 不等
  eq(
    '跳空 + high → 不等',
    shouldWait({ ...baseInput, is_gap_up: true, urgency: 'high' }, opts).wait_minutes,
    0
  );
  // 跳空 + low → 等 30 分钟
  eq(
    '跳空 + low → 30 min',
    shouldWait({ ...baseInput, is_gap_up: true, urgency: 'low' }, opts).wait_minutes,
    30
  );
  // 跳空 + normal (默认) → 等 15 分钟
  eq(
    '跳空 + normal → 15 min',
    shouldWait({ ...baseInput, is_gap_up: true }, opts).wait_minutes,
    15
  );
}

// ===========================================================================
// pickSizeBasedPolicy
// ===========================================================================

function testPickSizeBased(): void {
  console.log('# pickSizeBasedPolicy');
  const opts = DEFAULT_EXECUTION_POLICY_OPTIONS;
  // 0.1% → LIMIT_AT_TOUCH
  eq('0.1% → LIMIT_AT_TOUCH', pickSizeBasedPolicy(0.001, opts).policy, 'LIMIT_AT_TOUCH');
  // 1% → TWAP
  eq('1% → TWAP', pickSizeBasedPolicy(0.01, opts).policy, 'TWAP');
  // 3% → VWAP
  eq('3% → VWAP', pickSizeBasedPolicy(0.03, opts).policy, 'VWAP');
  // 10% → POV
  eq('10% → POV', pickSizeBasedPolicy(0.1, opts).policy, 'POV');
  // boundary: 0.5% (== small threshold) → TWAP (>= 不 < small_pct)
  eq('0.5% 边界 → TWAP', pickSizeBasedPolicy(0.005, opts).policy, 'TWAP');
  // POV participation_rate = opts default
  close('POV rate=10%', pickSizeBasedPolicy(0.1, opts).participation_rate, 0.1);
}

// ===========================================================================
// routeExecutionPolicy (端到端)
// ===========================================================================

function testRoute(): void {
  console.log('# routeExecutionPolicy');
  // 1. SKIP 优先级最高 — 高 vol
  const r1 = routeExecutionPolicy({ ...baseInput, current_volatility: 0.1 });
  eq('high vol → SKIP', r1.policy, 'SKIP');

  // 2. WAIT 次优先级 — 跳空
  const r2 = routeExecutionPolicy({ ...baseInput, is_gap_up: true });
  eq('gap_up → WAIT_15M', r2.policy, 'WAIT_15M');
  close('WAIT 15 min', r2.wait_minutes, 15);

  // gap_up + low → WAIT_30M
  const r2b = routeExecutionPolicy({ ...baseInput, is_gap_up: true, urgency: 'low' });
  eq('gap_up+low → WAIT_30M', r2b.policy, 'WAIT_30M');

  // gap_up + high → 直接 size-based, 不等
  const r2c = routeExecutionPolicy({ ...baseInput, is_gap_up: true, urgency: 'high' });
  eq('gap_up+high → 不等, 走 size policy', r2c.policy, 'LIMIT_AT_TOUCH');

  // 3. size-based: 小单 → LIMIT
  // amount=100k, turnover=100M → 0.1% < 0.5% → LIMIT
  const r3 = routeExecutionPolicy(baseInput);
  eq('小单 → LIMIT_AT_TOUCH', r3.policy, 'LIMIT_AT_TOUCH');
  close('LIMIT slippage=0.2%', r3.max_slippage_pct, 0.002);

  // 中单 → TWAP
  const r4 = routeExecutionPolicy({ ...baseInput, amount_yuan: 1000000 }); // 1%
  eq('中单 → TWAP', r4.policy, 'TWAP');
  assert('TWAP slice_count > 1', r4.slice_count > 1);

  // 大单 → POV
  const r5 = routeExecutionPolicy({ ...baseInput, amount_yuan: 10000000 }); // 10%
  eq('大单 → POV', r5.policy, 'POV');
  close('POV rate=10%', r5.participation_rate, 0.1);

  // BUY 临近涨停 → SKIP
  const r6 = routeExecutionPolicy({ ...baseInput, close_to_limit_up_pct: 0.01 });
  eq('BUY 临近涨停 → SKIP', r6.policy, 'SKIP');

  // size_pct 字段
  close('order_size_pct=0.1%', r3.order_size_pct, 0.001);

  // option override
  const r7 = routeExecutionPolicy({
    ...baseInput,
    options: { skip_volatility_threshold: 0.01 }, // 更严
  });
  eq('option override vol 阈值', r7.policy, 'SKIP'); // 0.02 >= 0.01 → skip
}

// ===========================================================================
// estimateCostPct
// ===========================================================================

function testEstimateCost(): void {
  console.log('# estimateCostPct');
  const router = new ExecutionPolicyRouter();
  const r1 = router.route(baseInput); // LIMIT
  const cost1 = router.estimateCostPct(r1);
  assert('LIMIT cost > 0', cost1 > 0);
  assert('LIMIT cost < 0.01 (合理)', cost1 < 0.01);

  const r2 = router.route({ ...baseInput, amount_yuan: 10000000 }); // POV
  const cost2 = router.estimateCostPct(r2);
  assert('POV cost > LIMIT cost', cost2 > cost1);
}

// ===========================================================================
// Run
// ===========================================================================

testNormalize();
testShouldSkip();
testShouldWait();
testPickSizeBased();
testRoute();
testEstimateCost();

console.log('');
console.log(`✅ passed=${passed}`);
console.log(`❌ failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
