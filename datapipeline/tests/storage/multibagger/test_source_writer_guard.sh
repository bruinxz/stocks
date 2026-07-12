#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HARNESS="$ROOT/datapipeline/tests/storage/multibagger/test_source_writer.pg.sh"
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

expect_guard_failure no_opt_in PGHOST=/tmp
expect_guard_failure hostname \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=localhost
expect_guard_failure service \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=/tmp PGSERVICE=remote
expect_guard_failure service_file \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=/tmp PGSERVICEFILE=/tmp/pg_service.conf
expect_guard_failure hostaddr \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=/tmp PGHOSTADDR=127.0.0.1
expect_guard_failure password \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=/tmp PGPASSWORD=secret
expect_guard_failure passfile \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=/tmp PGPASSFILE=/tmp/pass
expect_guard_failure database \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=/tmp PGDATABASE=foreign
expect_guard_failure bad_port \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=/tmp PGPORT=remote
expect_guard_failure wrong_user \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST=/tmp PGUSER=someone-else
expect_guard_failure missing_socket \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST="$TMP/missing"

EMPTY_SOCKET_DIR="$TMP/empty-socket"
mkdir "$EMPTY_SOCKET_DIR"
expect_guard_failure missing_socket_file \
  MULTIBAGGER_PG_DISPOSABLE_TEST=1 PGHOST="$EMPTY_SOCKET_DIR"

grep -Fq 'PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)' "$HARNESS"
test "$(grep -F ' "${PG_ARGS[@]}"' "$HARNESS" | wc -l | tr -d ' ')" -ge 4
grep -Fq 'openssl rand -hex 12' "$HARNESS"
grep -Fq 'chmod 600 "$PRIVATE_PGPASS"' "$HARNESS"

echo "multibagger-source-writer.guard: PASS (zero PostgreSQL commands)"
