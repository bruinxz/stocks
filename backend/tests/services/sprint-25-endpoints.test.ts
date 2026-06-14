/**
 * Sprint 25 Endpoint Smoke Test
 *
 * 直接调用 controller 方法 (绕 express + auth) 验证 7 个新 endpoint 的纯函数链路:
 *
 *   1. POST /attribution/brinson
 *   2. POST /attribution/mcr
 *   3. POST /attribution/crowding
 *   4. POST /attribution/vol-target
 *   5. POST /strategy-health/capacity
 *   6. POST /strategy-health/alpha-decay
 *   7. GET  /strategy-health/signal-half-lives
 */

import { advancedQuantController } from '../../src/api/controllers/AdvancedQuantController';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function makeRes() {
  const result: any = { statusCode: 200, body: null };
  return {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: any) {
      result.body = body;
      return this;
    },
    _result: result,
  } as any;
}

async function testBrinson() {
  console.log('\n## 1. POST /attribution/brinson');
  const req = {
    body: {
      industries: ['banks', 'banks', 'tech', 'tech', 'pharma'],
      portfolio_weights: [0.20, 0.10, 0.30, 0.15, 0.25],
      benchmark_weights: [0.15, 0.15, 0.20, 0.20, 0.30],
      stock_returns: [0.05, -0.02, 0.10, 0.08, 0.03],
    },
  } as any;
  const res = makeRes();
  await advancedQuantController.runBrinsonAttribution(req, res);
  assert('brinson 200', res._result.statusCode === 200);
  assert('brinson success', res._result.body?.success === true);
  assert('brinson 有 active_return', typeof res._result.body?.data?.active_return === 'number',
    `active=${res._result.body?.data?.active_return?.toFixed(4)}`);
  assert('brinson 有 industry_attribution', Array.isArray(res._result.body?.data?.industry_attribution));
  assert('brinson industry_attribution 3 行业 (聚合后)',
    res._result.body?.data?.industry_attribution?.length === 3);
}

async function testMcr() {
  console.log('\n## 2. POST /attribution/mcr');
  const req = {
    body: {
      weights: [0.4, 0.3, 0.3],
      cov: [
        [0.04, 0.02, 0.01],
        [0.02, 0.09, 0.015],
        [0.01, 0.015, 0.0625],
      ],
      symbols: ['A', 'B', 'C'],
      top_n: 2,
    },
  } as any;
  const res = makeRes();
  await advancedQuantController.runMcr(req, res);
  assert('mcr 200', res._result.statusCode === 200);
  assert('mcr 有 portfolio_vol', typeof res._result.body?.data?.mcr?.portfolio_vol === 'number',
    `vol=${res._result.body?.data?.mcr?.portfolio_vol?.toFixed(4)}`);
  assert('mcr 有 pct_contribution[3]',
    res._result.body?.data?.mcr?.pct_contribution?.length === 3);
  assert('mcr 有 top_contributors[2]',
    res._result.body?.data?.top_contributors?.length === 2);

  // 边界: 缺 weights → 400
  const badRes = makeRes();
  await advancedQuantController.runMcr({ body: { cov: [[1]] } } as any, badRes);
  assert('mcr 缺 weights → 400', badRes._result.statusCode === 400);
}

async function testCrowding() {
  console.log('\n## 3. POST /attribution/crowding');
  const req = {
    body: {
      signal: [0.05, 0.03, 0.08, -0.02, 0.06],
      market_consensus: [0.06, 0.04, 0.07, -0.01, 0.05],
      fund_concentration_change: 0.1,
      margin_balance_change: 0.15,
    },
  } as any;
  const res = makeRes();
  await advancedQuantController.runCrowdingScore(req, res);
  assert('crowding 200', res._result.statusCode === 200);
  assert('crowding 有 consensus_correlation', typeof res._result.body?.data?.consensus_correlation === 'number');
  assert('crowding 有 crowding_score 0-100',
    res._result.body?.data?.crowding_score >= 0 && res._result.body?.data?.crowding_score <= 100,
    `score=${res._result.body?.data?.crowding_score}`);
}

async function testVolTarget() {
  console.log('\n## 4. POST /attribution/vol-target');
  const req = {
    body: {
      weights: [0.5, 0.5],
      cov: [[0.04, 0.01], [0.01, 0.09]],
      vol_target_annual: 0.15,
      max_leverage: 2.0,
      prev_leverage: 1.0,
      buffer_pct: 0.05,
    },
  } as any;
  const res = makeRes();
  await advancedQuantController.runVolTargeting(req, res);
  assert('vol-target 200', res._result.statusCode === 200);
  assert('vol-target 有 applied_leverage > 0',
    res._result.body?.data?.applied_leverage > 0,
    `lev=${res._result.body?.data?.applied_leverage?.toFixed(2)}`);
  assert('vol-target 有 scaled_weights[2]',
    res._result.body?.data?.scaled_weights?.length === 2);
}

async function testCapacity() {
  console.log('\n## 5. POST /strategy-health/capacity');
  const req = {
    body: {
      stock_adv_values: [
        { symbol: 'sh.600519', adv_cny: 8_000_000_000 },
        { symbol: 'sz.000001', adv_cny: 1_500_000_000 },
        { symbol: 'sh.600036', adv_cny: 3_000_000_000 },
      ],
      positions_per_stock_pct: 0.05,
      n_holding_days: 20,
      participation_rate: 0.15,
      n_trades_per_year: 12,
    },
  } as any;
  const res = makeRes();
  await advancedQuantController.estimateCapacity(req, res);
  assert('capacity 200', res._result.statusCode === 200);
  assert('capacity 有 capacity_cny > 0',
    res._result.body?.data?.capacity_cny > 0,
    `cap=${res._result.body?.data?.capacity_cny?.toLocaleString()}`);
  assert('capacity 有 bottleneck_symbol',
    typeof res._result.body?.data?.bottleneck_symbol === 'string',
    `bottle=${res._result.body?.data?.bottleneck_symbol}`);
  assert('capacity bottleneck = 流通额最小 (000001)',
    res._result.body?.data?.bottleneck_symbol === 'sz.000001');
  assert('capacity 有 grade',
    ['high', 'medium', 'low'].includes(res._result.body?.data?.capacity_grade));
}

async function testAlphaDecay() {
  console.log('\n## 6. POST /strategy-health/alpha-decay');
  // 模拟 momentum 信号衰减
  const req = {
    body: {
      signal_name: 'momentum_1m',
      observed_ic_series: [
        { days_after_signal: 1, ic: 0.10 },
        { days_after_signal: 5, ic: 0.08 },
        { days_after_signal: 10, ic: 0.05 },
        { days_after_signal: 20, ic: 0.02 },
        { days_after_signal: 30, ic: 0.01 },
        { days_after_signal: 60, ic: 0.005 },
      ],
    },
  } as any;
  const res = makeRes();
  await advancedQuantController.monitorDecay(req, res);
  assert('alpha-decay 200', res._result.statusCode === 200);
  assert('alpha-decay 有 decay_status',
    ['accelerated', 'normal', 'extended', 'unknown'].includes(res._result.body?.data?.decay_status),
    `status=${res._result.body?.data?.decay_status}`);
  assert('alpha-decay 有 recommendation',
    typeof res._result.body?.data?.recommendation === 'string');
  assert('alpha-decay 含 known_signals 列表',
    Array.isArray(res._result.body?.data?.known_signals));
}

async function testListSignalHalfLives() {
  console.log('\n## 7. GET /strategy-health/signal-half-lives');
  const res = makeRes();
  await advancedQuantController.listSignalHalfLives({} as any, res);
  assert('half-lives 200', res._result.statusCode === 200);
  assert('half-lives 有 signals[]', Array.isArray(res._result.body?.data?.signals));
  assert('half-lives 至少 5 个已知 signal',
    res._result.body?.data?.signals?.length >= 5);
  assert('half-lives 每条有 expected_half_life_days',
    res._result.body?.data?.signals?.every((s: any) => typeof s.expected_half_life_days === 'number'));
}

async function main() {
  console.log('=== Sprint 25 Endpoint Smoke Test ===');
  await testBrinson();
  await testMcr();
  await testCrowding();
  await testVolTarget();
  await testCapacity();
  await testAlphaDecay();
  await testListSignalHalfLives();
  console.log(`\n========================================`);
  console.log(`Sprint 25: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
