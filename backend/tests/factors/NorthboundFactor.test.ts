/**
 * NorthboundFactor 单元测试 (BD-1 stale guard).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/NorthboundFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 isDataSourceStale:
 *     - null latestIso → true (表空 = stale)
 *     - latest == asOf → false
 *     - latest = asOf - threshold 天 → false (恰好等于阈值)
 *     - latest < asOf - threshold 天 → true
 *     - 自定义阈值生效
 *   - Factor metadata (name='northbound' / category='flow' / 已注册)
 *   - 常量校验 DATA_STALENESS_THRESHOLD_DAYS=30
 *   - compute() 空 universe 安全路径
 */

import {
  northboundFactor,
  isDataSourceStale,
  DATA_STALENESS_THRESHOLD_DAYS,
} from '../../src/quant/factors/library/NorthboundFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记
// eslint-disable-next-line @typescript-eslint/no-var-requires
import '../../src/quant/factors/library';

let passed = 0;
let failed = 0;

function expectEqual<T>(label: string, actual: T, expected: T) {
  if (actual === expected) {
    console.log(`  ok  ${label} (got ${String(actual)})`);
    passed += 1;
  } else {
    console.log(`  FAIL ${label} (got ${String(actual)}, expected ${String(expected)})`);
    failed += 1;
  }
}

console.log('## 常量校验');
expectEqual(
  'DATA_STALENESS_THRESHOLD_DAYS = 30',
  DATA_STALENESS_THRESHOLD_DAYS,
  30
);

console.log('\n## isDataSourceStale');
expectEqual('null latest → stale', isDataSourceStale(null, '2026-06-23'), true);
expectEqual('empty string latest → stale', isDataSourceStale('', '2026-06-23'), true);
expectEqual(
  'latest == asOf → not stale',
  isDataSourceStale('2026-06-23', '2026-06-23'),
  false
);
expectEqual(
  'latest = asOf - 1d → not stale',
  isDataSourceStale('2026-06-22', '2026-06-23'),
  false
);
expectEqual(
  'latest = asOf - 30d → not stale (恰好阈值)',
  isDataSourceStale('2026-05-24', '2026-06-23'),
  false
);
expectEqual(
  'latest = asOf - 31d → stale',
  isDataSourceStale('2026-05-23', '2026-06-23'),
  true
);
expectEqual(
  'latest = 2024-08-16 vs asOf=2026-06-23 → stale (22 个月)',
  isDataSourceStale('2024-08-16', '2026-06-23'),
  true
);
expectEqual(
  '自定义 thresholdDays=365 → 1 年内不 stale',
  isDataSourceStale('2025-07-01', '2026-06-23', 365),
  false
);
expectEqual(
  '自定义 thresholdDays=0 → 仅当日不 stale',
  isDataSourceStale('2026-06-22', '2026-06-23', 0),
  true
);

console.log('\n## Factor metadata');
expectEqual('name', northboundFactor.name, 'northbound');
expectEqual('category', northboundFactor.category, 'flow');
expectEqual('description 非空', typeof northboundFactor.description, 'string');
expectEqual(
  'compute is function',
  typeof northboundFactor.compute,
  'function'
);
expectEqual('factorRegistry.has(northbound)', factorRegistry.has('northbound'), true);
expectEqual('listNames 含 northbound', factorRegistry.listNames().includes('northbound'), true);
expectEqual('registry.get 拿回同对象', factorRegistry.get('northbound') === northboundFactor, true);

console.log('\n## compute() 空 universe 安全路径');
(async () => {
  const out = await northboundFactor.compute({
    as_of_date: '2026-06-23',
    universe: [],
    lookbackDays: 250,
    options: {},
  });
  expectEqual('compute(universe=[]) → 空 Map', out.size, 0);

  console.log(`\n## Summary: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
