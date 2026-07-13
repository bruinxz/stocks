from __future__ import annotations

import copy
from dataclasses import replace
from datetime import date, datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from datapipeline.fixtures.market_calendar import (
    LOCAL_DISPOSABLE_PURPOSE,
    SYNTHETIC_SOURCE,
    CalendarFixtureError,
    SyntheticCalendarPort,
    build_synthetic_calendars,
    canonical_calendar_hash,
    load_calendar_manifest,
    weekly_checkpoints,
)


MANIFEST_PATH = (
    Path(__file__).parents[3]
    / "fixtures"
    / "market_calendar"
    / "tab5_six_month_calendar.json"
)


class SyntheticCalendarFixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = load_calendar_manifest(
            MANIFEST_PATH, purpose=LOCAL_DISPOSABLE_PURPOSE
        )
        self.port = SyntheticCalendarPort(
            purpose=LOCAL_DISPOSABLE_PURPOSE,
            manifest_path=MANIFEST_PATH,
        )

    def test_exact_scope_session_checkpoint_and_window_counts(self) -> None:
        self.assertEqual(
            tuple(self.manifest["market_scopes"]),
            ("cn_a", "us", "jp", "kr"),
        )
        self.assertEqual(
            dict(self.manifest["window"]),
            {
                "calendar_start": "2026-01-10",
                "calendar_end": "2026-07-10",
                "inclusive_calendar_days": 182,
            },
        )
        for scope in self.manifest["market_scopes"]:
            with self.subTest(scope=scope):
                sessions = self.port.sessions(scope)
                checkpoints = self.port.checkpoints(scope)
                self.assertEqual(len(sessions), 128)
                self.assertEqual(len(checkpoints), 27)
                self.assertEqual(sessions[0].trade_date, "2026-01-12")
                self.assertEqual(sessions[-1].trade_date, "2026-07-10")
                self.assertEqual(checkpoints[0], sessions[0])
                self.assertEqual(checkpoints[-1], sessions[-1])
                self.assertEqual(checkpoints, weekly_checkpoints(sessions))

        common_checkpoints = (
            "2026-01-12",
            "2026-01-16",
            "2026-01-23",
            "2026-01-30",
            "2026-02-06",
            "2026-02-13",
            "2026-02-20",
            "2026-02-27",
            "2026-03-06",
            "2026-03-13",
            "2026-03-20",
            "2026-03-27",
            "2026-04-03",
            "2026-04-10",
            "2026-04-17",
            "2026-04-24",
            "2026-05-01",
            "2026-05-08",
            "2026-05-15",
            "2026-05-22",
            "2026-05-29",
            "2026-06-05",
            "2026-06-12",
            "2026-06-19",
            "2026-06-26",
            "2026-07-03",
            "2026-07-10",
        )
        for scope in ("us", "jp", "kr"):
            self.assertEqual(
                tuple(item.trade_date for item in self.port.checkpoints(scope)),
                common_checkpoints,
            )
        cn_checkpoints = list(common_checkpoints)
        cn_checkpoints[16] = "2026-04-30"
        self.assertEqual(
            tuple(item.trade_date for item in self.port.checkpoints("cn_a")),
            tuple(cn_checkpoints),
        )

    def test_closures_weekends_and_utc_close_rules(self) -> None:
        expected_closures = {
            "cn_a": {"2026-02-16", "2026-05-01"},
            "us": {"2026-02-16", "2026-05-25"},
            "jp": {"2026-02-11", "2026-05-04"},
            "kr": {"2026-03-02", "2026-05-05"},
        }
        expected_fixed_closes = {
            "cn_a": "07:00:00Z",
            "jp": "06:30:00Z",
            "kr": "06:30:00Z",
        }
        for scope in self.manifest["market_scopes"]:
            with self.subTest(scope=scope):
                sessions = self.port.sessions(scope)
                by_day = {session.trade_date: session for session in sessions}
                self.assertTrue(expected_closures[scope].isdisjoint(by_day))
                self.assertTrue(
                    all(date.fromisoformat(day).weekday() < 5 for day in by_day)
                )
                self.assertTrue(
                    all(session.source == SYNTHETIC_SOURCE for session in sessions)
                )
                self.assertTrue(
                    all(
                        datetime.fromisoformat(
                            session.session_close_utc.removesuffix("Z") + "+00:00"
                        ).tzinfo
                        == timezone.utc
                        for session in sessions
                    )
                )
                if scope in expected_fixed_closes:
                    self.assertEqual(
                        {session.session_close_utc[-9:] for session in sessions},
                        {expected_fixed_closes[scope]},
                    )

        us = {item.trade_date: item for item in self.port.sessions("us")}
        self.assertEqual(
            sum(item.session_close_utc.endswith("21:00:00Z") for item in us.values()),
            39,
        )
        self.assertEqual(
            sum(item.session_close_utc.endswith("20:00:00Z") for item in us.values()),
            89,
        )
        self.assertEqual(us["2026-03-06"].session_close_utc, "2026-03-06T21:00:00Z")
        self.assertEqual(us["2026-03-09"].session_close_utc, "2026-03-09T20:00:00Z")
        self.assertEqual(
            {session.session_close_utc[-9:] for session in us.values()},
            {"20:00:00Z", "21:00:00Z"},
        )

    def test_hashes_are_deterministic_distinct_and_scope_complete(self) -> None:
        first = build_synthetic_calendars(self.manifest)
        second = build_synthetic_calendars(self.manifest)
        self.assertEqual(first, second)
        hashes = {
            scope: canonical_calendar_hash(
                first[scope],
                calendar_start="2026-01-10",
                calendar_end="2026-07-10",
            )
            for scope in self.manifest["market_scopes"]
        }
        self.assertEqual(
            hashes,
            {
                "cn_a": "4677b0cde1effe19e5a397418de0c43e2eb0c48d9717e249e3e5ef4c67d1c9bf",
                "us": "6171091eff54de398c0caf40544bfb8e452ce042f680c9ef0f9f453267f9f14f",
                "jp": "9bec9d78e1033f8b96753fa7363c46e0d0aad9c1274398f7c9bc0ac158b90095",
                "kr": "84a21c09ecc3f9e05065bdf91942e692a50cc70ebd6e518326166708295fd865",
            },
        )
        self.assertEqual(
            hashes,
            {
                scope: self.port.fixture_hash(scope)
                for scope in self.manifest["market_scopes"]
            },
        )
        self.assertEqual(len(set(hashes.values())), 4)
        self.assertTrue(
            all(
                len(value) == 64 and set(value) <= set("0123456789abcdef")
                for value in hashes.values()
            )
        )
        us = first["us"]
        changed_close = list(us)
        changed_close[0] = replace(
            changed_close[0],
            session_close_utc="2026-01-12T20:59:59Z",
        )
        reversed_sessions = tuple(reversed(us))
        self.assertNotEqual(
            hashes["us"],
            canonical_calendar_hash(
                changed_close,
                calendar_start="2026-01-10",
                calendar_end="2026-07-10",
            ),
        )
        self.assertNotEqual(
            hashes["us"],
            canonical_calendar_hash(
                reversed_sessions,
                calendar_start="2026-01-10",
                calendar_end="2026-07-10",
            ),
        )

    def test_port_range_and_fail_closed_inputs(self) -> None:
        self.assertEqual(
            len(self.port.sessions("us", start="2026-03-01", end="2026-03-31")),
            22,
        )
        for call in (
            lambda: self.port.sessions("custom"),
            lambda: self.port.sessions("us", start="2026-02-30"),
            lambda: self.port.sessions("us", start="2026-07-10", end="2026-01-10"),
        ):
            with self.subTest(call=call):
                with self.assertRaises(CalendarFixtureError):
                    call()

    def test_manifest_refuses_production_or_non_synthetic_modes(self) -> None:
        for purpose in ("production", "prod", "", "LOCAL", None):
            with self.subTest(purpose=purpose):
                with self.assertRaises(CalendarFixtureError):
                    load_calendar_manifest(
                        MANIFEST_PATH, purpose=purpose  # type: ignore[arg-type]
                    )
                with self.assertRaises(CalendarFixtureError):
                    SyntheticCalendarPort(
                        purpose=purpose,  # type: ignore[arg-type]
                        manifest_path=MANIFEST_PATH,
                    )

        raw_manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        invalid_manifests = []
        for field, value in (
            ("production_seed_allowed", True),
            ("mode", "production"),
            ("fixture_kind", "official-exchange-calendar"),
            ("market_scopes", ["cn_a"]),
        ):
            invalid = copy.deepcopy(raw_manifest)
            invalid[field] = value
            invalid_manifests.append(invalid)
        no_disclaimer = copy.deepcopy(raw_manifest)
        no_disclaimer["disclaimer"] = "Official calendar."
        invalid_manifests.append(no_disclaimer)
        wrong_count = copy.deepcopy(raw_manifest)
        wrong_count["expected_open_sessions_per_scope"] = 127
        invalid_manifests.append(wrong_count)
        missing_closure = copy.deepcopy(raw_manifest)
        missing_closure["closures"]["us"] = ["2026-02-16"]
        invalid_manifests.append(missing_closure)
        gapped_rules = copy.deepcopy(raw_manifest)
        gapped_rules["session_close_utc"]["us"][1]["from"] = "2026-03-10"
        invalid_manifests.append(gapped_rules)

        for invalid in invalid_manifests:
            with self.subTest(invalid=invalid):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "calendar.json"
                    path.write_text(
                        json.dumps(invalid, ensure_ascii=False),
                        encoding="utf-8",
                    )
                    with self.assertRaises(CalendarFixtureError):
                        load_calendar_manifest(path, purpose=LOCAL_DISPOSABLE_PURPOSE)

    def test_manifest_and_port_outputs_are_deeply_immutable(self) -> None:
        with self.assertRaises(TypeError):
            self.manifest["window"]["calendar_start"] = "1999-01-01"
        with self.assertRaises(TypeError):
            self.manifest["closures"]["us"][0] = "1999-01-01"
        sessions = self.port.sessions("us")
        with self.assertRaises(AttributeError):
            sessions[0].trade_date = "1999-01-01"


if __name__ == "__main__":
    unittest.main()
