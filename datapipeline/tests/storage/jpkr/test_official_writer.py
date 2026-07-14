from __future__ import annotations

import copy
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import unittest

from datapipeline.collectors.jpkr_deep import (
    parse_jpx_kline_fixture,
    parse_jpx_security_fixture,
    parse_kind_disclosure_fixture,
)
from datapipeline.storage.jpkr import JpKrOfficialWriter, OfficialFactConflict

FIXTURES = Path(__file__).parents[3] / "fixtures" / "real_data_r1"


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        self.snapshot = copy.deepcopy(self.connection.rows)

    async def __aexit__(self, exc_type, exc, tb):
        if exc_type:
            self.connection.rows = self.snapshot


class Acquire:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, exc_type, exc, tb):
        return None


class Connection:
    def __init__(self):
        self.rows = {}

    def transaction(self):
        return Transaction(self)

    async def fetchval(self, sql, *key):
        return self.rows.get(tuple(key))

    async def fetchrow(self, sql, *values):
        if "jpkr_security_master" in sql:
            key = (values[10], values[11], values[12], values[3])
            digest = values[14]
        elif "jpkr_daily_kline" in sql:
            key = (values[2], values[3], values[6], values[22], values[24])
            digest = values[25]
        else:
            key = (values[8], values[9], values[10])
            digest = values[11]
        self.rows[key] = digest
        return {"id": "fixture"}


class Pool:
    def __init__(self):
        self.connection = Connection()

    def acquire(self):
        return Acquire(self.connection)


class OfficialWriterTest(unittest.IsolatedAsyncioTestCase):
    async def test_all_allowed_rows_insert_and_replay(self) -> None:
        pool = Pool()
        writer = JpKrOfficialWriter(pool)
        available = datetime(2026, 7, 2, 4, 20, 56, tzinfo=timezone.utc)
        securities = parse_jpx_security_fixture(load("jpx_security_sample.json"))
        klines = parse_jpx_kline_fixture(load("jpx_kline_sample.json"))
        disclosures = parse_kind_disclosure_fixture(load("kind_disclosure_sample.json"))
        first = (
            await writer.write_security(securities),
            await writer.write_klines(klines),
            await writer.write_disclosures(disclosures),
        )
        second = (
            await writer.write_security(securities),
            await writer.write_klines(klines),
            await writer.write_disclosures(disclosures),
        )
        self.assertEqual([item.inserted for item in first], [3, 1, 3])
        self.assertEqual([item.deduplicated for item in second], [3, 1, 3])
        self.assertEqual(len(pool.connection.rows), 7)

    async def test_changed_hash_conflict_and_batch_rollback(self) -> None:
        pool = Pool()
        writer = JpKrOfficialWriter(pool)
        available = datetime(2026, 7, 2, 4, 20, 56, tzinfo=timezone.utc)
        records = parse_jpx_security_fixture(load("jpx_security_sample.json"))
        await writer.write_security(records)
        pool.connection.rows[
            (
                records[0].source_kind,
                records[0].source_document_id,
                records[0].source_version,
                records[0].ticker,
            )
        ] = (
            "f" * 64
        )
        with self.assertRaises(OfficialFactConflict):
            await writer.write_security(records)

    async def test_changed_availability_cannot_reuse_capture_fact_hash(self) -> None:
        pool = Pool()
        writer = JpKrOfficialWriter(pool)
        records = parse_jpx_security_fixture(load("jpx_security_sample.json"))
        changed = replace(
            records[0],
            available_at_utc=datetime(2027, 1, 1, tzinfo=timezone.utc),
        )
        with self.assertRaisesRegex(ValueError, "fact hash"):
            await writer.write_security((changed,))
        self.assertEqual(pool.connection.rows, {})


if __name__ == "__main__":
    unittest.main()
