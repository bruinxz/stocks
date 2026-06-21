-- US-146 PM-027 2026-06-21 — 回滚 improvement_suggestions effect_metrics 列 (down).
--
-- 与 2026-06-21-improvement-suggestions-effect-metrics.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-21-improvement-suggestions-effect-metrics-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_improvement_suggestions_status_tracked;

ALTER TABLE improvement_suggestions
  DROP COLUMN IF EXISTS effect_tracked_at;

ALTER TABLE improvement_suggestions
  DROP COLUMN IF EXISTS effect_metrics;

COMMIT;
