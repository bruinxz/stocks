/**
 * ETF_PROFILES 白名单单元测试 (PR-F)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/constants/etf-industry.test.ts
 *
 * 校验:
 *   1. ETF_PROFILES 形态: code 6 位数字, name / industry 非空
 *   2. **唯一性**: code 不重复 (原 US-092 白名单有 159928 / 515170 两组重复, PR-F 清理)
 *   3. helpers 行为: getETFProfile / isWhitelistedETF / getETFCodesByIndustry /
 *      getAllETFIndustries / getAllWhitelistedETFCodes 在 happy / edge / unknown 上正确
 *   4. PR-F 重点: 通信 industry 必须 ≥ 6 只 ETF (回应用户 "通信 ETF 买哪个" 诉求)
 *   5. PR-F 总量门槛: ETF_PROFILES.length >= 70
 */

import {
  ETF_PROFILES,
  ETFProfile,
  getETFProfile,
  isWhitelistedETF,
  getAllWhitelistedETFCodes,
  getETFCodesByIndustry,
  getAllETFIndustries,
} from '../../src/constants/etfIndustry';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// [1] ETF_PROFILES 形态校验
// ---------------------------------------------------------------------------
console.log('\n[1] ETF_PROFILES 形态校验...');
assert('ETF_PROFILES 非空', ETF_PROFILES.length > 0);
for (const p of ETF_PROFILES) {
  assert(`code 6 位数字 (${p.code})`, /^[0-9]{6}$/.test(p.code), `bad=${p.code}`);
  assert(`name 非空 (${p.code})`, !!p.name && p.name.length > 0);
  assert(`industry 非空 (${p.code})`, !!p.industry && p.industry.length > 0);
}

// ---------------------------------------------------------------------------
// [2] code 唯一性 (原 US-092 白名单有重复, PR-F 清理 + enforce)
// ---------------------------------------------------------------------------
console.log('\n[2] code 唯一性...');
const codeCount = new Map<string, number>();
for (const p of ETF_PROFILES) {
  codeCount.set(p.code, (codeCount.get(p.code) ?? 0) + 1);
}
const dups: string[] = [];
for (const [code, n] of codeCount) {
  if (n > 1) dups.push(`${code}×${n}`);
}
assert('无重复 code', dups.length === 0, dups.join(', '));

// ---------------------------------------------------------------------------
// [3] helpers 行为
// ---------------------------------------------------------------------------
console.log('\n[3] helpers 行为...');
const sample: ETFProfile = ETF_PROFILES[0];
assert('getETFProfile 命中', getETFProfile(sample.code)?.code === sample.code);
assert('getETFProfile 未命中', getETFProfile('999999') === undefined);
assert('getETFProfile 空串返回 undefined', getETFProfile('') === undefined);
assert('getETFProfile 容忍空格', getETFProfile(`  ${sample.code}  `)?.code === sample.code);

assert('isWhitelistedETF 命中', isWhitelistedETF(sample.code));
assert('isWhitelistedETF 未命中', !isWhitelistedETF('999999'));
assert('isWhitelistedETF 空串 false', !isWhitelistedETF(''));

const allCodes = getAllWhitelistedETFCodes();
assertEqual('getAllWhitelistedETFCodes 长度', allCodes.length, ETF_PROFILES.length);
assert('getAllWhitelistedETFCodes 含示例 code', allCodes.includes(sample.code));

const industries = getAllETFIndustries();
assert('getAllETFIndustries 非空', industries.length > 0);
const isSorted = industries.every((v, i, a) => i === 0 || a[i - 1] <= v);
assert('getAllETFIndustries 字母序', isSorted);
assert('getAllETFIndustries 含 sample industry', industries.includes(sample.industry));

const sampleCodes = getETFCodesByIndustry(sample.industry);
assert('getETFCodesByIndustry 命中含 sample code', sampleCodes.includes(sample.code));
assertEqual('getETFCodesByIndustry 未知 industry 返回 []', getETFCodesByIndustry('不存在的行业'), []);
assertEqual('getETFCodesByIndustry 空串返回 []', getETFCodesByIndustry(''), []);

// ---------------------------------------------------------------------------
// [4] PR-F 重点: 通信 industry ≥ 6 只
// ---------------------------------------------------------------------------
console.log('\n[4] PR-F 通信主题门槛...');
const tongxinCodes = getETFCodesByIndustry('通信');
assert(
  `通信 industry 至少 6 只 (实际 ${tongxinCodes.length})`,
  tongxinCodes.length >= 6,
  tongxinCodes.join(',')
);
// PR-F 必须包含原有 3 只
for (const must of ['515050', '515880', '159994']) {
  assert(`通信 industry 含原有 ${must}`, tongxinCodes.includes(must));
}

// ---------------------------------------------------------------------------
// [5] PR-F 总量门槛 ≥ 70
// ---------------------------------------------------------------------------
console.log('\n[5] PR-F 总量门槛...');
assert(
  `ETF_PROFILES.length >= 70 (实际 ${ETF_PROFILES.length})`,
  ETF_PROFILES.length >= 70
);

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n=== 汇总: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
