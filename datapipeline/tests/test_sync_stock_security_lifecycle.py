from datetime import date
import unittest

from scripts.ops.sync_stock_security_lifecycle import _records


class StockSecurityLifecycleTest(unittest.TestCase):
    def test_normalizes_current_and_delisted_official_rows(self) -> None:
        current = _records(
            [{"证券代码": "600000", "上市日期": date(1999, 11, 10)}],
            market="sh",
            code_field="证券代码",
            listing_field="上市日期",
            delisting_field=None,
            is_listed=True,
        )
        delisted = _records(
            [
                {
                    "证券代码": "000004",
                    "上市日期": "1990-12-01",
                    "终止上市日期": "2026-07-14",
                }
            ],
            market="sz",
            code_field="证券代码",
            listing_field="上市日期",
            delisting_field="终止上市日期",
            is_listed=False,
        )

        self.assertEqual(current["sh.600000"]["listing_date"], date(1999, 11, 10))
        self.assertTrue(current["sh.600000"]["is_listed"])
        self.assertEqual(delisted["sz.000004"]["delisting_date"], date(2026, 7, 14))
        self.assertFalse(delisted["sz.000004"]["is_listed"])

    def test_rejects_impossible_lifecycle(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "delisting precedes listing"):
            _records(
                [
                    {
                        "证券代码": "000004",
                        "上市日期": "2026-07-15",
                        "终止上市日期": "2026-07-14",
                    }
                ],
                market="sz",
                code_field="证券代码",
                listing_field="上市日期",
                delisting_field="终止上市日期",
                is_listed=False,
            )


if __name__ == "__main__":
    unittest.main()
