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
  classifyTradingSession,
  sessionDowngradeReason,
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
  // US-107: 固定到连续竞价时段, 避免 host 当前时间漂移影响 route 结果
  now: new Date('2026-06-15T10:00:00+08:00'),
};

// 用于显式构造测试时段 (Asia/Shanghai 09:15-09:25 集合 / 10:00 连续 / 14:58 收盘集合 / 16:00 收盘后)
function sessionDate(hhmm: string): Date {
  return new Date(`2026-06-15T${hhmm}:00+08:00`);
}

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
// US-107: TradingSession (集合竞价 / 连续 / 收盘) — AC "单测 3 段"
// ===========================================================================

function testTradingSessionClassification(): void {
  console.log('# classifyTradingSession (3 段 + 边界)');
  // 开盘集合竞价 [09:15, 09:25)
  eq('09:15 → OPEN_AUCTION (起点含)', classifyTradingSession(sessionDate('09:15')), 'OPEN_AUCTION');
  eq('09:20 → OPEN_AUCTION', classifyTradingSession(sessionDate('09:20')), 'OPEN_AUCTION');
  eq('09:24 → OPEN_AUCTION', classifyTradingSession(sessionDate('09:24')), 'OPEN_AUCTION');
  // 撮合间隙 09:25-09:30 落 CLOSED
  eq('09:25 → CLOSED (撮合间隙)', classifyTradingSession(sessionDate('09:25')), 'CLOSED');
  eq('09:29 → CLOSED (撮合间隙)', classifyTradingSession(sessionDate('09:29')), 'CLOSED');
  // 连续竞价 [09:30, 11:30) + [13:00, 14:57)
  eq('09:30 → CONTINUOUS (起点含)', classifyTradingSession(sessionDate('09:30')), 'CONTINUOUS');
  eq('10:00 → CONTINUOUS', classifyTradingSession(sessionDate('10:00')), 'CONTINUOUS');
  eq('11:29 → CONTINUOUS (终点前 1 min)', classifyTradingSession(sessionDate('11:29')), 'CONTINUOUS');
  eq('11:30 → CLOSED (午休起点)', classifyTradingSession(sessionDate('11:30')), 'CLOSED');
  eq('12:30 → CLOSED (午休)', classifyTradingSession(sessionDate('12:30')), 'CLOSED');
  eq('13:00 → CONTINUOUS (下午起点)', classifyTradingSession(sessionDate('13:00')), 'CONTINUOUS');
  eq('14:30 → CONTINUOUS', classifyTradingSession(sessionDate('14:30')), 'CONTINUOUS');
  eq('14:56 → CONTINUOUS (终点前 1 min)', classifyTradingSession(sessionDate('14:56')), 'CONTINUOUS');
  // 收盘集合竞价 [14:57, 15:00)
  eq('14:57 → CLOSE_AUCTION (起点含)', classifyTradingSession(sessionDate('14:57')), 'CLOSE_AUCTION');
  eq('14:59 → CLOSE_AUCTION', classifyTradingSession(sessionDate('14:59')), 'CLOSE_AUCTION');
  eq('15:00 → CLOSED (收盘后)', classifyTradingSession(sessionDate('15:00')), 'CLOSED');
  eq('16:00 → CLOSED (盘后)', classifyTradingSession(sessionDate('16:00')), 'CLOSED');
  eq('07:00 → CLOSED (盘前)', classifyTradingSession(sessionDate('07:00')), 'CLOSED');
}

function testSessionDowngradeReason(): void {
  console.log('# sessionDowngradeReason');
  // CONTINUOUS 任何 policy 都不降级
  assert('CONTINUOUS + TWAP 不降级', sessionDowngradeReason('CONTINUOUS', 'TWAP') === null);
  assert('CONTINUOUS + POV 不降级', sessionDowngradeReason('CONTINUOUS', 'POV') === null);
  // OPEN_AUCTION: TWAP/VWAP/POV 全降级, LIMIT 不降
  assert('OPEN_AUCTION + TWAP 降级', sessionDowngradeReason('OPEN_AUCTION', 'TWAP') !== null);
  assert('OPEN_AUCTION + VWAP 降级', sessionDowngradeReason('OPEN_AUCTION', 'VWAP') !== null);
  assert('OPEN_AUCTION + POV 降级', sessionDowngradeReason('OPEN_AUCTION', 'POV') !== null);
  assert('OPEN_AUCTION + LIMIT 不降级', sessionDowngradeReason('OPEN_AUCTION', 'LIMIT_AT_TOUCH') === null);
  // CLOSE_AUCTION 同上
  assert('CLOSE_AUCTION + TWAP 降级', sessionDowngradeReason('CLOSE_AUCTION', 'TWAP') !== null);
  assert('CLOSE_AUCTION + LIMIT 不降级', sessionDowngradeReason('CLOSE_AUCTION', 'LIMIT_AT_TOUCH') === null);
  // CLOSED 永远降级 (SKIP)
  assert('CLOSED + 任何 → 降级', sessionDowngradeReason('CLOSED', 'TWAP') !== null);
  assert('CLOSED + LIMIT 也降级', sessionDowngradeReason('CLOSED', 'LIMIT_AT_TOUCH') !== null);
}

function testRouteBySession(): void {
  console.log('# routeExecutionPolicy — 3 段分流');

  // ---- 段 1: 开盘集合竞价 (09:20) ----
  // 中单 (1%) 本来应走 TWAP, 集合竞价时段强制 LIMIT_AT_TOUCH.
  const auctionMid = routeExecutionPolicy({
    ...baseInput,
    amount_yuan: 1000000,
    now: sessionDate('09:20'),
  });
  eq('OPEN_AUCTION 中单 → LIMIT (降级)', auctionMid.policy, 'LIMIT_AT_TOUCH');
  eq('OPEN_AUCTION session 字段', auctionMid.session, 'OPEN_AUCTION');
  assert(
    'OPEN_AUCTION reason 含降级关键词',
    /集合竞价|降级|单一价/.test(auctionMid.reason)
  );
  // 大单 (10%) 本来应走 POV, 集合竞价时段强制 LIMIT.
  const auctionLarge = routeExecutionPolicy({
    ...baseInput,
    amount_yuan: 10000000,
    now: sessionDate('09:20'),
  });
  eq('OPEN_AUCTION 大单 → LIMIT', auctionLarge.policy, 'LIMIT_AT_TOUCH');
  // 小单 (0.1%) 本来就是 LIMIT, session 路径不变化结果 (但 session 字段填对)
  const auctionSmall = routeExecutionPolicy({
    ...baseInput,
    now: sessionDate('09:20'),
  });
  eq('OPEN_AUCTION 小单 → LIMIT (本就 LIMIT)', auctionSmall.policy, 'LIMIT_AT_TOUCH');
  eq('OPEN_AUCTION 小单 session', auctionSmall.session, 'OPEN_AUCTION');

  // ---- 段 2: 连续竞价 (10:00) ----
  const continuousMid = routeExecutionPolicy({
    ...baseInput,
    amount_yuan: 1000000,
    now: sessionDate('10:00'),
  });
  eq('CONTINUOUS 中单 → TWAP', continuousMid.policy, 'TWAP');
  eq('CONTINUOUS session', continuousMid.session, 'CONTINUOUS');
  assert('CONTINUOUS TWAP slice > 1', continuousMid.slice_count > 1);
  const continuousLarge = routeExecutionPolicy({
    ...baseInput,
    amount_yuan: 10000000,
    now: sessionDate('10:00'),
  });
  eq('CONTINUOUS 大单 → POV', continuousLarge.policy, 'POV');
  // 连续竞价 + 高 vol 仍走 SKIP (硬约束优先)
  const continuousHighVol = routeExecutionPolicy({
    ...baseInput,
    current_volatility: 0.1,
    now: sessionDate('10:00'),
  });
  eq('CONTINUOUS + high vol → SKIP', continuousHighVol.policy, 'SKIP');
  eq('SKIP 时 session 字段也填', continuousHighVol.session, 'CONTINUOUS');

  // ---- 段 3: 收盘集合竞价 (14:58) ----
  const closeAuctionMid = routeExecutionPolicy({
    ...baseInput,
    amount_yuan: 1000000,
    now: sessionDate('14:58'),
  });
  eq('CLOSE_AUCTION 中单 → LIMIT (降级)', closeAuctionMid.policy, 'LIMIT_AT_TOUCH');
  eq('CLOSE_AUCTION session', closeAuctionMid.session, 'CLOSE_AUCTION');
  assert(
    'CLOSE_AUCTION reason 含降级关键词',
    /收盘集合竞价|降级/.test(closeAuctionMid.reason)
  );
  // 收盘集合竞价时段 WAIT 也不触发 (即便 gap_up + low)
  const closeAuctionGap = routeExecutionPolicy({
    ...baseInput,
    is_gap_up: true,
    urgency: 'low',
    now: sessionDate('14:58'),
  });
  eq('CLOSE_AUCTION + gap_up 不 WAIT', closeAuctionGap.policy, 'LIMIT_AT_TOUCH');

  // ---- 兜底: CLOSED 时段 (午休/盘后) 直接 SKIP ----
  const closedLunch = routeExecutionPolicy({ ...baseInput, now: sessionDate('12:00') });
  eq('CLOSED (午休) → SKIP', closedLunch.policy, 'SKIP');
  eq('CLOSED session', closedLunch.session, 'CLOSED');
  const closedAfter = routeExecutionPolicy({
    ...baseInput,
    amount_yuan: 1000000,
    now: sessionDate('15:30'),
  });
  eq('CLOSED (盘后) 中单也 SKIP', closedAfter.policy, 'SKIP');
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
testTradingSessionClassification();
testSessionDowngradeReason();
testRouteBySession();

console.log('');
console.log(`✅ passed=${passed}`);
console.log(`❌ failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
