import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../config/database';

const SCHEMA_MARKER = 'migration:2026-07-24-factor-source-schema';
const SOURCE_TABLES = ['financial_reports', 'analyst_forecasts', 'announcement_summaries'] as const;

async function assertFactorSourceSchema(): Promise<void> {
  const tables = await sequelize.query<{ table_name: string; marker: string | null }>(
    `SELECT relation.relname AS table_name,
            obj_description(relation.oid, 'pg_class') AS marker
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind = 'r'
        AND relation.relname IN (:table_names)`,
    { replacements: { table_names: [...SOURCE_TABLES] }, type: QueryTypes.SELECT }
  );
  const markers = new Map(tables.map(row => [row.table_name, row.marker]));
  const invalidTables = SOURCE_TABLES.filter(name => markers.get(name) !== SCHEMA_MARKER);
  const constraints = await sequelize.query<{ constraint_name: string }>(
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND constraint_name IN (
          'financial_reports_pkey',
          'analyst_forecasts_pkey',
          'announcement_summaries_date_code_title_uniq'
        )`,
    { type: QueryTypes.SELECT }
  );
  const constraintNames = new Set(constraints.map(row => row.constraint_name));
  if (
    invalidTables.length > 0 ||
    !constraintNames.has('financial_reports_pkey') ||
    !constraintNames.has('analyst_forecasts_pkey') ||
    !constraintNames.has('announcement_summaries_date_code_title_uniq')
  ) {
    throw new Error('Factor source schema verification failed');
  }
  const replayColumns = await sequelize.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'factor_scores'
        AND column_name IN ('available_at_utc', 'pit_replay_as_of_utc')`,
    { type: QueryTypes.SELECT }
  );
  if (new Set(replayColumns.map(row => row.column_name)).size !== 2) {
    throw new Error('Factor PIT replay schema verification failed');
  }
}

async function main(): Promise<void> {
  if (process.env.APPLY_FACTOR_SOURCE_SCHEMA !== '1') {
    throw new Error('Explicit factor source schema opt-in is required');
  }
  await sequelize.authenticate();
  for (const filename of [
    '2026-07-24-factor-source-schema.sql',
    '2026-07-24-factor-availability.sql',
    '2026-07-24-factor-pit-replay.sql',
  ]) {
    const migrationPath = path.resolve(process.cwd(), 'scripts/migrations', filename);
    await sequelize.query(fs.readFileSync(migrationPath, 'utf8'));
  }
  await assertFactorSourceSchema();
  console.log('factor source schema: READY');
}

main()
  .then(async () => sequelize.close())
  .catch(async () => {
    console.error('factor source schema: FAILED');
    try {
      await sequelize.close();
    } catch {
      // preserve the primary failure without logging credentials or connection details
    }
    process.exitCode = 1;
  });
