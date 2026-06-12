/**
 * DataQualityDeepCheckService 单测 (纯函数)
 */
import {
  aggregateBySeverity,
  deriveOverallStatus,
} from '../../src/services/DataQualityDeepCheckService';

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
function expectClose(name: string, actual: number, expected: number) {
  assert(name, actual === expected, `expected=${expected}, got=${actual}`);
}

function testAggregateBySeverity() {
  console.log('\n## aggregateBySeverity');
  const empty = aggregateBySeverity([]);
  expectClose('empty critical=0', empty.critical, 0);
  expectClose('empty high=0', empty.high, 0);
  expectClose('empty medium=0', empty.medium, 0);
  expectClose('empty low=0', empty.low, 0);

  const mixed = aggregateBySeverity([
    { check_name: 'a', severity: 'critical', count: 3, sample: [], detail: '' },
    { check_name: 'b', severity: 'critical', count: 2, sample: [], detail: '' },
    { check_name: 'c', severity: 'high', count: 5, sample: [], detail: '' },
    { check_name: 'd', severity: 'low', count: 10, sample: [], detail: '' },
  ]);
  expectClose('critical 3+2=5', mixed.critical, 5);
  expectClose('high=5', mixed.high, 5);
  expectClose('medium=0', mixed.medium, 0);
  expectClose('low=10', mixed.low, 10);
}

function testDeriveOverallStatus() {
  console.log('\n## deriveOverallStatus');
  assert(
    '全 0 → clean',
    deriveOverallStatus({ critical: 0, high: 0, medium: 0, low: 0 }) === 'clean'
  );
  assert(
    'critical > 0 → critical',
    deriveOverallStatus({ critical: 1, high: 0, medium: 0, low: 0 }) === 'critical'
  );
  assert(
    'high > 0 (无 critical) → warning',
    deriveOverallStatus({ critical: 0, high: 1, medium: 0, low: 0 }) === 'warning'
  );
  assert(
    '只 medium/low → clean (可接受)',
    deriveOverallStatus({ critical: 0, high: 0, medium: 5, low: 10 }) === 'clean'
  );
  assert(
    'critical + high 都有 → critical (最高优先)',
    deriveOverallStatus({ critical: 1, high: 5, medium: 0, low: 0 }) === 'critical'
  );
}

function main() {
  testAggregateBySeverity();
  testDeriveOverallStatus();
  console.log(`\n========================================`);
  console.log(`DataQualityDeepCheckService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
