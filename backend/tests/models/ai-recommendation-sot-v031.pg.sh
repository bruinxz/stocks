#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UP="$ROOT/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"
DOWN="$ROOT/scripts/migrations/2026-07-12-ai-recommendation-sot-v031-rollback.sql"
PGHOST="${PGHOST:-/tmp}"
DB="stocks_ai_recommendation_sot_${USER:-agent}_$$"
COLLISION_DB="${DB}_collision"

cleanup() {
  dropdb -h "$PGHOST" --if-exists "$DB" >/dev/null 2>&1 || true
  dropdb -h "$PGHOST" --if-exists "$COLLISION_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb -h "$PGHOST" "$DB"
psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "2"

psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO ai_recommendation_snapshot (
  snapshot_id, as_of_utc, trading_day, profile, market_scope,
  contract_version, profile_version, pipeline_version, model_version,
  strategy_version, rule_bundle_hash, template_hash, disclaimer_hash,
  input_fingerprint, output_fingerprint, idempotency_key, item_count,
  envelope_json
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  '2026-07-10T06:30:00Z',
  '2026-07-10',
  'us_preferred',
  'us',
  '0.3.1',
  'profile-v1',
  'pipeline-v1',
  'model-v1',
  'strategy-v1',
  repeat('a', 64),
  repeat('b', 64),
  repeat('c', 64),
  repeat('d', 64),
  repeat('e', 64),
  repeat('f', 64),
  1,
  jsonb_build_object(
    'snapshot_id', '11111111-1111-4111-8111-111111111111',
    'as_of', '2026-07-10T06:30:00Z',
    'profile', 'us_preferred',
    'market_scope', 'us',
    'items', jsonb_build_array(jsonb_build_object('rating_band', 'A')),
    'output_fingerprint', repeat('e', 64),
    'disclaimer', jsonb_build_object('hash', repeat('c', 64)),
    'meta', jsonb_build_object(
      'contract_version', '0.3.1',
      'profile_version', 'profile-v1',
      'input_fingerprint', repeat('d', 64),
      'strategy_version', 'strategy-v1',
      'pipeline_version', 'pipeline-v1'
    )
  )
);

WITH fixture AS (
  SELECT
    jsonb_build_object(
      'id', '22222222-2222-4222-8222-222222222222',
      'snapshot_id', '11111111-1111-4111-8111-111111111111',
      'ticker', 'AAPL',
      'score', jsonb_build_object('rating', 'A'),
      'conviction', jsonb_build_object('final', 90.0),
      'risk_gate', jsonb_build_object('gate', 'GREEN', 'ok_to_enter', true),
      'entry_plan', jsonb_build_object(
        'size_hint', jsonb_build_object('tier', 'TIER_5')
      )
    ) AS recommendation_json
),
canonical AS (
  SELECT recommendation_json, recommendation_json::TEXT AS recommendation_jcs
  FROM fixture
)
INSERT INTO ai_recommendation_item (
  item_id, snapshot_id, ticker, sort_rank, recommendation_json,
  recommendation_jcs, recommendation_hash, rating_band, conviction_final,
  risk_gate_status, size_hint_tier
) SELECT
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'AAPL',
  0,
  recommendation_json,
  recommendation_jcs,
  encode(sha256(convert_to(recommendation_jcs, 'UTF8')), 'hex'),
  'A',
  90.0,
  'GREEN',
  'TIER_5'
FROM canonical;

DO $$
BEGIN
  BEGIN
    INSERT INTO ai_recommendation_snapshot (
      snapshot_id, as_of_utc, trading_day, profile, market_scope,
      contract_version, profile_version, pipeline_version, model_version,
      strategy_version, rule_bundle_hash, template_hash, disclaimer_hash,
      input_fingerprint, output_fingerprint, idempotency_key, item_count,
      envelope_json
    ) SELECT
      '33333333-3333-4333-8333-333333333333', as_of_utc, trading_day,
      'custom', market_scope, contract_version, profile_version,
      pipeline_version, model_version, strategy_version, rule_bundle_hash,
      template_hash, disclaimer_hash, input_fingerprint, output_fingerprint,
      repeat('2', 64), item_count,
      jsonb_set(envelope_json, '{snapshot_id}', '"33333333-3333-4333-8333-333333333333"')
    FROM ai_recommendation_snapshot
    WHERE snapshot_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected custom profile rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_recommendation_item (
      item_id, snapshot_id, ticker, sort_rank, recommendation_json,
      recommendation_jcs, recommendation_hash, rating_band, conviction_final,
      risk_gate_status, size_hint_tier
    ) SELECT
      '44444444-4444-4444-8444-444444444444', snapshot_id, 'MSFT', 1,
      jsonb_set(recommendation_json, '{ticker}', '"MSFT"'),
      recommendation_jcs, repeat('3', 64), 'A', 90.0, 'YELLOW', size_hint_tier
    FROM ai_recommendation_item
    WHERE item_id = '22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'expected risk gate projection mismatch';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SQL

DB_HOST="$PGHOST" \
DB_PORT="${PGPORT:-5432}" \
DB_NAME="$DB" \
DB_USER="${PGUSER:-${USER:-agent}}" \
DB_PASSWORD="${PGPASSWORD:-}" \
AI_RECOMMENDATION_SOT_PG=1 \
  npx ts-node --transpile-only \
  "$ROOT/tests/models/ai-recommendation-sot-v031.orm.test.ts"

test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM ai_recommendation_snapshot")" = "1"
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM ai_recommendation_item")" = "1"

psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM ai_recommendation_snapshot
      WHERE snapshot_id='11111111-1111-4111-8111-111111111111';" >/dev/null
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM ai_recommendation_item")" = "0"

psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "0"

createdb -h "$PGHOST" "$COLLISION_DB"
psql -h "$PGHOST" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE ai_recommendation_snapshot (stub INTEGER);' >/dev/null
if psql -h "$PGHOST" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -f "$UP" >/dev/null 2>&1; then
  echo 'expected canonical table collision to fail closed' >&2
  exit 1
fi
if psql -h "$PGHOST" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  echo 'expected ownership mismatch rollback to fail closed' >&2
  exit 1
fi
test "$(psql -h "$PGHOST" -d "$COLLISION_DB" -Atc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_name='ai_recommendation_snapshot' AND column_name='stub'")" = "1"

echo 'ai-recommendation-sot-v031.pg: PASS'
