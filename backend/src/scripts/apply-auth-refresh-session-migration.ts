import fs from 'fs';
import path from 'path';

import { sequelize } from '../config/database';
import {
  assertAuthRefreshSessionSchema,
  authRefreshSessionTableExists,
} from '../auth/AuthRefreshSessionSchema';

async function main(): Promise<void> {
  if (process.env.APPLY_AUTH_REFRESH_SESSION_MIGRATION !== '1') {
    throw new Error('Explicit auth refresh-session migration opt-in is required');
  }
  await sequelize.authenticate();
  if (!(await authRefreshSessionTableExists(sequelize))) {
    const migrationPath = path.resolve(
      process.cwd(),
      'scripts/migrations/2026-07-16-auth-refresh-sessions.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await sequelize.query(sql);
  }
  await assertAuthRefreshSessionSchema(sequelize);
  console.log('auth refresh-session migration: READY');
}

main()
  .then(async () => {
    await sequelize.close();
  })
  .catch(async () => {
    console.error('auth refresh-session migration: FAILED');
    try {
      await sequelize.close();
    } catch {
      // preserve the primary failure without logging connection detail
    }
    process.exitCode = 1;
  });
