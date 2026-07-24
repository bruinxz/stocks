import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const index = read('backend/src/index.ts');
const scheduler = read('backend/src/services/SchedulerService.ts');
const runtime = read('scripts/deployment/runtime_schema_migration.js');
const health = read('scripts/tests/runtime_schema_health_check.js');
const marketNewsMigration = read('backend/scripts/migrations/2026-07-24-market-news.sql');
const feedbackMigration = read('backend/scripts/migrations/2026-06-21-user-feedbacks.sql');

for (const [table, model] of [
  ['market_news', 'MarketNews'],
  ['user_feedbacks', 'UserFeedback'],
] as const) {
  assert.match(
    index,
    new RegExp(`\\{ model: ${model}, label: '${model}' \\}`),
    `${table} must use the independent startup runtime sync path`
  );
  assert.match(runtime, new RegExp(`'${table}'`), `${table} must be deployment-verified`);
  assert.match(health, new RegExp(`'${table}'`), `${table} must be checked by runtime health`);
}

assert.match(runtime, /2026-07-24-market-news\.sql/);
assert.match(runtime, /2026-06-21-user-feedbacks\.sql/);
assert.match(marketNewsMigration, /CREATE TABLE IF NOT EXISTS market_news/);
assert.match(marketNewsMigration, /PRIMARY KEY \(title_hash, publish_time\)/);
assert.match(marketNewsMigration, /market_news_publish_date_source/);
assert.match(feedbackMigration, /CREATE TABLE IF NOT EXISTS user_feedbacks/);
assert.match(feedbackMigration, /REFERENCES users\(id\) ON DELETE CASCADE/);
assert.match(feedbackMigration, /idx_user_feedbacks_status_reviewed/);
assert.match(
  scheduler,
  /const feedbackFailed =[\s\S]{0,500}status: feedbackFailed \? 'FAILED' : 'COMPLETED'[\s\S]{0,1000}if \(feedbackFailed\)[\s\S]{0,120}throw new Error/,
  'feedback query or row failures must fail the scheduled task'
);
assert.match(scheduler, /const writeFailures =/, 'RSS persistence gaps must be counted');
assert.match(
  scheduler,
  /status: rssFailed \? 'FAILED' : 'COMPLETED'/,
  'incomplete RSS runs must be recorded as failed'
);
assert.match(
  scheduler,
  /if \(rssFailed\) throw new Error/,
  'incomplete RSS runs must reach the scheduler failure exit'
);

console.log('operational feed runtime schema contract tests passed');
