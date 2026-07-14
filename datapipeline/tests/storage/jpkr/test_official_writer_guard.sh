#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HARNESS="$ROOT/datapipeline/tests/storage/jpkr/test_official_writer.pg.sh"
TMP="$(mktemp -d)"
LOG="$TMP/commands.log"
trap 'rm -rf "$TMP"' EXIT

for command in createdb dropdb psql; do
  cat >"$TMP/$command" <<MOCK
#!/usr/bin/env bash
echo "$command \$*" >>"$LOG"
exit 99
MOCK
  chmod +x "$TMP/$command"
done

reject() {
  : >"$LOG"
  if env -i PATH="$TMP:/usr/bin:/bin" HOME="${HOME:-/tmp}" USER="$(id -un)" \
    "$@" bash "$HARNESS" >/dev/null 2>&1; then
    echo "unsafe environment unexpectedly passed" >&2
    exit 1
  fi
  test ! -s "$LOG" || {
    cat "$LOG" >&2
    exit 1
  }
}

OPT="R1_PG_DISPOSABLE_TEST=1"
reject PGHOST=/tmp
reject "$OPT" PGHOST=localhost
reject "$OPT" PGHOST=/tmp PGSERVICE=prod
reject "$OPT" PGHOST=/tmp PGPASSWORD=secret
reject "$OPT" PGHOST=/tmp PGPASSFILE=/tmp/pass
reject "$OPT" PGHOST=/tmp PGDATABASE=prod
reject "$OPT" PGHOST=/tmp PGPORT=remote
reject "$OPT" PGHOST=/tmp PGUSER=other
reject "$OPT" PGHOST="$TMP/missing"
mkdir "$TMP/empty"
reject "$OPT" PGHOST="$TMP/empty"

echo "jpkr-official-writer.guard: PASS (zero PostgreSQL commands)"
