import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from strategy.reporting.cli import (
    PROTOCOL_VERSION,
    ProjectionCliError,
    _write_json,
    dispatch,
)


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "reporting" / "fixtures"
MODULE = "strategy.reporting.cli"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def run_cli(request=None, raw=None):
    payload = raw if raw is not None else json.dumps(request, ensure_ascii=False)
    return subprocess.run(
        [sys.executable, "-m", MODULE],
        cwd=ROOT.parents[0],
        input=payload.encode("utf-8"),
        capture_output=True,
        check=False,
    )


class ProjectionCliTests(unittest.TestCase):
    def setUp(self):
        self.envelope = fixture("recommendation_list_us_v031.json")
        self.daily = fixture("daily_report_us_v031.golden.json")
        self.history = fixture("report_history_us_v031.golden.json")

    def test_dispatch_daily_and_history_match_sot_goldens(self):
        self.assertEqual(
            dispatch(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "op": "daily",
                    "envelope": self.envelope,
                }
            ),
            {
                "protocol_version": PROTOCOL_VERSION,
                "ok": True,
                "result": self.daily,
            },
        )
        self.assertEqual(
            dispatch(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "op": "history",
                    "envelopes": [self.envelope],
                }
            ),
            {
                "protocol_version": PROTOCOL_VERSION,
                "ok": True,
                "result": self.history,
            },
        )

    def test_subprocess_stdout_is_deterministic_compact_json(self):
        request = {
            "protocol_version": PROTOCOL_VERSION,
            "op": "daily",
            "envelope": self.envelope,
        }
        first = run_cli(request)
        second = run_cli(request)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(first.stderr, b"")
        self.assertEqual(first.stdout, second.stdout)
        self.assertTrue(first.stdout.endswith(b"\n"))
        self.assertNotIn(b"\n ", first.stdout)
        self.assertEqual(
            json.loads(first.stdout),
            {
                "protocol_version": PROTOCOL_VERSION,
                "ok": True,
                "result": self.daily,
            },
        )

    def test_history_filters_are_forwarded_without_formula_duplication(self):
        result = run_cli(
            {
                "protocol_version": PROTOCOL_VERSION,
                "op": "history",
                "envelopes": [self.envelope],
                "query": "AAPL",
                "profile": "us_preferred",
                "market_scope": "us",
                "from_day": "2026-07-12",
                "to_day": "2026-07-12",
            }
        )
        self.assertEqual(result.returncode, 0)
        body = json.loads(result.stdout)
        self.assertTrue(body["ok"])
        self.assertEqual(body["result"]["total"], 1)
        self.assertEqual(body["result"]["filters"]["query"], "aapl")

    def test_invalid_json_operation_keys_and_contract_use_controlled_errors(self):
        cases = (
            (run_cli(raw="{"), 2, "INVALID_JSON"),
            (
                run_cli(
                    {"protocol_version": PROTOCOL_VERSION, "op": "unknown"}
                ),
                2,
                "INVALID_OPERATION",
            ),
            (run_cli({"op": "daily", "envelope": self.envelope}), 2, "INVALID_PROTOCOL"),
            (
                run_cli(
                    {
                        "protocol_version": PROTOCOL_VERSION,
                        "op": "daily",
                        "envelope": self.envelope,
                        "legacy": True,
                    }
                ),
                2,
                "INVALID_REQUEST",
            ),
            (
                run_cli(
                    {
                        "protocol_version": PROTOCOL_VERSION,
                        "op": "history",
                        "envelopes": {},
                    }
                ),
                2,
                "INVALID_REQUEST",
            ),
            (
                run_cli(
                    {
                        "protocol_version": PROTOCOL_VERSION,
                        "op": "daily",
                        "envelope": {**self.envelope, "profile": "custom"},
                    }
                ),
                3,
                "CONTRACT_ERROR",
            ),
            (
                run_cli(
                    raw='{"protocol_version":"1.0.0","op":"daily","op":"history"}'
                ),
                2,
                "INVALID_JSON",
            ),
            (
                run_cli(
                    raw='{"protocol_version":"1.0.0","op":"daily","envelope":NaN}'
                ),
                2,
                "INVALID_JSON",
            ),
        )
        for completed, expected_exit, expected_code in cases:
            with self.subTest(code=expected_code):
                self.assertEqual(completed.returncode, expected_exit)
                self.assertEqual(completed.stdout, b"")
                error = json.loads(completed.stderr)
                self.assertEqual(error["protocol_version"], PROTOCOL_VERSION)
                self.assertFalse(error["ok"])
                self.assertEqual(error["error"]["code"], expected_code)

    def test_oversize_input_rejects_before_json_parse(self):
        result = run_cli(raw=" " * (8 * 1024 * 1024 + 1))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "INPUT_TOO_LARGE")

    def test_output_cap_fails_closed(self):
        class Buffer:
            def __init__(self):
                self.buffer = self

            def write(self, _value):
                raise AssertionError("oversized output must not be written")

            def flush(self):
                pass

        with patch("strategy.reporting.cli.MAX_OUTPUT_BYTES", 1):
            with self.assertRaisesRegex(ProjectionCliError, "output too large"):
                _write_json(Buffer(), {"ok": True})


if __name__ == "__main__":
    unittest.main()
