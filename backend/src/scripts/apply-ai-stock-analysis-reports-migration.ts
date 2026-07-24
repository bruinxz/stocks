import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../config/database';

const REQUIRED_COLUMNS = [
  'id',
  'report_id',
  'user_id',
  'stock_code',
  'stock_name',
  'dimensions',
  'summary',
  'recommendation',
  'confidence_score',
  'risk_level',
  'key_points_json',
  'status',
  'task_id',
  'target_date',
  'error',
  'generated_at',
  'metadata',
  'engine_variant',
  'shadow_of_report_id',
  'created_at',
  'updated_at',
] as const;

const REQUIRED_INDEXES = [
  'ai_stock_analysis_reports_report_id_uniq',
  'ai_stock_analysis_reports_task_user_idx',
  'ai_stock_analysis_reports_stock_generated_idx',
] as const;

async function assertSchema(): Promise<void> {
  const columns = await sequelize.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ai_stock_analysis_reports'`,
    { type: QueryTypes.SELECT }
  );
  const actualColumns = new Set(columns.map(row => row.column_name));
  const missingColumns = REQUIRED_COLUMNS.filter(column => !actualColumns.has(column));

  const indexes = await sequelize.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'ai_stock_analysis_reports'`,
    { type: QueryTypes.SELECT }
  );
  const actualIndexes = new Map(indexes.map(row => [row.indexname, row.indexdef]));
  const missingIndexes = REQUIRED_INDEXES.filter(index => !actualIndexes.has(index));
  const reportIdIndex = actualIndexes.get('ai_stock_analysis_reports_report_id_uniq') || '';

  if (
    missingColumns.length > 0 ||
    missingIndexes.length > 0 ||
    !/CREATE UNIQUE INDEX/i.test(reportIdIndex)
  ) {
    throw new Error(
      `AI stock analysis report schema verification failed: missing_columns=${missingColumns.join(
        ','
      )}; missing_indexes=${missingIndexes.join(',')}`
    );
  }
}

async function main(): Promise<void> {
  if (process.env.APPLY_AI_STOCK_ANALYSIS_REPORT_MIGRATION !== '1') {
    throw new Error('Explicit AI stock analysis report migration opt-in is required');
  }
  await sequelize.authenticate();
  const migrationPath = path.resolve(
    process.cwd(),
    'scripts/migrations/2026-07-24-ai-stock-analysis-reports.sql'
  );
  await sequelize.query(fs.readFileSync(migrationPath, 'utf8'));
  await assertSchema();
  console.log('AI stock analysis report migration: READY');
}

main()
  .then(async () => sequelize.close())
  .catch(async error => {
    console.error(`AI stock analysis report migration: FAILED: ${error?.message || String(error)}`);
    try {
      await sequelize.close();
    } catch {
      // preserve the primary failure without logging credentials or connection details
    }
    process.exitCode = 1;
  });
