from __future__ import annotations

import copy
from contextlib import nullcontext
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
import uuid

from ai.pipeline.replay_adapter import PipelineReplayAdapter, ReplayPipelinePolicy
from ai.replay.postgres_repository import (
    CAPTURE_COLUMNS,
    SELECT_CAPTURE,
    PostgresTypedSourceRepository,
    TypedSourceRepositoryConfigurationError,
    _snapshot_from_capture,
    typed_financial_fact_hash,
    typed_scan_document_fact_hash,
    typed_source_capture_hash,
    typed_text_context_hash,
)
from ai.replay.runtime import (
    TypedReplaySources,
    build_typed_replay_runtime,
    typed_score_fact_hash,
)
from ai.replay.file_store import AtomicFileReplayJobStore
from ai.replay.service import PROFILE_MARKET_SCOPES, ReplayPinsError, ReplaySourceError
from ai.replay.types import ReplayInputs, ReplayPins
from ai.snapshot.fingerprint import compute_input_fingerprint, jcs_canonicalize
from ai.snapshot.postgres_store import PostgresSnapshotStore
from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    canonical_disclosure_fact_hash,
)
from datapipeline.contracts import JpKrDisclosureRecord


NOW = datetime(2026, 7, 10, 6, 30, tzinfo=timezone.utc)
NOW_TEXT = "2026-07-10T06:30:00Z"


class _Repository:
    def __init__(self, snapshot):
        self.snapshot = snapshot

    def load(self, _pins):
        return self.snapshot


class _CountingRepository:
    def __init__(self, repository):
        self.repository = repository
        self.calls = 0

    def load(self, pins):
        self.calls += 1
        return self.repository.load(pins)


class _Cursor:
    def __init__(self, rows, calls):
        self.rows = rows
        self.calls = calls

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, parameters=None):
        self.calls.append((sql, parameters))

    def fetchall(self):
        return self.rows


class _Connection:
    def __init__(self, rows, calls):
        self.rows = rows
        self.calls = calls
        self.closed = False

    def transaction(self):
        return nullcontext()

    def cursor(self):
        return _Cursor(self.rows, self.calls)

    def close(self):
        self.closed = True


class _Connector:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []
        self.connections = []

    def __call__(self, database_url):
        self.calls.append(database_url)
        connection = _Connection(self.rows, [])
        self.connections.append(connection)
        return connection


def _disclosure_json():
    values = {
        "market_scope": "jp",
        "exchange": "tse",
        "ticker": "7203",
        "disclosure_kind": "ANNUAL_REPORT",
        "event_headline_local": "annual report",
        "event_body_url": None,
        "event_time_utc": "2026-07-10T06:00:00Z",
        "available_at_utc": NOW_TEXT,
        "source_kind": "jpx-edinet",
        "source_document_id": "EDINET-1",
        "source_version": "filing-v1",
        "fact_hash": "0" * 64,
        "source_payload": {},
        "provider_market_label": "JP",
    }
    record = JpKrDisclosureRecord(
        **{
            **values,
            "event_time_utc": datetime.fromisoformat(
                values["event_time_utc"].replace("Z", "+00:00")
            ),
            "available_at_utc": NOW,
        }
    )
    values["fact_hash"] = canonical_disclosure_fact_hash(record)
    return values


def _financial_json():
    values = {
        "market_scope": "jp",
        "exchange": "tse",
        "ticker": "7203",
        "fiscal_period_kind": "ANNUAL",
        "fiscal_period_start": "2025-07-11",
        "fiscal_period_end": "2026-07-10",
        "fiscal_quarter": None,
        "currency": "JPY",
        "is_consolidated": True,
        "revenue": "1000",
        "eps": "10",
        "net_income": "100",
        "total_assets": "5000",
        "total_equity": "2500",
        "total_liabilities": "2500",
        "operating_cash_flow": "120",
        "research_and_development": "25",
        "segment_facts": [],
        "taxonomy_version": "taxonomy-v1",
        "parser_version": "parser-v1",
        "account_mapping_version": None,
        "concept_provenance": {},
        "parse_warnings": [],
        "source_payload": {},
        "source_kind": "jpx-edinet",
        "source_document_id": "EDINET-1",
        "source_version": "financial-v1",
        "effective_at_utc": "2026-07-10T00:00:00Z",
        "available_at_utc": NOW_TEXT,
        "fact_hash": "0" * 64,
        "provider_market_label": "JP",
    }
    values["fact_hash"] = typed_financial_fact_hash(values)
    return values


def _text_hit_json():
    document = {
        "document_id": "EDINET-NEWS-1",
        "ticker": "7203",
        "market": "JP",
        "market_scope": "jp",
        "language": "ja",
        "title": "capacity expansion",
        "body": "capacity expansion plan",
        "published_at_utc": "2026-07-10T06:00:00Z",
        "available_at_utc": NOW_TEXT,
        "source_kind": "official-disclosure",
        "source_url": None,
        "document_fact_hash": "0" * 64,
    }
    document["document_fact_hash"] = typed_scan_document_fact_hash(document)
    hit = {
        "term_id": "capacity",
        "hit_kind": "EARLY_NEWS",
        "document_id": document["document_id"],
        "ticker": "7203",
        "language": "ja",
        "field": "TITLE",
        "start_offset": 0,
        "end_offset": 8,
        "context_hash": typed_text_context_hash("capacity"),
        "taxonomy_version": "taxonomy-v1",
    }
    return {"document": document, "hit": hit}


def _features(profile="japan_blue_chip", market_scope="jp"):
    return {
        "score": {
            "profile": profile,
            "market_scope": market_scope,
            "rating": "A",
            "total": 90.0,
            "dims": [
                {"key": "Q", "score": 90.0, "band": "A", "weight": 1.0}
            ],
        },
        "conviction": {
            "base": 80.0,
            "adjustments": [],
            "final": 80.0,
            "level": "HIGH",
        },
        "risk_gate": {"gate": "GREEN", "ok_to_enter": True, "triggers": []},
        "entry_plan": {
            "size_hint": {
                "tier": "TIER_3",
                "pct": 3.0,
                "disclaimer_key": "size_hint_advisory",
            },
            "stop_distance_pct": 4.0,
        },
    }


def _score_json(profile="japan_blue_chip", market_scope="jp"):
    values = {
        "ticker": "7203",
        "profile": profile,
        "market_scope": market_scope,
        "as_of": NOW_TEXT,
        "available_at_utc": NOW_TEXT,
        "source_version": "score-v1",
        "features": _features(profile, market_scope),
    }
    values["fact_hash"] = typed_score_fact_hash(
        **{
            **values,
            "available_at_utc": NOW,
        }
    )
    return values


def _base_pins(**overrides):
    values = {
        "trading_day": "2026-07-10",
        "as_of": NOW_TEXT,
        "profile": "japan_blue_chip",
        "market_scope": "jp",
        "profile_version": "1.0.0",
        "contract_version": "0.3.1",
        "input_fingerprint": "0" * 64,
        "strategy_version": "1.0.0",
        "pipeline_version": "1.0.0",
    }
    values.update(overrides)
    return ReplayPins(**values)


def _capture_row(*, pins=None, mutate=None):
    pins = pins or _base_pins()
    source_versions = {
        "signals": "signals-v1",
        "universe": "universe-v1",
        "scores": "scores-v1",
        "evidence": "evidence-v1",
    }
    filings = [
        {"disclosure": _disclosure_json(), "financials": [_financial_json()]}
    ]
    text_hits = [_text_hit_json()]
    scores = [_score_json(pins.profile, pins.market_scope)]
    provisional = {
        "capture_id": "12345678-1234-4234-8234-567812345678",
        "trading_day": date.fromisoformat(pins.trading_day),
        "as_of_utc": NOW,
        "profile": pins.profile,
        "market_scope": pins.market_scope,
        "profile_version": pins.profile_version,
        "contract_version": pins.contract_version,
        "input_fingerprint": pins.input_fingerprint,
        "strategy_version": pins.strategy_version,
        "pipeline_version": pins.pipeline_version,
        "available_at_utc": NOW,
        "source_versions": source_versions,
        "filings_json": filings,
        "text_hits_json": text_hits,
        "scores_json": scores,
        "capture_hash": "0" * 64,
    }
    snapshot = _snapshot_from_capture(
        {
            **provisional,
            "capture_hash": typed_source_capture_hash(
                pins=pins,
                available_at_utc=NOW_TEXT,
                source_versions=source_versions,
                filings=filings,
                text_hits=text_hits,
                scores=scores,
            ),
        },
        pins,
    )
    sources = TypedReplaySources(_Repository(snapshot))
    fingerprint = sources.input_fingerprint(pins)
    pins = replace(pins, input_fingerprint=fingerprint)
    row = {
        **provisional,
        "input_fingerprint": fingerprint,
        "capture_hash": typed_source_capture_hash(
            pins=pins,
            available_at_utc=NOW_TEXT,
            source_versions=source_versions,
            filings=filings,
            text_hits=text_hits,
            scores=scores,
        ),
    }
    if mutate is not None:
        mutate(row)
    return pins, row


def _disclaimer():
    full_text = "research only"
    return {
        "version": "1.0.0",
        "short_text": "research only",
        "full_text": full_text,
        "language": "zh-CN",
        "effective_at": "2026-01-01T00:00:00Z",
        "hash": hashlib.sha256(full_text.encode()).hexdigest(),
    }


class PostgresTypedSourceRepositoryTests(unittest.TestCase):
    def test_one_exact_query_loads_all_typed_sources(self):
        pins, row = _capture_row()
        connector = _Connector([row])
        repository = PostgresTypedSourceRepository(
            "postgresql://stocks@/test?host=/tmp", connector=connector
        )

        snapshot = repository.load(pins)

        self.assertEqual(len(connector.calls), 1)
        connection = connector.connections[0]
        self.assertTrue(connection.closed)
        self.assertEqual(len(connection.calls), 2)
        self.assertIn("REPEATABLE READ READ ONLY", connection.calls[0][0])
        self.assertEqual(connection.calls[1][0], SELECT_CAPTURE)
        self.assertEqual(
            connection.calls[1][1],
            (
                pins.trading_day,
                pins.as_of,
                pins.profile,
                pins.market_scope,
                pins.profile_version,
                pins.contract_version,
                pins.input_fingerprint,
                pins.strategy_version,
                pins.pipeline_version,
                pins.as_of,
            ),
        )
        self.assertEqual(len(snapshot.filings), 1)
        self.assertEqual(len(snapshot.text_hits), 1)
        self.assertEqual(len(snapshot.scores), 1)
        self.assertEqual(set(row), set(CAPTURE_COLUMNS))

    def test_hash_tamper_missing_and_duplicate_capture_fail_closed(self):
        pins, row = _capture_row()
        tampered = copy.deepcopy(row)
        tampered["scores_json"][0]["features"]["score"]["total"] = 89.0
        cases = ([tampered], [], [row, row])
        for rows in cases:
            with self.subTest(count=len(rows)):
                repository = PostgresTypedSourceRepository(
                    "postgresql://stocks@/test?host=/tmp",
                    connector=_Connector(rows),
                )
                with self.assertRaises(ReplaySourceError):
                    repository.load(pins)

    def test_invalid_and_custom_pairs_fail_before_connection(self):
        connector = _Connector([])
        repository = PostgresTypedSourceRepository(
            "postgresql://stocks@/test?host=/tmp", connector=connector
        )
        profiles = (*PROFILE_MARKET_SCOPES, "custom")
        scopes = ("cn_a", "us", "jp", "kr")
        invalid = [
            _base_pins(profile=profile, market_scope=scope)
            for profile in profiles
            for scope in scopes
            if profile not in PROFILE_MARKET_SCOPES
            or scope not in PROFILE_MARKET_SCOPES[profile]
        ]
        self.assertGreaterEqual(len(invalid), 16)
        for pins in invalid:
            with self.subTest(profile=pins.profile, scope=pins.market_scope):
                with self.assertRaises(ReplayPinsError):
                    repository.load(pins)
        self.assertEqual(connector.calls, [])

    def test_environment_and_connection_errors_are_fail_closed(self):
        with self.assertRaises(TypedSourceRepositoryConfigurationError):
            PostgresTypedSourceRepository.from_env({})
        with self.assertRaises(TypedSourceRepositoryConfigurationError):
            PostgresTypedSourceRepository.from_env(
                {
                    "DATABASE_URL": "postgresql://stocks@/test?host=/tmp",
                    "PGSERVICE": "production",
                }
            )

    def test_adapter_maps_all_four_slices_without_snapshot_side_effects(self):
        pins, row = _capture_row()
        snapshot = _snapshot_from_capture(row, pins)
        inputs = TypedReplaySources(_Repository(snapshot)).load_inputs(pins)
        mapped = PipelineReplayAdapter._map_inputs(pins, inputs)

        self.assertTrue(mapped.signals)
        self.assertEqual(mapped.universe, ("7203",))
        self.assertEqual(set(mapped.scores), {"7203"})
        kinds = {ref["kind"] for ref in mapped.evidence_refs["7203"]}
        self.assertEqual(kinds, {"SCORE_INPUT", "DISCLOSURE", "NEWS"})

        snapshot_connector = _Connector([])
        store = PostgresSnapshotStore(
            "postgresql://stocks@/test?host=/tmp",
            connector=snapshot_connector,
        )
        adapter = PipelineReplayAdapter(
            snapshot_store=store,
            policy=ReplayPipelinePolicy(
                model_version="1.0.0",
                template_hash="a" * 64,
                disclaimer=_disclaimer(),
            ),
        )
        invalid = replace(pins, profile="custom")
        with self.assertRaises(ReplayPinsError):
            adapter.run(invalid, inputs)
        self.assertEqual(snapshot_connector.calls, [])

    def test_future_evidence_with_resealed_slices_fails_before_store(self):
        pins, row = _capture_row()
        snapshot = _snapshot_from_capture(row, pins)
        inputs = TypedReplaySources(_Repository(snapshot)).load_inputs(pins)
        evidence_records = copy.deepcopy(inputs.evidence.records)
        signal_records = copy.deepcopy(inputs.signals.records)
        future = NOW + timedelta(seconds=1)
        future_text = future.strftime("%Y-%m-%dT%H:%M:%SZ")

        evidence_record = next(
            item for item in evidence_records if item["kind"] == "text_hit"
        )
        document = evidence_record["envelope"]["document"]
        document["available_at_utc"] = future_text
        document["document_fact_hash"] = typed_scan_document_fact_hash(document)
        evidence_record["identity"][0] = document["document_fact_hash"]
        signal_record = next(
            item for item in signal_records if item["kind"] == "text_hit"
        )
        signal_record["available_at_utc"] = future_text
        signal_record["fact_hash"] = document["document_fact_hash"]

        def reseal(source, records):
            return replace(
                source,
                records=records,
                content_hash=hashlib.sha256(
                    jcs_canonicalize(records).encode("utf-8")
                ).hexdigest(),
            )

        modified = ReplayInputs(
            signals=reseal(inputs.signals, signal_records),
            universe=inputs.universe,
            scores=inputs.scores,
            evidence=reseal(inputs.evidence, evidence_records),
        )
        pins = replace(
            pins,
            input_fingerprint=compute_input_fingerprint(
                [source.content_hash for source in modified.ordered()]
            ),
        )
        connector = _Connector([])
        adapter = PipelineReplayAdapter(
            snapshot_store=PostgresSnapshotStore(
                "postgresql://stocks@/test?host=/tmp",
                connector=connector,
            ),
            policy=ReplayPipelinePolicy(
                model_version="1.0.0",
                template_hash="a" * 64,
                disclaimer=_disclaimer(),
            ),
        )

        with self.assertRaisesRegex(ReplaySourceError, "PIT cutoff"):
            adapter.run(pins, modified)
        self.assertEqual(connector.calls, [])


@unittest.skipUnless(
    os.environ.get("TYPED_REPLAY_PG_INTEGRATION") == "1",
    "requires explicitly guarded disposable PostgreSQL",
)
class PostgresTypedSourceRepositoryIntegrationTests(unittest.TestCase):
    def setUp(self):
        import psycopg

        with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
            connection.execute(
                "TRUNCATE ai_recommendation_item, "
                "ai_recommendation_snapshot, "
                "ai_replay_typed_source_capture CASCADE"
            )

    @staticmethod
    def _insert(row):
        import psycopg
        from psycopg.types.json import Jsonb

        values = []
        for column in CAPTURE_COLUMNS:
            value = row[column]
            if column in {
                "source_versions",
                "filings_json",
                "text_hits_json",
                "scores_json",
            }:
                value = Jsonb(value)
            values.append(value)
        placeholders = ", ".join(["%s"] * len(CAPTURE_COLUMNS))
        with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
            connection.execute(
                "INSERT INTO ai_replay_typed_source_capture ("
                + ", ".join(CAPTURE_COLUMNS)
                + f") VALUES ({placeholders})",
                values,
            )

    def test_real_pipeline_persists_and_reads_final_snapshot(self):
        pins, row = _capture_row()
        self._insert(row)
        repository = PostgresTypedSourceRepository.from_env()
        snapshot_store = PostgresSnapshotStore.from_env()
        adapter = PipelineReplayAdapter(
            snapshot_store=snapshot_store,
            policy=ReplayPipelinePolicy(
                model_version="1.0.0",
                template_hash="a" * 64,
                disclaimer=_disclaimer(),
            ),
        )
        counted_repository = _CountingRepository(repository)
        test_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(dir=test_root) as directory:
            service, worker, _ = build_typed_replay_runtime(
                repository=counted_repository,
                pipeline=adapter,
                job_store=AtomicFileReplayJobStore(
                    Path(directory) / "jobs.json"
                ),
                uuid_factory=lambda: uuid.UUID(
                    "12345678-1234-4234-8234-567812345678"
                ),
                clock=lambda: NOW_TEXT,
            )
            completed = worker.run_job(service.submit(pins).job_id)

        self.assertEqual(completed.status, "completed", completed)
        self.assertEqual(counted_repository.calls, 1)
        persisted = snapshot_store.get_snapshot(completed.snapshot_id)
        self.assertIsNotNone(persisted)
        self.assertEqual(
            persisted.output_fingerprint, completed.output_fingerprint
        )
        self.assertEqual(persisted.input_fingerprint, pins.input_fingerprint)
        self.assertEqual(persisted.item_count, 1)
        items = snapshot_store.get_items(completed.snapshot_id)
        self.assertEqual([item.ticker for item in items], ["7203"])
        self.assertTrue(items[0].recommendation_json["evidence_refs"])

        repeat_inputs = TypedReplaySources(repository).load_inputs(pins)
        repeated = adapter.run(pins, repeat_inputs)
        self.assertEqual(repeated.snapshot_id, completed.snapshot_id)
        self.assertEqual(
            repeated.output_fingerprint,
            completed.output_fingerprint,
        )
        import psycopg

        with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
            snapshot_count = connection.execute(
                "SELECT COUNT(*) FROM ai_recommendation_snapshot"
            ).fetchone()[0]
            item_count = connection.execute(
                "SELECT COUNT(*) FROM ai_recommendation_item"
            ).fetchone()[0]
        self.assertEqual((snapshot_count, item_count), (1, 1))

    def test_future_score_fails_before_snapshot_effects(self):
        pins, row = _capture_row()
        pins = replace(pins, input_fingerprint="1" * 64)
        row["input_fingerprint"] = pins.input_fingerprint
        future = NOW + timedelta(seconds=1)
        future_text = future.strftime("%Y-%m-%dT%H:%M:%SZ")
        score = row["scores_json"][0]
        score["available_at_utc"] = future_text
        score["fact_hash"] = typed_score_fact_hash(
            ticker=score["ticker"],
            profile=score["profile"],
            market_scope=score["market_scope"],
            as_of=score["as_of"],
            available_at_utc=future,
            source_version=score["source_version"],
            features=score["features"],
        )
        row["capture_hash"] = typed_source_capture_hash(
            pins=pins,
            available_at_utc=NOW_TEXT,
            source_versions=row["source_versions"],
            filings=row["filings_json"],
            text_hits=row["text_hits_json"],
            scores=row["scores_json"],
        )
        self._insert(row)
        snapshot_store = PostgresSnapshotStore.from_env()
        adapter = PipelineReplayAdapter(
            snapshot_store=snapshot_store,
            policy=ReplayPipelinePolicy(
                model_version="1.0.0",
                template_hash="a" * 64,
                disclaimer=_disclaimer(),
            ),
        )
        test_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(dir=test_root) as directory:
            service, worker, _ = build_typed_replay_runtime(
                repository=PostgresTypedSourceRepository.from_env(),
                pipeline=adapter,
                job_store=AtomicFileReplayJobStore(
                    Path(directory) / "jobs.json"
                ),
                uuid_factory=lambda: uuid.UUID(
                    "22345678-1234-4234-8234-567812345678"
                ),
                clock=lambda: NOW_TEXT,
            )
            failed = worker.run_job(service.submit(pins).job_id)

        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertEqual(
            snapshot_store.list_snapshots(
                profile=pins.profile,
                market_scope=pins.market_scope,
            ),
            (),
        )


if __name__ == "__main__":
    unittest.main()
