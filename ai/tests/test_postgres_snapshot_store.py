from __future__ import annotations

import copy
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import os
import unittest

from ai.snapshot.postgres_store import (
    ITEM_COLUMNS,
    SNAPSHOT_COLUMNS,
    PostgresSnapshotStore,
    SnapshotStoreConfigurationError,
    SnapshotStoreConnectionError,
    _item_from_row,
    _snapshot_from_row,
    validate_database_url,
)
from ai.snapshot.store import SnapshotItemRow, SnapshotRow
from ai.snapshot.writer import SnapshotWriter
from ai.tests.test_snapshot_persistence import (
    _context,
    _recommendation_list,
)


class PostgresSnapshotStoreUnitTests(unittest.TestCase):
    def test_database_url_is_the_only_fail_closed_authority(self) -> None:
        valid = [
            "postgresql://stocks:secret@db.internal:5432/stocks",
            "postgres://stocks:secret@db.internal/stocks?sslmode=require",
            "postgresql://stocks@/stocks?host=/tmp&port=5432",
        ]
        for value in valid:
            with self.subTest(value=value):
                self.assertEqual(validate_database_url(value), value)

        invalid = [
            "",
            " postgresql://stocks:secret@db/stocks",
            "mysql://stocks:secret@db/stocks",
            "postgresql://db/stocks",
            "postgresql://stocks:secret@db/",
            "postgresql://stocks@db/stocks",
            "postgresql://stocks:secret@db/stocks#fragment",
            "postgresql://stocks@/stocks?host=relative",
            "postgresql://stocks@/stocks?host=/tmp&host=/var/run/postgresql",
            "postgresql://stocks:secret@db/stocks?service=prod",
            "postgresql://stocks:secret@db:0/stocks",
            "postgresql://stocks@/stocks?host=/tmp&port=５４３２",
            "postgresql://stocks:secret%ZZ@db/stocks",
            "postgresql://stocks:secret@db/stocks%ZZ",
        ]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(SnapshotStoreConfigurationError):
                    validate_database_url(value)

        connector_calls = []

        def connector(value):
            connector_calls.append(value)
            raise AssertionError("connector should not run")

        for environment in (
            {},
            {"DATABASE_URL": ""},
            {
                "DATABASE_URL": "postgresql://stocks@/stocks?host=/tmp",
                "PGSERVICE": "production",
            },
            {
                "DATABASE_URL": "postgresql://stocks@/stocks?host=/tmp",
                "PGPASSWORD": "ambient-secret",
            },
        ):
            with self.subTest(environment=environment):
                with self.assertRaises(SnapshotStoreConfigurationError):
                    PostgresSnapshotStore.from_env(environment, connector=connector)
        self.assertEqual(connector_calls, [])

    def test_connector_failure_is_redacted(self) -> None:
        secret_url = "postgresql://stocks:do-not-leak@db.internal/stocks"

        def connector(_value):
            raise RuntimeError(secret_url)

        store = PostgresSnapshotStore(secret_url, connector=connector)
        with self.assertRaises(SnapshotStoreConnectionError) as raised:
            store.get_snapshot("12345678-1234-4234-8234-567812345678")
        self.assertNotIn("do-not-leak", str(raised.exception))

    def test_exact_physical_projection_and_row_mapping(self) -> None:
        self.assertEqual(SNAPSHOT_COLUMNS, tuple(SnapshotRow.__dataclass_fields__))
        self.assertEqual(ITEM_COLUMNS, tuple(SnapshotItemRow.__dataclass_fields__))
        envelope = {"snapshot_id": "12345678-1234-4234-8234-567812345678"}
        snapshot_values = {
            "snapshot_id": "12345678-1234-4234-8234-567812345678",
            "as_of_utc": datetime(
                2026, 7, 12, 9, 2, 3, tzinfo=timezone(timedelta(hours=8))
            ),
            "trading_day": date(2026, 7, 12),
            "profile": "us_preferred",
            "market_scope": "us",
            "contract_version": "0.3.1",
            "profile_version": "3.1.0",
            "pipeline_version": "3.1.0",
            "model_version": "3.1.0",
            "strategy_version": "3.1.0",
            "rule_bundle_hash": "a" * 64,
            "template_hash": "b" * 64,
            "disclaimer_hash": "c" * 64,
            "input_fingerprint": "d" * 64,
            "output_fingerprint": "e" * 64,
            "fingerprint_preimage_jcs": "{}",
            "idempotency_key": "f" * 64,
            "item_count": 1,
            "envelope_json": envelope,
        }
        snapshot = _snapshot_from_row(snapshot_values)
        self.assertEqual(snapshot.as_of_utc, "2026-07-12T01:02:03Z")
        self.assertEqual(snapshot.trading_day, "2026-07-12")
        self.assertIs(snapshot.envelope_json, envelope)

        recommendation = {"ticker": "AAPL"}
        item = _item_from_row(
            {
                "item_id": "22345678-1234-4234-8234-567812345678",
                "snapshot_id": snapshot.snapshot_id,
                "ticker": "AAPL",
                "sort_rank": 0,
                "recommendation_json": recommendation,
                "recommendation_jcs": '{"ticker":"AAPL"}',
                "recommendation_hash": "1" * 64,
                "rating_band": "A",
                "conviction_final": Decimal("88.0"),
                "risk_gate_status": "GREEN",
                "size_hint_tier": "TIER_3",
            }
        )
        self.assertEqual(item.conviction_final, 88.0)
        self.assertIs(item.recommendation_json, recommendation)

        with self.assertRaisesRegex(RuntimeError, "projection"):
            _snapshot_from_row({"snapshot_id": snapshot.snapshot_id})
        with self.assertRaisesRegex(RuntimeError, "conviction"):
            _item_from_row(
                {
                    **{field: getattr(item, field) for field in ITEM_COLUMNS},
                    "conviction_final": Decimal("NaN"),
                }
            )


@unittest.skipUnless(
    os.environ.get("SNAPSHOT_PG_INTEGRATION") == "1",
    "requires explicitly guarded disposable PostgreSQL",
)
class PostgresSnapshotStoreIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = PostgresSnapshotStore.from_env()
        import psycopg

        with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
            connection.execute(
                "TRUNCATE ai_recommendation_item, " "ai_recommendation_snapshot CASCADE"
            )

    def test_writer_roundtrip_idempotency_and_reads(self) -> None:
        ctx = _context()
        payload = _recommendation_list(ctx)
        writer = SnapshotWriter(self.store)

        first = writer.write(ctx, payload)
        second = writer.write(ctx, copy.deepcopy(payload))

        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual(first.snapshot_id, second.snapshot_id)
        snapshot = self.store.get_snapshot(first.snapshot_id)
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot.envelope_json, payload)
        items = self.store.get_items(first.snapshot_id)
        self.assertEqual([item.sort_rank for item in items], [0, 1])
        self.assertEqual([item.ticker for item in items], ["AAPL", "MSFT"])
        self.assertEqual(
            self.store.list_snapshots(profile="us_preferred", market_scope="us"),
            (snapshot,),
        )
        self.assertEqual(
            self.store.list_snapshots(
                profile="us_preferred",
                market_scope="us",
                trading_day=ctx.config.trading_day,
            ),
            (snapshot,),
        )
        self.assertEqual(
            self.store.list_snapshots(
                profile="us_preferred",
                market_scope="cn_a",
            ),
            (),
        )

    def test_transaction_rolls_back_header_and_children(self) -> None:
        ctx = _context()
        payload = _recommendation_list(ctx)
        writer = SnapshotWriter(self.store)
        snapshot, items = writer._build_rows(ctx, payload)

        with self.assertRaisesRegex(RuntimeError, "injected rollback"):
            with self.store.transaction() as transaction:
                transaction.insert_snapshot(snapshot)
                transaction.insert_items(items)
                raise RuntimeError("injected rollback")
        self.assertIsNone(self.store.get_snapshot(snapshot.snapshot_id))
        self.assertEqual(self.store.get_items(snapshot.snapshot_id), ())

        bad_item = replace(items[0], recommendation_hash="0" * 64)
        with self.assertRaises(Exception):
            with self.store.transaction() as transaction:
                transaction.insert_snapshot(snapshot)
                transaction.insert_items((bad_item,))
        self.assertIsNone(self.store.get_snapshot(snapshot.snapshot_id))


if __name__ == "__main__":
    unittest.main()
