/**
 * StrategyKillSwitchMonitor 单测 — Phase 4+ 策略熔断监控
 *
 * 只测纯函数 parseMetricName + computeMetric。DB-driven 逻辑由集成测试覆盖。
 */
import {
  parseMetricName,
  computeMetric,
} from '../../src/services/StrategyKillSwitchMonitor';

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

function testParseMetric() {
  console.log('\n## parseMetricName');

  // sharpe 系列
  const s30 = parseMetricName('sharpe_30d');
  assert('sharpe_30d type=sharpe', s30?.type === 'sharpe');
  assert('sharpe_30d days=30', s30?.lookback_days === 30);

  const s60 = parseMetricName('sharpe_60');
  assert('sharpe_60 (无 d) → sharpe', s60?.type === 'sharpe');
  assert('sharpe_60 days=60', s60?.lookback_days === 60);

  // mean_test_sharpe alias (与 walk-forward 对齐)
  const mt = parseMetricName('mean_test_sharpe_30d');
  assert('mean_test_sharpe → sharpe', mt?.type === 'sharpe');
  assert('mean_test_sharpe days=30', mt?.lookback_days === 30);

  // win_rate
  const w = parseMetricName('win_rate_90d');
  assert('win_rate_90d type=win_rate', w?.type === 'win_rate');
  assert('win_rate_90d days=90', w?.lookback_days === 90);

  // 大小写不敏感
  const upper = parseMetricName('SHARPE_45D');
  assert('SHARPE_45D 大小写 → sharpe', upper?.type === 'sharpe');
  assert('SHARPE_45D days=45', upper?.lookback_days === 45);

  // 不支持的 metric
  assert('null metric → null', parseMetricName('') === null);
  assert('随机字符串 → null', parseMetricName('foo_bar') === null);
  assert('out of range days → null', parseMetricName('sharpe_999999d') === null);
  assert('sharpe 缺数字 → null', parseMetricName('sharpe') === null);
  assert('未来格式 sortino_30d → null (尚不支持)', parseMetricName('sortino_30d') === null);
}

function testComputeMetric() {
  console.log('\n## computeMetric');

  // win_rate
  expectClose(
    'win_rate 全赢 → 1',
    computeMetric('win_rate', [{ total_pnl_pct: 3 }, { total_pnl_pct: 5 }])!,
    1
  );
  expectClose(
    'win_rate 全输 → 0',
    computeMetric('win_rate', [{ total_pnl_pct: -1 }, { total_pnl_pct: -2 }])!,
    0
  );
  expectClose(
    'win_rate 4/5 = 0.8',
    computeMetric('win_rate', [
      { total_pnl_pct: 3 },
      { total_pnl_pct: 5 },
      { total_pnl_pct: 7 },
      { total_pnl_pct: 2 },
      { total_pnl_pct: -1 },
    ])!,
    0.8
  );

  // realized_pnl_pct fallback
  expectClose(
    'fallback realized_pnl_pct',
    computeMetric('win_rate', [{ realized_pnl_pct: 5 }, { realized_pnl_pct: -3 }])!,
    0.5
  );

  // NaN 过滤
  expectClose(
    'NaN 过滤',
    computeMetric('win_rate', [
      { total_pnl_pct: 5 },
      { total_pnl_pct: NaN as any },
      { total_pnl_pct: -2 },
    ])!,
    0.5
  );

  // 空 rows → null
  assert('空 rows → null', computeMetric('win_rate', []) === null);

  // sharpe 全相等 (std=0) → null
  assert(
    '全相等 sharpe → null',
    computeMetric('sharpe', [{ total_pnl_pct: 5 }, { total_pnl_pct: 5 }, { total_pnl_pct: 5 }]) === null
  );

  // sharpe 单样本 → null
  assert('单样本 sharpe → null', computeMetric('sharpe', [{ total_pnl_pct: 5 }]) === null);

  // sharpe 合理值
  // pnl: [3, 5, 2, -1, 6]; mean=3; var=((0+4+1+16+9)/4)=7.5; std≈2.7386
  // sharpe = 3/2.7386 × sqrt(12) ≈ 3.794
  const sharpe = computeMetric('sharpe', [
    { total_pnl_pct: 3 },
    { total_pnl_pct: 5 },
    { total_pnl_pct: 2 },
    { total_pnl_pct: -1 },
    { total_pnl_pct: 6 },
  ]);
  expectClose('sharpe 5 笔 ≈3.794', sharpe!, 3.794, 0.01);

  // 负 mean → 负 sharpe
  const neg = computeMetric('sharpe', [
    { total_pnl_pct: -3 },
    { total_pnl_pct: -5 },
    { total_pnl_pct: 1 },
    { total_pnl_pct: -2 },
  ]);
  // mean=-2.25, var=((0.5625+7.5625+10.5625+0.0625)/3)=6.25, std=2.5
  // sharpe = -2.25/2.5 × sqrt(12) ≈ -3.117
  expectClose('negative sharpe ≈-3.117', neg!, -3.117, 0.01);
}

function main() {
  testParseMetric();
  testComputeMetric();
  console.log(`\n========================================`);
  console.log(`StrategyKillSwitchMonitor tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
