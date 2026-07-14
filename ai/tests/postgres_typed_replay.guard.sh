#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="$ROOT/ai/tests/postgres_typed_replay.pg.sh"
TMP="$(mktemp -d)"
LOG="$TMP/commands.log"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

for command in createdb dropdb psql; do
  script="$TMP/$command"
  printf '%s\n' '#!/usr/bin/env bash' \
    "echo '$command' \"\$*\" >>'$LOG'" 'exit 99' >"$script"
  chmod +x "$script"
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
    exit 1
  }
}

OPT_IN="TYPED_REPLAY_PG_DISPOSABLE_TEST=1"
expect_guard_failure no_opt_in PGHOST=/tmp
expect_guard_failure ambient_url \
  "$OPT_IN" PGHOST=/tmp DATABASE_URL=postgresql://production/stocks
expect_guard_failure hostname "$OPT_IN" PGHOST=localhost
expect_guard_failure service "$OPT_IN" PGHOST=/tmp PGSERVICE=production
expect_guard_failure hostaddr "$OPT_IN" PGHOST=/tmp PGHOSTADDR=127.0.0.1
expect_guard_failure password "$OPT_IN" PGHOST=/tmp PGPASSWORD=secret
expect_guard_failure database "$OPT_IN" PGHOST=/tmp PGDATABASE=production
expect_guard_failure bad_port "$OPT_IN" PGHOST=/tmp PGPORT=remote
expect_guard_failure wrong_user "$OPT_IN" PGHOST=/tmp PGUSER=someone-else

echo "postgres-typed-replay.guard: PASS (zero PostgreSQL commands)"
