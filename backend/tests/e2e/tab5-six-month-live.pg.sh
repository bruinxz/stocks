#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
UP="$ROOT/backend/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"

fail() {
  echo "tab5-six-month-live.pg: $*" >&2
  exit 2
}

test "${T5D_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set T5D_PG_DISPOSABLE_TEST=1"
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
test "$PGUSER" = "$CURRENT_USER" || fail "PGUSER must equal OS user"
PYTHON_BIN="${TAB5_PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || fail "Python interpreter is unavailable"

SUFFIX="$(openssl rand -hex 12)"
case "$SUFFIX" in *[!0-9a-f]*|"") fail "random suffix invalid" ;; esac
DB="stocks_t5d_$(id -u)_$SUFFIX"
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)
ARTIFACT="$ROOT/backend/tests/e2e/tab5-six-month-live-responses.json"

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$ARTIFACT"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

PYTHONPATH="$ROOT" PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER="$PGUSER" \
PGDATABASE="$DB" "$PYTHON_BIN" \
  "$ROOT/datapipeline/tests/storage/backtest_pit/test_writer.pg.py"

DB_HOST="$PGHOST" DB_PORT="$PGPORT" DB_USER="$PGUSER" DB_PASSWORD="" \
DB_NAME="$DB" NODE_ENV=test SKIP_DEFAULT_USER_INIT=true \
JWT_SECRET=tab5-six-month-live-http-jwt-secret \
JWT_REFRESH_SECRET=tab5-six-month-live-http-refresh-secret \
T5D_LIVE_HTTP_TEST=1 \
T5D_RESPONSE_ARTIFACT="$(basename "$ARTIFACT")" \
  "$ROOT/backend/node_modules/.bin/ts-node" --transpile-only \
  "$ROOT/backend/tests/e2e/tab5-six-month-live-http.test.ts"

test -s "$ARTIFACT" || fail "HTTP response artifact missing"

cd "$ROOT/frontend"
T5D_RESPONSE_ARTIFACT="$ARTIFACT" CI=true npm test -- --watchAll=false --runInBand \
  src/pages/catdesk/tabs/backtest/__tests__/tab5SixMonthLiveE2E.test.tsx

echo "tab5-six-month-live.pg: PASS"
