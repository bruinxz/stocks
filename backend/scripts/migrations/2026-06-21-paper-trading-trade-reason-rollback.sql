-- AL-3 2026-06-21 — 回滚 paper_trading_trades trade_reason 列 (down).
--
-- 与 2026-06-21-paper-trading-trade-reason.sql 一一对应; 用 IF EXISTS 让重复跑幂等.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-21-paper-trading-trade-reason-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_paper_trading_trades_reason_source;

ALTER TABLE paper_trading_trades DROP COLUMN IF EXISTS trade_reason_summary;
ALTER TABLE paper_trading_trades DROP COLUMN IF EXISTS trade_reason;

COMMIT;
