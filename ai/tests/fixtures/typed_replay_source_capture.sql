-- Disposable integration fixture for the upstream-owned typed capture boundary.
-- This is intentionally not a production migration.
CREATE TABLE ai_replay_typed_source_capture (
  capture_id UUID PRIMARY KEY,
  trading_day DATE NOT NULL,
  as_of_utc TIMESTAMPTZ NOT NULL,
  profile TEXT NOT NULL,
  market_scope TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL CHECK (
    input_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  strategy_version TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  source_versions JSONB NOT NULL CHECK (
    jsonb_typeof(source_versions) = 'object'
  ),
  filings_json JSONB NOT NULL CHECK (jsonb_typeof(filings_json) = 'array'),
  text_hits_json JSONB NOT NULL CHECK (jsonb_typeof(text_hits_json) = 'array'),
  scores_json JSONB NOT NULL CHECK (jsonb_typeof(scores_json) = 'array'),
  capture_hash TEXT NOT NULL CHECK (capture_hash ~ '^[0-9a-f]{64}$'),
  CHECK (available_at_utc <= as_of_utc),
  UNIQUE (
    trading_day, as_of_utc, profile, market_scope, profile_version,
    contract_version, input_fingerprint, strategy_version, pipeline_version
  )
);
