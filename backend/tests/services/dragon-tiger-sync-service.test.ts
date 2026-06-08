/**
 * DragonTigerSyncService 纯函数单元测试 (US-088)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/dragon-tiger-sync-service.test.ts
 *
 * 覆盖 export 出来的纯函数 helpers:
 *   - clampLimit: undefined / null / 空串 / 合法数 / 0 / 负数 / 超大 / NaN / 字符串
 *   - resolveDateRange: 全缺省 / 仅 end / 仅 start / 双值 / 非法 fallback
 *
 * service.listEntries 涉及 Sequelize Op + DB，留给集成测试。
 */

import {
  clampLimit,
  resolveDateRange,
} from '../../src/data/services/DragonTigerSyncService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, details?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${details ? `\n    ${details}` : ''}`);
  }
}

console.log('--- clampLimit ---');
assert('undefined → 200 default', clampLimit(undefined) === 200);
assert('null → 200 default', clampLimit(null) === 200);
assert('空字符串 → 200 default', clampLimit('') === 200);
assert('100 → 100', clampLimit(100) === 100);
assert('"100" string → 100', clampLimit('100') === 100);
assert('0 → 1 (clamp lower)', clampLimit(0) === 1);
assert('-5 → 1 (clamp lower)', clampLimit(-5) === 1);
assert('1500 → 1000 (clamp upper)', clampLimit(1500) === 1000);
assert('1000 边界 → 1000', clampLimit(1000) === 1000);
assert('NaN → 200 default', clampLimit(NaN) === 200);
assert('"abc" 非数字 → 200 default', clampLimit('abc') === 200);
assert('1.7 浮点 → 1 (floor)', clampLimit(1.7) === 1);
assert('99.9 → 99 (floor)', clampLimit(99.9) === 99);
assert('自定义 default 50', clampLimit(undefined, 50) === 50);

console.log('--- resolveDateRange ---');
{
  // 注入固定 today 让测试可复现
  const today = '2024-06-15';
  const r = resolveDateRange(undefined, undefined, today);
  assert(`全缺省 → start=2024-06-08, end=2024-06-15`, r.start === '2024-06-08' && r.end === today,
    `got start=${r.start} end=${r.end}`);
}

{
  const today = '2024-06-15';
  const r = resolveDateRange('2024-06-01', undefined, today);
  assert(`仅 start → end=today`, r.start === '2024-06-01' && r.end === today,
    `got start=${r.start} end=${r.end}`);
}

{
  const today = '2024-06-15';
  const r = resolveDateRange(undefined, '2024-06-10', today);
  // start 缺省 = end - 7d
  assert(`仅 end → start=end-7d`, r.start === '2024-06-03' && r.end === '2024-06-10',
    `got start=${r.start} end=${r.end}`);
}

{
  const today = '2024-06-15';
  const r = resolveDateRange('2024-06-01', '2024-06-10', today);
  assert(`双值 → 原样返回`, r.start === '2024-06-01' && r.end === '2024-06-10',
    `got start=${r.start} end=${r.end}`);
}

{
  const today = '2024-06-15';
  const r = resolveDateRange('not-a-date', '2024-06-10', today);
  // 非法 start fallback 到 end-7d
  assert(`非法 start → fallback end-7d`, r.start === '2024-06-03' && r.end === '2024-06-10');
}

{
  const today = '2024-06-15';
  const r = resolveDateRange('2024-06-01', 'bogus', today);
  // 非法 end fallback 到 today, start 仍按原样
  assert(`非法 end → fallback today`, r.start === '2024-06-01' && r.end === today);
}

{
  const today = '2024-06-15';
  const r = resolveDateRange('bogus', 'bogus', today);
  // 双非法 → 全缺省行为
  assert(`双非法 → 等同全缺省`, r.start === '2024-06-08' && r.end === today);
}

{
  // 跨月边界
  const today = '2024-07-03';
  const r = resolveDateRange(undefined, undefined, today);
  assert(`跨月 today=07-03 → start=06-26`, r.start === '2024-06-26' && r.end === today,
    `got start=${r.start} end=${r.end}`);
}

{
  // 跨年边界
  const today = '2025-01-03';
  const r = resolveDateRange(undefined, undefined, today);
  assert(`跨年 today=2025-01-03 → start=2024-12-27`, r.start === '2024-12-27' && r.end === today,
    `got start=${r.start} end=${r.end}`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
