/**
 * SizingAuditService 纯函数单测 (Phase 2+)
 *
 * 测 computeSummary + computeByStrategy 不依赖 DB。
 */
import { SizingAuditService } from '../../src/services/SizingAuditService';

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

// Helper to create fake audit row
function fakeRow(opts: {
  symbol?: string;
  strategy_key?: string;
  method?: string;
  hard_cutover?: boolean;
  actual_pct: number;
  decision_pct: number;
  capped_by_max?: boolean;
  capped_by_cash?: boolean;
}): any {
  return {
    symbol: opts.symbol || 'SH600519',
    strategy_key: opts.strategy_key || 'multi_factor_alpha',
    method: opts.method || 'kelly',
    hard_cutover: !!opts.hard_cutover,
    actual_pct: opts.actual_pct,
    decision_pct: opts.decision_pct,
    delta: opts.decision_pct - opts.actual_pct,
    capped_by_max: !!opts.capped_by_max,
    capped_by_cash: !!opts.capped_by_cash,
  };
}

function testComputeSummary() {
  console.log('\n## computeSummary');
  const svc = new SizingAuditService();

  // 空数组
  const empty = svc.computeSummary([]);
  expectClose('empty count=0', empty.count, 0);
  expectClose('empty avg_actual_pct=0', empty.avg_actual_pct, 0);

  // 3 行 shadow, 各 delta 不同
  const rows3 = [
    fakeRow({ actual_pct: 5, decision_pct: 8, symbol: 'A' }), // delta=3
    fakeRow({ actual_pct: 5, decision_pct: 4, symbol: 'B' }), // delta=-1
    fakeRow({ actual_pct: 5, decision_pct: 12, symbol: 'C', capped_by_max: true }), // delta=7
  ];
  const s = svc.computeSummary(rows3);
  expectClose('3 rows count', s.count, 3);
  expectClose('3 rows hard=0', s.hard_cutover_count, 0);
  expectClose('3 rows shadow=3', s.shadow_count, 3);
  expectClose('avg_actual=5', s.avg_actual_pct, 5);
  // avg_decision = (8+4+12)/3 = 8
  expectClose('avg_decision=8', s.avg_decision_pct, 8);
  // avg_delta = (3-1+7)/3 = 3
  expectClose('avg_delta=3', s.avg_delta_pct, 3);
  // max |delta| = 7 (C)
  expectClose('max_abs_delta=7', s.max_abs_delta_pct, 7);
  assert('max_abs_delta_symbol=C', s.max_abs_delta_symbol === 'C');
  // capped_by_max = 1/3 = 33.3%
  expectClose('capped_max=33.3%', s.capped_by_max_pct, 33.3);

  // 含 hard_cutover
  const mixed = [
    fakeRow({ actual_pct: 5, decision_pct: 5, hard_cutover: true }),
    fakeRow({ actual_pct: 5, decision_pct: 5, hard_cutover: true }),
    fakeRow({ actual_pct: 5, decision_pct: 8, hard_cutover: false }),
  ];
  const sm = svc.computeSummary(mixed);
  expectClose('mixed hard=2', sm.hard_cutover_count, 2);
  expectClose('mixed shadow=1', sm.shadow_count, 1);
}

function testComputeByStrategy() {
  console.log('\n## computeByStrategy');
  const svc = new SizingAuditService();

  const rows = [
    fakeRow({ strategy_key: 'multi_factor_alpha', actual_pct: 5, decision_pct: 8, method: 'kelly' }),
    fakeRow({ strategy_key: 'multi_factor_alpha', actual_pct: 5, decision_pct: 6, method: 'kelly' }),
    fakeRow({ strategy_key: 'dragon_head_momentum', actual_pct: 5, decision_pct: 4, method: 'vol_target' }),
    fakeRow({ strategy_key: 'multi_factor_alpha', actual_pct: 5, decision_pct: 12, method: 'kelly' }),
  ];
  const groups = svc.computeByStrategy(rows);
  expectClose('2 strategies', groups.length, 2);

  // 多数 → multi_factor_alpha 第一
  assert('first group strategy_key', groups[0].strategy_key === 'multi_factor_alpha');
  expectClose('first group count=3', groups[0].count, 3);
  // avg_decision = (8+6+12)/3 = 8.667
  expectClose('first avg_decision=8.667', groups[0].avg_decision_pct, 8.667, 0.01);
  // avg_delta = (3+1+7)/3 = 3.667
  expectClose('first avg_delta=3.667', groups[0].avg_delta_pct, 3.667, 0.01);
  assert('first method_breakdown kelly=3', groups[0].method_breakdown.kelly === 3);

  assert('second group dragon', groups[1].strategy_key === 'dragon_head_momentum');
  expectClose('second group count=1', groups[1].count, 1);
}

function main() {
  testComputeSummary();
  testComputeByStrategy();
  console.log(`\n========================================`);
  console.log(`SizingAuditService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
