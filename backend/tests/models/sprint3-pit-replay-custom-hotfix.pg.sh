#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_UP="$ROOT/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"
BASE_DOWN="$ROOT/scripts/migrations/2026-07-11-sprint3-market-storage-phase1-rollback.sql"
HOTFIX_UP="$ROOT/scripts/migrations/2026-07-12-pit-replay-custom-hotfix.sql"
HOTFIX_DOWN="$ROOT/scripts/migrations/2026-07-12-pit-replay-custom-hotfix-rollback.sql"
PGHOST="${PGHOST:-/tmp}"
DB="stocks_pit_custom_hotfix_${USER:-agent}_$$"

cleanup() {
  dropdb -h "$PGHOST" --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb -h "$PGHOST" "$DB"
psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$BASE_UP" >/dev/null
psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$HOTFIX_UP" >/dev/null

DB_HOST="$PGHOST" \
DB_PORT="${PGPORT:-5432}" \
DB_NAME="$DB" \
DB_USER="${PGUSER:-${USER:-agent}}" \
DB_PASSWORD="${PGPASSWORD:-}" \
PIT_HOTFIX_PG=1 \
  npx ts-node --transpile-only \
  "$ROOT/tests/models/sprint3-pit-replay-custom-hotfix.test.ts"

psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO backtest_pit_snapshot (
  strategy, market_scope, as_of_utc, snapshot_day, is_survivorship_biased,
  source_versions, lineage_closure, metrics, fact_hash
) VALUES
  ('us_preferred', 'us', '2026-07-10T11:00:00Z', '2026-07-10', TRUE,
   '{"prices":"v1"}', '{}', '{}', repeat('b', 64)),
  ('multibagger', 'cn_a', '2026-07-10T11:01:00Z', '2026-07-10', TRUE,
   '{"prices":"v1"}', '{}', '{}', repeat('c', 64)),
  ('japan_blue_chip', 'jp', '2026-07-10T11:02:00Z', '2026-07-10', TRUE,
   '{"prices":"v1"}', '{}', '{}', repeat('d', 64)),
  ('japan_multibagger', 'jp', '2026-07-10T11:03:00Z', '2026-07-10', TRUE,
   '{"prices":"v1"}', '{}', '{}', repeat('e', 64)),
  ('korea_semiconductor_chain', 'kr', '2026-07-10T11:04:00Z', '2026-07-10', TRUE,
   '{"prices":"v1"}', '{}', '{}', repeat('f', 64)),
  ('korea_multibagger', 'kr', '2026-07-10T11:05:00Z', '2026-07-10', TRUE,
   '{"prices":"v1"}', '{}', '{}', repeat('0', 64));
SQL

test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM backtest_pit_snapshot")" = "6"

psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$HOTFIX_DOWN" >/dev/null
psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$BASE_DOWN" >/dev/null

echo 'sprint3-pit-replay-custom-hotfix.pg: PASS'
