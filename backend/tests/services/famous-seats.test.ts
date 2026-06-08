/**
 * famousSeats.ts 单元测试 (US-088)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/famous-seats.test.ts
 *
 * 范围:
 *   - SEAT_PROFILES 总数 ≥ 100 (AC: 至少覆盖 100 个常见营业部)
 *   - 每个 SeatProfile 字段合法 (name 非空 / type 在枚举内 / is_famous boolean)
 *   - 5 种 seat type 至少各有 1 条 (覆盖完整性)
 *   - isFamousYouzi 行为 (向后兼容 US-006)
 *   - canonicalSeatName 别名归一
 *   - getSeatType: 直接命中 / 别名归一 / 拉萨兜底 / 北向兜底 / 机构兜底 / unknown
 *   - isValidSeatType 校验逻辑
 */

import {
  SEAT_PROFILES,
  FAMOUS_YOUZI_SEATS,
  FAMOUS_SEAT_ALIASES,
  SeatType,
  isFamousYouzi,
  canonicalSeatName,
  getSeatType,
  isValidSeatType,
} from '../../src/constants/famousSeats';

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

console.log('--- SEAT_PROFILES 覆盖度 (AC) ---');
assert(
  `至少 100 条营业部 (实际 ${SEAT_PROFILES.length})`,
  SEAT_PROFILES.length >= 100,
  `expected >=100, got ${SEAT_PROFILES.length}`
);

console.log('--- SeatProfile 字段合法性 ---');
{
  const allTypesOk = SEAT_PROFILES.every(
    p =>
      typeof p.name === 'string' &&
      p.name.trim() === p.name &&
      p.name.length > 0 &&
      (p.type === 'public_fund' ||
        p.type === 'foreign' ||
        p.type === 'private_fund' ||
        p.type === 'famous_yz' ||
        p.type === 'unknown') &&
      typeof p.is_famous === 'boolean'
  );
  assert('每条 profile name 非空 / type 合法 / is_famous boolean', allTypesOk);
}

{
  const names = SEAT_PROFILES.map(p => p.name);
  const unique = new Set(names);
  assert(
    `name 字段无重复 (${unique.size}/${names.length})`,
    unique.size === names.length
  );
}

console.log('--- 5 种 SeatType 至少各 1 条 ---');
{
  const allTypes: SeatType[] = ['public_fund', 'foreign', 'private_fund', 'famous_yz'];
  for (const t of allTypes) {
    const count = SEAT_PROFILES.filter(p => p.type === t).length;
    assert(`type=${t} 至少 1 条 (实际 ${count})`, count >= 1);
  }
}

console.log('--- FAMOUS_YOUZI_SEATS 向后兼容 ---');
assert(
  'FAMOUS_YOUZI_SEATS 来源于 SEAT_PROFILES.famous_yz 子集',
  FAMOUS_YOUZI_SEATS.length === SEAT_PROFILES.filter(p => p.type === 'famous_yz').length
);
assert(
  'FAMOUS_YOUZI_SEATS 至少 30 条 (US-006 旧 AC)',
  FAMOUS_YOUZI_SEATS.length >= 30
);

console.log('--- isFamousYouzi (向后兼容 US-006) ---');
assert(
  '命中拉萨团结路第二营业部 → true',
  isFamousYouzi('东方财富证券股份有限公司拉萨团结路第二营业部') === true
);
assert(
  '命中绍兴营业部 → true',
  isFamousYouzi('中国银河证券股份有限公司绍兴营业部') === true
);
assert(
  '空字符串 → false',
  isFamousYouzi('') === false
);
assert('null → false', isFamousYouzi(null) === false);
assert('undefined → false', isFamousYouzi(undefined) === false);
assert(
  '别名"东方财富证券拉萨团结路第二营业部" → true (FAMOUS_SEAT_ALIASES 归一)',
  isFamousYouzi('东方财富证券拉萨团结路第二营业部') === true
);
assert(
  '拉萨系兜底（白名单外但匹配模式）→ true',
  isFamousYouzi('东方财富证券股份有限公司拉萨某新营业部') === true
);
assert(
  '完全无关营业部 → false',
  isFamousYouzi('某个不存在证券有限公司北京普通营业部') === false
);

console.log('--- canonicalSeatName ---');
assert(
  '命中别名归一',
  canonicalSeatName('中国银河证券绍兴营业部') === '中国银河证券股份有限公司绍兴营业部'
);
assert('未命中别名 → 原名', canonicalSeatName('某普通营业部') === '某普通营业部');
assert('带前后空格 → trim', canonicalSeatName('  某普通营业部  ') === '某普通营业部');

console.log('--- getSeatType 直接命中 ---');
assert(
  '拉萨团结路 → famous_yz',
  getSeatType('东方财富证券股份有限公司拉萨团结路第二营业部') === 'famous_yz'
);
assert(
  '中信里昂证券 → foreign',
  getSeatType('中信里昂证券有限公司') === 'foreign'
);
assert(
  '机构专用 → public_fund',
  getSeatType('机构专用') === 'public_fund'
);
assert(
  '私募专属席位 → private_fund',
  getSeatType('中信证券股份有限公司深圳总部证券营业部') === 'private_fund'
);

console.log('--- getSeatType 别名归一 ---');
assert(
  '别名"东方财富证券拉萨团结路第二营业部" → famous_yz',
  getSeatType('东方财富证券拉萨团结路第二营业部') === 'famous_yz'
);
assert(
  '别名"中国银河证券绍兴营业部" → famous_yz',
  getSeatType('中国银河证券绍兴营业部') === 'famous_yz'
);

console.log('--- getSeatType 兜底规则 ---');
assert(
  '拉萨系白名单外（东财+拉萨）→ famous_yz',
  getSeatType('东方财富证券股份有限公司拉萨某新营业部') === 'famous_yz'
);
assert('沪股通专用（直接命中标准名）→ foreign', getSeatType('沪股通专用') === 'foreign');
assert(
  '深股通（关键词兜底）→ foreign',
  getSeatType('某券商深股通席位') === 'foreign'
);
assert(
  '港股通席位（关键词兜底）→ foreign',
  getSeatType('某券商港股通席位') === 'foreign'
);
assert(
  'QFII（关键词兜底）→ foreign',
  getSeatType('某外资 QFII 席位') === 'foreign'
);
assert(
  '机构专用关键词（白名单外）→ public_fund',
  getSeatType('某新增机构专用席位') === 'public_fund'
);

console.log('--- getSeatType 边界 ---');
assert('null → unknown', getSeatType(null) === 'unknown');
assert('undefined → unknown', getSeatType(undefined) === 'unknown');
assert('空字符串 → unknown', getSeatType('') === 'unknown');
assert('空白字符串 → unknown', getSeatType('   ') === 'unknown');
assert(
  '完全无关营业部 → unknown',
  getSeatType('某个不存在证券有限公司北京普通营业部') === 'unknown'
);

console.log('--- isValidSeatType ---');
assert("'public_fund' → true", isValidSeatType('public_fund') === true);
assert("'foreign' → true", isValidSeatType('foreign') === true);
assert("'private_fund' → true", isValidSeatType('private_fund') === true);
assert("'famous_yz' → true", isValidSeatType('famous_yz') === true);
assert("'unknown' → true", isValidSeatType('unknown') === true);
assert("'bogus' → false", isValidSeatType('bogus') === false);
assert("'' → false", isValidSeatType('') === false);
assert('null → false', isValidSeatType(null) === false);
assert('undefined → false', isValidSeatType(undefined) === false);
assert('数字 1 → false', isValidSeatType(1) === false);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
