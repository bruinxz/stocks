from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid

from ai.replay.cli import (
    JOB_STORE_FILENAME,
    MAX_INPUT_BYTES,
    PROTOCOL_VERSION,
    RUNTIME_DIR_ENV,
)
from ai.replay.service import ReplayService
from ai.replay.types import ReplayPins


ROOT = Path(__file__).resolve().parents[2]
MODULE = "ai.replay.cli"


def _temporary_directory():
    return tempfile.TemporaryDirectory(dir=ROOT)


def _pins(**overrides):
    values = {
        "trading_day": "2026-07-14",
        "as_of": "2026-07-14T06:00:00Z",
        "profile": "us_preferred",
        "market_scope": "us",
        "profile_version": "1.0.0",
        "contract_version": "0.3.1",
        "input_fingerprint": "a" * 64,
        "strategy_version": "1.0.0",
        "pipeline_version": "1.0.0",
    }
    values.update(overrides)
    return values


def _submit_request(**overrides):
    return {
        "protocol_version": PROTOCOL_VERSION,
        "op": "submit",
        "pins": _pins(**overrides),
    }


def _job_request(op, job_id):
    return {
        "protocol_version": PROTOCOL_VERSION,
        "op": op,
        "job_id": job_id,
    }


def _environment(runtime_dir=None):
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "PYTHONPATH": str(ROOT),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if runtime_dir is not None:
        environment[RUNTIME_DIR_ENV] = str(runtime_dir)
    return environment


def run_cli(*, request=None, raw=None, runtime_dir=None):
    payload = raw if raw is not None else json.dumps(request)
    return subprocess.run(
        [sys.executable, "-m", MODULE],
        cwd=ROOT,
        env=_environment(runtime_dir),
        input=payload.encode("utf-8"),
        capture_output=True,
        check=False,
    )


class ReplayCliSubprocessTests(unittest.TestCase):
    def test_submit_status_and_idempotency_survive_independent_processes(self):
        with _temporary_directory() as directory:
            runtime_dir = Path(directory)
            first = run_cli(request=_submit_request(), runtime_dir=runtime_dir)
            second = run_cli(request=_submit_request(), runtime_dir=runtime_dir)
            self.assertEqual(first.returncode, 0)
            self.assertEqual(first.stderr, b"")
            self.assertEqual(first.stdout, second.stdout)
            first_body = json.loads(first.stdout)
            self.assertEqual(set(first_body), {"protocol_version", "ok", "result"})
            self.assertEqual(set(first_body["result"]), {"job"})
            self.assertEqual(set(first_body["result"]["job"]), {"job_id", "status"})
            job_id = first_body["result"]["job"]["job_id"]
            self.assertEqual(first_body["result"]["job"]["status"], "queued")
            self.assertEqual(str(uuid.UUID(job_id)), job_id)

            status = run_cli(
                request=_job_request("status", job_id),
                runtime_dir=runtime_dir,
            )
            self.assertEqual(status.returncode, 0)
            self.assertEqual(status.stderr, b"")
            self.assertEqual(status.stdout, first.stdout)

            state_path = runtime_dir / JOB_STORE_FILENAME
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(len(state["jobs"]), 1)
            self.assertEqual(len(state["keys"]), 1)
            self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)

    def test_run_one_fails_closed_and_preserves_queued_state(self):
        with _temporary_directory() as directory:
            runtime_dir = Path(directory)
            submitted = run_cli(request=_submit_request(), runtime_dir=runtime_dir)
            job_id = json.loads(submitted.stdout)["result"]["job"]["job_id"]
            attempted = run_cli(
                request=_job_request("run_one", job_id),
                runtime_dir=runtime_dir,
            )
            self.assertEqual(attempted.returncode, 4)
            self.assertEqual(attempted.stdout, b"")
            self.assertEqual(
                json.loads(attempted.stderr),
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "ok": False,
                    "error": {
                        "code": "REPLAY_RUNTIME_UNAVAILABLE",
                        "message": "replay runtime unavailable",
                    },
                },
            )
            recovered = run_cli(
                request=_job_request("status", job_id),
                runtime_dir=runtime_dir,
            )
            self.assertEqual(
                json.loads(recovered.stdout)["result"]["job"]["status"],
                "queued",
            )

    def test_malformed_duplicate_nonfinite_and_surrogates_are_controlled(self):
        marker = "SECRET_MARKER"
        cases = (
            "{",
            '{"protocol_version":"1.0.0","op":"status",' '"op":"run_one","job_id":"x"}',
            '{"protocol_version":"1.0.0","op":"submit","pins":NaN}',
            '{"protocol_version":"1.0.0","op":"submit","pins":Infinity}',
            '{"protocol_version":"1.0.0","op":"submit","pins":-Infinity}',
            '{"protocol_version":"1.0.0","op":"submit","pins":1e400}',
            '{"protocol_version":"1.0.0","op":"status","job_id":"\\ud800'
            + marker
            + '"}',
            '{"protocol_version":"1.0.0","op":"status","\\udc00'
            + marker
            + '":"x","job_id":"x"}',
        )
        with _temporary_directory() as directory:
            for raw in cases:
                with self.subTest(raw=raw):
                    result = run_cli(raw=raw, runtime_dir=directory)
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(result.stdout, b"")
                    body = json.loads(result.stderr)
                    self.assertEqual(body["error"]["code"], "INVALID_JSON")
                    self.assertNotIn(marker.encode(), result.stderr)
                    self.assertNotIn(b"Traceback", result.stderr)
                    self.assertNotIn(str(ROOT).encode(), result.stderr)

    def test_valid_surrogate_pair_is_not_classified_as_invalid_json(self):
        with _temporary_directory() as directory:
            result = run_cli(
                raw='{"protocol_version":"1.0.0","op":"\\ud83d\\ude00"}',
                runtime_dir=directory,
            )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(
            json.loads(result.stderr)["error"]["code"],
            "INVALID_OPERATION",
        )

    def test_exact_keys_types_semantic_pins_and_unknown_job(self):
        unknown = "32345678-1234-4234-8234-567812345678"
        cases = (
            ({}, 2, "INVALID_PROTOCOL"),
            (
                {"protocol_version": PROTOCOL_VERSION, "op": "unknown"},
                2,
                "INVALID_OPERATION",
            ),
            ({**_submit_request(), "extra": True}, 2, "INVALID_REQUEST"),
            (
                {
                    **_submit_request(),
                    "pins": {**_pins(), "extra": "x"},
                },
                2,
                "INVALID_REQUEST",
            ),
            (
                {**_submit_request(), "pins": []},
                2,
                "INVALID_REQUEST",
            ),
            (_submit_request(profile="custom"), 3, "INVALID_REPLAY_PINS"),
            (_job_request("status", "not-a-uuid"), 2, "INVALID_REQUEST"),
            (_job_request("status", unknown), 3, "REPLAY_JOB_NOT_FOUND"),
        )
        with _temporary_directory() as directory:
            for request, exit_code, code in cases:
                with self.subTest(code=code):
                    result = run_cli(request=request, runtime_dir=directory)
                    self.assertEqual(result.returncode, exit_code)
                    self.assertEqual(result.stdout, b"")
                    body = json.loads(result.stderr)
                    self.assertEqual(set(body), {"protocol_version", "ok", "error"})
                    self.assertEqual(set(body["error"]), {"code", "message"})
                    self.assertEqual(body["error"]["code"], code)

    def test_input_cap_and_unsafe_runtime_configuration_do_not_leak(self):
        oversized = run_cli(raw=" " * (MAX_INPUT_BYTES + 1))
        self.assertEqual(oversized.returncode, 2)
        self.assertEqual(oversized.stdout, b"")
        self.assertEqual(
            json.loads(oversized.stderr)["error"]["code"],
            "INPUT_TOO_LARGE",
        )

        secret = "SECRET_RUNTIME_MARKER"
        missing = run_cli(request=_submit_request())
        self.assertEqual(missing.returncode, 4)
        self.assertEqual(missing.stdout, b"")
        self.assertEqual(
            json.loads(missing.stderr)["error"]["code"],
            "REPLAY_STORE_UNAVAILABLE",
        )

        with _temporary_directory() as directory:
            unsafe = Path(directory) / secret
            unsafe.mkdir(mode=0o755)
            rejected = run_cli(request=_submit_request(), runtime_dir=unsafe)
        self.assertEqual(rejected.returncode, 4)
        self.assertEqual(rejected.stdout, b"")
        self.assertEqual(
            json.loads(rejected.stderr)["error"]["code"],
            "REPLAY_STORE_UNAVAILABLE",
        )
        self.assertNotIn(secret.encode(), rejected.stderr)
        self.assertNotIn(b"Traceback", rejected.stderr)
        self.assertNotIn(str(ROOT).encode(), rejected.stderr)

    def test_subprocess_idempotency_key_matches_service_authority(self):
        pins = _pins()
        expected = ReplayService._idempotency_key(ReplayPins(**pins))
        with _temporary_directory() as directory:
            result = run_cli(request=_submit_request(), runtime_dir=directory)
            self.assertEqual(result.returncode, 0)
            state = json.loads(
                (Path(directory) / JOB_STORE_FILENAME).read_text(encoding="utf-8")
            )
        self.assertEqual(set(state["keys"]), {expected})


if __name__ == "__main__":
    unittest.main()
