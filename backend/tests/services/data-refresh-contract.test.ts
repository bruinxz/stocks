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
const usTechSync = fs.readFileSync(
  path.join(root, 'scripts/ops/populate_live_us_tech_market.py'),
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
const liveMultibagger = fs.readFileSync(
  path.join(root, 'scripts/ops/populate_live_multibagger.py'),
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
const marketController = fs.readFileSync(
  path.join(root, 'backend/src/api/controllers/MarketController.ts'),
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
const deployRemoteBuild = fs.readFileSync(
  path.join(root, 'scripts/deployment/deploy_remote_build.sh'),
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
const eastMoneyClient = fs.readFileSync(
  path.join(root, 'backend/src/data/sources/EastMoneyClient.ts'),
  'utf8'
);
const derivedFactorCli = fs.readFileSync(
  path.join(root, 'backend/src/scripts/sync-derived-factors.ts'),
  'utf8'
);
const computeFactorsCli = fs.readFileSync(
  path.join(root, 'backend/src/scripts/compute-factors.ts'),
  'utf8'
);
const financialReportCli = fs.readFileSync(
  path.join(root, 'backend/src/scripts/sync-financial-report.ts'),
  'utf8'
);
const financialReportClient = fs.readFileSync(
  path.join(root, 'backend/src/data/sources/FinancialReportClient.ts'),
  'utf8'
);
const financialReportService = fs.readFileSync(
  path.join(root, 'backend/src/data/services/FinancialReportSyncService.ts'),
  'utf8'
);
const akshareHelper = fs.readFileSync(path.join(root, 'backend/python/akshare_helper.py'), 'utf8');
const analystForecastCli = fs.readFileSync(
  path.join(root, 'backend/src/scripts/sync-analyst-forecast.ts'),
  'utf8'
);
const factorSourceMigration = fs.readFileSync(
  path.join(root, 'backend/scripts/migrations/2026-07-24-factor-source-schema.sql'),
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
  scheduler,
  /getCurrentTargetPlan\(timestamp\)[\s\S]{0,220}targetPlan\.fresh[\s\S]{0,220}target\.symbol/,
  'realtime refresh must dynamically include the current research-loop targets'
);
assert.ok(
  !scheduler.includes("const targetDigits = ['688008'"),
  'realtime refresh must not retain a hard-coded historical audit basket'
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
  /getBroadMarketCoverageDate\(target_date\)[\s\S]{0,180}resolveDailyUpdateWindow\(target_date, marketCoverageDate\)[\s\S]{0,220}catchup_mode/,
  'severely stale daily data must switch from a short reread to a continuous catch-up window'
);
assert.match(
  marketController,
  /updateData = async[\s\S]{0,420}const target_date = expectedCompletedTradeDate\(\)/,
  'manual recovery must target the latest completed A-share trade day, not the UTC calendar day'
);
assert.match(
  marketController,
  /const pendingUpdate =[\s\S]{0,420}if \(pendingUpdate\)[\s\S]{0,320}job_id: String\(pendingUpdate\.id\)/,
  'force recovery must reuse a queued or active task for the same trade day'
);
assert.match(
  dataUpdateWorker,
  /completion_error[\s\S]{0,700}status: completion_error \? UpdateStatus\.FAILED : UpdateStatus\.COMPLETED/,
  'partial daily-update failures must not be recorded as completed'
);
assert.match(
  dataUpdateWorker,
  /final_market_coverage_date = await this\.getBroadMarketCoverageDate\(target_date\)[\s\S]{0,1200}未到达目标/,
  'daily recovery must fail closed when the broad-market watermark did not reach the target date'
);
assert.match(
  dataUpdateWorker,
  /status: failedSyncs > 0 \? UpdateStatus\.FAILED : UpdateStatus\.COMPLETED[\s\S]{0,500}历史行情回补存在/,
  'partial history-repair failures must not be recorded as completed'
);
assert.match(
  pageFreshness,
  /pages:\s*\[\{ page: 'market', label: 'A 股行情' \}\][\s\S]{0,120}source: 'daily_bars'/,
  'A-share page timestamp must follow the daily-bars source actually rendered by the page'
);
assert.match(
  pageFreshness,
  /coverage\.covered >= CEIL\(listed\.total \* 0\.80\)/,
  'one updated instrument must not make the whole A-share catalogue look fresh'
);
assert.match(
  realtimeDedupMigration,
  /LOCK TABLE realtime_quotes[\s\S]{0,700}PARTITION BY symbol, quote_time[\s\S]{0,700}CREATE UNIQUE INDEX uniq_realtime_quote_symbol_time/,
  'realtime quote cleanup must deduplicate under a lock before enforcing the natural key'
);
assert.match(
  pageFreshness,
  /pages:\s*\[\{ page: 'jpkr', label: '韩股科技' \}\][\s\S]{0,360}market_scope = 'kr'/,
  'Korean technology page timestamp must follow the primary KR representative view'
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
  stockFactorService,
  /if \(skipThreshold > 0 && stocks\.length > 0\)/,
  'provider quality is only a secondary skip gate; low total coverage must never skip a bootstrap'
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
  scheduler,
  /task\.type === 'FACTOR_SCORE_COMPUTE'[\s\S]{0,4200}scenario === 'factor_score_compute'[\s\S]{0,1200}total_upserted[\s\S]{0,1200}status: ok \? 'COMPLETED' : 'FAILED'[\s\S]{0,900}throw new Error\(`因子分数生成失败/,
  'factor-score scheduler runs must reject missing or zero-row child summaries and propagate failure'
);
assert.match(
  computeFactorsCli,
  /tradeDate > marketWatermark[\s\S]{0,400}拒绝生成假新鲜因子/,
  'factor-score CLI must never label scores newer than the broad-market watermark'
);
assert.match(
  computeFactorsCli,
  /coverage\.covered >= CEIL\(listed\.total \* 0\.80\)/,
  'factor-score CLI must derive its watermark from broad-market coverage'
);
assert.match(
  computeFactorsCli,
  /totalEffective > 0[\s\S]{0,700}totalEffective <= 0/,
  'factor-score CLI must reject all-neutral factor runs'
);
assert.match(
  computeFactorsCli,
  /FACTOR_CLI_SYNC_SCHEMA === 'true'/,
  'factor-score CLI schema sync must require explicit opt-in'
);
assert.match(
  derivedFactorCli,
  /FACTOR_CLI_SYNC_SCHEMA === 'true'/,
  'derived-factor CLI schema sync must require explicit opt-in'
);
assert(
  (liveRecommendations.match(/raw_value IS NOT NULL/g) || []).length >= 6,
  'recommendation candidate scores must exclude neutral factor placeholders'
);
assert(
  (liveMultibagger.match(/raw_value IS NOT NULL/g) || []).length >= 6,
  'multibagger candidate scores must exclude neutral factor placeholders'
);
assert(
  liveRecommendations.includes('CEIL(COUNT(DISTINCT fs.stock_code) * 0.20)::int') &&
    liveRecommendations.includes('coverage.q_coverage >= coverage.minimum_dimension_coverage') &&
    liveRecommendations.includes('coverage.r_coverage >= coverage.minimum_dimension_coverage') &&
    (liveRecommendations.match(/>= coverage\.minimum_dimension_coverage/g) || []).length === 6,
  'recommendations require broad cross-sectional coverage in all six score dimensions'
);
assert(
  liveMultibagger.includes('CEIL(COUNT(DISTINCT stock_code) * 0.20)::int') &&
    liveMultibagger.includes('coverage.quality_coverage >= coverage.minimum_dimension_coverage') &&
    liveMultibagger.includes('coverage.risk_coverage >= coverage.minimum_dimension_coverage') &&
    (liveMultibagger.match(/>= coverage\.minimum_dimension_coverage/g) || []).length === 6,
  'multibagger candidates require broad cross-sectional coverage in all six score dimensions'
);
assert.match(
  liveMultibagger,
  /FROM daily_bars CROSS JOIN day[\s\S]{0,180}time::date <= day\.trading_day/,
  'multibagger prices must be point-in-time bounded by the factor day'
);
assert.match(
  liveMultibagger,
  /FROM announcement_summaries CROSS JOIN day[\s\S]{0,180}announce_date <= day\.trading_day/,
  'multibagger catalysts must not leak future announcements into historical factor days'
);
assert.match(
  registry,
  /type: 'FINANCIAL_REPORT_SYNC'[\s\S]{0,180}recommendedCron: '0 1 \* \* 0'/,
  'financial-report facts need a registered recurring producer'
);
assert.match(
  scheduler,
  /task\.type === 'FINANCIAL_REPORT_SYNC'[\s\S]{0,3200}scenario === 'financial_report_sync'[\s\S]{0,1600}status: ok \? 'COMPLETED' : 'FAILED'[\s\S]{0,1000}throw new Error\(`财务报告同步失败/,
  'financial-report scheduler runs must require a structured child success and propagate failure'
);
assert.match(
  scheduler,
  /name: '财务报告全市场断点同步'[\s\S]{0,120}type: 'FINANCIAL_REPORT_SYNC'/,
  'financial-report task must preserve its stable seed identity while changing implementation'
);
assert(
  financialReportCli.includes("DATA_CLI_SYNC_SCHEMA === 'true'") &&
    financialReportCli.includes(
      'result.total_upserted > 0 || result.skipped === result.total_stocks'
    ),
  'financial-report CLI must be schema-safe and reject a zero-row cold-start false success'
);
assert.match(
  akshareHelper,
  /def get_market_financial_report[\s\S]{0,1600}stock_yjbb_em[\s\S]{0,2600}'indicator_row': \{'摊薄每股收益\(元\)': eps\}/,
  'financial-report cold starts must use the all-market quarter endpoint and preserve canonical EPS evidence'
);
assert.match(
  financialReportClient,
  /fetchMarketPeriod[\s\S]{0,500}get_market_financial_report/,
  'the TypeScript financial-report client must expose the market-period batch source'
);
assert.match(
  financialReportService,
  /syncMarketPeriod[\s\S]{0,2600}existing\.debt_ratio[\s\S]{0,1200}start \+= 500/,
  'market-period writes must preserve richer existing facts and chunk full-market upserts'
);
assert.match(
  financialReportCli,
  /minimumEffectiveStockCount = Math\.max\(500, Math\.ceil\(listedStockCount \* 0\.2\)\)[\s\S]{0,1800}eligibleEffectiveStockCount >= minimumEffectiveStockCount/,
  'the financial-report producer must reject narrow or non-listed market coverage'
);
assert.match(
  analystForecastCli,
  /scenario: 'analyst_forecast_sync'[\s\S]{0,220}total_upserted[\s\S]{0,500}process\.exit\(ok \? 0 : 1\)/,
  'analyst forecast CLI must expose a structured summary and reject zero-row cold starts'
);
assert.match(
  scheduler,
  /task\.type === 'ANALYST_FORECAST_SYNC'[\s\S]{0,4200}scenario === 'analyst_forecast_sync'[\s\S]{0,1200}status: okAF \? 'COMPLETED' : 'FAILED'/,
  'analyst forecast scheduler must verify the child summary instead of trusting process exit alone'
);
assert.match(factorSourceMigration, /CREATE TABLE IF NOT EXISTS financial_reports/);
assert.match(factorSourceMigration, /CREATE TABLE IF NOT EXISTS analyst_forecasts/);
assert.match(factorSourceMigration, /CREATE TABLE IF NOT EXISTS announcement_summaries/);
assert.doesNotMatch(
  factorSourceMigration,
  /DELETE FROM|TRUNCATE|INSERT INTO/,
  'factor source schema bootstrap must not mutate user or market data'
);
assert.match(
  stockFactorService,
  /recordProviderResult[\s\S]{0,600}upserts\?\.valuation[\s\S]{0,900}recordProviderResult\('eastmoney'/,
  'top-level factor-sync counts must include real-provider writes'
);
assert.match(
  eastMoneyClient,
  /options\.limit \|\| normalizedCodes\.length[\s\S]{0,80}6000/,
  'EastMoney batch snapshots must not truncate a full-market factor request at 1,000 stocks'
);
assert.match(
  eastMoneyClient,
  /batch chunk failed[\s\S]{0,3000}queue\.length > 500[\s\S]{0,300}refusing \$\{missing\.length\} single-request fallbacks/,
  'full-market batch failures must stay chunk-isolated and must not explode into thousands of single requests'
);
assert.match(
  derivedFactorCli,
  /\['eastmoney', 'baostock', 'tushare'\]\.includes\(provider\)[\s\S]{0,500}realProcessed \/ realRequested[\s\S]{0,350}realProcessed <= 0 \|\| \(realRequested >= 100 && realCoverage < 80\)/,
  'an explicit real-provider sync must reject fallback-only or partial-coverage false success'
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
  /populate_live_us_tech_market\.py[\s\S]{0,260}refresh_us_tech_market/,
  'global refresh must persist the US technology market before recommendation snapshots'
);
assert.match(
  globalSync,
  /populate_live_backtest_pit\.py[\s\S]{0,260}refresh_backtest_pit_cn_a/,
  'global refresh must materialize the backtest evidence page instead of leaving its table permanently empty'
);
assert.match(
  globalSync,
  /OPTIONAL_STEPS = \{"refresh_stock_security_lifecycle", "refresh_backtest_pit_cn_a"\}/,
  'PIT evidence must be explicitly classified as an optional projection'
);
assert.match(
  globalSync,
  /critical_failed =[\s\S]{0,500}"degraded_steps"[\s\S]{0,220}return 0 if not critical_failed else 1/,
  'an unavailable optional PIT projection must not roll back successful daily market refreshes'
);
assert.match(
  scheduler,
  /degradedSteps[\s\S]{0,1200}非关键投影降级/,
  'the scheduler must preserve optional projection degradation in its execution summary and logs'
);
assert.match(
  usTechSync,
  /"SMH"[\s\S]{0,180}"semiconductor"[\s\S]{0,500}"IGV"[\s\S]{0,180}"software_cloud"/,
  'US technology refresh must keep explicit sector ETF proxies'
);
assert.match(
  deployRemoteBuild,
  /APPLY_GLOBAL_TECH_DAILY_QUOTE_MIGRATION=1[\s\S]{0,120}apply-global-tech-daily-quotes-migration\.js/,
  'production deployment must apply and verify the US technology quote schema before restart'
);
assert.match(
  usTechSync,
  /US technology capture incomplete/,
  'US technology refresh must fail closed before persistence when any curated instrument is missing'
);
assert.match(
  globalSync,
  /_rebase_pending_fx[\s\S]{0,1800}previous_by_pair=stored_latest/,
  'global refresh must rebase new FX rows onto the persisted predecessor lineage'
);
assert.match(routes, /'\/page-freshness'.*authenticate/, 'page freshness route must be protected');
assert.match(
  pageFreshness,
  /pages:\s*\[\{ page: 'us', label: '美股科技' \}\][\s\S]{0,220}global_tech_daily_quote/,
  'US page freshness must follow the technology quote table shown by the page'
);
assert.match(
  pageFreshness,
  /pages:\s*\[\{ page: 'jpkr', label: '韩股科技' \}\][\s\S]{0,360}market_scope = 'kr'/,
  'Korean technology freshness must not be held back by the secondary Japan view'
);
assert.match(
  dailyReport,
  /profile:\s*'us_preferred'[\s\S]{0,80}marketScope:\s*'cn_a'/,
  'daily report must default to the detailed A-share scope'
);
assert.match(
  scheduler,
  /RETIRED_LEGACY_TASK_TYPES = new Set\(\[[\s\S]{0,240}'BLACK_SWAN_DETECT'[\s\S]{0,240}'SNOWBALL_HOT_KEYWORD_SYNC'/,
  'obsolete black-swan and Snowball types must remain outside the active cron registry'
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

console.log('data refresh contract: 56 assertions passed');
