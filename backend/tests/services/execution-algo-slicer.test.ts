/**
 * US-106 / EX-006 — ExecutionAlgoSlicer 单元测试.
 *
 * Pattern: 项目惯例, 不依赖 jest, 自带 assert + process.exit.
 *   cd backend && npx ts-node --transpile-only tests/services/execution-algo-slicer.test.ts
 *
 * 覆盖:
 *   - roundQtyByLot (lot 整数倍 + 余数末片 / lot=0 退化 / 空 / 负权重)
 *   - buildTwapPlan (等量等间隔 + ADV cap)
 *   - buildVwapPlan (U-型 profile + resample + ADV cap)
 *   - buildIcebergPlan (visible_pct 切块 + 末片余量)
 *   - buildPovPlan (按 participation_rate × ADV / 5min 间隔)
 *   - resampleProfile (任意长度 → n 桶)
 *   - planExecutionSlices (端到端 + 7 种 algo)
 *   - ExecutionAlgoSlicer.plan (service wrapper + fail-open)
 *   - AC: 算法跑通 (sum(qty) ≈ total + 切片数符合预期)
 */

import {
  DEFAULT_ASHARE_VOLUME_PROFILE,
  DEFAULT_LOT_SIZE,
  DEFAULT_TWAP_SLICES,
  DEFAULT_VWAP_SLICES,
  ExecutionAlgoSlicer,
  buildIcebergPlan,
  buildPovPlan,
  buildTwapPlan,
  buildVwapPlan,
  executionAlgoSlicer,
  planExecutionSlices,
  resampleProfile,
  roundQtyByLot,
} from '../../src/services/execution/ExecutionAlgoSlicer';

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
function eq<T>(name: string, a: T, b: T): void {
  assert(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
}
function close(name: string, a: number, b: number, eps = 1e-6): void {
  assert(name, Math.abs(a - b) < eps, `actual=${a} expected=${b} eps=${eps}`);
}

// ===========================================================================
// roundQtyByLot
// ===========================================================================
function testRoundQtyByLot(): void {
  console.log('# roundQtyByLot');
  // 均等 5 片 / total=10000 / lot=100 → 每片 2000
  const r1 = roundQtyByLot([1, 1, 1, 1, 1], 10000, 100);
  eq('5x2000=10000', r1, [2000, 2000, 2000, 2000, 2000]);
  // 不能被整除: total=10300 / 5 = 2060 → floor lot=100 → 2000, 余300 → 优先级补到第一片
  const r2 = roundQtyByLot([1, 1, 1, 1, 1], 10300, 100);
  assert('total 保留', r2.reduce((a, b) => a + b, 0) === 10300);
  assert('每片 ≥ 0', r2.every((q) => q >= 0));
  // 权重不均: VWAP-style profile
  const r3 = roundQtyByLot([2, 1, 1, 2], 8000, 100);
  eq('weighted sum=8000', r3.reduce((a, b) => a + b, 0), 8000);
  // lot=0 → 退化, 末片补差
  const r4 = roundQtyByLot([1, 1, 1], 100, 0);
  eq('lot=0 sum', r4.reduce((a, b) => a + b, 0), 100);
  // 空 weights
  eq('空 weights', roundQtyByLot([], 100, 100), []);
  // total=0 → 全 0
  eq('total=0', roundQtyByLot([1, 1], 0, 100), []);
  // 负权重过滤
  const r5 = roundQtyByLot([1, -1, 1], 200, 100);
  eq('负权重忽略 sum', r5.reduce((a, b) => a + b, 0), 200);
  assert('负权重位置=0', r5[1] === 0);
}

// ===========================================================================
// buildTwapPlan
// ===========================================================================
function testTwap(): void {
  console.log('# buildTwapPlan');
  const slices = buildTwapPlan(10000, 5, 240, 100);
  eq('TWAP 5 切片', slices.length, 5);
  eq('TWAP sum=10000', slices.reduce((a, s) => a + s.qty, 0), 10000);
  close('TWAP interval=48min', slices[1].time_offset_minutes - slices[0].time_offset_minutes, 48);
  assert('每片 visible=qty (非 iceberg)', slices.every((s) => s.visible_qty === s.qty && !s.is_iceberg));
  // ADV cap
  const capped = buildTwapPlan(10000, 5, 240, 100, 0, 1500);
  assert('TWAP ADV cap', capped.every((s) => s.qty <= 1500));
  // 边界
  eq('total=0 → 空', buildTwapPlan(0, 5, 240, 100), []);
  eq('duration=0 → 空', buildTwapPlan(1000, 5, 0, 100), []);
  eq('slice=0 → 空', buildTwapPlan(1000, 0, 240, 100), []);
}

// ===========================================================================
// buildVwapPlan
// ===========================================================================
function testVwap(): void {
  console.log('# buildVwapPlan');
  const slices = buildVwapPlan(10000, 8, 240, 100, DEFAULT_ASHARE_VOLUME_PROFILE);
  eq('VWAP 8 切片', slices.length, 8);
  eq('VWAP sum=10000', slices.reduce((a, s) => a + s.qty, 0), 10000);
  // 开盘片 (index=0, weight=0.20) 应 ≥ 中间桶 (index=3, weight=0.10)
  assert('VWAP 开盘片 ≥ 中段', slices[0].qty >= slices[3].qty);
  // 收盘片 (index=7, weight=0.15) 应 ≥ 中段
  assert('VWAP 收盘片 ≥ 中段', slices[7].qty >= slices[3].qty);
  // resample: profile 4 桶 → 8 切片
  const custom = buildVwapPlan(10000, 8, 240, 100, [1, 2, 2, 1]);
  eq('custom profile 8 切片', custom.length, 8);
  eq('custom profile sum', custom.reduce((a, s) => a + s.qty, 0), 10000);
  // 边界: 空 profile → fallback (resample 用 1 ones)
  const fb = buildVwapPlan(10000, 4, 240, 100, []);
  eq('空 profile sum', fb.reduce((a, s) => a + s.qty, 0), 10000);
}

// ===========================================================================
// buildIcebergPlan
// ===========================================================================
function testIceberg(): void {
  console.log('# buildIcebergPlan');
  // total=10000 visible=0.1 → 1000 / chunk → 10 chunks
  const slices = buildIcebergPlan(10000, 0.1, 240, 100);
  eq('Iceberg 10 chunks', slices.length, 10);
  eq('Iceberg sum=10000', slices.reduce((a, s) => a + s.qty, 0), 10000);
  assert('Iceberg flag', slices.every((s) => s.is_iceberg));
  // visible_pct=0.5 → 2 chunks
  const half = buildIcebergPlan(10000, 0.5, 240, 100);
  eq('Iceberg 0.5 → 2 chunks', half.length, 2);
  // visible_pct=1 → 1 chunk
  const full = buildIcebergPlan(10000, 1, 240, 100);
  eq('Iceberg 1.0 → 1 chunk', full.length, 1);
  // 不能整除: total=10500 / visible=0.1 → 11 chunks, 末片余 500
  const odd = buildIcebergPlan(10500, 0.1, 240, 100);
  eq('Iceberg odd sum', odd.reduce((a, s) => a + s.qty, 0), 10500);
  assert('Iceberg 末片 ≤ visible', odd[odd.length - 1].qty <= odd[0].qty);
  // 边界
  eq('visible=0 → 空', buildIcebergPlan(10000, 0, 240, 100), []);
  eq('visible>1 → 空', buildIcebergPlan(10000, 1.5, 240, 100), []);
  eq('total=0 → 空', buildIcebergPlan(0, 0.1, 240, 100), []);
}

// ===========================================================================
// buildPovPlan
// ===========================================================================
function testPov(): void {
  console.log('# buildPovPlan');
  // ADV=10M, rate=10% → 1M 可参与/天; 240min → ~4167/min × 5min = ~20800/slice
  // total=100000 → 约 5 切片
  const slices = buildPovPlan(100000, 240, 0.1, 10_000_000, 100);
  assert('POV slices > 0', slices.length > 0);
  eq('POV sum=100000', slices.reduce((a, s) => a + s.qty, 0), 100000);
  // 边界
  eq('POV 缺 adv → 空', buildPovPlan(100000, 240, 0.1, 0, 100), []);
  eq('POV rate=0 → 空', buildPovPlan(100000, 240, 0, 1000000, 100), []);
  eq('POV total=0 → 空', buildPovPlan(0, 240, 0.1, 1000000, 100), []);
}

// ===========================================================================
// resampleProfile
// ===========================================================================
function testResample(): void {
  console.log('# resampleProfile');
  // 同长度 → identity
  const r1 = resampleProfile([1, 2, 3], 3);
  eq('identity', r1, [1, 2, 3]);
  // 降采样 4 → 2
  const r2 = resampleProfile([1, 1, 3, 3], 2);
  close('downsample[0]', r2[0], 1);
  close('downsample[1]', r2[1], 3);
  // 升采样 2 → 4
  const r3 = resampleProfile([1, 3], 4);
  eq('upsample len', r3.length, 4);
  // 空 profile → ones
  eq('empty → ones', resampleProfile([], 3), [1, 1, 1]);
  // n=0 → []
  eq('n=0', resampleProfile([1, 2], 0), []);
}

// ===========================================================================
// planExecutionSlices (端到端)
// ===========================================================================
function testPlanEndToEnd(): void {
  console.log('# planExecutionSlices');
  // TWAP 默认
  const twap = planExecutionSlices({ algo: 'TWAP', total_qty: 10000 });
  eq('TWAP 默认 5 切片', twap.slices.length, DEFAULT_TWAP_SLICES);
  eq('TWAP scheduled=10000', twap.scheduled_qty, 10000);
  // VWAP 默认
  const vwap = planExecutionSlices({ algo: 'VWAP', total_qty: 10000 });
  eq('VWAP 默认 8 切片', vwap.slices.length, DEFAULT_VWAP_SLICES);
  // ICEBERG 默认 visible 0.1 → 10 chunks
  const ice = planExecutionSlices({ algo: 'ICEBERG', total_qty: 10000 });
  eq('ICEBERG 默认 10 chunks', ice.slices.length, 10);
  // POV 缺 adv → 空 (fail-open)
  const povNoAdv = planExecutionSlices({ algo: 'POV', total_qty: 100000 });
  eq('POV 缺 adv → 空 slices', povNoAdv.slices.length, 0);
  assert('POV 缺 adv reason 提示', povNoAdv.reason.includes('ADV') || povNoAdv.reason.includes('adv'));
  // POV 带 adv
  const pov = planExecutionSlices({
    algo: 'POV',
    total_qty: 100000,
    adv_qty: 10_000_000,
    participation_rate: 0.1,
  });
  assert('POV with adv slices > 0', pov.slices.length > 0);
  // LIMIT_AT_TOUCH 单片
  const limit = planExecutionSlices({ algo: 'LIMIT_AT_TOUCH', total_qty: 10000 });
  eq('LIMIT 单片', limit.slices.length, 1);
  // SKIP/WAIT 空
  for (const algo of ['SKIP', 'WAIT_5M', 'WAIT_15M', 'WAIT_30M'] as const) {
    const r = planExecutionSlices({ algo, total_qty: 10000 });
    eq(`${algo} → 空 slices`, r.slices.length, 0);
  }
  // 边界: total<=0
  const empty = planExecutionSlices({ algo: 'TWAP', total_qty: 0 });
  eq('total=0 空', empty.slices.length, 0);
  // duration<=0
  const zd = planExecutionSlices({ algo: 'TWAP', total_qty: 10000, duration_minutes: 0 });
  eq('duration=0 空', zd.slices.length, 0);
  // resolved 字段回写
  const res = planExecutionSlices({
    algo: 'TWAP',
    total_qty: 5000,
    slice_count: 4,
    parent_order_id: 'po-123',
  });
  eq('resolved.slice_count', res.resolved.slice_count, 4);
  eq('resolved.parent_order_id', res.resolved.parent_order_id, 'po-123');
  eq('resolved.lot_size 默认 100', res.resolved.lot_size, DEFAULT_LOT_SIZE);

  // ADV 自适应: 单片不超 adv_qty × participation_rate
  const adapt = planExecutionSlices({
    algo: 'TWAP',
    total_qty: 50000,
    slice_count: 5,
    adv_qty: 1_000_000,
    participation_rate: 0.05, // cap = 50000
  });
  // 每片 = 50000/5 = 10000 < cap → 不触发
  assert('TWAP ADV not capping', adapt.slices.every((s) => s.qty <= 50000));
  const adaptTight = planExecutionSlices({
    algo: 'TWAP',
    total_qty: 100000,
    slice_count: 5,
    adv_qty: 100000,
    participation_rate: 0.05, // cap = 5000
  });
  // 每片本应 20000, 被 cap 到 5000
  assert('TWAP ADV cap 生效', adaptTight.slices.every((s) => s.qty <= 5000));
}

// ===========================================================================
// ExecutionAlgoSlicer wrapper
// ===========================================================================
function testService(): void {
  console.log('# ExecutionAlgoSlicer service');
  const slicer = new ExecutionAlgoSlicer();
  const p = slicer.plan({ algo: 'TWAP', total_qty: 10000 });
  eq('wrapper TWAP 5 切片', p.slices.length, DEFAULT_TWAP_SLICES);
  // singleton 暴露
  assert('singleton 实例', executionAlgoSlicer instanceof ExecutionAlgoSlicer);
  // fail-open: 注入坏 input (negative total → 走 normalize → 空 plan, 不抛)
  const bad = slicer.plan({ algo: 'TWAP', total_qty: -100 });
  eq('negative total → 空', bad.slices.length, 0);
}

// ===========================================================================
// AC: 算法跑通
// ===========================================================================
function testAcceptanceCriteria(): void {
  console.log('# AC: 算法跑通');
  // 三种 algo 都能产出非空 plan + sum=total
  for (const algo of ['TWAP', 'VWAP', 'ICEBERG'] as const) {
    const p = planExecutionSlices({ algo, total_qty: 10000 });
    assert(`AC ${algo} slices > 0`, p.slices.length > 0);
    eq(`AC ${algo} sum=total`, p.scheduled_qty, 10000);
    assert(`AC ${algo} 每片 qty > 0`, p.slices.every((s) => s.qty > 0));
    assert(`AC ${algo} time_offset 单调递增`,
      p.slices.every((s, i, arr) => i === 0 || s.time_offset_minutes >= arr[i - 1].time_offset_minutes));
  }
  // VWAP 默认 profile 应 sum 到 1
  const profSum = DEFAULT_ASHARE_VOLUME_PROFILE.reduce((a, b) => a + b, 0);
  close('A 股 default profile sum=1', profSum, 1, 1e-6);
}

testRoundQtyByLot();
testTwap();
testVwap();
testIceberg();
testPov();
testResample();
testPlanEndToEnd();
testService();
testAcceptanceCriteria();

console.log('');
console.log(`✅ passed=${passed}`);
console.log(`❌ failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
