-- US-101 PR-012 2026-06-20 — 回滚 black_swan_postmortem_reports (down).
--
-- 与 2026-06-20-black-swan-postmortem-reports.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-black-swan-postmortem-reports-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_black_swan_postmortem_reports_generated_at;
DROP INDEX IF EXISTS idx_black_swan_postmortem_reports_source;
DROP INDEX IF EXISTS idx_black_swan_postmortem_reports_status;
DROP INDEX IF EXISTS black_swan_postmortem_reports_event_uniq;

DROP TABLE IF EXISTS black_swan_postmortem_reports;

COMMIT;
