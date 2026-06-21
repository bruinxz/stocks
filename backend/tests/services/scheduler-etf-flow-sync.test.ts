/**
 * scheduler-etf-flow-sync.test.ts
 *
 * Macro 串联补丁 (2026-06-21) — ETF_FLOW_SYNC cron 三处一致性 (registry / dispatch / seed).
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only \
 *     tests/services/scheduler-etf-flow-sync.test.ts
 *
 * 覆盖维度:
 *   [1] cronRegistry.ts 含 ETF_FLOW_SYNC entry, recommendedCron='0 18 * * 1-5'
 *   [2] SchedulerService.ts 含 task.type === 'ETF_FLOW_SYNC' 分支 + lazy-require ETFFlowSyncService
 *   [3] ensureDefaultTasks 数组 seed 同 type, cron_expression 与 registry 一致
 *   [4] CLI backend/src/scripts/sync-etf-flow.ts 与 cron 共享同款 ETFFlowSyncService.syncDate
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getCronTaskDefinition, CRON_REGISTRY } from '../../src/constants/cronRegistry';

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
const CLI_PATH = join(__dirname, '../../src/scripts/sync-etf-flow.ts');
const SERVICE_PATH = join(__dirname, '../../src/data/services/ETFFlowSyncService.ts');

const TYPE = 'ETF_FLOW_SYNC';
const EXPECTED_CRON = '0 18 * * 1-5';

// [1] registry
console.log('\n[1] cronRegistry.ts 含 ETF_FLOW_SYNC entry...');
const def = getCronTaskDefinition(TYPE);
assert('[1.1] getCronTaskDefinition 命中', !!def);
if (def) {
  assertEqual('[1.2] recommendedCron 工作日 18:00', def.recommendedCron, EXPECTED_CRON);
  assertEqual('[1.3] category=data_sync', def.category, 'data_sync');
}
assert('[1.4] CRON_REGISTRY array 含', CRON_REGISTRY.some(d => d.type === TYPE));

// [2] dispatch
console.log('\n[2] SchedulerService.ts 含 dispatch 分支...');
assert(
  `[2.1] 含 task.type === '${TYPE}'`,
  SCHEDULER_SRC.includes(`task.type === '${TYPE}'`)
);
assert(
  '[2.2] lazy-require ETFFlowSyncService',
  /require\(['"]\.\.\/data\/services\/ETFFlowSyncService['"]\)/.test(SCHEDULER_SRC)
);
assert(
  '[2.3] 调用 etfSvc.syncDate',
  /etfSvc\.syncDate\(/.test(SCHEDULER_SRC)
);

// [3] seed
console.log('\n[3] ensureDefaultTasks 数组 seed 同 type...');
const seedBlock = SCHEDULER_SRC.match(
  new RegExp(`type:\\s*'${TYPE}',\\s*cron_expression:\\s*'([^']+)'`, 'g')
);
assert('[3.1] seed 块存在', !!seedBlock && seedBlock.length > 0);
if (seedBlock && seedBlock.length > 0) {
  const cronInSeed = seedBlock[0].match(/cron_expression:\s*'([^']+)'/);
  const cronStr = cronInSeed ? cronInSeed[1] : '';
  assertEqual('[3.2] seed cron_expression 与 registry 一致', cronStr, EXPECTED_CRON);
}

// [4] CLI + cron 共享 ETFFlowSyncService
console.log('\n[4] CLI + cron 共享 ETFFlowSyncService.syncDate...');
assert('[4.1] CLI 文件存在', existsSync(CLI_PATH));
assert('[4.2] Service 文件存在', existsSync(SERVICE_PATH));
const cliSrc = readFileSync(CLI_PATH, 'utf8');
const serviceSrc = readFileSync(SERVICE_PATH, 'utf8');
assert('[4.3] CLI import ETFFlowSyncService', /ETFFlowSyncService/.test(cliSrc));
assert('[4.4] Service export class ETFFlowSyncService', /export class ETFFlowSyncService/.test(serviceSrc));
assert('[4.5] Service 实现 syncDate', /async syncDate\(/.test(serviceSrc));

console.log(`\n[scheduler-etf-flow-sync] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
