"""Real PitSnapshotWriter proof through an injected psycopg async adapter."""

import asyncio
from contextlib import asynccontextmanager
import os
import re

import psycopg
from psycopg.rows import dict_row

from datapipeline.storage.backtest_pit import PitIdempotencyConflict, PitSnapshotWriter
from datapipeline.tests.storage.backtest_pit.test_six_month_fixture import (
    LEGAL_PAIRS,
    fixture_snapshot,
)


class AsyncPsycopgConnection:
    def __init__(self, connection: psycopg.AsyncConnection) -> None:
        self.connection = connection

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
    def __init__(self, connection: psycopg.AsyncConnection) -> None:
        self.connection = AsyncPsycopgConnection(connection)

    @asynccontextmanager
    async def acquire(self):
        yield self.connection


async def main() -> None:
    connection = await psycopg.AsyncConnection.connect(
        host=os.environ["PGHOST"],
        port=int(os.environ["PGPORT"]),
        user=os.environ["PGUSER"],
        dbname=os.environ["PGDATABASE"],
        password=None,
        row_factory=dict_row,
    )
    try:
        writer = PitSnapshotWriter(AsyncPsycopgPool(connection))
        fixtures = [
            fixture_snapshot(strategy, scope, index)
            for strategy, scope in LEGAL_PAIRS
            for index in range(27)
        ]
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

        first, first_holdings = fixtures[0]
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
            "(216 snapshots, 648 holdings, rerun/readback/conflict)"
        )
    finally:
        await connection.close()


asyncio.run(main())
