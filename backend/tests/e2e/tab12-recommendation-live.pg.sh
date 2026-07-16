#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SNAPSHOT_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"
SOURCE_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-14-ai-replay-typed-source-capture.sql"

fail() {
  echo "tab12-recommendation-live.pg: $*" >&2
  exit 2
}

test "${TAB12_RECOMMENDATION_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set TAB12_RECOMMENDATION_PG_DISPOSABLE_TEST=1"
test -z "${DATABASE_URL:-}" || fail "ambient DATABASE_URL is forbidden"
test -n "${PGHOST:-}" || fail "PGHOST must be an explicit Unix-socket directory"
case "$PGHOST" in /*) ;; *) fail "PGHOST must be absolute" ;; esac
test -d "$PGHOST" || fail "PGHOST directory does not exist"
test -z "${PGSERVICE:-}" || fail "PGSERVICE is forbidden"
test -z "${PGSERVICEFILE:-}" || fail "PGSERVICEFILE is forbidden"
test -z "${PGHOSTADDR:-}" || fail "PGHOSTADDR is forbidden"
test -z "${PGPASSWORD:-}" || fail "PGPASSWORD is forbidden"
test -z "${PGPASSFILE:-}" || fail "PGPASSFILE is forbidden"
test -z "${PGDATABASE:-}" || fail "PGDATABASE is forbidden"
PGPORT="${PGPORT:-5432}"
case "$PGPORT" in *[!0-9]*|"") fail "PGPORT must use ASCII digits" ;; esac
test "$PGPORT" -ge 1 -a "$PGPORT" -le 65535 || fail "PGPORT is out of range"
test -S "$PGHOST/.s.PGSQL.$PGPORT" || fail "local PostgreSQL socket is missing"
CURRENT_USER="$(id -un)"
PGUSER="${PGUSER:-$CURRENT_USER}"
test "$PGUSER" = "$CURRENT_USER" || fail "PGUSER must equal current OS user"
export PGPORT PGUSER

SUFFIX="$(openssl rand -hex 12)"
case "$SUFFIX" in *[!0-9a-f]*|"") fail "database suffix is invalid" ;; esac
DB="stocks_tab12_live_$(id -u)_$SUFFIX"
# Atomic replay storage rejects symlinked parents. Keep all transient state
# under the real worktree path instead of macOS /var -> /private/var TMPDIR.
TEMP_ROOT="$(mktemp -d "$ROOT/.stocks-tab12-live.XXXXXX")"
chmod 700 "$TEMP_ROOT"
RUNTIME_DIR="$TEMP_ROOT/replay-runtime"
MANIFEST="$TEMP_ROOT/typed-captures.json"
ARTIFACT="$TEMP_ROOT/catdesk-recommendations.json"
SERVER_LOG="$TEMP_ROOT/backend-server.log"
PRIVATE_PGPASS="$TEMP_ROOT/pgpass"
mkdir -m 700 "$RUNTIME_DIR"
touch "$PRIVATE_PGPASS"
chmod 600 "$PRIVATE_PGPASS"
PGPASSFILE="$PRIVATE_PGPASS"
export PGPASSFILE
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)
SERVER_PID=""

cleanup() {
  if test -n "$SERVER_PID" && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill -TERM "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$SNAPSHOT_MIGRATION" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$SOURCE_MIGRATION" >/dev/null

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL UNIQUE,
  avatar_url VARCHAR(255),
  nickname VARCHAR(50),
  phone VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'user',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  risk_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO users (id, username, email, password_hash, role, is_active)
VALUES (7012, 'tab12-live-http', 'tab12-live-http@example.test', 'not-used', 'analyst', TRUE);
SQL

DATABASE_URL="$(
  TAB12_DATABASE="$DB" python3 - <<'PY'
import os
from urllib.parse import quote, urlencode

user = quote(os.environ["PGUSER"], safe="")
database = quote(os.environ["TAB12_DATABASE"], safe="")
query = urlencode({"host": os.environ["PGHOST"], "port": os.environ["PGPORT"]})
print(f"postgresql://{user}@/{database}?{query}", end="")
PY
)"

env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
  PYTHONPATH="$ROOT" \
  PYTHONDONTWRITEBYTECODE=1 \
  DATABASE_URL="$DATABASE_URL" \
  TAB12_SEED_MANIFEST="$MANIFEST" \
  python3 - <<'PY'
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
import json
import os
from pathlib import Path

from ai.replay.postgres_capture_writer import PostgresTypedCaptureWriter
from ai.replay.runtime import typed_score_fact_hash
from ai.replay.typed_capture import (
    TypedCaptureRequest,
    typed_score_record_from_json,
)


PROFILE = "us_preferred"
DIMENSIONS = ("Q", "G", "V", "M", "T", "R")
WEIGHTS = (0.2, 0.2, 0.15, 0.2, 0.15, 0.1)


def score_record(*, ticker: str, scope: str, as_of: str, currency: str, prices):
    low, high, stop, targets = prices
    features = {
        "score": {
            "profile": PROFILE,
            "market_scope": scope,
            "rating": "A",
            "total": 90.0,
            "dims": [
                {"key": key, "score": 90.0, "band": "A", "weight": weight}
                for key, weight in zip(DIMENSIONS, WEIGHTS)
            ],
        },
        "conviction": {
            "base": 90.0,
            "adjustments": [],
            "final": 90.0,
            "level": "HIGH",
        },
        "risk_gate": {"gate": "GREEN", "ok_to_enter": True, "triggers": []},
        "entry_plan": {
            "entry": {"low": low, "high": high, "currency": currency},
            "stop": {"value": stop, "currency": currency},
            "targets": [
                {"value": value, "currency": currency} for value in targets
            ],
            "size_hint": {
                "tier": "TIER_5",
                "pct": 5.0,
                "disclaimer_key": "size_hint_advisory",
                "rationale": "High conviction with an authenticated clean risk gate.",
            },
            "time_horizon": "POSITION",
            "invalidation": f"Close below {stop} {currency}.",
            "stop_distance_pct": 4.0,
        },
    }
    raw = {
        "ticker": ticker,
        "profile": PROFILE,
        "market_scope": scope,
        "as_of": as_of,
        "available_at_utc": as_of,
        "source_version": "strategy-score-v1",
        "features": features,
    }
    raw["fact_hash"] = typed_score_fact_hash(
        **{
            **raw,
            "available_at_utc": datetime.fromisoformat(
                as_of.replace("Z", "+00:00")
            ),
        }
    )
    return typed_score_record_from_json(raw)


def request(*, day: str, ticker: str, scope: str, currency: str, prices):
    as_of = f"{day}T06:30:00Z"
    score = score_record(
        ticker=ticker,
        scope=scope,
        as_of=as_of,
        currency=currency,
        prices=prices,
    )
    return TypedCaptureRequest(
        trading_day=day,
        as_of=as_of,
        profile=PROFILE,
        market_scope=scope,
        profile_version="1.0.0",
        contract_version="0.3.1",
        strategy_version="1.0.0",
        pipeline_version="1.0.0",
        source_versions={
            "signals": "signals-v1",
            "universe": "universe-v1",
            "scores": "scores-v1",
            "evidence": "evidence-v1",
        },
        filings=(),
        text_hits=(),
        scores=(score,),
    )


requests = (
    request(
        day="2026-07-14",
        ticker="600519.SH",
        scope="cn_a",
        currency="CNY",
        prices=(1450.0, 1460.0, 1400.0, (1600.0, 1750.0)),
    ),
    request(
        day="2026-07-15",
        ticker="AAPL",
        scope="us",
        currency="USD",
        prices=(195.0, 200.0, 188.0, (220.0, 240.0)),
    ),
)
writer = PostgresTypedCaptureWriter.from_env()
receipts = [writer.write(item) for item in requests]
assert all(receipt.created for receipt in receipts)
manifest = {
    "generated_from": "typed-capture-writer",
    "captures": [
        {
            "request": {
                "trading_day": item.trading_day,
                "profile": item.profile,
                "market_scope": item.market_scope,
            },
            "capture_id": receipt.capture_id,
            "ticker": item.scores[0].ticker,
            "score_fact_hash": item.scores[0].fact_hash,
            "pins": asdict(receipt.pins),
        }
        for item, receipt in zip(requests, receipts)
    ],
}
Path(os.environ["TAB12_SEED_MANIFEST"]).write_text(
    json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
    encoding="utf-8",
)
PY

DISCLAIMERS_JSON="$(
  PYTHONPATH="$ROOT" PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
import json
from ai.tests.test_postgres_typed_source_repository import _disclaimers

print(json.dumps(_disclaimers(), ensure_ascii=False, sort_keys=True, separators=(",", ":")), end="")
PY
)"

env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
  NODE_ENV=test \
  SKIP_DEFAULT_USER_INIT=true \
  JWT_SECRET=tab12-recommendation-live-http-jwt-secret \
  JWT_REFRESH_SECRET=tab12-recommendation-live-http-refresh-secret \
  DB_HOST="$PGHOST" \
  DB_PORT="$PGPORT" \
  DB_USER="$PGUSER" \
  DB_PASSWORD= \
  DB_NAME="$DB" \
  DATABASE_URL="$DATABASE_URL" \
  STOCKS_REPLAY_RUNTIME_DIR="$RUNTIME_DIR" \
  STOCKS_REPLAY_MODEL_VERSION=1.0.0 \
  STOCKS_REPLAY_TEMPLATE_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  STOCKS_REPLAY_DISCLAIMERS_JSON="$DISCLAIMERS_JSON" \
  TAB12_RECOMMENDATION_LIVE_HTTP_TEST=1 \
  TAB12_SEED_MANIFEST="$MANIFEST" \
  CATDESK_RECOMMENDATION_RESPONSE_ARTIFACT="$ARTIFACT" \
  "$ROOT/backend/node_modules/.bin/ts-node" --transpile-only \
    "$ROOT/backend/tests/e2e/tab12-recommendation-live-http.test.ts" \
    >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

READY=false
for _attempt in $(seq 1 240); do
  if test -s "$ARTIFACT"; then
    READY=true
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    cat "$SERVER_LOG" >&2
    fail "Backend live server exited before artifact readiness"
  fi
  sleep 0.25
done
test "$READY" = "true" || {
  cat "$SERVER_LOG" >&2
  fail "Backend live server did not become ready"
}

cd "$ROOT/frontend"
CATDESK_RECOMMENDATION_RESPONSE_ARTIFACT="$ARTIFACT" CI=true npm test -- \
  --watchAll=false --runInBand \
  src/pages/catdesk/tabs/morning/__tests__/tab1AShareMorningBriefLiveE2E.test.tsx \
  src/pages/catdesk/tabs/us/__tests__/tab2USStockPicksLiveE2E.test.tsx

test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  'SELECT COUNT(*) FROM ai_recommendation_snapshot')" = "2" ||
  fail "live replay did not persist two snapshots"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  'SELECT COUNT(*) FROM ai_recommendation_item')" = "2" ||
  fail "live replay did not persist two recommendation items"

kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
SERVER_PID=""
grep -q 'tab12-recommendation-live-http: READY' "$SERVER_LOG" || fail "Backend readiness log missing"
grep -q 'tab12-recommendation-live-http: STOPPED' "$SERVER_LOG" || fail "Backend shutdown log missing"

echo "tab12-recommendation-live.pg: PASS"
