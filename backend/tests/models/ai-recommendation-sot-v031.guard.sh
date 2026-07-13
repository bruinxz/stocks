#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="$ROOT/tests/models/ai-recommendation-sot-v031.pg.sh"
TMP="$(mktemp -d)"
LOG="$TMP/postgres-commands.log"

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

OPT_IN="AI_RECOMMENDATION_SOT_PG_DISPOSABLE_TEST=1"

expect_guard_failure no_opt_in PGHOST=/tmp
expect_guard_failure no_host "$OPT_IN"
expect_guard_failure hostname "$OPT_IN" PGHOST=localhost
expect_guard_failure ipv4 "$OPT_IN" PGHOST=127.0.0.1
expect_guard_failure relative "$OPT_IN" PGHOST=tmp
expect_guard_failure hostaddr "$OPT_IN" PGHOST=/tmp PGHOSTADDR=127.0.0.1
expect_guard_failure service "$OPT_IN" PGHOST=/tmp PGSERVICE=remote
expect_guard_failure service_file \
  "$OPT_IN" PGHOST=/tmp PGSERVICEFILE=/tmp/pg_service.conf
expect_guard_failure password "$OPT_IN" PGHOST=/tmp PGPASSWORD=secret
expect_guard_failure passfile "$OPT_IN" PGHOST=/tmp PGPASSFILE=/tmp/pass
expect_guard_failure alpha_port "$OPT_IN" PGHOST=/tmp PGPORT=remote
expect_guard_failure unicode_port "$OPT_IN" PGHOST=/tmp PGPORT=５４３２
expect_guard_failure zero_port "$OPT_IN" PGHOST=/tmp PGPORT=0
expect_guard_failure high_port "$OPT_IN" PGHOST=/tmp PGPORT=65536
expect_guard_failure long_port "$OPT_IN" PGHOST=/tmp PGPORT=000001
expect_guard_failure wrong_user "$OPT_IN" PGHOST=/tmp PGUSER=someone-else
expect_guard_failure missing_directory \
  "$OPT_IN" PGHOST="$TMP/missing"
expect_guard_failure missing_socket "$OPT_IN" PGHOST="$TMP"

echo "ai-recommendation-sot-v031.guard: PASS (18 unsafe cases, zero PostgreSQL commands)"
