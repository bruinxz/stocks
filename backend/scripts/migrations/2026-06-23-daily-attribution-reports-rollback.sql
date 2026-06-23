-- US-080 PM-003 2026-06-23 — 删除 daily_attribution_reports (rollback).
--
-- 用法 (谨慎; 表数据 = 历史归因报告, 删除后 PM-007 全部 404):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-23-daily-attribution-reports-rollback.sql

BEGIN;

DROP TABLE IF EXISTS daily_attribution_reports;

COMMIT;
