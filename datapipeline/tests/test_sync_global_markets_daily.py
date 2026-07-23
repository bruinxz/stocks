from datetime import date, datetime, timezone
from decimal import Decimal
import json
import unittest
from unittest.mock import patch

from datapipeline.collectors.jpkr_deep.fx_rate_fetcher import (
    FxSourceRow,
    normalize_fx_rows,
)
from scripts.ops.sync_global_markets_daily import _capture_bok_fx, _rebase_pending_fx


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

    def test_bok_capture_returns_versioned_usdkrw_rows_without_key_leakage(self) -> None:
        raw = json.dumps(
            {
                "StatisticSearch": {
                    "row": [
                        {"TIME": "20260722", "DATA_VALUE": "1,381.20"},
                        {"TIME": "20260723", "DATA_VALUE": "1,379.50"},
                    ]
                }
            }
        ).encode("utf-8")

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self) -> bytes:
                return raw

        requests = []

        def open_request(request, timeout):
            requests.append((request, timeout))
            return Response()

        with patch("scripts.ops.sync_global_markets_daily.urlopen", open_request):
            rows = _capture_bok_fx(
                {"BOK_ECOS_API_KEY": "private/key"},
                start_day=date(2026, 7, 10),
                end_day=date(2026, 7, 24),
                available_at_utc=AS_OF,
            )

        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1].pair, "USDKRW")
        self.assertEqual(rows[-1].source_kind, "BOK")
        self.assertEqual(rows[-1].observation_day, date(2026, 7, 23))
        self.assertEqual(rows[-1].local_per_usd, Decimal("1379.50"))
        self.assertIn("private%2Fkey", requests[0][0].full_url)
        self.assertEqual(requests[0][1], 20)
        self.assertNotIn("private", rows[-1].source_document_id)
        self.assertNotIn("private", rows[-1].source_version)
        self.assertRegex(rows[-1].source_version, r"^bok-ecos-731Y001-0000001@1\.0\.0:[0-9a-f]{64}$")

    def test_bok_capture_fails_closed_with_stable_error(self) -> None:
        with patch(
            "scripts.ops.sync_global_markets_daily.urlopen",
            side_effect=OSError("secret upstream detail"),
        ):
            with self.assertRaisesRegex(RuntimeError, "^BOK_SOURCE_READ_FAILED$"):
                _capture_bok_fx(
                    {},
                    start_day=date(2026, 7, 10),
                    end_day=date(2026, 7, 24),
                    available_at_utc=AS_OF,
                )


if __name__ == "__main__":
    unittest.main()
