-- PR-M2 2026-06-29 — 回滚集合竞价 snapshot + 盘中 30-min K 线表 (down).
-- 与 2026-06-29-auction-and-30min-klines.sql 配对.
-- 执行: psql $DATABASE_URL -f backend/scripts/migrations/2026-06-29-auction-and-30min-klines-rollback.sql

BEGIN;

DROP INDEX IF EXISTS intraday_klines_30min_time_idx;
DROP TABLE IF EXISTS intraday_klines_30min;

DROP INDEX IF EXISTS idx_auction_snapshots_date_pattern;
DROP TABLE IF EXISTS auction_snapshots;

COMMIT;
