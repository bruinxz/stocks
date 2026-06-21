-- Batch AL (2026-06-21) — user_feedbacks 表 (rollback / down).
--
-- 与 2026-06-21-user-feedbacks.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-21-user-feedbacks-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_user_feedbacks_status_reviewed;
DROP INDEX IF EXISTS idx_user_feedbacks_user_status;
DROP TABLE IF EXISTS user_feedbacks;

COMMIT;
