#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SNAPSHOT_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"
SOURCE_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-14-ai-replay-typed-source-capture.sql"

fail() {
  echo "postgres-typed-replay.pg: $*" >&2
  exit 2
}

test "${TYPED_REPLAY_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set TYPED_REPLAY_PG_DISPOSABLE_TEST=1 to enable destructive test"
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

SUFFIX="$(openssl rand -hex 12)" || fail "unable to generate database suffix"
case "$SUFFIX" in *[!0-9a-f]*|"") fail "database suffix is invalid" ;; esac
test "${#SUFFIX}" = "24" || fail "database suffix length is invalid"
DB="stocks_typed_replay_$(id -u)_$SUFFIX"
PRIVATE_PGPASS="$(mktemp "${TMPDIR:-/tmp}/stocks-typed-replay.XXXXXX")"
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
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -f "$SNAPSHOT_MIGRATION" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -f "$SOURCE_MIGRATION" >/dev/null

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

env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
  DATABASE_URL="$DATABASE_URL" \
  TYPED_REPLAY_PG_INTEGRATION=1 \
  python3 -m unittest -v ai.tests.test_postgres_typed_source_repository

echo "postgres-typed-replay.pg: PASS"
