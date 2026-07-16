#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SNAPSHOT_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"
SOURCE_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-14-ai-replay-typed-source-capture.sql"

fail() {
  echo "tab67-total-live.pg: $*" >&2
  exit 2
}

test "${T67_TOTAL_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set T67_TOTAL_PG_DISPOSABLE_TEST=1"
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
DB="stocks_t67_total_$(id -u)_$SUFFIX"
# The atomic replay store rejects any symlink in its parent chain. macOS
# TMPDIR traverses /var -> /private/var, so keep this private temp root under
# the real repository path, matching the existing replay live harness.
TEMP_ROOT="$(mktemp -d "$ROOT/.stocks-t67-total.XXXXXX")"
chmod 700 "$TEMP_ROOT"
RUNTIME_DIR="$TEMP_ROOT/replay-runtime"
MANIFEST="$TEMP_ROOT/typed-captures.json"
ARTIFACT="$TEMP_ROOT/tab67-live-artifact.json"
SERVER_LOG="$TEMP_ROOT/backend-server.log"
DUPLICATE_STDOUT="$TEMP_ROOT/duplicate.stdout"
DUPLICATE_STDERR="$TEMP_ROOT/duplicate.stderr"
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

# Minimal real auth table for AuthController.findByPk. This exists only in the
# disposable database and is never synchronized to any ambient database.
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
VALUES (7006, 't67-live-http', 't67-live-http@example.test', 'not-used', 'analyst', TRUE);
SQL

DATABASE_URL="$(
  T67_DATABASE="$DB" python3 - <<'PY'
import os
from urllib.parse import quote, urlencode

user = quote(os.environ["PGUSER"], safe="")
database = quote(os.environ["T67_DATABASE"], safe="")
query = urlencode({"host": os.environ["PGHOST"], "port": os.environ["PGPORT"]})
print(f"postgresql://{user}@/{database}?{query}", end="")
PY
)"

env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
  PYTHONPATH="$ROOT" \
  PYTHONDONTWRITEBYTECODE=1 \
  DATABASE_URL="$DATABASE_URL" \
  T67_SEED_MANIFEST="$MANIFEST" \
  python3 - <<'PY'
from __future__ import annotations

import copy
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path

from ai.replay.postgres_capture_writer import PostgresTypedCaptureWriter
from ai.replay.runtime import typed_score_fact_hash
from ai.replay.service import ReplaySourceError
from ai.replay.typed_capture import (
    TypedCaptureRequest,
    prepare_typed_capture,
    typed_score_record_from_json,
)
from ai.tests.test_postgres_typed_source_repository import _score_json


PROFILE = "us_preferred"
SCOPE = "us"
DAYS = ("2026-07-08", "2026-07-09", "2026-07-10")
TOTALS = (86.0, 90.0, 94.0)


def score_record(as_of: str, total: float, *, profile: str = PROFILE, scope: str = SCOPE):
    raw = copy.deepcopy(_score_json(profile, scope))
    raw["as_of"] = as_of
    raw["available_at_utc"] = as_of
    raw["features"]["score"]["total"] = total
    raw["features"]["score"]["dims"] = [
        {"key": key, "score": total, "band": "A", "weight": weight}
        for key, weight in zip(
            ("Q", "G", "V", "M", "T", "R"),
            (0.2, 0.2, 0.15, 0.2, 0.15, 0.1),
        )
    ]
    raw["features"]["conviction"].update(
        {"base": total, "final": total, "level": "HIGH"}
    )
    raw["features"]["entry_plan"]["size_hint"].update(
        {"tier": "TIER_5", "pct": 5.0}
    )
    raw["fact_hash"] = typed_score_fact_hash(
        ticker=raw["ticker"],
        profile=raw["profile"],
        market_scope=raw["market_scope"],
        as_of=raw["as_of"],
        available_at_utc=datetime.fromisoformat(as_of.replace("Z", "+00:00")),
        source_version=raw["source_version"],
        features=raw["features"],
    )
    return typed_score_record_from_json(raw)


def request(day: str, total: float) -> TypedCaptureRequest:
    as_of = f"{day}T06:30:00Z"
    return TypedCaptureRequest(
        trading_day=day,
        as_of=as_of,
        profile=PROFILE,
        market_scope=SCOPE,
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
        scores=(score_record(as_of, total),),
    )


requests = [request(day, total) for day, total in zip(DAYS, TOTALS)]
writer = PostgresTypedCaptureWriter.from_env()
receipts = [writer.write(item) for item in requests]
assert all(receipt.created for receipt in receipts)
repeated = writer.write(requests[0])
assert not repeated.created
assert repeated.capture_id == receipts[0].capture_id

negative = {}


def must_reject(label: str, candidate: TypedCaptureRequest) -> None:
    try:
        prepare_typed_capture(candidate)
    except ReplaySourceError:
        negative[label] = True
        return
    raise AssertionError(f"negative typed capture was accepted: {label}")


base = requests[0]
base_score = base.scores[0]
future_time = datetime.fromisoformat(base.as_of.replace("Z", "+00:00")) + timedelta(seconds=1)
future_score = replace(base_score, available_at_utc=future_time, fact_hash="0" * 64)
future_score = replace(
    future_score,
    fact_hash=typed_score_fact_hash(
        ticker=future_score.ticker,
        profile=future_score.profile,
        market_scope=future_score.market_scope,
        as_of=future_score.as_of,
        available_at_utc=future_score.available_at_utc,
        source_version=future_score.source_version,
        features=future_score.features,
    ),
)
must_reject("future_source", replace(base, scores=(future_score,)))

wrong_scope_score = score_record(base.as_of, 86.0, profile="japan_blue_chip", scope="jp")
must_reject("wrong_scope", replace(base, scores=(wrong_scope_score,)))
must_reject("malformed_hash", replace(base, scores=(replace(base_score, fact_hash="g" * 64),)))
must_reject("duplicate_fact", replace(base, scores=(base_score, base_score)))
negative["idempotent_capture"] = True

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
            "pins": asdict(receipt.pins),
        }
        for item, receipt in zip(requests, receipts)
    ],
    "negative": negative,
}
Path(os.environ["T67_SEED_MANIFEST"]).write_text(
    json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
    encoding="utf-8",
)
PY

test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  'SELECT COUNT(*) FROM ai_replay_typed_source_capture')" = "3"

# Strict replay CLI duplicate-key rejection is exercised in a real child process.
set +e
printf '%s' \
  '{"protocol_version":"1.0.0","op":"status","op":"run_one","job_id":"11111111-1111-4111-8111-111111111111"}' |
  env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
    PYTHONPATH="$ROOT" \
    PYTHONDONTWRITEBYTECODE=1 \
    STOCKS_REPLAY_RUNTIME_DIR="$RUNTIME_DIR" \
    python3 -m ai.replay.cli >"$DUPLICATE_STDOUT" 2>"$DUPLICATE_STDERR"
DUPLICATE_STATUS=$?
set -e
test "$DUPLICATE_STATUS" = "2" || fail "duplicate JSON returned $DUPLICATE_STATUS"
test ! -s "$DUPLICATE_STDOUT" || fail "duplicate JSON wrote stdout"
T67_DUPLICATE_STDERR="$DUPLICATE_STDERR" python3 - <<'PY'
import json
import os
from pathlib import Path

payload = json.loads(Path(os.environ["T67_DUPLICATE_STDERR"]).read_text(encoding="utf-8"))
assert payload == {
    "protocol_version": "1.0.0",
    "ok": False,
    "error": {"code": "INVALID_JSON", "message": "invalid replay request"},
}
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
  JWT_SECRET=t67-total-live-http-jwt-secret \
  JWT_REFRESH_SECRET=t67-total-live-http-refresh-secret \
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
  T67_TOTAL_LIVE_HTTP_TEST=1 \
  T67_SEED_MANIFEST="$MANIFEST" \
  T67_RESPONSE_ARTIFACT="$ARTIFACT" \
  "$ROOT/backend/node_modules/.bin/ts-node" --transpile-only \
    "$ROOT/backend/tests/e2e/tab67-total-live-http.test.ts" \
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
T67_RESPONSE_ARTIFACT="$ARTIFACT" CI=true npm test -- --watchAll=false --runInBand \
  src/pages/catdesk/tabs/daily-report/__tests__/tab67TotalLiveE2E.test.tsx

test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  'SELECT COUNT(*) FROM ai_recommendation_snapshot')" = "3" ||
  fail "Frontend Generate did not persist the third snapshot"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  'SELECT COUNT(*) FROM ai_recommendation_item')" = "3" ||
  fail "Frontend Generate did not persist the third item"

T67_JOB_STORE="$RUNTIME_DIR/replay_jobs.json" python3 - <<'PY'
import json
import os
from pathlib import Path

state = json.loads(Path(os.environ["T67_JOB_STORE"]).read_text(encoding="utf-8"))
jobs = state["jobs"]
assert len(jobs) == 3, jobs
assert {job["status"] for job in jobs.values()} == {"completed"}, jobs
assert all("snapshot_id" in job for job in jobs.values()), jobs
PY

kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
SERVER_PID=""
grep -q 'tab67-total-live-http: READY' "$SERVER_LOG" || fail "Backend readiness log missing"
grep -q 'tab67-total-live-http: STOPPED' "$SERVER_LOG" || fail "Backend shutdown log missing"

echo "tab67-total-live.pg: PASS"
