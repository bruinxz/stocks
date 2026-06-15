/**
 * l8-activation.test.ts — Sprint 27 helpers 单测
 *
 * 覆盖 5 个纯函数 + 类型不变量:
 *   - newActivation: 全 false 初始化, reached_layer='L1_data', final_outcome='pending'
 *   - markReached: snap.reached=true, 自动更新 reached_layer = max(prev, layer)
 *   - markBlocked: 同时 set reached + blocked, blocked_at 首次胜出
 *   - markContributed: 同时 set reached + contributed (互斥 blocked 由调用方保证)
 *   - setOutcome: 改 final_outcome
 *   - LAYER_ORDER 不变量: 8 层 + 顺序 L1..L8
 */

import {
  newActivation,
  markReached,
  markBlocked,
  markContributed,
  setOutcome,
  LAYER_ORDER,
  type LayerKey,
} from '../../src/portfolio/internal/l8-activation';

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

function testLayerOrder() {
  console.log('\n## LAYER_ORDER');
  assert('LAYER_ORDER 8 层', LAYER_ORDER.length === 8);
  const expected: LayerKey[] = [
    'L1_data',
    'L2_signal',
    'L3_meta',
    'L4_construction',
    'L5_feasibility',
    'L6_risk',
    'L7_governor',
    'L8_reflection',
  ];
  for (let i = 0; i < expected.length; i += 1) {
    assert(`LAYER_ORDER[${i}] = ${expected[i]}`, LAYER_ORDER[i] === expected[i]);
  }
}

function testNewActivation() {
  console.log('\n## newActivation');
  const a = newActivation();
  assert('reached_layer = L1_data', a.reached_layer === 'L1_data');
  assert('final_outcome = pending', a.final_outcome === 'pending');
  assert('blocked_at undefined', a.blocked_at === undefined);
  for (const layer of LAYER_ORDER) {
    assert(`${layer}.reached = false`, a[layer].reached === false);
    assert(`${layer}.blocked = false`, a[layer].blocked === false);
    assert(`${layer}.contributed = false`, a[layer].contributed === false);
    assert(`${layer}.detail undefined`, a[layer].detail === undefined);
  }
}

function testMarkReached() {
  console.log('\n## markReached');
  const a = newActivation();
  markReached(a, 'L3_meta', { confidence: 0.78 });
  assert('L3_meta.reached', a.L3_meta.reached);
  assert('L3_meta.blocked still false', a.L3_meta.blocked === false);
  assert('L3_meta.contributed still false', a.L3_meta.contributed === false);
  assert('reached_layer advanced to L3_meta', a.reached_layer === 'L3_meta');
  assert('detail.confidence = 0.78', a.L3_meta.detail?.confidence === 0.78);

  // 再标 L5_feasibility — reached_layer 应进到 L5
  markReached(a, 'L5_feasibility');
  assert('reached_layer advanced to L5_feasibility', a.reached_layer === 'L5_feasibility');

  // 再标更早的 L2 — reached_layer 不应回退
  markReached(a, 'L2_signal');
  assert('reached_layer NOT regressed to L2', a.reached_layer === 'L5_feasibility');
  assert('L2_signal.reached now true', a.L2_signal.reached === true);

  // detail 合并 (不替换)
  markReached(a, 'L3_meta', { threshold: 0.55 });
  assert('detail.confidence still present', a.L3_meta.detail?.confidence === 0.78);
  assert('detail.threshold new', a.L3_meta.detail?.threshold === 0.55);
}

function testMarkBlocked() {
  console.log('\n## markBlocked');
  const a = newActivation();
  markBlocked(a, 'L5_feasibility', { reason: '涨停板封单' });
  assert('L5.blocked true', a.L5_feasibility.blocked === true);
  assert('L5.reached also true (block 即 reached)', a.L5_feasibility.reached === true);
  assert('blocked_at = L5_feasibility', a.blocked_at === 'L5_feasibility');
  assert('reached_layer = L5_feasibility', a.reached_layer === 'L5_feasibility');

  // 再 block L6 — blocked_at 应保留首次
  markBlocked(a, 'L6_risk', { reason: '行业集中' });
  assert('blocked_at NOT overwritten (still L5)', a.blocked_at === 'L5_feasibility');
  assert('L6.blocked also true', a.L6_risk.blocked === true);
}

function testMarkContributed() {
  console.log('\n## markContributed');
  const a = newActivation();
  markContributed(a, 'L7_governor', { multiplier: 0.7 });
  assert('L7.contributed true', a.L7_governor.contributed === true);
  assert('L7.reached also true (contributed 即 reached)', a.L7_governor.reached === true);
  assert('L7.blocked still false', a.L7_governor.blocked === false);
  assert('reached_layer advanced to L7', a.reached_layer === 'L7_governor');
  assert('detail.multiplier = 0.7', a.L7_governor.detail?.multiplier === 0.7);
}

function testSetOutcome() {
  console.log('\n## setOutcome');
  const a = newActivation();
  assert('init outcome = pending', a.final_outcome === 'pending');
  setOutcome(a, 'executed');
  assert('after setOutcome executed', a.final_outcome === 'executed');
  setOutcome(a, 'skipped');
  assert('overwrite to skipped', a.final_outcome === 'skipped');
  setOutcome(a, 'rejected');
  assert('overwrite to rejected', a.final_outcome === 'rejected');
}

function testFullFlowExecuted() {
  console.log('\n## 完整流程 (executed)');
  const a = newActivation();
  markReached(a, 'L1_data', { quality_bucket: 'high' });
  markReached(a, 'L2_signal', { strategy_key: 'macd_trend' });
  markContributed(a, 'L3_meta', { decision: 'bet', confidence: 0.78 });
  markContributed(a, 'L5_feasibility', { decision: 'fillable' });
  markReached(a, 'L6_risk', { allowed: true });
  markReached(a, 'L7_governor', { multiplier: 1.0 });
  markReached(a, 'L8_reflection', { trade_id: 999 });
  setOutcome(a, 'executed');

  assert('reached_layer = L8_reflection', a.reached_layer === 'L8_reflection');
  assert('blocked_at undefined (no block)', a.blocked_at === undefined);
  assert('final_outcome = executed', a.final_outcome === 'executed');
  assert('L4_construction.reached = false (mode off)', a.L4_construction.reached === false);
}

function testFullFlowBlocked() {
  console.log('\n## 完整流程 (blocked at L5)');
  const a = newActivation();
  markReached(a, 'L1_data');
  markReached(a, 'L2_signal');
  markContributed(a, 'L3_meta', { decision: 'bet' });
  markBlocked(a, 'L5_feasibility', { reason: 'no_market_data' });
  setOutcome(a, 'rejected');

  assert('reached_layer = L5_feasibility', a.reached_layer === 'L5_feasibility');
  assert('blocked_at = L5_feasibility', a.blocked_at === 'L5_feasibility');
  assert('final_outcome = rejected', a.final_outcome === 'rejected');
  assert('L6_risk.reached = false (loop continues)', a.L6_risk.reached === false);
  assert('L8_reflection.reached = false', a.L8_reflection.reached === false);
}

function testJsonbSafe() {
  console.log('\n## JSONB-safe (round-trip via JSON)');
  const a = newActivation();
  markReached(a, 'L3_meta', { confidence: 0.78, model_version: 'v1-logistic-2026-06-15' });
  markContributed(a, 'L7_governor', { multiplier: 0.7, before_pct: 5.0, after_pct: 3.5 });
  setOutcome(a, 'executed');

  const serialized = JSON.stringify(a);
  const parsed = JSON.parse(serialized);
  assert('round-trip preserves reached_layer', parsed.reached_layer === 'L7_governor');
  assert('round-trip preserves final_outcome', parsed.final_outcome === 'executed');
  assert(
    'round-trip preserves L3 detail',
    parsed.L3_meta.detail.confidence === 0.78 &&
      parsed.L3_meta.detail.model_version === 'v1-logistic-2026-06-15'
  );
  assert(
    'round-trip preserves L7 detail',
    parsed.L7_governor.detail.multiplier === 0.7
  );
}

function main() {
  testLayerOrder();
  testNewActivation();
  testMarkReached();
  testMarkBlocked();
  testMarkContributed();
  testSetOutcome();
  testFullFlowExecuted();
  testFullFlowBlocked();
  testJsonbSafe();
  console.log(`\n========================================`);
  console.log(`l8-activation tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
