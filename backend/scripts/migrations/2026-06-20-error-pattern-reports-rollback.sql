-- US-092 PM-021 2026-06-20 — 回滚 error_pattern_reports (down).
--
-- 与 2026-06-20-error-pattern-reports.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-error-pattern-reports-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_error_pattern_reports_generated_at;
DROP INDEX IF EXISTS idx_error_pattern_reports_status;
DROP INDEX IF EXISTS idx_error_pattern_reports_period_end;
DROP INDEX IF EXISTS idx_error_pattern_reports_user_id;
DROP INDEX IF EXISTS error_pattern_reports_user_period_uniq;

DROP TABLE IF EXISTS error_pattern_reports;

COMMIT;
