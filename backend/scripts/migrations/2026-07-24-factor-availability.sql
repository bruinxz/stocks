-- Preserve when each factor fact first became available to this system.
-- Existing rows were ingested on 2026-07-24; created_at is the earliest
-- defensible availability timestamp and must not be rewritten to factor_date.

ALTER TABLE factor_scores
  ADD COLUMN IF NOT EXISTS available_at_utc TIMESTAMPTZ;
UPDATE factor_scores
   SET available_at_utc = COALESCE(created_at, updated_at, NOW())
 WHERE available_at_utc IS NULL;
ALTER TABLE factor_scores
  ALTER COLUMN available_at_utc SET DEFAULT NOW(),
  ALTER COLUMN available_at_utc SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_factor_scores_pit_availability
  ON factor_scores (trade_date, available_at_utc, factor_name);

ALTER TABLE stock_fundamental_factors
  ADD COLUMN IF NOT EXISTS available_at_utc TIMESTAMPTZ;
UPDATE stock_fundamental_factors
   SET available_at_utc = COALESCE(created_at, updated_at, NOW())
 WHERE available_at_utc IS NULL;
ALTER TABLE stock_fundamental_factors
  ALTER COLUMN available_at_utc SET DEFAULT NOW(),
  ALTER COLUMN available_at_utc SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_fundamental_factors_pit_availability
  ON stock_fundamental_factors (factor_date, available_at_utc, symbol);

ALTER TABLE stock_valuation_factors
  ADD COLUMN IF NOT EXISTS available_at_utc TIMESTAMPTZ;
UPDATE stock_valuation_factors
   SET available_at_utc = COALESCE(created_at, updated_at, NOW())
 WHERE available_at_utc IS NULL;
ALTER TABLE stock_valuation_factors
  ALTER COLUMN available_at_utc SET DEFAULT NOW(),
  ALTER COLUMN available_at_utc SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_valuation_factors_pit_availability
  ON stock_valuation_factors (factor_date, available_at_utc, symbol);

COMMENT ON COLUMN factor_scores.available_at_utc IS
  'UTC timestamp when this normalized factor fact first became available to the system.';
COMMENT ON COLUMN stock_fundamental_factors.available_at_utc IS
  'UTC timestamp when this fundamental factor fact first became available to the system.';
COMMENT ON COLUMN stock_valuation_factors.available_at_utc IS
  'UTC timestamp when this valuation factor fact first became available to the system.';
