import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../config/database';

async function main(): Promise<void> {
  if (process.env.APPLY_REALTIME_QUOTE_DEDUP_MIGRATION !== '1') {
    throw new Error('Explicit realtime-quote dedup migration opt-in is required');
  }
  await sequelize.authenticate();
  const migrationPath = path.resolve(
    process.cwd(),
    'scripts/migrations/2026-07-17-realtime-quote-dedup.sql'
  );
  await sequelize.query(fs.readFileSync(migrationPath, 'utf8'));
  const [duplicate] = await sequelize.query<{ duplicate_groups: number }>(
    `SELECT COUNT(*)::int AS duplicate_groups
       FROM (
         SELECT 1 FROM realtime_quotes
          GROUP BY symbol, quote_time HAVING COUNT(*) > 1
       ) groups`,
    { type: QueryTypes.SELECT }
  );
  const [index] = await sequelize.query<{ is_unique: boolean }>(
    `SELECT idx.indisunique AS is_unique
       FROM pg_class table_rel
       JOIN pg_index idx ON idx.indrelid = table_rel.oid
       JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
      WHERE table_rel.relname = 'realtime_quotes'
        AND index_rel.relname = 'uniq_realtime_quote_symbol_time'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(duplicate?.duplicate_groups || 0) !== 0 || index?.is_unique !== true) {
    throw new Error('Realtime quote natural-key verification failed');
  }
  console.log('realtime quote dedup migration: READY');
}

main()
  .then(async () => sequelize.close())
  .catch(async () => {
    console.error('realtime quote dedup migration: FAILED');
    try {
      await sequelize.close();
    } catch {
      // preserve the primary failure without logging credentials or connection details
    }
    process.exitCode = 1;
  });
