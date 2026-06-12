/**
 * EquityCurveGovernorService 单测 — Sprint 3
 */
import {
  EquityCurveGovernorService,
  computeRecentSharpe,
  computeCurrentDrawdown,
  computeRecentWinrate,
  deriveTier,
  buildGovernorSummary,
  TIER_MULTIPLIERS,
  DEFAULT_TIER_THRESHOLDS,
  PortfolioStats,
  GovernorDataSource,
} from '../../src/services/governor/EquityCurveGovernorService';
import { GovernorHealthTier } from '../../src/models/EquityCurveGovernorState';

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
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

function testTierMultipliers() {
  console.log('\n## TIER_MULTIPLIERS');
  assert('healthy = 1.0', TIER_MULTIPLIERS.healthy === 1.0);
  assert('cautious = 0.7', TIER_MULTIPLIERS.cautious === 0.7);
  assert('defensive = 0.4', TIER_MULTIPLIERS.defensive === 0.4);
  assert('critical = 0.2', TIER_MULTIPLIERS.critical === 0.2);
  assert('observe_only = 0', TIER_MULTIPLIERS.observe_only === 0);
}

function testComputeRecentSharpe() {
  console.log('\n## computeRecentSharpe');
  // 简单上升曲线
  const snaps = [
    { date: '2026-05-01', total_value: 100000 },
    { date: '2026-05-02', total_value: 101000 },
    { date: '2026-05-03', total_value: 102000 },
    { date: '2026-05-04', total_value: 103000 },
    { date: '2026-05-05', total_value: 104000 },
    { date: '2026-05-06', total_value: 105000 },
  ];
  const sharpe = computeRecentSharpe(snaps);
  assert('上升曲线 sharpe > 0', sharpe !== null && sharpe > 0, `sharpe=${sharpe}`);

  // 数据不足
  assert('< 6 个 → null', computeRecentSharpe(snaps.slice(0, 3)) === null);
  assert('空 → null', computeRecentSharpe([]) === null);
}

function testComputeCurrentDrawdown() {
  console.log('\n## computeCurrentDrawdown');
  // peak=120, current=100 → drawdown = 20/120 ≈ 0.1667
  const snaps = [
    { date: '2026-05-01', total_value: 100 },
    { date: '2026-05-02', total_value: 120 },
    { date: '2026-05-03', total_value: 100 },
  ];
  expectClose('drawdown ≈ 16.67%', computeCurrentDrawdown(snaps) as number, 20 / 120, 1e-3);

  // 单调上升 → 0
  const up = [
    { date: '2026-05-01', total_value: 100 },
    { date: '2026-05-02', total_value: 110 },
    { date: '2026-05-03', total_value: 120 },
  ];
  expectClose('上升 → 0', computeCurrentDrawdown(up) as number, 0);

  assert('空 → null', computeCurrentDrawdown([]) === null);
}

function testComputeRecentWinrate() {
  console.log('\n## computeRecentWinrate');
  expectClose('5 笔 3 胜 → 0.6', computeRecentWinrate([{ pnl: 1 }, { pnl: 2 }, { pnl: -1 }, { pnl: 3 }, { pnl: -2 }]) as number, 0.6);
  expectClose('全胜 → 1', computeRecentWinrate([{ pnl: 1 }, { pnl: 2 }]) as number, 1);
  expectClose('全负 → 0', computeRecentWinrate([{ pnl: -1 }, { pnl: -2 }]) as number, 0);
  assert('空 → null', computeRecentWinrate([]) === null);
}

function testDeriveTier() {
  console.log('\n## deriveTier');
  // 健康
  const healthy: PortfolioStats = {
    sharpe_30d: 1.5,
    drawdown_current: 0.02,
    winrate_30d: 0.7,
    trades_30d: 10,
    snapshots_count: 30,
  };
  const r1 = deriveTier(healthy);
  assert('健康 → healthy', r1.tier === 'healthy');

  // 6% drawdown → cautious
  const cautious: PortfolioStats = {
    sharpe_30d: 1.5,
    drawdown_current: 0.07,
    winrate_30d: 0.7,
    trades_30d: 10,
    snapshots_count: 30,
  };
  assert('drawdown 7% → cautious', deriveTier(cautious).tier === 'cautious');

  // 12% drawdown → defensive
  const defensive: PortfolioStats = {
    sharpe_30d: 1.5,
    drawdown_current: 0.13,
    winrate_30d: 0.7,
    trades_30d: 10,
    snapshots_count: 30,
  };
  assert('drawdown 13% → defensive', deriveTier(defensive).tier === 'defensive');

  // 18% drawdown → critical
  const critical: PortfolioStats = {
    sharpe_30d: 1.5,
    drawdown_current: 0.19,
    winrate_30d: 0.7,
    trades_30d: 10,
    snapshots_count: 30,
  };
  assert('drawdown 19% → critical', deriveTier(critical).tier === 'critical');

  // 25% drawdown → observe_only
  const obs: PortfolioStats = {
    sharpe_30d: 1.5,
    drawdown_current: 0.26,
    winrate_30d: 0.7,
    trades_30d: 10,
    snapshots_count: 30,
  };
  assert('drawdown 26% → observe_only', deriveTier(obs).tier === 'observe_only');

  // sharpe 触发
  const sharpeBad: PortfolioStats = {
    sharpe_30d: -1.6,
    drawdown_current: 0.02,
    winrate_30d: 0.7,
    trades_30d: 10,
    snapshots_count: 30,
  };
  assert('sharpe -1.6 → observe_only', deriveTier(sharpeBad).tier === 'observe_only');

  // winrate 触发
  const wrBad: PortfolioStats = {
    sharpe_30d: 1.5,
    drawdown_current: 0.02,
    winrate_30d: 0.25,
    trades_30d: 10,
    snapshots_count: 30,
  };
  assert('winrate 0.25 → critical', deriveTier(wrBad).tier === 'critical');

  // null 数据 → healthy (容错)
  const nullStats: PortfolioStats = {
    sharpe_30d: null,
    drawdown_current: null,
    winrate_30d: null,
    trades_30d: 0,
    snapshots_count: 0,
  };
  assert('全 null → healthy', deriveTier(nullStats).tier === 'healthy');
}

function testBuildSummary() {
  console.log('\n## buildGovernorSummary');
  const s = buildGovernorSummary({
    tier: 'cautious',
    multiplier: 0.7,
    trigger_reason: 'drawdown 7%',
    tier_changed: true,
    previous_tier: 'healthy',
    stats: { sharpe_30d: 1.2, drawdown_current: 0.07, winrate_30d: 0.55, trades_30d: 5, snapshots_count: 30 },
  });
  assert('summary 含 cautious', s.includes('cautious'));
  assert('summary 含切换提示', s.includes('从 healthy 切换'));
}

async function testServiceEvaluatePortfolio() {
  console.log('\n## evaluatePortfolio end-to-end');
  const fakeSource: GovernorDataSource = {
    async loadAllPortfolios() {
      return [
        { portfolio_id: 1, user_id: 100 },
        { portfolio_id: 2, user_id: 100 },
      ];
    },
    async loadStats(pid) {
      if (pid === 1) {
        return { sharpe_30d: 1.5, drawdown_current: 0.02, winrate_30d: 0.7, trades_30d: 10, snapshots_count: 30 };
      }
      return { sharpe_30d: -0.5, drawdown_current: 0.15, winrate_30d: 0.35, trades_30d: 5, snapshots_count: 30 };
    },
    async loadPreviousTier() {
      return null;
    },
  };
  const svc = new EquityCurveGovernorService(fakeSource);

  const r1 = await svc.evaluatePortfolio({ portfolio_id: 1, user_id: 100 }, { persist: false });
  assert('健康 portfolio → healthy', r1.tier === 'healthy');
  assert('multiplier = 1.0', r1.kelly_multiplier === 1.0);

  const r2 = await svc.evaluatePortfolio({ portfolio_id: 2, user_id: 100 }, { persist: false });
  assert('不健康 portfolio → 非 healthy', r2.tier !== 'healthy');
  assert('multiplier < 1', r2.kelly_multiplier < 1.0);

  // evaluateAll
  const all = await svc.evaluateAll({ persist: false });
  assert('evaluateAll 返回 2 个', all.length === 2);
}

async function testGetCurrentMultiplier() {
  console.log('\n## getCurrentMultiplier');
  let loadedRows = 0;
  const fakeSource: GovernorDataSource = {
    async loadAllPortfolios() {
      return [{ portfolio_id: 99, user_id: 1 }];
    },
    async loadStats() {
      return { sharpe_30d: 1.5, drawdown_current: 0.02, winrate_30d: 0.7, trades_30d: 10, snapshots_count: 30 };
    },
    async loadPreviousTier() {
      loadedRows += 1;
      return null;
    },
  };
  const svc = new EquityCurveGovernorService(fakeSource);
  svc.clearCache();

  // evaluate 后 cache 应该有值
  await svc.evaluatePortfolio({ portfolio_id: 99, user_id: 1 }, { persist: false });
  const m = await svc.getCurrentMultiplier(99);
  expectClose('cache 命中 → 1.0', m, 1.0);
}

async function main() {
  testTierMultipliers();
  testComputeRecentSharpe();
  testComputeCurrentDrawdown();
  testComputeRecentWinrate();
  testDeriveTier();
  testBuildSummary();
  await testServiceEvaluatePortfolio();
  await testGetCurrentMultiplier();
  console.log(`\n========================================`);
  console.log(`EquityCurveGovernorService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
