import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const runtimeSchema = fs.readFileSync(
  path.join(root, 'scripts/deployment/runtime_schema_migration.js'),
  'utf8'
);
const runtimeHealth = fs.readFileSync(
  path.join(root, 'scripts/tests/runtime_schema_health_check.js'),
  'utf8'
);
const runtimeTables = fs.readFileSync(
  path.join(root, 'backend/src/constants/runtimeSchemaTables.ts'),
  'utf8'
);
const scheduler = fs.readFileSync(
  path.join(root, 'backend/src/services/SchedulerService.ts'),
  'utf8'
);
const attributionService = fs.readFileSync(
  path.join(root, 'backend/src/services/attribution/DailyAttributionService.ts'),
  'utf8'
);

assert(
  runtimeSchema.includes('2026-06-23-daily-attribution-reports.sql'),
  'runtime schema provisioning must apply the daily attribution migration'
);

for (const source of [runtimeSchema, runtimeHealth, runtimeTables]) {
  const mentions = source.match(/'daily_attribution_reports'/g) || [];
  assert(
    mentions.length >= 2,
    'daily_attribution_reports must be part of runtime and critical schema checks'
  );
}

assert.match(
  scheduler,
  /const attributionFailed = attrSummary\.failed_count > 0[\s\S]{0,700}status: attributionFailed \? 'FAILED' : 'COMPLETED'/,
  'daily attribution execution log must be FAILED when any portfolio cannot persist'
);
assert.match(
  scheduler,
  /if \(attributionFailed\) \{[\s\S]{0,160}throw new Error/,
  'daily attribution failures must reach the scheduler task status'
);
assert.match(
  scheduler,
  /PAPER_TRADING_DAILY_SNAPSHOT[\s\S]{0,1800}status: failed > 0 \? 'FAILED' : 'COMPLETED'[\s\S]{0,700}throw new Error/,
  'the required 16:00 snapshot task must also fail visibly'
);
assert.match(
  scheduler,
  /PAPER_TRADING_DAILY_SNAPSHOT[\s\S]{0,2600}syncQuotesForSymbols\(closeSymbols[\s\S]{0,1600}14 \* 60 \+ 59[\s\S]{0,1000}收盘行情未到齐/,
  'daily snapshots must refresh and verify true closing quotes instead of reusing the 14:55 cache'
);
assert.match(
  attributionService,
  /Date\.now\(\) \+ 8 \* 60 \* 60 \* 1000/,
  'manual attribution runs must use the Shanghai date instead of the UTC date'
);

console.log('daily attribution runtime schema contract passed');
