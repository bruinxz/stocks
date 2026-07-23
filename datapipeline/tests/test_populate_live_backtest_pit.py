from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest

from scripts.ops.populate_live_backtest_pit import _build_facts, _checkpoints


def ranked_row(ticker: str, signal_close: str = "100") -> dict:
    return {
        "symbol": f"sh.{ticker}",
        "name": f"stock-{ticker}",
        "market": "sh",
        "current_close": Decimal(signal_close),
        "oldest_close": Decimal("90"),
        "session_count": 20,
        "average_turnover": Decimal("1000000"),
        "volatility": Decimal("1.5"),
        "latest_day": date(2026, 1, 1),
        "listing_date": date(2000, 1, 1),
        "delisting_date": None,
        "quality": Decimal("0.90"),
        "growth": Decimal("0.80"),
        "valuation": Decimal("0.70"),
        "momentum": Decimal("0.60"),
        "trend": Decimal("0.50"),
        "risk": Decimal("0.40"),
        "rank_score": Decimal("0.68"),
    }


class PopulateLiveBacktestPitTest(unittest.TestCase):
    def test_checkpoints_reserve_a_prior_signal_session(self) -> None:
        sessions = [date(2026, 1, 1) + timedelta(days=index) for index in range(28)]

        checkpoints = _checkpoints(sessions)

        self.assertEqual(len(checkpoints), 27)
        self.assertEqual(checkpoints[0], sessions[1])
        self.assertNotIn(sessions[0], checkpoints)

    def test_nav_marks_previous_holdings_before_full_rebalance(self) -> None:
        sessions = [date(2026, 1, 1), date(2026, 1, 2), date(2026, 1, 3)]
        checkpoints = sessions[1:]
        selections = [
            [ranked_row("600001"), ranked_row("600002"), ranked_row("600003")],
            [ranked_row("600004"), ranked_row("600005"), ranked_row("600006")],
        ]
        execution_prices = [
            {"600001": Decimal("100"), "600002": Decimal("100"), "600003": Decimal("100")},
            {
                "600001": Decimal("110"),
                "600002": Decimal("110"),
                "600003": Decimal("110"),
                "600004": Decimal("100"),
                "600005": Decimal("100"),
                "600006": Decimal("100"),
            },
        ]
        published_at = datetime(2026, 1, 4, tzinfo=timezone.utc)

        facts = _build_facts(
            sessions,
            checkpoints,
            selections,
            execution_prices,
            date(2025, 7, 4),
            date(2026, 1, 3),
            published_at,
        )

        first_snapshot, _ = facts[0]
        second_snapshot, second_holdings = facts[1]
        self.assertAlmostEqual(first_snapshot.metrics["net_value"], 0.999, places=12)
        # Old holdings gain 10%, then a complete sell+buy costs 20 bps of NAV.
        self.assertAlmostEqual(second_snapshot.metrics["net_value"], 1.0967022, places=10)
        self.assertEqual(second_snapshot.as_of_utc.hour, 7)
        self.assertEqual(second_snapshot.published_at_utc, published_at)
        self.assertTrue(all(item.return_since_entry == Decimal("0E-10") for item in second_holdings))
        self.assertTrue(
            all(
                item.source_version == "daily-bars-close-execution@2.0.0"
                for item in second_holdings
            )
        )


if __name__ == "__main__":
    unittest.main()
