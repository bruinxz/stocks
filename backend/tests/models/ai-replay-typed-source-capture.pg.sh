#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UP="$ROOT/scripts/migrations/2026-07-14-ai-replay-typed-source-capture.sql"
DOWN="$ROOT/scripts/migrations/2026-07-14-ai-replay-typed-source-capture-rollback.sql"

fail() {
  echo "ai-replay-typed-source-capture.pg: $*" >&2
  exit 2
}

test "${AI_REPLAY_TYPED_CAPTURE_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set AI_REPLAY_TYPED_CAPTURE_PG_DISPOSABLE_TEST=1 to enable destructive test"
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
test -S "$PGHOST/.s.PGSQL.$((10#$PGPORT))" ||
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
DB="stocks_typed_capture_$(id -u)_${SUFFIX}"
COLLISION_DB="${DB}_collision"
TAMPER_DB="${DB}_tamper"
PRIVATE_PGPASS="$(mktemp "${TMPDIR:-/tmp}/stocks-typed-capture.XXXXXX")"
chmod 600 "$PRIVATE_PGPASS"
PGPASSFILE="$PRIVATE_PGPASS"
export PGPASSFILE
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  dropdb "${PG_ARGS[@]}" --if-exists "$COLLISION_DB" >/dev/null 2>&1 || true
  dropdb "${PG_ARGS[@]}" --if-exists "$TAMPER_DB" >/dev/null 2>&1 || true
  rm -f "$PRIVATE_PGPASS"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

EXPECTED_COLUMNS='{capture_id,trading_day,as_of_utc,profile,market_scope,profile_version,contract_version,input_fingerprint,strategy_version,pipeline_version,available_at_utc,source_versions,filings_json,text_hits_json,scores_json,capture_hash,created_at}'
ACTUAL_COLUMNS="$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT array_agg(column_name ORDER BY ordinal_position)::TEXT
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_replay_typed_source_capture'")"
test "$ACTUAL_COLUMNS" = "$EXPECTED_COLUMNS" || fail "physical column contract drifted"

MARKER='migration:2026-07-14-ai-replay-typed-source-capture'
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT obj_description('ai_replay_typed_source_capture'::regclass, 'pg_class')")" = "$MARKER"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT obj_description('reject_ai_replay_typed_source_capture_mutation()'::regprocedure, 'pg_proc')")" = "$MARKER"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT obj_description(oid, 'pg_trigger') FROM pg_trigger
    WHERE tgrelid = 'ai_replay_typed_source_capture'::regclass
      AND tgname = 'tr_ai_replay_typed_source_capture_append_only'")" = "$MARKER"

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO ai_replay_typed_source_capture (
  capture_id, trading_day, as_of_utc, profile, market_scope,
  profile_version, contract_version, input_fingerprint, strategy_version,
  pipeline_version, available_at_utc, source_versions, filings_json,
  text_hits_json, scores_json, capture_hash
) VALUES (
  '12345678-1234-4234-8234-567812345678',
  '2026-07-10', '2026-07-10T06:30:00Z', 'japan_blue_chip', 'jp',
  '1.2.3-alpha.1+capture', '0.3.1', repeat('a', 64), '2.0.0',
  '3.4.5+build.7', '2026-07-10T06:29:59.500000Z',
  '{"signals":"signals-v1","universe":"universe-v1","scores":"scores-v1","evidence":"evidence-v1"}',
  '[]',
  '[{"document":{},"hit":{},"hit_fact_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
  '[]', repeat('b', 64)
);

DO $tests$
DECLARE
  base ai_replay_typed_source_capture%ROWTYPE;
BEGIN
  SELECT * INTO STRICT base
  FROM ai_replay_typed_source_capture
  WHERE capture_id = '12345678-1234-4234-8234-567812345678';

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '22345678-1234-1234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '1 minute', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions, base.filings_json, base.text_hits_json,
      base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected UUIDv4 rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '32345678-2234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '17 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions, base.filings_json,
      '[[{"document":{},"hit":{},"hit_fact_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]]'::JSONB,
      base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected nested text-hit array rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT 'f2345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '14 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions, base.filings_json,
      '[{"document":{},"hit":{}}]'::JSONB, base.scores_json,
      base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected missing text-hit physical pin rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '12345678-2234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '15 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions, base.filings_json,
      '[{"document":{},"hit":{},"hit_fact_hash":"ABC"}]'::JSONB,
      base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected invalid text-hit physical pin rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '32345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '2 minutes', base.profile, 'us',
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions, base.filings_json, base.text_hits_json,
      base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected profile/scope rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '42345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '3 minutes', base.profile, base.market_scope,
      '01.2.3', base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions, base.filings_json, base.text_hits_json,
      base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected profile SemVer rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '52345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '4 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      'v1.2.3', base.pipeline_version, base.available_at_utc,
      base.source_versions, base.filings_json, base.text_hits_json,
      base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected strategy SemVer rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '62345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '5 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, '1.2.3-01', base.available_at_utc,
      base.source_versions, base.filings_json, base.text_hits_json,
      base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected pipeline SemVer rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '72345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '6 minutes', base.profile, base.market_scope,
      base.profile_version, '0.3.0', base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions, base.filings_json, base.text_hits_json,
      base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected contract rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '82345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '7 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version,
      base.as_of_utc + INTERVAL '8 minutes', base.source_versions,
      base.filings_json, base.text_hits_json, base.scores_json,
      base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected PIT rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '92345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '9 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions - 'evidence', base.filings_json,
      base.text_hits_json, base.scores_json, base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected missing source version rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT 'a2345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '10 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions || '{"future":"forbidden"}'::JSONB,
      base.filings_json, base.text_hits_json, base.scores_json,
      base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected extra source version rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT 'b2345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '11 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      jsonb_set(base.source_versions, '{scores}', '[]'::JSONB),
      base.filings_json, base.text_hits_json, base.scores_json,
      base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected non-string source version rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT 'c2345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '12 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      jsonb_set(
        base.source_versions,
        '{signals}',
        to_jsonb(E'\tsignals-v1\t'::TEXT)
      ),
      base.filings_json, base.text_hits_json, base.scores_json,
      base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected tab-wrapped source version rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT '22345678-2234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '16 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, base.input_fingerprint,
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      jsonb_set(
        base.source_versions,
        '{signals}',
        to_jsonb(U&'\00A0signals-v1\00A0'::TEXT)
      ),
      base.filings_json, base.text_hits_json, base.scores_json,
      base.capture_hash, base.created_at;
    RAISE EXCEPTION 'expected NBSP-wrapped source version rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT 'd2345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc + INTERVAL '13 minutes', base.profile, base.market_scope,
      base.profile_version, base.contract_version, upper(base.input_fingerprint),
      base.strategy_version, base.pipeline_version, base.available_at_utc,
      base.source_versions, '{}'::JSONB, base.text_hits_json,
      base.scores_json, upper(base.capture_hash), base.created_at;
    RAISE EXCEPTION 'expected array/hash rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ai_replay_typed_source_capture
    SELECT 'e2345678-1234-4234-8234-567812345678', base.trading_day,
      base.as_of_utc, base.profile, base.market_scope, base.profile_version,
      base.contract_version, base.input_fingerprint, base.strategy_version,
      base.pipeline_version, base.available_at_utc, base.source_versions,
      base.filings_json, base.text_hits_json, base.scores_json,
      repeat('c', 64), base.created_at;
    RAISE EXCEPTION 'expected natural identity rejection';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE ai_replay_typed_source_capture
    SET capture_hash = repeat('c', 64)
    WHERE capture_id = base.capture_id;
    RAISE EXCEPTION 'expected append-only update rejection';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    DELETE FROM ai_replay_typed_source_capture WHERE capture_id = base.capture_id;
    RAISE EXCEPTION 'expected append-only delete rejection';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    TRUNCATE ai_replay_typed_source_capture;
    RAISE EXCEPTION 'expected append-only truncate rejection';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  IF (SELECT COUNT(*) FROM ai_replay_typed_source_capture) <> 1 THEN
    RAISE EXCEPTION 'rejected writes changed capture rows';
  END IF;
END;
$tests$;
SQL

if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null 2>&1; then
  fail "expected forward migration collision to fail closed"
fi
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  'SELECT COUNT(*) FROM ai_replay_typed_source_capture')" = "1"

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'")" = "0"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='reject_ai_replay_typed_source_capture_mutation'")" = "0"

createdb "${PG_ARGS[@]}" "$COLLISION_DB"
psql "${PG_ARGS[@]}" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE ai_replay_typed_source_capture (stub INTEGER);' >/dev/null
if psql "${PG_ARGS[@]}" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  fail "expected foreign-table rollback collision to fail closed"
fi
test "$(psql "${PG_ARGS[@]}" -d "$COLLISION_DB" -Atc \
  "SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='ai_replay_typed_source_capture'
      AND column_name='stub'")" = "1"
psql "${PG_ARGS[@]}" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -c 'DROP TABLE ai_replay_typed_source_capture;' >/dev/null
psql "${PG_ARGS[@]}" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE FUNCTION reject_ai_replay_typed_source_capture_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
SQL
if psql "${PG_ARGS[@]}" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -f "$UP" >/dev/null 2>&1; then
  fail "expected foreign-function forward collision to fail closed"
fi
test "$(psql "${PG_ARGS[@]}" -d "$COLLISION_DB" -Atc \
  "SELECT COUNT(*) FROM pg_tables
    WHERE schemaname='public'
      AND tablename='ai_replay_typed_source_capture'")" = "0"
test "$(psql "${PG_ARGS[@]}" -d "$COLLISION_DB" -Atc \
  "SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='reject_ai_replay_typed_source_capture_mutation'")" = "1"

createdb "${PG_ARGS[@]}" "$TAMPER_DB"
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON TABLE ai_replay_typed_source_capture IS 'foreign:table';" >/dev/null
if psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  fail "expected tampered-table rollback to fail closed"
fi
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON TABLE ai_replay_typed_source_capture IS '$MARKER';" >/dev/null
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON FUNCTION reject_ai_replay_typed_source_capture_mutation()
      IS 'foreign:function';" >/dev/null
if psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  fail "expected tampered-function rollback to fail closed"
fi
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON FUNCTION reject_ai_replay_typed_source_capture_mutation()
      IS '$MARKER';" >/dev/null
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION reject_ai_replay_typed_source_capture_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NULL;
END;
$$;
SQL
if psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  fail "expected tampered-function shape rollback to fail closed"
fi
test "$(psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -Atc \
  "SELECT COUNT(*) FROM pg_tables
    WHERE schemaname='public'
      AND tablename='ai_replay_typed_source_capture'")" = "1"
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION reject_ai_replay_typed_source_capture_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ai_replay_typed_source_capture is append-only';
END;
$$;
SQL
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON TRIGGER tr_ai_replay_typed_source_capture_append_only
      ON ai_replay_typed_source_capture IS 'foreign:trigger';" >/dev/null
if psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  fail "expected tampered-trigger rollback to fail closed"
fi
test "$(psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -Atc \
  "SELECT COUNT(*) FROM pg_tables
    WHERE schemaname='public'
      AND tablename='ai_replay_typed_source_capture'")" = "1"
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON TRIGGER tr_ai_replay_typed_source_capture_append_only
      ON ai_replay_typed_source_capture IS '$MARKER';" >/dev/null
psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE OR REPLACE TRIGGER tr_ai_replay_typed_source_capture_append_only
BEFORE DELETE ON ai_replay_typed_source_capture
FOR EACH STATEMENT
EXECUTE FUNCTION reject_ai_replay_typed_source_capture_mutation();
SQL
if psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  fail "expected tampered-trigger shape rollback to fail closed"
fi
test "$(psql "${PG_ARGS[@]}" -d "$TAMPER_DB" -Atc \
  "SELECT COUNT(*) FROM pg_tables
    WHERE schemaname='public'
      AND tablename='ai_replay_typed_source_capture'")" = "1"

echo 'ai-replay-typed-source-capture.pg: PASS'
