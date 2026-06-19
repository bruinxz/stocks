/**
 * ReconciliationAlertService 单元测试 (BETA-2, audit S-12; US-017 [EX-003] 看板扩展)
 *
 *   cd backend && npx ts-node --transpile-only tests/services/ReconciliationAlertService.test.ts
 *
 * 覆盖:
 *  - classifyReconciliation: aligned / drift_medium / drift_high / stale / not_bound
 *  - computeSymbolsHash: 同 input → 同 hash; symbols 变 → hash 变; aligned 特殊值
 *  - isSignatureFresh: 在窗口内 / 已过期 / 不存在
 *  - runForUser 集成 (US-017): liveTradingService stub → 验证 Prometheus snapshot/alert
 *    metric 被正确写入 (alignment / drift / age 三联 + alerts_total counter).
 *
 * 不写完整 runOnce 集成（依赖 LiveBrokerAccount DB）；runForUser 走 stub.
 */

import {
  ReconciliationAlertService,
  classifyReconciliation,
  computeSymbolsHash,
  isSignatureFresh,
} from '../../src/live-trading/services/ReconciliationAlertService';
import {
  __resetPrometheusBundleForTests,
  getPrometheusBundle,
} from '../../src/metrics/PrometheusRegistry';

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

// ============ US-017 [EX-003] runForUser → Prometheus metric 集成 ============
//
// 思路:
//   - 不动 RiskAlert / User model (stub 走 dry_run=true 关掉 write 路径)
//   - stub liveTradingService.getReconciliation 返回造数据
//   - 验证 reconciliation_alignment_score / drift / age gauge + alerts_total counter
//
// fail-OPEN 形态: 不需要担心 metric 出错阻塞主流程; 这里 assert metric 真被写入.

async function metricValueByName(
  metricName: string,
  labels: Record<string, string>
): Promise<number> {
  const bundle = getPrometheusBundle();
  const json = await bundle.registry.getMetricsAsJSON();
  const m = json.find(x => x.name === metricName);
  if (!m) return 0;
  const v = (m as any).values?.find((entry: any) => {
    for (const k of Object.keys(labels)) {
      if (String(entry.labels?.[k]) !== labels[k]) return false;
    }
    return true;
  });
  return v?.value || 0;
}

async function test_runForUser_writes_snapshot_metric_dry_run() {
  // 重置 singleton 让 metric 从 0 起算
  __resetPrometheusBundleForTests();

  // stub liveTradingService.getReconciliation
  const ltModule = require('../../src/live-trading/services/LiveTradingService');
  const origGetRec = ltModule.liveTradingService.getReconciliation;
  ltModule.liveTradingService.getReconciliation = async (_uid: number) => ({
    status: 'diverged',
    snapshot_age_minutes: 12,
    stale_threshold_minutes: 180,
    summary: {
      alignment_score: 72.5, // MEDIUM 区间
      live_only_count: 1,
      paper_only_count: 1,
    },
    position_matches: [
      { symbol: '600519', status: 'live_only', live_quantity: 100, paper_quantity: 0 },
      { symbol: '300750', status: 'paper_only', live_quantity: 0, paper_quantity: 200 },
      { symbol: '601318', status: 'live_overweight', live_quantity: 50, paper_quantity: 30 },
    ],
  });

  try {
    const service = new ReconciliationAlertService();
    const r = await service.runForUser(7, { window: 'intraday', dry_run: true });
    assert('dry_run severity MEDIUM', r.severity === 'MEDIUM');
    assert('dry_run alert_written=false', r.alert_written === false);
    assert('dry_run scanned=true', r.scanned === true);

    // gauge 应被覆盖式写入
    const align = await metricValueByName('reconciliation_alignment_score', { user_id: '7' });
    assert('metric alignment_score=72.5', Math.abs(align - 72.5) < 1e-6, `actual=${align}`);
    const age = await metricValueByName('reconciliation_snapshot_age_minutes', { user_id: '7' });
    assert('metric snapshot_age=12', age === 12, `actual=${age}`);
    const liveOnly = await metricValueByName('reconciliation_drift_positions', {
      user_id: '7',
      side: 'live_only',
    });
    assert('metric drift live_only=1', liveOnly === 1, `actual=${liveOnly}`);
    const paperOnly = await metricValueByName('reconciliation_drift_positions', {
      user_id: '7',
      side: 'paper_only',
    });
    assert('metric drift paper_only=1', paperOnly === 1, `actual=${paperOnly}`);
    const overweight = await metricValueByName('reconciliation_drift_positions', {
      user_id: '7',
      side: 'live_overweight',
    });
    assert('metric drift live_overweight=1', overweight === 1, `actual=${overweight}`);

    // dry_run 不写 alert → counter 不应被 inc
    const counter = await metricValueByName('reconciliation_alerts_total', {
      severity: 'MEDIUM',
      window: 'intraday',
    });
    assert('dry_run does NOT inc alerts_total', counter === 0, `actual=${counter}`);
  } finally {
    ltModule.liveTradingService.getReconciliation = origGetRec;
  }
}

async function test_runForUser_none_severity_emits_metric() {
  __resetPrometheusBundleForTests();
  const ltModule = require('../../src/live-trading/services/LiveTradingService');
  const origGetRec = ltModule.liveTradingService.getReconciliation;
  ltModule.liveTradingService.getReconciliation = async (_uid: number) => ({
    status: 'aligned',
    snapshot_age_minutes: 5,
    stale_threshold_minutes: 180,
    summary: { alignment_score: 96, live_only_count: 0, paper_only_count: 0 },
    position_matches: [{ symbol: '600519', status: 'aligned' }],
  });

  try {
    const service = new ReconciliationAlertService();
    const r = await service.runForUser(8, { window: 'eod' });
    assert('aligned severity NONE', r.severity === 'NONE');
    assert('aligned alert_written=false', r.alert_written === false);
    const align = await metricValueByName('reconciliation_alignment_score', { user_id: '8' });
    assert('NONE branch still writes alignment metric', align === 96);
    const counter = await metricValueByName('reconciliation_alerts_total', {
      severity: 'NONE',
      window: 'eod',
    });
    assert('NONE branch inc alerts_total{severity=NONE,window=eod}', counter === 1);
  } finally {
    ltModule.liveTradingService.getReconciliation = origGetRec;
  }
}

async function test_runForUser_failed_recon_does_not_record_metric() {
  __resetPrometheusBundleForTests();
  const ltModule = require('../../src/live-trading/services/LiveTradingService');
  const origGetRec = ltModule.liveTradingService.getReconciliation;
  ltModule.liveTradingService.getReconciliation = async () => {
    throw new Error('boom');
  };
  try {
    const service = new ReconciliationAlertService();
    const r = await service.runForUser(9, {});
    assert('error path scanned=false', r.scanned === false);
    assert('error path has error msg', !!r.error);
    const align = await metricValueByName('reconciliation_alignment_score', { user_id: '9' });
    assert('error path does NOT write metric', align === 0);
  } finally {
    ltModule.liveTradingService.getReconciliation = origGetRec;
  }
}

async function runIntegration() {
  await test_runForUser_writes_snapshot_metric_dry_run();
  await test_runForUser_none_severity_emits_metric();
  await test_runForUser_failed_recon_does_not_record_metric();

  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runIntegration().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exit(1);
});
