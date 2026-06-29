/**
 * sync-kol-opinions helpers unit test (PR-A hotfix 2026-06-29).
 *
 * Run:
 *   cd backend && npx ts-node --transpile-only tests/scripts/sync-kol-opinions.test.ts
 *
 * Pure-function tests for stripSuffix + rowsToFavoriteStockCodes — no DB.
 *
 * 守护回归: 之前 sync-kol-opinions --favorites 直接 SQL
 *   SELECT "symbol" FROM "favorite_stocks"
 * (FavoriteStock 表无 symbol 列, 只有 stock_id FK), cron 跑就挂. 修复后
 * 走 include:[Stock]+nest:true → row.Stock.symbol. 这里锁死 helper 形状,
 * 避免下一个 refactor 把它写回去.
 */

import { stripSuffix, rowsToFavoriteStockCodes } from '../../src/scripts/sync-kol-opinions';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// [1] stripSuffix — null / empty / 前后缀混合
console.log('\n[1] stripSuffix...');
assert('null → ""', stripSuffix(null) === '');
assert('undefined → ""', stripSuffix(undefined) === '');
assert('"" → ""', stripSuffix('') === '');
assert('"   " → ""', stripSuffix('   ') === '');
assert('"600519" passthrough', stripSuffix('600519') === '600519');
assert('"sh.600519" → "600519"', stripSuffix('sh.600519') === '600519');
assert('"sz.000001" → "000001"', stripSuffix('sz.000001') === '000001');
assert('"bj.430047" → "430047"', stripSuffix('bj.430047') === '430047');
assert('"SH.600519" 大写前缀 → "600519"', stripSuffix('SH.600519') === '600519');
assert('"600519.SH" 后缀 → "600519"', stripSuffix('600519.SH') === '600519');
assert('"000001.SZ" 后缀 → "000001"', stripSuffix('000001.SZ') === '000001');

// [2] rowsToFavoriteStockCodes — happy path
console.log('\n[2] rowsToFavoriteStockCodes happy path...');
const happy = rowsToFavoriteStockCodes([
  { Stock: { symbol: 'sh.600519' } },
  { Stock: { symbol: 'sz.000001' } },
  { Stock: { symbol: '600036.SH' } },
]);
assert('3 rows → 3 codes', happy.length === 3, `got=${JSON.stringify(happy)}`);
assert('order 保留', happy[0] === '600519' && happy[1] === '000001' && happy[2] === '600036');

// [3] dedup
console.log('\n[3] dedup...');
const dedup = rowsToFavoriteStockCodes([
  { Stock: { symbol: 'sh.600519' } },
  { Stock: { symbol: '600519.SH' } },
  { Stock: { symbol: 'sh.600519' } },
]);
assert('3 重复 → 1 code', dedup.length === 1, `got=${JSON.stringify(dedup)}`);
assert('保留 6 位', dedup[0] === '600519');

// [4] null / missing Stock / 非 6 位过滤
console.log('\n[4] null + 残缺 + invalid symbol...');
const dirty = rowsToFavoriteStockCodes([
  null,
  { Stock: null },
  { Stock: { symbol: null } },
  { Stock: { symbol: '' } },
  { Stock: { symbol: 'XYZ' } }, // 非 6 位数字
  { Stock: { symbol: 'sh.ABC123' } }, // 含字母
  { Stock: { symbol: '12345' } }, // 5 位
  { Stock: { symbol: '1234567' } }, // 7 位
  { Stock: { symbol: '600519' } }, // 合法
] as any);
assert('只留 1 个合法', dirty.length === 1, `got=${JSON.stringify(dirty)}`);
assert('保留是 600519', dirty[0] === '600519');

// [5] 空数组 / 空 rows
console.log('\n[5] 空 input...');
assert('[] → []', rowsToFavoriteStockCodes([]).length === 0);
assert('undefined → []', rowsToFavoriteStockCodes(undefined as any).length === 0);

// [6] META-GUARD: 验证 FavoriteStock 模型确实没有 symbol 列 (防止 schema 改回去)
console.log('\n[6] META-GUARD: FavoriteStock 模型无 symbol 字段...');
import('fs').then(fs => {
  const src = fs.readFileSync(
    require('path').resolve(__dirname, '../../src/models/FavoriteStock.ts'),
    'utf8'
  );
  // 不能含 `declare symbol` 或 `field: 'symbol'`
  const hasSymbolDecl = /declare\s+symbol\s*:/.test(src);
  const hasSymbolField = /field:\s*['"]symbol['"]/.test(src);
  assert(
    'FavoriteStock 没有 declare symbol',
    !hasSymbolDecl,
    `如果加了, 必须把本测试 + sync-kol-opinions.ts 一起改回 attributes:['symbol']`
  );
  assert('FavoriteStock 没有 field: symbol', !hasSymbolField);

  console.log(`\n========== sync-kol-opinions test: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
});
