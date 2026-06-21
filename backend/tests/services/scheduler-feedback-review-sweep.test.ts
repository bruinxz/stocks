/**
 * scheduler-feedback-review-sweep.test.ts (Batch AL 2026-06-21)
 *
 * FEEDBACK_REVIEW_SWEEP cron 三处一致性 (registry / dispatch / seed) + service hook.
 *
 *   cd backend && npx ts-node --transpile-only \
 *     tests/services/scheduler-feedback-review-sweep.test.ts
 *
 * 覆盖:
 *   [1] cronRegistry.ts 含 FEEDBACK_REVIEW_SWEEP entry, recommendedCron='*\/30 * * * *', category='analytics'
 *   [2] SchedulerService.ts 含 task.type === 'FEEDBACK_REVIEW_SWEEP' 分支 + lazy-require UserFeedbackService
 *   [3] ensureDefaultTasks 数组 seed 同 type, cron_expression='*\/30 * * * *', is_active=true
 *   [4] UserFeedbackService export PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP entry
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
const SERVICE_PATH = join(__dirname, '../../src/services/UserFeedbackService.ts');

const TYPE = 'FEEDBACK_REVIEW_SWEEP';
const EXPECTED_CRON = '*/30 * * * *';

// [1] registry
console.log('\n[1] cronRegistry.ts 含 FEEDBACK_REVIEW_SWEEP entry...');
const def = getCronTaskDefinition(TYPE);
assert('[1.1] getCronTaskDefinition 命中', !!def);
if (def) {
  assertEqual('[1.2] recommendedCron 每 30 分钟', def.recommendedCron, EXPECTED_CRON);
  assertEqual('[1.3] category=analytics', def.category, 'analytics');
}
assert('[1.4] CRON_REGISTRY array 含', CRON_REGISTRY.some(d => d.type === TYPE));

// [2] dispatch
console.log('\n[2] SchedulerService.ts 含 dispatch 分支...');
assert(
  `[2.1] 含 task.type === '${TYPE}'`,
  SCHEDULER_SRC.includes(`task.type === '${TYPE}'`)
);
assert(
  '[2.2] lazy-require UserFeedbackService',
  /require\(['"]\.\/UserFeedbackService['"]\)/.test(SCHEDULER_SRC)
);
assert(
  '[2.3] 调用 PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP',
  /PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP/.test(SCHEDULER_SRC)
);

// [3] seed
console.log('\n[3] ensureDefaultTasks 数组 seed 同 type...');
const seedRe = new RegExp(`type:\\s*'${TYPE}',\\s*cron_expression:\\s*'([^']+)'`, 'g');
const seedBlocks = SCHEDULER_SRC.match(seedRe);
assert('[3.1] seed 块存在', !!seedBlocks && seedBlocks.length > 0);
if (seedBlocks && seedBlocks.length > 0) {
  const cronInSeed = seedBlocks[0].match(/cron_expression:\s*'([^']+)'/);
  const cronStr = cronInSeed ? cronInSeed[1] : '';
  assertEqual('[3.2] seed cron_expression = */30 * * * *', cronStr, EXPECTED_CRON);
}

// [4] service hook
console.log('\n[4] UserFeedbackService export PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP...');
assert('[4.1] Service 文件存在', existsSync(SERVICE_PATH));
const serviceSrc = readFileSync(SERVICE_PATH, 'utf8');
assert(
  '[4.2] export const PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP',
  /export const PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP/.test(serviceSrc)
);
assert(
  '[4.3] export class UserFeedbackService',
  /export class UserFeedbackService/.test(serviceSrc)
);
assert(
  '[4.4] runReviewSweep method 存在',
  /async runReviewSweep\(/.test(serviceSrc)
);
assert(
  '[4.5] classifyFeedbackHeuristic 是 pure 函数 (export)',
  /export function classifyFeedbackHeuristic\(/.test(serviceSrc)
);

console.log(`\n[scheduler-feedback-review-sweep] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
