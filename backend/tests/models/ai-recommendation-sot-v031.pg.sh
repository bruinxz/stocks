#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UP="$ROOT/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"
DOWN="$ROOT/scripts/migrations/2026-07-12-ai-recommendation-sot-v031-rollback.sql"
PGHOST="${PGHOST:-/tmp}"
DB="stocks_ai_recommendation_sot_${USER:-agent}_$$"
COLLISION_DB="${DB}_collision"

cleanup() {
  dropdb -h "$PGHOST" --if-exists "$DB" >/dev/null 2>&1 || true
  dropdb -h "$PGHOST" --if-exists "$COLLISION_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb -h "$PGHOST" "$DB"
psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "2"

DB_HOST="$PGHOST" \
DB_PORT="${PGPORT:-5432}" \
DB_NAME="$DB" \
DB_USER="${PGUSER:-${USER:-agent}}" \
DB_PASSWORD="${PGPASSWORD:-}" \
AI_RECOMMENDATION_SOT_PG=1 \
  npx ts-node --transpile-only \
  "$ROOT/tests/models/ai-recommendation-sot-v031.orm.test.ts"

psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null
test "$(psql -h "$PGHOST" -d "$DB" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "0"

createdb -h "$PGHOST" "$COLLISION_DB"
psql -h "$PGHOST" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE ai_recommendation_snapshot (stub INTEGER);' >/dev/null
if psql -h "$PGHOST" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -f "$UP" >/dev/null 2>&1; then
  echo 'expected canonical table collision to fail closed' >&2
  exit 1
fi
if psql -h "$PGHOST" -d "$COLLISION_DB" -v ON_ERROR_STOP=1 \
  -f "$DOWN" >/dev/null 2>&1; then
  echo 'expected ownership mismatch rollback to fail closed' >&2
  exit 1
fi
test "$(psql -h "$PGHOST" -d "$COLLISION_DB" -Atc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_name='ai_recommendation_snapshot' AND column_name='stub'")" = "1"

echo 'ai-recommendation-sot-v031.pg: PASS'
