/**
 * SizingLimitConsistency 单元测试 (US-008 / PR-003)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/risk/sizing-limit-consistency.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 frozen / 数值正确
 *   [2] sizingMaxPctToFraction 单位换算 + NaN 兜底
 *   [3] compareSingleStockThresholds 三 severity 分支 (info / warn / critical) + 边界
 *       (in_sync 严格 / sizing<limit / sizing=limit+0.01pp / sizing=limit+5pp)
 *   [4] compareRawInputs 直接喂 raw 也能跑 (normalize 在内部)
 *   [5] assertConsistencyOnUpdate fake loader: in_sync / drift critical / loader throw
 *       fail-open returns null + logger.warn 被吞
 *   [6] runDriftAudit 多 user 部分失败的隔离 (1 ok + 1 throw + 1 ok = 3 results)
 *   [7] META-TEST: SizingPolicyService.updateConfig + PositionLimitGuard.updateConfig
 *       源文件都必须 call assertConsistencyOnUpdate
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DEFAULT_SIZING_POLICY,
  normalizeSizingPolicyConfig,
  SizingPolicyConfig,
} from '../../src/portfolio/PositionSizingPolicy';
import {
  DEFAULT_POSITION_LIMITS,
  normalizePositionLimitsConfig,
  PositionLimitsConfig,
} from '../../src/portfolio/risk/PositionLimitGuard';
import {
  SYNC_TOLERANCE_FRACTION,
  WARN_DRIFT_THRESHOLD_FRACTION,
  assertConsistencyOnUpdate,
  compareRawInputs,
  compareSingleStockThresholds,
  runDriftAudit,
  sizingMaxPctToFraction,
} from '../../src/portfolio/risk/SizingLimitConsistency';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-6) {
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}, |diff|=${Math.abs(actual - expected)}`
  );
}

function expectEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ============================================================
// [1] 常量校验
// ============================================================

function testConstants() {
  console.log('\n## constants');
  expectClose('SYNC_TOLERANCE_FRACTION = 1e-6', SYNC_TOLERANCE_FRACTION, 1e-6);
  expectClose('WARN_DRIFT_THRESHOLD_FRACTION = 0.02', WARN_DRIFT_THRESHOLD_FRACTION, 0.02);
}

// ============================================================
// [2] sizingMaxPctToFraction
// ============================================================

function testSizingMaxPctToFraction() {
  console.log('\n## sizingMaxPctToFraction');
  expectClose('12 → 0.12', sizingMaxPctToFraction(12), 0.12);
  expectClose('25 → 0.25', sizingMaxPctToFraction(25), 0.25);
  expectClose('0.5 → 0.005', sizingMaxPctToFraction(0.5), 0.005);
  expectClose('50 → 0.50', sizingMaxPctToFraction(50), 0.5);
  // NaN 兜底用 DEFAULT_SIZING_POLICY.max_position_pct = 12 → 0.12
  expectClose('NaN → default 12% = 0.12', sizingMaxPctToFraction(NaN), 0.12);
  expectClose('Infinity → default 0.12', sizingMaxPctToFraction(Infinity), 0.12);
}

// ============================================================
// [3] compareSingleStockThresholds — 三 severity + 边界
// ============================================================

function makeSizing(pct: number): SizingPolicyConfig {
  return { ...DEFAULT_SIZING_POLICY, max_position_pct: pct };
}

function makeLimit(fraction: number): PositionLimitsConfig {
  return { ...DEFAULT_POSITION_LIMITS, max_single_stock_pct: fraction };
}

function testCompareSingleStockThresholds() {
  console.log('\n## compareSingleStockThresholds');

  // -- in_sync: sizing == limit exactly --
  const inSync = compareSingleStockThresholds(makeSizing(10), makeLimit(0.1));
  assert('sizing=10% & limit=0.1 → in_sync', inSync.in_sync);
  expectEqual('in_sync severity = info', inSync.severity, 'info');
  expectClose('in_sync sizing_fraction = 0.10', inSync.sizing_pct_fraction, 0.1);
  expectClose('in_sync limit_fraction = 0.10', inSync.limit_pct_fraction, 0.1);
  expectClose('in_sync diff ≈ 0', inSync.diff_fraction, 0);
  assert(
    'in_sync message 含 一致',
    inSync.message.includes('一致'),
    `msg="${inSync.message}"`
  );

  // -- sizing < limit (user 留 buffer) → info, NOT warn --
  const sizingSmaller = compareSingleStockThresholds(makeSizing(8), makeLimit(0.1));
  assert('sizing=8% < limit=10% → !in_sync', !sizingSmaller.in_sync);
  expectEqual('sizing < limit severity = info', sizingSmaller.severity, 'info');
  expectClose('sizing < limit diff = -0.02', sizingSmaller.diff_fraction, -0.02);
  assert(
    'sizing<limit message 含 无冲突',
    sizingSmaller.message.includes('无冲突'),
    `msg="${sizingSmaller.message}"`
  );

  // -- sizing > limit by 1pp (内 warn 阈值) → warn --
  const warn = compareSingleStockThresholds(makeSizing(11), makeLimit(0.1));
  assert('sizing=11% > limit=10% → !in_sync', !warn.in_sync);
  expectEqual('drift 1pp → severity = warn', warn.severity, 'warn');
  expectClose('drift 1pp diff = 0.01', warn.diff_fraction, 0.01);
  assert(
    'warn message 含 轻微漂移',
    warn.message.includes('轻微漂移'),
    `msg="${warn.message}"`
  );

  // -- 边界: 恰好差 2pp → warn (≤ 阈值，包含边界) --
  const warnBoundary = compareSingleStockThresholds(makeSizing(12), makeLimit(0.1));
  expectEqual('drift 2pp (boundary) → warn', warnBoundary.severity, 'warn');
  expectClose('drift 2pp diff = 0.02', warnBoundary.diff_fraction, 0.02);

  // -- 边界 + 1ε: 差 2.001pp → critical --
  const critTiny = compareSingleStockThresholds(
    makeSizing(12.001),
    makeLimit(0.1)
  );
  expectEqual('drift 2.001pp → critical', critTiny.severity, 'critical');

  // -- 大漂移: sizing 25% > limit 10% → critical --
  const crit = compareSingleStockThresholds(makeSizing(25), makeLimit(0.1));
  expectEqual('drift 15pp → critical', crit.severity, 'critical');
  expectClose('drift 15pp diff = 0.15', crit.diff_fraction, 0.15);
  assert(
    'critical message 含 严重漂移',
    crit.message.includes('严重漂移'),
    `msg="${crit.message}"`
  );

  // -- 极小 sub-tolerance 差异 → in_sync --
  const subTol = compareSingleStockThresholds(
    makeSizing(10 + SYNC_TOLERANCE_FRACTION * 50), // tiny diff well below tolerance
    makeLimit(0.1)
  );
  assert(
    'sub-tolerance diff → in_sync (within 1e-6)',
    subTol.in_sync,
    `diff=${subTol.diff_fraction}`
  );

  // -- limit NaN 防御兜底用 DEFAULT 0.10 --
  const limitNaN = compareSingleStockThresholds(
    makeSizing(10),
    { ...DEFAULT_POSITION_LIMITS, max_single_stock_pct: NaN } as PositionLimitsConfig
  );
  expectClose(
    'limit NaN → fallback 0.10',
    limitNaN.limit_pct_fraction,
    DEFAULT_POSITION_LIMITS.max_single_stock_pct
  );
}

// ============================================================
// [4] compareRawInputs — 直接喂 raw
// ============================================================

function testCompareRawInputs() {
  console.log('\n## compareRawInputs');
  // raw input 经 normalize: max_position_pct=25 (合法) + max_single_stock_pct=0.1 (默认)
  const rep = compareRawInputs(
    { method: 'kelly', max_position_pct: 25 },
    { max_single_stock_pct: 0.1 }
  );
  expectEqual('raw critical drift', rep.severity, 'critical');
  expectClose('raw sizing=0.25', rep.sizing_pct_fraction, 0.25);
  expectClose('raw limit=0.10', rep.limit_pct_fraction, 0.1);
  // 全 undefined → 默认 12% vs 10% → warn (差 2pp)
  const defaults = compareRawInputs(undefined, undefined);
  expectEqual('all-default → warn (DEFAULT 12 vs 10)', defaults.severity, 'warn');
  expectClose('all-default sizing=0.12', defaults.sizing_pct_fraction, 0.12);
  expectClose('all-default limit=0.10', defaults.limit_pct_fraction, 0.1);
}

// ============================================================
// [5] assertConsistencyOnUpdate — fake loader
// ============================================================

async function testAssertConsistencyOnUpdate() {
  console.log('\n## assertConsistencyOnUpdate (async)');

  // (a) in_sync: 不发 warn
  const aReport = await assertConsistencyOnUpdate({
    user_id: 42,
    sizingLoader: async () => makeSizing(10),
    limitLoader: async () => makeLimit(0.1),
    triggered_by: 'test_in_sync',
  });
  assert('in_sync report 非 null', aReport !== null);
  expectEqual('in_sync severity=info', aReport?.severity, 'info');

  // (b) critical drift: 仍返 report
  const bReport = await assertConsistencyOnUpdate({
    user_id: 42,
    sizingLoader: async () => makeSizing(30),
    limitLoader: async () => makeLimit(0.1),
    triggered_by: 'test_critical',
  });
  expectEqual('critical drift severity', bReport?.severity, 'critical');
  expectClose('critical drift diff', bReport?.diff_fraction ?? 0, 0.2);

  // (c) sizing loader throws → fail-open 返 null
  const cReport = await assertConsistencyOnUpdate({
    user_id: 42,
    sizingLoader: async () => {
      throw new Error('sizing DB outage');
    },
    limitLoader: async () => makeLimit(0.1),
    triggered_by: 'test_sizing_throw',
  });
  assert('sizing loader throw → null (fail-open)', cReport === null);

  // (d) limit loader throws → fail-open 返 null
  const dReport = await assertConsistencyOnUpdate({
    user_id: 42,
    sizingLoader: async () => makeSizing(10),
    limitLoader: async () => {
      throw new Error('limit DB outage');
    },
    triggered_by: 'test_limit_throw',
  });
  assert('limit loader throw → null (fail-open)', dReport === null);

  // (e) triggered_by 缺省: 不应 throw
  const eReport = await assertConsistencyOnUpdate({
    user_id: 7,
    sizingLoader: async () => makeSizing(11),
    limitLoader: async () => makeLimit(0.1),
  });
  expectEqual('no triggered_by → still ok (warn)', eReport?.severity, 'warn');
}

// ============================================================
// [6] runDriftAudit — 多 user + per-user 隔离
// ============================================================

async function testRunDriftAudit() {
  console.log('\n## runDriftAudit (async)');

  // sizingLoader: user 1 in_sync, user 2 critical, user 3 throw
  const sizingLoader = async (uid: number) => {
    if (uid === 1) return makeSizing(10);
    if (uid === 2) return makeSizing(30);
    if (uid === 3) throw new Error(`user ${uid} not found`);
    return makeSizing(12);
  };
  const limitLoader = async (_uid: number) => makeLimit(0.1);

  const results = await runDriftAudit({
    user_ids: [1, 2, 3, 4],
    sizingLoader,
    limitLoader,
  });

  expectEqual('returned 4 results', results.length, 4);
  expectEqual('user 1 in_sync', results[0].report?.severity, 'info');
  assert('user 1 no error', !results[0].error);
  expectEqual('user 2 critical', results[1].report?.severity, 'critical');
  assert('user 3 report=null + error set', results[2].report === null && !!results[2].error);
  assert(
    'user 3 error 含 not found',
    (results[2].error || '').includes('not found'),
    `err="${results[2].error}"`
  );
  // user 4: 默认 sizing 12 vs limit 0.1 → 差 2pp → warn
  expectEqual('user 4 warn (default 12% vs 10%)', results[3].report?.severity, 'warn');
}

// ============================================================
// [7] META-TEST: SizingPolicyService + PositionLimitGuard 必须接 hook
// ============================================================

function testMetaGuardConsistencyHookWired() {
  console.log('\n## META-TEST: consistency hook wired into both updateConfig sites');

  const sizingServicePath = resolve(
    __dirname,
    '../../src/portfolio/risk/SizingPolicyService.ts'
  );
  const sizingSrc = readFileSync(sizingServicePath, 'utf-8');

  assert(
    'SizingPolicyService imports assertConsistencyOnUpdate',
    /import\s+\{\s*assertConsistencyOnUpdate\s*\}\s+from\s+['"]\.\/SizingLimitConsistency['"]/.test(
      sizingSrc
    )
  );
  assert(
    'SizingPolicyService imports positionLimitGuard',
    /import\s+\{\s*positionLimitGuard\s*\}\s+from\s+['"]\.\/PositionLimitGuard['"]/.test(
      sizingSrc
    )
  );
  // hook 在 updateConfig 方法体内被调用 (有 await assertConsistencyOnUpdate)
  assert(
    'SizingPolicyService.updateConfig calls assertConsistencyOnUpdate',
    /await\s+assertConsistencyOnUpdate\s*\(/.test(sizingSrc)
  );
  assert(
    'SizingPolicyService hook triggered_by 标识为 sizing_policy_update',
    /triggered_by:\s*['"]sizing_policy_update['"]/.test(sizingSrc)
  );

  const limitGuardPath = resolve(
    __dirname,
    '../../src/portfolio/risk/PositionLimitGuard.ts'
  );
  const limitSrc = readFileSync(limitGuardPath, 'utf-8');

  assert(
    'PositionLimitGuard.updateConfig require SizingLimitConsistency (lazy)',
    /require\(['"]\.\/SizingLimitConsistency['"]\)/.test(limitSrc)
  );
  assert(
    'PositionLimitGuard.updateConfig require SizingPolicyService (lazy)',
    /require\(['"]\.\/SizingPolicyService['"]\)/.test(limitSrc)
  );
  assert(
    'PositionLimitGuard.updateConfig calls assertConsistencyOnUpdate',
    /assertConsistencyOnUpdate\s*\(/.test(limitSrc)
  );
  assert(
    'PositionLimitGuard hook triggered_by 标识为 position_limit_update',
    /triggered_by:\s*['"]position_limit_update['"]/.test(limitSrc)
  );
  // hook 整段被 try/catch 包裹 — fail-open 主流程不阻塞
  assert(
    'PositionLimitGuard hook 被 try/catch 包裹 (fail-open)',
    /try\s*\{[\s\S]*assertConsistencyOnUpdate[\s\S]*\}\s*catch/.test(limitSrc)
  );
}

// ============================================================
// [8] 额外: normalize + compare 联合契约 sanity
// ============================================================

function testNormalizeCompareCombo() {
  console.log('\n## normalize + compare combo sanity');
  const sizing = normalizeSizingPolicyConfig({ max_position_pct: 12 });
  const limit = normalizePositionLimitsConfig({ max_single_stock_pct: 0.12 });
  const rep = compareSingleStockThresholds(sizing, limit);
  // 12% sizing == 0.12 limit → in_sync after units align
  assert('normalized 12% == 0.12 → in_sync', rep.in_sync, `diff=${rep.diff_fraction}`);
  expectEqual('in_sync severity = info', rep.severity, 'info');
}

// ============================================================
// main
// ============================================================

(async () => {
  testConstants();
  testSizingMaxPctToFraction();
  testCompareSingleStockThresholds();
  testCompareRawInputs();
  await testAssertConsistencyOnUpdate();
  await testRunDriftAudit();
  testMetaGuardConsistencyHookWired();
  testNormalizeCompareCombo();

  console.log(`\n========================================`);
  console.log(`SizingLimitConsistency tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
})();
