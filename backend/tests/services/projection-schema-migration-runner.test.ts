import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const runner = fs.readFileSync(
  path.join(root, 'backend/src/scripts/apply-projection-schema-migrations.ts'),
  'utf8'
);
const deploy = fs.readFileSync(
  path.join(root, 'scripts/deployment/deploy_remote_build.sh'),
  'utf8'
);
const packageJson = fs.readFileSync(path.join(root, 'backend/package.json'), 'utf8');
const globalSync = fs.readFileSync(
  path.join(root, 'scripts/ops/sync_global_markets_daily.py'),
  'utf8'
);
const pitMaterializer = fs.readFileSync(
  path.join(root, 'scripts/ops/populate_live_backtest_pit.py'),
  'utf8'
);
const projectionProducers = [
  'populate_live_us_tech_market.py',
  'populate_live_kr_market.py',
  'populate_live_recommendations.py',
  'populate_live_multibagger.py',
  'populate_live_backtest_pit.py',
].map(filename => fs.readFileSync(path.join(root, 'scripts/ops', filename), 'utf8'));

for (const migration of [
  '2026-07-11-sprint3-market-storage-phase1.sql',
  '2026-07-12-pit-replay-custom-hotfix.sql',
  '2026-07-14-multibagger-classification-provenance.sql',
  '2026-07-14-multibagger-text-hit-provenance.sql',
  '2026-07-14-multibagger-source-version-integrity.sql',
  '2026-07-12-ai-recommendation-sot-v031.sql',
]) {
  assert.match(runner, new RegExp(migration.replaceAll('.', '\\.')));
}

assert.match(
  runner,
  /assertCompleteGroup\([\s\S]{0,900}schema is partially installed/,
  'a partial migration-owned schema must fail closed instead of rerunning CREATE TABLE blindly'
);
assert.match(
  runner,
  /assertPhase1Markers[\s\S]{0,900}PHASE1_MARKER/,
  'the runner must verify ownership markers for all Sprint 3 tables'
);
assert.match(
  runner,
  /ck_backtest_pit_strategy[\s\S]{0,1200}classification_policy_version[\s\S]{0,2200}ck_multibagger_text_hit_fact_hash[\s\S]{0,1800}ck_multibagger_candidate_score_source_versions/,
  'the runner must apply and verify every required Sprint 3 follow-up migration'
);
assert.match(
  runner,
  /function_marker[\s\S]{0,800}trigger_count[\s\S]{0,600}AI_RECOMMENDATION_MARKER/,
  'AI recommendation tables, validation function and deferred triggers must be verified together'
);
assert.match(
  deploy,
  /APPLY_PROJECTION_SCHEMA_MIGRATIONS=1[\s\S]{0,120}apply-projection-schema-migrations\.js/,
  'production deployment must apply projection schemas before restart'
);
assert.match(
  packageJson,
  /db:apply-projection-schema[\s\S]{0,220}APPLY_GLOBAL_TECH_DAILY_QUOTE_MIGRATION=1/,
  'local development needs one command that provisions all page projection tables'
);
assert.match(
  globalSync,
  /populate_live_backtest_pit\.py[\s\S]{0,260}refresh_backtest_pit_cn_a/,
  'the daily projection producer must include backtest PIT materialization'
);
assert.match(
  globalSync,
  /OPTIONAL_STEPS = \{"refresh_backtest_pit_cn_a"\}/,
  'PIT evidence must be explicitly classified as an optional projection'
);
assert.match(
  globalSync,
  /critical_failed =[\s\S]{0,500}degraded_steps[\s\S]{0,220}return 0 if not critical_failed else 1/,
  'PIT evidence may degrade without hiding or failing unrelated fresh projections'
);
assert.match(
  pitMaterializer,
  /--dry-run[\s\S]{0,700}if args\.dry_run/,
  'PIT materialization must remain safe when the global job is run as a dry run'
);
assert.match(
  pitMaterializer,
  /COUNT\(DISTINCT bar\.stock_id\)[\s\S]{0,700}coverage\.covered >= CEIL\(listed\.total \* 0\.80\)/,
  'PIT windows must use the broad-market watermark rather than one updated instrument'
);
for (const producer of projectionProducers) {
  assert.match(
    producer,
    /values = dict\(os\.environ\)[\s\S]{0,360}values\.setdefault/,
    'projection producers must let injected DB settings override stale env files'
  );
}

console.log('projection schema migration runner: 21 assertions passed');
