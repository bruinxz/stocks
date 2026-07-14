-- Immutable, lossless typed-source boundary used by deterministic AI replay.
-- Text hits retain their DataPipeline-owned physical hit_fact_hash. The
-- payload hash is produced by the canonical Python replay implementation;
-- PostgreSQL owns structural, pin, PIT, identity, and append-only enforcement.

BEGIN;

CREATE TABLE ai_replay_typed_source_capture (
  capture_id UUID PRIMARY KEY
    CHECK (
      SUBSTRING(capture_id::TEXT FROM 15 FOR 1) = '4'
      AND SUBSTRING(capture_id::TEXT FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
  trading_day DATE NOT NULL,
  as_of_utc TIMESTAMPTZ NOT NULL CHECK (
    DATE_TRUNC('second', as_of_utc) = as_of_utc
  ),
  profile TEXT NOT NULL CHECK (profile IN (
    'us_preferred',
    'multibagger',
    'japan_blue_chip',
    'japan_multibagger',
    'korea_semiconductor_chain',
    'korea_multibagger'
  )),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('cn_a', 'us', 'jp', 'kr')),
  profile_version TEXT NOT NULL CHECK (
    profile_version COLLATE "C" ~
      '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?([+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*)?$'
  ),
  contract_version TEXT NOT NULL CHECK (contract_version = '0.3.1'),
  input_fingerprint TEXT NOT NULL CHECK (
    input_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  strategy_version TEXT NOT NULL CHECK (
    strategy_version COLLATE "C" ~
      '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?([+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*)?$'
  ),
  pipeline_version TEXT NOT NULL CHECK (
    pipeline_version COLLATE "C" ~
      '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?([+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*)?$'
  ),
  available_at_utc TIMESTAMPTZ NOT NULL CHECK (
    available_at_utc <= as_of_utc
  ),
  source_versions JSONB NOT NULL CHECK (
    CASE jsonb_typeof(source_versions)
      WHEN 'object' THEN
        source_versions ?& ARRAY['signals', 'universe', 'scores', 'evidence']
        AND source_versions - 'signals' - 'universe' - 'scores' - 'evidence'
          = '{}'::JSONB
        AND jsonb_typeof(source_versions->'signals') = 'string'
        AND source_versions->>'signals' COLLATE "C" ~ '^[!-~]+$'
        AND jsonb_typeof(source_versions->'universe') = 'string'
        AND source_versions->>'universe' COLLATE "C" ~ '^[!-~]+$'
        AND jsonb_typeof(source_versions->'scores') = 'string'
        AND source_versions->>'scores' COLLATE "C" ~ '^[!-~]+$'
        AND jsonb_typeof(source_versions->'evidence') = 'string'
        AND source_versions->>'evidence' COLLATE "C" ~ '^[!-~]+$'
      ELSE FALSE
    END
  ),
  filings_json JSONB NOT NULL CHECK (jsonb_typeof(filings_json) = 'array'),
  text_hits_json JSONB NOT NULL CHECK (
    jsonb_typeof(text_hits_json) = 'array'
    AND jsonb_array_length(
      jsonb_path_query_array(
        text_hits_json,
        'strict $[*] ? (
          @.type() == "object"
          && @.document.type() == "object"
          && @.hit.type() == "object"
          && @.hit_fact_hash.type() == "string"
          && @.hit_fact_hash like_regex "^[0-9a-f]{64}$"
        )'
      )
    ) = jsonb_array_length(text_hits_json)
  ),
  scores_json JSONB NOT NULL CHECK (jsonb_typeof(scores_json) = 'array'),
  capture_hash TEXT NOT NULL CHECK (capture_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT DATE_TRUNC('second', CURRENT_TIMESTAMP),
  CONSTRAINT ck_ai_replay_typed_source_capture_profile_scope CHECK (
    (profile IN ('us_preferred', 'multibagger') AND market_scope IN ('cn_a', 'us'))
    OR (profile IN ('japan_blue_chip', 'japan_multibagger') AND market_scope = 'jp')
    OR (
      profile IN ('korea_semiconductor_chain', 'korea_multibagger')
      AND market_scope = 'kr'
    )
  ),
  CONSTRAINT uq_ai_replay_typed_source_capture_natural UNIQUE (
    trading_day,
    as_of_utc,
    profile,
    market_scope,
    profile_version,
    contract_version,
    input_fingerprint,
    strategy_version,
    pipeline_version
  )
);

CREATE FUNCTION reject_ai_replay_typed_source_capture_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $append_only$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ai_replay_typed_source_capture is append-only';
END;
$append_only$;

CREATE TRIGGER tr_ai_replay_typed_source_capture_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON ai_replay_typed_source_capture
FOR EACH STATEMENT
EXECUTE FUNCTION reject_ai_replay_typed_source_capture_mutation();

COMMENT ON TABLE ai_replay_typed_source_capture IS
  'migration:2026-07-14-ai-replay-typed-source-capture';
COMMENT ON FUNCTION reject_ai_replay_typed_source_capture_mutation() IS
  'migration:2026-07-14-ai-replay-typed-source-capture';
COMMENT ON TRIGGER tr_ai_replay_typed_source_capture_append_only
  ON ai_replay_typed_source_capture IS
  'migration:2026-07-14-ai-replay-typed-source-capture';

COMMIT;
