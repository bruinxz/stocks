#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
UP="$ROOT/backend/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"

fail() {
  echo "jpkr-official-writer.pg: $*" >&2
  exit 2
}

test "${R1_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set R1_PG_DISPOSABLE_TEST=1 to enable destructive test"
test -n "${PGHOST:-}" || fail "PGHOST must be an explicit Unix-socket directory"
case "$PGHOST" in /*) ;; *) fail "PGHOST must be absolute" ;; esac
test -d "$PGHOST" || fail "PGHOST directory does not exist"
test -z "${PGSERVICE:-}" || fail "PGSERVICE is forbidden"
test -z "${PGSERVICEFILE:-}" || fail "PGSERVICEFILE is forbidden"
test -z "${PGHOSTADDR:-}" || fail "PGHOSTADDR is forbidden"
test -z "${PGPASSWORD:-}" || fail "PGPASSWORD is forbidden"
test -z "${PGPASSFILE:-}" || fail "PGPASSFILE is forbidden"
test -z "${PGDATABASE:-}" || fail "PGDATABASE is forbidden"
PGPORT="${PGPORT:-5432}"
case "$PGPORT" in *[!0-9]*|"") fail "PGPORT must be ASCII digits" ;; esac
test "$PGPORT" -ge 1 -a "$PGPORT" -le 65535 || fail "PGPORT is out of range"
test -S "$PGHOST/.s.PGSQL.$PGPORT" || fail "local PostgreSQL socket is missing"
CURRENT_USER="$(id -un)"
PGUSER="${PGUSER:-$CURRENT_USER}"
test "$PGUSER" = "$CURRENT_USER" || fail "PGUSER must equal current OS user"
export PGPORT PGUSER

SUFFIX="$(openssl rand -hex 12)"
test "${#SUFFIX}" = "24" || fail "random suffix failed"
DB="stocks_r1_$(id -u)_$SUFFIX"
PGPASSFILE="$(mktemp "${TMPDIR:-/tmp}/stocks-r1-pgpass.XXXXXX")"
chmod 600 "$PGPASSFILE"
export PGPASSFILE
ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)
cleanup() {
  dropdb "${ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$PGPASSFILE"
}
trap cleanup EXIT

createdb "${ARGS[@]}" "$DB"
psql "${ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

DATABASE_URL="$(
  python3 - <<PY
from urllib.parse import quote, urlencode
print(
    "postgresql://"
    + quote("$PGUSER", safe="")
    + "@/"
    + quote("$DB", safe="")
    + "?"
    + urlencode({"host": "$PGHOST", "port": "$PGPORT"}),
    end="",
)
PY
)"
env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
  DATABASE_URL="$DATABASE_URL" \
  PYTHONPATH="$ROOT" \
  python3 "$ROOT/datapipeline/tests/storage/jpkr/official_writer_pg_runner.py"

echo "jpkr-official-writer.pg: PASS"
