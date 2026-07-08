/**
 * scheduler-default-tasks-completeness.test.ts
 *
 * Macro 串联补丁 (2026-06-21) — Batch AJ: 14 个之前漏 seed 的 cron + 3 个本批
 * 新增 cron 必须全部在 SchedulerService.ensureDefaultTasks 数组里出现.
 *
 * 这是反 drift 的 boot-time guard 的"代码侧"延伸 (initialize() 末尾 warn 是
 * runtime 侧). 让任何人删 / 改 seed 时立刻被 CI 拦.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only \
 *     tests/services/scheduler-default-tasks-completeness.test.ts
 *
 * 覆盖维度:
 *   [1] 14 个 macro-integration-check report §🚨 #3 列的 cron 全部出现在 seed 数组
 *   [2] 3 个本批新增 cron (WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE,
 *       DAILY_IMPROVEMENT_EFFECT_TRACK, ETF_FLOW_SYNC) 全部出现在 seed
 *   [3] 每个 seed 的 cron_expression 与 cronRegistry.recommendedCron 一致
 *       (允许 LIVE_RECONCILIATION_GUARD 多 row 拆分 intraday/eod — 见 #4)
 *   [4] LIVE_RECONCILIATION_GUARD 必须有 intraday + eod 两行 (window 字段区分)
 *   [5] reverse drift guard 已写在 SchedulerService.initialize/dumpActiveTaskSchedule
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { CRON_REGISTRY, getCronTaskDefinition } from '../../src/constants/cronRegistry';

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

const SCHEDULER_SRC = readFileSync(
  join(__dirname, '../../src/services/SchedulerService.ts'),
  'utf8'
);

/** 提取 ensureDefaultTasks 数组中所有 (type, cron_expression) 二元组. */
function extractSeededTasks(src: string): Array<{ type: string; cron: string }> {
  // 简单 regex: 抓所有 "type: 'X', cron_expression: 'Y'," (允许中间空行)
  // ensureDefaultTasks 的入口在 5644 行附近; 我们扫整个文件,
  // 但只保留 isRegisteredCronType 的 type (排除小写 task_type 嵌入字符串).
  const out: Array<{ type: string; cron: string }> = [];
  const re = /\{\s*(?:[^{}]*?\n)?\s*name:\s*['"][^'"]+['"],\s*type:\s*'([A-Z][A-Z0-9_]+)',\s*cron_expression:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ type: m[1], cron: m[2] });
  }
  return out;
}

const seeded = extractSeededTasks(SCHEDULER_SRC);
const seededByType = new Map<string, Array<{ type: string; cron: string }>>();
for (const s of seeded) {
  if (!seededByType.has(s.type)) seededByType.set(s.type, []);
  seededByType.get(s.type)!.push(s);
}

// ---------------------------------------------------------------------------
// [1] + [2] 13 missing + 3 new — 必须全部 seed
// (BLACK_SWAN_DETECT 已在 C-BS-03 批次结构性删除 · 见 30-cleanup-log.md)
// ---------------------------------------------------------------------------
const MISSING_13 = [
  'BLACK_SWAN_BASELINE',
  'BLACK_SWAN_IMPROVEMENT',
  'BLACK_SWAN_POSTMORTEM',
  'BLACK_SWAN_QUARTERLY_SUMMARY',
  'BLACK_SWAN_TIMELINE',
  'DATA_QUALITY_SCAN',
  'DB_BACKUP',
  'EQUITY_CURVE_GOVERNOR_DAILY_EVAL',
  'LIVE_RECONCILIATION_GUARD',
  'RESEARCH_INTEGRITY_BATCH_AUDIT',
  'SYNC_ALL_STOCKS',
  'WEBHOOK_FALLBACK_RETRY',
  'WEEKLY_QA_STAT_AGGREGATE',
];

const NEW_3 = [
  'WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE',
  'DAILY_IMPROVEMENT_EFFECT_TRACK',
  'ETF_FLOW_SYNC',
];

console.log('\n[1] 13 个之前漏 seed 的 cron 必须全部 seed...');
for (const type of MISSING_13) {
  assert(`[1.${type}] seeded`, seededByType.has(type), `not found in defaultTasks`);
}

console.log('\n[2] 3 个本批新增 cron 必须 seed...');
for (const type of NEW_3) {
  assert(`[2.${type}] seeded`, seededByType.has(type), `not found in defaultTasks`);
}

// ---------------------------------------------------------------------------
// [3] cron_expression 与 registry recommendedCron 一致 (LIVE_RECONCILIATION_GUARD 例外)
// ---------------------------------------------------------------------------
console.log('\n[3] seed cron_expression 与 registry recommendedCron 一致...');
const ALL_CHECK = [...MISSING_13, ...NEW_3].filter(t => t !== 'LIVE_RECONCILIATION_GUARD');
for (const type of ALL_CHECK) {
  const def = getCronTaskDefinition(type);
  const rows = seededByType.get(type) || [];
  if (!def || rows.length === 0) continue;
  // 至少 1 个 seed row 的 cron 与 registry.recommendedCron 一致
  // (有的 type 可能只 seed 1 row, recommendedCron 必须命中其中之一)
  if (def.recommendedCron) {
    const match = rows.some(r => r.cron === def.recommendedCron);
    assert(
      `[3.${type}] seed cron='${rows.map(r => r.cron).join('|')}' 含 registry recommended='${def.recommendedCron}'`,
      match
    );
  }
}

// ---------------------------------------------------------------------------
// [4] LIVE_RECONCILIATION_GUARD 必须 seed intraday + eod 两行
// ---------------------------------------------------------------------------
console.log('\n[4] LIVE_RECONCILIATION_GUARD 必须 seed intraday + eod 两行...');
const lrgRows = seededByType.get('LIVE_RECONCILIATION_GUARD') || [];
assert('[4.1] LIVE_RECONCILIATION_GUARD seed >= 2 rows', lrgRows.length >= 2);
assert(
  '[4.2] LIVE_RECONCILIATION_GUARD seed 含 intraday cron 31 10,14,15',
  lrgRows.some(r => r.cron === '31 10,14,15 * * 1-5')
);
assert(
  '[4.3] LIVE_RECONCILIATION_GUARD seed 含 eod cron 1 16',
  lrgRows.some(r => r.cron === '1 16 * * 1-5')
);
assert(
  '[4.4] LIVE_RECONCILIATION_GUARD seed 含 window: intraday 参数',
  /window:\s*'intraday'/.test(SCHEDULER_SRC)
);
assert(
  '[4.5] LIVE_RECONCILIATION_GUARD seed 含 window: eod 参数',
  /window:\s*'eod'/.test(SCHEDULER_SRC)
);

// ---------------------------------------------------------------------------
// [5] reverse drift guard 已写在 dumpActiveTaskSchedule
// ---------------------------------------------------------------------------
console.log('\n[5] reverse drift guard 已写...');
assert(
  '[5.1] dumpActiveTaskSchedule 含 reverse drift warn',
  /cron registry reverse drift/.test(SCHEDULER_SRC)
);
assert(
  '[5.2] reverse drift guard 支持 SCHEDULER_REGISTRY_DRIFT_ALLOW_MISSING env 豁免',
  /SCHEDULER_REGISTRY_DRIFT_ALLOW_MISSING/.test(SCHEDULER_SRC)
);

// ---------------------------------------------------------------------------
// [6] 全 CRON_REGISTRY 漂移 check — 计算 registry 中没 seed 的 type 列表
//     (本环境允许漂移的 type list, 但要打印让 ops 看到)
// ---------------------------------------------------------------------------
console.log('\n[6] CRON_REGISTRY 与 seed 漂移概览 (informational)...');
const allRegistryTypes = CRON_REGISTRY.map(d => d.type);
const seededTypes = new Set(seededByType.keys());
const stillUnseeded = allRegistryTypes.filter(t => !seededTypes.has(t)).sort();
if (stillUnseeded.length > 0) {
  console.log(
    `[6.info] 仍未 seed 的 type (${stillUnseeded.length}): ${stillUnseeded.join(', ')}`
  );
  console.log('         (本批仅承诺补 17 个; 其它历史 type 维持原样, runtime warn 已加)');
}
assertEqual(
  '[6.1] 13 个 macro check 列出的漏 seed type 已全部补齐',
  MISSING_13.filter(t => !seededTypes.has(t)),
  []
);
assertEqual(
  '[6.2] 3 个本批新增 cron 全部 seed',
  NEW_3.filter(t => !seededTypes.has(t)),
  []
);

console.log(`\n[scheduler-default-tasks-completeness] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
