import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const scheduler = fs.readFileSync(
  path.join(root, 'backend/src/services/SchedulerService.ts'),
  'utf8'
);
const registry = fs.readFileSync(path.join(root, 'backend/src/constants/cronRegistry.ts'), 'utf8');
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
const quantDataService = fs.readFileSync(
  path.join(root, 'backend/src/quant/engine/internal/QuantDataService.ts'),
  'utf8'
);
const dataUpdateWorker = fs.readFileSync(
  path.join(root, 'backend/src/jobs/dataUpdateWorker.ts'),
  'utf8'
);
const pageFreshness = fs.readFileSync(
  path.join(root, 'backend/src/services/PageFreshnessService.ts'),
  'utf8'
);
const realtimeDedupMigration = fs.readFileSync(
  path.join(root, 'backend/scripts/migrations/2026-07-17-realtime-quote-dedup.sql'),
  'utf8'
);
const freshnessAudit = fs.readFileSync(
  path.join(root, 'scripts/tests/quant_data_freshness_check.js'),
  'utf8'
);
const stockFactorService = fs.readFileSync(
  path.join(root, 'backend/src/data/services/StockFactorService.ts'),
  'utf8'
);
const derivedFactorCli = fs.readFileSync(
  path.join(root, 'backend/src/scripts/sync-derived-factors.ts'),
  'utf8'
);
const readonlySmoke = fs.readFileSync(
  path.join(root, 'scripts/tests/smoke_readonly_core.js'),
  'utf8'
);
const retiredBaostockFactorTask = fs.readFileSync(
  path.join(root, 'backend/scripts/migrations/2026-07-17-retire-legacy-baostock-factor-sync.sql'),
  'utf8'
);

assert.match(
  scheduler,
  /type:\s*'REALTIME_QUOTE_SYNC'[\s\S]{0,180}cron_expression:\s*'\*\/5 9-11,13-14 \* \* 1-5'/,
  'A-share realtime sync must be seeded at five-minute cadence'
);
assert.match(
  scheduler,
  /taskData\.type === 'DAILY_UPDATE'[\s\S]{0,260}max_stocks:\s*6000/,
  'existing daily-update tasks must be upgraded to full-market coverage'
);
assert.match(
  scheduler,
  /taskData\.name === '全量股票日线同步'[\s\S]{0,700}batch_limit = 6000/,
  'history repair must not inherit the legacy 300-symbol ceiling'
);
assert.match(
  scheduler,
  /task\.type === 'REALTIME_QUOTE_SYNC'[\s\S]{0,3500}include_all_instruments:\s*universe === 'market'/,
  'realtime market refresh must include stocks, indexes and ETFs'
);
assert.match(
  quantDataService,
  /include_all_instruments\?: boolean[\s\S]{0,1000}Math\.min\(Number\(options\.limit \|\| 120\), 6000\)/,
  'market data service must allow the complete listed-instrument universe'
);
assert.match(
  dataUpdateWorker,
  /max_stocks = 6000/,
  'daily update worker fallback must cover the complete listed universe'
);
assert.match(
  dataUpdateWorker,
  /status: dailyFailCount > 0 \? UpdateStatus\.FAILED : UpdateStatus\.COMPLETED[\s\S]{0,500}任务拒绝标记完成/,
  'partial daily-update failures must not be recorded as completed'
);
assert.match(
  dataUpdateWorker,
  /status: failedSyncs > 0 \? UpdateStatus\.FAILED : UpdateStatus\.COMPLETED[\s\S]{0,500}历史行情回补存在/,
  'partial history-repair failures must not be recorded as completed'
);
assert.match(
  pageFreshness,
  /'market'::text[\s\S]{0,420}'daily_bars'::text AS source/,
  'A-share page timestamp must follow the daily-bars source actually rendered by the page'
);
assert.match(
  realtimeDedupMigration,
  /LOCK TABLE realtime_quotes[\s\S]{0,700}PARTITION BY symbol, quote_time[\s\S]{0,700}CREATE UNIQUE INDEX uniq_realtime_quote_symbol_time/,
  'realtime quote cleanup must deduplicate under a lock before enforcing the natural key'
);
assert.match(
  pageFreshness,
  /'jpkr'[\s\S]{0,180}MIN\(latest_day\)[\s\S]{0,280}market_scope IN \('jp', 'kr'\)/,
  'JP/KR page timestamp must expose the slower market watermark'
);
assert.match(
  pageFreshness,
  /expectedCompletedTradeDate[\s\S]{0,700}latestTradeDateOnOrBefore/,
  'page freshness must compare against an expected completed A-share trade date'
);
assert.match(
  freshnessAudit,
  /resolveExpectedCompletedTradeDate[\s\S]{0,1800}isAShareTradeDay[\s\S]{0,900}hour >= 17[\s\S]{0,900}latestTradeDateOnOrBefore/,
  'production freshness audit must not treat partial intraday bars as a completed trade date'
);
assert.match(
  stockFactorService,
  /targetFactorDate = String\(options\.as_of \|\| coverage\.latest_trade_date[\s\S]{0,700}factorCoverageIsCurrent[\s\S]{0,350}targetFactorDate &&[\s\S]{0,120}factorCoverageIsCurrent/,
  'derived-factor coverage may skip only when a factor watermark reaches the target trade date'
);
assert.match(
  scheduler,
  /task\.type === 'DERIVED_FACTOR_SYNC'[\s\S]{0,4200}status: ok \? 'COMPLETED' : 'FAILED'[\s\S]{0,900}throw new Error\(`派生因子同步失败/,
  'derived-factor scheduler runs must finish their execution log and propagate script failures'
);
assert.match(
  retiredBaostockFactorTask,
  /type = 'DERIVED_FACTOR_SYNC'[\s\S]{0,120}name = '每日派生因子同步 \(baostock\)'[\s\S]{0,120}is_active = true/,
  'the duplicate legacy Baostock factor task must be retired without touching custom tasks'
);
assert.match(
  retiredBaostockFactorTask,
  /name = '每日派生因子同步 \(自动多源\)'[\s\S]{0,220}jsonb_set[\s\S]{0,220}'"auto"'::jsonb[\s\S]{0,300}name = '每日派生因子同步 \(东方财富\)'/,
  'the authoritative factor task must migrate from the blocked provider to the automatic fallback plan'
);
assert.match(
  derivedFactorCli,
  /opts\.provider \|\| 'auto'[\s\S]{0,1800}totalUpserts <= 0[\s\S]{0,500}因子同步零落盘，拒绝记录假成功/,
  'the derived-factor CLI must default to auto and reject zero-upsert false successes'
);
assert.match(
  scheduler,
  /syncSummary[\s\S]{0,900}scenario === 'derived_factor_sync'[\s\S]{0,700}syncSummary\.skipped === true \|\| upsertTotal > 0/,
  'the scheduler must require a structured successful factor-sync summary'
);
assert.match(
  stockFactorService,
  /recordProviderResult[\s\S]{0,600}upserts\?\.valuation[\s\S]{0,900}recordProviderResult\('eastmoney'/,
  'top-level factor-sync counts must include real-provider writes'
);
assert.match(
  stockFactorService,
  /Intl\.DateTimeFormat\('en-US',[\s\S]{0,160}timeZone: 'Asia\/Shanghai'[\s\S]{0,350}byType\.year/,
  'derived-factor dates must use the A-share timezone instead of UTC truncation'
);
for (const retiredRoute of [
  '/api/strategy-research/opening-preflight',
  '/api/today/opening-readiness',
  '/api/quant/fusion-audits',
  '/api/quant/rankings',
  '/api/ai/signals/stats',
  '/api/ai/recommendations/loop-policy-snapshots',
]) {
  assert.doesNotMatch(
    readonlySmoke,
    new RegExp(retiredRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `read-only smoke must not probe retired route ${retiredRoute}`
  );
}
assert.match(
  readonlySmoke,
  /!Array\.isArray\(json\.data\)[\s\S]{0,120}&&[\s\S]{0,120}!Array\.isArray\(json\.data\?\.suggestions\)/,
  'empty experiment-suggestion arrays are a valid API response'
);
assert.match(
  readonlySmoke,
  /!Array\.isArray\(json\.data\?\.versions\)/,
  'empty parameter-version collections are a valid API response'
);
assert.match(
  scheduler,
  /task\.type === 'REALTIME_QUOTE_SYNC'[\s\S]{0,240}checkAShareTradingHours/,
  'five-minute cron must retain a continuous-session guard'
);
assert.match(
  registry,
  /type:\s*'GLOBAL_MARKET_DAILY_SYNC'[\s\S]{0,180}recommendedCron:\s*'0 9 \* \* \*'/,
  'global catalyst refresh must be registered at 09:00 Asia/Shanghai'
);
assert.match(
  scheduler,
  /type:\s*'GLOBAL_MARKET_DAILY_SYNC'[\s\S]{0,260}cron_expression:\s*'0 9 \* \* \*'[\s\S]{0,180}require_trading_day:\s*false/,
  'global catalyst refresh must run daily without the A-share holiday guard'
);
assert.match(
  scheduler,
  /scheduleGlobalMarketRetry\(taskId: number, attempt: number\)[\s\S]{0,1500}attempt \+ 1/,
  'global catalyst refresh must retry failures in-process'
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
assert.match(
  globalSync,
  /_rebase_pending_fx[\s\S]{0,1800}previous_by_pair=stored_latest/,
  'global refresh must rebase new FX rows onto the persisted predecessor lineage'
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
assert.match(
  liveRecommendations,
  /--trading-day[\s\S]{0,900}_read_candidates\(database_url, args\.limit, args\.trading_day\)/,
  'A-share report history must support PIT-bounded historical materialization'
);

console.log('data refresh contract: 48 assertions passed');
