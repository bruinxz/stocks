-- AT-1 2026-06-22 — rollback for 2026-06-22-paper-trading-portfolio-strategy-fields.sql
--
-- 注意:
--   - DROP COLUMN 会丢失所有用户已配置的 strategy_keys / enabled_factors /
--     auto_trade_enabled 数据, 不可逆. 仅在确实需要回滚 schema 时使用.
--   - 回滚后, runAutoSync 会回到 "所有 portfolio 都跟单" 的 legacy 行为.
--
-- 执行:
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-22-paper-trading-portfolio-strategy-fields-rollback.sql

BEGIN;

DROP INDEX IF EXISTS idx_paper_trading_portfolios_auto_trade;

ALTER TABLE paper_trading_portfolios
  DROP COLUMN IF EXISTS auto_trade_enabled,
  DROP COLUMN IF EXISTS risk_profile_overrides,
  DROP COLUMN IF EXISTS enabled_factors,
  DROP COLUMN IF EXISTS strategy_keys,
  DROP COLUMN IF EXISTS description;

COMMIT;
