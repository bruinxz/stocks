import copy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest
from uuid import NAMESPACE_URL, uuid5

from datapipeline.storage.backtest_pit import (
    PitHoldingFact,
    PitIdempotencyConflict,
    PitSnapshotFact,
    PitSnapshotWriter,
    canonical_holding_hash,
    canonical_snapshot_hash,
)

AS_OF = datetime(2026, 7, 10, 7, tzinfo=timezone.utc)


def uuid_for(value: str) -> str:
    # UUIDv5 is deterministic, but the physical contract requires UUIDv4.
    # Force the version bits while retaining deterministic fixture bytes.
    raw = bytearray(uuid5(NAMESPACE_URL, value).bytes)
    raw[6] = (raw[6] & 0x0F) | 0x40
    raw[8] = (raw[8] & 0x3F) | 0x80
    from uuid import UUID

    return str(UUID(bytes=bytes(raw)))


def metrics(index: int = 0, count: int = 27) -> dict:
    net_value = 1.0 + index / 100
    return {
        "net_value": net_value,
        "drawdown": -index / 1000,
        "cumulative_return": net_value - 1.0,
        "sharpe_ratio_6m": None if index == 0 else 1.25,
        "win_rate_6m": None if index == 0 else 0.5,
        "metric_contract_version": "1.0.0",
        "window_start": "2026-01-10",
        "window_end": "2026-07-10",
        "evaluated_session_count": 128,
        "checkpoint_index": index,
        "checkpoint_count": count,
        "initial_nav": 1.0,
        "commission_bps_per_side": 5,
        "slippage_bps_per_side": 5,
        "annualization_sessions": 252,
    }


def holding(
    index: int,
    *,
    scope: str = "cn_a",
    as_of: datetime = AS_OF,
    delisted: bool = False,
) -> PitHoldingFact:
    item = PitHoldingFact(
        holding_id=uuid_for(f"holding:{scope}:{as_of.isoformat()}:{index}"),
        position_order=index,
        market_scope=scope,
        ticker=("600000.SH", "000001.SZ", "300750.SZ")[index],
        weight=Decimal("0.3333333333") if index < 2 else Decimal("0.3333333334"),
        return_since_entry=Decimal("0.0100000000"),
        is_stale=index == 1,
        is_delisted_at_as_of=delisted,
        source_kind="synthetic-price",
        source_document_id=f"price:{scope}:{index}:{as_of.date()}",
        source_version="fixture-v1",
        available_at_utc=as_of,
        lineage={
            "fixture_hash": "a" * 64,
            "is_delisted_at_as_of": delisted,
        },
        fact_hash="0" * 64,
    )
    object.__setattr__(item, "fact_hash", canonical_holding_hash(item))
    return item


def snapshot(
    *,
    strategy: str = "us_preferred",
    scope: str = "cn_a",
    as_of: datetime = AS_OF,
    metric_values: dict = None,
    holding_values: tuple = None,
) -> tuple:
    holdings = holding_values or tuple(
        holding(i, scope=scope, as_of=as_of) for i in range(3)
    )
    item = PitSnapshotFact(
        snapshot_id=uuid_for(f"snapshot:{strategy}:{scope}:{as_of.isoformat()}"),
        strategy=strategy,
        market_scope=scope,
        as_of_utc=as_of,
        snapshot_day=as_of.date(),
        published_at_utc=as_of + timedelta(seconds=1),
        is_survivorship_biased=False,
        is_delisted_at_as_of=any(value.is_delisted_at_as_of for value in holdings),
        source_versions={"calendar": "fixture-v1", "prices": "fixture-v1"},
        lineage_closure={
            "survivorship_evidence": {"retained_delisted": True},
            "fixture_hash": "b" * 64,
        },
        metrics=metric_values or metrics(),
        fact_hash="0" * 64,
    )
    object.__setattr__(item, "fact_hash", canonical_snapshot_hash(item, holdings))
    return item, holdings


class FakeTransaction:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection
        self.snapshot = None
        self.holdings = None

    async def __aenter__(self) -> None:
        self.snapshot = copy.deepcopy(self.connection.snapshots)
        self.holdings = copy.deepcopy(self.connection.holdings)

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        if exc_type is not None:
            self.connection.snapshots = self.snapshot
            self.connection.holdings = self.holdings


class FakeAcquire:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection

    async def __aenter__(self) -> "FakeConnection":
        return self.connection

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None


class FakeConnection:
    def __init__(self, fail_holding: int = None) -> None:
        self.snapshots = {}
        self.holdings = {}
        self.fail_holding = fail_holding

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    async def fetchval(self, sql: str, *args: object):
        return None

    async def fetchrow(self, sql: str, *args: object):
        if "SELECT" in sql:
            if len(args) == 3:
                return self.snapshots.get(tuple(args))
            return None
        if "backtest_pit_snapshot" in sql:
            key = (args[1], args[2], args[3])
            self.snapshots[key] = {
                "snapshot_id": args[0],
                "strategy": args[1],
                "market_scope": args[2],
                "as_of_utc": args[3],
                "snapshot_day": args[4],
                "published_at_utc": args[5],
                "is_survivorship_biased": args[6],
                "is_delisted_at_as_of": args[7],
                "source_versions": copy.deepcopy(__import__("json").loads(args[8])),
                "lineage_closure": copy.deepcopy(__import__("json").loads(args[9])),
                "metrics": copy.deepcopy(__import__("json").loads(args[10])),
                "fact_hash": args[11],
            }
            return {"snapshot_id": args[0]}
        if self.fail_holding is not None and args[3] == self.fail_holding:
            raise RuntimeError("injected holding failure")
        self.holdings.setdefault(args[1], []).append(
            {
                "backtest_pit_holding_id": args[0],
                "snapshot_id": args[1],
                "snapshot_as_of_utc": args[2],
                "position_order": args[3],
                "market_scope": args[4],
                "ticker": args[5],
                "weight": args[6],
                "return_since_entry": args[7],
                "is_stale": args[8],
                "source_kind": args[9],
                "source_document_id": args[10],
                "source_version": args[11],
                "available_at_utc": args[12],
                "lineage": __import__("json").loads(args[13]),
                "fact_hash": args[14],
            }
        )
        return {"backtest_pit_holding_id": args[0]}

    async def fetch(self, sql: str, *args: object):
        return copy.deepcopy(self.holdings.get(args[0], []))


class FakePool:
    def __init__(self, fail_holding: int = None) -> None:
        self.connection = FakeConnection(fail_holding)

    def acquire(self) -> FakeAcquire:
        return FakeAcquire(self.connection)


class PitWriterTest(unittest.IsolatedAsyncioTestCase):
    async def test_rolling_production_profile_accepts_dynamic_window(self) -> None:
        metric_values = metrics()
        metric_values["window_start"] = "2026-01-14"
        metric_values["window_end"] = "2026-07-16"
        item, holdings = snapshot(metric_values=metric_values)
        item = copy.copy(item)
        object.__setattr__(
            item,
            "source_versions",
            {"calendar": "production-daily-bars-calendar@2026-07-16", "prices": "v1"},
        )
        object.__setattr__(item, "fact_hash", canonical_snapshot_hash(item, holdings))
        writer = PitSnapshotWriter(
            FakePool(), validation_profile="rolling_production"
        )

        manifest = await writer.write_or_verify(item, holdings)

        self.assertTrue(manifest.inserted)

    async def test_frozen_profile_still_rejects_dynamic_window(self) -> None:
        metric_values = metrics()
        metric_values["window_end"] = "2026-07-16"
        item, holdings = snapshot(metric_values=metric_values)
        with self.assertRaisesRegex(ValueError, "window_end must equal frozen replay pin"):
            PitSnapshotWriter(FakePool()).validate(item, holdings)

    async def test_insert_replay_and_readback(self) -> None:
        pool = FakePool()
        writer = PitSnapshotWriter(pool)
        header, children = snapshot()
        inserted = await writer.write_or_verify(header, children)
        replay = await writer.write_or_verify(header, children)
        readback = await writer.readback(
            strategy=header.strategy,
            market_scope=header.market_scope,
            as_of_utc=header.as_of_utc,
        )
        self.assertTrue(inserted.inserted)
        self.assertFalse(replay.inserted)
        self.assertEqual(inserted.snapshot_id, replay.snapshot_id)
        self.assertEqual(readback, replay)
        self.assertEqual(len(pool.connection.snapshots), 1)
        self.assertEqual(len(pool.connection.holdings[header.snapshot_id]), 3)

    async def test_changed_header_or_child_conflicts(self) -> None:
        pool = FakePool()
        writer = PitSnapshotWriter(pool)
        header, children = snapshot()
        await writer.write_or_verify(header, children)

        changed_header, _ = snapshot(metric_values=metrics(index=1))
        with self.assertRaisesRegex(PitIdempotencyConflict, "header differs"):
            await writer.write_or_verify(changed_header, children)

        changed_children = list(children)
        changed_children[0] = copy.copy(changed_children[0])
        object.__setattr__(changed_children[0], "is_stale", True)
        object.__setattr__(
            changed_children[0],
            "fact_hash",
            canonical_holding_hash(changed_children[0]),
        )
        changed_snapshot, _ = snapshot(holding_values=tuple(changed_children))
        with self.assertRaisesRegex(PitIdempotencyConflict, "header differs"):
            await writer.write_or_verify(changed_snapshot, tuple(changed_children))

    async def test_stored_delisted_lineage_tamper_conflicts(self) -> None:
        pool = FakePool()
        writer = PitSnapshotWriter(pool)
        header, children = snapshot()
        await writer.write_or_verify(header, children)
        pool.connection.holdings[header.snapshot_id][0]["lineage"][
            "is_delisted_at_as_of"
        ] = True
        with self.assertRaisesRegex(PitIdempotencyConflict, "holding differs"):
            await writer.write_or_verify(header, children)

    async def test_injected_child_failure_rolls_back_header_and_children(self) -> None:
        pool = FakePool(fail_holding=1)
        header, children = snapshot()
        with self.assertRaisesRegex(RuntimeError, "injected holding"):
            await PitSnapshotWriter(pool).write_or_verify(header, children)
        self.assertEqual(pool.connection.snapshots, {})
        self.assertEqual(pool.connection.holdings, {})

    async def test_validation_matrix(self) -> None:
        header, children = snapshot()
        cases = []
        cases.append(("scope", copy.copy(header), children, "incompatible"))
        object.__setattr__(cases[-1][1], "market_scope", "jp")
        cases.append(("lookahead", header, list(children), "availability"))
        cases[-1][2][0] = copy.copy(cases[-1][2][0])
        object.__setattr__(
            cases[-1][2][0],
            "available_at_utc",
            header.as_of_utc + timedelta(seconds=1),
        )
        cases.append(("weight", header, list(children), "sum to one"))
        cases[-1][2][0] = copy.copy(cases[-1][2][0])
        object.__setattr__(cases[-1][2][0], "weight", Decimal("0.5"))
        object.__setattr__(
            cases[-1][2][0],
            "fact_hash",
            canonical_holding_hash(cases[-1][2][0]),
        )
        cases.append(("duplicate", header, list(children), "tickers"))
        cases[-1][2][1] = copy.copy(cases[-1][2][1])
        object.__setattr__(cases[-1][2][1], "ticker", children[0].ticker)
        cases.append(("order", header, list(children), "position_order"))
        cases[-1][2][1] = copy.copy(cases[-1][2][1])
        object.__setattr__(cases[-1][2][1], "position_order", 3)
        cases.append(("aggregate", header, list(children), "aggregate ticker"))
        cases[-1][2][0] = copy.copy(cases[-1][2][0])
        object.__setattr__(
            cases[-1][2][0], "ticker", "__AGGREGATE__:french:small-value"
        )
        cases.append(("delisted", header, list(children), "delisted flag"))
        cases[-1][2][0] = copy.copy(cases[-1][2][0])
        object.__setattr__(cases[-1][2][0], "is_delisted_at_as_of", True)
        object.__setattr__(
            cases[-1][2][0],
            "lineage",
            {**cases[-1][2][0].lineage, "is_delisted_at_as_of": True},
        )
        object.__setattr__(
            cases[-1][2][0],
            "fact_hash",
            canonical_holding_hash(cases[-1][2][0]),
        )
        cases.append(
            ("survivorship", copy.copy(header), children, "survivorship-biased")
        )
        object.__setattr__(cases[-1][1], "is_survivorship_biased", True)
        cases.append(("source", copy.copy(header), children, "source_versions"))
        object.__setattr__(cases[-1][1], "source_versions", {})
        cases.append(("evidence", copy.copy(header), children, "survivorship evidence"))
        object.__setattr__(cases[-1][1], "lineage_closure", {})
        cases.append(("metric", copy.copy(header), children, "metric contract"))
        bad_metrics = dict(header.metrics)
        del bad_metrics["win_rate_6m"]
        object.__setattr__(cases[-1][1], "metrics", bad_metrics)
        for name, bad_header, bad_children, message in cases:
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, message):
                    await PitSnapshotWriter(FakePool()).write_or_verify(
                        bad_header, tuple(bad_children)
                    )

    async def test_strict_semver_matrix(self) -> None:
        header, children = snapshot()
        for value in ("01.0.0", "1.01.0", "1.0.01", "１.0.0", "1.0"):
            with self.subTest(value=value):
                bad_metrics = dict(header.metrics)
                bad_metrics["metric_contract_version"] = value
                bad_header = copy.copy(header)
                object.__setattr__(bad_header, "metrics", bad_metrics)
                with self.assertRaisesRegex(ValueError, "strict SemVer"):
                    await PitSnapshotWriter(FakePool()).write_or_verify(
                        bad_header, children
                    )
        for value in ("1.0.0", "1.0.0-alpha.1", "1.0.0+build.2"):
            with self.subTest(value=value):
                good_metrics = dict(header.metrics)
                good_metrics["metric_contract_version"] = value
                good_header = copy.copy(header)
                object.__setattr__(good_header, "metrics", good_metrics)
                object.__setattr__(
                    good_header,
                    "fact_hash",
                    canonical_snapshot_hash(good_header, children),
                )
                result = await PitSnapshotWriter(FakePool()).write_or_verify(
                    good_header, children
                )
                self.assertTrue(result.inserted)

    async def test_frozen_metric_pin_matrix(self) -> None:
        header, children = snapshot()
        mutations = {
            "window_start": "2026-01-11",
            "window_end": "2026-07-09",
            "evaluated_session_count": 129,
            "checkpoint_index": 27,
            "checkpoint_count": 26,
            "initial_nav": 2.0,
            "commission_bps_per_side": 6,
            "slippage_bps_per_side": 6,
            "annualization_sessions": 365,
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                bad_metrics = dict(header.metrics)
                bad_metrics[field] = value
                bad_header = copy.copy(header)
                object.__setattr__(bad_header, "metrics", bad_metrics)
                with self.assertRaisesRegex(ValueError, field):
                    await PitSnapshotWriter(FakePool()).write_or_verify(
                        bad_header, children
                    )


if __name__ == "__main__":
    unittest.main()
