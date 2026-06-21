-- US-099 PR-010 2026-06-20 — 回滚 black_swan_events (down).
--
-- 与 2026-06-20-black-swan-events.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-black-swan-events-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_black_swan_events_detected_at;
DROP INDEX IF EXISTS idx_black_swan_events_symbol;
DROP INDEX IF EXISTS idx_black_swan_events_status;
DROP INDEX IF EXISTS idx_black_swan_events_scope;
DROP INDEX IF EXISTS idx_black_swan_events_severity;
DROP INDEX IF EXISTS idx_black_swan_events_event_type;
DROP INDEX IF EXISTS black_swan_events_type_sig_detected_uniq;

DROP TABLE IF EXISTS black_swan_events;

COMMIT;
