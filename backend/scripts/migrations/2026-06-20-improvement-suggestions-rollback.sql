-- US-094 PM-023 2026-06-20 — 回滚 improvement_suggestions (down).
--
-- 与 2026-06-20-improvement-suggestions.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-improvement-suggestions-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_improvement_suggestions_generated_at;
DROP INDEX IF EXISTS idx_improvement_suggestions_priority;
DROP INDEX IF EXISTS idx_improvement_suggestions_status;
DROP INDEX IF EXISTS idx_improvement_suggestions_category;
DROP INDEX IF EXISTS idx_improvement_suggestions_period_end;
DROP INDEX IF EXISTS idx_improvement_suggestions_user_id;
DROP INDEX IF EXISTS improvement_suggestions_user_period_cat_key_uniq;

DROP TABLE IF EXISTS improvement_suggestions;

COMMIT;
