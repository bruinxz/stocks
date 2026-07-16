#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PHASE1="$ROOT/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"
UP="$ROOT/scripts/migrations/2026-07-14-multibagger-source-version-integrity.sql"
DOWN="$ROOT/scripts/migrations/2026-07-14-multibagger-source-version-integrity-rollback.sql"

fail() {
  echo "multibagger-source-version-integrity.pg: $*" >&2
  exit 2
}

test "${MULTIBAGGER_SOURCE_VERSION_INTEGRITY_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set MULTIBAGGER_SOURCE_VERSION_INTEGRITY_PG_DISPOSABLE_TEST=1"
test -z "${DATABASE_URL:-}" || fail "ambient DATABASE_URL is forbidden"
test -n "${PGHOST:-}" || fail "PGHOST must be an explicit local Unix-socket directory"
case "$PGHOST" in
  /*) ;;
  *) fail "PGHOST must be an absolute local Unix-socket directory" ;;
esac
test -d "$PGHOST" || fail "PGHOST directory does not exist"
test -z "${PGHOSTADDR:-}" || fail "PGHOSTADDR is forbidden"
test -z "${PGSERVICE:-}" || fail "PGSERVICE is forbidden"
test -z "${PGSERVICEFILE:-}" || fail "PGSERVICEFILE is forbidden"
test -z "${PGDATABASE:-}" || fail "PGDATABASE is forbidden"
test -z "${PGPASSWORD:-}" || fail "PGPASSWORD is forbidden"
test -z "${PGPASSFILE:-}" || fail "PGPASSFILE is forbidden"

PGPORT="${PGPORT:-5432}"
case "$PGPORT" in
  *[!0-9]* | "") fail "PGPORT must contain ASCII decimal digits only" ;;
esac
test "${#PGPORT}" -le 5 || fail "PGPORT is out of range"
((10#$PGPORT >= 1 && 10#$PGPORT <= 65535)) || fail "PGPORT is out of range"
PGPORT="$((10#$PGPORT))"
test -S "$PGHOST/.s.PGSQL.$PGPORT" ||
  fail "PGHOST does not contain the requested local PostgreSQL socket"

CURRENT_USER="$(id -un)"
PGUSER="${PGUSER:-$CURRENT_USER}"
test "$PGUSER" = "$CURRENT_USER" || fail "PGUSER must equal the current OS user"
export PGPORT PGUSER

SUFFIX="$(LC_ALL=C od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
case "$SUFFIX" in
  *[!0-9a-f]* | "") fail "could not generate a safe database suffix" ;;
esac
test "${#SUFFIX}" = "24" || fail "database suffix length is invalid"
DB="stocks_source_version_integrity_$(id -u)_${SUFFIX}"
PRIVATE_PGPASS="$(mktemp "${TMPDIR:-/tmp}/stocks-source-version.XXXXXX")"
chmod 600 "$PRIVATE_PGPASS"
PGPASSFILE="$PRIVATE_PGPASS"
export PGPASSFILE
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$PRIVATE_PGPASS"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$PHASE1" >/dev/null

PHASE1_MARKER='migration:2026-07-11-sprint3-market-storage-phase1'
INTEGRITY_MARKER='migration:2026-07-14-multibagger-source-version-integrity'

# Both phase1 table markers are mandatory.
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON TABLE multibagger_candidate_snapshot IS 'foreign:candidate';" >/dev/null
if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null 2>&1; then
  fail "forward migration accepted a foreign candidate table marker"
fi
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON TABLE multibagger_candidate_snapshot IS '$PHASE1_MARKER';" >/dev/null

# Invalid legacy source rows must be rejected explicitly.
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO multibagger_universe (
  market_scope, exchange, ticker, record_kind, universe_source_kind,
  source_document_id, source_version, effective_at_utc, available_at_utc,
  as_of_utc, features, evidence_refs, fact_hash
) VALUES (
  'jp', 'tse', 'LEGACY-U', 'DAILY', 'fixture', 'legacy-universe',
  E'\tbad\t', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z', '{}'::JSONB, '[]'::JSONB, repeat('a', 64)
);
SQL
if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null 2>&1; then
  fail "forward migration accepted an invalid legacy universe version"
fi
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM multibagger_universe WHERE ticker = 'LEGACY-U';" >/dev/null

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO multibagger_candidate_snapshot (
  market_scope, exchange, ticker, as_of_utc, available_at_utc, stage,
  conclusion, score, rating, source_fact_hashes, strategy_version, fact_hash
) VALUES (
  'jp', 'tse', 'LEGACY-C', '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z', 'seed', 'SKIP',
  '{"rating":"B","source_versions":{"quality_engine":"quality-v1"}}'::JSONB,
  'B', jsonb_build_array(repeat('b', 64)), 'strategy-v1', repeat('c', 64)
);
SQL
if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null 2>&1; then
  fail "forward migration accepted invalid legacy candidate versions"
fi
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM multibagger_candidate_snapshot WHERE ticker = 'LEGACY-C';" >/dev/null

# A pre-existing same-name constraint is never adopted.
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE multibagger_universe ADD CONSTRAINT ck_multibagger_universe_source_version_ascii CHECK (TRUE);" >/dev/null
if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null 2>&1; then
  fail "forward migration accepted a constraint-name collision"
fi
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE multibagger_universe DROP CONSTRAINT ck_multibagger_universe_source_version_ascii;" >/dev/null

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT COUNT(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname IN ('multibagger_universe', 'multibagger_candidate_snapshot')
      AND obj_description(c.oid, 'pg_constraint') = '$INTEGRITY_MARKER'")" = "2"

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO multibagger_universe (
  market_scope, exchange, ticker, record_kind, universe_source_kind,
  source_document_id, source_version, effective_at_utc, available_at_utc,
  as_of_utc, features, evidence_refs, fact_hash
) VALUES (
  'jp', 'tse', 'VALID-U', 'DAILY', 'fixture', 'valid-universe',
  'source-v1:parser-v2', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z', '{}'::JSONB, '[]'::JSONB, repeat('d', 64)
);

INSERT INTO multibagger_candidate_snapshot (
  market_scope, exchange, ticker, as_of_utc, available_at_utc, stage,
  conclusion, score, rating, source_fact_hashes, strategy_version, fact_hash
) VALUES
(
  'jp', 'tse', 'VALID-C', '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z', 'growth', 'MULTIBAGGER_2X',
  jsonb_build_object(
    'rating', 'B',
    'source_versions', jsonb_build_object(
      'quality_engine', 'quality-v1',
      'growth_engine', 'growth-v1',
      'valuation_engine', 'valuation-v1',
      'moat_engine', 'moat-v1',
      'trend_engine', 'trend-v1',
      'risk_engine', 'risk-v1'
    )
  ),
  'B', jsonb_build_array(repeat('e', 64)), 'strategy-v1', repeat('f', 64)
),
(
  'jp', 'tse', 'NULL-C', '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z', 'seed', 'SKIP', NULL, NULL,
  jsonb_build_array(repeat('1', 64)), 'strategy-v1', repeat('2', 64)
);

DO $tests$
DECLARE
  invalid_version TEXT;
  candidate_versions JSONB;
  invalid_candidate_versions JSONB[];
BEGIN
  FOREACH invalid_version IN ARRAY ARRAY[
    '',
    ' leading',
    'trailing ',
    'internal space',
    E'\tcontrol\t',
    '版本-v1'
  ] LOOP
    BEGIN
      INSERT INTO multibagger_universe (
        market_scope, exchange, ticker, record_kind, universe_source_kind,
        source_document_id, source_version, effective_at_utc, available_at_utc,
        as_of_utc, features, evidence_refs, fact_hash
      ) VALUES (
        'jp', 'tse', 'INVALID-U', 'DAILY', 'fixture', 'invalid-universe',
        invalid_version, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z',
        '2026-07-01T00:00:00Z', '{}'::JSONB, '[]'::JSONB, repeat('3', 64)
      );
      RAISE EXCEPTION 'invalid universe source_version accepted: %', invalid_version;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  candidate_versions := jsonb_build_object(
    'quality_engine', 'quality-v1',
    'growth_engine', 'growth-v1',
    'valuation_engine', 'valuation-v1',
    'moat_engine', 'moat-v1',
    'trend_engine', 'trend-v1',
    'risk_engine', 'risk-v1'
  );
  invalid_candidate_versions := ARRAY[
    jsonb_set(candidate_versions, '{quality_engine}', to_jsonb(''::TEXT)),
    jsonb_set(candidate_versions, '{quality_engine}', to_jsonb(' leading'::TEXT)),
    jsonb_set(candidate_versions, '{quality_engine}', to_jsonb('trailing '::TEXT)),
    jsonb_set(candidate_versions, '{quality_engine}', to_jsonb('internal space'::TEXT)),
    jsonb_set(candidate_versions, '{quality_engine}', to_jsonb(E'\tcontrol\t'::TEXT)),
    jsonb_set(candidate_versions, '{quality_engine}', to_jsonb('版本-v1'::TEXT)),
    candidate_versions - 'risk_engine',
    candidate_versions || '{"future_engine":"future-v1"}'::JSONB,
    jsonb_set(candidate_versions, '{quality_engine}', '[]'::JSONB),
    '"not-an-object"'::JSONB
  ];

  FOREACH candidate_versions IN ARRAY invalid_candidate_versions LOOP
    BEGIN
      INSERT INTO multibagger_candidate_snapshot (
        market_scope, exchange, ticker, as_of_utc, available_at_utc, stage,
        conclusion, score, rating, source_fact_hashes, strategy_version, fact_hash
      ) VALUES (
        'jp', 'tse', 'INVALID-C', '2026-07-01T00:00:00Z',
        '2026-07-01T00:00:00Z', 'seed', 'SKIP',
        jsonb_build_object('rating', 'B', 'source_versions', candidate_versions),
        'B', jsonb_build_array(repeat('4', 64)), 'strategy-v1', repeat('5', 64)
      );
      RAISE EXCEPTION 'invalid candidate source_versions accepted: %', candidate_versions;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
END;
$tests$;
SQL

# Rollback refuses to drop a constraint whose ownership marker changed.
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON CONSTRAINT ck_multibagger_candidate_score_source_versions ON multibagger_candidate_snapshot IS 'foreign:constraint';" >/dev/null
if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null 2>&1; then
  fail "rollback accepted a foreign constraint marker"
fi
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT COUNT(*) FROM pg_constraint
    WHERE conname IN ('ck_multibagger_universe_source_version_ascii',
                      'ck_multibagger_candidate_score_source_versions')")" = "2"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON CONSTRAINT ck_multibagger_candidate_score_source_versions ON multibagger_candidate_snapshot IS '$INTEGRITY_MARKER';" >/dev/null

# Matching names and comments are insufficient: foreign constraint semantics
# must also be rejected before rollback can drop anything.
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
ALTER TABLE multibagger_candidate_snapshot
  DROP CONSTRAINT ck_multibagger_candidate_score_source_versions;
ALTER TABLE multibagger_candidate_snapshot
  ADD CONSTRAINT ck_multibagger_candidate_score_source_versions CHECK (TRUE);
COMMENT ON CONSTRAINT ck_multibagger_candidate_score_source_versions
  ON multibagger_candidate_snapshot IS '$INTEGRITY_MARKER';
SQL
if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null 2>&1; then
  fail "rollback accepted a foreign same-marker constraint shape"
fi
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT COUNT(*) FROM pg_constraint
    WHERE conname IN ('ck_multibagger_universe_source_version_ascii',
                      'ck_multibagger_candidate_score_source_versions')")" = "2"

# Restore both migration-owned definitions through the forward migration.
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
ALTER TABLE multibagger_candidate_snapshot
  DROP CONSTRAINT ck_multibagger_candidate_score_source_versions;
ALTER TABLE multibagger_universe
  DROP CONSTRAINT ck_multibagger_universe_source_version_ascii;
SQL
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null

test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT COUNT(*) FROM pg_constraint
    WHERE conname IN ('ck_multibagger_universe_source_version_ascii',
                      'ck_multibagger_candidate_score_source_versions')")" = "0"

# Phase1 compatibility is restored after rollback: these rows are intentionally
# invalid under the removed migration and must now insert successfully.
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO multibagger_universe (
  market_scope, exchange, ticker, record_kind, universe_source_kind,
  source_document_id, source_version, effective_at_utc, available_at_utc,
  as_of_utc, features, evidence_refs, fact_hash
) VALUES (
  'jp', 'tse', 'ROLLBACK-U', 'DAILY', 'fixture', 'rollback-universe',
  ' invalid ', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z', '{}'::JSONB, '[]'::JSONB, repeat('6', 64)
);
INSERT INTO multibagger_candidate_snapshot (
  market_scope, exchange, ticker, as_of_utc, available_at_utc, stage,
  conclusion, score, rating, source_fact_hashes, strategy_version, fact_hash
) VALUES (
  'jp', 'tse', 'ROLLBACK-C', '2026-07-01T00:00:00Z',
  '2026-07-01T00:00:00Z', 'seed', 'SKIP',
  '{"rating":"B","source_versions":{"quality_engine":" invalid "}}'::JSONB,
  'B', jsonb_build_array(repeat('7', 64)), 'strategy-v1', repeat('8', 64)
);
SQL

echo 'multibagger-source-version-integrity.pg: PASS'
