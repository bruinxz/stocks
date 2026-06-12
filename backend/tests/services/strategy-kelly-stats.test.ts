/**
 * StrategyKellyStatsService 单测 — Phase 2+ Kelly sizing 数据源
 *
 * 只测纯计算 computeStats (DB 部分由集成测试覆盖)
 */
import {
  StrategyKellyStatsService,
} from '../../src/services/StrategyKellyStatsService';

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

function testComputeStats() {
  console.log('\n## StrategyKellyStatsService.computeStats');

  const svc = new StrategyKellyStatsService();

  // 6 wins (5%/3%/8%/2%/4%/6%) + 4 losses (-3%/-5%/-2%/-4%)
  const rows = [
    { total_pnl_pct: 5 },
    { total_pnl_pct: 3 },
    { total_pnl_pct: 8 },
    { total_pnl_pct: 2 },
    { total_pnl_pct: 4 },
    { total_pnl_pct: 6 },
    { total_pnl_pct: -3 },
    { total_pnl_pct: -5 },
    { total_pnl_pct: -2 },
    { total_pnl_pct: -4 },
  ];
  const s = svc.computeStats('test_strategy', rows);
  expectClose('sample_size=10', s.sample_size, 10);
  expectClose('win_count=6', s.win_count, 6);
  expectClose('loss_count=4', s.loss_count, 4);
  expectClose('win_rate=0.6', s.win_rate, 0.6);
  // avg_win = (5+3+8+2+4+6)/6 = 28/6 ≈ 4.667
  expectClose('avg_win_pct≈4.667', s.avg_win_pct, 4.667, 0.01);
  // avg_loss = |(-3-5-2-4)/4| = 14/4 = 3.5
  expectClose('avg_loss_pct=3.5', s.avg_loss_pct, 3.5);
  // payoff = 4.667/3.5 ≈ 1.333
  expectClose('payoff_ratio≈1.333', s.payoff_ratio, 1.333, 0.01);

  // 全赢 → payoff fallback to 1
  const allWins = svc.computeStats('all_wins', [
    { total_pnl_pct: 5 },
    { total_pnl_pct: 10 },
  ]);
  expectClose('all_wins win_rate=1', allWins.win_rate, 1);
  expectClose('all_wins payoff_ratio=1 (fallback)', allWins.payoff_ratio, 1);

  // 全输 → win_rate=0, payoff valid
  const allLosses = svc.computeStats('all_losses', [
    { total_pnl_pct: -3 },
    { total_pnl_pct: -7 },
  ]);
  expectClose('all_losses win_rate=0', allLosses.win_rate, 0);
  expectClose('all_losses avg_win=0', allLosses.avg_win_pct, 0);
  expectClose('all_losses avg_loss=5', allLosses.avg_loss_pct, 5);

  // 空 rows → 都是 0
  const empty = svc.computeStats('empty', []);
  expectClose('empty sample_size=0', empty.sample_size, 0);
  expectClose('empty win_rate=0', empty.win_rate, 0);

  // 使用 realized_pnl_pct fallback
  const fallback = svc.computeStats('fallback', [
    { realized_pnl_pct: 4 },
    { realized_pnl_pct: -2 },
  ]);
  expectClose('fallback sample_size=2', fallback.sample_size, 2);
  expectClose('fallback win_rate=0.5', fallback.win_rate, 0.5);

  // NaN/null/undefined values → filtered out
  const noisy = svc.computeStats('noisy', [
    { total_pnl_pct: 5 },
    { total_pnl_pct: NaN as any },
    { total_pnl_pct: undefined },
    { total_pnl_pct: -3 },
  ]);
  expectClose('noisy filtered: sample_size=2', noisy.sample_size, 2);
}

function testCache() {
  console.log('\n## cache invalidate');
  const svc = new StrategyKellyStatsService();
  // 直接写 cache (bypass DB)
  (svc as any).cache.set('foo', { stats: null, computed_at: Date.now() });
  assert('cache has foo', (svc as any).cache.has('foo'));
  svc.invalidate('foo');
  assert('after invalidate(foo): cache miss', !(svc as any).cache.has('foo'));

  (svc as any).cache.set('a', { stats: null, computed_at: Date.now() });
  (svc as any).cache.set('b', { stats: null, computed_at: Date.now() });
  svc.invalidateAll();
  assert('after invalidateAll: cache empty', (svc as any).cache.size === 0);
}

function main() {
  testComputeStats();
  testCache();
  console.log(`\n========================================`);
  console.log(`StrategyKellyStatsService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
