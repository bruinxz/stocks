-- RecommendationList v0.3.1 physical source of truth.
-- One immutable header plus ordered immutable recommendation items.

BEGIN;

CREATE TABLE ai_recommendation_snapshot (
  snapshot_id UUID PRIMARY KEY
    CHECK (
      SUBSTRING(snapshot_id::TEXT FROM 15 FOR 1) = '4'
      AND SUBSTRING(snapshot_id::TEXT FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
  as_of_utc TIMESTAMPTZ NOT NULL,
  trading_day DATE NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN (
    'us_preferred',
    'multibagger',
    'japan_blue_chip',
    'japan_multibagger',
    'korea_semiconductor_chain',
    'korea_multibagger'
  )),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('cn_a', 'us', 'jp', 'kr')),
  contract_version TEXT NOT NULL CHECK (contract_version = '0.3.1'),
  profile_version TEXT NOT NULL CHECK (
    profile_version COLLATE "C" ~
      '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?([+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*)?$'
  ),
  pipeline_version TEXT NOT NULL CHECK (
    pipeline_version COLLATE "C" ~
      '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?([+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*)?$'
  ),
  model_version TEXT NOT NULL CHECK (
    model_version COLLATE "C" ~
      '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?([+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*)?$'
  ),
  strategy_version TEXT NOT NULL CHECK (
    strategy_version COLLATE "C" ~
      '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?([+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*)?$'
  ),
  rule_bundle_hash TEXT NOT NULL CHECK (rule_bundle_hash ~ '^[0-9a-f]{64}$'),
  template_hash TEXT NOT NULL CHECK (template_hash ~ '^[0-9a-f]{64}$'),
  disclaimer_hash TEXT NOT NULL CHECK (disclaimer_hash ~ '^[0-9a-f]{64}$'),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  output_fingerprint TEXT NOT NULL CHECK (output_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_preimage_jcs TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  envelope_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_ai_recommendation_snapshot_profile_scope CHECK (
    (profile IN ('us_preferred', 'multibagger') AND market_scope IN ('cn_a', 'us'))
    OR (profile IN ('japan_blue_chip', 'japan_multibagger') AND market_scope = 'jp')
    OR (
      profile IN ('korea_semiconductor_chain', 'korea_multibagger')
      AND market_scope = 'kr'
    )
  ),
  CONSTRAINT ck_ai_recommendation_snapshot_envelope CHECK (
    CASE jsonb_typeof(envelope_json)
      WHEN 'object' THEN COALESCE(
        envelope_json->>'snapshot_id' = snapshot_id::TEXT
        AND jsonb_typeof(envelope_json->'as_of') = 'string'
        AND (envelope_json->>'as_of')::TIMESTAMPTZ = as_of_utc
        AND envelope_json->>'profile' = profile
        AND envelope_json->>'market_scope' = market_scope
        AND envelope_json->>'output_fingerprint' = output_fingerprint
        AND jsonb_typeof(envelope_json->'items') = 'array'
        AND jsonb_array_length(envelope_json->'items') = item_count
        AND jsonb_typeof(envelope_json->'disclaimer') = 'object'
        AND envelope_json->'disclaimer'->>'hash' = disclaimer_hash
        AND jsonb_typeof(envelope_json->'meta') = 'object'
        AND envelope_json->'meta'->>'contract_version' = contract_version
        AND envelope_json->'meta'->>'profile_version' = profile_version
        AND envelope_json->'meta'->>'input_fingerprint' = input_fingerprint
        AND envelope_json->'meta'->>'strategy_version' = strategy_version
        AND envelope_json->'meta'->>'pipeline_version' = pipeline_version,
        FALSE
      )
      ELSE FALSE
    END
  ),
  CONSTRAINT ck_ai_recommendation_snapshot_fingerprint_hash CHECK (
    output_fingerprint =
      ENCODE(SHA256(CONVERT_TO(fingerprint_preimage_jcs, 'UTF8')), 'hex')
  ),
  CONSTRAINT uq_ai_recommendation_snapshot_replay UNIQUE (
    profile,
    market_scope,
    as_of_utc,
    output_fingerprint
  ),
  CONSTRAINT uq_ai_recommendation_snapshot_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX ix_ai_recommendation_snapshot_latest
  ON ai_recommendation_snapshot (profile, market_scope, as_of_utc DESC);
CREATE INDEX ix_ai_recommendation_snapshot_day
  ON ai_recommendation_snapshot (trading_day DESC, profile, market_scope);

CREATE TABLE ai_recommendation_item (
  item_id UUID PRIMARY KEY
    CHECK (
      SUBSTRING(item_id::TEXT FROM 15 FOR 1) = '4'
      AND SUBSTRING(item_id::TEXT FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
  snapshot_id UUID NOT NULL
    REFERENCES ai_recommendation_snapshot(snapshot_id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  sort_rank INTEGER NOT NULL CHECK (sort_rank >= 0),
  recommendation_json JSONB NOT NULL,
  recommendation_jcs TEXT NOT NULL,
  recommendation_hash TEXT NOT NULL CHECK (recommendation_hash ~ '^[0-9a-f]{64}$'),
  rating_band TEXT NOT NULL CHECK (rating_band IN ('A', 'B', 'C', 'D', 'F')),
  conviction_final NUMERIC(5, 1) NOT NULL
    CHECK (conviction_final >= 0 AND conviction_final <= 100),
  risk_gate_status TEXT NOT NULL CHECK (risk_gate_status = 'GREEN'),
  size_hint_tier TEXT NOT NULL CHECK (
    size_hint_tier IN ('TIER_5', 'TIER_3', 'TIER_2', 'TIER_1', 'SKIP')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_ai_recommendation_item_jcs_hash CHECK (
    recommendation_hash =
      ENCODE(SHA256(CONVERT_TO(recommendation_jcs, 'UTF8')), 'hex')
  ),
  CONSTRAINT ck_ai_recommendation_item_payload CHECK (
    CASE jsonb_typeof(recommendation_json)
      WHEN 'object' THEN COALESCE(
        recommendation_json->>'snapshot_id' = snapshot_id::TEXT
        AND recommendation_json->>'id' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND recommendation_json->>'id' = item_id::TEXT
        AND recommendation_json->>'ticker' = ticker
        AND recommendation_jcs::JSONB = recommendation_json
        AND jsonb_typeof(recommendation_json->'score') = 'object'
        AND recommendation_json->'score'->>'rating' = rating_band
        AND NOT (recommendation_json->'score' ? 'band')
        AND jsonb_typeof(recommendation_json->'conviction') = 'object'
        AND (recommendation_json->'conviction'->>'final')::NUMERIC = conviction_final
        AND jsonb_typeof(recommendation_json->'risk_gate') = 'object'
        AND recommendation_json->'risk_gate'->>'gate' = 'GREEN'
        AND recommendation_json->'risk_gate'->>'gate' = risk_gate_status
        AND (recommendation_json->'risk_gate'->>'ok_to_enter')::BOOLEAN = TRUE
        AND jsonb_typeof(recommendation_json->'entry_plan') = 'object'
        AND recommendation_json->'entry_plan'->'size_hint'->>'tier' = size_hint_tier,
        FALSE
      )
      ELSE FALSE
    END
  ),
  CONSTRAINT uq_ai_recommendation_item_ticker UNIQUE (snapshot_id, ticker),
  CONSTRAINT uq_ai_recommendation_item_rank UNIQUE (snapshot_id, sort_rank),
  CONSTRAINT uq_ai_recommendation_item_hash UNIQUE (snapshot_id, recommendation_hash)
);

CREATE INDEX ix_ai_recommendation_item_snapshot_rank
  ON ai_recommendation_item (snapshot_id, sort_rank);

CREATE FUNCTION validate_ai_recommendation_snapshot_v031()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $validation$
DECLARE
  target_snapshot_id UUID := COALESCE(NEW.snapshot_id, OLD.snapshot_id);
  snapshot_row ai_recommendation_snapshot%ROWTYPE;
  actual_count INTEGER;
  actual_items JSONB;
  minimum_rank INTEGER;
  maximum_rank INTEGER;
  semantic_envelope JSONB;
BEGIN
  SELECT *
    INTO snapshot_row
  FROM ai_recommendation_snapshot
  WHERE snapshot_id = target_snapshot_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::INTEGER,
         COALESCE(
           JSONB_AGG(
             JSONB_BUILD_OBJECT(
               'recommendation', recommendation_json,
               'rating_band', rating_band
             )
             ORDER BY sort_rank
           ),
           '[]'::JSONB
         ),
         MIN(sort_rank),
         MAX(sort_rank)
    INTO actual_count, actual_items, minimum_rank, maximum_rank
  FROM ai_recommendation_item
  WHERE snapshot_id = target_snapshot_id;

  IF snapshot_row.item_count <> actual_count THEN
    RAISE EXCEPTION
      'Recommendation item_count mismatch for snapshot %: expected %, got %',
      target_snapshot_id, snapshot_row.item_count, actual_count;
  END IF;

  IF snapshot_row.envelope_json->'items' IS DISTINCT FROM actual_items THEN
    RAISE EXCEPTION
      'Recommendation envelope/items mismatch for snapshot %',
      target_snapshot_id;
  END IF;

  semantic_envelope :=
    (snapshot_row.envelope_json - 'output_fingerprint' - 'snapshot_id')
    || JSONB_BUILD_OBJECT(
      'meta',
      (snapshot_row.envelope_json->'meta') - 'generated_by' - 'generation_ms'
    )
    || JSONB_BUILD_OBJECT(
      'items',
      COALESCE(
        (
          SELECT JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'recommendation',
              (entry->'recommendation') - 'id' - 'snapshot_id',
              'rating_band',
              entry->'rating_band'
            )
            ORDER BY ordinality
          )
          FROM JSONB_ARRAY_ELEMENTS(actual_items)
            WITH ORDINALITY AS ordered(entry, ordinality)
        ),
        '[]'::JSONB
      )
    );

  IF snapshot_row.fingerprint_preimage_jcs::JSONB IS DISTINCT FROM semantic_envelope THEN
    RAISE EXCEPTION
      'Recommendation fingerprint preimage/envelope mismatch for snapshot %',
      target_snapshot_id;
  END IF;

  IF actual_count > 0
     AND (minimum_rank <> 0 OR maximum_rank <> actual_count - 1) THEN
    RAISE EXCEPTION
      'Recommendation sort_rank sequence mismatch for snapshot %: min %, max %, count %',
      target_snapshot_id, minimum_rank, maximum_rank, actual_count;
  END IF;

  RETURN NULL;
END;
$validation$;

CREATE CONSTRAINT TRIGGER ck_ai_recommendation_snapshot_items_deferred
AFTER INSERT OR UPDATE ON ai_recommendation_snapshot
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_ai_recommendation_snapshot_v031();

CREATE CONSTRAINT TRIGGER ck_ai_recommendation_item_snapshot_deferred
AFTER INSERT OR UPDATE OR DELETE ON ai_recommendation_item
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_ai_recommendation_snapshot_v031();

COMMENT ON TABLE ai_recommendation_snapshot IS
  'migration:2026-07-12-ai-recommendation-sot-v031';
COMMENT ON TABLE ai_recommendation_item IS
  'migration:2026-07-12-ai-recommendation-sot-v031';
COMMENT ON FUNCTION validate_ai_recommendation_snapshot_v031() IS
  'migration:2026-07-12-ai-recommendation-sot-v031';

COMMIT;
