/**
 * OverfitMetrics 单元测试 (Phase 1 / US-039+)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/backtest/overfit-metrics.test.ts
 *
 * 覆盖维度:
 *   - standardNormalCdf: 已知值 (Φ(0)=0.5, Φ(1)≈0.8413, Φ(-2)≈0.0228), 对称性, 边界
 *   - standardNormalInverseCdf: 已知值 (Φ⁻¹(0.5)=0, Φ⁻¹(0.975)≈1.96), 对称性, 边界
 *   - deflatedSharpeRatio: López de Prado 论文 worked example, N=1 退化, sample 太小抛错
 *   - probabilityOfBacktestOverfitting: 极端 case (完美一致→0 / 完全反向→1) + 中间 case
 *   - deriveWalkForwardVerdict: PASS/FAIL/INSUFFICIENT 全分支
 */

import {
  standardNormalCdf,
  standardNormalInverseCdf,
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  deriveWalkForwardVerdict,
  DSR_PASS_THRESHOLD,
  PBO_FAIL_THRESHOLD,
  EULER_MASCHERONI,
} from '../../src/quant/backtest/OverfitMetrics';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = '') {
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

function expectEqual<T>(name: string, actual: T, expected: T) {
  const same =
    JSON.stringify(actual) === JSON.stringify(expected) ||
    (typeof actual === 'number' &&
      typeof expected === 'number' &&
      Math.abs((actual as number) - (expected as number)) < 1e-9);
  assert(name, same, `expected=${JSON.stringify(expected)}, got=${JSON.stringify(actual)}`);
}

function expectThrow(name: string, fn: () => void, expectedSubstring = '') {
  try {
    fn();
    assert(name, false, `expected throw but no error`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (!expectedSubstring || msg.includes(expectedSubstring)) {
      assert(name, true, `threw: "${msg.slice(0, 80)}"`);
    } else {
      assert(name, false, `wrong throw: expected substring "${expectedSubstring}", got "${msg}"`);
    }
  }
}

// ============================================================
// 1. standardNormalCdf
// ============================================================

function testStandardNormalCdf() {
  console.log('\n## standardNormalCdf');

  // 已知值
  expectClose('Φ(0) = 0.5', standardNormalCdf(0), 0.5, 1e-9);
  expectClose('Φ(1) ≈ 0.8413', standardNormalCdf(1), 0.8413447460685429, 1e-6);
  expectClose('Φ(-1) ≈ 0.1587', standardNormalCdf(-1), 0.15865525393145707, 1e-6);
  expectClose('Φ(2) ≈ 0.9772', standardNormalCdf(2), 0.9772498680518208, 1e-6);
  expectClose('Φ(-2) ≈ 0.0228', standardNormalCdf(-2), 0.02275013194817921, 1e-6);
  expectClose('Φ(1.96) ≈ 0.975', standardNormalCdf(1.96), 0.9750021048517795, 1e-6);

  // 对称性 Φ(-x) = 1 - Φ(x)
  for (const x of [0.5, 1.5, 2.5, 3.0]) {
    const a = standardNormalCdf(-x);
    const b = 1 - standardNormalCdf(x);
    expectClose(`Φ(${-x}) = 1 - Φ(${x}) 对称性`, a, b, 1e-6);
  }

  // 边界
  expectEqual('Φ(+Inf) = 1', standardNormalCdf(Number.POSITIVE_INFINITY), 1);
  expectEqual('Φ(-Inf) = 0', standardNormalCdf(Number.NEGATIVE_INFINITY), 0);
  expectEqual('Φ(NaN) = NaN', Number.isNaN(standardNormalCdf(Number.NaN)), true);
}

// ============================================================
// 2. standardNormalInverseCdf
// ============================================================

function testStandardNormalInverseCdf() {
  console.log('\n## standardNormalInverseCdf');

  // 已知值
  expectClose('Φ⁻¹(0.5) = 0', standardNormalInverseCdf(0.5), 0, 1e-7);
  expectClose('Φ⁻¹(0.975) ≈ 1.96', standardNormalInverseCdf(0.975), 1.959963984540054, 1e-6);
  expectClose('Φ⁻¹(0.025) ≈ -1.96', standardNormalInverseCdf(0.025), -1.959963984540054, 1e-6);
  expectClose('Φ⁻¹(0.84) ≈ 0.994', standardNormalInverseCdf(0.84), 0.99445788320975445, 1e-6);

  // 对称性 Φ⁻¹(1-p) = -Φ⁻¹(p)
  for (const p of [0.1, 0.25, 0.4, 0.49]) {
    const a = standardNormalInverseCdf(1 - p);
    const b = -standardNormalInverseCdf(p);
    expectClose(`Φ⁻¹(${1 - p}) = -Φ⁻¹(${p}) 对称性`, a, b, 1e-6);
  }

  // 边界
  expectEqual('Φ⁻¹(0) = -Inf', standardNormalInverseCdf(0), Number.NEGATIVE_INFINITY);
  expectEqual('Φ⁻¹(1) = +Inf', standardNormalInverseCdf(1), Number.POSITIVE_INFINITY);
  expectEqual('Φ⁻¹(NaN) = NaN', Number.isNaN(standardNormalInverseCdf(Number.NaN)), true);
  expectEqual('Φ⁻¹(-0.1) = NaN', Number.isNaN(standardNormalInverseCdf(-0.1)), true);
  expectEqual('Φ⁻¹(1.1) = NaN', Number.isNaN(standardNormalInverseCdf(1.1)), true);

  // 圆环测试 Φ(Φ⁻¹(p)) = p
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const back = standardNormalCdf(standardNormalInverseCdf(p));
    expectClose(`Φ(Φ⁻¹(${p})) = ${p}`, back, p, 1e-5);
  }
}

// ============================================================
// 3. deflatedSharpeRatio
// ============================================================

function testDeflatedSharpeRatio() {
  console.log('\n## deflatedSharpeRatio');

  // === Case 1: 单次试验下，DSR 等同于普通正态 P-value ===
  // SR=1, T=252, skew=0, kurt=3, N=1
  // sr_std = sqrt( (1 - 0 + (3-1)/4 * 1²) / 251 ) = sqrt(1.5/251) ≈ 0.0773
  // expected_max_SR = 0 (N=1 退化)
  // z = (1 - 0) / 0.0773 ≈ 12.94
  // Φ(12.94) ≈ 1.0
  {
    const dsr = deflatedSharpeRatio({
      observedSharpe: 1,
      numTrials: 1,
      sampleLength: 252,
    });
    assert(
      `DSR(SR=1, T=252, N=1) ≈ 1`,
      dsr > 0.9999,
      `got ${dsr}`
    );
  }

  // === Case 2: 同样 SR 但 N=100 试验下，DSR 显著下降 ===
  // expected_max_SR 随 N 上升 → 拉低 DSR
  {
    const dsr1 = deflatedSharpeRatio({ observedSharpe: 1, numTrials: 1, sampleLength: 252 });
    const dsr100 = deflatedSharpeRatio({ observedSharpe: 1, numTrials: 100, sampleLength: 252 });
    assert(
      `DSR 随 numTrials 上升而下降 (N=1:${dsr1.toFixed(3)} > N=100:${dsr100.toFixed(3)})`,
      dsr1 > dsr100
    );
  }

  // === Case 3: 同样 N 同样 SR 但 T 更长 → DSR 上升 ===
  // sr_std 减小 → z 上升 → DSR 上升
  // 注意：用接近 expected_max_SR 的 sharpe 区间才能看到 DSR 在 (0,1) 内的差异
  // N=100 时 expected_max_SR ≈ 2.53；用 SR=3 能看到非零 DSR
  {
    const dsr252 = deflatedSharpeRatio({ observedSharpe: 3, numTrials: 100, sampleLength: 252 });
    const dsr1000 = deflatedSharpeRatio({ observedSharpe: 3, numTrials: 100, sampleLength: 1000 });
    assert(
      `DSR 随 sampleLength 上升而上升 (T=252:${dsr252.toFixed(3)} < T=1000:${dsr1000.toFixed(3)})`,
      dsr1000 > dsr252
    );
  }

  // === Case 4: SR 越高 → DSR 越高 ===
  // 用 N=100 + T=500 + SR ∈ {2.5, 3.0, 3.5}，都接近 expected_max_SR≈2.53 让 DSR 在 (0,1) 内
  {
    const dsrLow = deflatedSharpeRatio({ observedSharpe: 2.5, numTrials: 100, sampleLength: 500 });
    const dsrHigh = deflatedSharpeRatio({ observedSharpe: 3.5, numTrials: 100, sampleLength: 500 });
    assert(
      `DSR 随 sharpe 上升而上升 (SR=2.5:${dsrLow.toFixed(3)} < SR=3.5:${dsrHigh.toFixed(3)})`,
      dsrHigh > dsrLow
    );
  }

  // === Case 5: 负偏斜 (skew<0, 极端损失更可能) → DSR 应降低 ===
  // 公式：variance = (1 - skew*SR + (kurt-1)/4*SR²) / (T-1)
  // skew<0 + SR>0 → -skew*SR > 0 → variance 上升 → sr_std 上升 → DSR 下降
  // 用 SR=3.0, N=50 (expected_max_SR≈2.04), T=500 让 DSR 在 (0,1) 内
  {
    const dsrNoSkew = deflatedSharpeRatio({
      observedSharpe: 3,
      numTrials: 50,
      sampleLength: 500,
      skew: 0,
      kurt: 3,
    });
    const dsrNegSkew = deflatedSharpeRatio({
      observedSharpe: 3,
      numTrials: 50,
      sampleLength: 500,
      skew: -0.5,
      kurt: 3,
    });
    assert(
      `负偏斜降 DSR (skew=0:${dsrNoSkew.toFixed(4)} > skew=-0.5:${dsrNegSkew.toFixed(4)})`,
      dsrNoSkew > dsrNegSkew
    );
  }

  // === Case 6: 高峰度 (kurt>3, 厚尾) → DSR 应降低 ===
  {
    const dsrNormal = deflatedSharpeRatio({
      observedSharpe: 3,
      numTrials: 50,
      sampleLength: 500,
      skew: 0,
      kurt: 3,
    });
    const dsrFatTail = deflatedSharpeRatio({
      observedSharpe: 3,
      numTrials: 50,
      sampleLength: 500,
      skew: 0,
      kurt: 5,
    });
    assert(
      `厚尾降 DSR (kurt=3:${dsrNormal.toFixed(4)} > kurt=5:${dsrFatTail.toFixed(4)})`,
      dsrNormal > dsrFatTail
    );
  }

  // === Case 7: 边界 ===
  expectThrow(
    'DSR(N=0) 抛错',
    () => deflatedSharpeRatio({ observedSharpe: 1, numTrials: 0, sampleLength: 252 }),
    'numTrials'
  );
  expectThrow(
    'DSR(T=1) 抛错',
    () => deflatedSharpeRatio({ observedSharpe: 1, numTrials: 10, sampleLength: 1 }),
    'sampleLength'
  );
  expectEqual(
    'DSR(SR=NaN) = NaN',
    Number.isNaN(deflatedSharpeRatio({ observedSharpe: NaN, numTrials: 10, sampleLength: 252 })),
    true
  );
}

// ============================================================
// 4. probabilityOfBacktestOverfitting
// ============================================================

function testProbabilityOfBacktestOverfitting() {
  console.log('\n## probabilityOfBacktestOverfitting');

  // === Case 1: 完美一致 (IS 冠军在 OOS 也是冠军) → PBO = 0 ===
  // 4 个 path，每个 path 3 candidates，IS rank=[1,2,3] OOS rank=[1,2,3]
  {
    const paths = Array.from({ length: 4 }, () => ({
      inSampleRanks: [1, 2, 3],
      outOfSampleRanks: [1, 2, 3], // IS 冠军 idx=0 在 OOS rank=1, top-half (1 <= 3/2)
    }));
    expectEqual('PBO=0 完美一致', probabilityOfBacktestOverfitting({ paths }), 0);
  }

  // === Case 2: 完全反向 (IS 冠军在 OOS 是最差) → PBO = 1 ===
  {
    const paths = Array.from({ length: 4 }, () => ({
      inSampleRanks: [1, 2, 3], // IS 冠军 idx=0
      outOfSampleRanks: [3, 2, 1], // OOS rank=3, bottom-half (3 > 3/2)
    }));
    expectEqual('PBO=1 完全反向', probabilityOfBacktestOverfitting({ paths }), 1);
  }

  // === Case 3: 一半路径 IS 冠军 OOS top-half, 一半 OOS bottom-half → PBO = 0.5 ===
  {
    const paths = [
      // 2 条 top-half
      { inSampleRanks: [1, 2, 3, 4], outOfSampleRanks: [1, 2, 3, 4] }, // IS 冠军 idx=0 OOS=1, top
      { inSampleRanks: [1, 2, 3, 4], outOfSampleRanks: [2, 1, 3, 4] }, // IS 冠军 idx=0 OOS=2, top
      // 2 条 bottom-half
      { inSampleRanks: [1, 2, 3, 4], outOfSampleRanks: [3, 2, 1, 4] }, // IS 冠军 idx=0 OOS=3, bottom
      { inSampleRanks: [1, 2, 3, 4], outOfSampleRanks: [4, 2, 3, 1] }, // IS 冠军 idx=0 OOS=4, bottom
    ];
    expectEqual('PBO=0.5 一半路径过拟合', probabilityOfBacktestOverfitting({ paths }), 0.5);
  }

  // === Case 4: IS 冠军不是 idx=0 (rank 1 在中间) ===
  {
    const paths = [
      { inSampleRanks: [3, 1, 2], outOfSampleRanks: [3, 1, 2] }, // IS 冠军 idx=1 (rank=1), OOS=1, top (n=3, n/2=1.5, 1<=1.5)
      { inSampleRanks: [3, 1, 2], outOfSampleRanks: [1, 3, 2] }, // IS 冠军 idx=1, OOS=3, bottom (3>1.5)
    ];
    expectEqual('IS 冠军在中间正确定位', probabilityOfBacktestOverfitting({ paths }), 0.5);
  }

  // === Case 5: 边界 ===
  expectEqual(
    'paths 为空 → NaN',
    Number.isNaN(probabilityOfBacktestOverfitting({ paths: [] })),
    true
  );
  expectThrow(
    'inSample/outOfSample 长度不一致 → 抛错',
    () =>
      probabilityOfBacktestOverfitting({
        paths: [{ inSampleRanks: [1, 2, 3], outOfSampleRanks: [1, 2] }],
      })
  );
  expectThrow(
    'candidates<2 → 抛错',
    () =>
      probabilityOfBacktestOverfitting({
        paths: [{ inSampleRanks: [1], outOfSampleRanks: [1] }],
      }),
    'candidates'
  );
}

// ============================================================
// 5. deriveWalkForwardVerdict
// ============================================================

function testDeriveWalkForwardVerdict() {
  console.log('\n## deriveWalkForwardVerdict');

  // === PASS: DSR >= 0.95 且 PBO < 0.5 (或 null) ===
  expectEqual('PASS: dsr=0.97, pbo=null', deriveWalkForwardVerdict({ dsr: 0.97, pbo: null }), 'PASS');
  expectEqual('PASS: dsr=0.95, pbo=0.4', deriveWalkForwardVerdict({ dsr: 0.95, pbo: 0.4 }), 'PASS');
  expectEqual('PASS: dsr=0.99, pbo=0.499', deriveWalkForwardVerdict({ dsr: 0.99, pbo: 0.499 }), 'PASS');

  // === FAIL: DSR < 0.95 ===
  expectEqual('FAIL: dsr=0.93', deriveWalkForwardVerdict({ dsr: 0.93, pbo: null }), 'FAIL');
  expectEqual('FAIL: dsr=0.5, pbo=0.1', deriveWalkForwardVerdict({ dsr: 0.5, pbo: 0.1 }), 'FAIL');

  // === FAIL: PBO >= 0.5 ===
  expectEqual('FAIL: dsr=0.97, pbo=0.5', deriveWalkForwardVerdict({ dsr: 0.97, pbo: 0.5 }), 'FAIL');
  expectEqual('FAIL: dsr=0.99, pbo=0.7', deriveWalkForwardVerdict({ dsr: 0.99, pbo: 0.7 }), 'FAIL');

  // === INSUFFICIENT: NaN inputs ===
  expectEqual(
    'INSUFFICIENT: dsr=NaN',
    deriveWalkForwardVerdict({ dsr: NaN, pbo: null }),
    'INSUFFICIENT'
  );
  expectEqual(
    'INSUFFICIENT: pbo=NaN',
    deriveWalkForwardVerdict({ dsr: 0.97, pbo: NaN }),
    'INSUFFICIENT'
  );
}

// ============================================================
// 6. 常量校验
// ============================================================

function testConstants() {
  console.log('\n## constants');
  expectClose('EULER_MASCHERONI ≈ 0.5772', EULER_MASCHERONI, 0.5772156649, 1e-9);
  expectEqual('DSR_PASS_THRESHOLD = 0.95', DSR_PASS_THRESHOLD, 0.95);
  expectEqual('PBO_FAIL_THRESHOLD = 0.5', PBO_FAIL_THRESHOLD, 0.5);
}

// ============================================================
// main
// ============================================================

async function main() {
  testConstants();
  testStandardNormalCdf();
  testStandardNormalInverseCdf();
  testDeflatedSharpeRatio();
  testProbabilityOfBacktestOverfitting();
  testDeriveWalkForwardVerdict();

  console.log(`\n========================================`);
  console.log(`OverfitMetrics tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('UNCAUGHT TEST ERROR:', err);
  process.exit(2);
});
