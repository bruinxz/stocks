#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SNAPSHOT_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"
SOURCE_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-14-ai-replay-typed-source-capture.sql"

fail() {
  echo "recommendation-replay-live.pg: $*" >&2
  exit 2
}

test "${RECOMMENDATION_REPLAY_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set RECOMMENDATION_REPLAY_PG_DISPOSABLE_TEST=1"
test -z "${DATABASE_URL:-}" || fail "ambient DATABASE_URL is forbidden"
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
case "$PGPORT" in *[!0-9]*|"") fail "PGPORT must use ASCII digits" ;; esac
test "$PGPORT" -ge 1 -a "$PGPORT" -le 65535 || fail "PGPORT is out of range"
test -S "$PGHOST/.s.PGSQL.$PGPORT" || fail "local PostgreSQL socket is missing"
CURRENT_USER="$(id -un)"
PGUSER="${PGUSER:-$CURRENT_USER}"
test "$PGUSER" = "$CURRENT_USER" || fail "PGUSER must equal current OS user"
export PGPORT PGUSER

SUFFIX="$(openssl rand -hex 12)"
case "$SUFFIX" in *[!0-9a-f]*|"") fail "database suffix is invalid" ;; esac
DB="stocks_replay_http_$(id -u)_$SUFFIX"
PRIVATE_PGPASS="$(mktemp "${TMPDIR:-/tmp}/stocks-replay-http.XXXXXX")"
RUNTIME_DIR="$(mktemp -d "$ROOT/.stocks-replay-http.XXXXXX")"
chmod 600 "$PRIVATE_PGPASS"
chmod 700 "$RUNTIME_DIR"
PGPASSFILE="$PRIVATE_PGPASS"
export PGPASSFILE
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$PRIVATE_PGPASS"
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$SNAPSHOT_MIGRATION" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$SOURCE_MIGRATION" >/dev/null

DATABASE_URL="$(
  TYPED_REPLAY_DB="$DB" python3 - <<'PY'
import os
from urllib.parse import quote, urlencode

user = quote(os.environ["PGUSER"], safe="")
database = quote(os.environ["TYPED_REPLAY_DB"], safe="")
query = urlencode({"host": os.environ["PGHOST"], "port": os.environ["PGPORT"]})
print(f"postgresql://{user}@/{database}?{query}", end="")
PY
)"

DISCLAIMERS_JSON="$(
  PYTHONPATH="$ROOT" PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
import json
from ai.tests.test_postgres_typed_source_repository import _disclaimers

print(json.dumps(_disclaimers(), ensure_ascii=False, sort_keys=True, separators=(",", ":")), end="")
PY
)"

EXPECTED_INPUT_FINGERPRINT="$(
  env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
    PYTHONPATH="$ROOT" \
    PYTHONDONTWRITEBYTECODE=1 \
    DATABASE_URL="$DATABASE_URL" \
    python3 - <<'PY'
from ai.replay.postgres_capture_writer import PostgresTypedCaptureWriter
from ai.tests.test_postgres_typed_source_repository import _capture_request

receipt = PostgresTypedCaptureWriter.from_env().write(_capture_request())
assert receipt.created
print(receipt.pins.input_fingerprint, end="")
PY
)"
case "$EXPECTED_INPUT_FINGERPRINT" in
  *[!0-9a-f]*|"") fail "seeded input fingerprint is invalid" ;;
esac
test "${#EXPECTED_INPUT_FINGERPRINT}" = "64" || fail "seeded input fingerprint length is invalid"

(
  cd "$ROOT/backend"
  env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
    NODE_ENV=test \
    JWT_SECRET=recommendation-replay-live-http-jwt-secret \
    JWT_REFRESH_SECRET=recommendation-replay-live-http-refresh-secret \
    DATABASE_URL="$DATABASE_URL" \
    STOCKS_REPLAY_RUNTIME_DIR="$RUNTIME_DIR" \
    STOCKS_REPLAY_MODEL_VERSION=1.0.0 \
    STOCKS_REPLAY_TEMPLATE_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    STOCKS_REPLAY_DISCLAIMERS_JSON="$DISCLAIMERS_JSON" \
    EXPECTED_INPUT_FINGERPRINT="$EXPECTED_INPUT_FINGERPRINT" \
    RECOMMENDATION_REPLAY_PG_INTEGRATION=1 \
    npx ts-node --transpile-only tests/e2e/recommendation-replay-live-http.test.ts
)

echo "recommendation-replay-live.pg: PASS"
