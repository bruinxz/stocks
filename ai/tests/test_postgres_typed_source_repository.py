from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import tempfile
import traceback
import unittest
import uuid

from ai.pipeline.replay_adapter import (
    PipelineReplayAdapter,
    ReplayPipelinePolicy,
    _parse_replay_utc_seconds,
    _parse_source_utc,
)
from ai.replay.postgres_repository import (
    CAPTURE_COLUMNS,
    SELECT_CAPTURE,
    PostgresTypedSourceRepository,
    TypedSourceRepositoryConfigurationError,
    TypedSourceRepositoryReadError,
    _snapshot_from_capture,
)
from ai.replay.postgres_capture_writer import PostgresTypedCaptureWriter
from ai.replay.typed_capture import (
    TypedCaptureRequest,
    filing_envelope_from_json,
    prepare_typed_capture,
    text_hit_envelope_from_json,
    typed_score_record_from_json,
    typed_source_capture_hash,
    typed_text_hit_record_from_json,
)
from ai.replay.runtime import (
    TypedReplaySources,
    build_typed_replay_runtime,
    typed_score_fact_hash,
)
from ai.replay.file_store import AtomicFileReplayJobStore
from ai.replay.fingerprint import compute_replay_input_fingerprint
from ai.replay.service import (
    PROFILE_MARKET_SCOPES,
    ReplayPipelineError,
    ReplayPinsError,
    ReplaySourceError,
)
from ai.replay.types import ReplayInputs, ReplayPins, SourceSlice
from ai.snapshot.fingerprint import jcs_canonicalize
from ai.snapshot.postgres_store import PostgresSnapshotStore
from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    canonical_disclosure_fact_hash,
)
from datapipeline.contracts import JpKrDisclosureRecord
from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    canonical_disclosure_fact_hash,
)
from datapipeline.storage.jpkr import canonical_financial_fact_hash
from datapipeline.storage.multibagger import (
    build_text_hit_storage_row,
    canonical_scan_document_fact_hash,
    canonical_text_context_hash,
)


NOW = datetime(2026, 7, 10, 6, 30, tzinfo=timezone.utc)
NOW_TEXT = "2026-07-10T06:30:00Z"


class ForgedHash(str):
    def __eq__(self, _other: object) -> bool:
        return True

    def __ne__(self, _other: object) -> bool:
        return False

    __hash__ = str.__hash__


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
    def __init__(self, rows, calls, *, transaction_error=None, close_error=None):
        self.rows = rows
        self.calls = calls
        self.transaction_error = transaction_error
        self.close_error = close_error
        self.closed = False

    def transaction(self):
        if self.transaction_error is not None:
            raise self.transaction_error
        return nullcontext()

    def cursor(self):
        return _Cursor(self.rows, self.calls)

    def close(self):
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


class _Connector:
    def __init__(self, rows, *, transaction_error=None, close_error=None):
        self.rows = rows
        self.transaction_error = transaction_error
        self.close_error = close_error
        self.calls = []
        self.connections = []

    def __call__(self, database_url):
        self.calls.append(database_url)
        connection = _Connection(
            self.rows,
            [],
            transaction_error=self.transaction_error,
            close_error=self.close_error,
        )
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
    values["fact_hash"] = canonical_financial_fact_hash(values)
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
        "source_version": "capture-v1",
        "source_url": None,
        "document_fact_hash": "0" * 64,
    }
    document["document_fact_hash"] = canonical_scan_document_fact_hash(document)
    hit = {
        "term_id": "capacity",
        "hit_kind": "EARLY_NEWS",
        "document_id": document["document_id"],
        "ticker": "7203",
        "language": "ja",
        "field": "TITLE",
        "start_offset": 0,
        "end_offset": 8,
        "context_hash": canonical_text_context_hash("capacity"),
        "taxonomy_version": "taxonomy-v1",
    }
    envelope = text_hit_envelope_from_json({"document": document, "hit": hit})
    return {
        "document": document,
        "hit": hit,
        "hit_fact_hash": build_text_hit_storage_row(envelope).hit_fact_hash,
    }


def _features(profile="japan_blue_chip", market_scope="jp"):
    return {
        "score": {
            "profile": profile,
            "market_scope": market_scope,
            "rating": "A",
            "total": 90.0,
            "dims": [{"key": "Q", "score": 90.0, "band": "A", "weight": 1.0}],
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
    filings = [{"disclosure": _disclosure_json(), "financials": [_financial_json()]}]
    text_hits = [_text_hit_json()]
    scores = [_score_json(pins.profile, pins.market_scope)]
    prepared = prepare_typed_capture(
        TypedCaptureRequest(
            trading_day=pins.trading_day,
            as_of=pins.as_of,
            profile=pins.profile,
            market_scope=pins.market_scope,
            profile_version=pins.profile_version,
            contract_version=pins.contract_version,
            strategy_version=pins.strategy_version,
            pipeline_version=pins.pipeline_version,
            source_versions=source_versions,
            filings=tuple(filing_envelope_from_json(item) for item in filings),
            text_hits=tuple(typed_text_hit_record_from_json(item) for item in text_hits),
            scores=tuple(typed_score_record_from_json(item) for item in scores),
        )
    )
    pins = prepared.pins
    row = prepared.row("12345678-1234-4234-8234-567812345678")
    row["trading_day"] = date.fromisoformat(pins.trading_day)
    row["as_of_utc"] = datetime.fromisoformat(pins.as_of.replace("Z", "+00:00"))
    row["available_at_utc"] = datetime.fromisoformat(
        prepared.available_at_utc.replace("Z", "+00:00")
    )
    if mutate is not None:
        mutate(row)
    return pins, row


def _capture_request():
    pins = _base_pins()
    return TypedCaptureRequest(
        trading_day=pins.trading_day,
        as_of=pins.as_of,
        profile=pins.profile,
        market_scope=pins.market_scope,
        profile_version=pins.profile_version,
        contract_version=pins.contract_version,
        strategy_version=pins.strategy_version,
        pipeline_version=pins.pipeline_version,
        source_versions={
            "signals": "signals-v1",
            "universe": "universe-v1",
            "scores": "scores-v1",
            "evidence": "evidence-v1",
        },
        filings=(
            filing_envelope_from_json(
                {
                    "disclosure": _disclosure_json(),
                    "financials": [_financial_json()],
                }
            ),
        ),
        text_hits=(typed_text_hit_record_from_json(_text_hit_json()),),
        scores=(typed_score_record_from_json(_score_json()),),
    )


def _disclaimer(language, full_text):
    return {
        "version": "1.0.0",
        "short_text": full_text,
        "full_text": full_text,
        "language": language,
        "effective_at": "2026-01-01T00:00:00Z",
        "hash": hashlib.sha256(full_text.encode()).hexdigest(),
    }


def _disclaimers():
    return {
        "zh-CN": _disclaimer("zh-CN", "仅供研究参考"),
        "ja-JP": _disclaimer("ja-JP", "調査目的のみ"),
        "ko-KR": _disclaimer("ko-KR", "연구 목적으로만 제공됩니다"),
    }


class PostgresTypedSourceRepositoryTests(unittest.TestCase):
    def test_source_availability_accepts_canonical_utc_microseconds(self):
        parsed = _parse_source_utc("2026-07-10T06:29:59.500000Z")
        self.assertEqual(parsed.microsecond, 500000)

        with self.assertRaisesRegex(ReplaySourceError, "canonical UTC"):
            _parse_source_utc("2026-07-10T06:29:59.5Z")
        with self.assertRaisesRegex(ReplaySourceError, "UTC seconds"):
            _parse_replay_utc_seconds("2026-07-10T06:29:59.500000Z")

    def test_pipeline_policy_selects_profile_default_disclaimer_locale(self):
        policy = ReplayPipelinePolicy(
            model_version="1.0.0",
            template_hash="a" * 64,
            disclaimers=_disclaimers(),
        )
        expected = {
            "us_preferred": "zh-CN",
            "multibagger": "zh-CN",
            "japan_blue_chip": "ja-JP",
            "japan_multibagger": "ja-JP",
            "korea_semiconductor_chain": "ko-KR",
            "korea_multibagger": "ko-KR",
        }
        for profile, language in expected.items():
            with self.subTest(profile=profile):
                self.assertEqual(
                    policy.validated_disclaimer(profile)["language"],
                    language,
                )

        invalid = _disclaimers()
        invalid["ja-JP"]["language"] = "zh-CN"
        with self.assertRaisesRegex(ReplayPipelineError, "locale key"):
            ReplayPipelinePolicy(
                model_version="1.0.0",
                template_hash="a" * 64,
                disclaimers=invalid,
            ).validated_disclaimer("japan_blue_chip")

    def test_pipeline_policy_rejects_hash_str_subclasses(self):
        disclaimers = _disclaimers()
        disclaimers["ja-JP"]["hash"] = ForgedHash("f" * 64)
        with self.assertRaisesRegex(ReplayPipelineError, "hash"):
            ReplayPipelinePolicy(
                model_version="1.0.0",
                template_hash="a" * 64,
                disclaimers=disclaimers,
            ).validated_disclaimer("japan_blue_chip")
        with self.assertRaisesRegex(ReplayPipelineError, "template_hash"):
            ReplayPipelinePolicy(
                model_version="1.0.0",
                template_hash=ForgedHash("a" * 64),
                disclaimers=_disclaimers(),
            ).validated_disclaimer("japan_blue_chip")

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

    def test_close_errors_are_redacted_without_masking_primary_failure(self):
        pins, row = _capture_row()
        secret = "postgresql://secret:password@production/internal"
        repository = PostgresTypedSourceRepository(
            "postgresql://stocks@/test?host=/tmp",
            connector=_Connector([row], close_error=RuntimeError(secret)),
        )

        with self.assertRaises(TypedSourceRepositoryReadError) as captured:
            repository.load(pins)
        self.assertEqual(
            str(captured.exception),
            "unable to close typed replay source connection",
        )
        self.assertNotIn(secret, str(captured.exception))
        self.assertIsNone(captured.exception.__cause__)
        self.assertIsNone(captured.exception.__context__)
        self.assertNotIn(
            secret,
            "".join(
                traceback.format_exception(
                    type(captured.exception),
                    captured.exception,
                    captured.exception.__traceback__,
                )
            ),
        )

        primary_error = ReplaySourceError("primary replay source failure")
        repository = PostgresTypedSourceRepository(
            "postgresql://stocks@/test?host=/tmp",
            connector=_Connector(
                [],
                transaction_error=primary_error,
                close_error=RuntimeError(secret),
            ),
        )
        with self.assertRaises(ReplaySourceError) as primary:
            repository.load(pins)
        self.assertIs(primary.exception, primary_error)

        repository = PostgresTypedSourceRepository(
            "postgresql://stocks@/test?host=/tmp",
            connector=_Connector(
                [],
                transaction_error=RuntimeError(secret),
            ),
        )
        with self.assertRaises(TypedSourceRepositoryReadError) as transaction:
            repository.load(pins)
        self.assertIsNone(transaction.exception.__cause__)
        self.assertIsNone(transaction.exception.__context__)
        self.assertNotIn(
            secret,
            "".join(
                traceback.format_exception(
                    type(transaction.exception),
                    transaction.exception,
                    transaction.exception.__traceback__,
                )
            ),
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
                disclaimers=_disclaimers(),
            ),
        )
        invalid = replace(pins, profile="custom")
        with self.assertRaises(ReplayPinsError):
            adapter.run(invalid, inputs)
        self.assertEqual(snapshot_connector.calls, [])

        class TruncatedReplayInputs(ReplayInputs):
            def ordered(self):
                return (self.signals,)

        substituted = TruncatedReplayInputs(
            signals=inputs.signals,
            universe=inputs.universe,
            scores=inputs.scores,
            evidence=inputs.evidence,
        )
        with self.assertRaisesRegex(ReplaySourceError, "wrong type"):
            adapter._validate_inputs(pins, substituted)
        self.assertEqual(snapshot_connector.calls, [])

        class SwitchingSlice(SourceSlice):
            pass

        switching_signals = SwitchingSlice(**inputs.signals.__dict__)
        switching = ReplayInputs(
            signals=switching_signals,
            universe=inputs.universe,
            scores=inputs.scores,
            evidence=inputs.evidence,
        )
        with self.assertRaisesRegex(ReplaySourceError, "wrong type"):
            adapter._validate_inputs(pins, switching)
        self.assertEqual(snapshot_connector.calls, [])

        class SwitchingDict(dict):
            def __init__(self, honest, alternate):
                super().__init__(honest)
                self.alternate = alternate
                self.reads = 0

            def __getitem__(self, key):
                source = self if self.reads < len(self) else self.alternate
                self.reads += 1
                if source is self:
                    return super().__getitem__(key)
                return source[key]

        honest_universe = dict(inputs.universe.records[0])
        dynamic_record = SwitchingDict(
            honest_universe,
            {**honest_universe, "ticker": "substituted"},
        )
        dynamic_inputs = ReplayInputs(
            signals=inputs.signals,
            universe=replace(inputs.universe, records=(dynamic_record,)),
            scores=inputs.scores,
            evidence=inputs.evidence,
        )

        canonical_inputs = adapter._validate_inputs(pins, dynamic_inputs)

        self.assertEqual(canonical_inputs.universe.records, (honest_universe,))
        self.assertEqual(dynamic_record["ticker"], "substituted")
        self.assertIs(type(canonical_inputs.universe.records[0]), dict)

    def test_future_evidence_with_resealed_slices_fails_before_store(self):
        pins, row = _capture_row()
        snapshot = _snapshot_from_capture(row, pins)
        inputs = TypedReplaySources(_Repository(snapshot)).load_inputs(pins)
        evidence_records = list(copy.deepcopy(inputs.evidence.records))
        signal_records = list(copy.deepcopy(inputs.signals.records))
        future = NOW + timedelta(seconds=1)
        future_text = future.strftime("%Y-%m-%dT%H:%M:%SZ")

        evidence_record = next(
            item for item in evidence_records if item["kind"] == "text_hit"
        )
        document = evidence_record["envelope"]["document"]
        document["available_at_utc"] = future_text
        document["document_fact_hash"] = canonical_scan_document_fact_hash(document)
        envelope = text_hit_envelope_from_json(
            {
                "document": document,
                "hit": evidence_record["envelope"]["hit"],
            }
        )
        evidence_record["envelope"]["hit_fact_hash"] = (
            build_text_hit_storage_row(envelope).hit_fact_hash
        )
        evidence_record["identity"][0] = document["document_fact_hash"]
        signal_record = next(
            item for item in signal_records if item["kind"] == "text_hit"
        )
        signal_record["available_at_utc"] = future_text
        signal_record["fact_hash"] = evidence_record["envelope"]["hit_fact_hash"]
        signal_record["document_fact_hash"] = document["document_fact_hash"]

        def reseal(source, records):
            return replace(
                source,
                records=tuple(records),
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
            input_fingerprint=compute_replay_input_fingerprint(modified),
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
                disclaimers=_disclaimers(),
            ),
        )

        with self.assertRaisesRegex(ReplaySourceError, "PIT cutoff"):
            adapter.run(pins, modified)
        self.assertEqual(connector.calls, [])

    def test_untrimmed_score_source_version_fails_after_full_reseal(self):
        pins, row = _capture_row()
        snapshot = _snapshot_from_capture(row, pins)
        inputs = TypedReplaySources(_Repository(snapshot)).load_inputs(pins)
        score_records = copy.deepcopy(inputs.scores.records)
        score = score_records[0]
        score["source_version"] = " score-v1 "
        score["fact_hash"] = typed_score_fact_hash(
            ticker=score["ticker"],
            profile=score["profile"],
            market_scope=score["market_scope"],
            as_of=score["as_of"],
            available_at_utc=datetime.fromisoformat(
                score["available_at_utc"].replace("Z", "+00:00")
            ),
            source_version=score["source_version"],
            features=score["features"],
        )
        scores = replace(
            inputs.scores,
            records=score_records,
            content_hash=hashlib.sha256(
                jcs_canonicalize(score_records).encode("utf-8")
            ).hexdigest(),
        )
        modified = ReplayInputs(
            signals=inputs.signals,
            universe=inputs.universe,
            scores=scores,
            evidence=inputs.evidence,
        )
        pins = replace(
            pins,
            input_fingerprint=compute_replay_input_fingerprint(modified),
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
                disclaimers=_disclaimers(),
            ),
        )

        validated = adapter._validate_inputs(pins, modified)
        with self.assertRaisesRegex(ReplaySourceError, "score record replay pins"):
            adapter._map_inputs(pins, validated)
        self.assertEqual(connector.calls, [])

    def test_adapter_rejects_duplicate_financial_physical_identity(self):
        pins, row = _capture_row()
        snapshot = _snapshot_from_capture(row, pins)
        inputs = TypedReplaySources(_Repository(snapshot)).load_inputs(pins)
        evidence_records = list(copy.deepcopy(inputs.evidence.records))
        original_evidence = next(
            item for item in evidence_records if item["kind"] == "filing"
        )
        changed_evidence = copy.deepcopy(original_evidence)
        disclosure_json = changed_evidence["envelope"]["disclosure"]
        disclosure_json["source_version"] = "filing-v2"
        draft = JpKrDisclosureRecord(
            **{
                **disclosure_json,
                "event_time_utc": datetime.fromisoformat(
                    disclosure_json["event_time_utc"].replace("Z", "+00:00")
                ),
                "available_at_utc": datetime.fromisoformat(
                    disclosure_json["available_at_utc"].replace("Z", "+00:00")
                ),
                "fact_hash": "0" * 64,
            }
        )
        disclosure_json["fact_hash"] = canonical_disclosure_fact_hash(draft)
        financial_json = changed_evidence["envelope"]["financials"][0]
        financial_json["revenue"] = "2000"
        financial_json["fact_hash"] = canonical_financial_fact_hash(financial_json)
        changed_envelope = filing_envelope_from_json(changed_evidence["envelope"])
        changed_evidence["identity"] = list(changed_envelope.disclosure.identity)
        evidence_records.append(changed_evidence)
        evidence_records.sort(key=lambda item: jcs_canonicalize(item))

        signal_records = list(copy.deepcopy(inputs.signals.records))
        changed_signal = copy.deepcopy(
            next(item for item in signal_records if item["kind"] == "filing")
        )
        changed_signal["source_version"] = disclosure_json["source_version"]
        changed_signal["fact_hash"] = disclosure_json["fact_hash"]
        signal_records.append(changed_signal)
        signal_records.sort(key=lambda item: jcs_canonicalize(item))

        def reseal(source, records):
            return replace(
                source,
                records=tuple(records),
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
            input_fingerprint=compute_replay_input_fingerprint(modified),
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
                disclaimers=_disclaimers(),
            ),
        )

        validated = adapter._validate_inputs(pins, modified)
        with self.assertRaisesRegex(ReplaySourceError, "financial evidence identity"):
            adapter._map_inputs(pins, validated)
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
                "ALTER TABLE ai_replay_typed_source_capture DISABLE TRIGGER "
                "tr_ai_replay_typed_source_capture_append_only"
            )
            connection.execute(
                "TRUNCATE ai_recommendation_item, "
                "ai_recommendation_snapshot, "
                "ai_replay_typed_source_capture CASCADE"
            )
            connection.execute(
                "ALTER TABLE ai_replay_typed_source_capture ENABLE TRIGGER "
                "tr_ai_replay_typed_source_capture_append_only"
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
        writer = PostgresTypedCaptureWriter.from_env(
            uuid4_factory=lambda: uuid.UUID(
                "12345678-1234-4234-8234-567812345678"
            )
        )
        receipt = writer.write(_capture_request())
        repeated = writer.write(_capture_request())
        self.assertTrue(receipt.created)
        self.assertFalse(repeated.created)
        self.assertEqual(repeated.capture_id, receipt.capture_id)
        pins = receipt.pins
        repository = PostgresTypedSourceRepository.from_env()
        snapshot_store = PostgresSnapshotStore.from_env()
        adapter = PipelineReplayAdapter(
            snapshot_store=snapshot_store,
            policy=ReplayPipelinePolicy(
                model_version="1.0.0",
                template_hash="a" * 64,
                disclaimers=_disclaimers(),
            ),
        )
        counted_repository = _CountingRepository(repository)
        test_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(dir=test_root) as directory:
            service, worker, _ = build_typed_replay_runtime(
                repository=counted_repository,
                pipeline=adapter,
                job_store=AtomicFileReplayJobStore(Path(directory) / "jobs.json"),
                uuid_factory=lambda: uuid.UUID("12345678-1234-4234-8234-567812345678"),
                clock=lambda: NOW_TEXT,
            )
            completed = worker.run_job(service.submit(pins).job_id)

        self.assertEqual(completed.status, "completed", completed)
        self.assertEqual(counted_repository.calls, 1)
        persisted = snapshot_store.get_snapshot(completed.snapshot_id)
        self.assertIsNotNone(persisted)
        self.assertEqual(persisted.output_fingerprint, completed.output_fingerprint)
        self.assertEqual(persisted.input_fingerprint, pins.input_fingerprint)
        self.assertEqual(persisted.item_count, 1)
        items = snapshot_store.get_items(completed.snapshot_id)
        self.assertEqual([item.ticker for item in items], ["7203"])
        self.assertTrue(items[0].recommendation_json["evidence_refs"])

        repeat_inputs = TypedReplaySources(repository).load_inputs(pins)
        repeated_result = adapter.run(pins, repeat_inputs)
        self.assertEqual(repeated_result.snapshot_id, completed.snapshot_id)
        self.assertEqual(
            repeated_result.output_fingerprint,
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

    def test_concurrent_capture_writes_converge_to_one_row(self):
        identities = (
            uuid.UUID("12345678-1234-4234-8234-567812345678"),
            uuid.UUID("22345678-1234-4234-8234-567812345678"),
        )

        def write(identity):
            return PostgresTypedCaptureWriter.from_env(
                uuid4_factory=lambda: identity
            ).write(_capture_request())

        with ThreadPoolExecutor(max_workers=2) as executor:
            receipts = tuple(executor.map(write, identities))

        self.assertEqual(sorted(item.created for item in receipts), [False, True])
        self.assertEqual(len({item.capture_id for item in receipts}), 1)
        import psycopg

        with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
            row_count = connection.execute(
                "SELECT COUNT(*) FROM ai_replay_typed_source_capture"
            ).fetchone()[0]
        self.assertEqual(row_count, 1)

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
                disclaimers=_disclaimers(),
            ),
        )
        test_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(dir=test_root) as directory:
            service, worker, _ = build_typed_replay_runtime(
                repository=PostgresTypedSourceRepository.from_env(),
                pipeline=adapter,
                job_store=AtomicFileReplayJobStore(Path(directory) / "jobs.json"),
                uuid_factory=lambda: uuid.UUID("22345678-1234-4234-8234-567812345678"),
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
