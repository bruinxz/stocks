/**
 * DataHealthStatusService 纯函数单元测试 (US-079)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/data-health-status-service.test.ts
 *
 * 范围 — 只覆盖 4 个 export 出来的纯函数:
 *   - normalizeDateOnly: 处理 string / Date / null / 非法值
 *   - normalizeIsoDateTime: 同上但输出 ISO 字符串
 *   - computeLagInTradingDays: 0 lag / 多日 lag / 节假日跨越 / 边界
 *   - decideLevel: daily 阈值 (0/1-3/>3) + periodic 阈值 (30/90) + event 阈值 (7/14) + unknown
 *
 * 集成层 (Sequelize raw aggregate + 异步) 留给后续 story 加测——遵循 codebase 模式:
 * 复杂 service 通过纯函数 helper 抽取 + helper 单测覆盖, e2e 走集成测试。
 */

import {
  normalizeDateOnly,
  normalizeIsoDateTime,
  computeLagInTradingDays,
  decideLevel,
} from '../../src/services/DataHealthStatusService';

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

console.log('--- normalizeDateOnly ---');
assert(
  'string "2024-12-31" → "2024-12-31"',
  normalizeDateOnly('2024-12-31') === '2024-12-31'
);
assert(
  'string "2024-12-31T08:00:00Z" → "2024-12-31"',
  normalizeDateOnly('2024-12-31T08:00:00Z') === '2024-12-31'
);
assert('null → null', normalizeDateOnly(null) === null);
assert('undefined → null', normalizeDateOnly(undefined) === null);
assert('Date instance → "YYYY-MM-DD"', (() => {
  const d = new Date('2024-06-01T12:00:00Z');
  return normalizeDateOnly(d) === '2024-06-01';
})());
assert('"abc" non-date string → null', normalizeDateOnly('abc') === null);
assert('Invalid Date → null', normalizeDateOnly(new Date('not-a-date')) === null);

console.log('--- normalizeIsoDateTime ---');
assert('null → null', normalizeIsoDateTime(null) === null);
assert('Date → ISO', (() => {
  const d = new Date('2024-06-01T12:00:00Z');
  const out = normalizeIsoDateTime(d);
  return out === '2024-06-01T12:00:00.000Z';
})());
assert('valid string → ISO', (() => {
  const out = normalizeIsoDateTime('2024-06-01T12:00:00Z');
  return out === '2024-06-01T12:00:00.000Z';
})());
assert('Invalid string → null', normalizeIsoDateTime('not a date') === null);

console.log('--- computeLagInTradingDays ---');
const tradeDates = [
  '2024-06-05',
  '2024-06-04',
  '2024-06-03',
  '2024-05-31',
  '2024-05-30',
]; // DESC, 含周末间隔(31→3)

assert(
  'null latest → null',
  computeLagInTradingDays(null, '2024-06-05', tradeDates) === null
);
assert(
  'null reference → null',
  computeLagInTradingDays('2024-06-04', null, tradeDates) === null
);
assert(
  'latest === reference → 0',
  computeLagInTradingDays('2024-06-05', '2024-06-05', tradeDates) === 0
);
assert(
  'latest > reference → 0 (future data fine)',
  computeLagInTradingDays('2024-06-06', '2024-06-05', tradeDates) === 0
);
assert(
  'latest 06-04, reference 06-05 → 1',
  computeLagInTradingDays('2024-06-04', '2024-06-05', tradeDates) === 1
);
assert(
  'latest 06-03, reference 06-05 → 2',
  computeLagInTradingDays('2024-06-03', '2024-06-05', tradeDates) === 2
);
assert(
  'latest 05-30, reference 06-05 → 4 (跨周末)',
  computeLagInTradingDays('2024-05-30', '2024-06-05', tradeDates) === 4
);

console.log('--- decideLevel (daily) ---');
assert("daily lag 0 → green", decideLevel(0, 'daily') === 'green');
assert("daily lag 1 → yellow", decideLevel(1, 'daily') === 'yellow');
assert("daily lag 3 → yellow", decideLevel(3, 'daily') === 'yellow');
assert("daily lag 4 → red", decideLevel(4, 'daily') === 'red');
assert("daily lag null → unknown", decideLevel(null, 'daily') === 'unknown');

console.log('--- decideLevel (periodic) ---');
assert("periodic lag 30 → green", decideLevel(30, 'periodic') === 'green');
assert("periodic lag 31 → yellow", decideLevel(31, 'periodic') === 'yellow');
assert("periodic lag 90 → yellow", decideLevel(90, 'periodic') === 'yellow');
assert("periodic lag 91 → red", decideLevel(91, 'periodic') === 'red');
assert("periodic lag null → unknown", decideLevel(null, 'periodic') === 'unknown');

console.log('--- decideLevel (event) ---');
assert("event lag 7 → green", decideLevel(7, 'event') === 'green');
assert("event lag 8 → yellow", decideLevel(8, 'event') === 'yellow');
assert("event lag 14 → yellow", decideLevel(14, 'event') === 'yellow');
assert("event lag 15 → red", decideLevel(15, 'event') === 'red');
assert("event lag null → unknown", decideLevel(null, 'event') === 'unknown');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
