-- US-095 OPS-006 2026-06-20 — 回滚 webhook_fallback_log (down).
--
-- 与 2026-06-20-webhook-fallback-log.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-webhook-fallback-log-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_webhook_fallback_log_created_at;
DROP INDEX IF EXISTS idx_webhook_fallback_log_channel;
DROP INDEX IF EXISTS idx_webhook_fallback_log_status_next_retry;

DROP TABLE IF EXISTS webhook_fallback_log;

COMMIT;
