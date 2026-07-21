import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../config/database';

async function tableExists(): Promise<boolean> {
  const [row] = await sequelize.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.global_tech_daily_quote')::text AS table_name`,
    { type: QueryTypes.SELECT }
  );
  return row?.table_name === 'global_tech_daily_quote';
}

async function assertSchema(): Promise<void> {
  const columns = await sequelize.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'global_tech_daily_quote'`,
    { type: QueryTypes.SELECT }
  );
  const actual = new Set(columns.map(row => row.column_name));
  const required = [
    'market_scope',
    'symbol',
    'instrument_name',
    'instrument_type',
    'theme',
    'is_sector_proxy',
    'is_focus',
    'trading_day',
    'close',
    'volume',
    'available_at_utc',
    'fact_hash',
  ];
  const missing = required.filter(column => !actual.has(column));
  const [index] = await sequelize.query<{ is_unique: boolean }>(
    `SELECT idx.indisunique AS is_unique
       FROM pg_class table_rel
       JOIN pg_index idx ON idx.indrelid = table_rel.oid
       JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
      WHERE table_rel.relname = 'global_tech_daily_quote'
        AND index_rel.relname = 'uq_global_tech_quote_identity'`,
    { type: QueryTypes.SELECT }
  );
  if (missing.length > 0 || index?.is_unique !== true) {
    throw new Error('Global technology quote schema verification failed');
  }
}

async function main(): Promise<void> {
  if (process.env.APPLY_GLOBAL_TECH_DAILY_QUOTE_MIGRATION !== '1') {
    throw new Error('Explicit global technology quote migration opt-in is required');
  }
  await sequelize.authenticate();
  if (!(await tableExists())) {
    const migration_path = path.resolve(
      process.cwd(),
      'scripts/migrations/2026-07-22-global-tech-daily-quotes.sql'
    );
    await sequelize.query(fs.readFileSync(migration_path, 'utf8'));
  }
  await assertSchema();
  console.log('global technology daily-quote migration: READY');
}

main()
  .then(async () => sequelize.close())
  .catch(async () => {
    console.error('global technology daily-quote migration: FAILED');
    try {
      await sequelize.close();
    } catch {
      // preserve the primary error without logging connection details
    }
    process.exitCode = 1;
  });
