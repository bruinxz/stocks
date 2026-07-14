"""Real PitSnapshotWriter proof through an injected psycopg async adapter."""

import asyncio
from contextlib import asynccontextmanager
import os
from pathlib import Path
import re

import psycopg
from psycopg.rows import dict_row

# Before T5-B is merged, its immutable worktree may own the top-level
# datapipeline package. Extend that package with this T5-C storage lane.
import datapipeline.storage

_T5C_STORAGE = str(Path(__file__).resolve().parents[3] / "storage")
if _T5C_STORAGE not in datapipeline.storage.__path__:
    datapipeline.storage.__path__.append(_T5C_STORAGE)

from datapipeline.storage.backtest_pit import PitIdempotencyConflict, PitSnapshotWriter
from datapipeline.storage.backtest_pit import convert_snapshot_candidate


class AsyncPsycopgConnection:
    def __init__(
        self, connection: psycopg.AsyncConnection, fail_holding: int = None
    ) -> None:
        self.connection = connection
        self.fail_holding = fail_holding

    def transaction(self):
        return self.connection.transaction()

    @staticmethod
    def _query(query: str, args: tuple) -> tuple:
        ordered = []

        def replace(match: re.Match) -> str:
            ordered.append(args[int(match.group(1)) - 1])
            return "%s"

        return re.sub(r"\$(\d+)", replace, query), tuple(ordered)

    async def fetchval(self, query: str, *args: object):
        query, args = self._query(query, args)
        async with self.connection.cursor() as cursor:
            await cursor.execute(query, args)
            row = await cursor.fetchone()
            if row is None:
                return None
            return next(iter(row.values())) if isinstance(row, dict) else row[0]

    async def fetchrow(self, query: str, *args: object):
        if (
            self.fail_holding is not None
            and "INSERT INTO backtest_pit_holding" in query
            and args[3] == self.fail_holding
        ):
            raise RuntimeError("injected holding failure")
        query, args = self._query(query, args)
        async with self.connection.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(query, args)
            if cursor.description is None:
                return {"inserted": True} if cursor.rowcount == 1 else None
            return await cursor.fetchone()

    async def fetch(self, query: str, *args: object):
        query, args = self._query(query, args)
        async with self.connection.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(query, args)
            return await cursor.fetchall()


class AsyncPsycopgPool:
    def __init__(
        self, connection: psycopg.AsyncConnection, fail_holding: int = None
    ) -> None:
        self.connection = AsyncPsycopgConnection(connection, fail_holding)

    @asynccontextmanager
    async def acquire(self):
        yield self.connection


async def main() -> None:
    from ai.tests.test_six_month_replay import _engine, _landed_calendar

    connection = await psycopg.AsyncConnection.connect(
        host=os.environ["PGHOST"],
        port=int(os.environ["PGPORT"]),
        user=os.environ["PGUSER"],
        dbname=os.environ["PGDATABASE"],
        password=None,
        row_factory=dict_row,
    )
    try:
        batch = _engine(calendar=_landed_calendar()).run_all()
        assert (
            batch.daily_evaluations,
            batch.snapshot_count,
            batch.holding_count,
        ) == (1024, 216, 648)
        fixtures = [
            convert_snapshot_candidate(candidate)
            for run in batch.runs
            for candidate in run.snapshots
        ]
        first, first_holdings = fixtures[0]
        failure_writer = PitSnapshotWriter(AsyncPsycopgPool(connection, fail_holding=1))
        try:
            await failure_writer.write_or_verify(first, first_holdings)
        except RuntimeError as error:
            assert str(error) == "injected holding failure"
        else:
            raise AssertionError("injected child failure did not propagate")
        async with connection.cursor() as cursor:
            await cursor.execute("SELECT count(*) FROM backtest_pit_snapshot")
            assert next(iter((await cursor.fetchone()).values())) == 0
            await cursor.execute("SELECT count(*) FROM backtest_pit_holding")
            assert next(iter((await cursor.fetchone()).values())) == 0
        # The verification SELECTs above open an implicit psycopg transaction.
        # Close it before subsequent writer transactions so they are real
        # top-level commits, not savepoints rolled back when this process exits.
        await connection.commit()

        writer = PitSnapshotWriter(AsyncPsycopgPool(connection))
        inserted = [
            await writer.write_or_verify(snapshot, holdings)
            for snapshot, holdings in fixtures
        ]
        assert len(inserted) == 216
        assert all(item.inserted for item in inserted)

        replayed = [
            await writer.write_or_verify(snapshot, holdings)
            for snapshot, holdings in fixtures
        ]
        assert all(not item.inserted for item in replayed)
        for expected in replayed:
            readback = await writer.readback(
                strategy=expected.strategy,
                market_scope=expected.market_scope,
                as_of_utc=expected.as_of_utc,
            )
            assert readback == expected

        changed_metrics = dict(first.metrics)
        changed_metrics["net_value"] += 0.1
        changed_metrics["cumulative_return"] = changed_metrics["net_value"] - 1.0
        from datapipeline.storage.backtest_pit import (
            PitSnapshotFact,
            canonical_snapshot_hash,
        )

        changed = PitSnapshotFact(
            **{**first.__dict__, "metrics": changed_metrics, "fact_hash": "0" * 64}
        )
        object.__setattr__(
            changed, "fact_hash", canonical_snapshot_hash(changed, first_holdings)
        )
        try:
            await writer.write_or_verify(changed, first_holdings)
        except PitIdempotencyConflict:
            pass
        else:
            raise AssertionError("changed PIT input did not fail closed")

        async with connection.cursor() as cursor:
            await cursor.execute("SELECT count(*) FROM backtest_pit_snapshot")
            assert next(iter((await cursor.fetchone()).values())) == 216
            await cursor.execute("SELECT count(*) FROM backtest_pit_holding")
            assert next(iter((await cursor.fetchone()).values())) == 648
            await cursor.execute(
                "SELECT count(DISTINCT (strategy, market_scope)) "
                "FROM backtest_pit_snapshot"
            )
            assert next(iter((await cursor.fetchone()).values())) == 8
        print(
            "backtest-pit-writer.pg: PASS "
            "(actual T5-B 1024 evaluations, 216 snapshots, 648 holdings, "
            "rerun/readback/conflict/rollback)"
        )
    finally:
        await connection.close()


asyncio.run(main())
