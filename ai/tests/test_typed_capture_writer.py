from __future__ import annotations

import copy
from contextlib import AbstractContextManager
from dataclasses import replace
from datetime import date, datetime, timezone
import json
import traceback
import unittest
import uuid

from ai.replay.postgres_capture_writer import (
    INSERT_CAPTURE,
    LOCK_CAPTURE,
    SELECT_CAPTURE_BY_IDENTITY,
    PostgresTypedCaptureWriter,
    TypedCaptureConflictError,
    TypedCaptureWriteError,
)
from ai.replay.service import ReplayServiceError, ReplaySourceError
from ai.replay.typed_capture import (
    CAPTURE_COLUMNS,
    TypedCaptureRequest,
    filing_envelope_from_json,
    prepare_typed_capture,
    typed_score_record_from_json,
    typed_score_record_to_json,
    typed_text_hit_record_from_json,
)
from ai.replay.runtime import typed_score_fact_hash
from ai.tests.test_postgres_typed_source_repository import (
    NOW_TEXT,
    _disclosure_json,
    _financial_json,
    _score_json,
    _text_hit_json,
)
from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    canonical_disclosure_fact_hash,
)
from datapipeline.contracts import JpKrDisclosureRecord
from datapipeline.storage.jpkr import canonical_financial_fact_hash


CAPTURE_ID = uuid.UUID("12345678-1234-4234-8234-567812345678")
SECOND_CAPTURE_ID = uuid.UUID("22345678-1234-4234-8234-567812345678")


class ForgedHash(str):
    def __eq__(self, _other: object) -> bool:
        return True

    def __ne__(self, _other: object) -> bool:
        return False

    __hash__ = str.__hash__


def _request(**overrides):
    values = {
        "trading_day": "2026-07-10",
        "as_of": NOW_TEXT,
        "profile": "japan_blue_chip",
        "market_scope": "jp",
        "profile_version": "1.0.0",
        "contract_version": "0.3.1",
        "strategy_version": "1.0.0",
        "pipeline_version": "1.0.0",
        "source_versions": {
            "signals": "signals-v1",
            "universe": "universe-v1",
            "scores": "scores-v1",
            "evidence": "evidence-v1",
        },
        "filings": (
            filing_envelope_from_json(
                {
                    "disclosure": _disclosure_json(),
                    "financials": [_financial_json()],
                }
            ),
        ),
        "text_hits": (typed_text_hit_record_from_json(_text_hit_json()),),
        "scores": (typed_score_record_from_json(_score_json()),),
    }
    values.update(overrides)
    return TypedCaptureRequest(**values)


class _Transaction(AbstractContextManager):
    def __init__(self, connection):
        self.connection = connection
        self.previous = None

    def __enter__(self):
        self.previous = copy.deepcopy(self.connection.database.row)
        return self

    def __exit__(self, exc_type, _exc, _traceback):
        if exc_type is not None:
            self.connection.database.row = self.previous
            self.connection.rollbacks += 1
        else:
            self.connection.commits += 1
        return False


class _Cursor(AbstractContextManager):
    def __init__(self, connection):
        self.connection = connection
        self.result = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, parameters=None):
        self.connection.calls.append((sql, parameters))
        if sql == LOCK_CAPTURE:
            self.result = None
        elif sql == SELECT_CAPTURE_BY_IDENTITY:
            row = copy.deepcopy(self.connection.database.row)
            if row is not None and self.connection.tamper_readback:
                row["capture_hash"] = "f" * 64
            self.result = row
        elif sql == INSERT_CAPTURE:
            row = dict(zip(CAPTURE_COLUMNS, parameters))
            row["trading_day"] = date.fromisoformat(row["trading_day"])
            row["as_of_utc"] = datetime.fromisoformat(
                row["as_of_utc"].replace("Z", "+00:00")
            )
            row["available_at_utc"] = datetime.fromisoformat(
                row["available_at_utc"].replace("Z", "+00:00")
            )
            for field in (
                "source_versions",
                "filings_json",
                "text_hits_json",
                "scores_json",
            ):
                row[field] = json.loads(row[field])
            self.connection.database.row = row
            self.result = None
        else:
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchone(self):
        return self.result


class _Connection:
    def __init__(self, database, *, tamper_readback=False, close_error=None):
        self.database = database
        self.tamper_readback = tamper_readback
        self.close_error = close_error
        self.calls = []
        self.closed = False
        self.commits = 0
        self.rollbacks = 0

    def transaction(self):
        return _Transaction(self)

    def cursor(self):
        return _Cursor(self)

    def close(self):
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


class _Database:
    def __init__(self):
        self.row = None


class _Connector:
    def __init__(self, database=None, *, tamper_readback=False, close_error=None):
        self.database = database or _Database()
        self.tamper_readback = tamper_readback
        self.close_error = close_error
        self.calls = []
        self.connections = []

    def __call__(self, database_url):
        self.calls.append(database_url)
        connection = _Connection(
            self.database,
            tamper_readback=self.tamper_readback,
            close_error=self.close_error,
        )
        self.connections.append(connection)
        return connection


class TypedCaptureTests(unittest.TestCase):
    def test_score_only_and_fully_empty_captures_have_valid_fingerprints(self):
        score_only = prepare_typed_capture(_request(filings=(), text_hits=()))
        fully_empty = prepare_typed_capture(
            _request(filings=(), text_hits=(), scores=())
        )

        self.assertRegex(score_only.pins.input_fingerprint, r"^[0-9a-f]{64}$")
        self.assertRegex(fully_empty.pins.input_fingerprint, r"^[0-9a-f]{64}$")
        self.assertNotEqual(
            score_only.pins.input_fingerprint,
            fully_empty.pins.input_fingerprint,
        )
        self.assertEqual(fully_empty.available_at_utc, fully_empty.pins.as_of)

    def test_derives_pins_availability_and_canonical_order(self):
        first = _score_json()
        second = copy.deepcopy(first)
        second["ticker"] = "6758"
        second["fact_hash"] = typed_score_fact_hash(
            ticker=second["ticker"],
            profile=second["profile"],
            market_scope=second["market_scope"],
            as_of=second["as_of"],
            available_at_utc=datetime.fromisoformat(
                second["available_at_utc"].replace("Z", "+00:00")
            ),
            source_version=second["source_version"],
            features=second["features"],
        )
        request = _request(
            scores=(
                typed_score_record_from_json(first),
                typed_score_record_from_json(second),
            )
        )

        prepared = prepare_typed_capture(request)

        self.assertRegex(prepared.pins.input_fingerprint, r"^[0-9a-f]{64}$")
        self.assertEqual(prepared.available_at_utc, NOW_TEXT)
        self.assertEqual(
            [item["ticker"] for item in prepared.scores_json],
            ["6758", "7203"],
        )
        self.assertRegex(prepared.capture_hash, r"^[0-9a-f]{64}$")

    def test_canonical_microsecond_availability_is_preserved(self):
        as_of = "2026-07-10T06:30:01Z"
        raw = _score_json()
        raw["as_of"] = as_of
        raw["available_at_utc"] = "2026-07-10T06:30:00.123456Z"
        available = datetime(2026, 7, 10, 6, 30, 0, 123456, tzinfo=timezone.utc)
        raw["fact_hash"] = typed_score_fact_hash(
            ticker=raw["ticker"],
            profile=raw["profile"],
            market_scope=raw["market_scope"],
            as_of=raw["as_of"],
            available_at_utc=available,
            source_version=raw["source_version"],
            features=raw["features"],
        )

        prepared = prepare_typed_capture(
            _request(
                as_of=as_of,
                scores=(typed_score_record_from_json(raw),),
            )
        )

        self.assertEqual(prepared.available_at_utc, "2026-07-10T06:30:00.123456Z")

    def test_hash_pit_profile_and_duplicate_fail_closed(self):
        score = _request().scores[0]
        score.features["score"]["total"] = 89.0
        cases = [
            _request(scores=(score,)),
            _request(text_hits=(_request().text_hits[0],) * 2),
            _request(profile="korea_multibagger"),
        ]
        future_raw = typed_score_record_to_json(_request().scores[0])
        future_raw["available_at_utc"] = "2026-07-10T06:30:01Z"
        future = datetime(2026, 7, 10, 6, 30, 1, tzinfo=timezone.utc)
        future_raw["fact_hash"] = typed_score_fact_hash(
            ticker=future_raw["ticker"],
            profile=future_raw["profile"],
            market_scope=future_raw["market_scope"],
            as_of=future_raw["as_of"],
            available_at_utc=future,
            source_version=future_raw["source_version"],
            features=future_raw["features"],
        )
        cases.append(_request(scores=(typed_score_record_from_json(future_raw),)))
        for request in cases:
            with self.subTest(request=request):
                with self.assertRaises(Exception) as captured:
                    prepare_typed_capture(request)
                self.assertIsInstance(captured.exception, ReplayServiceError)

    def test_typed_score_source_version_must_be_trimmed(self):
        raw = _score_json()
        raw["source_version"] = " score-v1 "

        with self.assertRaisesRegex(ReplaySourceError, "source_version"):
            typed_score_record_from_json(raw)

    def test_source_version_str_subclass_cannot_forge_ascii_policy(self):
        class ForgedSourceVersion(str):
            def isascii(self):
                return True

            def __iter__(self):
                return iter("score-v1")

        forged = ForgedSourceVersion("版本-v1")
        raw = _score_json()
        raw["source_version"] = forged
        with self.assertRaisesRegex(ReplaySourceError, "source_version"):
            typed_score_record_from_json(raw)

        source_versions = dict(_request().source_versions)
        source_versions["scores"] = forged
        with self.assertRaisesRegex(ReplaySourceError, "source capture versions"):
            prepare_typed_capture(_request(source_versions=source_versions))

    def test_prepare_rejects_comparison_overriding_fact_hash_subclass(self):
        request = _request()
        score = request.scores[0]
        wrong_hash = "f" * 64 if score.fact_hash != "f" * 64 else "e" * 64
        forged = replace(score, fact_hash=ForgedHash(wrong_hash))

        with self.assertRaisesRegex(ReplaySourceError, "fact_hash"):
            prepare_typed_capture(_request(scores=(forged,)))

    def test_text_hit_requires_datapipeline_physical_fact_pin(self):
        raw = _text_hit_json()
        raw["hit"]["hit_kind"] = "NEGATIVE"

        with self.assertRaisesRegex(ReplaySourceError, "fact_hash"):
            typed_text_hit_record_from_json(raw)

    def test_duplicate_financial_physical_identity_is_rejected(self):
        first = filing_envelope_from_json(
            {
                "disclosure": _disclosure_json(),
                "financials": [_financial_json()],
            }
        )
        disclosure_json = _disclosure_json()
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
        financial_json = _financial_json()
        financial_json["revenue"] = "2000"
        financial_json["fact_hash"] = canonical_financial_fact_hash(financial_json)
        second = filing_envelope_from_json(
            {
                "disclosure": disclosure_json,
                "financials": [financial_json],
            }
        )

        with self.assertRaisesRegex(ReplaySourceError, "identity is duplicated"):
            prepare_typed_capture(_request(filings=(first, second)))


class PostgresTypedCaptureWriterTests(unittest.TestCase):
    def _writer(self, connector, identity=CAPTURE_ID):
        return PostgresTypedCaptureWriter(
            "postgresql://stocks@/test?host=/tmp",
            connector=connector,
            uuid4_factory=lambda: identity,
        )

    def test_insert_readback_and_idempotent_retry(self):
        connector = _Connector()
        first = self._writer(connector).write(_request())
        second = self._writer(connector, SECOND_CAPTURE_ID).write(_request())

        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual(second.capture_id, first.capture_id)
        self.assertEqual(second.pins, first.pins)
        self.assertEqual(second.capture_hash, first.capture_hash)
        self.assertEqual(len(connector.connections), 2)
        self.assertTrue(all(item.closed for item in connector.connections))
        sql = [call[0] for item in connector.connections for call in item.calls]
        self.assertEqual(sql.count(INSERT_CAPTURE), 1)
        self.assertEqual(sql.count(LOCK_CAPTURE), 2)
        self.assertEqual(sql.count(SELECT_CAPTURE_BY_IDENTITY), 3)
        self.assertEqual(connector.connections[0].commits, 1)

    def test_same_natural_identity_with_different_source_versions_conflicts(self):
        connector = _Connector()
        self._writer(connector).write(_request())
        changed = _request(
            source_versions={
                "signals": "signals-v2",
                "universe": "universe-v1",
                "scores": "scores-v1",
                "evidence": "evidence-v1",
            }
        )

        with self.assertRaises(TypedCaptureConflictError):
            self._writer(connector, SECOND_CAPTURE_ID).write(changed)

        self.assertEqual(connector.connections[-1].rollbacks, 1)

    def test_invalid_request_fails_before_uuid_or_connection(self):
        connector = _Connector()
        called = []
        writer = PostgresTypedCaptureWriter(
            "postgresql://stocks@/test?host=/tmp",
            connector=connector,
            uuid4_factory=lambda: called.append(True),
        )
        score = _request().scores[0]
        score.features["score"]["total"] = 1.0

        with self.assertRaises(ReplaySourceError):
            writer.write(_request(scores=(score,)))

        self.assertEqual(called, [])
        self.assertEqual(connector.calls, [])

        with self.assertRaises(ReplaySourceError):
            writer.write(
                _request(
                    source_versions={
                        "signals": " signals-v1 ",
                        "universe": "universe-v1",
                        "scores": "scores-v1",
                        "evidence": "evidence-v1",
                    }
                )
            )
        self.assertEqual(connector.calls, [])

    def test_tampered_readback_rolls_back_insert(self):
        connector = _Connector(tamper_readback=True)

        with self.assertRaises(TypedCaptureConflictError):
            self._writer(connector).write(_request())

        self.assertIsNone(connector.database.row)
        self.assertEqual(connector.connections[0].rollbacks, 1)
        self.assertTrue(connector.connections[0].closed)

    def test_connection_errors_are_redacted(self):
        secret = "postgresql://secret:password@production/internal"

        def fail(_database_url):
            raise RuntimeError(secret)

        writer = PostgresTypedCaptureWriter(
            "postgresql://stocks@/test?host=/tmp",
            connector=fail,
            uuid4_factory=lambda: CAPTURE_ID,
        )
        with self.assertRaises(TypedCaptureWriteError) as captured:
            writer.write(_request())
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

    def test_close_errors_are_redacted_without_masking_primary_failure(self):
        secret = "postgresql://secret:password@production/internal"
        connector = _Connector(close_error=RuntimeError(secret))

        with self.assertRaises(TypedCaptureWriteError) as captured:
            self._writer(connector).write(_request())
        self.assertEqual(
            str(captured.exception),
            "unable to close typed source capture connection",
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

        conflict_connector = _Connector(
            tamper_readback=True,
            close_error=RuntimeError(secret),
        )
        with self.assertRaises(TypedCaptureConflictError) as primary:
            self._writer(conflict_connector).write(_request())
        self.assertNotIn(secret, str(primary.exception))


if __name__ == "__main__":
    unittest.main()
