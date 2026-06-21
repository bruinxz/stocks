-- US-147 KOL-001 2026-06-21 — etf_creation_redemption 表回滚 (down).
--
-- 完全回退 2026-06-21-etf-creation-redemption.sql.
-- 警告: 会丢掉所有已同步的 ETF 申赎 + 折溢价快照;
-- 这些数据可由 ETFCreationRedemptionSyncService (KOL-002) 重跑恢复.

BEGIN;

DROP INDEX IF EXISTS idx_etf_creation_redemption_trade_date_industry;
DROP INDEX IF EXISTS idx_etf_creation_redemption_industry;
DROP INDEX IF EXISTS idx_etf_creation_redemption_etf_code;
DROP INDEX IF EXISTS idx_etf_creation_redemption_trade_date;

DROP TABLE IF EXISTS etf_creation_redemption;

COMMIT;
