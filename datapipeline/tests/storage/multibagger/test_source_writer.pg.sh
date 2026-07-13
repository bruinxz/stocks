#!/usr/bin/env bash
set -euo pipefail

# Disposable PostgreSQL proof for the multibagger source writer's physical row.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
UP="$ROOT/backend/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"

fail() {
  echo "multibagger-source-writer.pg: $*" >&2
  exit 2
}

guard_local_postgres() {
  test "${MULTIBAGGER_PG_DISPOSABLE_TEST:-}" = "1" ||
    fail "set MULTIBAGGER_PG_DISPOSABLE_TEST=1 to enable destructive test"

  test -n "${PGHOST:-}" ||
    fail "PGHOST must be an explicit local Unix-socket directory"
  case "$PGHOST" in
    /*) ;;
    *) fail "PGHOST must be an absolute local Unix-socket directory" ;;
  esac
  test -d "$PGHOST" || fail "PGHOST directory does not exist"

  test -z "${PGSERVICE:-}" || fail "PGSERVICE is forbidden"
  test -z "${PGSERVICEFILE:-}" || fail "PGSERVICEFILE is forbidden"
  test -z "${PGHOSTADDR:-}" || fail "PGHOSTADDR is forbidden"
  test -z "${PGPASSWORD:-}" || fail "PGPASSWORD is forbidden"
  test -z "${PGPASSFILE:-}" || fail "PGPASSFILE is forbidden"
  test -z "${PGDATABASE:-}" || fail "PGDATABASE is forbidden"

  PGPORT="${PGPORT:-5432}"
  case "$PGPORT" in
    *[!0-9]*|"") fail "PGPORT must contain digits only" ;;
  esac
  test "$PGPORT" -ge 1 -a "$PGPORT" -le 65535 ||
    fail "PGPORT is out of range"
  test -S "$PGHOST/.s.PGSQL.$PGPORT" ||
    fail "PGHOST does not contain the requested local PostgreSQL socket"

  CURRENT_USER="$(id -un)"
  PGUSER="${PGUSER:-$CURRENT_USER}"
  test "$PGUSER" = "$CURRENT_USER" ||
    fail "PGUSER must equal the current OS user"
  export PGPORT PGUSER
}

guard_local_postgres

RANDOM_SUFFIX="$(openssl rand -hex 12)" ||
  fail "unable to generate random database suffix"
case "$RANDOM_SUFFIX" in
  *[!0-9a-f]*|"") fail "random database suffix is invalid" ;;
esac
test "${#RANDOM_SUFFIX}" = "24" || fail "random database suffix length is invalid"
DB="stocks_multibagger_writer_$(id -u)_$RANDOM_SUFFIX"
PRIVATE_PGPASS="$(mktemp "${TMPDIR:-/tmp}/stocks-multibagger-pgpass.XXXXXX")"
chmod 600 "$PRIVATE_PGPASS"
PGPASS_MODE="$(
  stat -f '%Lp' "$PRIVATE_PGPASS" 2>/dev/null ||
    stat -c '%a' "$PRIVATE_PGPASS"
)"
test "$PGPASS_MODE" = "600" || fail "private PGPASSFILE must have mode 0600"
PGPASSFILE="$PRIVATE_PGPASS"
export PGPASSFILE
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$PRIVATE_PGPASS"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO multibagger_universe (
  market_scope, provider_market_label, exchange, ticker, record_kind,
  universe_source_kind, source_document_id, source_version,
  effective_at_utc, available_at_utc, as_of_utc,
  features, evidence_refs, text_hit_kinds, fundamental_snapshot,
  filter_pass_bitmap, market_cap_cny_100m, fact_hash
) VALUES
  (
    'cn_a', 'CN', 'sh', '600000', 'DAILY', 'baostock_cn',
    '600000:2026-07-10', 'v1',
    '2026-07-10T06:00:00Z', '2026-07-10T07:00:00Z',
    '2026-07-10T08:00:00Z',
    '{"close_local":"10.25","quality_flags":[]}',
    '["baostock:600000:2026-07-10"]', '[]', '{}', 0, NULL,
    repeat('a', 64)
  ),
  (
    'cn_a', 'CN', 'sh', '600000', 'LIFECYCLE', 'baostock_cn',
    '600000:2026-07-10', 'v1',
    '2026-07-10T06:00:00Z', '2026-07-10T07:00:00Z',
    '2026-07-10T08:00:00Z',
    '{"listing_status":"ACTIVE"}', '[]', '[]', '{}', 0, NULL,
    repeat('b', 64)
  ),
  (
    'us', 'US', 'ACADEMIC_REFERENCE',
    '__AGGREGATE__:french:small-value', 'FRENCH_AGGREGATE',
    'kenneth_french', '2026-06:small-value', 'archive-sha-v1',
    '2026-06-30T00:00:00Z', '2026-07-01T00:00:00Z',
    '2026-07-01T00:00:00Z',
    '{"frequency":"MONTHLY","is_ticker_level":false}',
    '[]', '[]', '{}', 0, NULL, repeat('c', 64)
  );

DO $$
BEGIN
  BEGIN
    INSERT INTO multibagger_universe (
      market_scope, exchange, ticker, record_kind, universe_source_kind,
      source_document_id, source_version, effective_at_utc, available_at_utc,
      as_of_utc, features, evidence_refs, text_hit_kinds,
      fundamental_snapshot, filter_pass_bitmap, fact_hash
    ) VALUES (
      'cn_a', 'sh', '600001', 'DAILY', 'baostock_cn', 'future', 'v1',
      '2026-07-10T06:00:00Z', '2026-07-10T09:00:00Z',
      '2026-07-10T08:00:00Z', '{}', '[]', '[]', '{}', 0, repeat('d', 64)
    );
    RAISE EXCEPTION 'expected PIT check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO multibagger_universe (
      market_scope, exchange, ticker, record_kind, universe_source_kind,
      source_document_id, source_version, effective_at_utc, available_at_utc,
      as_of_utc, features, evidence_refs, text_hit_kinds,
      fundamental_snapshot, filter_pass_bitmap, fact_hash
    ) VALUES (
      'us', 'nasdaq', '__AGGREGATE__:bad', 'FRENCH_AGGREGATE',
      'kenneth_french', 'bad', 'v1',
      '2026-06-30T00:00:00Z', '2026-07-01T00:00:00Z',
      '2026-07-01T00:00:00Z', '{}', '[]', '[]', '{}', 0, repeat('e', 64)
    );
    RAISE EXCEPTION 'expected aggregate identity check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SQL

test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT count(*) FROM multibagger_universe")" = "3"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT count(*) FROM multibagger_universe
   WHERE ticker = '600000'")" = "2"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT jsonb_typeof(features) || ':' ||
          jsonb_typeof(evidence_refs) || ':' ||
          jsonb_typeof(text_hit_kinds) || ':' ||
          jsonb_typeof(fundamental_snapshot)
   FROM multibagger_universe
   WHERE record_kind = 'DAILY'")" = "object:array:array:object"

echo "multibagger-source-writer.pg: PASS"
