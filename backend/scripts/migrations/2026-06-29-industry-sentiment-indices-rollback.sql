-- PR-M3 2026-06-29 — 回滚 industry_sentiment_indices (down).
-- 与 2026-06-29-industry-sentiment-indices.sql 配对.
-- 执行: psql $DATABASE_URL -f backend/scripts/migrations/2026-06-29-industry-sentiment-indices-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_isi_industry_date;
DROP INDEX IF EXISTS idx_isi_date_score;
DROP TABLE IF EXISTS industry_sentiment_indices;

COMMIT;
