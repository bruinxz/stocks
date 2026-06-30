-- CE-C 2026-06-25 — 回滚 intraday_opportunity_pushes 表 (down).
-- 与 2026-06-25-intraday-opportunity-pushes.sql 配对.
-- 执行: psql $DATABASE_URL -f backend/scripts/migrations/2026-06-25-intraday-opportunity-pushes-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_iop_pending_forward;
DROP INDEX IF EXISTS idx_iop_rule_time;
DROP INDEX IF EXISTS idx_iop_symbol_time;
DROP TABLE IF EXISTS intraday_opportunity_pushes;

COMMIT;
