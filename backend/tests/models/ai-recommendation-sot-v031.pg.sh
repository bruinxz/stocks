#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UP="$ROOT/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"
DOWN="$ROOT/scripts/migrations/2026-07-12-ai-recommendation-sot-v031-rollback.sql"

fail() {
  echo "ai-recommendation-sot-v031.pg: $*" >&2
  exit 2
}

guard_local_postgres() {
  test "${AI_RECOMMENDATION_SOT_PG_DISPOSABLE_TEST:-}" = "1" ||
    fail "set AI_RECOMMENDATION_SOT_PG_DISPOSABLE_TEST=1 to enable destructive test"

  test -n "${PGHOST:-}" ||
    fail "PGHOST must be an explicit local Unix-socket directory"
  case "$PGHOST" in
    /*) ;;
    *) fail "PGHOST must be an absolute local Unix-socket directory" ;;
  esac
  test -d "$PGHOST" || fail "PGHOST directory does not exist"

  test -z "${PGHOSTADDR:-}" || fail "PGHOSTADDR is forbidden"
  test -z "${PGSERVICE:-}" || fail "PGSERVICE is forbidden"
  test -z "${PGSERVICEFILE:-}" || fail "PGSERVICEFILE is forbidden"
  test -z "${PGPASSWORD:-}" || fail "PGPASSWORD is forbidden"
  test -z "${PGPASSFILE:-}" || fail "PGPASSFILE is forbidden"

  PGPORT="${PGPORT:-5432}"
  case "$PGPORT" in
    *[!0-9]* | "") fail "PGPORT must contain ASCII decimal digits only" ;;
  esac
  test "${#PGPORT}" -le 5 || fail "PGPORT is out of range"
  ((10#$PGPORT >= 1 && 10#$PGPORT <= 65535)) ||
    fail "PGPORT is out of range"

  CURRENT_USER="$(id -un)"
  PGUSER="${PGUSER:-$CURRENT_USER}"
  test "$PGUSER" = "$CURRENT_USER" ||
    fail "PGUSER must equal the current OS user"

  test -S "$PGHOST/.s.PGSQL.$((10#$PGPORT))" ||
    fail "PGHOST does not contain the requested local PostgreSQL socket"

  export PGPORT PGUSER
}

guard_local_postgres

RANDOM_SUFFIX="$(LC_ALL=C od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
test "${#RANDOM_SUFFIX}" = "16" ||
  fail "could not generate disposable database suffix"
DB="stocks_ai_sot_$(id -u)_${RANDOM_SUFFIX}"
COLLISION_DB="${DB}_collision"
PGPASSFILE="$(mktemp)"
chmod 600 "$PGPASSFILE"
export PGPASSFILE

cleanup() {
  dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
    --if-exists "$DB" >/dev/null 2>&1 || true
  dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
    --if-exists "$COLLISION_DB" >/dev/null 2>&1 || true
  rm -f "$PGPASSFILE"
}
trap cleanup EXIT

createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password "$DB"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
  -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

test "$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
  -d "$DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "2"

DB_HOST="$PGHOST" \
DB_PORT="$PGPORT" \
DB_NAME="$DB" \
DB_USER="$PGUSER" \
DB_PASSWORD="" \
AI_RECOMMENDATION_SOT_PG=1 \
  npx ts-node --transpile-only \
  "$ROOT/tests/models/ai-recommendation-sot-v031.orm.test.ts"

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
  -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null
test "$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
  -d "$DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "0"

createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password "$COLLISION_DB"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
  -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE ai_recommendation_snapshot (stub INTEGER);' >/dev/null
if psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
  -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -f "$UP" >/dev/null 2>&1; then
  echo 'expected canonical table collision to fail closed' >&2
  exit 1
fi
if psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
  -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  echo 'expected ownership mismatch rollback to fail closed' >&2
  exit 1
fi
test "$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password \
  -d "$COLLISION_DB" -Atc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_name='ai_recommendation_snapshot' AND column_name='stub'")" = "1"

echo 'ai-recommendation-sot-v031.pg: PASS'
