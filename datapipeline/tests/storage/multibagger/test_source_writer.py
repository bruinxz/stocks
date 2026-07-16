import copy
from datetime import datetime, timedelta, timezone
import hashlib
import unittest

from datapipeline.contracts import MultibaggerSourceRecord
from datapipeline.storage.multibagger import (
    MultibaggerIdempotencyConflict,
    MultibaggerSourceWriter,
    build_storage_row,
    canonical_multibagger_fact_hash,
    canonicalize_json,
)

NOW = datetime(2026, 7, 10, 8, tzinfo=timezone.utc)


class ForgedSourceVersion(str):
    def isascii(self) -> bool:
        return True

    def __iter__(self):
        return iter("forged-v1")


class ForgedHash(str):
    def __ne__(self, other: object) -> bool:
        return False


class RecordSubclass(MultibaggerSourceRecord):
    pass


def record(**overrides: object) -> MultibaggerSourceRecord:
    values = {
        "market": "CN",
        "market_scope": "cn_a",
        "exchange": "sh",
        "ticker": "600000",
        "record_kind": "DAILY",
        "source_kind": "baostock_cn",
        "source_document_id": "600000:2026-07-10",
        "source_version": "baostock-v1",
        "effective_at_utc": NOW - timedelta(hours=2),
        "available_at_utc": NOW - timedelta(hours=1),
        "as_of_utc": NOW,
        "features": {"close_local": "10.25", "quality_flags": []},
        "evidence_refs": ("baostock:600000:2026-07-10",),
        "fact_hash": "0" * 64,
    }
    values.update(overrides)
    draft = MultibaggerSourceRecord(**values)
    object.__setattr__(draft, "fact_hash", canonical_multibagger_fact_hash(draft))
    return draft


class FakeTransaction:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection
        self.rows_snapshot = None
        self.args_snapshot = None

    async def __aenter__(self) -> None:
        self.connection.active_transactions += 1
        self.rows_snapshot = copy.deepcopy(self.connection.rows)
        self.args_snapshot = copy.deepcopy(self.connection.inserted_args)

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        if exc_type is not None:
            self.connection.rows = self.rows_snapshot
            self.connection.inserted_args = self.args_snapshot
        self.connection.active_transactions -= 1


class FakeAcquire:
    def __init__(self, connection: "FakeConnection", on_enter=None) -> None:
        self.connection = connection
        self.on_enter = on_enter

    async def __aenter__(self) -> "FakeConnection":
        if self.on_enter is not None:
            self.on_enter()
        return self.connection

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None


class FakeConnection:
    def __init__(self) -> None:
        self.rows = {}
        self.lock_keys = []
        self.inserted_args = []
        self.race_hash = None
        self.active_transactions = 0

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    async def fetchval(self, sql: str, *args: object):
        self.lock_keys.append(args[0])
        return None

    async def fetch(self, sql: str, *args: object):
        hashes = self.rows.get(tuple(args), set())
        return [{"fact_hash": value} for value in hashes]

    async def fetchrow(self, sql: str, *args: object):
        key = (args[5], args[4], args[3], args[6], args[7])
        if self.race_hash is not None:
            self.rows.setdefault(key, set()).add(self.race_hash)
            self.race_hash = None
            return None
        self.rows.setdefault(key, set()).add(args[17])
        self.inserted_args.append(args)
        return {"multibagger_universe_id": "fixture-id"}


class FakePool:
    def __init__(self, on_acquire=None) -> None:
        self.connection = FakeConnection()
        self.acquire_count = 0
        self.on_acquire = on_acquire

    def acquire(self) -> FakeAcquire:
        self.acquire_count += 1
        return FakeAcquire(self.connection, self.on_acquire)


class CanonicalSourceFactTest(unittest.TestCase):
    def test_record_type_must_be_exact(self) -> None:
        item = record()
        subclass = RecordSubclass(**item.__dict__)
        for operation in (canonical_multibagger_fact_hash, build_storage_row):
            with self.subTest(operation=operation.__name__):
                with self.assertRaisesRegex(TypeError, "MultibaggerSourceRecord"):
                    operation(subclass)

    def test_source_version_constructor_rejects_noncanonical_values(self) -> None:
        for value in (
            "版本-v1",
            " baostock-v1 ",
            "\tbaostock-v1\t",
            ForgedSourceVersion("版本-v1"),
        ):
            with self.subTest(value=value, type=type(value)):
                with self.assertRaisesRegex(ValueError, "printable ASCII"):
                    record(source_version=value)

    def test_jcs_key_order_number_and_hash_vectors(self) -> None:
        self.assertEqual(canonicalize_json({"b": 2, "a": 1}), '{"a":1,"b":2}')
        self.assertEqual(canonicalize_json(-0.0), "0")
        self.assertEqual(canonicalize_json(1.0), "1")
        self.assertEqual(canonicalize_json(0.000001), "0.000001")
        self.assertEqual(canonicalize_json(1e-7), "1e-7")
        self.assertEqual(canonicalize_json(1e21), "1e+21")
        self.assertEqual(
            hashlib.sha256(canonicalize_json({"a": 1, "b": 2}).encode()).hexdigest(),
            "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
        )
        with self.assertRaisesRegex(ValueError, "keys must be strings"):
            canonicalize_json({1: "bad"})

    def test_json_and_forbidden_fields_fail_closed_recursively(self) -> None:
        for features, message in (
            ({"nested": {"score": 90}}, "forbidden derived key"),
            ({"bad": object()}, "unsupported JSON value"),
            ({"bad": float("nan")}, "finite"),
            ({1: "bad"}, "non-string JSON key"),
            ({"bad": 9007199254740992}, "safe range"),
        ):
            with self.subTest(features=features):
                with self.assertRaisesRegex(ValueError, message):
                    canonical_multibagger_fact_hash(record(features=features))

    def test_market_and_aggregate_identity(self) -> None:
        build_storage_row(record())
        for market, scope, exchange, ticker in (
            ("CN", "cn_a", "sz", "000001"),
            ("US", "us", "nyse", "IBM"),
            ("JP", "jp", "tse", "7203"),
            ("KR", "kr", "kosdaq", "035720"),
        ):
            with self.subTest(market=market, exchange=exchange):
                build_storage_row(
                    record(
                        market=market,
                        market_scope=scope,
                        exchange=exchange,
                        ticker=ticker,
                    )
                )
        aggregate = record(
            market="US",
            market_scope="us",
            exchange="ACADEMIC_REFERENCE",
            ticker="__AGGREGATE__:french:small-value",
            record_kind="FRENCH_AGGREGATE",
            source_kind="kenneth_french",
        )
        build_storage_row(aggregate)
        with self.assertRaisesRegex(ValueError, "aggregate identity"):
            build_storage_row(
                record(
                    market="US",
                    market_scope="us",
                    exchange="nasdaq",
                    ticker="__AGGREGATE__:bad",
                    record_kind="FRENCH_AGGREGATE",
                )
            )
        with self.assertRaisesRegex(ValueError, "canonical mapping"):
            build_storage_row(record(exchange="nyse"))
        mutated = record()
        object.__setattr__(mutated, "market_scope", "us")
        with self.assertRaisesRegex(ValueError, "market and market_scope"):
            build_storage_row(mutated)

    def test_hash_covers_all_storage_fields_and_defaults(self) -> None:
        item = record()
        row = build_storage_row(item)
        self.assertEqual(row.canonical_body["provider_market_label"], "CN")
        self.assertEqual(row.canonical_body["text_hit_kinds"], [])
        self.assertEqual(row.canonical_body["fundamental_snapshot"], {})
        self.assertEqual(row.canonical_body["filter_pass_bitmap"], 0)
        self.assertIsNone(row.canonical_body["market_cap_cny_100m"])
        self.assertEqual(
            item.fact_hash,
            "f9b668b2be1d30bbcd723580c15cec732316b3faa61c63b619b3018e26374988",
        )

    def test_prepared_nested_features_are_detached_from_caller(self) -> None:
        features = {"nested": {"labels": ["before"]}}
        prepared = build_storage_row(record(features=features))

        features["nested"]["labels"][0] = "attacker"
        features["nested"]["labels"].append("later")

        self.assertEqual(
            prepared.features_json,
            '{"nested":{"labels":["before"]}}',
        )
        self.assertEqual(
            prepared.canonical_body["features"],
            {"nested": {"labels": ["before"]}},
        )

    def test_pit_hash_evidence_and_numeric_authority(self) -> None:
        with self.assertRaisesRegex(ValueError, "available_at_utc"):
            build_storage_row(record(as_of_utc=NOW - timedelta(hours=2)))
        with self.assertRaisesRegex(ValueError, "fact_hash does not match"):
            broken = record()
            object.__setattr__(broken, "fact_hash", "f" * 64)
            build_storage_row(broken)
        with self.assertRaisesRegex(ValueError, "evidence_refs"):
            build_storage_row(record(evidence_refs=("",)))
        with self.assertRaisesRegex(ValueError, "storage scale"):
            build_storage_row(record(features={"market_cap_cny_100m": "1.12345"}))
        with self.assertRaisesRegex(ValueError, "integer digits"):
            build_storage_row(
                record(features={"market_cap_cny_100m": "123456789012345"})
            )
        with self.assertRaisesRegex(ValueError, "valid only"):
            build_storage_row(
                record(
                    market="US",
                    market_scope="us",
                    exchange="nyse",
                    ticker="IBM",
                    features={"market_cap_cny_100m": "1"},
                )
            )


class MultibaggerSourceWriterTest(unittest.IsolatedAsyncioTestCase):
    async def test_acquire_mutation_cannot_switch_prepared_source_identity(self) -> None:
        item = record()
        original_version = item.source_version
        original_hash = item.fact_hash

        def mutate_source() -> None:
            object.__setattr__(item, "source_version", "attacker-v2")

        pool = FakePool(on_acquire=mutate_source)
        result = await MultibaggerSourceWriter(pool).write_batch((item,))

        self.assertEqual(result.inserted, 1)
        self.assertEqual(item.source_version, "attacker-v2")
        self.assertEqual(pool.connection.inserted_args[0][7], original_version)
        self.assertEqual(pool.connection.inserted_args[0][17], original_hash)

    async def test_nested_feature_mutation_after_prepare_does_not_change_insert(self) -> None:
        features = {"nested": {"labels": ["before"]}}
        item = record(features=features)

        def mutate_features() -> None:
            features["nested"]["labels"][0] = "attacker"
            features["nested"]["labels"].append("later")

        pool = FakePool(on_acquire=mutate_features)
        await MultibaggerSourceWriter(pool).write_batch((item,))

        self.assertEqual(
            pool.connection.inserted_args[0][11],
            '{"nested":{"labels":["before"]}}',
        )

    async def test_forged_hash_is_rejected_before_database_roundtrip(self) -> None:
        pool = FakePool()
        item = record()
        object.__setattr__(item, "fact_hash", ForgedHash("0" * 64))

        with self.assertRaisesRegex(ValueError, "SHA-256"):
            await MultibaggerSourceWriter(pool).write_batch((item,))

        self.assertEqual(pool.acquire_count, 0)

    async def test_insert_then_replay_is_noop(self) -> None:
        pool = FakePool()
        writer = MultibaggerSourceWriter(pool)
        item = record()
        first = await writer.write_batch((item,))
        second = await writer.write_batch((item,))
        self.assertEqual((first.inserted, first.deduplicated), (1, 0))
        self.assertEqual((second.inserted, second.deduplicated), (0, 1))
        self.assertEqual(len(pool.connection.rows), 1)
        self.assertEqual(len(set(pool.connection.lock_keys)), 1)
        self.assertEqual(pool.connection.active_transactions, 0)

    async def test_two_writers_same_hash_noop_different_hash_conflict(self) -> None:
        pool = FakePool()
        first_writer = MultibaggerSourceWriter(pool)
        second_writer = MultibaggerSourceWriter(pool)
        item = record()
        first = await first_writer.write_batch((item,))
        replay = await second_writer.write_batch((item,))
        self.assertEqual((first.inserted, replay.deduplicated), (1, 1))
        self.assertEqual(len(pool.connection.rows), 1)

        conflicting = record(features={"close_local": "11"})
        with self.assertRaisesRegex(MultibaggerIdempotencyConflict, "stored"):
            await second_writer.write_batch((conflicting,))
        self.assertEqual(len(pool.connection.rows), 1)
        self.assertEqual(pool.connection.active_transactions, 0)

    async def test_batch_duplicate_and_conflict_preflight(self) -> None:
        pool = FakePool()
        item = record()
        duplicate = await MultibaggerSourceWriter(pool).write_batch((item, item))
        self.assertEqual((duplicate.inserted, duplicate.deduplicated), (1, 1))
        conflict = record(features={"close_local": "11"})
        with self.assertRaisesRegex(MultibaggerIdempotencyConflict, "batch"):
            await MultibaggerSourceWriter(FakePool()).write_batch((item, conflict))

    async def test_stored_conflict_rolls_back_prior_insert(self) -> None:
        pool = FakePool()
        writer = MultibaggerSourceWriter(pool)
        conflict = record()
        key = (
            conflict.source_kind,
            conflict.record_kind,
            conflict.ticker,
            conflict.source_document_id,
            conflict.source_version,
        )
        pool.connection.rows[key] = {"f" * 64}
        earlier = record(ticker="000001", source_document_id="000001:2026-07-10")
        with self.assertRaisesRegex(MultibaggerIdempotencyConflict, "stored"):
            await writer.write_batch((earlier, conflict))
        self.assertEqual(pool.connection.rows, {key: {"f" * 64}})
        self.assertEqual(pool.connection.inserted_args, [])
        self.assertEqual(pool.connection.active_transactions, 0)

    async def test_insert_race_same_hash_noops_and_different_hash_rejects(self) -> None:
        item = record()
        same_pool = FakePool()
        same_pool.connection.race_hash = item.fact_hash
        same = await MultibaggerSourceWriter(same_pool).write_batch((item,))
        self.assertEqual((same.inserted, same.deduplicated), (0, 1))

        conflict_pool = FakePool()
        conflict_pool.connection.race_hash = "f" * 64
        with self.assertRaisesRegex(MultibaggerIdempotencyConflict, "raced"):
            await MultibaggerSourceWriter(conflict_pool).write_batch((item,))
        self.assertEqual(conflict_pool.connection.rows, {})
        self.assertEqual(conflict_pool.connection.active_transactions, 0)

    async def test_revision_appends_and_full_storage_projection_is_exact(self) -> None:
        pool = FakePool()
        writer = MultibaggerSourceWriter(pool)
        first = record(source_version="v1")
        second = record(source_version="v2")
        result = await writer.write_batch((first, second))
        self.assertEqual(result.inserted, 2)
        self.assertEqual(len(pool.connection.rows), 2)
        args = pool.connection.inserted_args[0]
        self.assertEqual(args[11], canonicalize_json(first.features))
        self.assertEqual(args[12], canonicalize_json(list(first.evidence_refs)))
        self.assertEqual(args[13], "[]")
        self.assertEqual(args[14], "{}")
        self.assertEqual(args[15], 0)
        self.assertIsNone(args[16])
        self.assertEqual(args[17], first.fact_hash)
        self.assertEqual(len(args), 18)

    async def test_lifecycle_and_daily_records_coexist(self) -> None:
        pool = FakePool()
        lifecycle = record(record_kind="LIFECYCLE")
        daily = record(record_kind="DAILY")
        result = await MultibaggerSourceWriter(pool).write_batch((lifecycle, daily))
        self.assertEqual(result.inserted, 2)
        self.assertEqual(len(pool.connection.rows), 2)

    async def test_invalid_record_has_no_database_roundtrip(self) -> None:
        pool = FakePool()
        item = record()
        object.__setattr__(item, "fact_hash", "f" * 64)
        with self.assertRaisesRegex(ValueError, "canonical storage source fact"):
            await MultibaggerSourceWriter(pool).write_batch((item,))
        self.assertEqual(pool.acquire_count, 0)

    async def test_noncanonical_source_version_has_no_database_roundtrip(self) -> None:
        for value in (
            "版本-v1",
            " baostock-v1 ",
            "\tbaostock-v1\t",
            ForgedSourceVersion("版本-v1"),
        ):
            with self.subTest(value=value, type=type(value)):
                pool = FakePool()
                item = record()
                object.__setattr__(item, "source_version", value)
                with self.assertRaisesRegex(ValueError, "printable ASCII"):
                    await MultibaggerSourceWriter(pool).write_batch((item,))
                self.assertEqual(pool.acquire_count, 0)

    async def test_empty_batch_has_no_database_roundtrip(self) -> None:
        pool = FakePool()
        result = await MultibaggerSourceWriter(pool).write_batch(())
        self.assertEqual(
            (result.attempted, result.inserted, result.deduplicated), (0, 0, 0)
        )
        self.assertEqual(pool.acquire_count, 0)


if __name__ == "__main__":
    unittest.main()
