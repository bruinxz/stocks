import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../config/database';

const PHASE1_MARKER = 'migration:2026-07-11-sprint3-market-storage-phase1';
const AI_RECOMMENDATION_MARKER = 'migration:2026-07-12-ai-recommendation-sot-v031';

const PHASE1_TABLES = [
  'jpkr_security_master',
  'jpkr_daily_kline',
  'jpkr_disclosure_event',
  'jpkr_financial_snapshot',
  'jpkr_fx_observation',
  'multibagger_universe',
  'multibagger_text_hit',
  'multibagger_candidate_snapshot',
  'backtest_pit_snapshot',
  'backtest_pit_holding',
] as const;

const AI_RECOMMENDATION_TABLES = ['ai_recommendation_snapshot', 'ai_recommendation_item'] as const;

const MIGRATIONS = {
  phase1: '2026-07-11-sprint3-market-storage-phase1.sql',
  pit_hotfix: '2026-07-12-pit-replay-custom-hotfix.sql',
  classification_provenance: '2026-07-14-multibagger-classification-provenance.sql',
  text_hit_provenance: '2026-07-14-multibagger-text-hit-provenance.sql',
  source_version_integrity: '2026-07-14-multibagger-source-version-integrity.sql',
  ai_recommendation: '2026-07-12-ai-recommendation-sot-v031.sql',
} as const;

function sqlList(values: readonly string[]): string {
  return values.map(value => sequelize.escape(value)).join(', ');
}

async function existingTables(names: readonly string[]): Promise<Set<string>> {
  const rows = await sequelize.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (${sqlList(names)})`,
    { type: QueryTypes.SELECT }
  );
  return new Set(rows.map(row => row.table_name));
}

async function applyMigration(filename: string): Promise<void> {
  const migrationPath = path.resolve(process.cwd(), 'scripts/migrations', filename);
  await sequelize.query(fs.readFileSync(migrationPath, 'utf8'));
}

async function tableMarkers(names: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await sequelize.query<{ table_name: string; marker: string | null }>(
    `SELECT table_rel.relname AS table_name,
            obj_description(table_rel.oid, 'pg_class') AS marker
       FROM pg_class table_rel
       JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
      WHERE namespace.nspname = 'public'
        AND table_rel.relkind = 'r'
        AND table_rel.relname IN (${sqlList(names)})`,
    { type: QueryTypes.SELECT }
  );
  return new Map(rows.map(row => [row.table_name, row.marker]));
}

async function constraintNames(table_name: string): Promise<Set<string>> {
  const rows = await sequelize.query<{ constraint_name: string }>(
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = :table_name`,
    { replacements: { table_name }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map(row => row.constraint_name));
}

async function columnNames(table_name: string): Promise<Set<string>> {
  const rows = await sequelize.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = :table_name`,
    { replacements: { table_name }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map(row => row.column_name));
}

function assertCompleteGroup(
  label: string,
  expected: readonly string[],
  actual: Set<string>
): void {
  if (actual.size === 0 || actual.size === expected.length) return;
  const missing = expected.filter(name => !actual.has(name));
  throw new Error(`${label} schema is partially installed; missing: ${missing.join(', ')}`);
}

async function assertPhase1Markers(): Promise<void> {
  const markers = await tableMarkers(PHASE1_TABLES);
  const invalid = PHASE1_TABLES.filter(name => markers.get(name) !== PHASE1_MARKER);
  if (invalid.length > 0) {
    throw new Error(`Sprint 3 projection ownership verification failed: ${invalid.join(', ')}`);
  }
}

async function ensurePhase1Schema(): Promise<void> {
  let tables = await existingTables(PHASE1_TABLES);
  assertCompleteGroup('Sprint 3 projection', PHASE1_TABLES, tables);
  if (tables.size === 0) {
    await applyMigration(MIGRATIONS.phase1);
    tables = await existingTables(PHASE1_TABLES);
  }
  if (tables.size !== PHASE1_TABLES.length) {
    throw new Error('Sprint 3 projection base migration did not create every required table');
  }
  await assertPhase1Markers();

  let pitConstraints = await constraintNames('backtest_pit_snapshot');
  if (!pitConstraints.has('ck_backtest_pit_strategy')) {
    await applyMigration(MIGRATIONS.pit_hotfix);
    pitConstraints = await constraintNames('backtest_pit_snapshot');
  }
  if (
    !pitConstraints.has('ck_backtest_pit_strategy') ||
    pitConstraints.has('backtest_pit_snapshot_strategy_check')
  ) {
    throw new Error('PIT replay strategy hotfix verification failed');
  }

  let candidateColumns = await columnNames('multibagger_candidate_snapshot');
  const provenanceColumns = ['classification_policy_version', 'classification_reason_codes'];
  const provenanceCount = provenanceColumns.filter(name => candidateColumns.has(name)).length;
  if (provenanceCount === 0) {
    await applyMigration(MIGRATIONS.classification_provenance);
    candidateColumns = await columnNames('multibagger_candidate_snapshot');
  } else if (provenanceCount !== provenanceColumns.length) {
    throw new Error('Multibagger classification provenance schema is partially installed');
  }
  if (!provenanceColumns.every(name => candidateColumns.has(name))) {
    throw new Error('Multibagger classification provenance verification failed');
  }

  let textHitColumns = await columnNames('multibagger_text_hit');
  const textHitProvenanceColumns = ['source_version', 'hit_fact_hash'];
  const textHitProvenanceCount = textHitProvenanceColumns.filter(name =>
    textHitColumns.has(name)
  ).length;
  if (textHitProvenanceCount === 0) {
    await applyMigration(MIGRATIONS.text_hit_provenance);
    textHitColumns = await columnNames('multibagger_text_hit');
  } else if (textHitProvenanceCount !== textHitProvenanceColumns.length) {
    throw new Error('Multibagger text-hit provenance schema is partially installed');
  }
  const textHitConstraints = await constraintNames('multibagger_text_hit');
  if (
    !textHitProvenanceColumns.every(name => textHitColumns.has(name)) ||
    !textHitConstraints.has('ck_multibagger_text_hit_source_version') ||
    !textHitConstraints.has('ck_multibagger_text_hit_fact_hash')
  ) {
    throw new Error('Multibagger text-hit provenance verification failed');
  }

  let universeConstraints = await constraintNames('multibagger_universe');
  let candidateConstraints = await constraintNames('multibagger_candidate_snapshot');
  const hasUniverseIntegrity = universeConstraints.has(
    'ck_multibagger_universe_source_version_ascii'
  );
  const hasCandidateIntegrity = candidateConstraints.has(
    'ck_multibagger_candidate_score_source_versions'
  );
  if (!hasUniverseIntegrity && !hasCandidateIntegrity) {
    await applyMigration(MIGRATIONS.source_version_integrity);
    universeConstraints = await constraintNames('multibagger_universe');
    candidateConstraints = await constraintNames('multibagger_candidate_snapshot');
  } else if (hasUniverseIntegrity !== hasCandidateIntegrity) {
    throw new Error('Multibagger source-version integrity schema is partially installed');
  }
  if (
    !universeConstraints.has('ck_multibagger_universe_source_version_ascii') ||
    !candidateConstraints.has('ck_multibagger_candidate_score_source_versions')
  ) {
    throw new Error('Multibagger source-version integrity verification failed');
  }
}

async function assertAIRecommendationSchema(): Promise<void> {
  const markers = await tableMarkers(AI_RECOMMENDATION_TABLES);
  const invalid = AI_RECOMMENDATION_TABLES.filter(
    name => markers.get(name) !== AI_RECOMMENDATION_MARKER
  );
  const [runtime] = await sequelize.query<{
    function_marker: string | null;
    trigger_count: number;
  }>(
    `SELECT obj_description(
              to_regprocedure('validate_ai_recommendation_snapshot_v031()'),
              'pg_proc'
            ) AS function_marker,
            (SELECT COUNT(*)::int
               FROM pg_trigger
              WHERE NOT tgisinternal
                AND tgname IN (
                  'ck_ai_recommendation_snapshot_items_deferred',
                  'ck_ai_recommendation_item_snapshot_deferred'
                )) AS trigger_count`,
    { type: QueryTypes.SELECT }
  );
  if (
    invalid.length > 0 ||
    runtime?.function_marker !== AI_RECOMMENDATION_MARKER ||
    Number(runtime?.trigger_count || 0) !== 2
  ) {
    throw new Error('AI recommendation projection schema verification failed');
  }
}

async function ensureAIRecommendationSchema(): Promise<void> {
  let tables = await existingTables(AI_RECOMMENDATION_TABLES);
  assertCompleteGroup('AI recommendation projection', AI_RECOMMENDATION_TABLES, tables);
  if (tables.size === 0) {
    await applyMigration(MIGRATIONS.ai_recommendation);
    tables = await existingTables(AI_RECOMMENDATION_TABLES);
  }
  if (tables.size !== AI_RECOMMENDATION_TABLES.length) {
    throw new Error('AI recommendation migration did not create every required table');
  }
  await assertAIRecommendationSchema();
}

async function main(): Promise<void> {
  if (process.env.APPLY_PROJECTION_SCHEMA_MIGRATIONS !== '1') {
    throw new Error('Explicit projection schema migration opt-in is required');
  }
  await sequelize.authenticate();
  await ensurePhase1Schema();
  await ensureAIRecommendationSchema();
  console.log('projection schema migrations: READY');
}

main()
  .then(async () => sequelize.close())
  .catch(async () => {
    console.error('projection schema migrations: FAILED');
    try {
      await sequelize.close();
    } catch {
      // preserve the primary error without logging credentials or connection details
    }
    process.exitCode = 1;
  });
