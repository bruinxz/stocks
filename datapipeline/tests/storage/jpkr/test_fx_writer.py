import copy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest

from datapipeline.collectors.jpkr_deep.fx_rate_fetcher import (
    FxSourceRow,
    normalize_fx_rows,
)
from datapipeline.storage.jpkr.fx_writer import (
    FxIdempotencyConflict,
    FxObservationWriter,
)

NOW = datetime(2026, 7, 10, 2, tzinfo=timezone.utc)


class FakeTransaction:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection
        self.snapshot = None
        self.fact_snapshot = None
        self.args_snapshot = None

    async def __aenter__(self) -> None:
        self.snapshot = copy.deepcopy(self.connection.rows)
        self.fact_snapshot = copy.deepcopy(self.connection.facts)
        self.args_snapshot = copy.deepcopy(self.connection.inserted_args)

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        if exc_type is not None:
            self.connection.rows = self.snapshot
            self.connection.facts = self.fact_snapshot
            self.connection.inserted_args = self.args_snapshot


class FakeAcquire:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection

    async def __aenter__(self) -> "FakeConnection":
        return self.connection

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None


class FakeConnection:
    def __init__(self) -> None:
        self.rows = {}
        self.predecessors = {}
        self.facts = {}
        self.inserted_args = []

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    async def fetchrow(self, sql: str, *args: object):
        if "ORDER BY" in sql:
            explicit = self.predecessors.get((args[0], args[2]))
            candidates = [
                fact
                for fact in self.facts.values()
                if fact["pair"] == args[0]
                and fact["source_kind"] == args[2]
                and fact["observation_day"] < args[3]
                and fact["available_at_utc"] <= args[4]
            ]
            if explicit is not None:
                candidates.append(explicit)
            if not candidates:
                return None
            return sorted(
                candidates,
                key=lambda fact: (
                    fact["observation_day"],
                    fact["available_at_utc"],
                    fact["source_version"],
                ),
                reverse=True,
            )[0]
        key = (args[0], args[1], args[2], args[4], args[6])
        if key in self.rows:
            return None
        self.rows[key] = args[14]
        self.facts[key] = {
            "pair": args[0],
            "observation_day": args[2],
            "available_at_utc": args[3],
            "source_kind": args[4],
            "source_version": args[6],
            "local_per_usd": args[7],
            "fact_hash": args[14],
        }
        self.inserted_args.append(args)
        return {"fact_hash": args[14]}

    async def fetchval(self, sql: str, *args: object):
        return self.rows.get(tuple(args))


class FakePool:
    def __init__(self) -> None:
        self.connection = FakeConnection()
        self.acquire_count = 0

    def acquire(self) -> FakeAcquire:
        self.acquire_count += 1
        return FakeAcquire(self.connection)


def observation(
    day: int = 10,
    version: str = "v1",
    rate: str = "150",
    source_document_id: str = None,
):
    row = FxSourceRow(
        pair="USDJPY",
        observation_day=date(2026, 7, day),
        available_at_utc=NOW,
        local_per_usd=Decimal(rate),
        source_kind="BOJ",
        source_document_id=source_document_id or f"doc-{day}",
        source_version=version,
    )
    return normalize_fx_rows((row,), as_of_utc=NOW)[0]


def observation_with_predecessor(
    *,
    current_rate: str = "151",
    previous_rate: str = "150",
    previous_version: str = "v1",
):
    previous = observation(
        day=9,
        version=previous_version,
        rate=previous_rate,
        source_document_id="previous-doc",
    )
    row = FxSourceRow(
        pair="USDJPY",
        observation_day=date(2026, 7, 10),
        available_at_utc=NOW,
        local_per_usd=Decimal(current_rate),
        source_kind="BOJ",
        source_document_id="current-doc",
        source_version="v1",
    )
    current = normalize_fx_rows(
        (row,), as_of_utc=NOW, previous_by_pair={"USDJPY": previous}
    )[0]
    return previous, current


def store_predecessor(pool: FakePool, previous) -> None:
    pool.connection.predecessors[(previous.pair, previous.source_kind)] = {
        "observation_day": previous.observation_day,
        "available_at_utc": previous.available_at_utc,
        "source_kind": previous.source_kind,
        "source_version": previous.source_version,
        "local_per_usd": str(previous.local_per_usd),
        "fact_hash": previous.fact_hash,
    }


class FxObservationWriterTest(unittest.IsolatedAsyncioTestCase):
    async def test_insert_then_replay_is_noop(self) -> None:
        pool = FakePool()
        writer = FxObservationWriter(pool)
        item = observation()
        first = await writer.write_batch((item,), as_of_utc=NOW)
        second = await writer.write_batch((item,), as_of_utc=NOW)
        self.assertEqual((first.inserted, first.deduplicated), (1, 0))
        self.assertEqual((second.inserted, second.deduplicated), (0, 1))
        self.assertEqual(len(pool.connection.rows), 1)

    async def test_duplicate_input_counts_as_deduplicated(self) -> None:
        writer = FxObservationWriter(FakePool())
        item = observation()
        result = await writer.write_batch((item, item), as_of_utc=NOW)
        self.assertEqual(result.attempted, 2)
        self.assertEqual(result.inserted, 1)
        self.assertEqual(result.deduplicated, 1)

    async def test_batch_insert_authenticates_same_transaction_predecessor(
        self,
    ) -> None:
        pool = FakePool()
        previous, current = observation_with_predecessor()
        result = await FxObservationWriter(pool).write_batch(
            (current, previous), as_of_utc=NOW
        )
        self.assertEqual(result.inserted, 2)
        self.assertEqual(len(pool.connection.rows), 2)

    async def test_same_identity_different_hash_rejects_before_transaction(
        self,
    ) -> None:
        pool = FakePool()
        writer = FxObservationWriter(pool)
        item = observation()
        conflict = observation(source_document_id="different-document")
        with self.assertRaisesRegex(FxIdempotencyConflict, "one FX writer batch"):
            await writer.write_batch((item, conflict), as_of_utc=NOW)
        self.assertEqual(pool.acquire_count, 0)

    async def test_stored_hash_conflict_rolls_back_whole_batch(self) -> None:
        pool = FakePool()
        writer = FxObservationWriter(pool)
        existing = observation()
        await writer.write_batch((existing,), as_of_utc=NOW)
        key = next(iter(pool.connection.rows))
        pool.connection.rows[key] = "f" * 64
        another = observation(day=9)
        with self.assertRaisesRegex(FxIdempotencyConflict, "stored FX identity"):
            await writer.write_batch((another, existing), as_of_utc=NOW)
        self.assertEqual(len(pool.connection.rows), 1)
        self.assertEqual(pool.connection.rows[key], "f" * 64)

    async def test_revision_version_appends(self) -> None:
        pool = FakePool()
        writer = FxObservationWriter(pool)
        await writer.write_batch((observation(version="v1"),), as_of_utc=NOW)
        result = await writer.write_batch(
            (observation(version="v2", rate="151"),), as_of_utc=NOW
        )
        self.assertEqual(result.inserted, 1)
        self.assertEqual(len(pool.connection.rows), 2)

    async def test_inserted_decimal_strings_and_hash_are_exact(self) -> None:
        pool = FakePool()
        item = observation()
        await FxObservationWriter(pool).write_batch((item,), as_of_utc=NOW)
        args = pool.connection.inserted_args[0]
        self.assertEqual(args[7], str(item.local_per_usd))
        self.assertEqual(args[8], str(item.usd_per_local))
        self.assertEqual(args[14], item.fact_hash)

    async def test_authoritative_predecessor_lineage_inserts(self) -> None:
        pool = FakePool()
        previous, current = observation_with_predecessor()
        store_predecessor(pool, previous)
        result = await FxObservationWriter(pool).write_batch((current,), as_of_utc=NOW)
        self.assertEqual(result.inserted, 1)

    async def test_missing_fabricated_stale_and_wrong_change_lineage_reject(
        self,
    ) -> None:
        previous, current = observation_with_predecessor()

        missing_pool = FakePool()
        with self.assertRaisesRegex(ValueError, "does not exist"):
            await FxObservationWriter(missing_pool).write_batch(
                (current,), as_of_utc=NOW
            )

        fabricated_pool = FakePool()
        store_predecessor(fabricated_pool, previous)
        fabricated = copy.copy(current)
        object.__setattr__(fabricated, "previous_fact_hash", "f" * 64)
        from datapipeline.collectors.jpkr_deep.fx_rate_fetcher import (
            canonical_fx_fact_hash,
        )

        object.__setattr__(
            fabricated,
            "fact_hash",
            canonical_fx_fact_hash(
                pair=fabricated.pair,
                observation_day=fabricated.observation_day,
                available_at_utc=fabricated.available_at_utc,
                local_per_usd=fabricated.local_per_usd,
                usd_per_local=fabricated.usd_per_local,
                change_pct=fabricated.change_pct,
                source_kind=fabricated.source_kind,
                source_document_id=fabricated.source_document_id,
                source_version=fabricated.source_version,
                previous_observation_day=fabricated.previous_observation_day,
                previous_source_kind=fabricated.previous_source_kind,
                previous_source_version=fabricated.previous_source_version,
                previous_fact_hash=fabricated.previous_fact_hash,
            ),
        )
        with self.assertRaisesRegex(ValueError, "stale or fabricated"):
            await FxObservationWriter(fabricated_pool).write_batch(
                (fabricated,), as_of_utc=NOW
            )

        stale_pool = FakePool()
        latest_previous = observation(
            day=9,
            version="v2",
            rate="150.5",
            source_document_id="latest-revision",
        )
        store_predecessor(stale_pool, latest_previous)
        with self.assertRaisesRegex(ValueError, "stale or fabricated"):
            await FxObservationWriter(stale_pool).write_batch((current,), as_of_utc=NOW)

        wrong_change_pool = FakePool()
        store_predecessor(wrong_change_pool, previous)
        wrong_change = copy.copy(current)
        object.__setattr__(wrong_change, "change_pct", Decimal("99"))
        object.__setattr__(
            wrong_change,
            "fact_hash",
            canonical_fx_fact_hash(
                pair=wrong_change.pair,
                observation_day=wrong_change.observation_day,
                available_at_utc=wrong_change.available_at_utc,
                local_per_usd=wrong_change.local_per_usd,
                usd_per_local=wrong_change.usd_per_local,
                change_pct=wrong_change.change_pct,
                source_kind=wrong_change.source_kind,
                source_document_id=wrong_change.source_document_id,
                source_version=wrong_change.source_version,
                previous_observation_day=wrong_change.previous_observation_day,
                previous_source_kind=wrong_change.previous_source_kind,
                previous_source_version=wrong_change.previous_source_version,
                previous_fact_hash=wrong_change.previous_fact_hash,
            ),
        )
        with self.assertRaisesRegex(ValueError, "authoritative predecessor"):
            await FxObservationWriter(wrong_change_pool).write_batch(
                (wrong_change,), as_of_utc=NOW
            )

    async def test_existing_predecessor_requires_lineage(self) -> None:
        pool = FakePool()
        previous = observation(day=9)
        store_predecessor(pool, previous)
        with self.assertRaisesRegex(ValueError, "lineage is missing"):
            await FxObservationWriter(pool).write_batch(
                (observation(day=10),), as_of_utc=NOW
            )

    async def test_future_availability_rejects_before_database(self) -> None:
        pool = FakePool()
        writer = FxObservationWriter(pool)
        item = observation()
        object.__setattr__(item, "available_at_utc", NOW + timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "not available"):
            await writer.write_batch((item,), as_of_utc=NOW)
        self.assertEqual(pool.acquire_count, 0)

    async def test_corrupted_reciprocal_and_lineage_reject_before_database(
        self,
    ) -> None:
        pool = FakePool()
        writer = FxObservationWriter(pool)
        bad_reciprocal = observation()
        object.__setattr__(bad_reciprocal, "usd_per_local", Decimal("0.5"))
        with self.assertRaisesRegex(ValueError, "reciprocal"):
            await writer.write_batch((bad_reciprocal,), as_of_utc=NOW)

        bad_lineage = observation()
        object.__setattr__(bad_lineage, "previous_observation_day", date(2026, 7, 9))
        with self.assertRaisesRegex(ValueError, "previous lineage"):
            await writer.write_batch((bad_lineage,), as_of_utc=NOW)

        bad_hash = observation()
        object.__setattr__(bad_hash, "fact_hash", "f" * 64)
        with self.assertRaisesRegex(ValueError, "canonical FX payload"):
            await writer.write_batch((bad_hash,), as_of_utc=NOW)
        self.assertEqual(pool.acquire_count, 0)

    async def test_future_economic_day_rejects_before_database(self) -> None:
        pool = FakePool()
        writer = FxObservationWriter(pool)
        item = observation()
        object.__setattr__(item, "observation_day", date(2026, 7, 11))
        with self.assertRaisesRegex(ValueError, "economic day"):
            await writer.write_batch((item,), as_of_utc=NOW)
        self.assertEqual(pool.acquire_count, 0)

    async def test_over_scale_and_integer_overflow_reject_before_database(self) -> None:
        mutations = (
            ("local_per_usd", Decimal("150.00000000000"), "storage scale"),
            ("local_per_usd", Decimal("123456789012345"), "integer digits"),
            ("usd_per_local", Decimal("0.006666666666670"), "storage scale"),
        )
        for field, value, message in mutations:
            with self.subTest(field=field, value=value):
                pool = FakePool()
                item = observation()
                object.__setattr__(item, field, value)
                with self.assertRaisesRegex(ValueError, message):
                    await FxObservationWriter(pool).write_batch((item,), as_of_utc=NOW)
                self.assertEqual(pool.acquire_count, 0)

        pool = FakePool()
        previous, current = observation_with_predecessor()
        store_predecessor(pool, previous)
        object.__setattr__(current, "change_pct", Decimal("0.123456789"))
        with self.assertRaisesRegex(ValueError, "storage scale"):
            await FxObservationWriter(pool).write_batch((current,), as_of_utc=NOW)
        self.assertEqual(pool.acquire_count, 0)

    async def test_empty_batch_has_no_database_roundtrip(self) -> None:
        pool = FakePool()
        result = await FxObservationWriter(pool).write_batch((), as_of_utc=NOW)
        self.assertEqual(
            (result.attempted, result.inserted, result.deduplicated), (0, 0, 0)
        )
        self.assertEqual(pool.acquire_count, 0)


if __name__ == "__main__":
    unittest.main()
