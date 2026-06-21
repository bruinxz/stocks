/**
 * scheduler-daily-improvement-effect-track.test.ts
 *
 * Macro 串联补丁 (2026-06-21) — DAILY_IMPROVEMENT_EFFECT_TRACK cron 三处一致性 +
 * trackPendingSuggestions fail-OPEN 兜底回归.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only \
 *     tests/services/scheduler-daily-improvement-effect-track.test.ts
 *
 * 覆盖维度:
 *   [1] cronRegistry.ts 含 DAILY_IMPROVEMENT_EFFECT_TRACK entry + recommendedCron='30 19 * * *'
 *   [2] SchedulerService.ts 含 task.type === 'DAILY_IMPROVEMENT_EFFECT_TRACK' 分支
 *       且 lazy-require ImprovementEffectTracker.trackPendingSuggestions
 *   [3] SchedulerService.ts ensureDefaultTasks 数组 seed 同 type, cron_expression 与 registry 一致
 *   [4] trackPendingSuggestions fail-OPEN (list throw / 单条 throw / writeBack ok=false 都不抛)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  trackPendingSuggestions,
  TRACK_STATUS,
  EFFECT_METRICS_SOURCE,
  type ImprovementEffectTrackerDataSource,
} from '../../src/services/postmortem/ImprovementEffectTracker';
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

const TYPE = 'DAILY_IMPROVEMENT_EFFECT_TRACK';
const EXPECTED_CRON = '30 19 * * *';

// ---------------------------------------------------------------------------
// [1] cronRegistry
// ---------------------------------------------------------------------------
console.log('\n[1] cronRegistry.ts 含 DAILY_IMPROVEMENT_EFFECT_TRACK entry...');
const def = getCronTaskDefinition(TYPE);
assert('[1.1] getCronTaskDefinition 命中', !!def);
if (def) {
  assertEqual('[1.2] recommendedCron 是每日 19:30', def.recommendedCron, EXPECTED_CRON);
  assert('[1.3] description 含 effect_metrics', /effect_metrics/.test(def.description));
}
assert(
  '[1.4] CRON_REGISTRY array 含此 type',
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
  '[2.2] dispatch 分支 lazy-require ImprovementEffectTracker',
  /require\(['"]\.\/postmortem\/ImprovementEffectTracker['"]\)/.test(SCHEDULER_SRC)
);
assert(
  '[2.3] dispatch 分支调用 trackPendingSuggestions',
  /trackPendingSuggestions\(/.test(SCHEDULER_SRC)
);
assert(
  '[2.4] dispatch 分支传入 PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE',
  /PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE/.test(SCHEDULER_SRC)
);
assert(
  '[2.5] dispatch 分支透传 dry_run',
  /dryRunTrack/.test(SCHEDULER_SRC)
);

// ---------------------------------------------------------------------------
// [3] ensureDefaultTasks seed
// ---------------------------------------------------------------------------
console.log('\n[3] ensureDefaultTasks 数组 seed 同 type...');
const seedBlockMatch = SCHEDULER_SRC.match(
  new RegExp(`type:\\s*'${TYPE}',\\s*cron_expression:\\s*'([^']+)'`, 'g')
);
assert('[3.1] seed 块存在', !!seedBlockMatch && seedBlockMatch.length > 0);
if (seedBlockMatch && seedBlockMatch.length > 0) {
  const cronInSeed = seedBlockMatch[0].match(/cron_expression:\s*'([^']+)'/);
  const cronStr = cronInSeed ? cronInSeed[1] : '';
  assertEqual('[3.2] seed cron_expression 与 registry 一致', cronStr, EXPECTED_CRON);
}

// ---------------------------------------------------------------------------
// [4] trackPendingSuggestions fail-OPEN
// ---------------------------------------------------------------------------
(async () => {
  console.log('\n[4] trackPendingSuggestions fail-OPEN...');

  // (a) list throw → 返 summary reason='list_threw' 不抛
  const dsListThrow: ImprovementEffectTrackerDataSource = {
    async listPendingApplied() {
      throw new Error('boom-list');
    },
    async listUserPortfolios() {
      return [];
    },
    async loadAttributionReports() {
      return [];
    },
    async writeBackMetrics() {
      return { ok: true };
    },
  };
  const r1 = await trackPendingSuggestions({ data_source: dsListThrow });
  assertEqual('[4.1] list throw → reason=list_threw', r1.reason, 'list_threw');
  assertEqual('[4.2] list throw → total_candidates=0', r1.total_candidates, 0);

  // (b) 0 candidates → ok summary
  const dsEmpty: ImprovementEffectTrackerDataSource = {
    async listPendingApplied() {
      return [];
    },
    async listUserPortfolios() {
      return [];
    },
    async loadAttributionReports() {
      return [];
    },
    async writeBackMetrics() {
      return { ok: true };
    },
  };
  const r2 = await trackPendingSuggestions({ data_source: dsEmpty });
  assertEqual('[4.3] 空 candidates → total_candidates=0', r2.total_candidates, 0);
  assertEqual('[4.4] 空 candidates → ok_count=0', r2.ok_count, 0);
  assertEqual('[4.5] 空 candidates → failed_count=0', r2.failed_count, 0);

  // (c) happy path — 1 candidate with portfolio rows → ok + persisted
  const writeBackCalls: any[] = [];
  const dsHappy: ImprovementEffectTrackerDataSource = {
    async listPendingApplied() {
      return [
        {
          id: 1,
          user_id: 100,
          period_end: '2026-05-01',
          category: 'bias',
          key: 'overconfidence',
          applied_at: new Date('2026-05-15T10:00:00Z'),
          effect_tracked_at: null,
        },
      ];
    },
    async listUserPortfolios() {
      return [10];
    },
    async loadAttributionReports() {
      return [
        { portfolio_id: 10, date: '2026-05-15', total_pnl: 100, total_pnl_pct: 1.0, trade_count: 2 },
        { portfolio_id: 10, date: '2026-05-16', total_pnl: 50, total_pnl_pct: 0.5, trade_count: 1 },
      ];
    },
    async writeBackMetrics(input) {
      writeBackCalls.push(input);
      return { ok: true };
    },
  };
  const r3 = await trackPendingSuggestions({
    data_source: dsHappy,
    now: new Date('2026-06-21T19:30:00Z'),
  });
  assertEqual('[4.6] happy → total_candidates=1', r3.total_candidates, 1);
  assertEqual('[4.7] happy → ok_count=1', r3.ok_count, 1);
  assertEqual('[4.8] happy → persisted_count=1', r3.persisted_count, 1);
  assertEqual('[4.9] writeBack 调 1 次', writeBackCalls.length, 1);
  assert('[4.10] writeBack input 含 effect_metrics', !!writeBackCalls[0].effect_metrics);
  assertEqual(
    '[4.11] writeBack source = TRACKER_CRON',
    writeBackCalls[0].effect_metrics.source,
    EFFECT_METRICS_SOURCE.TRACKER_CRON
  );

  // (d) dry_run=true → 不调 writeBack, persisted=0
  writeBackCalls.length = 0;
  const r4 = await trackPendingSuggestions({
    data_source: dsHappy,
    now: new Date('2026-06-21T19:30:00Z'),
    dry_run: true,
  });
  assertEqual('[4.12] dry_run → persisted_count=0', r4.persisted_count, 0);
  assertEqual('[4.13] dry_run → writeBack 不调', writeBackCalls.length, 0);
  assert('[4.14] dry_run=true 透传到 summary', r4.dry_run === true);

  // (e) writeBack ok=false → status=failed 不抛
  const dsWriteFail: ImprovementEffectTrackerDataSource = {
    async listPendingApplied() {
      return [
        {
          id: 2,
          user_id: 101,
          period_end: '2026-05-01',
          category: 'outcome',
          key: 'stop_loss_miss',
          applied_at: new Date('2026-05-15T10:00:00Z'),
          effect_tracked_at: null,
        },
      ];
    },
    async listUserPortfolios() {
      return [11];
    },
    async loadAttributionReports() {
      return [
        { portfolio_id: 11, date: '2026-05-15', total_pnl: 50, total_pnl_pct: 0.5, trade_count: 1 },
      ];
    },
    async writeBackMetrics() {
      return { ok: false, reason: 'pg_down' };
    },
  };
  const r5 = await trackPendingSuggestions({
    data_source: dsWriteFail,
    now: new Date('2026-06-21T19:30:00Z'),
  });
  assertEqual('[4.15] writeBack fail → failed_count=1', r5.failed_count, 1);
  assertEqual('[4.16] writeBack fail → persisted_count=0', r5.persisted_count, 0);
  const failedRow = r5.per_suggestion.find(s => s.status === TRACK_STATUS.FAILED);
  assert('[4.17] writeBack fail → 单条 status=failed', !!failedRow);

  console.log(`\n[scheduler-daily-improvement-effect-track] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
})().catch(err => {
  console.error('test crashed:', err);
  process.exit(1);
});
