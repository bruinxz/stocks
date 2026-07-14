#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
UP="$ROOT/backend/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"

fail() {
  echo "backtest-pit-writer.pg: $*" >&2
  exit 2
}

test "${PIT_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set PIT_PG_DISPOSABLE_TEST=1 to enable destructive test"
test -n "${PGHOST:-}" || fail "PGHOST must be explicit"
case "$PGHOST" in /*) ;; *) fail "PGHOST must be absolute Unix socket dir" ;; esac
test -d "$PGHOST" || fail "PGHOST dir missing"
test -z "${PGHOSTADDR:-}" || fail "PGHOSTADDR forbidden"
test -z "${PGSERVICE:-}" || fail "PGSERVICE forbidden"
test -z "${PGSERVICEFILE:-}" || fail "PGSERVICEFILE forbidden"
test -z "${PGPASSWORD:-}" || fail "PGPASSWORD forbidden"
test -z "${PGPASSFILE:-}" || fail "PGPASSFILE forbidden"
test -z "${PGDATABASE:-}" || fail "PGDATABASE forbidden"

PGPORT="${PGPORT:-5432}"
case "$PGPORT" in *[!0-9]*|"") fail "PGPORT invalid" ;; esac
test "$PGPORT" -ge 1 -a "$PGPORT" -le 65535 || fail "PGPORT out of range"
test -S "$PGHOST/.s.PGSQL.$PGPORT" || fail "local PostgreSQL socket missing"
CURRENT_USER="$(id -un)"
PGUSER="${PGUSER:-$CURRENT_USER}"
test "$PGUSER" = "$CURRENT_USER" || fail "PGUSER must equal current OS user"

SUFFIX="$(openssl rand -hex 12)"
case "$SUFFIX" in *[!0-9a-f]*|"") fail "random suffix invalid" ;; esac
test "${#SUFFIX}" = 24 || fail "random suffix length invalid"
DB="stocks_pit_writer_$(id -u)_$SUFFIX"
PRIVATE_PGPASS="$(mktemp "${TMPDIR:-/tmp}/stocks-pit-pgpass.XXXXXX")"
chmod 600 "$PRIVATE_PGPASS"
MODE="$(
  stat -f '%Lp' "$PRIVATE_PGPASS" 2>/dev/null ||
    stat -c '%a' "$PRIVATE_PGPASS"
)"
test "$MODE" = 600 || fail "private passfile mode must be 0600"
export PGPASSFILE="$PRIVATE_PGPASS"
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$PRIVATE_PGPASS"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null
PYTHONPATH="${T5B_ROOT:+$T5B_ROOT:}$ROOT" \
PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER="$PGUSER" PGDATABASE="$DB" \
  /usr/bin/python3 \
  "$ROOT/datapipeline/tests/storage/backtest_pit/test_writer.pg.py"
