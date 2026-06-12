/**
 * ExecutionFeasibilityService 单测 — Sprint 1B
 */
import {
  ExecutionFeasibilityService,
  computeLimitProximityScore,
  computeVolumeCoverageScore,
  computeSpreadScore,
  checkStatusConstraints,
  computeCompositeScore,
  deriveDecision,
  buildFeasibilitySummary,
  inferMarketSegment,
  getLimitPct,
  FILLABLE_THRESHOLD,
  BLOCKED_THRESHOLD,
  ExecutionFeasibilityDataSource,
} from '../../src/services/execution/ExecutionFeasibilityService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function testInferMarketSegment() {
  console.log('\n## inferMarketSegment');
  assert('60xxxx → main', inferMarketSegment('sh.600000') === 'main');
  assert('00xxxx → main', inferMarketSegment('sz.000001') === 'main');
  assert('30xxxx → chinext', inferMarketSegment('sz.300750') === 'chinext');
  assert('68xxxx → star', inferMarketSegment('sh.688001') === 'star');
  assert('8xxxxx → bj', inferMarketSegment('bj.830799') === 'bj');
}

function testGetLimitPct() {
  console.log('\n## getLimitPct');
  assert('main = 0.10', getLimitPct('main') === 0.10);
  assert('chinext = 0.20', getLimitPct('chinext') === 0.20);
  assert('star = 0.20', getLimitPct('star') === 0.20);
  assert('bj = 0.30', getLimitPct('bj') === 0.30);
  assert('st = 0.05', getLimitPct('st') === 0.05);
}

function testLimitProximity() {
  console.log('\n## computeLimitProximityScore');
  // 主板：prev_close=10, limit_up=11, current=10.5 → BUY distance = (11-10.5)/11 ≈ 0.045 → ~91
  const s1 = computeLimitProximityScore({
    side: 'BUY',
    current_price: 10.5,
    prev_close: 10,
    limit_pct: 0.10,
  });
  assert('BUY 中间价格 → > 50', s1 > 50, `score=${s1}`);

  // 已涨停 → 0
  const s2 = computeLimitProximityScore({
    side: 'BUY',
    current_price: 11,
    prev_close: 10,
    limit_pct: 0.10,
  });
  assert('BUY @ limit_up → 0', s2 === 0);

  // SELL 跌停 → 0
  const s3 = computeLimitProximityScore({
    side: 'SELL',
    current_price: 9,
    prev_close: 10,
    limit_pct: 0.10,
  });
  assert('SELL @ limit_down → 0', s3 === 0);

  // 充分距离 → 100
  const s4 = computeLimitProximityScore({
    side: 'BUY',
    current_price: 9,
    prev_close: 10,
    limit_pct: 0.10,
  });
  assert('BUY 远离涨停 → 100', s4 === 100);

  // prev_close <= 0 → 0
  const s5 = computeLimitProximityScore({
    side: 'BUY',
    current_price: 10,
    prev_close: 0,
    limit_pct: 0.10,
  });
  assert('prev_close=0 → 0', s5 === 0);
}

function testVolumeCoverage() {
  console.log('\n## computeVolumeCoverageScore');
  assert('ratio < 千分一 → 100', computeVolumeCoverageScore({ target_qty: 100, avg_volume_5d: 1000000 }) === 100);
  const s1 = computeVolumeCoverageScore({ target_qty: 5000, avg_volume_5d: 1000000 });
  assert('ratio = 0.5% → 80-100', (s1 ?? 0) >= 80 && (s1 ?? 0) <= 100, `score=${s1}`);
  const s2 = computeVolumeCoverageScore({ target_qty: 200000, avg_volume_5d: 1000000 });
  assert('ratio = 20% → 0', s2 === 0, `score=${s2}`);
  assert('avg_volume=0 → null', computeVolumeCoverageScore({ target_qty: 100, avg_volume_5d: 0 }) === null);
  assert('avg_volume=null → null', computeVolumeCoverageScore({ target_qty: 100, avg_volume_5d: null }) === null);
}

function testSpreadScore() {
  console.log('\n## computeSpreadScore');
  // proxy = (10.1 - 10) / 10.05 = 0.01 → 100
  const s1 = computeSpreadScore({ high: 10.1, low: 10, close: 10.05 });
  assert('proxy ≈ 1% → 100', s1 === 100, `score=${s1}`);
  // proxy = 10% → 20
  const s2 = computeSpreadScore({ high: 11, low: 10, close: 10.5 });
  assert('proxy > 5% → 20', s2 === 20, `score=${s2}`);
  assert('high=null → null', computeSpreadScore({ high: null, low: 10, close: 10 }) === null);
}

function testStatusConstraints() {
  console.log('\n## checkStatusConstraints');
  const ok = checkStatusConstraints({
    side: 'BUY',
    snapshot: { close: 10, is_limit_up: false, is_limit_down: false, is_suspended: false, is_st: false },
    as_of_date: '2026-06-13',
  });
  assert('all ok → score=100', ok.score === 100 && ok.reasons.length === 0);

  const suspended = checkStatusConstraints({
    side: 'BUY',
    snapshot: { close: 10, is_suspended: true },
    as_of_date: '2026-06-13',
  });
  assert('suspended → score=0', suspended.score === 0);
  assert('suspended → reason', suspended.reasons.includes('suspended'));

  const limitUpBuy = checkStatusConstraints({
    side: 'BUY',
    snapshot: { close: 11, is_limit_up: true },
    as_of_date: '2026-06-13',
  });
  assert('涨停拦截 BUY', limitUpBuy.score === 0 && limitUpBuy.reasons.includes('limit_up_blocked_buy'));

  // T+1
  const t1 = checkStatusConstraints({
    side: 'SELL',
    snapshot: { close: 10 },
    holding_buy_date: '2026-06-13',
    as_of_date: '2026-06-13',
  });
  assert('T+1 拦截 SELL', t1.score === 0 && t1.reasons.includes('t_plus_1_violation'));

  // ST = warning 不是 hard block
  const stWarn = checkStatusConstraints({
    side: 'BUY',
    snapshot: { close: 10, is_st: true },
    as_of_date: '2026-06-13',
  });
  assert('ST → warning only score=50', stWarn.score === 50);
}

function testCompositeScore() {
  console.log('\n## computeCompositeScore');
  const c1 = computeCompositeScore({
    limit_proximity: 100,
    volume_coverage: 100,
    spread: 100,
    status: 100,
    has_hard_block: false,
  });
  assert('全 100 → 100', c1 === 100);

  const c2 = computeCompositeScore({
    limit_proximity: 100,
    volume_coverage: 100,
    spread: 100,
    status: 100,
    has_hard_block: true,
  });
  assert('hard_block → 0', c2 === 0);

  const c3 = computeCompositeScore({
    limit_proximity: null,
    volume_coverage: null,
    spread: null,
    status: 100,
    has_hard_block: false,
  });
  assert('只有 status=100 → 100 (其他 null 跳过)', c3 === 100);
}

function testDeriveDecision() {
  console.log('\n## deriveDecision');
  assert('composite=80 → fillable', deriveDecision(80, false) === 'fillable');
  assert('composite=50 → risky', deriveDecision(50, false) === 'risky');
  assert('composite=20 → blocked', deriveDecision(20, false) === 'blocked');
  assert('hard_block → blocked', deriveDecision(95, true) === 'blocked');
}

function testBuildSummary() {
  console.log('\n## buildFeasibilitySummary');
  const fillable = buildFeasibilitySummary({
    decision: 'fillable',
    composite: 85.5,
    block_reasons: [],
    side: 'BUY',
    symbol: 'sh.600000',
  });
  assert('fillable 含 ✅', fillable.includes('✅'));

  const blocked = buildFeasibilitySummary({
    decision: 'blocked',
    composite: 0,
    block_reasons: ['suspended'],
    side: 'BUY',
    symbol: 'sh.600000',
  });
  assert('blocked 含 🔴', blocked.includes('🔴'));
  assert('blocked 含 suspended', blocked.includes('suspended'));
}

async function testServiceComputeFeasibility() {
  console.log('\n## computeFeasibility end-to-end');
  const fakeSource: ExecutionFeasibilityDataSource = {
    async loadMarketSnapshot(symbol) {
      if (symbol === 'NODATA') return null;
      return {
        close: 10,
        open: 9.95,
        high: 10.1,
        low: 9.9,
        prev_close: 10,
        volume: 1000000,
        avg_volume_5d: 800000,
        is_limit_up: false,
        is_limit_down: false,
        is_suspended: false,
        is_st: false,
      };
    },
  };
  const svc = new ExecutionFeasibilityService(fakeSource);

  const r1 = await svc.computeFeasibility({
    symbol: 'sh.600000',
    side: 'BUY',
    target_qty: 100,
    as_of_date: '2026-06-13',
  });
  assert('正常 BUY → fillable', r1.decision === 'fillable', `composite=${r1.composite_score}`);

  const r2 = await svc.computeFeasibility({
    symbol: 'NODATA',
    side: 'BUY',
    target_qty: 100,
    as_of_date: '2026-06-13',
  });
  assert('无数据 → blocked', r2.decision === 'blocked');
  assert('无数据 reason', r2.block_reasons.includes('no_market_data'));

  // 大单 → risky/blocked
  const r3 = await svc.computeFeasibility({
    symbol: 'sh.600000',
    side: 'BUY',
    target_qty: 200000,
    as_of_date: '2026-06-13',
  });
  assert('大单 → composite 较低', r3.composite_score < r1.composite_score, `large=${r3.composite_score} normal=${r1.composite_score}`);

  // batch
  const reports = await svc.computeBatch([
    { symbol: 'sh.600000', side: 'BUY', target_qty: 100, as_of_date: '2026-06-13' },
    { symbol: 'NODATA', side: 'BUY', target_qty: 100, as_of_date: '2026-06-13' },
  ]);
  assert('batch 返回 2 个', reports.length === 2);
}

async function main() {
  testInferMarketSegment();
  testGetLimitPct();
  testLimitProximity();
  testVolumeCoverage();
  testSpreadScore();
  testStatusConstraints();
  testCompositeScore();
  testDeriveDecision();
  testBuildSummary();
  await testServiceComputeFeasibility();
  console.log(`\n========================================`);
  console.log(`ExecutionFeasibilityService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
