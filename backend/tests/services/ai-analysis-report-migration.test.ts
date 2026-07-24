import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const sql = fs.readFileSync(
  path.join(root, 'backend/scripts/migrations/2026-07-24-ai-stock-analysis-reports.sql'),
  'utf8'
);
const runner = fs.readFileSync(
  path.join(root, 'backend/src/scripts/apply-ai-stock-analysis-reports-migration.ts'),
  'utf8'
);
const deploy = fs.readFileSync(
  path.join(root, 'scripts/deployment/deploy_remote_build.sh'),
  'utf8'
);
const packageJson = fs.readFileSync(path.join(root, 'backend/package.json'), 'utf8');
const server = fs.readFileSync(path.join(root, 'backend/src/index.ts'), 'utf8');
const service = fs.readFileSync(
  path.join(root, 'backend/src/services/AIAdvisorService.ts'),
  'utf8'
);

assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_stock_analysis_reports/);
for (const column of [
  'report_id',
  'user_id',
  'stock_code',
  'dimensions',
  'key_points_json',
  'task_id',
  'generated_at',
  'engine_variant',
  'shadow_of_report_id',
]) {
  assert.match(sql, new RegExp(`\\b${column}\\b`));
}
assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_stock_analysis_reports_report_id_uniq/);
assert.match(sql, /ai_stock_analysis_reports_task_user_idx[\s\S]{0,100}\(task_id, user_id\)/);
assert.match(runner, /REQUIRED_COLUMNS[\s\S]{0,900}shadow_of_report_id/);
assert.match(runner, /REQUIRED_INDEXES[\s\S]{0,500}task_user_idx/);
assert.match(
  deploy,
  /APPLY_AI_STOCK_ANALYSIS_REPORT_MIGRATION=1[\s\S]{0,120}apply-ai-stock-analysis-reports-migration\.js/
);
assert.match(packageJson, /db:apply-ai-analysis-schema/);
assert.match(
  server,
  /Attempting to sync AIStockAnalysisReport table separately[\s\S]{0,240}AIStockAnalysisReportModel\.sync\(\)/
);
assert.match(
  service,
  /if \(statusRaw === 'FAILED'\)[\s\S]{0,900}if \(isRemoteInFlight/,
  'FAILED payloads must be handled before the asynchronous pending branch'
);

console.log('AI analysis report migration contract: 21 assertions passed');
