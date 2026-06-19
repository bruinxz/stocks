/**
 * FactorController 因子健康列 (US-045 / FE-006) 单元测试
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/factor-health.test.ts
 *
 * 也不依赖 DB/网络: 全部用 pure helpers + fake rows.
 *
 * 覆盖维度:
 *   [1] 常量冻结 (FACTOR_HEALTH_THRESHOLDS Object.freeze + 4 关键阈值数值);
 *   [2] classifyFactorHealth 4 档分类全分支:
 *       - null / NaN → unknown;
 *       - |ic_90d| < WEAK → weak (即使 ir 大);
 *       - |ic_90d| ≥ ALPHA 且 |ic_ir| ≥ IR_ALPHA → alpha (正向 & 反向);
 *       - 中间地带 → unstable;
 *       - 边界: 阈值正好等于触发 / 略低于不触发;
 *   [3] computeFactorICHealth 聚合:
 *       - 空 rows → unknown;
 *       - 全 null ic_mean → ic_90d=null, sample=0, unknown;
 *       - 多条 ic_mean 算术平均;
 *       - 跳过 null / NaN ic_mean;
 *       - ic_ir 取 rows[0] (调用方已排序 DESC);
 *       - 非 finite ic_ir → null;
 *       - 字符串数字 (Sequelize raw 返 DECIMAL as string) 正确 parse;
 *   [4] META-GUARD fs+regex:
 *       - FactorController.ts: pure helpers 全 export + Object.freeze;
 *       - FactorController.ts: getOverview 调 loadFactorHealthMap;
 *       - factorService.ts (frontend): FactorOverviewItem 含 ic_90d / ic_ir /
 *         ic_sample_count / health_class 字段;
 *       - FactorWorkspace.tsx (frontend): 渲染 IC_90d / IC_IR + health Tag.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FACTOR_HEALTH_THRESHOLDS,
  classifyFactorHealth,
  computeFactorICHealth,
  FactorHealthClass,
} from '../../src/api/controllers/FactorController';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function assertClose(name: string, actual: number | null, expected: number, eps = 0.0001): void {
  const ok = actual !== null && Math.abs(actual - expected) < eps;
  assert(name, ok, `actual=${actual} expected~=${expected}`);
}

// ---------------------------------------------------------------------------
// [1] 常量冻结
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assert('FACTOR_HEALTH_THRESHOLDS frozen', Object.isFrozen(FACTOR_HEALTH_THRESHOLDS));
  // 阈值数值固化, 任何调参动作必须改测试 + PR review 走一遍
  assertEqual(
    'IC_HEALTH_LOOK_FORWARD_DAYS = 20',
    FACTOR_HEALTH_THRESHOLDS.IC_HEALTH_LOOK_FORWARD_DAYS,
    20
  );
  assertEqual(
    'IC_HEALTH_LOOKBACK_DAYS = 90',
    FACTOR_HEALTH_THRESHOLDS.IC_HEALTH_LOOKBACK_DAYS,
    90
  );
  assertEqual('IC_ALPHA_THRESHOLD = 0.03', FACTOR_HEALTH_THRESHOLDS.IC_ALPHA_THRESHOLD, 0.03);
  assertEqual(
    'IC_IR_ALPHA_THRESHOLD = 0.3',
    FACTOR_HEALTH_THRESHOLDS.IC_IR_ALPHA_THRESHOLD,
    0.3
  );
  assertEqual('IC_WEAK_THRESHOLD = 0.01', FACTOR_HEALTH_THRESHOLDS.IC_WEAK_THRESHOLD, 0.01);
}

// ---------------------------------------------------------------------------
// [2] classifyFactorHealth 全分支
// ---------------------------------------------------------------------------

function testClassify(): void {
  // 缺数据
  assertEqual('null ic_90d → unknown', classifyFactorHealth(null, 1.0), 'unknown' as FactorHealthClass);
  assertEqual('NaN ic_90d → unknown', classifyFactorHealth(NaN, 1.0), 'unknown');
  assertEqual('Infinity ic_90d → unknown', classifyFactorHealth(Infinity, 1.0), 'unknown');

  // 失效区 — |ic| < 0.01
  assertEqual('|ic|=0.005 → weak (even with high ir)', classifyFactorHealth(0.005, 2.0), 'weak');
  assertEqual('|ic|=-0.005 → weak', classifyFactorHealth(-0.005, 2.0), 'weak');
  assertEqual('|ic|=0.0099 → weak (just below WEAK)', classifyFactorHealth(0.0099, 2.0), 'weak');

  // alpha 区 — |ic| >= 0.03 且 |ir| >= 0.3
  assertEqual('ic=0.05, ir=0.5 → alpha', classifyFactorHealth(0.05, 0.5), 'alpha');
  assertEqual('ic=-0.05, ir=-0.5 → alpha (反向因子)', classifyFactorHealth(-0.05, -0.5), 'alpha');
  assertEqual('ic=0.03, ir=0.3 → alpha (边界等号)', classifyFactorHealth(0.03, 0.3), 'alpha');

  // unstable — 有方向但 IR 不够 / null ir
  assertEqual('ic=0.05, ir=0.2 → unstable (ir 不够)', classifyFactorHealth(0.05, 0.2), 'unstable');
  assertEqual('ic=0.05, ir=null → unstable', classifyFactorHealth(0.05, null), 'unstable');
  assertEqual('ic=0.02, ir=1.0 → unstable (ic 中间区)', classifyFactorHealth(0.02, 1.0), 'unstable');
  // 边界: ic 略低于 ALPHA 但高于 WEAK
  assertEqual('ic=0.0299, ir=1.0 → unstable', classifyFactorHealth(0.0299, 1.0), 'unstable');
  // 边界: ir 略低于 0.3
  assertEqual('ic=0.05, ir=0.2999 → unstable', classifyFactorHealth(0.05, 0.2999), 'unstable');
}

// ---------------------------------------------------------------------------
// [3] computeFactorICHealth 聚合
// ---------------------------------------------------------------------------

function testComputeEmpty(): void {
  const r = computeFactorICHealth([]);
  assertEqual('空 rows ic_90d=null', r.ic_90d, null);
  assertEqual('空 rows ic_ir=null', r.ic_ir, null);
  assertEqual('空 rows sample=0', r.ic_sample_count, 0);
  assertEqual('空 rows class=unknown', r.health_class, 'unknown' as FactorHealthClass);
}

function testComputeAllNull(): void {
  const r = computeFactorICHealth([
    { ic_mean: null, ic_ir: null, period_end: '2026-06-19', computed_at: '2026-06-19T00:00:00Z' },
    { ic_mean: null, ic_ir: null, period_end: '2026-06-18', computed_at: '2026-06-18T00:00:00Z' },
  ]);
  assertEqual('全 null ic_mean → ic_90d=null', r.ic_90d, null);
  assertEqual('全 null sample=0', r.ic_sample_count, 0);
  assertEqual('全 null class=unknown', r.health_class, 'unknown' as FactorHealthClass);
}

function testComputeAvg(): void {
  // 3 条 ic_mean: 0.04, 0.05, 0.06 → mean = 0.05 → alpha 区 (ir=0.6)
  const r = computeFactorICHealth([
    { ic_mean: 0.06, ic_ir: 0.6, period_end: '2026-06-19', computed_at: '2026-06-19T00:00:00Z' },
    { ic_mean: 0.05, ic_ir: 0.55, period_end: '2026-06-12', computed_at: '2026-06-12T00:00:00Z' },
    { ic_mean: 0.04, ic_ir: 0.5, period_end: '2026-06-05', computed_at: '2026-06-05T00:00:00Z' },
  ]);
  assertClose('3 行均值 = 0.05', r.ic_90d, 0.05);
  // ic_ir 取最新一条 (rows[0])
  assertClose('ic_ir 取 rows[0]', r.ic_ir, 0.6);
  assertEqual('sample=3', r.ic_sample_count, 3);
  assertEqual('class=alpha', r.health_class, 'alpha' as FactorHealthClass);
}

function testComputeSkipNullMean(): void {
  // 5 行, 2 行 null → 应只用 3 行算均值
  const r = computeFactorICHealth([
    { ic_mean: 0.06, ic_ir: 0.6 },
    { ic_mean: null, ic_ir: 0.6 },
    { ic_mean: 0.05, ic_ir: 0.6 },
    { ic_mean: null, ic_ir: 0.6 },
    { ic_mean: 0.04, ic_ir: 0.6 },
  ]);
  assertClose('5 行跳 null → 用 3 行 mean=0.05', r.ic_90d, 0.05);
  assertEqual('sample=3', r.ic_sample_count, 3);
}

function testComputeStringNumbers(): void {
  // Sequelize raw=true 返 DECIMAL as string — 必须容忍
  const r = computeFactorICHealth([
    { ic_mean: '0.06' as unknown as number, ic_ir: '0.6' as unknown as number },
    { ic_mean: '0.04' as unknown as number, ic_ir: '0.5' as unknown as number },
  ]);
  assertClose('字符串 ic_mean 平均 = 0.05', r.ic_90d, 0.05);
  assertClose('字符串 ic_ir parse → 0.6', r.ic_ir, 0.6);
}

function testComputeNonFiniteIr(): void {
  const r = computeFactorICHealth([
    { ic_mean: 0.05, ic_ir: NaN },
    { ic_mean: 0.04, ic_ir: 0.5 },
  ]);
  assertEqual('rows[0].ic_ir=NaN → ic_ir=null', r.ic_ir, null);
  // class: ic_90d=0.045 (>= ALPHA), ir=null → unstable
  assertEqual('NaN ir → unstable', r.health_class, 'unstable' as FactorHealthClass);
}

function testComputeWeakAggregate(): void {
  // 全 ic_mean 很小 → ic_90d 也很小 → weak
  const r = computeFactorICHealth([
    { ic_mean: 0.005, ic_ir: 0.8 },
    { ic_mean: 0.003, ic_ir: 0.8 },
    { ic_mean: -0.001, ic_ir: 0.8 },
  ]);
  assert('ic_90d 小', r.ic_90d !== null && Math.abs(r.ic_90d) < 0.01);
  assertEqual('小 ic_90d → weak', r.health_class, 'weak' as FactorHealthClass);
}

// ---------------------------------------------------------------------------
// [4] META-GUARD fs + regex
// ---------------------------------------------------------------------------

function testMetaGuard(): void {
  const root = join(__dirname, '..', '..', 'src');

  // (4a) FactorController.ts
  const ctrlSrc = readFileSync(
    join(root, 'api', 'controllers', 'FactorController.ts'),
    'utf-8'
  );
  assert(
    'META: FactorController exports FACTOR_HEALTH_THRESHOLDS',
    /export\s+const\s+FACTOR_HEALTH_THRESHOLDS/.test(ctrlSrc)
  );
  assert(
    'META: FactorController exports classifyFactorHealth',
    /export\s+function\s+classifyFactorHealth/.test(ctrlSrc)
  );
  assert(
    'META: FactorController exports computeFactorICHealth',
    /export\s+function\s+computeFactorICHealth/.test(ctrlSrc)
  );
  assert(
    'META: FactorController exports loadFactorHealthMap (async)',
    /export\s+async\s+function\s+loadFactorHealthMap/.test(ctrlSrc)
  );
  assert(
    'META: FACTOR_HEALTH_THRESHOLDS uses Object.freeze',
    /FACTOR_HEALTH_THRESHOLDS\s*=\s*Object\.freeze/.test(ctrlSrc)
  );
  // getOverview 必须真调 loadFactorHealthMap, 否则 UI 永远拿 unknown
  assert(
    'META: getOverview 调 loadFactorHealthMap',
    ctrlSrc.includes('loadFactorHealthMap(factorNames')
  );
  // payload 必须含 health 字段
  assert(
    'META: getOverview payload 含 factorStatsWithHealth',
    ctrlSrc.includes('factorStatsWithHealth')
  );

  // (4b) factor.routes.ts /overview 仍存在
  const routeSrc = readFileSync(
    join(root, 'api', 'routes', 'factor.routes.ts'),
    'utf-8'
  );
  assert("META: factor.routes.ts 含 '/overview'", routeSrc.includes("'/overview'"));

  // (4c) frontend factorService.ts FactorOverviewItem 字段
  const feRoot = join(__dirname, '..', '..', '..', 'frontend', 'src');
  const svcSrc = readFileSync(join(feRoot, 'services', 'factorService.ts'), 'utf-8');
  for (const field of ['ic_90d', 'ic_ir', 'ic_sample_count', 'health_class']) {
    assert(
      `META: factorService.ts FactorOverviewItem 含 ${field}`,
      svcSrc.includes(field)
    );
  }
  assert(
    'META: factorService.ts health_class 是 alpha|weak|unstable|unknown',
    /health_class:\s*'alpha'\s*\|\s*'weak'\s*\|\s*'unstable'\s*\|\s*'unknown'/.test(svcSrc)
  );

  // (4d) frontend FactorWorkspace.tsx 真渲染 IC_90d / IC_IR + health Tag
  const wsSrc = readFileSync(
    join(feRoot, 'pages', 'workspace', 'FactorWorkspace.tsx'),
    'utf-8'
  );
  assert('META: FactorWorkspace 渲染 IC_90d', wsSrc.includes('IC_90d'));
  assert('META: FactorWorkspace 渲染 IC_IR', wsSrc.includes('IC_IR'));
  assert(
    'META: FactorWorkspace 渲染 FACTOR_HEALTH_DISPLAY',
    wsSrc.includes('FACTOR_HEALTH_DISPLAY')
  );
  assert(
    'META: FactorWorkspace card 有 factor-health-tag 测试钩子',
    wsSrc.includes('factor-health-tag-')
  );
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

function main(): void {
  testConstantsFrozen();
  testClassify();
  testComputeEmpty();
  testComputeAllNull();
  testComputeAvg();
  testComputeSkipNullMean();
  testComputeStringNumbers();
  testComputeNonFiniteIr();
  testComputeWeakAggregate();
  testMetaGuard();

  console.log(`\n${passed} ok / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
