import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const scheduler = fs.readFileSync(
  path.join(root, 'backend/src/services/SchedulerService.ts'),
  'utf8'
);
const registry = fs.readFileSync(
  path.join(root, 'backend/src/constants/cronRegistry.ts'),
  'utf8'
);
const routes = fs.readFileSync(path.join(root, 'backend/src/api/routes/data.routes.ts'), 'utf8');
const globalSync = fs.readFileSync(
  path.join(root, 'scripts/ops/sync_global_markets_daily.py'),
  'utf8'
);
const dailyReport = fs.readFileSync(
  path.join(root, 'frontend/src/pages/catdesk/tabs/daily-report/DailyReportContainer.tsx'),
  'utf8'
);
const dataSync = fs.readFileSync(
  path.join(root, 'backend/src/data/services/DataSyncService.ts'),
  'utf8'
);
const akshareClient = fs.readFileSync(
  path.join(root, 'backend/src/data/sources/AKShareClient.ts'),
  'utf8'
);
const combinedDataSource = fs.readFileSync(
  path.join(root, 'backend/src/data/sources/CombinedDataSource.ts'),
  'utf8'
);
const backfill = fs.readFileSync(
  path.join(root, 'backend/src/scripts/backfill-missing-bars.ts'),
  'utf8'
);
const pitWriter = fs.readFileSync(
  path.join(root, 'datapipeline/storage/backtest_pit/writer.py'),
  'utf8'
);
const liveRecommendations = fs.readFileSync(
  path.join(root, 'scripts/ops/populate_live_recommendations.py'),
  'utf8'
);

assert.match(
  scheduler,
  /type:\s*'REALTIME_QUOTE_SYNC'[\s\S]{0,180}cron_expression:\s*'\*\/5 9-11,13-14 \* \* 1-5'/,
  'A-share realtime sync must be seeded at five-minute cadence'
);
assert.match(
  scheduler,
  /task\.type === 'REALTIME_QUOTE_SYNC'[\s\S]{0,240}checkAShareTradingHours/,
  'five-minute cron must retain a continuous-session guard'
);
assert.match(
  registry,
  /type:\s*'GLOBAL_MARKET_DAILY_SYNC'[\s\S]{0,180}recommendedCron:\s*'0 9 \* \* 1-5'/,
  'global catalyst refresh must be registered at 09:00 Asia/Shanghai'
);
assert.match(
  scheduler,
  /CATCH_UP_WHITELIST[\s\S]{0,260}'GLOBAL_MARKET_DAILY_SYNC'/,
  '09:00 global refresh must catch up after a missed server window'
);
assert.match(
  globalSync,
  /for market_scope in \("cn_a", "us", "jp"\)/,
  'global refresh must generate A-share, US and JP snapshots'
);
assert.match(routes, /'\/page-freshness'.*authenticate/, 'page freshness route must be protected');
assert.match(
  dailyReport,
  /profile:\s*'us_preferred'[\s\S]{0,80}marketScope:\s*'cn_a'/,
  'daily report must default to the detailed A-share scope'
);
assert.match(
  scheduler,
  /RETIRED_LEGACY_TASK_TYPES = new Set\(\['BLACK_SWAN_DETECT'\]\)/,
  'obsolete black-swan type must remain outside the active cron registry'
);
assert.match(
  scheduler,
  /RETIRED_LEGACY_TASK_TYPES\.has\(task\.type\)[\s\S]{0,1000}skipRetiredScheduledTask/,
  'obsolete black-swan cron rows must self-retire instead of flooding logs'
);
assert.match(
  dataSync,
  /safeParseDate\(dateValue: unknown\)[\s\S]{0,900}String\(dateValue\)\.trim\(\)/,
  'stock dates must normalize numeric and Date inputs before string operations'
);
assert.match(
  akshareClient,
  /AKSHARE_HISTORY_TIMEOUT_MS[\s\S]{0,80}30000/,
  'AKShare history calls must have a bounded production timeout'
);
assert.doesNotMatch(
  combinedDataSource,
  /KNOWN_DELISTED_SYMBOLS/,
  'active symbols must not be suppressed by a static delisting blacklist'
);
assert.match(
  backfill,
  /\.option\('--provider <name>'/,
  'targeted history repair must expose provider selection'
);
assert.match(
  backfill,
  /syncStockHistory\([\s\S]{0,180}provider/,
  'targeted history repair must forward provider selection'
);
assert.match(
  pitWriter,
  /validation_profile == "rolling_production"[\s\S]{0,900}production-daily-bars-calendar@/,
  'PIT storage must validate rolling production windows separately from frozen fixtures'
);
assert.match(
  liveRecommendations,
  /"snapshot-v4"[\s\S]{0,180}as_of[\s\S]{0,1000}_prune_superseded_snapshots/,
  'daily recommendation reruns must use unique identities and prune only after success'
);

console.log('data refresh contract: 16 assertions passed');
