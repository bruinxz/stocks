/**
 * seed-mainstream-etfs script helpers unit test (PR-F 2026-06-29).
 *
 * Run:
 *   cd backend && npx ts-node --transpile-only tests/scripts/seed-mainstream-etfs.test.ts
 *
 * Pure-function tests for codeToSymbol / inferMarket — no DB.
 */

import { codeToSymbol, inferMarket } from '../../src/scripts/seed-mainstream-etfs';
import { ETF_PROFILES } from '../../src/constants/etfIndustry';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// [1] inferMarket
console.log('\n[1] inferMarket...');
assert('159 → SZ', inferMarket('159995') === 'SZ');
assert('512 → SH', inferMarket('512000') === 'SH');
assert('515 → SH', inferMarket('515050') === 'SH');
assert('510 → SH', inferMarket('510300') === 'SH');
assert('588 → SH', inferMarket('588000') === 'SH');
assert('562 → SH', inferMarket('562500') === 'SH');
assert('563 → SH', inferMarket('563530') === 'SH');

// [2] codeToSymbol
console.log('\n[2] codeToSymbol...');
assert('SH 拼接', codeToSymbol('515050', 'SH') === 'sh.515050');
assert('SZ 拼接', codeToSymbol('159995', 'SZ') === 'sz.159995');

// [3] 白名单全覆盖
console.log('\n[3] 白名单全覆盖 inferMarket 不抛...');
for (const p of ETF_PROFILES) {
  const m = inferMarket(p.code);
  assert(`${p.code} 推断 market 合法`, m === 'SH' || m === 'SZ');
  const sym = codeToSymbol(p.code, m);
  assert(`${p.code} symbol 含点号`, sym.includes('.'));
}

console.log(`\n=== 汇总: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
