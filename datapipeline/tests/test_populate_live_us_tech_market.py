from datetime import datetime, timezone
import unittest
from unittest.mock import Mock, patch

from scripts.ops import populate_live_us_tech_market


NOW = datetime(2026, 7, 23, 22, 30, tzinfo=timezone.utc)


class PopulateLiveUsTechMarketTest(unittest.TestCase):
    def test_retries_only_failed_symbols_with_lower_concurrency(self) -> None:
        attempts: dict[str, int] = {}

        def capture(symbol: str, _days: int, _available_at: datetime) -> list[dict]:
            attempts[symbol] = attempts.get(symbol, 0) + 1
            if symbol == "AAPL" and attempts[symbol] == 1:
                raise RuntimeError("transient throttle")
            return [{"symbol": symbol}]

        sleep = Mock()
        with (
            patch.dict(
                populate_live_us_tech_market.UNIVERSE,
                {
                    "AAPL": ("Apple", "stock", "broad_technology", False, True),
                    "MSFT": ("Microsoft", "stock", "software_cloud", False, True),
                },
                clear=True,
            ),
            patch.object(populate_live_us_tech_market, "_rows", capture),
        ):
            rows, errors, missing = populate_live_us_tech_market._capture_universe(
                14,
                NOW,
                sleep=sleep,
            )

        self.assertEqual([row["symbol"] for row in rows], ["AAPL", "MSFT"])
        self.assertEqual(attempts, {"AAPL": 2, "MSFT": 1})
        self.assertEqual(errors[0]["attempt"], 1)
        self.assertEqual(missing, [])
        sleep.assert_called_once_with(1.0)

    def test_permanent_failure_remains_missing_after_bounded_attempts(self) -> None:
        sleep = Mock()
        with (
            patch.dict(
                populate_live_us_tech_market.UNIVERSE,
                {"AAPL": ("Apple", "stock", "broad_technology", False, True)},
                clear=True,
            ),
            patch.object(
                populate_live_us_tech_market,
                "_rows",
                side_effect=RuntimeError("provider unavailable"),
            ),
        ):
            rows, errors, missing = populate_live_us_tech_market._capture_universe(
                14,
                NOW,
                sleep=sleep,
            )

        self.assertEqual(rows, [])
        self.assertEqual(len(errors), 3)
        self.assertEqual(missing, ["AAPL"])
        self.assertEqual(sleep.call_count, 2)
