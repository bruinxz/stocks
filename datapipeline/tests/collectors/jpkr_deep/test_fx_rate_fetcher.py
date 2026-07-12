from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest

from datapipeline.collectors.jpkr_deep.fx_rate_fetcher import (
    FxParseError,
    FxSourceRow,
    canonical_fx_fact_hash,
    normalize_fx_rows,
    parse_boj_csv,
    parse_bok_json,
)

NOW = datetime(2026, 7, 10, 2, tzinfo=timezone.utc)


class FxRateFetcherTest(unittest.TestCase):
    def test_boj_csv_normalizes_chronologically_with_lineage(self) -> None:
        rows = parse_boj_csv(
            "observation_day,local_per_usd\n2026-07-10,151\n2026-07-09,150\n",
            available_at_utc=NOW,
            source_document_id="boj-dataset",
            source_version="boj-v1:column-usdjpy",
        )
        observations = normalize_fx_rows(rows, as_of_utc=NOW)
        self.assertEqual(
            [item.observation_day for item in observations],
            [
                date(2026, 7, 9),
                date(2026, 7, 10),
            ],
        )
        self.assertIsNone(observations[0].change_pct)
        self.assertEqual(observations[1].change_pct, Decimal("0.66666667"))
        self.assertEqual(observations[1].previous_fact_hash, observations[0].fact_hash)

    def test_bok_json_is_storage_ready(self) -> None:
        rows = parse_bok_json(
            {
                "StatisticSearch": {
                    "row": [{"TIME": "20260710", "DATA_VALUE": "1,380.50"}]
                }
            },
            available_at_utc=NOW,
            source_document_id="bok-ecos-dataset",
            source_version="ecos-v1:usdkrw",
        )
        observation = normalize_fx_rows(rows, as_of_utc=NOW)[0]
        self.assertEqual(observation.pair, "USDKRW")
        self.assertEqual(observation.source_kind, "BOK")
        self.assertEqual(observation.local_per_usd, Decimal("1380.5000000000"))

    def test_previous_observation_can_cross_weekend(self) -> None:
        previous = normalize_fx_rows(
            (
                FxSourceRow(
                    pair="USDJPY",
                    observation_day=date(2026, 7, 3),
                    available_at_utc=NOW - timedelta(days=7),
                    local_per_usd=Decimal("150"),
                    source_kind="BOJ",
                    source_document_id="old",
                    source_version="v1",
                ),
            ),
            as_of_utc=NOW,
        )[0]
        current = FxSourceRow(
            pair="USDJPY",
            observation_day=date(2026, 7, 6),
            available_at_utc=NOW,
            local_per_usd=Decimal("151"),
            source_kind="BOJ",
            source_document_id="new",
            source_version="v1",
        )
        normalized = normalize_fx_rows(
            (current,), as_of_utc=NOW, previous_by_pair={"USDJPY": previous}
        )[0]
        self.assertEqual(normalized.previous_observation_day, date(2026, 7, 3))

    def test_same_source_rows_deduplicate_and_conflicts_reject(self) -> None:
        row = FxSourceRow(
            pair="USDJPY",
            observation_day=date(2026, 7, 10),
            available_at_utc=NOW,
            local_per_usd=Decimal("150"),
            source_kind="BOJ",
            source_document_id="doc",
            source_version="v1",
        )
        self.assertEqual(len(normalize_fx_rows((row, row), as_of_utc=NOW)), 1)
        conflicting = FxSourceRow(
            pair=row.pair,
            observation_day=row.observation_day,
            available_at_utc=row.available_at_utc,
            local_per_usd=Decimal("151"),
            source_kind=row.source_kind,
            source_document_id=row.source_document_id,
            source_version=row.source_version,
        )
        with self.assertRaisesRegex(ValueError, "conflicting"):
            normalize_fx_rows((row, conflicting), as_of_utc=NOW)

    def test_future_or_incompatible_previous_rejects(self) -> None:
        future = FxSourceRow(
            pair="USDKRW",
            observation_day=date(2026, 7, 10),
            available_at_utc=NOW + timedelta(seconds=1),
            local_per_usd=Decimal("1380"),
            source_kind="BOK",
            source_document_id="doc",
            source_version="v1",
        )
        with self.assertRaisesRegex(ValueError, "not available"):
            normalize_fx_rows((future,), as_of_utc=NOW)

    def test_schema_and_value_drift_fail_closed(self) -> None:
        with self.assertRaisesRegex(FxParseError, "schema drift"):
            parse_boj_csv(
                "day,value\n2026-07-10,150\n",
                available_at_utc=NOW,
                source_document_id="doc",
                source_version="v1",
            )
        with self.assertRaisesRegex(FxParseError, "row list"):
            parse_bok_json(
                {"StatisticSearch": {"row": "bad"}},
                available_at_utc=NOW,
                source_document_id="doc",
                source_version="v1",
            )
        with self.assertRaisesRegex(FxParseError, "finite and positive"):
            parse_bok_json(
                {"StatisticSearch": {"row": [{"TIME": "20260710", "DATA_VALUE": "0"}]}},
                available_at_utc=NOW,
                source_document_id="doc",
                source_version="v1",
            )
        with self.assertRaisesRegex(ValueError, "storage scale"):
            parse_boj_csv(
                "observation_day,local_per_usd\n2026-07-10,150.12345678901\n",
                available_at_utc=NOW,
                source_document_id="doc",
                source_version="v1",
            )
        with self.assertRaisesRegex(ValueError, "storage integer digits"):
            parse_boj_csv(
                "observation_day,local_per_usd\n2026-07-10,123456789012345\n",
                available_at_utc=NOW,
                source_document_id="doc",
                source_version="v1",
            )

    def test_hash_is_deterministic_and_sensitive_to_lineage(self) -> None:
        kwargs = {
            "pair": "USDJPY",
            "observation_day": date(2026, 7, 10),
            "available_at_utc": NOW,
            "local_per_usd": Decimal("150.0000000000"),
            "usd_per_local": Decimal("0.00666666666667"),
            "change_pct": None,
            "source_kind": "BOJ",
            "source_document_id": "doc",
            "source_version": "v1",
            "previous_observation_day": None,
            "previous_source_kind": None,
            "previous_source_version": None,
            "previous_fact_hash": None,
        }
        first = canonical_fx_fact_hash(**kwargs)
        self.assertEqual(first, canonical_fx_fact_hash(**kwargs))
        self.assertEqual(
            first,
            "8a5b58d9062d453f48737df2f150aea5cea5fc2c808f915658618e7c7f32997f",
        )
        self.assertNotEqual(
            first, canonical_fx_fact_hash(**{**kwargs, "source_version": "v2"})
        )
        self.assertRegex(first, r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
