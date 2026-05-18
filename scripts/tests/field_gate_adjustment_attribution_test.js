#!/usr/bin/env node

/**
 * Lightweight unit coverage for FieldGateAdjustmentAttributionService.
 * Runs without DB/network and locks the key decision branches used by
 * strategy policy snapshots, task health, and Feishu structured summaries.
 */

require('../../backend/node_modules/ts-node').register({
  transpileOnly: true,
  project: require('path').join(__dirname, '../../backend/tsconfig.json'),
});

const assert = require('assert');
const {
  fieldGateAdjustmentAttributionService,
} = require('../../backend/src/services/FieldGateAdjustmentAttributionService');

const changedAt = '2026-01-10T00:00:00.000Z';
const dayMs = 24 * 60 * 60 * 1000;

function at(offsetDays) {
  return new Date(new Date(changedAt).getTime() + offsetDays * dayMs).toISOString();
}

function snapshot(offsetDays, excess) {
  return {
    generated_at: at(offsetDays),
    avg_excess_return_pct: excess,
  };
}

function build(afterExcessValues, beforeExcessValues = [0, 0]) {
  return fieldGateAdjustmentAttributionService.build(
    [
      ...afterExcessValues.map((value, index) => snapshot(index + 1, value)),
      ...beforeExcessValues.map((value, index) => snapshot(-index - 1, value)),
    ],
    {
      source: 'filled_from_outcome_advice',
      changed_at: changedAt,
      task_name: '测试任务',
    }
  );
}

function testNoAdjustment() {
  const result = fieldGateAdjustmentAttributionService.build([snapshot(1, 3)], {
    source: 'manual_input',
    changed_at: changedAt,
  });
  assert.strictEqual(result.status, 'no_advice_adjustment');
  assert.strictEqual(result.decision.action, 'insufficient');
}

function testInsufficient() {
  const result = build([2], [0]);
  assert.strictEqual(result.status, 'insufficient_samples');
  assert.strictEqual(result.decision.action, 'insufficient');
}

function testSupport() {
  const result = build([1.2, 1.4, 1.1], [0, 0.1]);
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.decision.action, 'support');
  assert.ok(result.delta_pct > 0.4, `expected positive delta, got ${result.delta_pct}`);
  assert.strictEqual(result.windows.length, 3);
}

function testCaution() {
  const result = build([-0.8, -0.7, -0.9], [0.4, 0.5]);
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.decision.action, 'caution');
  assert.ok(result.delta_pct < -0.4, `expected negative delta, got ${result.delta_pct}`);
}

function testObserve() {
  const result = build([0.1, 0.15, 0.2], [0, 0.05]);
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.decision.action, 'observe');
}

for (const test of [testNoAdjustment, testInsufficient, testSupport, testCaution, testObserve]) {
  test();
  console.log(`[PASS] ${test.name}`);
}

console.log('FieldGateAdjustmentAttributionService tests passed.');
