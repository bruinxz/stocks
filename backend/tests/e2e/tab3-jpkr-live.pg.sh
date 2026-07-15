#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MARKET_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql"
SNAPSHOT_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql"
SOURCE_MIGRATION="$ROOT/backend/scripts/migrations/2026-07-14-ai-replay-typed-source-capture.sql"

fail() {
  echo "tab3-jpkr-live.pg: $*" >&2
  exit 2
}

test "${TAB3_JPKR_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set TAB3_JPKR_PG_DISPOSABLE_TEST=1"
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
DB="stocks_tab3_live_$(id -u)_$SUFFIX"
TEMP_ROOT="$(mktemp -d "$ROOT/.stocks-tab3-live.XXXXXX")"
chmod 700 "$TEMP_ROOT"
RUNTIME_DIR="$TEMP_ROOT/replay-runtime"
MANIFEST="$TEMP_ROOT/jpkr-seed-manifest.json"
ARTIFACT="$TEMP_ROOT/tab3-jpkr-response.json"
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
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$MARKET_MIGRATION" >/dev/null
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
VALUES (7013, 'tab3-live-http', 'tab3-live-http@example.test', 'not-used', 'analyst', TRUE);
SQL

DATABASE_URL="$(
  TAB3_DATABASE="$DB" python3 - <<'PY'
import os
from urllib.parse import quote, urlencode

user = quote(os.environ["PGUSER"], safe="")
database = quote(os.environ["TAB3_DATABASE"], safe="")
query = urlencode({"host": os.environ["PGHOST"], "port": os.environ["PGPORT"]})
print(f"postgresql://{user}@/{database}?{query}", end="")
PY
)"

env -u PGPASSFILE -u PGHOST -u PGPORT -u PGUSER \
  PYTHONPATH="$ROOT" \
  PYTHONDONTWRITEBYTECODE=1 \
  DATABASE_URL="$DATABASE_URL" \
  TAB3_JPKR_SEED_MANIFEST="$MANIFEST" \
  python3 - <<'PY'
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import asdict, replace
from datetime import date, datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from ai.replay.postgres_capture_writer import PostgresTypedCaptureWriter
from ai.replay.runtime import TypedScoreRecord, typed_score_fact_hash
from ai.replay.typed_capture import TypedCaptureRequest
from datapipeline.collectors.jpkr_deep import (
    normalize_fx_rows,
    parse_boj_csv,
    parse_jpx_kline_fixture,
    parse_jpx_security_fixture,
)
from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    canonical_disclosure_fact_hash,
)
from datapipeline.contracts import (
    JpKrDisclosureRecord,
    JpKrFilingEnvelope,
    JpKrFinancialRecord,
    capture_source_version,
    validate_capture_wrapper,
)
from datapipeline.storage.jpkr import (
    FxObservationWriter,
    JpKrOfficialWriter,
    canonical_financial_fact_hash,
)


ROOT = Path(os.environ["PYTHONPATH"])
FIXTURES = ROOT / "datapipeline" / "fixtures" / "real_data_r1"
TRADING_DAY = "2026-07-13"
AS_OF_TEXT = "2026-07-13T07:30:00Z"
AS_OF = datetime(2026, 7, 13, 7, 30, tzinfo=timezone.utc)
AVAILABLE = datetime(2026, 7, 13, 6, 30, tzinfo=timezone.utc)
TICKER = "1301"
DISCLAIMER = "Controlled official-source fixture; not production real-time data."


class Result:
    def __init__(self, row):
        self._row = row

    def __getitem__(self, key):
        return self._row[key]

    def __getattr__(self, key):
        return self._row[key]


class Connection:
    def __init__(self, raw):
        self.raw = raw

    @asynccontextmanager
    async def transaction(self):
        with self.raw.transaction():
            yield

    async def fetchval(self, sql, *args):
        row = self.raw.execute(_sql(sql), args).fetchone()
        return None if row is None else next(iter(row.values()))

    async def fetchrow(self, sql, *args):
        row = self.raw.execute(_sql(sql), args).fetchone()
        if row is None:
            return None
        normalized = dict(row)
        for key, value in tuple(normalized.items()):
            if isinstance(value, datetime) and value.tzinfo is not None:
                normalized[key] = value.astimezone(timezone.utc)
        return Result(normalized)


class Pool:
    def __init__(self, url):
        self.url = url

    @asynccontextmanager
    async def acquire(self):
        with psycopg.connect(self.url, row_factory=dict_row, passfile="") as raw:
            yield Connection(raw)


def _sql(value):
    index = 0
    while f"${index + 1}" in value:
        index += 1
    for current in range(index, 0, -1):
        value = value.replace(f"${current}", "%s")
    return value


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def utc(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


async def main():
    database_url = os.environ["DATABASE_URL"]
    pool = Pool(database_url)
    official = JpKrOfficialWriter(pool)

    securities = parse_jpx_security_fixture(load("jpx_security_sample.json"))
    klines = parse_jpx_kline_fixture(load("jpx_kline_sample.json"))
    security = next(item for item in securities if item.ticker == TICKER)
    kline = next(item for item in klines if item.ticker == TICKER)
    security_result = await official.write_security(securities)
    kline_result = await official.write_klines((kline,))
    assert security_result.inserted == 3
    assert kline_result.inserted == 1

    controlled_payload = {
        "fixture_mode": "controlled-test-only",
        "production_seed_allowed": False,
        "basis": "contract-valid JP filing fixture for disposable E2E only",
    }
    disclosure_draft = JpKrDisclosureRecord(
        market_scope="jp",
        exchange="tse",
        ticker=TICKER,
        disclosure_kind="ANNUAL_REPORT",
        event_headline_local="受控テスト年次報告書",
        event_body_url=None,
        event_time_utc=datetime(2026, 7, 13, 5, 30, tzinfo=timezone.utc),
        available_at_utc=AVAILABLE,
        source_kind="jpx-edinet",
        source_document_id="CONTROLLED-EDINET-1301-20260713",
        source_version="controlled-fixture-v1",
        fact_hash="0" * 64,
        source_payload=controlled_payload,
        provider_market_label="JP",
    )
    disclosure = replace(
        disclosure_draft,
        fact_hash=canonical_disclosure_fact_hash(disclosure_draft),
    )
    disclosure_result = await official.write_disclosures((disclosure,))
    assert disclosure_result.inserted == 1

    financial_draft = JpKrFinancialRecord(
        market_scope="jp",
        exchange="tse",
        ticker=TICKER,
        fiscal_period_kind="ANNUAL",
        fiscal_period_start=date(2025, 4, 1),
        fiscal_period_end=date(2026, 3, 31),
        fiscal_quarter=None,
        currency="JPY",
        is_consolidated=True,
        revenue=Decimal("300000000000"),
        eps=Decimal("215.25"),
        net_income=Decimal("22000000000"),
        total_assets=Decimal("450000000000"),
        total_equity=Decimal("180000000000"),
        total_liabilities=Decimal("270000000000"),
        operating_cash_flow=Decimal("31000000000"),
        research_and_development=Decimal("4200000000"),
        segment_facts=(),
        taxonomy_version="controlled-edinet-taxonomy-v1",
        parser_version="controlled-parser-v1",
        account_mapping_version=None,
        concept_provenance={"fixture": "controlled-test-only"},
        parse_warnings=(),
        source_payload=controlled_payload,
        source_kind="jpx-edinet",
        source_document_id=disclosure.source_document_id,
        source_version="controlled-financial-v1",
        effective_at_utc=datetime(2026, 3, 31, 0, 0, tzinfo=timezone.utc),
        available_at_utc=AVAILABLE,
        fact_hash="0" * 64,
        provider_market_label="JP",
    )
    financial = replace(
        financial_draft,
        fact_hash=canonical_financial_fact_hash(financial_draft),
    )
    revenue_by_region = [
        {"region": "Japan", "pct": 62.5},
        {"region": "US", "pct": 37.5},
    ]
    financial_result = await official.write_financials((financial,))
    assert financial_result.inserted == 1
    with psycopg.connect(database_url, row_factory=dict_row, passfile="") as connection:
        with connection.transaction():
            connection.execute(
                """
                UPDATE jpkr_financial_snapshot
                   SET dim_moat = %s::jsonb,
                       dim_trend = %s::jsonb,
                       dim_risk = %s::jsonb,
                       coverage_pct = %s,
                       derivation_version = %s
                 WHERE market_scope = %s
                   AND ticker = %s
                   AND source_document_id = %s
                   AND source_version = %s
                """,
                (
                    json.dumps({"sector": "other", "revenue_by_region": revenue_by_region}),
                    json.dumps({"fx_beta": 0.42}),
                    json.dumps({"revenue_by_region": revenue_by_region}),
                    Decimal("100"),
                    "controlled-fixture-derivation-v1",
                    financial.market_scope,
                    financial.ticker,
                    financial.source_document_id,
                    financial.source_version,
                ),
            )
            stored_hash = connection.execute(
                "SELECT fact_hash FROM jpkr_financial_snapshot WHERE ticker=%s",
                (TICKER,),
            ).fetchone()["fact_hash"]
            assert stored_hash == financial.fact_hash

    boj_fixture = load("boj_fx_sample.json")
    boj_payload = validate_capture_wrapper(boj_fixture, expected_source_kind="BOJ")
    boj_csv = "observation_day,local_per_usd\n" + "\n".join(
        f"{row['observation_day']},{row['local_per_usd']}"
        for row in boj_payload["rows"]
    )
    fx_available = datetime(2026, 7, 13, 6, 0, tzinfo=timezone.utc)
    fx_rows = normalize_fx_rows(
        parse_boj_csv(
            boj_csv,
            available_at_utc=fx_available,
            source_document_id=("BOJ:FM08'FXERD04:" + boj_fixture["capture_instance"]),
            source_version=capture_source_version(boj_fixture),
        ),
        as_of_utc=fx_available,
    )
    fx_result = await FxObservationWriter(pool).write_batch(fx_rows, as_of_utc=fx_available)
    assert fx_result.inserted == 3
    latest_fx = max(fx_rows, key=lambda item: item.observation_day)

    filing = JpKrFilingEnvelope(disclosure, (financial,))
    features = {
        "score": {
            "profile": "japan_blue_chip",
            "market_scope": "jp",
            "rating": "A",
            "total": 91.0,
            "dims": [
                {"key": key, "score": 91.0, "band": "A", "weight": weight}
                for key, weight in zip(
                    ("Q", "G", "V", "M", "T", "R"),
                    (0.2, 0.2, 0.15, 0.2, 0.15, 0.1),
                )
            ],
        },
        "conviction": {
            "base": 91.0,
            "adjustments": [],
            "final": 91.0,
            "level": "HIGH",
        },
        "risk_gate": {
            "gate": "GREEN",
            "ok_to_enter": True,
            "triggers": [],
        },
        "entry_plan": {
            "entry": {"low": 4400.0, "high": 4550.0, "currency": "JPY"},
            "stop": {"value": 4200.0, "currency": "JPY"},
            "targets": [
                {"value": 5000.0, "currency": "JPY"},
                {"value": 5400.0, "currency": "JPY"},
            ],
            "size_hint": {
                "tier": "TIER_5",
                "pct": 5.0,
                "disclaimer_key": "size_hint_advisory",
                "rationale": "Controlled high-conviction fixture with an explicit GREEN gate.",
            },
            "time_horizon": "POSITION",
            "invalidation": "Close below 4200 JPY.",
            "stop_distance_pct": 4.5,
        },
    }
    score_values = {
        "ticker": TICKER,
        "profile": "japan_blue_chip",
        "market_scope": "jp",
        "as_of": AS_OF_TEXT,
        "available_at_utc": AS_OF,
        "source_version": "controlled-score-v1",
        "features": features,
    }
    score = TypedScoreRecord(
        **score_values,
        fact_hash=typed_score_fact_hash(**score_values),
    )
    request = TypedCaptureRequest(
        trading_day=TRADING_DAY,
        as_of=AS_OF_TEXT,
        profile="japan_blue_chip",
        market_scope="jp",
        profile_version="1.0.0",
        contract_version="0.3.1",
        strategy_version="1.0.0",
        pipeline_version="1.0.0",
        source_versions={
            "signals": "controlled-signals-v1",
            "universe": "controlled-universe-v1",
            "scores": "controlled-scores-v1",
            "evidence": "controlled-evidence-v1",
        },
        filings=(filing,),
        text_hits=(),
        scores=(score,),
    )
    receipt = PostgresTypedCaptureWriter.from_env().write(request)
    assert receipt.created

    manifest = {
        "generated_from": "controlled-official-jp-fixture",
        "fixture_disclaimer": DISCLAIMER,
        "trading_day": TRADING_DAY,
        "capture": {
            "request": {
                "trading_day": request.trading_day,
                "profile": request.profile,
                "market_scope": request.market_scope,
            },
            "capture_id": receipt.capture_id,
            "capture_hash": receipt.capture_hash,
            "ticker": TICKER,
            "score_fact_hash": score.fact_hash,
            "pins": asdict(receipt.pins),
        },
        "facts": {
            "security": {
                "count": len(securities),
                "ticker": TICKER,
                "fact_hash": security.fact_hash,
                "available_at_utc": utc(security.available_at_utc),
            },
            "kline": {
                "count": 1,
                "ticker": TICKER,
                "fact_hash": kline.fact_hash,
                "trading_day": kline.trading_day.isoformat(),
                "available_at_utc": utc(kline.available_at_utc),
            },
            "financial": {
                "count": 1,
                "fact_hash": financial.fact_hash,
                "available_at_utc": utc(financial.available_at_utc),
            },
            "disclosure": {
                "count": 1,
                "fact_hash": disclosure.fact_hash,
                "available_at_utc": utc(disclosure.available_at_utc),
                "title": disclosure.event_headline_local,
            },
            "fx": {
                "count": len(fx_rows),
                "latest_fact_hash": latest_fx.fact_hash,
                "latest_observation_day": latest_fx.observation_day.isoformat(),
                "latest_rate": float(latest_fx.local_per_usd),
                "available_at_utc": utc(latest_fx.available_at_utc),
            },
        },
    }
    Path(os.environ["TAB3_JPKR_SEED_MANIFEST"]).write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


asyncio.run(main())
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
  JWT_SECRET=tab3-jpkr-live-http-jwt-secret \
  JWT_REFRESH_SECRET=tab3-jpkr-live-http-refresh-secret \
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
  TAB3_JPKR_LIVE_HTTP_TEST=1 \
  TAB3_JPKR_SEED_MANIFEST="$MANIFEST" \
  TAB3_JPKR_RESPONSE_ARTIFACT="$ARTIFACT" \
  "$ROOT/backend/node_modules/.bin/ts-node" --transpile-only \
    "$ROOT/backend/tests/e2e/tab3-jpkr-live-http.test.ts" \
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
TAB3_JPKR_RESPONSE_ARTIFACT="$ARTIFACT" CI=true npm test -- \
  --watchAll=false --runInBand \
  src/pages/catdesk/tabs/jpkr/__tests__/tab3JpKrLiveE2E.test.tsx

test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc 'SELECT COUNT(*) FROM jpkr_security_master')" = "3" ||
  fail "security facts were not preserved"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc 'SELECT COUNT(*) FROM jpkr_financial_snapshot')" = "1" ||
  fail "financial fact was not preserved"
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc 'SELECT COUNT(*) FROM ai_recommendation_snapshot')" = "1" ||
  fail "replay snapshot was not persisted"

kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
SERVER_PID=""
grep -q 'tab3-jpkr-live-http: READY' "$SERVER_LOG" || fail "Backend readiness log missing"
grep -q 'tab3-jpkr-live-http: STOPPED' "$SERVER_LOG" || fail "Backend shutdown log missing"

echo "tab3-jpkr-live.pg: PASS"
