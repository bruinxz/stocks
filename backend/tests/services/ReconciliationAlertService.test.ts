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
  normalizeReconciliationAlertConfig,
  DEFAULT_RECONCILIATION_ALERT_CONFIG,
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

// ============ US-137 [EX-012] ReconciliationAlertConfig 阈值持久化 ============

function test_default_config_frozen() {
  assert(
    'DEFAULT_RECONCILIATION_ALERT_CONFIG frozen',
    Object.isFrozen(DEFAULT_RECONCILIATION_ALERT_CONFIG)
  );
  assert(
    'DEFAULT enabled=true',
    DEFAULT_RECONCILIATION_ALERT_CONFIG.enabled === true
  );
  assert(
    'DEFAULT alignment_score_high=70 (v1 hardcoded 兼容)',
    DEFAULT_RECONCILIATION_ALERT_CONFIG.alignment_score_high_threshold === 70
  );
  assert(
    'DEFAULT alignment_score_medium=85 (v1 hardcoded 兼容)',
    DEFAULT_RECONCILIATION_ALERT_CONFIG.alignment_score_medium_threshold === 85
  );
  assert(
    'DEFAULT drift_count_high=3 (v1 hardcoded 兼容)',
    DEFAULT_RECONCILIATION_ALERT_CONFIG.drift_count_high_threshold === 3
  );
  assert(
    'DEFAULT drift_count_medium=1 (v1 hardcoded 兼容)',
    DEFAULT_RECONCILIATION_ALERT_CONFIG.drift_count_medium_threshold === 1
  );
  assert(
    'DEFAULT dedupe_window_minutes=30 (v1 hardcoded 兼容)',
    DEFAULT_RECONCILIATION_ALERT_CONFIG.dedupe_window_minutes === 30
  );
}

function test_normalize_empty_returns_default() {
  const r = normalizeReconciliationAlertConfig(undefined);
  assert(
    'normalize(undefined) → enabled=true',
    r.enabled === DEFAULT_RECONCILIATION_ALERT_CONFIG.enabled
  );
  assert(
    'normalize(undefined) → high=70',
    r.alignment_score_high_threshold === 70
  );
  assert('normalize(null) ok', normalizeReconciliationAlertConfig(null).enabled === true);
  assert('normalize({}) ok', normalizeReconciliationAlertConfig({}).enabled === true);
  assert(
    'normalize("garbage") ok (string fallback)',
    normalizeReconciliationAlertConfig('garbage').enabled === true
  );
}

function test_normalize_lenient_invalid_values() {
  const r = normalizeReconciliationAlertConfig({
    enabled: 'not-a-bool', // → true (default)
    alignment_score_high_threshold: 999, // > 100 → 70 default
    alignment_score_medium_threshold: -5, // < 0 → 85 default
    drift_count_high_threshold: 'foo', // → 3 default
    drift_count_medium_threshold: 0.5, // 非整数 → 1 default
    dedupe_window_minutes: 0, // < 1 → 30 default
  });
  assert('invalid enabled → default true', r.enabled === true);
  assert('out-of-range high → default 70', r.alignment_score_high_threshold === 70);
  assert('out-of-range medium → default 85', r.alignment_score_medium_threshold === 85);
  assert('non-number drift_high → default 3', r.drift_count_high_threshold === 3);
  assert(
    'non-integer drift_medium → default 1',
    r.drift_count_medium_threshold === 1
  );
  assert('dedupe<1 → default 30', r.dedupe_window_minutes === 30);
}

function test_normalize_happy_path() {
  const r = normalizeReconciliationAlertConfig({
    enabled: false,
    alignment_score_high_threshold: 60,
    alignment_score_medium_threshold: 80,
    drift_count_high_threshold: 5,
    drift_count_medium_threshold: 2,
    dedupe_window_minutes: 60,
  });
  assert('enabled=false 透传', r.enabled === false);
  assert('alignment_high=60 透传', r.alignment_score_high_threshold === 60);
  assert('alignment_medium=80 透传', r.alignment_score_medium_threshold === 80);
  assert('drift_high=5 透传', r.drift_count_high_threshold === 5);
  assert('drift_medium=2 透传', r.drift_count_medium_threshold === 2);
  assert('dedupe=60 透传', r.dedupe_window_minutes === 60);
}

function test_normalize_swap_inverted_thresholds() {
  // medium < high → 静默 swap (防 MEDIUM 永被 HIGH 决策覆盖)
  const r = normalizeReconciliationAlertConfig({
    alignment_score_high_threshold: 80,
    alignment_score_medium_threshold: 50, // < high (80) → 应被拉到 80
    drift_count_high_threshold: 3,
    drift_count_medium_threshold: 10, // > high (3) → 应被压到 3
  });
  assert(
    'medium 阈值 < high 时被静默拉齐到 high (防永远被 HIGH 决策覆盖)',
    r.alignment_score_medium_threshold === 80
  );
  assert(
    'drift_medium > drift_high 时被静默压回 drift_high',
    r.drift_count_medium_threshold === 3
  );
}

function test_classify_with_custom_thresholds_high_branch() {
  // 默认 alignment<70 → HIGH; 用户调到 80 后 alignment=75 也触发 HIGH
  const cfg = normalizeReconciliationAlertConfig({
    alignment_score_high_threshold: 80,
    alignment_score_medium_threshold: 90,
  });
  const r = classifyReconciliation({
    alignment_score: 75,
    live_only_count: 0,
    paper_only_count: 0,
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'diverged',
    thresholds: cfg,
  });
  assert(
    'custom high=80 → alignment_score=75 触发 HIGH (默认 70 时只会是 MEDIUM)',
    r.severity === 'HIGH'
  );
}

function test_classify_with_custom_thresholds_drift_relaxed() {
  // 默认 drift>3 → HIGH; 用户放宽到 drift>5 后 drift=4 应回到 MEDIUM
  const cfg = normalizeReconciliationAlertConfig({
    drift_count_high_threshold: 5,
    drift_count_medium_threshold: 2,
  });
  const r = classifyReconciliation({
    alignment_score: 95,
    live_only_count: 2,
    paper_only_count: 2, // drift=4, ≥ medium(2) 且 ≤ high(5)
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'diverged',
    thresholds: cfg,
  });
  assert(
    'custom drift_high=5 → drift=4 从 HIGH 降级 MEDIUM (默认是 HIGH)',
    r.severity === 'MEDIUM'
  );
}

function test_classify_backward_compat_no_thresholds() {
  // thresholds 不传 → 走 DEFAULT 与 v1 hardcoded 行为完全一致
  const r = classifyReconciliation({
    alignment_score: 68, // < 70
    live_only_count: 0,
    paper_only_count: 0,
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'diverged',
    // thresholds omitted
  });
  assert(
    'backward compat: thresholds 缺省 → alignment<70 仍 HIGH',
    r.severity === 'HIGH'
  );
}

function test_classify_disabled_section_via_high_threshold_zero() {
  // alignment_score_high_threshold=0 时, 任何 score>=0 都不再触发 HIGH 分支
  const cfg = normalizeReconciliationAlertConfig({
    alignment_score_high_threshold: 0,
    alignment_score_medium_threshold: 0,
    drift_count_high_threshold: 100,
    drift_count_medium_threshold: 100,
  });
  const r = classifyReconciliation({
    alignment_score: 50,
    live_only_count: 5,
    paper_only_count: 5,
    snapshot_age_minutes: 10,
    stale_threshold_minutes: 180,
    status: 'diverged',
    thresholds: cfg,
  });
  assert(
    'AC: 阈值放到极限 → 真实漂移也回归 NONE (用户实际"关闭"对账告警噪声)',
    r.severity === 'NONE'
  );
}

test_default_config_frozen();
test_normalize_empty_returns_default();
test_normalize_lenient_invalid_values();
test_normalize_happy_path();
test_normalize_swap_inverted_thresholds();
test_classify_with_custom_thresholds_high_branch();
test_classify_with_custom_thresholds_drift_relaxed();
test_classify_backward_compat_no_thresholds();
test_classify_disabled_section_via_high_threshold_zero();

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
