import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const cli = read('backend/src/scripts/compute-factors.ts');
const pipeline = read('backend/src/quant/factors/FactorPipeline.ts');
const quality = read('backend/src/quant/factors/library/QualityFactor.ts');
const replay = read('scripts/ops/prepare_backtest_pit_factors.py');
const materializer = read('scripts/ops/populate_live_backtest_pit.py');
const controller = read('backend/src/api/controllers/BacktestPitController.ts');
const globalSync = read('scripts/ops/sync_global_markets_daily.py');

assert.match(
  cli,
  /HISTORICAL_PIT_FACTORS = \[[\s\S]{0,300}'quality'[\s\S]{0,300}'growth'[\s\S]{0,300}'value'[\s\S]{0,300}'momentum'[\s\S]{0,300}'gradual_breakout'[\s\S]{0,300}'low_vol'/
);
assert.match(
  cli,
  /historicalPitReplay[\s\S]{0,1400}loadHistoricalUniverse\(tradeDate\)[\s\S]{0,2600}minimumHistoricalCoverage/,
  'historical mode must use the point-in-time security universe and fail thin factor slices'
);
assert.match(
  cli,
  /listing_date <= :as_of_date[\s\S]{0,180}delisting_date IS NULL OR delisting_date > :as_of_date/,
  'historical universe must include securities by their listing lifecycle at the checkpoint'
);
assert.match(
  pipeline,
  /source: options\.source[\s\S]{0,180}pit_replay_as_of_utc/,
  'factor persistence must atomically replace replay provenance with every recomputation'
);
assert.match(pipeline, /updateOnDuplicate[\s\S]{0,300}'pit_replay_as_of_utc'/);
assert.match(
  quality,
  /r\.roe == null[\s\S]{0,120}NaN[\s\S]{0,1800}FinancialReport\.findAll[\s\S]{0,1200}announcementDate/,
  'quality replay must reject null-as-zero and only use reports announced by the checkpoint'
);
assert.match(replay, /CHECKPOINT_COUNT = 27/);
assert.match(replay, /eligible = sessions\[1:\]/);
assert.match(
  replay,
  /minimum = max\(500, \(universe_size \+ 4\) \/\/ 5\)[\s\S]{0,900}incomplete_factors/,
  'every replayed factor must cover at least 20% of the historical universe'
);
assert.match(
  globalSync,
  /prepare_backtest_pit_factors_cn_a[\s\S]{0,900}refresh_backtest_pit_cn_a/,
  'daily refresh must materialize factors before snapshots'
);
assert.match(
  materializer,
  /historical_pit_replay@1\.0\.0[\s\S]{0,12000}signal_day = previous_session\[checkpoint\]/,
  'snapshot ranking must use the prior-session audited factor cutoff'
);
assert.match(
  materializer,
  /bar\.time >= %s::date - INTERVAL '45 days'[\s\S]{0,120}bar\.time < %s::date \+ INTERVAL '1 day'/,
  'snapshot ranking must use indexable time ranges after the production history backfill'
);
assert.match(
  materializer,
  /bar\.time >= %s::date[\s\S]{0,100}bar\.time < %s::date \+ INTERVAL '1 day'/,
  'execution-price lookup must keep the daily-bars time index usable'
);
assert.match(
  materializer,
  /factor_name IN \([\s\S]{0,500}'low_vol', 'liquidity'[\s\S]{0,1800}ORDER BY rank_score DESC, stock\.symbol ASC[\s\S]{0,80}LIMIT 50[\s\S]{0,500}JOIN LATERAL/,
  'snapshot materialization must rank the audited factor slice before loading per-stock bar history'
);
assert.doesNotMatch(
  materializer,
  /WHERE bar\.time::date (?:=|<|>|BETWEEN)/,
  'daily-bars filters must not cast the indexed time column in WHERE clauses'
);
assert.match(
  controller,
  /trustedSnapshotCount >= REQUIRED_PIT_CHECKPOINTS[\s\S]{0,260}state: 'ready'/,
  'fully validated immutable snapshots must avoid a million-row factor rescan on every page load'
);

console.log('backtest PIT factor replay contract: passed');
