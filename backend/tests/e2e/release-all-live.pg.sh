#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
SOCKET_DIR="${RELEASE_PG_SOCKET_DIR:-}"
PORT="${RELEASE_PGPORT:-5432}"
OS_USER="$(id -un)"

fail() {
  echo "release-all-live.pg: $*" >&2
  exit 2
}

case "$PORT" in
  *[!0-9]*|"") fail "RELEASE_PGPORT must use ASCII digits" ;;
esac
test "$PORT" -ge 1 -a "$PORT" -le 65535 || fail "port out of range"
test -n "$SOCKET_DIR" || fail "RELEASE_PG_SOCKET_DIR must explicitly name a private Unix-socket directory"
case "$SOCKET_DIR" in
  /*) ;;
  *) fail "RELEASE_PG_SOCKET_DIR must be absolute" ;;
esac
test -d "$SOCKET_DIR" || fail "socket directory does not exist: $SOCKET_DIR"
test "$(cd "$SOCKET_DIR" && pwd -P)" = "$SOCKET_DIR" ||
  fail "socket directory must not resolve through a symlink"
test "${#SOCKET_DIR}" -le 70 || fail "socket directory path is too long"
test -O "$SOCKET_DIR" || fail "socket directory must belong to the current user"
test -z "$(find "$SOCKET_DIR" -prune -perm -022 -print)" ||
  fail "socket directory must not be group/world writable"
test -S "$SOCKET_DIR/.s.PGSQL.$PORT" ||
  fail "PostgreSQL socket missing: $SOCKET_DIR/.s.PGSQL.$PORT"

SCRUB=(
  -u DATABASE_URL
  -u PGHOST
  -u PGHOSTADDR
  -u PGPORT
  -u PGUSER
  -u PGDATABASE
  -u PGPASSWORD
  -u PGPASSFILE
  -u PGSERVICE
  -u PGSERVICEFILE
  -u PGOPTIONS
  -u DB_HOST
  -u DB_PORT
  -u DB_USER
  -u DB_PASSWORD
  -u DB_NAME
  -u DB_SSL
  -u JWT_SECRET
  -u JWT_REFRESH_SECRET
  -u ENABLE_SECURE_COOKIE
  -u STOCKS_REPLAY_RUNTIME_DIR
  -u STOCKS_REPLAY_MODEL_VERSION
  -u STOCKS_REPLAY_TEMPLATE_HASH
  -u STOCKS_REPLAY_DISCLAIMERS_JSON
  -u STOCKS_REPLAY_PYTHON
  -u STOCKS_REPLAY_CLI_TIMEOUT_MS
  -u STOCKS_REPLAY_HTTP_WAIT_MS
  -u STOCKS_REPLAY_CONTROL_TIMEOUT_MS
  -u STOCKS_REPLAY_WORKER_DEADLINE_SECONDS
  -u STOCKS_REPLAY_LEASE_SECONDS
  -u STOCKS_REPLAY_MAX_CONCURRENCY
  -u STOCKS_REPLAY_MAX_QUEUE_DEPTH
  -u STOCKS_REPLAY_SUBMIT_RATE_PER_MINUTE
  -u STOCKS_REPLAY_STATUS_RATE_PER_MINUTE
  -u STOCKS_REPLAY_RATE_MAX_USERS
  -u AUTH_REFRESH_SESSION_PG_DISPOSABLE_TEST
  -u RECOMMENDATION_REPLAY_PG_DISPOSABLE_TEST
  -u TAB12_RECOMMENDATION_PG_DISPOSABLE_TEST
  -u TAB3_JPKR_PG_DISPOSABLE_TEST
  -u TAB4_PG_DISPOSABLE_TEST
  -u T5D_PG_DISPOSABLE_TEST
  -u T67_TOTAL_PG_DISPOSABLE_TEST
)

TRANSPORT="$(
  env "${SCRUB[@]}" \
    PGHOST="$SOCKET_DIR" PGPORT="$PORT" PGUSER="$OS_USER" \
    psql -X --no-password -d template1 -Atqc \
      "SELECT CASE WHEN inet_server_addr() IS NULL THEN 'unix' ELSE 'tcp' END"
)"
test "$TRANSPORT" = "unix" || fail "connection did not use a Unix socket"

run_harness() {
  local label="$1"
  local guard="$2"
  local relative_script="$3"

  test -r "$ROOT/$relative_script" || fail "missing $relative_script"
  echo "=== START $label ==="

  if env "${SCRUB[@]}" \
      PGHOST="$SOCKET_DIR" \
      PGPORT="$PORT" \
      PGUSER="$OS_USER" \
      DB_HOST="$SOCKET_DIR" \
      DB_PORT="$PORT" \
      DB_USER="$OS_USER" \
      DB_PASSWORD= \
      DB_SSL=false \
      DB_NAME=__release_runner_requires_disposable_db__ \
      TMPDIR="$SOCKET_DIR" \
      PYTHONDONTWRITEBYTECODE=1 \
      "${guard}=1" \
      bash "$ROOT/$relative_script"; then
    echo "=== PASS  $label ==="
  else
    local status=$?
    echo "=== FAIL  $label status=$status ===" >&2
    exit "$status"
  fi
}

run_harness \
  "recommendation replay" \
  "RECOMMENDATION_REPLAY_PG_DISPOSABLE_TEST" \
  "backend/tests/e2e/recommendation-replay-live.pg.sh"

run_harness \
  "Tab1/2 recommendation" \
  "TAB12_RECOMMENDATION_PG_DISPOSABLE_TEST" \
  "backend/tests/e2e/tab12-recommendation-live.pg.sh"

run_harness \
  "Tab3 JP/KR" \
  "TAB3_JPKR_PG_DISPOSABLE_TEST" \
  "backend/tests/e2e/tab3-jpkr-live.pg.sh"

run_harness \
  "Tab4 multibagger" \
  "TAB4_PG_DISPOSABLE_TEST" \
  "backend/tests/e2e/tab4-multibagger-live.pg.sh"

run_harness \
  "Tab5 six-month PIT" \
  "T5D_PG_DISPOSABLE_TEST" \
  "backend/tests/e2e/tab5-six-month-live.pg.sh"

run_harness \
  "Tab6/7 total" \
  "T67_TOTAL_PG_DISPOSABLE_TEST" \
  "backend/tests/e2e/tab67-total-live.pg.sh"

run_harness \
  "auth refresh-session migration" \
  "AUTH_REFRESH_SESSION_PG_DISPOSABLE_TEST" \
  "backend/tests/models/auth-refresh-session.pg.sh"

echo "release-all-live.pg: ALL PASS"
