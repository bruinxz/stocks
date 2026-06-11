/**
 * PositionSizingPolicy 单元测试 (Phase 2)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/portfolio/position-sizing-policy.test.ts
 *
 * 覆盖维度:
 *   - normalizeSizingPolicyConfig: 合法化 / 边界 / NaN / 缺失字段
 *   - computeVolTargetSize: 公式正确 / sigma=0 退化 / cap to 1 / conviction 影响
 *   - computeAtrBasedSize: 公式正确 / atr=0 退化 / target>equity cap
 *   - decideSizing equal_pct: 基本 / max_pct cap / cash cap / min_trade 拒绝
 *   - decideSizing vol_target: 高 vol 仓位小、低 vol 仓位大 / conviction 影响
 *   - decideSizing atr_based: 高 ATR 仓位小、低 ATR 仓位大 / risk_pct 控亏损
 */

import {
  normalizeSizingPolicyConfig,
  computeVolTargetSize,
  computeAtrBasedSize,
  decideSizing,
  DEFAULT_SIZING_POLICY,
  SizingPolicyConfig,
} from '../../src/portfolio/PositionSizingPolicy';

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

function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
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
      Math.abs((actual as number) - (expected as number)) < 1e-6);
  assert(name, same, `expected=${JSON.stringify(expected)}, got=${JSON.stringify(actual)}`);
}

// ============================================================
// normalizeSizingPolicyConfig
// ============================================================

function testNormalize() {
  console.log('\n## normalizeSizingPolicyConfig');

  const empty = normalizeSizingPolicyConfig(undefined);
  expectEqual('空 input → method=equal_pct', empty.method, 'equal_pct');
  expectClose('空 input → base_position_pct=5', empty.base_position_pct, 5);
  expectClose('空 input → max_position_pct=12', empty.max_position_pct, 12);

  const valid = normalizeSizingPolicyConfig({
    method: 'vol_target',
    base_position_pct: 3,
    max_position_pct: 8,
    vol_target_pct: 0.2,
  });
  expectEqual('valid method=vol_target', valid.method, 'vol_target');
  expectClose('valid base=3', valid.base_position_pct, 3);
  expectClose('valid vol_target=0.2', valid.vol_target_pct, 0.2);

  const negative = normalizeSizingPolicyConfig({
    method: 'invalid_method',
    base_position_pct: -10,
    max_position_pct: 999,
  });
  expectEqual('invalid method → equal_pct', negative.method, 'equal_pct');
  expectClose('negative base clamped to 0.5', negative.base_position_pct, 0.5);
  expectClose('max>50 clamped to 50', negative.max_position_pct, 50);

  const nanInput = normalizeSizingPolicyConfig({ base_position_pct: NaN });
  expectClose('NaN → fallback 5', nanInput.base_position_pct, 5);
}

// ============================================================
// computeVolTargetSize
// ============================================================

function testComputeVolTarget() {
  console.log('\n## computeVolTargetSize');

  // equity=1M, vol_target=15%, sigma=30% → ratio=0.5 → target=500K
  expectClose(
    'sigma=2*target → 50% equity',
    computeVolTargetSize(1_000_000, 0.15, 0.30, 1.0, 5),
    500_000
  );

  // equity=1M, sigma=15% (=target) → ratio=1 → cap to 1 → target=1M
  expectClose(
    'sigma=target → 100% equity (cap)',
    computeVolTargetSize(1_000_000, 0.15, 0.15, 1.0, 5),
    1_000_000
  );

  // equity=1M, sigma=5% (<target) → ratio>1 → cap to 1 → 1M
  expectClose(
    'sigma<target → cap to 100%',
    computeVolTargetSize(1_000_000, 0.15, 0.05, 1.0, 5),
    1_000_000
  );

  // sigma=0 → 退化到 base_position_pct
  expectClose(
    'sigma=0 → base 5%',
    computeVolTargetSize(1_000_000, 0.15, 0, 1.0, 5),
    50_000
  );

  // sigma=NaN → 退化
  expectClose(
    'sigma=NaN → base 5%',
    computeVolTargetSize(1_000_000, 0.15, NaN, 1.0, 5),
    50_000
  );

  // conviction=2 翻倍
  expectClose(
    'conviction=2x → 2x size',
    computeVolTargetSize(1_000_000, 0.15, 0.30, 2.0, 5),
    1_000_000  // 500K * 2
  );

  // conviction 上限 3
  expectClose(
    'conviction=10 cap to 3',
    computeVolTargetSize(1_000_000, 0.15, 0.30, 10, 5),
    1_500_000  // 500K * 3
  );
}

// ============================================================
// computeAtrBasedSize
// ============================================================

function testComputeAtrBased() {
  console.log('\n## computeAtrBasedSize');

  // equity=1M, risk=1%, atr=1元, price=10元
  // dollar_risk = 1M * 1% = 10K
  // shares = 10K / 1 = 10K shares
  // target = 10K * 10 = 100K
  expectClose(
    'atr=1, price=10 → 100K target',
    computeAtrBasedSize(1_000_000, 1.0, 1.0, 10, 5),
    100_000
  );

  // 同 risk_pct, ATR 翻倍 → 仓位减半
  expectClose(
    'atr=2 (2x) → 50K target (half)',
    computeAtrBasedSize(1_000_000, 1.0, 2.0, 10, 5),
    50_000
  );

  // ATR=0 退化
  expectClose(
    'atr=0 → base 5%',
    computeAtrBasedSize(1_000_000, 1.0, 0, 10, 5),
    50_000
  );

  // price=0 退化
  expectClose(
    'price=0 → base 5%',
    computeAtrBasedSize(1_000_000, 1.0, 1.0, 0, 5),
    50_000
  );

  // 极小 ATR 导致 target>equity → cap to equity
  // atr=0.01, price=100, risk=1%, equity=1M
  // dollar_risk = 10K; shares = 10K/0.01 = 1M shares; target = 1M*100 = 100M
  // cap to equity=1M
  expectClose(
    'tiny ATR → target capped to equity',
    computeAtrBasedSize(1_000_000, 1.0, 0.01, 100, 5),
    1_000_000
  );
}

// ============================================================
// decideSizing - equal_pct
// ============================================================

function testDecideSizingEqualPct() {
  console.log('\n## decideSizing equal_pct');

  const policy: SizingPolicyConfig = { ...DEFAULT_SIZING_POLICY };  // base=5, max=12

  // 基本：equity=1M, no caps
  const d1 = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 10,
    max_position_pct: 12,
  });
  expectClose('basic 5% → 50K', d1.target_amount, 50_000);
  expectEqual('basic method', d1.method, 'equal_pct');
  assert('basic not capped by max', !d1.capped_by_max);
  assert('basic not capped by cash', !d1.capped_by_cash);

  // max_pct cap: base=15 但 max=12
  const policy2 = { ...policy, base_position_pct: 15 };
  const d2 = decideSizing(policy2, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 10,
    max_position_pct: 12,
  });
  expectClose('base 15% capped to 12%', d2.target_amount, 120_000);
  assert('capped_by_max=true', d2.capped_by_max);

  // cash cap: target 50K 但 cash 只有 30K
  const d3 = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 30_000,
    current_price: 10,
    max_position_pct: 12,
  });
  expectClose('50K target capped to cash*0.98=29.4K', d3.target_amount, 29_400);
  assert('capped_by_cash=true', d3.capped_by_cash);

  // min_trade 拒绝
  const d4 = decideSizing(policy, {
    equity: 50_000,
    available_cash: 50_000,
    current_price: 10,
    max_position_pct: 12,
    min_trade_amount: 5000,
  });
  // equity=50K, base 5% = 2.5K < 5K min → 拒绝返回 0
  expectEqual('min_trade 拒绝 → target=0', d4.target_amount, 0);

  // conviction 影响
  const d5 = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 10,
    max_position_pct: 12,
    conviction_multiplier: 2.0,
  });
  expectClose('conviction=2x → 100K', d5.target_amount, 100_000);
}

// ============================================================
// decideSizing - vol_target
// ============================================================

function testDecideSizingVolTarget() {
  console.log('\n## decideSizing vol_target');

  const policy: SizingPolicyConfig = { ...DEFAULT_SIZING_POLICY, method: 'vol_target' };
  // vol_target=0.15

  // 低 vol 标的 → 仓位大
  const dLowVol = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 10,
    vol_annualized: 0.10,  // 比 target 还低
    max_position_pct: 12,
  });
  // ratio = min(1, 0.15/0.10) = 1, target = 1M * 1 = 1M, cap to max_pct 12% = 120K
  expectClose('low vol → capped to 120K (12% max)', dLowVol.target_amount, 120_000);

  // 高 vol 标的 → 仓位小
  const dHighVol = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 10,
    vol_annualized: 0.60,  // 高
    max_position_pct: 12,
  });
  // ratio = 0.15/0.60 = 0.25, target = 250K, cap to 120K (12%)
  expectClose('high vol → still capped to 120K (12% max)', dHighVol.target_amount, 120_000);

  // 非常高 vol → 没被 cap
  const dExtremeVol = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 10,
    vol_annualized: 2.0,  // 200% 年化波动
    max_position_pct: 12,
  });
  // ratio = 0.15/2.0 = 0.075, target = 75K, NOT capped (under 120K)
  expectClose('extreme vol → 75K (not capped)', dExtremeVol.target_amount, 75_000);
  assert('extreme vol not capped by max', !dExtremeVol.capped_by_max);
}

// ============================================================
// decideSizing - atr_based
// ============================================================

function testDecideSizingAtrBased() {
  console.log('\n## decideSizing atr_based');

  const policy: SizingPolicyConfig = {
    ...DEFAULT_SIZING_POLICY,
    method: 'atr_based',
    atr_risk_pct: 1.0,  // 每笔最多亏 1% equity
  };

  // 高 ATR → 仓位小
  // equity=1M, risk=1%=10K, atr=2元, price=20元
  // shares = 10K / 2 = 5K; target = 5K * 20 = 100K
  const dHighAtr = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 20,
    atr: 2,
    max_position_pct: 12,
  });
  expectClose('atr=2, price=20 → 100K target', dHighAtr.target_amount, 100_000);

  // 低 ATR → 仓位大
  // atr=0.5, price=20 → shares=20K, target=400K → cap to 120K (12%)
  const dLowAtr = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 20,
    atr: 0.5,
    max_position_pct: 12,
  });
  expectClose('low ATR → capped to 120K (12% max)', dLowAtr.target_amount, 120_000);
  assert('low ATR capped_by_max', dLowAtr.capped_by_max);

  // ATR 缺失 → 退化到 base
  const dNoAtr = decideSizing(policy, {
    equity: 1_000_000,
    available_cash: 500_000,
    current_price: 20,
    max_position_pct: 12,
    // no atr
  });
  expectClose('ATR missing → base 5%', dNoAtr.target_amount, 50_000);
}

// ============================================================
// 默认配置
// ============================================================

function testConstants() {
  console.log('\n## constants');
  expectEqual('DEFAULT method', DEFAULT_SIZING_POLICY.method, 'equal_pct');
  expectClose('DEFAULT base_position_pct', DEFAULT_SIZING_POLICY.base_position_pct, 5);
  expectClose('DEFAULT max_position_pct', DEFAULT_SIZING_POLICY.max_position_pct, 12);
  // frozen
  assert('DEFAULT is frozen', Object.isFrozen(DEFAULT_SIZING_POLICY));
}

// ============================================================
// main
// ============================================================

function main() {
  testConstants();
  testNormalize();
  testComputeVolTarget();
  testComputeAtrBased();
  testDecideSizingEqualPct();
  testDecideSizingVolTarget();
  testDecideSizingAtrBased();

  console.log(`\n========================================`);
  console.log(`PositionSizingPolicy tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
