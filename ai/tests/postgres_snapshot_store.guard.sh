#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="$ROOT/ai/tests/postgres_snapshot_store.pg.sh"
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

OPT_IN="SNAPSHOT_STORE_PG_DISPOSABLE_TEST=1"
expect_guard_failure no_opt_in PGHOST=/tmp
expect_guard_failure ambient_url \
  "$OPT_IN" PGHOST=/tmp DATABASE_URL=postgresql://production/stocks
expect_guard_failure hostname "$OPT_IN" PGHOST=localhost
expect_guard_failure service "$OPT_IN" PGHOST=/tmp PGSERVICE=production
expect_guard_failure service_file \
  "$OPT_IN" PGHOST=/tmp PGSERVICEFILE=/tmp/pg_service.conf
expect_guard_failure hostaddr "$OPT_IN" PGHOST=/tmp PGHOSTADDR=127.0.0.1
expect_guard_failure password "$OPT_IN" PGHOST=/tmp PGPASSWORD=secret
expect_guard_failure passfile "$OPT_IN" PGHOST=/tmp PGPASSFILE=/tmp/pass
expect_guard_failure database "$OPT_IN" PGHOST=/tmp PGDATABASE=production
expect_guard_failure bad_port "$OPT_IN" PGHOST=/tmp PGPORT=remote
expect_guard_failure wrong_user "$OPT_IN" PGHOST=/tmp PGUSER=someone-else
expect_guard_failure missing_socket "$OPT_IN" PGHOST="$TMP/missing"

EMPTY_SOCKET_DIR="$TMP/empty-socket"
mkdir "$EMPTY_SOCKET_DIR"
expect_guard_failure missing_socket_file "$OPT_IN" PGHOST="$EMPTY_SOCKET_DIR"

grep -Fq 'PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)' "$HARNESS"
grep -Fq 'openssl rand -hex 12' "$HARNESS"
grep -Fq 'chmod 600 "$PRIVATE_PGPASS"' "$HARNESS"

echo "postgres-snapshot-store.guard: PASS (zero PostgreSQL commands)"
