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

  // Phase 4+ NEW: sortino / calmar / profit_factor 新支持
  const sortino = parseMetricName('sortino_30d');
  assert('sortino_30d type=sortino', sortino?.type === 'sortino');
  assert('sortino_30d days=30', sortino?.lookback_days === 30);

  const calmar = parseMetricName('calmar_60d');
  assert('calmar_60d type=calmar', calmar?.type === 'calmar');
  assert('calmar_60d days=60', calmar?.lookback_days === 60);

  const pf = parseMetricName('profit_factor_90d');
  assert('profit_factor_90d type=profit_factor', pf?.type === 'profit_factor');
  assert('profit_factor_90d days=90', pf?.lookback_days === 90);

  const pfCase = parseMetricName('PROFIT_FACTOR_30D');
  assert('PROFIT_FACTOR_30D 大小写 → profit_factor', pfCase?.type === 'profit_factor');
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

  // ============================================================
  // Phase 4+ NEW: sortino / calmar / profit_factor
  // ============================================================

  // sortino — 与 sharpe 不同的是 std 只用负样本
  // pnls: [3, 5, -1, 6, -2]; mean = 11/5 = 2.2
  // negatives = [-1, -2]; downsideVariance = (1+4)/5 = 1; downsideStd = 1
  // sortino = 2.2 / 1 × sqrt(12) ≈ 7.622
  const sortino = computeMetric('sortino', [
    { total_pnl_pct: 3 },
    { total_pnl_pct: 5 },
    { total_pnl_pct: -1 },
    { total_pnl_pct: 6 },
    { total_pnl_pct: -2 },
  ]);
  expectClose('sortino 5 笔含 2 负 ≈7.62', sortino!, 7.62, 0.01);

  // sortino 全赢 → 大正数 999 (无下行风险)
  expectClose(
    'sortino 全赢 → 999',
    computeMetric('sortino', [{ total_pnl_pct: 3 }, { total_pnl_pct: 5 }])!,
    999
  );
  // sortino 全输 → mean<0 但 negatives 有，正常公式
  const sortinoAllLoss = computeMetric('sortino', [
    { total_pnl_pct: -2 },
    { total_pnl_pct: -3 },
    { total_pnl_pct: -1 },
  ]);
  assert('sortino 全输 → 非 null', sortinoAllLoss !== null && Number.isFinite(sortinoAllLoss));
  assert('sortino 全输 → 负值', sortinoAllLoss! < 0);

  // sortino 单样本 → null
  assert('sortino 单样本 → null', computeMetric('sortino', [{ total_pnl_pct: 5 }]) === null);

  // calmar — 累计 equity 曲线算最大回撤
  // pnls: [10, -5, 3]; equity: 100 → 110 → 104.5 → 107.635
  // peak=110, trough=104.5, max_dd = (110-104.5)/110 = 0.05
  // totalReturn = (107.635-100)/100 = 0.07635
  // annualReturn = (1.07635)^(12/3) - 1 = 1.07635^4 - 1 ≈ 0.3411
  // calmar = 0.3411 / 0.05 ≈ 6.82
  const calmar = computeMetric('calmar', [
    { total_pnl_pct: 10 },
    { total_pnl_pct: -5 },
    { total_pnl_pct: 3 },
  ]);
  expectClose('calmar 累计 dd 5% / annualReturn ~34% ≈ 6.82', calmar!, 6.82, 0.1);

  // calmar 无回撤 + 正回报 → 999
  expectClose(
    'calmar 全赢无回撤 → 999',
    computeMetric('calmar', [{ total_pnl_pct: 5 }, { total_pnl_pct: 3 }])!,
    999
  );

  // calmar 单样本 → null
  assert('calmar 单样本 → null', computeMetric('calmar', [{ total_pnl_pct: 5 }]) === null);

  // profit_factor — gross_win / |gross_loss|
  // pnls: [5, 3, -2, 4, -3]; grossWin = 12, grossLoss = 5
  // profit_factor = 12/5 = 2.4
  const pf = computeMetric('profit_factor', [
    { total_pnl_pct: 5 },
    { total_pnl_pct: 3 },
    { total_pnl_pct: -2 },
    { total_pnl_pct: 4 },
    { total_pnl_pct: -3 },
  ]);
  expectClose('profit_factor 12/5 = 2.4', pf!, 2.4);

  // profit_factor 全赢 → 999
  expectClose(
    'profit_factor 全赢 → 999',
    computeMetric('profit_factor', [{ total_pnl_pct: 5 }, { total_pnl_pct: 3 }])!,
    999
  );

  // profit_factor 全输 → grossWin=0 → 0
  expectClose(
    'profit_factor 全输 → 0',
    computeMetric('profit_factor', [{ total_pnl_pct: -3 }, { total_pnl_pct: -2 }])!,
    0
  );

  // profit_factor 空 → null
  assert('profit_factor 空 → null', computeMetric('profit_factor', []) === null);

  // NaN 过滤对新 metric 同样有效
  expectClose(
    'sortino NaN 过滤',
    computeMetric('sortino', [
      { total_pnl_pct: 3 },
      { total_pnl_pct: NaN as any },
      { total_pnl_pct: -1 },
    ])!,
    // pnls=[3,-1]; mean=1; neg=[-1]; dsVar=1/2=0.5; dsStd=√0.5≈0.707
    // sortino = 1/0.707 × √12 ≈ 4.899
    4.9,
    0.05
  );
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
