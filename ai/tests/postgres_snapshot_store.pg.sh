#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UP="$ROOT/backend/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"

fail() {
  echo "postgres-snapshot-store.pg: $*" >&2
  exit 2
}

guard_local_postgres() {
  test "${SNAPSHOT_STORE_PG_DISPOSABLE_TEST:-}" = "1" ||
    fail "set SNAPSHOT_STORE_PG_DISPOSABLE_TEST=1 to enable destructive test"
  test -z "${DATABASE_URL:-}" ||
    fail "ambient DATABASE_URL is forbidden in disposable test"
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
    *[!0-9]*|"") fail "PGPORT must contain ASCII digits only" ;;
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
test "${#RANDOM_SUFFIX}" = "24" ||
  fail "random database suffix length is invalid"
DB="stocks_snapshot_store_$(id -u)_$RANDOM_SUFFIX"
PRIVATE_PGPASS="$(mktemp "${TMPDIR:-/tmp}/stocks-snapshot-pgpass.XXXXXX")"
chmod 600 "$PRIVATE_PGPASS"
PGPASS_MODE="$(
  stat -f '%Lp' "$PRIVATE_PGPASS" 2>/dev/null ||
    stat -c '%a' "$PRIVATE_PGPASS"
)"
test "$PGPASS_MODE" = "600" ||
  fail "private PGPASSFILE must have mode 0600"
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

DATABASE_URL="$(
  SNAPSHOT_DB="$DB" python3 - <<'PY'
import os
from urllib.parse import quote, urlencode

user = quote(os.environ["PGUSER"], safe="")
database = quote(os.environ["SNAPSHOT_DB"], safe="")
query = urlencode({"host": os.environ["PGHOST"], "port": os.environ["PGPORT"]})
print(f"postgresql://{user}@/{database}?{query}", end="")
PY
)"

env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
  DATABASE_URL="$DATABASE_URL" \
  SNAPSHOT_PG_INTEGRATION=1 \
  python3 -m unittest -v ai.tests.test_postgres_snapshot_store

echo "postgres-snapshot-store.pg: PASS"
