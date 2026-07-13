from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import unittest

from datapipeline.collectors.jpkr_deep import (
    canonical_disclosure_fact_hash,
    canonical_kline_fact_hash,
    canonical_security_fact_hash,
    normalize_fx_rows,
    parse_boj_csv,
    parse_bok_json,
    parse_jpx_kline_fixture,
    parse_jpx_security_fixture,
    parse_kind_disclosure_fixture,
)
from datapipeline.contracts import (
    CaptureProvenanceError,
    capture_source_version,
    validate_capture_wrapper,
)

FIXTURES = Path(__file__).parents[3] / "fixtures" / "real_data_r1"


def load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class OfficialFixtureParserTest(unittest.TestCase):
    def test_jpx_security_and_kline_exact_rows_and_hashes(self) -> None:
        security_wrapper = load("jpx_security_sample.json")
        securities = parse_jpx_security_fixture(security_wrapper)
        self.assertEqual(len(securities), 3)
        self.assertEqual([item.ticker for item in securities], ["1301", "130A", "1332"])
        self.assertTrue(all(item.market_scope == "jp" for item in securities))
        self.assertTrue(
            all(
                item.fact_hash == canonical_security_fact_hash(item)
                for item in securities
            )
        )
        self.assertTrue(
            all(
                item.available_at_utc.isoformat() == "2026-07-02T04:20:56+00:00"
                for item in securities
            )
        )
        for attempted in (
            datetime(2025, 1, 1, tzinfo=timezone.utc),
            datetime(2027, 1, 1, tzinfo=timezone.utc),
        ):
            with self.subTest(attempted=attempted):
                with self.assertRaises(TypeError):
                    parse_jpx_security_fixture(
                        security_wrapper, available_at_utc=attempted
                    )
        self.assertTrue(
            all(
                item.source_version
                == capture_source_version(load("jpx_security_sample.json"))
                for item in securities
            )
        )

        klines = parse_jpx_kline_fixture(load("jpx_kline_sample.json"))
        self.assertEqual(len(klines), 1)
        item = klines[0]
        self.assertEqual(
            (item.ticker, item.open, item.high, item.low, item.close),
            ("1301", "4500", "4530", "4490", "4505"),
        )
        self.assertEqual(item.volume, "36800")
        self.assertEqual(item.fact_hash, canonical_kline_fact_hash(item))
        self.assertEqual(item.available_at_utc.isoformat(), "2026-07-10T07:00:00+00:00")
        self.assertEqual(
            item.source_version,
            capture_source_version(load("jpx_kline_sample.json")),
        )

    def test_kind_disclosure_timezone_identity_and_hash(self) -> None:
        records = parse_kind_disclosure_fixture(load("kind_disclosure_sample.json"))
        self.assertEqual(len(records), 3)
        self.assertEqual(records[0].source_document_id, "20260710001011")
        self.assertEqual(records[0].ticker, "081660")
        self.assertEqual(
            records[0].event_time_utc.isoformat(),
            "2026-07-10T11:01:00+00:00",
        )
        self.assertEqual(
            records[0].available_at_utc.isoformat(),
            "2026-07-13T22:38:43+00:00",
        )
        self.assertTrue(
            all(
                item.fact_hash == canonical_disclosure_fact_hash(item)
                for item in records
            )
        )
        self.assertTrue(
            all(
                item.source_version
                == capture_source_version(load("kind_disclosure_sample.json"))
                for item in records
            )
        )

    def test_official_bok_and_boj_fx_fixtures_normalize(self) -> None:
        available = datetime(2026, 7, 13, 6, 0, tzinfo=timezone.utc)
        bok_fixture = load("bok_fx_sample.json")
        self.assertEqual(bok_fixture["fixture_mode"], "synthetic-keyed-unverified")
        self.assertEqual(bok_fixture["gap_code"], "PRIVATE_KEY_REQUIRED")
        boj_fixture = load("boj_fx_sample.json")
        boj_payload = validate_capture_wrapper(boj_fixture, expected_source_kind="BOJ")
        csv_payload = "observation_day,local_per_usd\n" + "\n".join(
            f"{row['observation_day']},{row['local_per_usd']}"
            for row in boj_payload["rows"]
        )
        boj = normalize_fx_rows(
            parse_boj_csv(
                csv_payload,
                available_at_utc=available,
                source_document_id=(
                    "BOJ:FM08'FXERD04:" + boj_fixture["capture_instance"]
                ),
                source_version=capture_source_version(boj_fixture),
            ),
            as_of_utc=available,
        )
        self.assertEqual(len(boj), 3)
        self.assertEqual(str(boj[-1].local_per_usd), "162.35")

    def test_nonproduction_and_schema_drift_fail_closed(self) -> None:
        cases = []
        production = load("jpx_security_sample.json")
        production["production_seed_allowed"] = True
        cases.append(lambda: parse_jpx_security_fixture(production))
        bad_scope = load("kind_disclosure_sample.json")
        bad_scope["payload"]["rows"][0]["market"] = "UNKNOWN"
        cases.append(lambda: parse_kind_disclosure_fixture(bad_scope))
        bad_ohlc = load("jpx_kline_sample.json")
        bad_ohlc["payload"]["rows"][0]["high"] = "1"
        cases.append(lambda: parse_jpx_kline_fixture(bad_ohlc))
        bad_code = load("jpx_security_sample.json")
        bad_code["payload"]["rows"][0]["local_code"] = "13 01"
        cases.append(lambda: parse_jpx_security_fixture(bad_code))
        for call in cases:
            with self.subTest(call=call):
                with self.assertRaises(ValueError):
                    call()

    def test_every_capture_metadata_field_and_payload_tamper_fails(self) -> None:
        fixtures = {
            "jpx_security_sample.json": "jpx-listed-company-monthly",
            "jpx_kline_sample.json": "jpx-daily-statistics-pdf",
            "kind_disclosure_sample.json": "kind",
            "boj_fx_sample.json": "BOJ",
        }
        mutations = {
            "capture_instance": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "capture_schema_version": "9.9.9",
            "captured_at_utc": "1999-01-01T00:00:00Z",
            "captured_response_sha256": "f" * 64,
            "declared_live_row_count": 999,
            "fixture_mode": True,
            "payload_sha256": "f" * 64,
            "production_seed_allowed": True,
            "source_url": "https://example.invalid/source",
            "terms_url": "https://example.invalid/terms",
            "wrapper_sha256": "f" * 64,
        }
        for name, source_kind in fixtures.items():
            original = load(name)
            for field, value in mutations.items():
                with self.subTest(name=name, field=field):
                    tampered = copy.deepcopy(original)
                    tampered[field] = value
                    with self.assertRaises(CaptureProvenanceError):
                        validate_capture_wrapper(
                            tampered, expected_source_kind=source_kind
                        )
            tampered = copy.deepcopy(original)
            tampered["payload"]["rows"][0]["tampered"] = True
            with self.subTest(name=name, field="payload"):
                with self.assertRaises(CaptureProvenanceError):
                    validate_capture_wrapper(tampered, expected_source_kind=source_kind)


if __name__ == "__main__":
    unittest.main()
