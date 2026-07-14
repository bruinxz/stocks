from __future__ import annotations

import json
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from datapipeline.collectors.jpkr_deep import (
    live_capture,
    parse_boj_capture_fixture,
    parse_jpx_security_fixture,
    parse_kind_disclosure_fixture,
)
from datapipeline.contracts import (
    build_capture_wrapper,
    capture_source_version,
    validate_capture_wrapper,
)


class LiveCaptureCliTest(unittest.TestCase):
    def wrapper(
        self,
        source_kind,
        source_url,
        terms_url,
        raw,
        count,
        payload,
    ):
        with (
            patch.object(
                live_capture.uuid,
                "uuid4",
                return_value=live_capture.uuid.UUID(
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                ),
            ),
            patch.object(
                live_capture,
                "_captured_at",
                return_value="2026-07-10T12:34:56Z",
            ),
        ):
            return live_capture._wrap(
                source_kind=source_kind,
                source_url=source_url,
                terms_url=terms_url,
                raw=raw,
                status=200,
                live_row_count=count,
                payload=payload,
            )

    def test_boj_raw_to_wrapper_and_fact_hash_chain(self) -> None:
        raw = (
            b"header\n2026/07/07,161.97,162.1\n"
            b"2026/07/08,162.22,162.3\n2026/07/09,162.35,162.4\n"
        )
        with patch.object(
            live_capture,
            "_read",
            return_value=(raw, 200, "text/csv"),
        ), patch.object(
            live_capture.uuid,
            "uuid4",
            return_value=live_capture.uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ), patch.object(
            live_capture,
            "_captured_at",
            return_value="2026-07-10T12:34:56Z",
        ):
            wrapper = live_capture.capture_boj(
                live_capture.date(2026, 7, 7),
                live_capture.date(2026, 7, 9),
            )
        self.assertEqual(
            wrapper["captured_response_sha256"],
            hashlib.sha256(raw).hexdigest(),
        )
        self.assertEqual(wrapper["declared_live_row_count"], 3)
        self.assertEqual(len(wrapper["payload"]["rows"]), 3)
        self.assertEqual(
            validate_capture_wrapper(wrapper, expected_source_kind="BOJ"),
            wrapper["payload"],
        )
        self.assertEqual(
            capture_source_version(wrapper),
            "1.0.0:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:"
            + wrapper["captured_response_sha256"]
            + ":"
            + wrapper["wrapper_sha256"],
        )
        records = parse_boj_capture_fixture(
            wrapper,
            as_of_utc=live_capture.datetime(
                2026, 7, 10, 13, tzinfo=live_capture.timezone.utc
            ),
        )
        changed_raw = raw + b"\n"
        changed_wrapper = self.wrapper(
            "BOJ",
            live_capture.BOJ_FX_URL,
            live_capture.BOJ_TERMS_URL,
            changed_raw,
            3,
            wrapper["payload"],
        )
        changed_records = parse_boj_capture_fixture(
            changed_wrapper,
            as_of_utc=live_capture.datetime(
                2026, 7, 10, 13, tzinfo=live_capture.timezone.utc
            ),
        )
        self.assertNotEqual(
            capture_source_version(wrapper),
            capture_source_version(changed_wrapper),
        )
        self.assertNotEqual(records[0].fact_hash, changed_records[0].fact_hash)
        changed_payload = json.loads(json.dumps(wrapper["payload"]))
        changed_payload["rows"][0]["local_per_usd"] = "999"
        payload_wrapper = self.wrapper(
            "BOJ",
            live_capture.BOJ_FX_URL,
            live_capture.BOJ_TERMS_URL,
            raw,
            3,
            changed_payload,
        )
        self.assertNotEqual(
            wrapper["payload_sha256"], payload_wrapper["payload_sha256"]
        )
        self.assertNotEqual(
            wrapper["wrapper_sha256"], payload_wrapper["wrapper_sha256"]
        )

    def test_jpx_and_kind_raw_construction_chain(self) -> None:
        jpx_raw = b"same-payload-raw-v1"
        jpx_payload = {
            "rows": [
                {
                    "effective_day": "20260630",
                    "local_code": "1301",
                    "name_local": "name",
                    "section": "Prime 内国株式",
                    "sector_33_code": "50",
                    "sector_33_name": "sector",
                    "size_code": "6",
                    "size_name": "small",
                }
            ]
        }
        first = self.wrapper(
            "jpx-listed-company-monthly",
            live_capture.JPX_SECURITY_URL,
            live_capture.JPX_TERMS_URL,
            jpx_raw,
            4437,
            jpx_payload,
        )
        second = self.wrapper(
            "jpx-listed-company-monthly",
            live_capture.JPX_SECURITY_URL,
            live_capture.JPX_TERMS_URL,
            jpx_raw + b"x",
            4437,
            jpx_payload,
        )
        available = live_capture.datetime(
            2026, 7, 2, 4, 20, 56, tzinfo=live_capture.timezone.utc
        )
        self.assertNotEqual(
            parse_jpx_security_fixture(first)[0].fact_hash,
            parse_jpx_security_fixture(second)[0].fact_hash,
        )
        kind_payload = {
            "source_document_day": "2026-07-10",
            "rows": [
                {
                    "time_local": "20:01",
                    "market": "유가증권",
                    "short_code": "08166",
                    "company_name_local": "name",
                    "receipt_no": "20260710001011",
                    "headline_local": "headline",
                    "submitter": "submitter",
                }
            ],
        }
        kind = self.wrapper(
            "kind",
            live_capture.KIND_URL,
            live_capture.KIND_TERMS_URL,
            b"kind-raw",
            86,
            kind_payload,
        )
        self.assertEqual(
            parse_kind_disclosure_fixture(kind)[0].source_version,
            capture_source_version(kind),
        )

    def test_public_cli_has_no_keyed_bok_path(self) -> None:
        source = Path(live_capture.__file__).read_text(encoding="utf-8")
        self.assertNotIn("--bok-key", source)
        self.assertNotIn("capture_bok", source)
        self.assertNotIn("BOK_URL", source)

    def test_cli_requires_confirmation_and_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "capture.json"
            missing = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "datapipeline.collectors.jpkr_deep.live_capture",
                    "--source",
                    "boj",
                    "--start",
                    "2026-07-07",
                    "--end",
                    "2026-07-09",
                    "--output",
                    str(output),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(missing.returncode, 2)
            self.assertEqual(
                json.loads(missing.stderr),
                {"error": "SELF_USE_CONFIRMATION_REQUIRED"},
            )
            self.assertFalse(output.exists())
            output.write_text("occupied", encoding="utf-8")
            with self.assertRaisesRegex(live_capture.LiveCaptureError, "OUTPUT_EXISTS"):
                live_capture.write_fixture({}, output)

    def test_sentinel_exceptions_are_constant_and_redacted(self) -> None:
        sentinel = "SENTINEL_KEY_URL_PATH"
        for error_name in ("OSError", "ValueError", "JSONDecodeError"):
            with self.subTest(
                error=error_name
            ), tempfile.TemporaryDirectory() as directory:
                expression = (
                    f"json.JSONDecodeError({sentinel!r},{sentinel!r},0)"
                    if error_name == "JSONDecodeError"
                    else f"{error_name}({sentinel!r})"
                )
                script = "\n".join(
                    (
                        "import json,runpy,urllib.request",
                        "def fail(*args, **kwargs):",
                        f"    raise {expression}",
                        "urllib.request.urlopen = fail",
                        "runpy.run_module("
                        "'datapipeline.collectors.jpkr_deep.live_capture',"
                        "run_name='__main__')",
                    )
                )
                command = [
                    sys.executable,
                    "-c",
                    script,
                    "--confirm-self-use",
                    "--source",
                    "boj",
                    "--start",
                    "2026-07-07",
                    "--end",
                    "2026-07-09",
                    "--output",
                    str(Path(directory) / "capture.json"),
                ]
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(
                    json.loads(result.stderr),
                    {"error": "SOURCE_READ_FAILED"},
                )
                self.assertNotIn(sentinel, result.stdout + result.stderr)
                self.assertNotIn("Traceback", result.stdout + result.stderr)

    def test_argument_errors_never_echo_sentinels_paths_or_urls(self) -> None:
        sentinel = "SUPER_SECRET_BOK_KEY_123"
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "capture.json")
            cases = (
                (
                    "--confirm-self-use",
                    "--source",
                    "boj",
                    "--bok-key",
                    sentinel,
                    "--start",
                    "2026-07-01",
                    "--end",
                    "2026-07-02",
                    "--output",
                    output,
                ),
                (
                    "--confirm-self-use",
                    "--source",
                    "https://" + sentinel,
                    "--output",
                    output,
                ),
                (
                    "--confirm-self-use",
                    "--source",
                    "boj",
                    "--start",
                    sentinel,
                    "--end",
                    "2026-07-02",
                    "--output",
                    output,
                ),
            )
            for args in cases:
                with self.subTest(args=args):
                    result = subprocess.run(
                        [
                            sys.executable,
                            "-m",
                            "datapipeline.collectors.jpkr_deep.live_capture",
                            *args,
                        ],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    combined = result.stdout + result.stderr
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(
                        json.loads(result.stderr)["error"],
                        {"INVALID_ARGUMENTS", "INVALID_DATE_WINDOW"},
                    )
                    self.assertNotIn(sentinel, combined)
                    self.assertNotIn(str(Path.cwd()), combined)
                    self.assertNotIn("https://", combined)
                    self.assertFalse(Path(output).exists())


if __name__ == "__main__":
    unittest.main()
