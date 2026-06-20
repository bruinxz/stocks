-- US-089 PM-018 2026-06-20 — 回滚 ai_diary_entries (down).
--
-- 与 2026-06-20-ai-diary-entries.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-ai-diary-entries-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_ai_diary_entries_generated_at;
DROP INDEX IF EXISTS idx_ai_diary_entries_source;
DROP INDEX IF EXISTS idx_ai_diary_entries_status;
DROP INDEX IF EXISTS idx_ai_diary_entries_date;
DROP INDEX IF EXISTS idx_ai_diary_entries_user_id;
DROP INDEX IF EXISTS ai_diary_entries_user_date_uniq;

DROP TABLE IF EXISTS ai_diary_entries;

COMMIT;
