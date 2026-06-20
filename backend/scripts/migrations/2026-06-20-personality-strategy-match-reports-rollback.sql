-- US-127 PM-025 2026-06-20 — 回滚 personality_strategy_match_reports (down).
--
-- 与 2026-06-20-personality-strategy-match-reports.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-personality-strategy-match-reports-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_personality_strategy_match_reports_generated_at;
DROP INDEX IF EXISTS idx_personality_strategy_match_reports_status;
DROP INDEX IF EXISTS idx_personality_strategy_match_reports_period_end;
DROP INDEX IF EXISTS idx_personality_strategy_match_reports_user_id;
DROP INDEX IF EXISTS personality_strategy_match_reports_user_period_uniq;

DROP TABLE IF EXISTS personality_strategy_match_reports;

COMMIT;
