import { readFileSync } from 'fs';
import { join } from 'path';
import { CRON_REGISTRY } from '../../src/constants/cronRegistry';
import { skipRetiredScheduledTask } from '../../src/services/scheduler/retiredScheduledTask';

const RETIRED_TYPE = 'PAPER_TRADING_RESTRICTED_SHARE_CHECK';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? ` detail=${detail}` : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  assert(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
  );
}

async function run(): Promise<void> {
  console.log('\n[1] persisted legacy task is skipped and deactivated...');
  const taskUpdates: Array<Record<string, unknown>> = [];
  const logUpdates: Array<Record<string, unknown>> = [];
  const metricCalls: Array<[string, string, number]> = [];
  let deactivated = 0;
  const completedAt = new Date('2026-07-15T00:00:00.000Z');

  const result = await skipRetiredScheduledTask({
    task: {
      id: 89,
      name: 'legacy restricted-share check',
      type: RETIRED_TYPE,
      update: async patch => {
        taskUpdates.push(patch);
      },
    },
    execution_log: {
      update: async patch => {
        logUpdates.push(patch);
      },
    },
    reason: 'RestrictedShareWatchdog has been retired',
    metric_started_at_ms: Date.now(),
    record_metric: (type, status, duration) => metricCalls.push([type, status, duration]),
    deactivate_in_memory: () => {
      deactivated += 1;
    },
    now: () => completedAt,
  });

  assertEqual('controlled result is successful skip', result, {
    success: true,
    skipped: true,
    message: `skipped: retired task ${RETIRED_TYPE}`,
  });
  assertEqual('task is marked SKIPPED and inactive', taskUpdates, [
    { last_run_status: 'SKIPPED', is_active: false },
  ]);
  assert('execution log is marked SKIPPED', logUpdates[0]?.status === 'SKIPPED');
  assert('execution log has completion timestamp', logUpdates[0]?.completed_at === completedAt);
  assert(
    'execution log identifies retired task',
    (logUpdates[0]?.result_summary as any)?.retired === true &&
      (logUpdates[0]?.result_summary as any)?.task_type === RETIRED_TYPE
  );
  assertEqual('in-memory cron is deactivated once', deactivated, 1);
  assert(
    'metric records skipped instead of success',
    metricCalls.length === 1 &&
      metricCalls[0][0] === RETIRED_TYPE &&
      metricCalls[0][1] === 'skipped' &&
      metricCalls[0][2] >= 0
  );

  console.log('\n[2] execution-log failure still deactivates the task...');
  const fallbackTaskUpdates: Array<Record<string, unknown>> = [];
  const fallbackMetricCalls: string[] = [];
  const warnings: string[] = [];
  let fallbackDeactivated = 0;

  await skipRetiredScheduledTask({
    task: {
      id: 90,
      name: 'legacy restricted-share check with broken log',
      type: RETIRED_TYPE,
      update: async patch => {
        fallbackTaskUpdates.push(patch);
      },
    },
    execution_log: {
      update: async () => {
        throw new Error('log table unavailable');
      },
    },
    reason: 'RestrictedShareWatchdog has been retired',
    metric_started_at_ms: Date.now(),
    record_metric: (_type, status) => fallbackMetricCalls.push(status),
    deactivate_in_memory: () => {
      fallbackDeactivated += 1;
    },
    warn: message => warnings.push(message),
  });

  assertEqual('broken log does not block DB deactivation', fallbackTaskUpdates, [
    { last_run_status: 'SKIPPED', is_active: false },
  ]);
  assertEqual('broken log does not block in-memory deactivation', fallbackDeactivated, 1);
  assertEqual('broken log still records skipped metric', fallbackMetricCalls, ['skipped']);
  assert(
    'broken log emits a bounded warning',
    warnings.length === 1 && warnings[0].includes('execution log update failed')
  );

  console.log('\n[3] Scheduler dispatch retires before calendar handling and early-returns...');
  const schedulerPath = join(__dirname, '../../src/services/SchedulerService.ts');
  const schedulerSource = readFileSync(schedulerPath, 'utf8');
  const branchLiteral = `task.type === '${RETIRED_TYPE}'`;
  const branchIndex = schedulerSource.indexOf(branchLiteral);
  const calendarIndex = schedulerSource.indexOf('if (!isManual && requireTradingDay)');
  assert('retired dispatch literal remains for registry guard', branchIndex >= 0);
  assert(
    'retired dispatch executes before trading-calendar success path',
    branchIndex >= 0 && calendarIndex >= 0 && branchIndex < calendarIndex
  );
  const earlyBranch = schedulerSource.slice(branchIndex, calendarIndex);
  assert(
    'retired dispatch directly returns helper result',
    /return await skipRetiredScheduledTask\s*\(/.test(earlyBranch)
  );
  assert(
    'removed watchdog implementation is never referenced',
    !schedulerSource.includes('restrictedShareWatchdog')
  );
  assertEqual(
    'only one retired dispatch literal remains',
    schedulerSource.split(branchLiteral).length - 1,
    1
  );

  console.log('\n[4] new installations do not seed the retired task...');
  const ensureDefaultsIndex = schedulerSource.indexOf('async ensureDefaultTasks()');
  assert('ensureDefaultTasks source exists', ensureDefaultsIndex >= 0);
  const ensureDefaultsSource = schedulerSource.slice(ensureDefaultsIndex);
  assert(
    'retired type is absent from ensureDefaultTasks',
    !ensureDefaultsSource.includes(RETIRED_TYPE)
  );

  console.log('\n[5] cron registry keeps an explicit tombstone...');
  const tombstone = CRON_REGISTRY.find(item => item.type === RETIRED_TYPE);
  assert('registry tombstone exists', Boolean(tombstone));
  assert('registry tombstone is retired', tombstone?.retired === true);
  assert('registry description starts with [已下线]', tombstone?.description.startsWith('[已下线]') === true);

  console.log('\n[6] migration only disables active rows of the retired type...');
  const migrationPath = join(
    __dirname,
    '../../scripts/migrations/2026-07-15-retire-restricted-share-watchdog.sql'
  );
  const migration = readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').trim();
  assertEqual(
    'migration is the single idempotent targeted UPDATE',
    migration,
    "UPDATE scheduled_tasks SET is_active = false, updated_at = NOW() WHERE type = 'PAPER_TRADING_RESTRICTED_SHARE_CHECK' AND is_active = true;"
  );

  console.log(`\n[scheduler-restricted-share-retirement] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
