from datetime import date, datetime, timezone
import unittest

from datapipeline.contracts import JpKrDailyKlineRecord, JpKrSecurityRecord


NOW = datetime(2026, 7, 14, tzinfo=timezone.utc)


class ForgedString(str):
    def __eq__(self, _other: object) -> bool:
        return True

    def __ne__(self, _other: object) -> bool:
        return False

    __hash__ = str.__hash__


class JpKrOfficialRecordIntegrityTest(unittest.TestCase):
    def security(self, **overrides: object) -> JpKrSecurityRecord:
        values = {
            "market_scope": "jp",
            "exchange": "tse",
            "ticker": "7203",
            "ticker_name_local": "Toyota",
            "ticker_name_en": "Toyota",
            "currency": "JPY",
            "listing_day": date(1949, 5, 16),
            "delisting_day": None,
            "is_active": True,
            "source_kind": "jpx",
            "source_document_id": "jpx-security-7203",
            "source_version": "capture-v1",
            "available_at_utc": NOW,
            "fact_hash": "a" * 64,
            "source_payload": {},
        }
        values.update(overrides)
        return JpKrSecurityRecord(**values)  # type: ignore[arg-type]

    def kline(self, **overrides: object) -> JpKrDailyKlineRecord:
        values = {
            "market_scope": "jp",
            "exchange": "tse",
            "ticker": "7203",
            "ticker_name_local": "Toyota",
            "ticker_name_en": "Toyota",
            "trading_day": NOW.date(),
            "effective_at_utc": NOW,
            "available_at_utc": NOW,
            "open": "100",
            "high": "110",
            "low": "90",
            "close": "105",
            "adjusted_close": None,
            "corporate_action_version": None,
            "volume": "1000",
            "turnover": None,
            "currency": "JPY",
            "is_halted": False,
            "dividend_amount": None,
            "split_ratio": None,
            "market_cap_local": None,
            "turnover_rate": None,
            "halt_reason_code": None,
            "source_kind": "jpx",
            "source_document_id": "jpx-kline-7203",
            "source_version": "capture-v1",
            "fact_hash": "b" * 64,
        }
        values.update(overrides)
        return JpKrDailyKlineRecord(**values)  # type: ignore[arg-type]

    def test_source_version_policy_is_shared_and_exact(self) -> None:
        for value in ("版本-v1", " capture-v1 ", ForgedString("capture-v1")):
            with self.subTest(value=value, type=type(value)):
                with self.assertRaisesRegex(ValueError, "source_version"):
                    self.security(source_version=value)
                with self.assertRaisesRegex(ValueError, "source_version"):
                    self.kline(source_version=value)

    def test_fact_hash_rejects_comparison_overriding_str_subclass(self) -> None:
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.security(fact_hash=ForgedString("a" * 64))
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.kline(fact_hash=ForgedString("b" * 64))


if __name__ == "__main__":
    unittest.main()
