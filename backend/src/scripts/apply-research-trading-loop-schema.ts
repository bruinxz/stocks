import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../config/database';

const SCHEMA_MARKER = 'migration:2026-07-24-research-trading-loop-schema';
const LOOP_TABLES = ['research_trading_loop_runs', 'research_trading_loop_decisions'] as const;

async function assertResearchTradingLoopSchema(): Promise<void> {
  const tables = await sequelize.query<{ table_name: string; marker: string | null }>(
    `SELECT relation.relname AS table_name,
            obj_description(relation.oid, 'pg_class') AS marker
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind = 'r'
        AND relation.relname IN (:table_names)`,
    { replacements: { table_names: [...LOOP_TABLES] }, type: QueryTypes.SELECT }
  );
  const markers = new Map(tables.map(row => [row.table_name, row.marker]));
  const invalidTables = LOOP_TABLES.filter(name => markers.get(name) !== SCHEMA_MARKER);

  const columns = await sequelize.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'paper_trading_portfolios'
        AND column_name = 'portfolio_type'`,
    { type: QueryTypes.SELECT }
  );
  const constraints = await sequelize.query<{ constraint_name: string }>(
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND constraint_name IN (
          'uq_research_trading_loop_run',
          'ck_research_trading_loop_run_status',
          'uq_research_trading_loop_decision',
          'ck_research_trading_loop_decision_action',
          'ck_research_trading_loop_decision_status'
        )`,
    { type: QueryTypes.SELECT }
  );
  const constraintNames = new Set(constraints.map(row => row.constraint_name));
  const requiredConstraints = [
    'uq_research_trading_loop_run',
    'ck_research_trading_loop_run_status',
    'uq_research_trading_loop_decision',
    'ck_research_trading_loop_decision_action',
    'ck_research_trading_loop_decision_status',
  ];

  if (
    invalidTables.length > 0 ||
    columns.length !== 1 ||
    requiredConstraints.some(name => !constraintNames.has(name))
  ) {
    throw new Error('Research trading loop schema verification failed');
  }
}

async function main(): Promise<void> {
  if (process.env.APPLY_RESEARCH_TRADING_LOOP_SCHEMA !== '1') {
    throw new Error('Explicit research trading loop schema opt-in is required');
  }
  await sequelize.authenticate();
  const migrationPath = path.resolve(
    process.cwd(),
    'scripts/migrations/2026-07-24-research-trading-loop-schema.sql'
  );
  await sequelize.query(fs.readFileSync(migrationPath, 'utf8'));
  await assertResearchTradingLoopSchema();
  console.log('research trading loop schema: READY');
}

main()
  .then(async () => sequelize.close())
  .catch(async () => {
    console.error('research trading loop schema: FAILED');
    try {
      await sequelize.close();
    } catch {
      // preserve the primary failure without logging credentials or connection details
    }
    process.exitCode = 1;
  });
