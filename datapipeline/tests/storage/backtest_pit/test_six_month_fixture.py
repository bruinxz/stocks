from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest

from datapipeline.fixtures.market_calendar import (
    LOCAL_DISPOSABLE_PURPOSE,
    SyntheticCalendarPort,
)
from datapipeline.storage.backtest_pit import (
    PitHoldingFact,
    PitIdempotencyConflict,
    PitSnapshotFact,
    PitSnapshotWriter,
    canonical_holding_hash,
    canonical_snapshot_hash,
)
from datapipeline.tests.storage.backtest_pit.test_writer import FakePool, uuid_for

LEGAL_PAIRS = (
    ("us_preferred", "cn_a"),
    ("us_preferred", "us"),
    ("multibagger", "cn_a"),
    ("multibagger", "us"),
    ("japan_blue_chip", "jp"),
    ("japan_multibagger", "jp"),
    ("korea_semiconductor_chain", "kr"),
    ("korea_multibagger", "kr"),
)
SYMBOLS = {
    "cn_a": ("600000.SH", "000001.SZ", "300750.SZ"),
    "us": ("AAPL", "MSFT", "NVDA"),
    "jp": ("7203.T", "6758.T", "8306.T"),
    "kr": ("005930.KS", "000660.KS", "035420.KS"),
}


CALENDAR = SyntheticCalendarPort(purpose=LOCAL_DISPOSABLE_PURPOSE)


def metric_values(index: int) -> dict:
    nav = 1.0 + index / 1000
    return {
        "net_value": nav,
        "drawdown": -index / 10000,
        "cumulative_return": nav - 1.0,
        "sharpe_ratio_6m": None if index == 0 else 1.0,
        "win_rate_6m": None if index == 0 else 0.5,
        "metric_contract_version": "1.0.0",
        "window_start": "2026-01-10",
        "window_end": "2026-07-10",
        "evaluated_session_count": min(128, index * 5 + 1),
        "checkpoint_index": index,
        "checkpoint_count": 27,
        "initial_nav": 1.0,
        "commission_bps_per_side": 5,
        "slippage_bps_per_side": 5,
        "annualization_sessions": 252,
    }


def fixture_snapshot(strategy: str, scope: str, index: int) -> tuple:
    checkpoint = CALENDAR.checkpoints(scope)[index]
    day = date.fromisoformat(checkpoint.trade_date)
    as_of = datetime.fromisoformat(
        checkpoint.session_close_utc.removesuffix("Z") + "+00:00"
    )
    holdings = []
    for position, ticker in enumerate(SYMBOLS[scope]):
        item = PitHoldingFact(
            holding_id=uuid_for(
                f"holding:{strategy}:{scope}:{as_of.isoformat()}:{position}"
            ),
            position_order=position,
            market_scope=scope,
            ticker=ticker,
            weight=Decimal("0.3333333333") if position < 2 else Decimal("0.3333333334"),
            return_since_entry=Decimal(f"{index / 1000:.10f}"),
            is_stale=index == 13 and position == 1,
            is_delisted_at_as_of=index == 26 and position == 2,
            source_kind="synthetic-price",
            source_document_id=f"price:{scope}:{ticker}:{day.isoformat()}",
            source_version="fixture-v1",
            available_at_utc=as_of,
            lineage={
                "fixture_hash": "a" * 64,
                "checkpoint": index,
                "is_delisted_at_as_of": index == 26 and position == 2,
            },
            fact_hash="0" * 64,
        )
        object.__setattr__(item, "fact_hash", canonical_holding_hash(item))
        holdings.append(item)
    ordered = tuple(holdings)
    snapshot = PitSnapshotFact(
        snapshot_id=uuid_for(f"snapshot:{strategy}:{scope}:{as_of.isoformat()}"),
        strategy=strategy,
        market_scope=scope,
        as_of_utc=as_of,
        snapshot_day=day,
        published_at_utc=as_of + timedelta(seconds=1),
        is_survivorship_biased=False,
        is_delisted_at_as_of=any(item.is_delisted_at_as_of for item in ordered),
        source_versions={
            "calendar": checkpoint.fixture_version,
            "prices": "fixture-v1",
            "strategy": "fixture-v1",
        },
        lineage_closure={
            "survivorship_evidence": {"retained_delisted": True},
            "calendar_fixture_hash": CALENDAR.fixture_hash(scope),
            "universe_fixture_hash": "c" * 64,
        },
        metrics=metric_values(index),
        fact_hash="0" * 64,
    )
    object.__setattr__(
        snapshot, "fact_hash", canonical_snapshot_hash(snapshot, ordered)
    )
    return snapshot, ordered


class SixMonthPitWriterTest(unittest.IsolatedAsyncioTestCase):
    async def test_exact_216_snapshots_648_holdings_and_idempotent_readback(
        self,
    ) -> None:
        pool = FakePool()
        writer = PitSnapshotWriter(pool)
        manifests = []
        for strategy, scope in LEGAL_PAIRS:
            for index in range(27):
                snapshot, holdings = fixture_snapshot(strategy, scope, index)
                manifests.append(await writer.write_or_verify(snapshot, holdings))

        self.assertEqual(len(manifests), 216)
        self.assertEqual(len(pool.connection.snapshots), 216)
        self.assertEqual(
            sum(len(items) for items in pool.connection.holdings.values()), 648
        )
        self.assertEqual(
            {(item.strategy, item.market_scope) for item in manifests},
            set(LEGAL_PAIRS),
        )
        self.assertEqual(len({item.snapshot_id for item in manifests}), 216)
        self.assertEqual(len({item.snapshot_fact_hash for item in manifests}), 216)

        before_snapshot_ids = {
            key: value["snapshot_id"]
            for key, value in pool.connection.snapshots.items()
        }
        before_holding_hashes = {
            key: tuple(item["fact_hash"] for item in values)
            for key, values in pool.connection.holdings.items()
        }
        replayed = []
        for strategy, scope in LEGAL_PAIRS:
            for index in range(27):
                snapshot, holdings = fixture_snapshot(strategy, scope, index)
                replayed.append(await writer.write_or_verify(snapshot, holdings))
        self.assertTrue(all(not item.inserted for item in replayed))
        self.assertEqual(
            before_snapshot_ids,
            {
                key: value["snapshot_id"]
                for key, value in pool.connection.snapshots.items()
            },
        )
        self.assertEqual(
            before_holding_hashes,
            {
                key: tuple(item["fact_hash"] for item in values)
                for key, values in pool.connection.holdings.items()
            },
        )

        for manifest in manifests:
            readback = await writer.readback(
                strategy=manifest.strategy,
                market_scope=manifest.market_scope,
                as_of_utc=manifest.as_of_utc,
            )
            self.assertEqual(
                readback, PitSnapshotFactManifest.with_inserted_false(manifest)
            )

    async def test_changed_input_conflict_has_zero_row_drift(self) -> None:
        pool = FakePool()
        writer = PitSnapshotWriter(pool)
        original, holdings = fixture_snapshot("us_preferred", "cn_a", 5)
        await writer.write_or_verify(original, holdings)
        before = copy_state(pool)

        changed_metrics = dict(original.metrics)
        changed_metrics["net_value"] = changed_metrics["net_value"] + 0.1
        changed_metrics["cumulative_return"] = changed_metrics["net_value"] - 1.0
        changed = PitSnapshotFact(
            **{
                **original.__dict__,
                "metrics": changed_metrics,
                "fact_hash": "0" * 64,
            }
        )
        object.__setattr__(
            changed, "fact_hash", canonical_snapshot_hash(changed, holdings)
        )
        with self.assertRaisesRegex(PitIdempotencyConflict, "header differs"):
            await writer.write_or_verify(changed, holdings)
        self.assertEqual(before, copy_state(pool))


class PitSnapshotFactManifest:
    @staticmethod
    def with_inserted_false(manifest):
        return type(manifest)(
            snapshot_id=manifest.snapshot_id,
            strategy=manifest.strategy,
            market_scope=manifest.market_scope,
            as_of_utc=manifest.as_of_utc,
            snapshot_day=manifest.snapshot_day,
            snapshot_fact_hash=manifest.snapshot_fact_hash,
            holding_fact_hashes=manifest.holding_fact_hashes,
            inserted=False,
        )


def copy_state(pool: FakePool) -> tuple:
    import copy

    return (
        copy.deepcopy(pool.connection.snapshots),
        copy.deepcopy(pool.connection.holdings),
    )


if __name__ == "__main__":
    unittest.main()
