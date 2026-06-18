/**
 * CRON_REGISTRY 单元测试 (US-002 / OPS-002)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/constants/cron-registry.test.ts
 *
 * 这份测试是 CRON_REGISTRY ↔ SchedulerService._executeTaskLogic 之间的一致性 guard：
 *   1. registry 是 freeze 的, type 全大写下划线, 无重复, owner / description 非空
 *   2. buildCronRegistryDump() 稳定排序 (category 固定顺序, 同 category 内 type 字母序)
 *   3. isRegisteredCronType / getCronTaskDefinition / listRegisteredCronTypes 行为正确
 *   4. findUnregisteredTypes 能识别 DB 漂移项 (含去重 / 空串过滤 / 字母序)
 *   5. CRON_REGISTRY 的 type set 与 SchedulerService 源文件中所有
 *      `task.type === '...'` 字符串一致 (双向: 代码有的 registry 必须有, 反之亦然)
 *
 * 测试 #5 是这条 user story 的核心约束 —— 后续任何人加 / 删 cron 类型, 改两边里的
 * 任一边都会让这条单测立刻挂, 强制保持代码白名单与 dispatch 分支一致。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CRON_REGISTRY,
  buildCronRegistryDump,
  findUnregisteredTypes,
  getCronTaskDefinition,
  isRegisteredCronType,
  listRegisteredCronTypes,
} from '../../src/constants/cronRegistry';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// [1] CRON_REGISTRY 形态校验
// ---------------------------------------------------------------------------
console.log('\n[1] CRON_REGISTRY 形态校验...');
assert('CRON_REGISTRY 已 freeze', Object.isFrozen(CRON_REGISTRY));
assert('CRON_REGISTRY 非空', CRON_REGISTRY.length > 0);

const seenTypes = new Set<string>();
for (const def of CRON_REGISTRY) {
  assert(
    `type 大写下划线 (${def.type})`,
    /^[A-Z][A-Z0-9_]*$/.test(def.type),
    `bad type=${def.type}`
  );
  assert(`type 非重复 (${def.type})`, !seenTypes.has(def.type), `dup=${def.type}`);
  seenTypes.add(def.type);
  assert(`owner 非空 (${def.type})`, !!def.owner && def.owner.length > 0);
  assert(`description 非空 (${def.type})`, !!def.description && def.description.length > 0);
}

// ---------------------------------------------------------------------------
// [2] buildCronRegistryDump 稳定排序
// ---------------------------------------------------------------------------
console.log('\n[2] buildCronRegistryDump 稳定排序...');
const dump1 = buildCronRegistryDump();
const dump2 = buildCronRegistryDump();
assertEqual('buildCronRegistryDump 幂等', dump1, dump2);
assertEqual('dump 行数 = registry 长度', dump1.length, CRON_REGISTRY.length);

// 同 category 内字母序
const byCat = new Map<string, string[]>();
for (const line of dump1) {
  if (!byCat.has(line.category)) byCat.set(line.category, []);
  byCat.get(line.category)!.push(line.type);
}
for (const [cat, types] of byCat) {
  const sorted = [...types].sort();
  assertEqual(`category ${cat} 内 type 字母序`, types, sorted);
}

// category 整体出现顺序固定
const expectedCategoryOrder = [
  'data_sync',
  'factor',
  'quant_engine',
  'paper_trading',
  'risk_control',
  'live_trading',
  'analytics',
  'cleanup',
];
const seenCategoryOrder: string[] = [];
for (const line of dump1) {
  if (seenCategoryOrder[seenCategoryOrder.length - 1] !== line.category) {
    seenCategoryOrder.push(line.category);
  }
}
// 只比对在 registry 中真出现过的 categories 子集顺序
const actualSubset = seenCategoryOrder;
const expectedSubset = expectedCategoryOrder.filter(c => actualSubset.includes(c));
assertEqual('category 出现顺序固定', actualSubset, expectedSubset);

// dump 行字段对齐源 record
for (const line of dump1) {
  const src = getCronTaskDefinition(line.type)!;
  assertEqual(`dump category 对齐 (${line.type})`, line.category, src.category);
  assertEqual(`dump owner 对齐 (${line.type})`, line.owner, src.owner);
  assertEqual(`dump description 对齐 (${line.type})`, line.description, src.description);
  assertEqual(`dump recommendedCron 对齐 (${line.type})`, line.recommendedCron, src.recommendedCron);
  assertEqual(`dump intraday 对齐 (${line.type})`, line.intraday, src.intraday);
}

// ---------------------------------------------------------------------------
// [3] 查询函数
// ---------------------------------------------------------------------------
console.log('\n[3] 查询函数 (isRegistered / getCronTaskDefinition / listRegisteredCronTypes)...');
const sampleType = CRON_REGISTRY[0].type;
assert('isRegisteredCronType 命中真实 type', isRegisteredCronType(sampleType));
assert('isRegisteredCronType 拒绝未知 type', !isRegisteredCronType('NO_SUCH_TYPE_X'));
assert('isRegisteredCronType 拒绝空串', !isRegisteredCronType(''));
const got = getCronTaskDefinition(sampleType);
assert('getCronTaskDefinition 命中返回对象', !!got && got.type === sampleType);
assert('getCronTaskDefinition 未命中返回 undefined', getCronTaskDefinition('NO_SUCH_TYPE_X') === undefined);
const listed = listRegisteredCronTypes();
assertEqual('listRegisteredCronTypes 长度', listed.length, CRON_REGISTRY.length);
assertEqual('listRegisteredCronTypes set 完整', new Set(listed).size, CRON_REGISTRY.length);

// ---------------------------------------------------------------------------
// [4] findUnregisteredTypes
// ---------------------------------------------------------------------------
console.log('\n[4] findUnregisteredTypes...');
assertEqual('全 registered → 空', findUnregisteredTypes([sampleType, sampleType]), []);
assertEqual(
  '混合 → 仅返回未注册项, 字母序, 去重',
  findUnregisteredTypes([
    sampleType,
    'UNREG_B',
    'UNREG_A',
    'UNREG_B', // dup
    '', // 空串过滤
  ]),
  ['UNREG_A', 'UNREG_B']
);
assertEqual('空输入 → 空', findUnregisteredTypes([]), []);
assertEqual('仅空串 → 空', findUnregisteredTypes(['', '']), []);

// ---------------------------------------------------------------------------
// [5] 与 SchedulerService._executeTaskLogic 的双向一致性
//     这条是 OPS-002 的核心 guard —— 任何一边漂移立刻挂。
// ---------------------------------------------------------------------------
console.log('\n[5] CRON_REGISTRY ↔ SchedulerService dispatch 分支双向一致...');
const schedulerSrcPath = path.resolve(__dirname, '../../src/services/SchedulerService.ts');
assert('SchedulerService 源文件存在', fs.existsSync(schedulerSrcPath));
const schedulerSrc = fs.readFileSync(schedulerSrcPath, 'utf8');

const dispatchRegex = /task\.type\s*===\s*'([A-Z0-9_]+)'/g;
const dispatchTypes = new Set<string>();
let m: RegExpExecArray | null;
while ((m = dispatchRegex.exec(schedulerSrc)) !== null) {
  dispatchTypes.add(m[1]);
}
assert(
  `SchedulerService 中至少 1 个 task.type === '...' 分支 (扫到 ${dispatchTypes.size})`,
  dispatchTypes.size > 0
);

const registryTypes = new Set(CRON_REGISTRY.map(d => d.type));

const inSchedNotInRegistry = [...dispatchTypes].filter(t => !registryTypes.has(t)).sort();
assertEqual(
  '所有 dispatch 分支的 type 都登记在 CRON_REGISTRY (否则把缺失项加到 src/constants/cronRegistry.ts)',
  inSchedNotInRegistry,
  []
);

const inRegistryNotInSched = [...registryTypes].filter(t => !dispatchTypes.has(t)).sort();
assertEqual(
  '所有 CRON_REGISTRY 中的 type 都有 dispatch 分支 (否则去 SchedulerService._executeTaskLogic 加 else if)',
  inRegistryNotInSched,
  []
);

// ===========================================================================
console.log('\n--------------------------------------------------------------');
console.log(`Total: ${passed} ok, ${failed} failed`);
console.log('--------------------------------------------------------------');
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
