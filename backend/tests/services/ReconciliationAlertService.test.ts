/**
 * ReconciliationAlertService 单元测试 (BETA-2, audit S-12)
 *
 *   cd backend && npx ts-node --transpile-only tests/services/ReconciliationAlertService.test.ts
 *
 * 覆盖:
 *  - classifyReconciliation: aligned / drift_medium / drift_high / stale / not_bound
 *  - computeSymbolsHash: 同 input → 同 hash; symbols 变 → hash 变; aligned 特殊值
 *  - isSignatureFresh: 在窗口内 / 已过期 / 不存在
 *
 * 不写 runForUser / runOnce 集成（依赖 LiveTradingService.getReconciliation + DB）。
 */

import {
  classifyReconciliation,
  computeSymbolsHash,
  isSignatureFresh,
} from '../../src/live-trading/services/ReconciliationAlertService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}

// ============ classifyReconciliation ============

function test_classify_high_low_score() {
  const r = classifyReconciliation({
    alignment_score: 50,
    live_only_count: 0,
    paper_only_count: 0,
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'high_divergence',
  });
  assert('aligned<70 → HIGH', r.severity === 'HIGH');
}

function test_classify_high_drift_count() {
  const r = classifyReconciliation({
    alignment_score: 90,
    live_only_count: 3,
    paper_only_count: 1, // drift=4 > 3
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'aligned',
  });
  assert('drift>3 → HIGH', r.severity === 'HIGH');
}

function test_classify_stale() {
  const r = classifyReconciliation({
    alignment_score: 95,
    live_only_count: 0,
    paper_only_count: 0,
    snapshot_age_minutes: 300, // > 180
    stale_threshold_minutes: 180,
    status: 'aligned',
  });
  assert('stale → HIGH', r.severity === 'HIGH');
  assert('stale → symbol=STALE', r.symbol.includes('STALE'));
}

function test_classify_stale_by_status() {
  const r = classifyReconciliation({
    alignment_score: 95,
    live_only_count: 0,
    paper_only_count: 0,
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'stale',
  });
  assert('status=stale → HIGH', r.severity === 'HIGH');
}

function test_classify_medium_score() {
  const r = classifyReconciliation({
    alignment_score: 75,
    live_only_count: 0,
    paper_only_count: 0,
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'diverged',
  });
  assert('70 ≤ score < 85 → MEDIUM', r.severity === 'MEDIUM');
}

function test_classify_medium_drift() {
  const r = classifyReconciliation({
    alignment_score: 90,
    live_only_count: 1,
    paper_only_count: 1, // drift=2
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'aligned',
  });
  assert('drift 1-3 → MEDIUM', r.severity === 'MEDIUM');
}

function test_classify_aligned_none() {
  const r = classifyReconciliation({
    alignment_score: 95,
    live_only_count: 0,
    paper_only_count: 0,
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'aligned',
  });
  assert('aligned → NONE', r.severity === 'NONE');
}

function test_classify_not_bound() {
  const r = classifyReconciliation({
    alignment_score: null,
    live_only_count: 0,
    paper_only_count: 0,
    snapshot_age_minutes: null,
    stale_threshold_minutes: 180,
    status: 'not_bound',
  });
  assert('not_bound (score=null) → NONE', r.severity === 'NONE');
}

// ============ computeSymbolsHash ============

function test_hash_aligned_special() {
  const h = computeSymbolsHash([{ symbol: '600519', status: 'aligned' }]);
  assert('全 aligned → hash=aligned', h === 'aligned');
}

function test_hash_drift_consistent() {
  const matches = [
    { symbol: '600519', status: 'live_only' },
    { symbol: '300750', status: 'paper_only' },
  ];
  const h1 = computeSymbolsHash(matches);
  const h2 = computeSymbolsHash(matches);
  assert('同 input → 同 hash', h1 === h2);
  assert('drift hash 非 aligned', h1 !== 'aligned');
}

function test_hash_changes_with_symbols() {
  const a = computeSymbolsHash([{ symbol: '600519', status: 'live_only' }]);
  const b = computeSymbolsHash([{ symbol: '300750', status: 'live_only' }]);
  assert('不同 symbol → 不同 hash', a !== b);
}

function test_hash_order_insensitive() {
  const a = computeSymbolsHash([
    { symbol: '600519', status: 'live_only' },
    { symbol: '300750', status: 'paper_only' },
  ]);
  const b = computeSymbolsHash([
    { symbol: '300750', status: 'paper_only' },
    { symbol: '600519', status: 'live_only' },
  ]);
  assert('hash 顺序无关 (内部 sort)', a === b);
}

// ============ isSignatureFresh ============

function test_signature_fresh_in_window() {
  const now = 1_000_000_000_000;
  const seen = [{ sig: 'HIGH::abc::intraday', pushed_at_ms: now - 5 * 60 * 1000 }];
  assert(
    '5 min 前推过 (<30min window) → fresh',
    isSignatureFresh(seen, 'HIGH::abc::intraday', 30 * 60 * 1000, now) === true
  );
}

function test_signature_stale_outside_window() {
  const now = 1_000_000_000_000;
  const seen = [{ sig: 'HIGH::abc::intraday', pushed_at_ms: now - 31 * 60 * 1000 }];
  assert(
    '31 min 前推过 → 不 fresh',
    isSignatureFresh(seen, 'HIGH::abc::intraday', 30 * 60 * 1000, now) === false
  );
}

function test_signature_unknown() {
  const now = 1_000_000_000_000;
  const seen = [{ sig: 'HIGH::other::intraday', pushed_at_ms: now - 1000 }];
  assert(
    '未推过 → 不 fresh',
    isSignatureFresh(seen, 'HIGH::abc::intraday', 30 * 60 * 1000, now) === false
  );
}

test_classify_high_low_score();
test_classify_high_drift_count();
test_classify_stale();
test_classify_stale_by_status();
test_classify_medium_score();
test_classify_medium_drift();
test_classify_aligned_none();
test_classify_not_bound();
test_hash_aligned_special();
test_hash_drift_consistent();
test_hash_changes_with_symbols();
test_hash_order_insensitive();
test_signature_fresh_in_window();
test_signature_stale_outside_window();
test_signature_unknown();

console.log('');
console.log(`✅ passed=${passed}`);
console.log(`❌ failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
