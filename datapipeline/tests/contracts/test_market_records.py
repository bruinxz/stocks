from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest

from datapipeline.contracts.market_records import FxObservation, MultibaggerSourceRecord


class MultibaggerSourceRecordTest(unittest.TestCase):
    def make_record(self, **overrides: object) -> MultibaggerSourceRecord:
        now = datetime(2026, 7, 10, tzinfo=timezone.utc)
        values: dict[str, object] = {
            "market": "CN",
            "market_scope": "cn_a",
            "exchange": "sh",
            "ticker": "600000",
            "record_kind": "DAILY",
            "source_kind": "baostock_cn",
            "source_document_id": "600000:2026-07-10",
            "source_version": "v1",
            "effective_at_utc": now,
            "available_at_utc": now,
            "as_of_utc": now,
            "features": {},
            "evidence_refs": (),
            "fact_hash": "a" * 64,
        }
        values.update(overrides)
        return MultibaggerSourceRecord(**values)  # type: ignore[arg-type]

    def test_frozen_identity_is_constructible(self) -> None:
        record = self.make_record(record_kind="LIFECYCLE")
        self.assertEqual(record.record_kind, "LIFECYCLE")
        self.assertEqual(record.source_document_id, "600000:2026-07-10")

    def test_market_scope_mismatch_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "canonical mapping"):
            self.make_record(market_scope="us")

    def test_future_availability_fails_closed(self) -> None:
        now = datetime(2026, 7, 10, tzinfo=timezone.utc)
        with self.assertRaisesRegex(ValueError, "must not exceed"):
            self.make_record(available_at_utc=now + timedelta(seconds=1), as_of_utc=now)

    def test_invalid_hash_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.make_record(fact_hash="A" * 64)


class FxObservationTest(unittest.TestCase):
    def make_observation(self, **overrides: object) -> FxObservation:
        values: dict[str, object] = {
            "pair": "USDJPY",
            "observation_day": date(2026, 7, 10),
            "available_at_utc": datetime(2026, 7, 10, tzinfo=timezone.utc),
            "local_per_usd": Decimal("100"),
            "usd_per_local": Decimal("0.01"),
            "change_pct": None,
            "source_kind": "BOJ",
            "source_document_id": "boj:2026-07-10",
            "source_version": "v1",
            "fact_hash": "a" * 64,
        }
        values.update(overrides)
        return FxObservation(**values)  # type: ignore[arg-type]

    def test_observation_day_is_the_economic_day(self) -> None:
        observation = self.make_observation()
        self.assertEqual(observation.observation_day, date(2026, 7, 10))
        self.assertFalse(hasattr(observation, "effective_at_utc"))

    def test_pair_provider_mismatch_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "provider mapping"):
            self.make_observation(source_kind="BOK")

    def test_change_requires_complete_previous_lineage(self) -> None:
        with self.assertRaisesRegex(ValueError, "complete earlier"):
            self.make_observation(change_pct=Decimal("1.0"))

    def test_change_lineage_is_constructible(self) -> None:
        observation = self.make_observation(
            change_pct=Decimal("1.0"),
            previous_observation_day=date(2026, 7, 9),
            previous_source_kind="BOJ",
            previous_source_version="v0",
            previous_fact_hash="b" * 64,
        )
        self.assertEqual(observation.previous_observation_day, date(2026, 7, 9))


if __name__ == "__main__":
    unittest.main()
