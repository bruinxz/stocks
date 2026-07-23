import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const runtimeSchema = fs.readFileSync(
  path.join(root, 'scripts/deployment/runtime_schema_migration.js'),
  'utf8'
);
const scheduler = fs.readFileSync(
  path.join(root, 'backend/src/services/SchedulerService.ts'),
  'utf8'
);
const eventMigration = fs.readFileSync(
  path.join(root, 'backend/scripts/migrations/2026-06-20-black-swan-events.sql'),
  'utf8'
);

for (const migration of [
  '2026-06-20-black-swan-events.sql',
  '2026-06-20-black-swan-postmortem-reports.sql',
]) {
  assert(runtimeSchema.includes(migration), `runtime schema provisioning must apply ${migration}`);
}

for (const table of ['black_swan_events', 'black_swan_postmortem_reports']) {
  const mentions = runtimeSchema.match(new RegExp(`'${table}'`, 'g')) || [];
  assert(
    mentions.length >= 2,
    `${table} must be part of both runtime and critical schema health checks`
  );
}

for (const taskType of [
  'BLACK_SWAN_POSTMORTEM',
  'BLACK_SWAN_BASELINE',
  'BLACK_SWAN_TIMELINE',
  'BLACK_SWAN_IMPROVEMENT',
]) {
  assert.match(
    scheduler,
    new RegExp(`${taskType} failed:[\\s\\S]{0,120}unknown_error`),
    `${taskType} must throw when its service returns success=false`
  );
}

assert.match(
  eventMigration,
  /detected_at AT TIME ZONE 'Asia\/Shanghai'[\s\S]{0,80}::date/,
  'daily event de-duplication must use an immutable, explicit Shanghai date expression'
);
assert.doesNotMatch(
  eventMigration,
  /\(detected_at::date\)/,
  'TIMESTAMPTZ::date is session-timezone dependent and cannot back an expression index'
);

console.log('black swan runtime schema contract passed');
