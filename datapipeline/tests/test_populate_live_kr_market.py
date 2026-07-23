from contextlib import redirect_stdout
from io import StringIO
import json
import sys
import unittest
from unittest.mock import patch

from scripts.ops import populate_live_kr_market


PRICE = {
    "localTradedAt": "2026-07-23",
    "openPrice": "100",
    "highPrice": "110",
    "lowPrice": "95",
    "closePrice": "105",
    "accumulatedTradingVolume": "1,000",
}


class PopulateLiveKrMarketTest(unittest.TestCase):
    def test_dry_run_includes_official_kospi_rows_and_summary(self) -> None:
        def stock_response(path: str):
            if path.endswith("/basic"):
                ticker = path.split("/", 1)[0]
                return {"stockName": f"종목-{ticker}", "sosok": "0"}
            return [PRICE]

        def index_response(url: str):
            if url.endswith("/basic"):
                return {"stockName": "코스피"}
            return [PRICE]

        stdout = StringIO()
        argv = [
            "populate_live_kr_market.py",
            "--env-file",
            "/does/not/need/to/exist",
            "--days",
            "2",
            "--dry-run",
        ]
        with (
            patch.object(sys, "argv", argv),
            patch.object(populate_live_kr_market, "_json", stock_response),
            patch.object(populate_live_kr_market, "_json_url", index_response),
            redirect_stdout(stdout),
        ):
            exit_code = populate_live_kr_market.main()

        result = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["security_count"], 9)
        self.assertEqual(result["kline_count"], 9)
        self.assertIn("KOSPI", result["tickers"])
        self.assertEqual(result["latest_trading_day"], "2026-07-23")


if __name__ == "__main__":
    unittest.main()
