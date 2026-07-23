from pathlib import Path
import os
import unittest
from unittest.mock import patch

from scripts.ops import (
    populate_live_backtest_pit,
    populate_live_kr_market,
    populate_live_multibagger,
    populate_live_recommendations,
    populate_live_us_tech_market,
    sync_global_markets_daily,
)


class GlobalSyncChildEnvironmentTest(unittest.TestCase):
    def test_every_child_uses_process_environment_when_env_file_is_absent(self) -> None:
        missing = Path("/definitely/missing/stocks-backend.env")
        modules = (
            sync_global_markets_daily,
            populate_live_kr_market,
            populate_live_us_tech_market,
            populate_live_recommendations,
            populate_live_multibagger,
            populate_live_backtest_pit,
        )

        with patch.dict(os.environ, {"DB_HOST": "runtime-db"}, clear=False):
            for module in modules:
                with self.subTest(module=module.__name__):
                    self.assertEqual(module._load_env(missing)["DB_HOST"], "runtime-db")


if __name__ == "__main__":
    unittest.main()
