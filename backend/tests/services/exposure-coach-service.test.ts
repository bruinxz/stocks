/**
 * ExposureCoachService 单测 — Phase 8 总仓位/暴露追踪
 */
import {
  ExposureCoachService,
  computeGrossExposure,
  computeNetExposure,
  computeBetaExposure,
  computeBeta,
  closeToReturns,
  buildWarnings,
  BETA_MIN_OBS,
  ExposureCoachDataSource,
} from '../../src/services/ExposureCoachService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}`
  );
}

function testComputeGrossExposure() {
  console.log('\n## computeGrossExposure');

  // 3 个持仓共 60K，equity 100K → gross = 0.6
  const positions = [
    { market_value: 20000 },
    { market_value: 25000 },
    { market_value: 15000 },
  ];
  expectClose('60K mv / 100K equity = 0.6', computeGrossExposure(positions, 100000), 0.6);

  // 负 mv (short) 按 abs 计入 gross
  const withShort = [
    { market_value: 30000 },
    { market_value: -10000 },
  ];
  expectClose('long 30K + short 10K → gross 0.4 / 100K', computeGrossExposure(withShort, 100000), 0.4);

  // equity ≤ 0 → 0
  expectClose('equity 0 → 0', computeGrossExposure(positions, 0), 0);

  // 空持仓 → 0
  expectClose('空持仓 → 0', computeGrossExposure([], 100000), 0);

  // 融资 (gross > 1)
  expectClose('200K mv / 100K equity = 2.0 leverage', computeGrossExposure([{ market_value: 200000 }], 100000), 2.0);
}

function testComputeNetExposure() {
  console.log('\n## computeNetExposure');

  // 纯多头时 net = gross
  const longOnly = [{ market_value: 30000 }, { market_value: 40000 }];
  expectClose('纯多头 net = gross', computeNetExposure(longOnly, 100000), 0.7);

  // 多空对冲 net = 0
  const balanced = [
    { market_value: 50000 },
    { market_value: -50000 },
  ];
  expectClose('多空对冲 net = 0', computeNetExposure(balanced, 100000), 0);

  // 纯空头 net < 0
  const shortOnly = [{ market_value: -30000 }];
  expectClose('纯空头 net = -0.3', computeNetExposure(shortOnly, 100000), -0.3);
}

function testComputeBetaExposure() {
  console.log('\n## computeBetaExposure');

  // 2 个等权持仓 β=1.0 和 β=0.5 → 加权 β = 0.75
  const r1 = computeBetaExposure([
    { market_value: 50000, beta_to_hs300: 1.0 },
    { market_value: 50000, beta_to_hs300: 0.5 },
  ]);
  expectClose('equal weight β: (1+0.5)/2 = 0.75', r1.beta_exposure, 0.75);
  expectClose('no missing', r1.missing_count, 0);

  // 不等权: 70K β=1.5 + 30K β=0.5 → 0.7×1.5 + 0.3×0.5 = 1.2
  const r2 = computeBetaExposure([
    { market_value: 70000, beta_to_hs300: 1.5 },
    { market_value: 30000, beta_to_hs300: 0.5 },
  ]);
  expectClose('weighted β = 1.2', r2.beta_exposure, 1.2);

  // 缺失 β → fallback 1.0
  const r3 = computeBetaExposure([
    { market_value: 50000, beta_to_hs300: 1.2 },
    { market_value: 50000, beta_to_hs300: null },
    { market_value: 50000 }, // undefined
  ]);
  // 加权: 0.333×1.2 + 0.333×1.0 + 0.333×1.0 = 1.0666
  expectClose('缺失 β fallback 1.0 → 1.067', r3.beta_exposure, 1.067, 0.005);
  expectClose('missing_count = 2', r3.missing_count, 2);

  // 全空 → 0
  const r4 = computeBetaExposure([]);
  expectClose('empty → 0', r4.beta_exposure, 0);
}

function testComputeBeta() {
  console.log('\n## computeBeta (OLS slope)');

  // β = 1: stock returns 完全跟 benchmark
  const N = BETA_MIN_OBS;
  const bench = Array.from({ length: N }, (_, i) => 0.01 * Math.sin(i));
  const stock = bench.slice();
  expectClose('完美 β=1', computeBeta(stock, bench)!, 1.0);

  // β = 2: stock 是 benchmark 的 2 倍
  const stock2 = bench.map(v => 2 * v);
  expectClose('β=2 (2x leverage)', computeBeta(stock2, bench)!, 2.0);

  // β = -0.5: stock 反向
  const stockNeg = bench.map(v => -0.5 * v);
  expectClose('β=-0.5 (反向)', computeBeta(stockNeg, bench)!, -0.5);

  // 长度不等 → null
  assert('length mismatch → null', computeBeta([1, 2, 3], [1, 2]) === null);

  // 长度 < MIN → null
  assert('short series → null', computeBeta([1, 2, 3], [1, 2, 3]) === null);

  // benchmark 方差 0 → null
  const flatBench = Array(N).fill(0.01);
  assert('flat benchmark → null', computeBeta(stock, flatBench) === null);
}

function testCloseToReturns() {
  console.log('\n## closeToReturns');
  const closes = [100, 110, 99];
  const returns = closeToReturns(closes);
  expectClose('length = 2', returns.length, 2);
  expectClose('[0] = 0.1', returns[0], 0.1);
  expectClose('[1] = -0.1', returns[1], -0.1, 0.001);
}

function testBuildWarnings() {
  console.log('\n## buildWarnings');

  // 健康状态 — 无 warning
  const healthy = buildWarnings(0.7, 0.7, 0.7, 0.95, 0.3, 0);
  expectClose('健康 0 warnings', healthy.length, 0);

  // 融资 → leverage warning
  const lev = buildWarnings(1.3, 1.3, 1.3, 1.0, 0.0, 0);
  assert('leverage > 1 → warning', lev.some(w => w.includes('杠杆')));

  // 满仓
  const full = buildWarnings(0.98, 0.98, 0.98, 1.0, 0.02, 0);
  assert('gross > 95% → warning', full.some(w => w.includes('近满仓')));
  assert('cash < 5% + gross > 90% → warning', full.some(w => w.includes('现金 < 5%')));

  // 高 β
  const highBeta = buildWarnings(0.7, 0.7, 0.7, 1.5, 0.3, 0);
  assert('β > 1.3 → warning', highBeta.some(w => w.includes('高敏感')));

  // 低 β (defensive)
  const lowBeta = buildWarnings(0.7, 0.7, 0.7, 0.3, 0.3, 0);
  assert('β < 0.5 → defensive 提示', lowBeta.some(w => w.includes('防御')));

  // β 缺失
  const missing = buildWarnings(0.7, 0.7, 0.7, 1.0, 0.3, 2);
  assert('β 缺失 → 提示', missing.some(w => w.includes('β 数据缺失')));
}

async function testGetReport() {
  console.log('\n## getReport (fake DataSource)');

  // 3 持仓总 60K + cash 40K = 100K equity；混合 β
  const fakeSource: ExposureCoachDataSource = {
    async loadPortfolioHeader(_pid) {
      return { user_id: 1, total_value: 100000, current_cash: 40000 };
    },
    async loadPositionsWithMV(_pid) {
      return [
        { symbol: 'A', market_value: 20000, quantity: 100 },
        { symbol: 'B', market_value: 25000, quantity: 100 },
        { symbol: 'C', market_value: 15000, quantity: 100 },
      ];
    },
    async loadStockBetas(_syms) {
      return new Map<string, number | null>([
        ['A', 1.2],
        ['B', 0.8],
        ['C', null], // 缺失
      ]);
    },
  };

  const svc = new ExposureCoachService(fakeSource);
  const r = await svc.getReport(1);
  assert('非空', r !== null);
  expectClose('total_equity', r!.total_equity, 100000);
  expectClose('current_cash', r!.current_cash, 40000);
  expectClose('cash_pct = 40%', r!.cash_pct, 0.4);
  expectClose('position_count = 3', r!.position_count, 3);
  expectClose('gross = 60K/100K = 0.6', r!.gross_exposure, 0.6);
  expectClose('net = gross (纯多头)', r!.net_exposure, 0.6);
  expectClose('leverage = gross', r!.leverage_ratio, 0.6);
  // β: 20K×1.2 + 25K×0.8 + 15K×1.0 (C fallback) = 24 + 20 + 15 = 59；总 60K → 59/60 = 0.983
  expectClose('β_exposure ≈ 0.983', r!.beta_exposure, 0.983, 0.01);
  expectClose('beta_missing_count = 1', r!.beta_missing_count, 1);
  assert('warnings 含 β 缺失', r!.warnings.some(w => w.includes('β 数据缺失')));

  // portfolio 不存在
  const fakeNull: ExposureCoachDataSource = {
    async loadPortfolioHeader() {
      return null;
    },
    async loadPositionsWithMV() {
      return [];
    },
    async loadStockBetas() {
      return new Map();
    },
  };
  const notFound = await new ExposureCoachService(fakeNull).getReport(999);
  assert('不存在 → null', notFound === null);
}

async function main() {
  testComputeGrossExposure();
  testComputeNetExposure();
  testComputeBetaExposure();
  testComputeBeta();
  testCloseToReturns();
  testBuildWarnings();
  await testGetReport();
  console.log(`\n========================================`);
  console.log(`ExposureCoachService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
