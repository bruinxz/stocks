from __future__ import annotations

import copy
import hashlib
import math
import unittest
from contextlib import contextmanager
from dataclasses import replace
from types import SimpleNamespace

from ai.snapshot.fingerprint import (
    canonicalize_output_fingerprint_preimage,
    compute_input_fingerprint,
    compute_output_fingerprint,
    jcs_canonicalize,
)
from ai.snapshot.reader import (
    SnapshotCorruptError,
    SnapshotNotFoundError,
    SnapshotReader,
)
from ai.snapshot.store import SnapshotItemRow, SnapshotRow
from ai.snapshot.writer import (
    SnapshotContractError,
    SnapshotIdempotencyConflictError,
    SnapshotStoreNotConfiguredError,
    SnapshotWriter,
)


SHA_A = "a" * 64
SHA_B = "b" * 64
SNAPSHOT_ID = "12345678-1234-4234-8234-567812345678"
OLDER_SNAPSHOT_ID = "22345678-1234-4234-8234-567812345678"
NEXT_SNAPSHOT_ID = "32345678-1234-4234-8234-567812345678"
RECOMMENDATION_IDS = {
    "AAPL": "42345678-1234-4234-8234-567812345678",
    "MSFT": "52345678-1234-4234-8234-567812345678",
    "TSLA": "62345678-1234-4234-8234-567812345678",
    "NVDA": "72345678-1234-4234-8234-567812345678",
}


class MemorySnapshotStore:
    def __init__(self):
        self.snapshots: dict[str, SnapshotRow] = {}
        self.items: dict[str, list[SnapshotItemRow]] = {}
        self.idempotency: dict[str, str] = {}
        self.fail_items = False

    @contextmanager
    def transaction(self):
        staged_snapshots = dict(self.snapshots)
        staged_items = {key: list(value) for key, value in self.items.items()}
        staged_idempotency = dict(self.idempotency)
        transaction = MemorySnapshotTransaction(
            staged_snapshots,
            staged_items,
            staged_idempotency,
            fail_items=self.fail_items,
        )
        try:
            yield transaction
        except Exception:
            raise
        else:
            self.snapshots = staged_snapshots
            self.items = staged_items
            self.idempotency = staged_idempotency

    def get_snapshot(self, snapshot_id):
        return self.snapshots.get(snapshot_id)

    def get_items(self, snapshot_id):
        return tuple(self.items.get(snapshot_id, ()))

    def list_snapshots(self, *, profile, market_scope, trading_day=None):
        rows = [
            row
            for row in self.snapshots.values()
            if row.profile == profile and row.market_scope == market_scope
        ]
        if trading_day is not None:
            rows = [row for row in rows if row.trading_day == trading_day]
        return tuple(rows)


class MemorySnapshotTransaction:
    def __init__(
        self, snapshots, items, idempotency, *, fail_items=False
    ):
        self.snapshots = snapshots
        self.items = items
        self.idempotency = idempotency
        self.fail_items = fail_items

    def find_snapshot_by_idempotency_key(self, key):
        snapshot_id = self.idempotency.get(key)
        return self.snapshots.get(snapshot_id) if snapshot_id else None

    def get_items(self, snapshot_id):
        return tuple(self.items.get(snapshot_id, ()))

    def insert_snapshot(self, snapshot):
        if snapshot.snapshot_id in self.snapshots:
            raise RuntimeError("duplicate snapshot")
        if snapshot.idempotency_key in self.idempotency:
            raise RuntimeError("duplicate idempotency key")
        self.snapshots[snapshot.snapshot_id] = snapshot
        self.idempotency[snapshot.idempotency_key] = snapshot.snapshot_id
        self.items[snapshot.snapshot_id] = []

    def insert_items(self, items):
        if self.fail_items:
            raise RuntimeError("injected item write failure")
        for item in items:
            self.items[item.snapshot_id].append(item)


def _context(
    *,
    snapshot_id=SNAPSHOT_ID,
    profile="us_preferred",
    market_scope="us",
    trading_day="2026-07-12",
):
    full_text = "Research only. No investment promise."
    disclaimer_hash = hashlib.sha256(full_text.encode()).hexdigest()
    config = SimpleNamespace(
        trading_day=trading_day,
        profile=profile,
        market_scope=market_scope,
        pipeline_version="3.1.0",
        model_version="3.1.0",
        strategy_version="3.1.0",
        rule_bundle_hash=SHA_A,
        template_hash=SHA_B,
        disclaimer_hash=disclaimer_hash,
    )
    return SimpleNamespace(
        snapshot_id=snapshot_id,
        as_of="2026-07-12T01:02:03Z",
        config=config,
        input_hashes=["b" * 64, "a" * 64],
    )


def _recommendation(ctx, ticker="AAPL", conviction=88.0):
    return {
        "id": RECOMMENDATION_IDS[ticker],
        "snapshot_id": ctx.snapshot_id,
        "ticker": ticker,
        "as_of": ctx.as_of,
        "score": {
            "profile": ctx.config.profile,
            "market_scope": ctx.config.market_scope,
            "rating": "A",
        },
        "conviction": {"final": conviction},
        "risk_gate": {"gate": "GREEN", "ok_to_enter": True},
        "entry_plan": {
            "size_hint": {
                "tier": "TIER_3",
                "pct": 3.0,
                "disclaimer_key": "size_hint_advisory",
            }
        },
        "disclaimer_version": "3.1.0",
    }


def _recommendation_list(ctx, tickers=("AAPL", "MSFT")):
    full_text = "Research only. No investment promise."
    disclaimer_hash = hashlib.sha256(full_text.encode()).hexdigest()
    items = [
        {
            "recommendation": _recommendation(
                ctx, ticker, conviction=88.0 - index
            ),
            "rating_band": "A",
        }
        for index, ticker in enumerate(tickers)
    ]
    result = {
        "snapshot_id": ctx.snapshot_id,
        "as_of": ctx.as_of,
        "profile": ctx.config.profile,
        "market_scope": ctx.config.market_scope,
        "items": items,
        "disclaimer": {
            "version": "3.1.0",
            "short_text": "Research only.",
            "full_text": full_text,
            "language": "en-US",
            "effective_at": "2026-07-01T00:00:00Z",
            "hash": disclaimer_hash,
        },
        "meta": {
            "contract_version": "0.3.1",
            "profile_version": "3.1.0",
            "input_fingerprint": compute_input_fingerprint(ctx.input_hashes),
            "strategy_version": ctx.config.strategy_version,
            "pipeline_version": ctx.config.pipeline_version,
            "generated_by": "ai-gamma@test",
            "generation_ms": 123,
        },
    }
    result["output_fingerprint"] = compute_output_fingerprint(result)
    return result


class SnapshotWriterTests(unittest.TestCase):
    def test_store_is_required(self):
        with self.assertRaises(SnapshotStoreNotConfiguredError):
            SnapshotWriter().write(_context(), _recommendation_list(_context()))

    def test_atomic_write_and_exact_idempotent_retry(self):
        ctx = _context()
        payload = _recommendation_list(ctx)
        store = MemorySnapshotStore()
        writer = SnapshotWriter(store)

        first = writer.write(ctx, payload)
        second = writer.write(ctx, copy.deepcopy(payload))

        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual(second.snapshot_id, first.snapshot_id)
        self.assertEqual(len(store.snapshots), 1)
        self.assertEqual(len(store.items[ctx.snapshot_id]), 2)

    def test_idempotent_retry_ignores_only_generation_telemetry(self):
        ctx = _context()
        payload = _recommendation_list(ctx)
        store = MemorySnapshotStore()
        writer = SnapshotWriter(store)
        writer.write(ctx, payload)

        retry = copy.deepcopy(payload)
        retry["meta"]["generation_ms"] = 999
        retry["meta"]["generated_by"] = "retry-worker"
        result = writer.write(ctx, retry)

        self.assertFalse(result.created)
        self.assertEqual(len(store.snapshots), 1)

    def test_item_failure_rolls_back_snapshot_and_items(self):
        ctx = _context()
        store = MemorySnapshotStore()
        store.fail_items = True

        with self.assertRaisesRegex(RuntimeError, "injected item"):
            SnapshotWriter(store).write(ctx, _recommendation_list(ctx))

        self.assertEqual(store.snapshots, {})
        self.assertEqual(store.items, {})
        self.assertEqual(store.idempotency, {})

    def test_idempotency_key_conflict_fails_closed(self):
        ctx = _context()
        payload = _recommendation_list(ctx)
        store = MemorySnapshotStore()
        writer = SnapshotWriter(store)
        writer.write(ctx, payload)

        existing = next(iter(store.snapshots.values()))
        store.snapshots[ctx.snapshot_id] = SnapshotRow(
            **{
                **existing.__dict__,
                "output_fingerprint": "f" * 64,
            }
        )

        with self.assertRaises(SnapshotIdempotencyConflictError):
            writer.write(ctx, payload)

    def test_retry_rejects_every_persisted_scalar_corruption(self):
        ctx = _context()
        payload = _recommendation_list(ctx)
        mutations = {
            "snapshot_id": "82345678-1234-4234-8234-567812345678",
            "as_of_utc": "1999-01-01T00:00:00Z",
            "trading_day": "1999-01-01",
            "profile": "multibagger",
            "market_scope": "cn_a",
            "contract_version": "0.3.0",
            "profile_version": "current",
            "pipeline_version": "01.0.0",
            "model_version": "corrupt",
            "strategy_version": "١.0.0",
            "rule_bundle_hash": "1" * 64,
            "template_hash": "2" * 64,
            "disclaimer_hash": "3" * 64,
            "input_fingerprint": "4" * 64,
            "output_fingerprint": "5" * 64,
            "fingerprint_preimage_jcs": "{}",
            "idempotency_key": "6" * 64,
            "item_count": 99,
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                store = MemorySnapshotStore()
                writer = SnapshotWriter(store)
                writer.write(ctx, payload)
                row = store.snapshots[ctx.snapshot_id]
                corrupted = replace(row, **{field: value})
                store.snapshots.pop(ctx.snapshot_id)
                store.snapshots[corrupted.snapshot_id] = corrupted
                store.idempotency[row.idempotency_key] = corrupted.snapshot_id
                if corrupted.snapshot_id != ctx.snapshot_id:
                    store.items[corrupted.snapshot_id] = store.items.pop(
                        ctx.snapshot_id
                    )
                with self.assertRaises(SnapshotIdempotencyConflictError):
                    writer.write(ctx, payload)

    def test_retry_rejects_envelope_identity_and_output_mirror_corruption(self):
        ctx = _context()
        payload = _recommendation_list(ctx)
        mutations = {
            "output_fingerprint": "f" * 64,
            "snapshot_id": "82345678-1234-4234-8234-567812345678",
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                store = MemorySnapshotStore()
                writer = SnapshotWriter(store)
                writer.write(ctx, payload)
                row = store.snapshots[ctx.snapshot_id]
                envelope = copy.deepcopy(row.envelope_json)
                envelope[field] = value
                if field == "snapshot_id":
                    for entry in envelope["items"]:
                        entry["recommendation"]["snapshot_id"] = value
                        entry["recommendation"]["id"] = (
                            "82345678-1234-4234-8234-567812345678"
                        )
                store.snapshots[ctx.snapshot_id] = replace(
                    row, envelope_json=envelope
                )
                with self.assertRaises(SnapshotIdempotencyConflictError):
                    writer.write(ctx, payload)

    def test_missing_pins_and_invalid_profile_scope_fail_before_transaction(self):
        invalid_cases = []

        missing_meta = _recommendation_list(_context())
        missing_meta["meta"].pop("profile_version")
        invalid_cases.append(missing_meta)

        custom_ctx = _context(profile="custom")
        invalid_cases.append(_recommendation_list(custom_ctx))

        mismatch = _recommendation_list(_context())
        mismatch["market_scope"] = "jp"
        invalid_cases.append(mismatch)

        bad_fingerprint = _recommendation_list(_context())
        bad_fingerprint["output_fingerprint"] = "0" * 64
        invalid_cases.append(bad_fingerprint)

        bad_disclaimer = _recommendation_list(_context())
        bad_disclaimer["disclaimer"]["full_text"] += " mutated"
        invalid_cases.append(bad_disclaimer)

        disclaimer_version_mismatch = _recommendation_list(_context())
        disclaimer_version_mismatch["items"][0]["recommendation"][
            "disclaimer_version"
        ] = "0.0.0"
        disclaimer_version_mismatch["output_fingerprint"] = (
            compute_output_fingerprint(disclaimer_version_mismatch)
        )
        invalid_cases.append(disclaimer_version_mismatch)

        boolean_generation_ms = _recommendation_list(_context())
        boolean_generation_ms["meta"]["generation_ms"] = True
        invalid_cases.append(boolean_generation_ms)

        non_finite = _recommendation_list(_context())
        non_finite["items"][0]["recommendation"]["conviction"]["final"] = math.nan
        invalid_cases.append(non_finite)

        boolean_size = _recommendation_list(_context())
        boolean_size["items"][0]["recommendation"]["entry_plan"]["size_hint"][
            "pct"
        ] = True
        invalid_cases.append(boolean_size)

        for payload in invalid_cases:
            with self.subTest(payload=payload):
                store = MemorySnapshotStore()
                with self.assertRaises(SnapshotContractError):
                    SnapshotWriter(store).write(_context(), payload)
                self.assertEqual(store.snapshots, {})


class SnapshotReaderTests(unittest.TestCase):
    def setUp(self):
        self.ctx = _context()
        self.store = MemorySnapshotStore()
        self.payload = _recommendation_list(self.ctx)
        SnapshotWriter(self.store).write(self.ctx, self.payload)
        self.reader = SnapshotReader(self.store)

    def test_read_hydrates_full_envelope_and_canonical_items(self):
        hydrated = self.reader.read_snapshot(self.ctx.snapshot_id)

        self.assertEqual(hydrated, self.payload)
        self.assertEqual(
            jcs_canonicalize(hydrated["items"][0]["recommendation"]),
            self.store.items[self.ctx.snapshot_id][0].recommendation_jcs,
        )

    def test_latest_and_by_date_are_deterministic(self):
        older_ctx = _context(snapshot_id=OLDER_SNAPSHOT_ID)
        older_ctx.as_of = "2026-07-12T00:00:00Z"
        older_payload = _recommendation_list(older_ctx, tickers=("TSLA",))
        SnapshotWriter(self.store).write(older_ctx, older_payload)

        latest = self.reader.read_latest("us_preferred", "us")
        history = self.reader.read_by_date(
            "2026-07-12", "us_preferred", "us"
        )

        self.assertEqual(latest["snapshot_id"], self.ctx.snapshot_id)
        self.assertEqual(
            [snapshot["snapshot_id"] for snapshot in history],
            [self.ctx.snapshot_id, OLDER_SNAPSHOT_ID],
        )

    def test_diff_is_sorted_and_reports_changed_tickers(self):
        next_ctx = _context(snapshot_id=NEXT_SNAPSHOT_ID)
        next_ctx.as_of = "2026-07-12T02:00:00Z"
        next_payload = _recommendation_list(
            next_ctx, tickers=("AAPL", "NVDA")
        )
        next_payload["items"][0]["recommendation"]["conviction"]["final"] = 70.0
        next_payload["output_fingerprint"] = compute_output_fingerprint(next_payload)
        SnapshotWriter(self.store).write(next_ctx, next_payload)

        diff = self.reader.diff(self.ctx.snapshot_id, next_ctx.snapshot_id)

        self.assertEqual(diff["added"], ["NVDA"])
        self.assertEqual(diff["removed"], ["MSFT"])
        self.assertEqual(diff["common"], ["AAPL"])
        self.assertEqual(diff["changed"], ["AAPL"])
        self.assertFalse(diff["fingerprint_match"])

    def test_missing_and_corrupt_snapshots_fail_closed(self):
        with self.assertRaises(SnapshotNotFoundError):
            self.reader.read_snapshot("missing")

        row = self.store.snapshots[self.ctx.snapshot_id]
        self.store.snapshots[self.ctx.snapshot_id] = SnapshotRow(
            **{**row.__dict__, "item_count": 99}
        )
        with self.assertRaisesRegex(
            SnapshotCorruptError, "item.count|item_count"
        ):
            self.reader.read_snapshot(self.ctx.snapshot_id)

    def test_reader_rejects_every_persisted_scalar_corruption(self):
        mutations = {
            "as_of_utc": "1999-01-01T00:00:00Z",
            "trading_day": "1999-01-01",
            "profile": "multibagger",
            "market_scope": "cn_a",
            "contract_version": "0.3.0",
            "profile_version": "current",
            "pipeline_version": "01.0.0",
            "model_version": "corrupt",
            "strategy_version": "١.0.0",
            "rule_bundle_hash": "1" * 64,
            "template_hash": "2" * 64,
            "disclaimer_hash": "3" * 64,
            "input_fingerprint": "4" * 64,
            "output_fingerprint": "5" * 64,
            "fingerprint_preimage_jcs": "{}",
            "idempotency_key": "6" * 64,
            "item_count": 99,
        }
        original = self.store.snapshots[self.ctx.snapshot_id]
        for field, value in mutations.items():
            with self.subTest(field=field):
                self.store.snapshots[self.ctx.snapshot_id] = replace(
                    original, **{field: value}
                )
                with self.assertRaises(SnapshotCorruptError):
                    self.reader.read_snapshot(self.ctx.snapshot_id)
                self.store.snapshots[self.ctx.snapshot_id] = original

    def test_reader_rejects_envelope_mirror_corruption(self):
        original = self.store.snapshots[self.ctx.snapshot_id]
        mutations = {
            "output_fingerprint": "f" * 64,
            "snapshot_id": "82345678-1234-4234-8234-567812345678",
            "as_of": "1999-01-01T00:00:00Z",
            "profile": "multibagger",
            "market_scope": "cn_a",
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                envelope = copy.deepcopy(original.envelope_json)
                envelope[field] = value
                self.store.snapshots[self.ctx.snapshot_id] = replace(
                    original, envelope_json=envelope
                )
                with self.assertRaises(SnapshotCorruptError):
                    self.reader.read_snapshot(self.ctx.snapshot_id)
                self.store.snapshots[self.ctx.snapshot_id] = original

    def test_recomputed_item_fingerprint_detects_projection_consistent_tamper(self):
        item = self.store.items[self.ctx.snapshot_id][0]
        recommendation = copy.deepcopy(
            self.payload["items"][0]["recommendation"]
        )
        recommendation["explanation"] = {"headline": "tampered"}
        self.store.items[self.ctx.snapshot_id][0] = SnapshotItemRow(
            **{
                **item.__dict__,
                "recommendation_json": recommendation,
                "recommendation_jcs": jcs_canonicalize(recommendation),
                "recommendation_hash": hashlib.sha256(
                    jcs_canonicalize(recommendation).encode("utf-8")
                ).hexdigest(),
            }
        )

        with self.assertRaisesRegex(
            SnapshotCorruptError, "envelope/item row|item fingerprint"
        ):
            self.reader.read_snapshot(self.ctx.snapshot_id)

    def test_invalid_read_profile_scope_fails_closed(self):
        with self.assertRaisesRegex(Exception, "incompatible"):
            self.reader.read_latest("japan_blue_chip", "us")


if __name__ == "__main__":
    unittest.main()
