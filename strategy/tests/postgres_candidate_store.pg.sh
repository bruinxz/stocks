#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  echo "postgres-candidate-store.pg: $*" >&2
  exit 2
}

test "${R2_CANDIDATE_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set R2_CANDIDATE_PG_DISPOSABLE_TEST=1 to enable destructive test"
test -z "${R2_CANDIDATE_DATABASE_URL:-}" ||
  fail "ambient R2_CANDIDATE_DATABASE_URL is forbidden"
: "${R2_LOCAL_PG_SOCKET:?R2_LOCAL_PG_SOCKET must explicitly name a local Unix socket}"
case "$R2_LOCAL_PG_SOCKET" in
  /*) ;;
  *) fail "R2_LOCAL_PG_SOCKET must be absolute" ;;
esac
test -d "$R2_LOCAL_PG_SOCKET" || fail "socket directory does not exist"
test -S "$R2_LOCAL_PG_SOCKET/.s.PGSQL.5432" ||
  fail "socket directory does not contain local PostgreSQL"
for variable in PGDATABASE PGHOST PGHOSTADDR PGPASSFILE PGPASSWORD PGSERVICE PGSERVICEFILE
do
  test -z "${!variable:-}" || fail "$variable is forbidden"
done
CURRENT_USER="$(id -un)"
PG_USER="${PGUSER:-$CURRENT_USER}"
test "$PG_USER" = "$CURRENT_USER" || fail "PGUSER must equal the current OS user"
RANDOM_SUFFIX="$(openssl rand -hex 12)" ||
  fail "unable to generate random database suffix"
case "$RANDOM_SUFFIX" in
  *[!0-9a-f]*|"") fail "random database suffix is invalid" ;;
esac
test "${#RANDOM_SUFFIX}" = "24" || fail "random database suffix length is invalid"
DB="stocks_r2_candidate_$(id -u)_$RANDOM_SUFFIX"
PG_ARGS=(-h "$R2_LOCAL_PG_SOCKET" -p 5432 -U "$PG_USER" --no-password)

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT/backend/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql" \
  >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT/backend/scripts/migrations/2026-07-12-pit-replay-custom-hotfix.sql" \
  >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT/backend/scripts/migrations/2026-07-14-multibagger-classification-provenance.sql" \
  >/dev/null

export R2_CANDIDATE_DATABASE_URL="postgresql://${PG_USER}@/$(printf %s "$DB")?host=$(printf %s "$R2_LOCAL_PG_SOCKET")&port=5432"
cd "$ROOT"
python3 -m strategy.tests.postgres_candidate_store_pg
