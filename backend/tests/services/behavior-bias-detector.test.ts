/**
 * BehaviorBiasDetector 单测 — Phase 8 行为偏差
 */
import {
  detectChasingHigh,
  detectOvertrading,
  detectAnchoringLoss,
  detectLossAversionEarlyTake,
  computeSeverity,
  computeOverallHealth,
  buildSummary,
  BehaviorBiasDetector,
  BehaviorBiasDataSource,
} from '../../src/services/BehaviorBiasDetector';

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

function testComputeSeverity() {
  console.log('\n## computeSeverity');
  expectClose('0/10 → 0', computeSeverity(0, 10), 0);
  expectClose('2/10 = 20% → 50', computeSeverity(2, 10), 50);
  expectClose('4/10 = 40% → 100 (cap)', computeSeverity(4, 10), 100);
  expectClose('10/10 → 100', computeSeverity(10, 10), 100);
  expectClose('total=0 → 0', computeSeverity(5, 0), 0);
}

function testChasingHigh() {
  console.log('\n## detectChasingHigh');
  const rows = [
    // 追高 (entry 100 / high5d 100 = 1.0, loss -5%)
    { entry_price: 100, high_during_5d_before_entry: 100, total_pnl_pct: -5, trade_status: 'closed' },
    // 追高 (0.96, loss)
    { entry_price: 96, high_during_5d_before_entry: 100, total_pnl_pct: -3, trade_status: 'closed' },
    // 不追高 (0.80, loss)
    { entry_price: 80, high_during_5d_before_entry: 100, total_pnl_pct: -2, trade_status: 'closed' },
    // 追高但赚了 (不算)
    { entry_price: 100, high_during_5d_before_entry: 100, total_pnl_pct: 8, trade_status: 'closed' },
    // 未平仓 (跳过)
    { entry_price: 100, high_during_5d_before_entry: 100, total_pnl_pct: -5, trade_status: 'open' },
  ];
  const r = detectChasingHigh(rows);
  expectClose('total = 4 (closed with valid prices)', r.total, 4);
  expectClose('triggered = 2 (前两笔)', r.triggered, 2);
}

function testOvertrading() {
  console.log('\n## detectOvertrading');
  const rows = [
    { holding_days: 1, trade_status: 'closed' },
    { holding_days: 2, trade_status: 'closed' },
    { holding_days: 5, trade_status: 'closed' },
    { holding_days: 30, trade_status: 'closed' },
    { holding_days: 60, trade_status: 'closed' },
  ];
  const r = detectOvertrading(rows);
  expectClose('total = 5', r.total, 5);
  expectClose('triggered = 2 (< 3 天)', r.triggered, 2);
  expectClose('avg = (1+2+5+30+60)/5 = 19.6', r.avg_holding_days, 19.6, 0.01);
}

function testAnchoringLoss() {
  console.log('\n## detectAnchoringLoss');
  const rows = [
    { total_pnl_pct: -5, holding_days: 45, trade_status: 'closed' }, // 套牢
    { total_pnl_pct: -3, holding_days: 60, trade_status: 'closed' }, // 套牢
    { total_pnl_pct: -8, holding_days: 5, trade_status: 'closed' },  // 短期止损 (不算)
    { total_pnl_pct: 10, holding_days: 50, trade_status: 'closed' }, // 盈利 不算亏损
  ];
  const r = detectAnchoringLoss(rows);
  expectClose('total_losses = 3', r.total_losses, 3);
  expectClose('triggered (> 30 天的亏损) = 2', r.triggered, 2);
}

function testLossAversionEarlyTake() {
  console.log('\n## detectLossAversionEarlyTake');
  const rows = [
    { total_pnl_pct: 1, trade_status: 'closed' },   // 小赚 trigger
    { total_pnl_pct: 2.5, trade_status: 'closed' }, // 小赚 trigger
    { total_pnl_pct: 8, trade_status: 'closed' },   // 大赚
    { total_pnl_pct: 15, trade_status: 'closed' },  // 大赚
    { total_pnl_pct: -3, trade_status: 'closed' },  // 亏损 不算
  ];
  const r = detectLossAversionEarlyTake(rows);
  expectClose('total_wins = 4', r.total_wins, 4);
  expectClose('triggered (< 3%) = 2', r.triggered, 2);
  // avg = (1+2.5+8+15)/4 = 6.625
  expectClose('avg_winner_return = 6.625', r.avg_winner_return, 6.625, 0.01);
}

function testComputeOverallHealth() {
  console.log('\n## computeOverallHealth');
  expectClose('empty findings → 100', computeOverallHealth([]), 100);
  // 3 findings 平均 severity = 30 → health = 70
  const findings: any[] = [
    { severity: 30 },
    { severity: 30 },
    { severity: 30 },
  ];
  expectClose('avg severity 30 → health 70', computeOverallHealth(findings), 70);
  // 1 严重 1 轻度
  expectClose(
    'avg (80+20)/2 = 50 → health 50',
    computeOverallHealth([{ severity: 80 }, { severity: 20 }] as any),
    50
  );
}

function testBuildSummary() {
  console.log('\n## buildSummary');
  // 健康
  const healthy = buildSummary([], 100);
  assert('健康 msg 含未发现', healthy.includes('未发现明显行为偏差'));

  // 严重 — chasing_high 80
  const severe = buildSummary(
    [
      { bias_key: 'chasing_high', bias_label: '追涨杀跌', severity: 80 } as any,
      { bias_key: 'overtrading', bias_label: '过度交易', severity: 30 } as any,
    ],
    20
  );
  assert('严重 msg 含 追涨杀跌', severe.includes('追涨杀跌'));
  assert('严重 msg 含 主要偏差', severe.includes('主要偏差'));

  // 中等
  const medium = buildSummary(
    [{ bias_key: 'overtrading', bias_label: '过度交易', severity: 40 } as any],
    60
  );
  assert('中等 msg 是 🟠', medium.includes('🟠'));
}

async function testGetReport() {
  console.log('\n## getReport with fake DataSource');
  const fakeSource: BehaviorBiasDataSource = {
    async loadOutcomes(_uid, _days) {
      return [
        // 追高 loss
        { entry_price: 100, high_during_5d_before_entry: 100, total_pnl_pct: -5, holding_days: 3, trade_status: 'closed' },
        { entry_price: 99, high_during_5d_before_entry: 100, total_pnl_pct: -4, holding_days: 4, trade_status: 'closed' },
        // 持有期长的 loss (anchoring)
        { entry_price: 50, high_during_5d_before_entry: 50, total_pnl_pct: -10, holding_days: 45, trade_status: 'closed' },
        // 小赚 (early take)
        { entry_price: 30, high_during_5d_before_entry: 35, total_pnl_pct: 2, holding_days: 5, trade_status: 'closed' },
        { entry_price: 40, high_during_5d_before_entry: 45, total_pnl_pct: 2.5, holding_days: 7, trade_status: 'closed' },
        // 正常持仓
        { entry_price: 60, high_during_5d_before_entry: 70, total_pnl_pct: 8, holding_days: 30, trade_status: 'closed' },
      ];
    },
  };
  const svc = new BehaviorBiasDetector(fakeSource);
  const r = await svc.getReport(1, 90);
  assert('total_outcomes = 6', r.total_outcomes === 6);
  assert('closed_outcomes = 6', r.closed_outcomes === 6);
  assert('findings 至少 3 个 bias', r.findings.length >= 3);

  // 追高应触发
  const chasing = r.findings.find(f => f.bias_key === 'chasing_high');
  assert('chasing_high 存在', chasing !== undefined);
  assert('chasing_high severity > 0', (chasing?.severity || 0) > 0);

  // health < 100
  assert('overall_health < 100', r.overall_health_score < 100);

  // summary msg 含主要偏差
  assert('summary 含 主要偏差', r.summary_message.includes('主要偏差') || r.summary_message.includes('未发现'));
}

async function main() {
  testComputeSeverity();
  testChasingHigh();
  testOvertrading();
  testAnchoringLoss();
  testLossAversionEarlyTake();
  testComputeOverallHealth();
  testBuildSummary();
  await testGetReport();
  console.log(`\n========================================`);
  console.log(`BehaviorBiasDetector tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
