/**
 * v2 #3 + #4 + #5 联合测试: Almgren-Chriss + Carver + CPCV
 */
import {
  calibrateAlmgrenChrissDefaults,
  expectedImpactCost,
  impactCostToScore,
  optimalLiquidationTrajectory,
} from '../../src/services/execution/almgren-chriss';
import {
  computeForecastScalar,
  applyForecastScalar,
  combineScaledForecasts,
  applyBufferZone,
  applyMultiplierBuffer,
  continuousMultiplier,
  FORECAST_TARGET_ABS_MEAN,
  FORECAST_CAP,
  DEFAULT_BUFFER_WIDTH,
} from '../../src/services/governor/carver-extensions';
import {
  combinatorialPurgedCV,
  generateCombinations,
  computePboFromPaths,
} from '../../src/services/research/cpcv';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); }
}
function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

// ============================================================
// Almgren-Chriss tests
// ============================================================

function testCalibrate() {
  console.log('\n## calibrateAlmgrenChrissDefaults');
  const p = calibrateAlmgrenChrissDefaults({
    adv: 1_000_000,
    daily_vol: 0.02,
    spread_pct: 0.001,
  });
  // Eq.34: η = 0.142 × 0.02 × 0.001 / 1e6 = 2.84e-12
  expectClose('η = 0.142 × σ × s / V', p.eta, (0.142 * 0.02 * 0.001) / 1_000_000, 1e-15);
  // Eq.37: γ = 0.314 × 0.02 / 1e6 = 6.28e-9
  expectClose('γ = 0.314 × σ / V', p.gamma, (0.314 * 0.02) / 1_000_000, 1e-12);
  // ε = spread / 2
  expectClose('ε = spread/2', p.epsilon_pct, 0.0005);

  // Override 也工作
  const p2 = calibrateAlmgrenChrissDefaults({ adv: 1e6, daily_vol: 0.02, spread_pct: 0.001, eta: 0.5 });
  expectClose('η override', p2.eta, 0.5);
}

function testExpectedImpactCost() {
  console.log('\n## expectedImpactCost');
  // 小订单 (1000 股, ADV = 1M) → 极小 impact
  const r1 = expectedImpactCost(1000, { adv: 1_000_000, daily_vol: 0.02, spread_pct: 0.001 });
  expectClose('participation_rate = 1000/1M = 0.001', r1.participation_rate, 0.001);
  assert('小订单 total_bps < 10', r1.total_bps < 10, `bps=${r1.total_bps}`);

  // 大订单 (100K 股, 10% of ADV) → impact 显著
  const r2 = expectedImpactCost(100_000, { adv: 1_000_000, daily_vol: 0.02, spread_pct: 0.001 });
  expectClose('participation_rate = 0.1', r2.participation_rate, 0.1);
  assert('大订单 bps > 小订单', r2.total_bps > r1.total_bps);

  // 极大订单 (1M, 100% ADV) → 严重 impact
  const r3 = expectedImpactCost(1_000_000, { adv: 1_000_000, daily_vol: 0.02, spread_pct: 0.001 });
  assert('极大订单 bps > 大订单', r3.total_bps > r2.total_bps);
  assert('temporary + permanent ≈ total', Math.abs(r3.total_bps - r3.temporary_bps - r3.permanent_bps) < 1e-6);

  // ADV = 0 → infinite participation
  const r4 = expectedImpactCost(100, { adv: 0, daily_vol: 0.02, spread_pct: 0.001 });
  assert('ADV=0 → participation=Inf', r4.participation_rate === Infinity);
}

function testImpactCostToScore() {
  console.log('\n## impactCostToScore');
  expectClose('0 bps → 100', impactCostToScore(0), 100);
  expectClose('3 bps → 100', impactCostToScore(3), 100);
  expectClose('20 bps → 80', impactCostToScore(20), 80);
  expectClose('50 bps → 50', impactCostToScore(50), 50);
  expectClose('100 bps → 20', impactCostToScore(100), 20);
  expectClose('200 bps → 0', impactCostToScore(200), 0);
}

function testOptimalLiquidationTrajectory() {
  console.log('\n## optimalLiquidationTrajectory');
  // 卖出 100K 股, 10 个时间步, 平均 vol/eta
  const r = optimalLiquidationTrajectory(100_000, 10, {
    risk_aversion: 1e-6,
    daily_vol: 0.02,
    eta: 1e-8,
    gamma: 1e-9,
  });
  assert('11 个 holdings (含起始)', r.holdings.length === 11);
  assert('10 个 trades', r.trades.length === 10);
  expectClose('起始 holding = 100K', r.holdings[0], 100_000);
  expectClose('最终 holding ≈ 0', r.holdings[10], 0, 1);
  // Σ trades ≈ 100K
  const totalTraded = r.trades.reduce((s, v) => s + v, 0);
  expectClose('Σ trades ≈ 100K', totalTraded, 100_000, 1);
  // 高 risk_aversion → 早卖；低 risk_aversion → 平均分布
  const rHighRA = optimalLiquidationTrajectory(100_000, 10, {
    risk_aversion: 1e-3,
    daily_vol: 0.02,
    eta: 1e-8,
    gamma: 1e-9,
  });
  // 高 RA 前面 trade 更大
  assert('高 RA: 第一笔 trade > 平均', rHighRA.trades[0] > 10_000, `trade0=${rHighRA.trades[0]}`);
}

// ============================================================
// Carver Forecast Scaling tests
// ============================================================

function testForecastScalar() {
  console.log('\n## computeForecastScalar');
  // raw avg(|x|) = 2 → scalar = 10/2 = 5
  expectClose('avg|x|=2 → scalar=5', computeForecastScalar([-2, 2, -2, 2]), 5);
  // raw avg(|x|) = 100 → scalar = 0.1
  expectClose('avg|x|=100 → scalar=0.1', computeForecastScalar([-100, 100, -100, 100]), 0.1);
  // 全 0 → scalar = 1 (退化)
  expectClose('全 0 → scalar=1', computeForecastScalar([0, 0, 0]), 1);
  // 空 → 1
  expectClose('空 → 1', computeForecastScalar([]), 1);
}

function testApplyForecastScalar() {
  console.log('\n## applyForecastScalar');
  expectClose('5 × 2 = 10', applyForecastScalar(5, 2), 10);
  expectClose('cap +20', applyForecastScalar(100, 1), 20);
  expectClose('cap -20', applyForecastScalar(-100, 1), -20);
}

function testCombineScaledForecasts() {
  console.log('\n## combineScaledForecasts');
  // 3 策略各给 10, equal weight, FDM=1.2 → (10+10+10)/3 * 1.2 = 12
  expectClose('3×10 equal w FDM=1.2 → 12', combineScaledForecasts([10, 10, 10], undefined, 1.2), 12);
  // 反向信号: 10 + (-10) = 0
  expectClose('对冲信号 → 0', combineScaledForecasts([10, -10], undefined, 1.2), 0);
  // cap 触发
  expectClose('FDM 推高超 20 → cap 20', combineScaledForecasts([20, 20], [0.5, 0.5], 3), 20);
}

// ============================================================
// Carver Buffer Zone tests
// ============================================================

function testApplyBufferZone() {
  console.log('\n## applyBufferZone');
  // current=100, target=110, buffer=10% → buffer width = 11
  //   diff = 10 ≤ buffer 11 → 不变, return 100
  expectClose('|diff| ≤ buffer → 不变', applyBufferZone(100, 110, 0.10), 100);

  // current=100, target=120, buffer=10% (12) → diff=20 > 12 → 买到 target-buffer = 108
  expectClose('|diff| > buffer 买 → target-buffer', applyBufferZone(100, 120, 0.10), 108);

  // current=120, target=100, buffer=10 → 卖到 target+buffer = 110
  expectClose('|diff| > buffer 卖 → target+buffer', applyBufferZone(120, 100, 0.10), 110);

  // target = 0 → buffer = 0 → 直接到 target
  expectClose('target=0 buffer=0 → 直接 0', applyBufferZone(100, 0, 0.10), 0);
}

function testApplyMultiplierBuffer() {
  console.log('\n## applyMultiplierBuffer');
  // prev=0.7, raw=0.75, buffer=10% → buffer = 0.075, diff = 0.05 ≤ 0.075 → 不变
  expectClose('小变化 → 保持', applyMultiplierBuffer(0.7, 0.75, 0.10), 0.7);
  // prev=0.7, raw=0.9, buffer=10% (= 0.09), diff=0.2 > 0.09 → 升到 0.9 - 0.09 = 0.81
  expectClose('大变化 → 升 buffer 边', applyMultiplierBuffer(0.7, 0.9, 0.10), 0.81);
}

function testContinuousMultiplier() {
  console.log('\n## continuousMultiplier');
  // dd=0, sharpe=1 → mult=1 (sharpe_factor=1, mult_dd=1)
  expectClose('健康 → 1', continuousMultiplier(0, 1), 1);
  // dd=20%, sharpe=1 → mult_dd = 1 - 2.5*0.2 = 0.5, sharpe_factor=1 → 0.5
  expectClose('dd=20% sharpe=1 → 0.5', continuousMultiplier(0.20, 1), 0.5);
  // dd=40% → mult_dd = 0
  expectClose('dd=40% → 0', continuousMultiplier(0.40, 1), 0);
  // dd=0, sharpe=-1 → sharpe_factor = 0 → mult = 0
  expectClose('sharpe=-1 → 0', continuousMultiplier(0, -1), 0);
  // 单调性: dd 大 → mult 小
  assert('单调性 dd', continuousMultiplier(0.05, 1) > continuousMultiplier(0.15, 1));
  // sharpe = null → sharpe_factor = 1
  expectClose('sharpe=null', continuousMultiplier(0, null), 1);
}

// ============================================================
// CPCV tests
// ============================================================

function testGenerateCombinations() {
  console.log('\n## generateCombinations');
  // C(4, 2) = 6
  const c = generateCombinations(4, 2);
  assert('C(4,2) = 6', c.length === 6);
  // 验证: [0,1], [0,2], [0,3], [1,2], [1,3], [2,3]
  assert('包含 [0,1]', c.some(co => co.length === 2 && co[0] === 0 && co[1] === 1));
  assert('包含 [2,3]', c.some(co => co.length === 2 && co[0] === 2 && co[1] === 3));
  // C(10, 2) = 45
  expectClose('C(10,2) = 45', generateCombinations(10, 2).length, 45);
  // C(10, 1) = 10
  expectClose('C(10,1) = 10', generateCombinations(10, 1).length, 10);
}

function testCombinatorialPurgedCV() {
  console.log('\n## combinatorialPurgedCV');
  // 100 samples, N=5 groups, k=2 test groups → C(5,2) = 10 folds
  const events = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    entry_time: i,
    exit_time: i + 0.5,
  }));
  const folds = combinatorialPurgedCV(events, { n_groups: 5, k_test: 2, embargo_pct: 0 });
  expectClose('10 folds', folds.length, 10);
  // 每 fold test_groups 有 2 个
  assert('每 fold 有 2 test_groups', folds.every(f => f.test_groups.length === 2));
  // train + test 不重叠
  for (const f of folds) {
    const tset = new Set(f.test_ids);
    assert(`fold ${f.fold_index} no overlap`, !f.train_ids.some(id => tset.has(id)));
  }
  // 每段被 test 的次数 = C(N-1, k-1) = C(4,1) = 4
  const groupTestCount = new Array(5).fill(0);
  for (const f of folds) for (const g of f.test_groups) groupTestCount[g] += 1;
  assert('每段被 test 4 次', groupTestCount.every(c => c === 4), `counts=[${groupTestCount}]`);
}

function testComputePboFromPaths() {
  console.log('\n## computePboFromPaths');
  // 完美策略: IS champion 总是 OOS top → PBO = 0
  const goodPaths = [
    { train_metrics: [1, 2, 3], test_metrics: [1, 2, 3] }, // 都是 idx 2 first
    { train_metrics: [1, 3, 2], test_metrics: [2, 3, 1] }, // idx 1 first 一致
  ];
  expectClose('完美 → PBO=0', computePboFromPaths(goodPaths), 0);

  // 反向策略: IS champion 总是 OOS bottom → PBO = 1
  const badPaths = [
    { train_metrics: [1, 2, 3], test_metrics: [3, 2, 1] }, // IS=idx2 OOS rank=3 > median
    { train_metrics: [2, 3, 1], test_metrics: [1, 1, 3] }, // IS=idx1 (val 3), OOS sorted=[2,0,1], rank=3
  ];
  const pbo_bad = computePboFromPaths(badPaths);
  assert('反向 → PBO > 0.5', pbo_bad > 0.5, `PBO=${pbo_bad}`);

  // 空 → NaN
  assert('空 → NaN', Number.isNaN(computePboFromPaths([])));
}

function main() {
  testCalibrate();
  testExpectedImpactCost();
  testImpactCostToScore();
  testOptimalLiquidationTrajectory();
  testForecastScalar();
  testApplyForecastScalar();
  testCombineScaledForecasts();
  testApplyBufferZone();
  testApplyMultiplierBuffer();
  testContinuousMultiplier();
  testGenerateCombinations();
  testCombinatorialPurgedCV();
  testComputePboFromPaths();

  console.log(`\n========================================`);
  console.log(`v2 #3+#4+#5 tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
