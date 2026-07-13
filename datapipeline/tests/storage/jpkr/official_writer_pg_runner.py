"""Invoke the real async writers against psycopg in a disposable database."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from datapipeline.collectors.jpkr_deep import (
    canonical_security_fact_hash,
    normalize_fx_rows,
    parse_boj_csv,
    parse_jpx_kline_fixture,
    parse_jpx_security_fixture,
    parse_kind_disclosure_fixture,
)
from datapipeline.contracts import capture_source_version, validate_capture_wrapper
from datapipeline.storage.jpkr import (
    FxObservationWriter,
    JpKrOfficialWriter,
    OfficialFactConflict,
)

FIXTURES = Path(__file__).parents[3] / "fixtures" / "real_data_r1"


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


async def main():
    url = os.environ["DATABASE_URL"]
    pool = Pool(url)
    official = JpKrOfficialWriter(pool)
    available = datetime(2026, 7, 13, 6, 0, tzinfo=timezone.utc)
    securities = parse_jpx_security_fixture(load("jpx_security_sample.json"))
    klines = parse_jpx_kline_fixture(load("jpx_kline_sample.json"))
    disclosures = parse_kind_disclosure_fixture(load("kind_disclosure_sample.json"))
    first = (
        await official.write_security(securities),
        await official.write_klines(klines),
        await official.write_disclosures(disclosures),
    )
    second = (
        await official.write_security(securities),
        await official.write_klines(klines),
        await official.write_disclosures(disclosures),
    )
    assert [item.inserted for item in first] == [3, 1, 3]
    assert [item.deduplicated for item in second] == [3, 1, 3]

    new_draft = replace(
        securities[1],
        ticker="0001",
        source_document_id="jpx-listed:2026-06-30:0001",
        fact_hash="0" * 64,
    )
    new_security = replace(new_draft, fact_hash=canonical_security_fact_hash(new_draft))
    changed_draft = replace(
        securities[0],
        ticker_name_local=securities[0].ticker_name_local + " changed",
        fact_hash="0" * 64,
    )
    changed_security = replace(
        changed_draft,
        fact_hash=canonical_security_fact_hash(changed_draft),
    )
    try:
        await official.write_security((new_security, changed_security))
    except OfficialFactConflict:
        pass
    else:
        raise AssertionError("changed-hash identity must fail closed")

    fx = FxObservationWriter(pool)
    bok_fixture = load("bok_fx_sample.json")
    assert bok_fixture["fixture_mode"] == "synthetic-keyed-unverified"
    assert bok_fixture["gap_code"] == "PRIVATE_KEY_REQUIRED"
    boj_fixture = load("boj_fx_sample.json")
    boj_payload = validate_capture_wrapper(boj_fixture, expected_source_kind="BOJ")
    boj_csv = "observation_day,local_per_usd\n" + "\n".join(
        f"{row['observation_day']},{row['local_per_usd']}"
        for row in boj_payload["rows"]
    )
    boj = normalize_fx_rows(
        parse_boj_csv(
            boj_csv,
            available_at_utc=available,
            source_document_id=("BOJ:FM08'FXERD04:" + boj_fixture["capture_instance"]),
            source_version=capture_source_version(boj_fixture),
        ),
        as_of_utc=available,
    )
    first_fx = await fx.write_batch(boj, as_of_utc=available)
    second_fx = await fx.write_batch(boj, as_of_utc=available)
    assert first_fx.inserted == 3
    assert second_fx.deduplicated == 3

    with psycopg.connect(url, row_factory=dict_row, passfile="") as connection:
        counts = {
            table: connection.execute(f"SELECT count(*) AS n FROM {table}").fetchone()[
                "n"
            ]
            for table in (
                "jpkr_security_master",
                "jpkr_daily_kline",
                "jpkr_disclosure_event",
                "jpkr_fx_observation",
            )
        }
        rolled_back = connection.execute(
            "SELECT count(*) AS n FROM jpkr_security_master WHERE ticker='0001'"
        ).fetchone()["n"]
        stored_availability = {
            "security": connection.execute(
                "SELECT available_at_utc FROM jpkr_security_master "
                "WHERE ticker='1301'"
            )
            .fetchone()["available_at_utc"]
            .astimezone(timezone.utc),
            "kline": connection.execute(
                "SELECT available_at_utc FROM jpkr_daily_kline " "WHERE ticker='1301'"
            )
            .fetchone()["available_at_utc"]
            .astimezone(timezone.utc),
            "disclosure": connection.execute(
                "SELECT available_at_utc FROM jpkr_disclosure_event "
                "WHERE source_document_id='20260710001011'"
            )
            .fetchone()["available_at_utc"]
            .astimezone(timezone.utc),
            "fx": connection.execute(
                "SELECT available_at_utc FROM jpkr_fx_observation "
                "ORDER BY observation_day LIMIT 1"
            )
            .fetchone()["available_at_utc"]
            .astimezone(timezone.utc),
        }
    assert counts == {
        "jpkr_security_master": 3,
        "jpkr_daily_kline": 1,
        "jpkr_disclosure_event": 3,
        "jpkr_fx_observation": 3,
    }
    assert rolled_back == 0
    assert stored_availability == {
        "security": datetime(2026, 7, 2, 4, 20, 56, tzinfo=timezone.utc),
        "kline": datetime(2026, 7, 10, 7, 0, 0, tzinfo=timezone.utc),
        "disclosure": datetime(2026, 7, 13, 22, 38, 43, tzinfo=timezone.utc),
        "fx": datetime(2026, 7, 13, 6, 0, 0, tzinfo=timezone.utc),
    }
    print("official-writer-pg-runner: PASS", counts)


if __name__ == "__main__":
    asyncio.run(main())
