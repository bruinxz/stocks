/**
 * scheduler-weekly-improvement-suggestion.test.ts
 *
 * Macro 串联补丁 (2026-06-21) — WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE cron 三处一致性 +
 * 主入口 generateForUser fail-OPEN 兜底回归.
 *
 * 不依赖 jest / DB / 网络. 直接跑:
 *   cd backend && npx ts-node --transpile-only \
 *     tests/services/scheduler-weekly-improvement-suggestion.test.ts
 *
 * 覆盖维度:
 *   [1] cronRegistry.ts 含 WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE entry + recommendedCron
 *   [2] SchedulerService.ts 含 task.type === 'WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE' 分支
 *       且 lazy-require ImprovementSuggestionService.generateForUser + User model
 *   [3] SchedulerService.ts ensureDefaultTasks 数组 seed 同 type, cron_expression 与 registry
 *       recommendedCron 一致 (反 drift)
 *   [4] ImprovementSuggestionService.generateForUser 三层 fail-OPEN — load throw / no report /
 *       happy path 都不抛
 *
 * 这是反 drift / 反静默断链的 guard — 任何一边的删除 / 拼写漂移 / cron expression 不一致
 * 都会让本测试挂.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  generateForUser,
  IMPROVEMENT_GENERATE_STATUS,
  type ImprovementSuggestionDataSource,
  type ErrorPatternSnapshot,
} from '../../src/services/postmortem/ImprovementSuggestionService';
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
const REGISTRY_SRC = readFileSync(
  join(__dirname, '../../src/constants/cronRegistry.ts'),
  'utf8'
);

const TYPE = 'WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE';
const EXPECTED_CRON = '0 9 * * 2';

// ---------------------------------------------------------------------------
// [1] cronRegistry entry
// ---------------------------------------------------------------------------
console.log('\n[1] cronRegistry.ts 含 WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE entry...');
const def = getCronTaskDefinition(TYPE);
assert('[1.1] getCronTaskDefinition 命中', !!def);
if (def) {
  assertEqual('[1.2] recommendedCron 是周二 09:00', def.recommendedCron, EXPECTED_CRON);
  assert('[1.3] owner 非空', !!def.owner && def.owner.length > 0);
  assert('[1.4] description 含 improvement_suggestions', /improvement_suggestions/.test(def.description));
}
assert(
  '[1.5] CRON_REGISTRY array 含此 type',
  CRON_REGISTRY.some(d => d.type === TYPE)
);

// ---------------------------------------------------------------------------
// [2] SchedulerService dispatch 分支
// ---------------------------------------------------------------------------
console.log('\n[2] SchedulerService.ts 含 dispatch 分支...');
assert(
  `[2.1] 含 task.type === '${TYPE}' 分支`,
  SCHEDULER_SRC.includes(`task.type === '${TYPE}'`)
);
assert(
  '[2.2] dispatch 分支 lazy-require ImprovementSuggestionService',
  /require\(['"]\.\/postmortem\/ImprovementSuggestionService['"]\)/.test(SCHEDULER_SRC)
);
assert(
  '[2.3] dispatch 分支 lazy-require User model',
  /require\(['"]\.\.\/models\/User['"]\)/.test(SCHEDULER_SRC)
);
assert(
  '[2.4] dispatch 分支调用 generateImprovementForUser',
  /generateImprovementForUser\(/.test(SCHEDULER_SRC)
);
assert(
  '[2.5] dispatch 分支 per-user try/catch (fail-OPEN)',
  /service_threw/.test(SCHEDULER_SRC)
);

// ---------------------------------------------------------------------------
// [3] ensureDefaultTasks seed
// ---------------------------------------------------------------------------
console.log('\n[3] ensureDefaultTasks 数组 seed 同 type...');
const seedBlockMatch = SCHEDULER_SRC.match(
  new RegExp(
    `type:\\s*'${TYPE}',\\s*cron_expression:\\s*'([^']+)'`,
    'g'
  )
);
assert('[3.1] seed 块存在 (type + cron_expression)', !!seedBlockMatch && seedBlockMatch.length > 0);
if (seedBlockMatch && seedBlockMatch.length > 0) {
  const cronInSeed = seedBlockMatch[0].match(/cron_expression:\s*'([^']+)'/);
  const cronStr = cronInSeed ? cronInSeed[1] : '';
  assertEqual(`[3.2] seed cron_expression 与 registry recommendedCron 一致`, cronStr, EXPECTED_CRON);
}

// ---------------------------------------------------------------------------
// [4] generateForUser fail-OPEN
// ---------------------------------------------------------------------------
(async () => {
  console.log('\n[4] generateForUser fail-OPEN 三层兜底...');

  // (a) load throw → failed reason='load_threw' 不抛
  const dsThrow: ImprovementSuggestionDataSource = {
    async loadLatestErrorPatternReport() {
      throw new Error('boom-load');
    },
    async bulkUpsertSuggestions() {
      return { ok: true, persisted_count: 0 };
    },
  };
  const r1 = await generateForUser(1, { data_source: dsThrow });
  assertEqual('[4.1] load throw → status=failed', r1.status, IMPROVEMENT_GENERATE_STATUS.FAILED);
  assertEqual('[4.2] load throw → reason=load_threw', r1.reason, 'load_threw');
  assertEqual('[4.3] load throw → persisted_count=0', r1.persisted_count, 0);

  // (b) no report → skipped reason='no_error_pattern'
  const dsNull: ImprovementSuggestionDataSource = {
    async loadLatestErrorPatternReport() {
      return null;
    },
    async bulkUpsertSuggestions() {
      return { ok: true, persisted_count: 0 };
    },
  };
  const r2 = await generateForUser(2, { data_source: dsNull });
  assertEqual('[4.4] no report → status=skipped', r2.status, IMPROVEMENT_GENERATE_STATUS.SKIPPED);
  assertEqual('[4.5] no report → reason=no_error_pattern', r2.reason, 'no_error_pattern');

  // (c) happy path with biases → status=ok, persisted_count>0
  const snapshot: ErrorPatternSnapshot = {
    id: 42,
    user_id: 3,
    period_start: '2026-03-21',
    period_end: '2026-06-19',
    lookback_days: 90,
    patterns: {
      bias_patterns: [
        {
          bias_type: 'overconfidence',
          total_count: 8,
          avg_severity: 0.65,
          weeks_active: 4,
          trending: 'up',
          sample_trades: ['600519', '000001', '300750'],
        },
      ],
      outcome_patterns: [],
      attribution_patterns: [],
      top_findings: [],
    },
    summary: 'ok',
    status: 'ok',
    generated_at: new Date('2026-06-19T10:00:00Z'),
  };
  let upsertCalls = 0;
  const dsHappy: ImprovementSuggestionDataSource = {
    async loadLatestErrorPatternReport() {
      return snapshot;
    },
    async bulkUpsertSuggestions(rows) {
      upsertCalls += 1;
      return { ok: true, persisted_count: rows.length };
    },
  };
  const r3 = await generateForUser(3, { data_source: dsHappy, cron_run_id: 'test_cron_42' });
  assertEqual('[4.6] happy → status=ok', r3.status, IMPROVEMENT_GENERATE_STATUS.OK);
  assert('[4.7] happy → persisted_count>0', r3.persisted_count > 0);
  assertEqual('[4.8] happy → upsert 调 1 次', upsertCalls, 1);
  assertEqual('[4.9] happy → error_pattern_report_id 透传', r3.error_pattern_report_id, 42);
  assert(
    '[4.10] rows[].metadata.cron_run_id 透传',
    r3.rows.every(row => (row.metadata as any).cron_run_id === 'test_cron_42')
  );

  // (d) bulkUpsert ok=false → failed reason='bulk_upsert_failed' 不抛
  const dsUpsertFail: ImprovementSuggestionDataSource = {
    async loadLatestErrorPatternReport() {
      return snapshot;
    },
    async bulkUpsertSuggestions() {
      return { ok: false, persisted_count: 0, reason: 'pg_down' };
    },
  };
  const r4 = await generateForUser(4, { data_source: dsUpsertFail });
  assertEqual('[4.11] upsert fail → status=failed', r4.status, IMPROVEMENT_GENERATE_STATUS.FAILED);
  assertEqual('[4.12] upsert fail → persisted_count=0', r4.persisted_count, 0);
  assertEqual('[4.13] upsert fail → reason 透传', r4.reason, 'pg_down');

  console.log(`\n[scheduler-weekly-improvement-suggestion] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
})().catch(err => {
  console.error('test crashed:', err);
  process.exit(1);
});
