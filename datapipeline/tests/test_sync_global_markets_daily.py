from datetime import date, datetime, timezone
from decimal import Decimal
import unittest

from datapipeline.collectors.jpkr_deep.fx_rate_fetcher import (
    FxSourceRow,
    normalize_fx_rows,
)
from scripts.ops.sync_global_markets_daily import _rebase_pending_fx


AS_OF = datetime(2026, 7, 17, 6, tzinfo=timezone.utc)


def source(day: int, version: str, rate: str, captured_at: datetime) -> FxSourceRow:
    return FxSourceRow(
        pair="USDJPY",
        observation_day=date(2026, 7, day),
        available_at_utc=captured_at,
        local_per_usd=Decimal(rate),
        source_kind="BOJ",
        source_document_id=f"BOJ:USDJPY:{version}",
        source_version=version,
    )


class GlobalMarketFxLineageTest(unittest.TestCase):
    def test_rebases_overlapping_capture_to_persisted_predecessor(self) -> None:
        stored = normalize_fx_rows(
            (
                source(
                    14,
                    "capture-v1",
                    "158.10",
                    datetime(2026, 7, 15, tzinfo=timezone.utc),
                ),
            ),
            as_of_utc=AS_OF,
        )[0]
        captured = normalize_fx_rows(
            (
                source(
                    14,
                    "capture-v2",
                    "158.10",
                    datetime(2026, 7, 17, tzinfo=timezone.utc),
                ),
                source(
                    15,
                    "capture-v2",
                    "158.30",
                    datetime(2026, 7, 17, tzinfo=timezone.utc),
                ),
                source(
                    16,
                    "capture-v2",
                    "158.20",
                    datetime(2026, 7, 17, tzinfo=timezone.utc),
                ),
            ),
            as_of_utc=AS_OF,
        )

        pending = _rebase_pending_fx(
            captured,
            {"USDJPY": stored},
            as_of_utc=AS_OF,
        )

        self.assertEqual([item.observation_day.day for item in pending], [15, 16])
        self.assertEqual(pending[0].previous_observation_day, stored.observation_day)
        self.assertEqual(pending[0].previous_source_version, stored.source_version)
        self.assertEqual(pending[0].previous_fact_hash, stored.fact_hash)
        self.assertNotEqual(pending[0].previous_fact_hash, captured[0].fact_hash)
        self.assertEqual(pending[1].previous_fact_hash, pending[0].fact_hash)


if __name__ == "__main__":
    unittest.main()
