import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('backend/scripts/migrations/2026-07-24-factor-availability.sql');
const replayMigration = read('backend/scripts/migrations/2026-07-24-factor-pit-replay.sql');
const runtime = read('scripts/deployment/runtime_schema_migration.js');
const controller = read('backend/src/api/controllers/BacktestPitController.ts');
const materializer = read('scripts/ops/populate_live_backtest_pit.py');

for (const table of ['factor_scores', 'stock_fundamental_factors', 'stock_valuation_factors']) {
  assert.match(
    migration,
    new RegExp(
      `ALTER TABLE ${table}[\\s\\S]{0,160}ADD COLUMN IF NOT EXISTS available_at_utc TIMESTAMPTZ`
    )
  );
}
assert.match(migration, /SET available_at_utc = COALESCE\(created_at, updated_at, NOW\(\)\)/);
assert.doesNotMatch(migration, /SET available_at_utc\s*=\s*(trade_date|factor_date)/);
assert.match(runtime, /2026-07-24-factor-availability\.sql/);
assert.match(runtime, /2026-07-24-factor-pit-replay\.sql/);
assert.match(
  controller,
  /factorAvailableByTradeDate[\s\S]{0,500}available_at_utc[\s\S]{0,500}historical_pit_replay@1\.0\.0[\s\S]{0,240}pit_replay_as_of_utc/,
  'readiness must count only factors that were available by the historical cutoff'
);
assert.match(
  materializer,
  /available_at_utc[\s\S]{0,160}T15:00:00Z[\s\S]{0,260}historical_pit_replay@1\.0\.0[\s\S]{0,160}pit_replay_as_of_utc/
);
assert.match(replayMigration, /ADD COLUMN IF NOT EXISTS pit_replay_as_of_utc TIMESTAMPTZ/);
assert.match(
  replayMigration,
  /source = 'historical_pit_replay@1\.0\.0'[\s\S]{0,220}pit_replay_as_of_utc <= available_at_utc/,
  'historical replay cutoff must remain separate from and earlier than real ingestion time'
);
assert.match(
  controller,
  /jsonb_each_text\([^)]+source_versions\)[\s\S]{0,180}\(fixture\|synthetic\|mock\|seed\)/,
  'fixture, synthetic, mock and seed provenance must never unlock a visible curve'
);
assert.match(
  controller,
  /daily-bars-close-execution@2\.0\.0[\s\S]{0,180}six-factor-prior-session@2\.0\.0/,
  'CN-A readiness must require the audited execution and prior-session ranking versions'
);

console.log('factor availability schema contract: passed');
