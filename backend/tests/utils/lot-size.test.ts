/**
 * lotSizeFor / quantizeBuyQuantity 板块感知最小交易单位测试 (HIGH #13).
 *
 * 跑: cd backend && npx ts-node --transpile-only tests/utils/lot-size.test.ts
 */
import { lotSizeFor, quantizeBuyQuantity } from '../../src/utils/stockSymbol';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

// lotSizeFor
assert(lotSizeFor('sh.600000').lot === 100, '主板 sh.6 lot=100');
assert(lotSizeFor('sh.600000').min_qty === 100, '主板 min=100');
assert(lotSizeFor('sz.000001').lot === 100, '深市主板 sz.0 lot=100');
assert(lotSizeFor('sz.300001').lot === 100, '创业板 sz.3 lot=100');
assert(lotSizeFor('sh.688001').lot === 1, '科创板 sh.688 lot=1');
assert(lotSizeFor('sh.688001').min_qty === 200, '科创板 min=200');
assert(lotSizeFor('sh.689001').lot === 1, '科创板 sh.689 lot=1');
assert(lotSizeFor('bj.830001').lot === 1, '北交所 lot=1');
assert(lotSizeFor('bj.830001').min_qty === 100, '北交所 min=100');

// quantizeBuyQuantity
assert(quantizeBuyQuantity(550, 'sh.600000') === 500, '主板 550 → 500 (floor 100)');
assert(quantizeBuyQuantity(99, 'sh.600000') === 0, '主板 99 → 0 (< min 100)');
assert(quantizeBuyQuantity(101, 'sh.600000') === 100, '主板 101 → 100');
assert(quantizeBuyQuantity(550, 'sh.688001') === 550, '科创板 550 → 550 (lot=1, ≥ min 200)');
assert(quantizeBuyQuantity(199, 'sh.688001') === 0, '科创板 199 → 0 (< min 200)');
assert(quantizeBuyQuantity(200, 'sh.688001') === 200, '科创板 200 → 200 (恰好 min)');
assert(quantizeBuyQuantity(155, 'bj.830001') === 155, '北交所 155 → 155 (lot=1, ≥ min 100)');
assert(quantizeBuyQuantity(99, 'bj.830001') === 0, '北交所 99 → 0 (< min 100)');

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) {
  console.error(`\nFAILURES:\n${failures.map(f => `  - ${f}`).join('\n')}`);
  process.exit(1);
} else {
  console.log('✓ lotSizeFor / quantizeBuyQuantity tests passed.');
  process.exit(0);
}
