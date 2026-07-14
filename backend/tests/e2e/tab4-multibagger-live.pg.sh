#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PHASE1="$ROOT/backend/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"
PROVENANCE="$ROOT/backend/scripts/migrations/2026-07-14-multibagger-classification-provenance.sql"
TEXT_HIT_PROVENANCE="$ROOT/backend/scripts/migrations/2026-07-14-multibagger-text-hit-provenance.sql"
TEXT_HIT_ROLLBACK="$ROOT/backend/scripts/migrations/2026-07-14-multibagger-text-hit-provenance-rollback.sql"

fail() {
  echo "tab4-multibagger-live.pg: $*" >&2
  exit 2
}

test "${TAB4_PG_DISPOSABLE_TEST:-}" = "1" || fail "set TAB4_PG_DISPOSABLE_TEST=1"
test -n "${PGHOST:-}" || fail "PGHOST must be explicit"
case "$PGHOST" in /*) ;; *) fail "PGHOST must be an absolute Unix socket dir" ;; esac
test -d "$PGHOST" || fail "PGHOST dir missing"
test -z "${PGHOSTADDR:-}" || fail "PGHOSTADDR forbidden"
test -z "${PGSERVICE:-}" || fail "PGSERVICE forbidden"
test -z "${PGSERVICEFILE:-}" || fail "PGSERVICEFILE forbidden"
test -z "${PGPASSWORD:-}" || fail "PGPASSWORD forbidden"
test -z "${PGPASSFILE:-}" || fail "PGPASSFILE forbidden"
test -z "${PGDATABASE:-}" || fail "PGDATABASE forbidden"
PGPORT="${PGPORT:-5432}"
case "$PGPORT" in *[!0-9]*|"") fail "PGPORT invalid" ;; esac
test -S "$PGHOST/.s.PGSQL.$PGPORT" || fail "local PostgreSQL socket missing"
CURRENT_USER="$(id -un)"
PGUSER="${PGUSER:-$CURRENT_USER}"
test "$PGUSER" = "$CURRENT_USER" || fail "PGUSER must equal OS user"

SUFFIX="$(openssl rand -hex 12)"
case "$SUFFIX" in *[!0-9a-f]*|"") fail "random suffix invalid" ;; esac
DB="stocks_tab4_$(id -u)_$SUFFIX"
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)
ARTIFACT="$ROOT/backend/tests/e2e/tab4-multibagger-live-responses.json"

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$ARTIFACT"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$PHASE1" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$PROVENANCE" >/dev/null

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO multibagger_text_hit (
  market_scope, ticker, source_kind, source_document_id,
  document_fact_hash, taxonomy_version, term_id, hit_kind,
  language, field, start_offset, end_offset, context_hash,
  effective_at_utc, available_at_utc
) VALUES (
  'jp', 'LEGACY', 'legacy', 'legacy-doc', repeat('a', 64),
  'legacy-taxonomy', 'legacy-term', 'OPTIONALITY', 'ja', 'TITLE',
  0, 1, repeat('b', 64), '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
);
SQL
if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -f "$TEXT_HIT_PROVENANCE" >/dev/null 2>&1; then
  fail "text-hit migration accepted a lossy legacy row"
fi
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM multibagger_text_hit WHERE ticker = 'LEGACY'" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$TEXT_HIT_PROVENANCE" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$TEXT_HIT_ROLLBACK" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$TEXT_HIT_PROVENANCE" >/dev/null

TAB4_DATABASE_URL="postgresql://${PGUSER}@/${DB}?host=${PGHOST}&port=${PGPORT}" \
  PYTHONPATH="$ROOT" python3 -m strategy.tests.tab4_live_seed

DB_HOST="$PGHOST" DB_PORT="$PGPORT" DB_USER="$PGUSER" DB_PASSWORD="" \
DB_NAME="$DB" NODE_ENV=test SKIP_DEFAULT_USER_INIT=true \
TAB4_LIVE_HTTP_TEST=1 \
TAB4_RESPONSE_ARTIFACT="$(basename "$ARTIFACT")" \
  "$ROOT/backend/node_modules/.bin/ts-node" --transpile-only \
  "$ROOT/backend/tests/e2e/tab4-multibagger-live-http.test.ts"

test -s "$ARTIFACT" || fail "HTTP response artifact missing"
cd "$ROOT/frontend"
TAB4_RESPONSE_ARTIFACT="$ARTIFACT" CI=true npm test -- --watchAll=false --runInBand \
  src/pages/catdesk/tabs/multibagger/__tests__/tab4MultibaggerLiveE2E.test.tsx

echo "tab4-multibagger-live.pg: PASS"
