#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="$ROOT/strategy/tests/postgres_candidate_store.pg.sh"
TMP="$(mktemp -d)"
LOG="$TMP/commands.log"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

for command in createdb dropdb psql; do
  cat >"$TMP/$command" <<MOCK
#!/usr/bin/env bash
echo "$command \$*" >>"$LOG"
exit 99
MOCK
  chmod +x "$TMP/$command"
done

expect_guard_failure() {
  name="$1"
  shift
  : >"$LOG"
  if env -i PATH="$TMP:/usr/bin:/bin" HOME="${HOME:-/tmp}" \
    USER="$(id -un)" "$@" bash "$HARNESS" >/dev/null 2>&1; then
    echo "guard case unexpectedly passed: $name" >&2
    exit 1
  fi
  test ! -s "$LOG" || {
    echo "guard case executed PostgreSQL command: $name" >&2
    cat "$LOG" >&2
    exit 1
  }
}

OPT_IN="R2_CANDIDATE_PG_DISPOSABLE_TEST=1"
expect_guard_failure no_opt_in R2_LOCAL_PG_SOCKET=/tmp
expect_guard_failure ambient_url \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp \
  R2_CANDIDATE_DATABASE_URL=postgresql://production/stocks
expect_guard_failure relative_socket "$OPT_IN" R2_LOCAL_PG_SOCKET=tmp
expect_guard_failure service \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp PGSERVICE=production
expect_guard_failure service_file \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp PGSERVICEFILE=/tmp/pg_service.conf
expect_guard_failure host \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp PGHOST=production
expect_guard_failure hostaddr \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp PGHOSTADDR=127.0.0.1
expect_guard_failure password \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp PGPASSWORD=secret
expect_guard_failure passfile \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp PGPASSFILE=/tmp/pass
expect_guard_failure database \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp PGDATABASE=production
expect_guard_failure wrong_user \
  "$OPT_IN" R2_LOCAL_PG_SOCKET=/tmp PGUSER=someone-else

EMPTY_SOCKET_DIR="$TMP/empty-socket"
mkdir "$EMPTY_SOCKET_DIR"
expect_guard_failure missing_socket \
  "$OPT_IN" R2_LOCAL_PG_SOCKET="$EMPTY_SOCKET_DIR"

grep -Fq 'PG_ARGS=(-h "$R2_LOCAL_PG_SOCKET" -p 5432 -U "$PG_USER" --no-password)' \
  "$HARNESS"
grep -Fq 'openssl rand -hex 12' "$HARNESS"
grep -Fq 'passfile=""' "$ROOT/strategy/materialization/postgres_candidate_store.py"

echo "postgres-candidate-store.guard: PASS (zero PostgreSQL commands)"
