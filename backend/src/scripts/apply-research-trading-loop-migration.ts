import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../config/database';

interface MigrationHealthRow {
  user_count: number;
  loop_portfolio_count: number;
  user_portfolio_violations: number;
  legacy_portfolio_count: number;
  marker_count: number;
  legacy_active_task_count: number;
}

async function assertResearchTradingLoopSchema(): Promise<void> {
  const [health] = await sequelize.query<MigrationHealthRow>(
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS user_count,
       (SELECT COUNT(*)::int FROM paper_trading_portfolios
         WHERE portfolio_type = 'research_loop' AND is_active = TRUE) AS loop_portfolio_count,
       (SELECT COUNT(*)::int FROM (
          SELECT user_id
            FROM paper_trading_portfolios
           WHERE portfolio_type = 'research_loop' AND is_active = TRUE
           GROUP BY user_id HAVING COUNT(*) <> 1
        ) violations) AS user_portfolio_violations,
       (SELECT COUNT(*)::int FROM paper_trading_portfolios
         WHERE portfolio_type <> 'research_loop' OR is_active = FALSE) AS legacy_portfolio_count,
       (SELECT COUNT(*)::int FROM runtime_data_migrations
         WHERE migration_key = '2026-07-22-research-trading-loop-reset-v1') AS marker_count,
       (SELECT COUNT(*)::int FROM scheduled_tasks
         WHERE is_active = TRUE AND type IN (
           'PAPER_TRADING_AUTO_SYNC',
           'PAPER_TRADING_RISK_CHECK',
           'PAPER_TRADING_TRAILING_STOP_UPDATE',
           'PAPER_TRADING_TRAILING_STOP_CHECK',
           'PAPER_TRADING_INDUSTRY_CONCENTRATION_CHECK',
           'PAPER_TRADING_DRAWDOWN_BREAKER_CHECK',
           'PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK',
           'PAPER_TRADING_DAILY_PLAN'
         )) AS legacy_active_task_count`,
    { type: QueryTypes.SELECT }
  );
  const tables = await sequelize.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('research_trading_loop_runs', 'research_trading_loop_decisions')`,
    { type: QueryTypes.SELECT }
  );
  const tableNames = new Set(tables.map(row => row.table_name));
  if (
    !health ||
    Number(health.user_count) !== Number(health.loop_portfolio_count) ||
    Number(health.user_portfolio_violations) !== 0 ||
    Number(health.legacy_portfolio_count) !== 0 ||
    Number(health.marker_count) !== 1 ||
    Number(health.legacy_active_task_count) !== 0 ||
    !tableNames.has('research_trading_loop_runs') ||
    !tableNames.has('research_trading_loop_decisions')
  ) {
    throw new Error('Research trading loop migration verification failed');
  }
}

async function main(): Promise<void> {
  if (process.env.APPLY_RESEARCH_TRADING_LOOP_MIGRATION !== '1') {
    throw new Error('Explicit research trading loop migration opt-in is required');
  }
  await sequelize.authenticate();
  const migrationPath = path.resolve(
    process.cwd(),
    'scripts/migrations/2026-07-22-research-trading-loop.sql'
  );
  await sequelize.query(fs.readFileSync(migrationPath, 'utf8'));
  await assertResearchTradingLoopSchema();
  console.log('research trading loop migration: READY');
}

main()
  .then(async () => sequelize.close())
  .catch(async () => {
    console.error('research trading loop migration: FAILED');
    try {
      await sequelize.close();
    } catch {
      // preserve the primary failure without logging credentials or connection details
    }
    process.exitCode = 1;
  });
