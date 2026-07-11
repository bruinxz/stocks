#!/usr/bin/env bash
set -euo pipefail

# Disposable PostgreSQL verification for Sprint 3 Phase 1.
# Defaults to the local test server; never point PGHOST/PGPORT at production.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UP="$ROOT/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"
DOWN="$ROOT/scripts/migrations/2026-07-11-sprint3-market-storage-phase1-rollback.sql"
PGHOST="${PGHOST:-/tmp}"
DB="stocks_sprint3_phase1_${USER:-agent}_$$"
COLLISION_DB="${DB}_collision"

cleanup() {
  dropdb -h "$PGHOST" --if-exists "$DB" >/dev/null 2>&1 || true
  dropdb -h "$PGHOST" --if-exists "$COLLISION_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb -h "$PGHOST" "$DB"
psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

table_count="$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
test "$table_count" = "10"

psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO backtest_pit_snapshot (
  strategy, as_of_utc, snapshot_day, published_at_utc,
  is_survivorship_biased, source_versions, lineage_closure, metrics, fact_hash
) VALUES (
  'multibagger', '2026-07-10T06:30:00Z', '2026-07-10', '2026-07-10T06:31:00Z',
  FALSE, '{"prices":"v1"}',
  '{"survivorship_evidence":{"universe":"fixture-v1"}}',
  '{}', repeat('a', 64)
);

INSERT INTO backtest_pit_holding (
  snapshot_id, snapshot_as_of_utc, position_order, market_scope, ticker,
  weight, return_since_entry, source_kind, source_document_id, source_version,
  available_at_utc, fact_hash
) SELECT snapshot_id, as_of_utc, 0, 'us', 'AAPL', 0.5, 0.1,
         'fixture', 'holding-1', 'v1', as_of_utc, repeat('b', 64)
  FROM backtest_pit_snapshot WHERE strategy = 'multibagger';

-- Baostock lifecycle and daily rows do not collide because record_kind is in
-- the append-only identity.
INSERT INTO multibagger_universe (
  market_scope, exchange, ticker, record_kind, universe_source_kind,
  source_document_id, source_version, effective_at_utc, available_at_utc,
  as_of_utc, fact_hash
) VALUES
  ('cn_a', 'sh', '600000', 'LIFECYCLE', 'baostock_cn',
   '600000:2026-07-10', 'v1', '2026-07-10T00:00:00Z',
   '2026-07-10T01:00:00Z', '2026-07-10T02:00:00Z', repeat('c', 64)),
  ('cn_a', 'sh', '600000', 'DAILY', 'baostock_cn',
   '600000:2026-07-10', 'v1', '2026-07-10T00:00:00Z',
   '2026-07-10T01:00:00Z', '2026-07-10T02:00:00Z', repeat('d', 64));

-- French aggregate is accepted only in the reserved, non-publishable lane.
INSERT INTO multibagger_universe (
  market_scope, exchange, ticker, record_kind, universe_source_kind,
  source_document_id, source_version, effective_at_utc, available_at_utc,
  as_of_utc, fact_hash
) VALUES (
  'us', 'ACADEMIC_REFERENCE', '__AGGREGATE__:FRENCH_MONTHLY',
  'FRENCH_AGGREGATE', 'kenneth_french', '2026-06', 'v1',
  '2026-06-30T00:00:00Z', '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z', repeat('e', 64)
);

INSERT INTO multibagger_text_hit (
  market_scope, ticker, source_kind, source_document_id, document_fact_hash,
  taxonomy_version, term_id, hit_kind, language, field, start_offset,
  end_offset, context_hash, effective_at_utc, available_at_utc
) SELECT 'cn_a', ticker, universe_source_kind, '600000:2026-07-10',
         repeat('f', 64), 'taxonomy-v1', 'capacity_expansion',
         'EARLY_NEWS', 'zh', 'TITLE', 3, 9, repeat('1', 64),
         effective_at_utc, available_at_utc
  FROM multibagger_universe
  WHERE universe_source_kind = 'baostock_cn' AND record_kind = 'DAILY';

DO $$
DECLARE snapshot_uuid uuid;
BEGIN
  SELECT snapshot_id INTO snapshot_uuid
  FROM backtest_pit_snapshot WHERE strategy = 'multibagger';

  BEGIN
    INSERT INTO backtest_pit_holding (
      snapshot_id, snapshot_as_of_utc, position_order, market_scope, ticker,
      weight, return_since_entry, source_kind, source_document_id, source_version,
      available_at_utc, fact_hash
    ) VALUES (
      snapshot_uuid, '2026-07-10T06:30:00Z', 1, 'us', 'MSFT', 0.5, 0.1,
      'fixture', 'future', 'v1', '2026-07-10T06:31:00Z', repeat('2', 64)
    );
    RAISE EXCEPTION 'expected no-lookahead check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO backtest_pit_holding (
      snapshot_id, snapshot_as_of_utc, position_order, market_scope, ticker,
      weight, return_since_entry, source_kind, source_document_id, source_version,
      available_at_utc, fact_hash
    ) VALUES (
      snapshot_uuid, '2026-07-10T06:30:00Z', 1, 'us',
      '__AGGREGATE__:FRENCH_MONTHLY', 0.5, 0.1,
      'fixture', 'aggregate', 'v1', '2026-07-10T06:30:00Z', repeat('3', 64)
    );
    RAISE EXCEPTION 'expected aggregate holding check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO backtest_pit_snapshot (
      strategy, as_of_utc, snapshot_day, is_survivorship_biased,
      source_versions, lineage_closure, metrics, fact_hash
    ) VALUES (
      'us_preferred', '2026-07-10T06:31:00Z', '2026-07-10', TRUE,
      '{}', '{}', '{}', repeat('4', 64)
    );
    RAISE EXCEPTION 'expected empty source_versions check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO backtest_pit_snapshot (
      strategy, as_of_utc, snapshot_day, is_survivorship_biased,
      source_versions, lineage_closure, metrics, fact_hash
    ) VALUES (
      'us_preferred', '2026-07-10T06:32:00Z', '2026-07-10', FALSE,
      '{"prices":"v1"}', '{}', '{}', repeat('5', 64)
    );
    RAISE EXCEPTION 'expected survivorship evidence check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO multibagger_candidate_snapshot (
      market_scope, exchange, ticker, as_of_utc, available_at_utc, stage,
      conclusion, source_fact_hashes, strategy_version, fact_hash
    ) VALUES (
      'us', 'ACADEMIC_REFERENCE', '__AGGREGATE__:BAD',
      '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'seed',
      'SKIP', jsonb_build_array(repeat('e', 64)), 'strategy-v1',
      repeat('6', 64)
    );
    RAISE EXCEPTION 'expected French candidate check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO multibagger_text_hit (
      market_scope, ticker, source_kind, source_document_id, document_fact_hash,
      taxonomy_version, term_id, hit_kind, language, field, start_offset,
      end_offset, context_hash, effective_at_utc, available_at_utc
    ) SELECT 'cn_a', ticker, universe_source_kind, 'duplicate',
             repeat('f', 64), 'taxonomy-v1', 'capacity_expansion',
             'EARLY_NEWS', 'zh', 'TITLE', 3, 9, repeat('7', 64),
             effective_at_utc, available_at_utc
      FROM multibagger_universe
      WHERE universe_source_kind = 'baostock_cn' AND record_kind = 'DAILY';
    RAISE EXCEPTION 'expected text-hit identity unique violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO multibagger_candidate_snapshot (
      market_scope, exchange, ticker, as_of_utc, available_at_utc,
      stage, conclusion, source_fact_hashes, strategy_version, fact_hash
    ) VALUES (
      'cn_a', 'sh', '600000', '2026-07-10T02:00:00Z',
      '2026-07-10T01:00:00Z', 'seed', 'SKIP', '[]', 'strategy-v1',
      repeat('8', 64)
    );
    RAISE EXCEPTION 'expected empty source fact closure check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jpkr_fx_observation (
      pair, direction, observation_day, available_at_utc,
      source_kind, source_document_id, source_version, local_per_usd,
      usd_per_local, fact_hash
    ) VALUES (
      'USDJPY', 'LOCAL_PER_USD_WITH_RECIPROCAL', '2026-07-10',
      '2026-07-10T01:00:00Z',
      'BOJ', 'bad-reciprocal', 'v1', 150, 0.5, repeat('9', 64)
    );
    RAISE EXCEPTION 'expected FX reciprocal check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO multibagger_candidate_snapshot (
      market_scope, exchange, ticker, as_of_utc, available_at_utc, stage,
      conclusion, score, rating, source_fact_hashes, strategy_version, fact_hash
    ) VALUES (
      'cn_a', 'sh', '600001', '2026-07-10T02:00:00Z',
      '2026-07-10T01:00:00Z', 'seed', 'SKIP',
      '{"rating":null}', 'A', jsonb_build_array(repeat('a', 64)),
      'strategy-v1', repeat('a', 64)
    );
    RAISE EXCEPTION 'expected JSON-null rating check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO multibagger_candidate_snapshot (
      market_scope, exchange, ticker, as_of_utc, available_at_utc, stage,
      conclusion, score, rating, source_fact_hashes, strategy_version, fact_hash
    ) VALUES (
      'cn_a', 'sh', '600002', '2026-07-10T02:00:00Z',
      '2026-07-10T01:00:00Z', 'seed', 'SKIP',
      '{"rating":"A","band":"F"}', 'A',
      jsonb_build_array(repeat('a', 64)), 'strategy-v1', repeat('b', 64)
    );
    RAISE EXCEPTION 'expected aggregate score.band check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO backtest_pit_snapshot (
      strategy, as_of_utc, snapshot_day, is_survivorship_biased,
      source_versions, lineage_closure, metrics, fact_hash
    ) VALUES (
      'not-a-profile', '2026-07-10T06:33:00Z', '2026-07-10', TRUE,
      '{"prices":"v1"}', '{}', '{}', repeat('c', 64)
    );
    RAISE EXCEPTION 'expected replay strategy check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jpkr_daily_kline (
      market_scope, exchange, ticker, ticker_name_local, trading_day,
      open, high, low, close, volume, currency, source_kind,
      source_document_id, source_version, effective_at_utc,
      available_at_utc, fact_hash
    ) VALUES (
      'jp', 'tse', '7203', 'Toyota', '2026-07-10',
      1, 1, 1, 1, 1, 'KRW', 'fixture', 'jp-bad-currency', 'v1',
      '2026-07-10T00:00:00Z', '2026-07-10T01:00:00Z', repeat('d', 64)
    );
    RAISE EXCEPTION 'expected market/currency check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jpkr_fx_observation (
      pair, direction, observation_day, available_at_utc, source_kind,
      source_document_id, source_version, local_per_usd, usd_per_local,
      fact_hash
    ) VALUES (
      'USDJPY', 'LOCAL_PER_USD_WITH_RECIPROCAL', '2026-07-10',
      '2026-07-10T01:00:00Z', 'BOK', 'wrong-source', 'v1',
      100, 0.01, repeat('e', 64)
    );
    RAISE EXCEPTION 'expected pair/provider check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jpkr_financial_snapshot (
      market_scope, ticker, fiscal_period_end, fiscal_period_kind,
      fiscal_quarter, currency, taxonomy_version, parser_version,
      source_kind, source_document_id, source_version, effective_at_utc,
      available_at_utc, fact_hash
    ) VALUES (
      'jp', '7203', '2025-03-31', 'ANNUAL', NULL, 'JPY',
      'taxonomy-v1', 'parser-v1', 'jpx-edinet', 'annual-1', 'v1',
      '2025-03-31T06:00:00Z', '2025-06-20T06:00:00Z', repeat('f', 64)
    );
    IF NOT EXISTS (
      SELECT 1 FROM jpkr_financial_snapshot
      WHERE source_document_id = 'annual-1' AND fiscal_year = 2025
    ) THEN
      RAISE EXCEPTION 'expected deterministic fiscal_year mapping';
    END IF;
  END;

  BEGIN
    INSERT INTO jpkr_financial_snapshot (
      market_scope, ticker, fiscal_period_end, fiscal_period_kind,
      fiscal_quarter, currency, parser_version, account_mapping_version,
      source_kind, source_document_id, source_version, effective_at_utc,
      available_at_utc, fact_hash
    ) VALUES (
      'kr', '005930', '2025-06-30', 'SEMIANNUAL', NULL, 'KRW',
      'parser-v1', 'account-map-v1', 'dart', 'semiannual-1', 'v1',
      '2025-06-30T06:00:00Z', '2025-08-14T06:00:00Z', repeat('0', 64)
    );
  END;

  BEGIN
    INSERT INTO jpkr_financial_snapshot (
      market_scope, ticker, fiscal_period_end, fiscal_period_kind,
      fiscal_quarter, currency, parser_version, source_kind,
      source_document_id, source_version, effective_at_utc,
      available_at_utc, fact_hash
    ) VALUES (
      'jp', '7203', '2025-03-31', 'ANNUAL', NULL, 'JPY',
      'parser-v1', 'jpx-edinet', 'missing-taxonomy', 'v1',
      '2025-03-31T06:00:00Z', '2025-06-20T06:00:00Z', repeat('1', 64)
    );
    RAISE EXCEPTION 'expected EDINET taxonomy lineage check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jpkr_financial_snapshot (
      market_scope, ticker, fiscal_period_end, fiscal_period_kind,
      fiscal_quarter, currency, parser_version, source_kind,
      source_document_id, source_version, effective_at_utc,
      available_at_utc, fact_hash
    ) VALUES (
      'kr', '005930', '2025-06-30', 'SEMIANNUAL', NULL, 'KRW',
      'parser-v1', 'dart', 'missing-account-map', 'v1',
      '2025-06-30T06:00:00Z', '2025-08-14T06:00:00Z', repeat('2', 64)
    );
    RAISE EXCEPTION 'expected DART account-map lineage check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jpkr_fx_observation (
      pair, direction, observation_day, available_at_utc, source_kind,
      source_document_id, source_version, local_per_usd, usd_per_local,
      change_pct, fact_hash
    ) VALUES (
      'USDJPY', 'LOCAL_PER_USD_WITH_RECIPROCAL', '2026-07-10',
      '2026-07-10T01:00:00Z', 'BOJ', 'missing-previous', 'v1',
      100, 0.01, 1.0, repeat('3', 64)
    );
    RAISE EXCEPTION 'expected change lineage check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO multibagger_candidate_snapshot (
      market_scope, exchange, ticker, as_of_utc, available_at_utc, stage,
      conclusion, source_fact_hashes, strategy_version, fact_hash
    ) VALUES (
      'cn_a', 'sh', '600003', '2026-07-10T02:00:00Z',
      '2026-07-10T01:00:00Z', 'seed', 'SKIP', '["not-a-hash"]',
      'strategy-v1', repeat('4', 64)
    );
    RAISE EXCEPTION 'expected non-SHA closure check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO backtest_pit_snapshot (
      strategy, as_of_utc, snapshot_day, is_survivorship_biased,
      source_versions, lineage_closure, metrics, fact_hash
    ) VALUES (
      'us_preferred', '2026-07-10T06:34:00Z', '2026-07-10', TRUE,
      '{"prices":[]}', '{}', '{}', repeat('5', 64)
    );
    RAISE EXCEPTION 'expected nested source-version check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Strict JSON closure matrix. Every malformed top-level/value/element shape
-- must fail closed; the two valid multi-value fixtures below must survive.
DO $$
DECLARE
  invalid_value jsonb;
  fixture_number integer := 0;
  invalid_closures jsonb[] := ARRAY[
    NULL::jsonb,
    'null'::jsonb,
    '[]'::jsonb,
    '"scalar"'::jsonb,
    '{}'::jsonb,
    '[null]'::jsonb,
    '[1]'::jsonb,
    '[true]'::jsonb,
    '[{}]'::jsonb,
    '[[]]'::jsonb,
    jsonb_build_array(jsonb_build_array(repeat('a', 64))),
    jsonb_build_array(repeat('A', 64)),
    jsonb_build_array(repeat('a', 63)),
    jsonb_build_array(repeat('a', 65)),
    jsonb_build_array(repeat('z', 64)),
    jsonb_build_array(repeat('a', 64), 'not-a-hash')
  ];
  invalid_versions jsonb[] := ARRAY[
    NULL::jsonb,
    'null'::jsonb,
    '[]'::jsonb,
    '"scalar"'::jsonb,
    '{}'::jsonb,
    '{"p":null}'::jsonb,
    '{"p":1}'::jsonb,
    '{"p":true}'::jsonb,
    '{"p":{}}'::jsonb,
    '{"p":[]}'::jsonb,
    '{"p":["v1"]}'::jsonb,
    '{"p":""}'::jsonb
  ];
BEGIN
  FOREACH invalid_value IN ARRAY invalid_closures LOOP
    fixture_number := fixture_number + 1;
    BEGIN
      INSERT INTO multibagger_candidate_snapshot (
        market_scope, exchange, ticker, as_of_utc, available_at_utc,
        stage, conclusion, source_fact_hashes, strategy_version, fact_hash
      ) VALUES (
        'cn_a', 'sh', 'bad-closure-' || fixture_number,
        '2026-07-10T03:00:00Z', '2026-07-10T02:00:00Z',
        'seed', 'SKIP', invalid_value, 'strategy-v1', repeat('a', 64)
      );
      RAISE EXCEPTION 'invalid source_fact_hashes accepted: %', invalid_value;
    EXCEPTION
      WHEN check_violation OR not_null_violation THEN NULL;
    END;
  END LOOP;

  fixture_number := 0;
  FOREACH invalid_value IN ARRAY invalid_versions LOOP
    fixture_number := fixture_number + 1;
    BEGIN
      INSERT INTO backtest_pit_snapshot (
        strategy, as_of_utc, snapshot_day, is_survivorship_biased,
        source_versions, lineage_closure, metrics, fact_hash
      ) VALUES (
        'us_preferred',
        '2026-07-10T07:00:00Z'::timestamptz + fixture_number * INTERVAL '1 second',
        '2026-07-10', TRUE, invalid_value, '{}', '{}', repeat('b', 64)
      );
      RAISE EXCEPTION 'invalid source_versions accepted: %', invalid_value;
    EXCEPTION
      WHEN check_violation OR not_null_violation THEN NULL;
    END;
  END LOOP;

  INSERT INTO multibagger_candidate_snapshot (
    market_scope, exchange, ticker, as_of_utc, available_at_utc,
    stage, conclusion, source_fact_hashes, strategy_version, fact_hash
  ) VALUES
    (
      'cn_a', 'sh', '600010', '2026-07-10T03:00:00Z',
      '2026-07-10T02:00:00Z', 'seed', 'SKIP',
      jsonb_build_array(repeat('a', 64), repeat('b', 64)),
      'strategy-v1', repeat('c', 64)
    ),
    (
      'cn_a', 'sh', '600010', '2026-07-10T03:00:00Z',
      '2026-07-10T02:00:00Z', 'seed', 'SKIP',
      jsonb_build_array(repeat('a', 64), repeat('b', 64)),
      'strategy-v2', repeat('d', 64)
    );

  INSERT INTO backtest_pit_snapshot (
    strategy, as_of_utc, snapshot_day, is_survivorship_biased,
    source_versions, lineage_closure, metrics, fact_hash
  ) VALUES (
    'japan_blue_chip', '2026-07-10T08:00:00Z', '2026-07-10', TRUE,
    '{"prices":"v1","fundamentals":"v2"}', '{}', '{}', repeat('e', 64)
  );
END $$;
SQL

test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM multibagger_universe
   WHERE universe_source_kind = 'baostock_cn'")" = "2"
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM backtest_pit_holding")" = "1"
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM multibagger_text_hit")" = "1"
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM multibagger_candidate_snapshot
   WHERE ticker = '600010'")" = "2"
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM backtest_pit_snapshot
   WHERE strategy = 'japan_blue_chip'")" = "1"

psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" = "0"
psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null

# A partial pre-existing canonical name must abort and preserve the partial table.
createdb -h "$PGHOST" "$COLLISION_DB"
psql -h "$PGHOST" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE jpkr_security_master (stub integer);' >/dev/null
if psql -h "$PGHOST" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null 2>&1; then
  echo 'expected canonical name collision to fail closed' >&2
  exit 1
fi
test "$(psql -h "$PGHOST" -d "$COLLISION_DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" = "1"
test "$(psql -h "$PGHOST" -d "$COLLISION_DB" -Atc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'jpkr_security_master'
     AND column_name = 'stub'")" = "1"

echo 'sprint3-market-storage-phase1.pg: PASS (10 tables, constraints, rollback, collision)'
