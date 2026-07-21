BEGIN;

CREATE TABLE global_tech_daily_quote (
  global_tech_daily_quote_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_scope TEXT NOT NULL CHECK (market_scope = 'us'),
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  instrument_name TEXT NOT NULL,
  instrument_type TEXT NOT NULL CHECK (instrument_type IN ('stock', 'etf')),
  theme TEXT NOT NULL,
  is_sector_proxy BOOLEAN NOT NULL DEFAULT FALSE,
  is_focus BOOLEAN NOT NULL DEFAULT FALSE,
  trading_day DATE NOT NULL,
  open NUMERIC(18, 4) NOT NULL CHECK (open >= 0),
  high NUMERIC(18, 4) NOT NULL CHECK (high >= 0),
  low NUMERIC(18, 4) NOT NULL CHECK (low >= 0),
  close NUMERIC(18, 4) NOT NULL CHECK (close >= 0),
  adjusted_close NUMERIC(18, 4) CHECK (adjusted_close IS NULL OR adjusted_close >= 0),
  volume BIGINT NOT NULL CHECK (volume >= 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  source_kind TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  effective_at_utc TIMESTAMPTZ NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_global_tech_quote_ohlc CHECK (
    high >= low AND high >= open AND high >= close AND low <= open AND low <= close
  ),
  CONSTRAINT uq_global_tech_quote_identity UNIQUE (
    market_scope, symbol, trading_day, source_kind, source_version
  )
);

CREATE INDEX ix_global_tech_quote_symbol_day
  ON global_tech_daily_quote (market_scope, symbol, trading_day DESC);
CREATE INDEX ix_global_tech_quote_day_role
  ON global_tech_daily_quote (trading_day DESC, is_sector_proxy, is_focus);
CREATE INDEX ix_global_tech_quote_pit
  ON global_tech_daily_quote (available_at_utc, effective_at_utc);

COMMIT;
