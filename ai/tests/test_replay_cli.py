from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
import uuid
from unittest.mock import patch

from ai.replay.cli import (
    ERROR_EXIT_CODES,
    JOB_STORE_FILENAME,
    PIN_KEYS,
    PROTOCOL_VERSION,
    RUNTIME_DIR_ENV,
    ReplayCliError,
    ReplayCliRuntime,
    ReplayRuntimeConfigurationError,
    ReplayRuntimeUnavailableError,
    ReplayWorkerProtocolError,
    PUBLIC_ERROR_MESSAGES,
    _error,
    _write_error,
    _write_success,
    build_runtime_from_environment,
    build_submit_status_runtime,
    dispatch,
    main,
)
from ai.replay.file_store import AtomicFileReplayJobStore
from ai.replay.fingerprint import compute_replay_input_fingerprint
from ai.replay.runtime import ReplayWorker
from ai.replay.service import ReplayPinsError, ReplayService
from ai.replay.types import (
    ReplayInputs,
    ReplayJob,
    ReplayPins,
    ReplayResult,
    SourceSlice,
)
from ai.snapshot.fingerprint import jcs_canonicalize


ROOT = Path(__file__).resolve().parents[2]
JOB_ID = uuid.UUID("12345678-1234-4234-8234-567812345678")
SNAPSHOT_ID = "22345678-1234-4234-8234-567812345678"
NOW = "2026-07-14T06:00:00Z"
KINDS = ("signals", "universe", "scores", "evidence")


def _temporary_directory():
    return tempfile.TemporaryDirectory(dir=ROOT)


def _records(kind):
    return ({"kind": kind},)


def _hash(kind):
    return hashlib.sha256(jcs_canonicalize(_records(kind)).encode("utf-8")).hexdigest()


def _pins(**overrides):
    values = {
        "trading_day": "2026-07-14",
        "as_of": NOW,
        "profile": "us_preferred",
        "market_scope": "us",
        "profile_version": "1.0.0",
        "contract_version": "0.3.1",
        "input_fingerprint": "0" * 64,
        "strategy_version": "1.0.0",
        "pipeline_version": "1.0.0",
    }
    provisional = ReplayPins(**values)
    inputs = ReplayInputs(
        signals=Source("signals").load(provisional),
        universe=Source("universe").load(provisional),
        scores=Source("scores").load(provisional),
        evidence=Source("evidence").load(provisional),
    )
    values["input_fingerprint"] = compute_replay_input_fingerprint(inputs)
    values.update(overrides)
    return ReplayPins(**values)


def _submit_request(pins=None):
    selected = pins or _pins()
    return {
        "protocol_version": PROTOCOL_VERSION,
        "op": "submit",
        "pins": {key: getattr(selected, key) for key in PIN_KEYS},
    }


def _job_request(op, job_id=str(JOB_ID)):
    return {
        "protocol_version": PROTOCOL_VERSION,
        "op": op,
        "job_id": job_id,
    }


class Source:
    def __init__(self, kind):
        self.kind = kind

    def load(self, pins):
        return SourceSlice(
            kind=self.kind,
            trading_day=pins.trading_day,
            as_of=pins.as_of,
            profile=pins.profile,
            market_scope=pins.market_scope,
            source_version=self.kind + "@1",
            content_hash=_hash(self.kind),
            records=_records(self.kind),
        )

    load_signals = load
    load_universe = load
    load_scores = load
    load_evidence = load


class Pipeline:
    def __init__(self, error=None):
        self.error = error

    def run(self, _pins, _inputs):
        if self.error is not None:
            raise self.error
        return ReplayResult(SNAPSHOT_ID, "f" * 64)


class ReturningWorker:
    def __init__(self, job):
        self.job = job

    def run_job(self, _job_id):
        return self.job

    def run_batch(self, _job_ids, *, limit):
        raise AssertionError("run_batch is outside the CLI protocol")


def _runtime(path, *, pipeline=None):
    store = AtomicFileReplayJobStore(path)
    sources = {kind: Source(kind) for kind in KINDS}
    service = ReplayService(
        signal_source=sources["signals"],
        universe_source=sources["universe"],
        score_source=sources["scores"],
        evidence_cache=sources["evidence"],
        pipeline=pipeline or Pipeline(),
        job_store=store,
        uuid_factory=lambda: JOB_ID,
        clock=lambda: NOW,
    )
    return ReplayCliRuntime(
        service=service,
        worker=ReplayWorker(service),
        close=store.close,
    )


class Buffer:
    def __init__(self):
        self.buffer = self
        self.value = b""

    def write(self, value):
        self.value += value

    def flush(self):
        pass


class BinaryStream:
    def __init__(self, value=b""):
        self.buffer = io.BytesIO(value)

    def flush(self):
        pass


class ReplayCliTests(unittest.TestCase):
    def test_submit_is_idempotent_and_status_recovers_from_same_store(self):
        with _temporary_directory() as directory:
            path = Path(directory) / JOB_STORE_FILENAME
            first_runtime = _runtime(path)
            try:
                first = dispatch(_submit_request(), runtime=first_runtime)
                second = dispatch(_submit_request(), runtime=first_runtime)
            finally:
                first_runtime.close()

            second_runtime = _runtime(path)
            try:
                recovered = dispatch(_job_request("status"), runtime=second_runtime)
            finally:
                second_runtime.close()

            self.assertEqual(first, second)
            self.assertEqual(recovered, first)
            self.assertEqual(set(first), {"protocol_version", "ok", "result"})
            self.assertEqual(set(first["result"]), {"job"})
            self.assertEqual(
                first["result"]["job"],
                {"job_id": str(JOB_ID), "status": "queued"},
            )
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(state["jobs"]), 1)
            self.assertEqual(len(state["keys"]), 1)

    def test_injected_worker_completes_and_terminal_run_is_idempotent(self):
        with _temporary_directory() as directory:
            runtime = _runtime(Path(directory) / JOB_STORE_FILENAME)
            try:
                dispatch(_submit_request(), runtime=runtime)
                completed = dispatch(_job_request("run_one"), runtime=runtime)
                repeated = dispatch(_job_request("run_one"), runtime=runtime)
            finally:
                runtime.close()

        self.assertEqual(completed, repeated)
        self.assertEqual(
            completed["result"]["job"],
            {
                "job_id": str(JOB_ID),
                "status": "completed",
            },
        )

    def test_failed_worker_response_is_public_and_secret_free(self):
        with _temporary_directory() as directory:
            runtime = _runtime(
                Path(directory) / JOB_STORE_FILENAME,
                pipeline=Pipeline(RuntimeError("SECRET_TOKEN=/private/path")),
            )
            try:
                dispatch(_submit_request(), runtime=runtime)
                failed = dispatch(_job_request("run_one"), runtime=runtime)
            finally:
                runtime.close()

        self.assertEqual(
            failed["result"]["job"],
            {
                "job_id": str(JOB_ID),
                "status": "failed",
            },
        )
        self.assertNotIn("SECRET_TOKEN", json.dumps(failed))
        self.assertNotIn("/private/path", json.dumps(failed))

    def test_default_runtime_fails_run_one_closed_without_consuming_job(self):
        with _temporary_directory() as directory:
            runtime = build_submit_status_runtime(
                Path(directory),
                uuid_factory=lambda: JOB_ID,
                clock=lambda: NOW,
            )
            try:
                dispatch(_submit_request(), runtime=runtime)
                with self.assertRaises(ReplayRuntimeUnavailableError):
                    dispatch(_job_request("run_one"), runtime=runtime)
                status = dispatch(_job_request("status"), runtime=runtime)
            finally:
                runtime.close()
        self.assertEqual(status["result"]["job"]["status"], "queued")

    def test_run_one_rejects_non_terminal_worker_and_durable_states(self):
        with _temporary_directory() as directory:
            runtime = _runtime(Path(directory) / JOB_STORE_FILENAME)
            try:
                dispatch(_submit_request(), runtime=runtime)
                queued = runtime.status(str(JOB_ID))

                runtime._worker = ReturningWorker(queued)
                with self.assertRaises(ReplayWorkerProtocolError):
                    dispatch(_job_request("run_one"), runtime=runtime)
                self.assertEqual(runtime.status(str(JOB_ID)).status, "queued")

                runtime._worker = ReturningWorker({"status": "completed"})
                with self.assertRaises(ReplayWorkerProtocolError):
                    dispatch(_job_request("run_one"), runtime=runtime)
                self.assertEqual(runtime.status(str(JOB_ID)).status, "queued")

                runtime._worker = ReturningWorker(queued.running(NOW))
                with self.assertRaises(ReplayWorkerProtocolError):
                    dispatch(_job_request("run_one"), runtime=runtime)
                self.assertEqual(runtime.status(str(JOB_ID)).status, "queued")

                unpersisted_terminal = queued.completed(
                    ReplayResult(SNAPSHOT_ID, "f" * 64), NOW
                )
                runtime._worker = ReturningWorker(unpersisted_terminal)
                with self.assertRaises(ReplayWorkerProtocolError):
                    dispatch(_job_request("run_one"), runtime=runtime)
                self.assertEqual(runtime.status(str(JOB_ID)).status, "queued")

                running = runtime._service._job_store.transition(
                    str(JOB_ID), "queued", queued.running(NOW)
                )
                runtime._worker = ReturningWorker(
                    running.completed(ReplayResult(SNAPSHOT_ID, "f" * 64), NOW)
                )
                with self.assertRaises(ReplayWorkerProtocolError):
                    dispatch(_job_request("run_one"), runtime=runtime)
                self.assertEqual(runtime.status(str(JOB_ID)).status, "running")
            finally:
                runtime.close()

    def test_non_terminal_worker_is_generic_protocol_failure_not_success(self):
        with _temporary_directory() as directory:
            path = Path(directory) / JOB_STORE_FILENAME
            runtime = _runtime(path)
            dispatch(_submit_request(), runtime=runtime)
            runtime._worker = ReturningWorker(runtime.status(str(JOB_ID)))
            stdin = BinaryStream(json.dumps(_job_request("run_one")).encode("utf-8"))
            stdout = BinaryStream()
            stderr = BinaryStream()
            with patch("ai.replay.cli.sys.stdin", stdin):
                with patch("ai.replay.cli.sys.stdout", stdout):
                    with patch("ai.replay.cli.sys.stderr", stderr):
                        exit_code = main(runtime_factory=lambda: runtime)

            self.assertEqual(exit_code, 4)
            self.assertEqual(stdout.buffer.getvalue(), b"")
            self.assertEqual(
                json.loads(stderr.buffer.getvalue()), _error("INTERNAL_ERROR")
            )

            recovered = _runtime(path)
            try:
                self.assertEqual(recovered.status(str(JOB_ID)).status, "queued")
            finally:
                recovered.close()

    def test_exact_request_keys_types_protocol_operation_and_uuid(self):
        def must_not_build():
            raise AssertionError("invalid request reached runtime construction")

        cases = (
            ({}, "INVALID_PROTOCOL"),
            ({"protocol_version": PROTOCOL_VERSION}, "INVALID_OPERATION"),
            (
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "op": "unknown",
                },
                "INVALID_OPERATION",
            ),
            (
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "op": [],
                },
                "INVALID_OPERATION",
            ),
            (
                {**_submit_request(), "extra": True},
                "INVALID_REQUEST",
            ),
            (
                {
                    **_submit_request(),
                    "pins": {**_submit_request()["pins"], "extra": "x"},
                },
                "INVALID_REQUEST",
            ),
            (
                {**_submit_request(), "pins": []},
                "INVALID_REQUEST",
            ),
            (
                {**_submit_request(), "pins": {key: 1 for key in PIN_KEYS}},
                "INVALID_REQUEST",
            ),
            (_job_request("status", "not-a-uuid"), "INVALID_REQUEST"),
            (
                _job_request("status", "12345678-1234-1234-8234-567812345678"),
                "INVALID_REQUEST",
            ),
        )
        for request, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(ReplayCliError) as raised:
                    dispatch(request, runtime_factory=must_not_build)
                self.assertEqual(raised.exception.code, code)

    def test_semantically_invalid_pins_use_domain_error(self):
        with _temporary_directory() as directory:
            runtime = _runtime(Path(directory) / JOB_STORE_FILENAME)
            try:
                with self.assertRaises(ReplayPinsError):
                    dispatch(
                        _submit_request(_pins(profile="custom")),
                        runtime=runtime,
                    )
            finally:
                runtime.close()

    def test_runtime_directory_matches_atomic_store_owner_and_mode_boundary(self):
        with _temporary_directory() as directory:
            secure = Path(directory) / "secure"
            secure.mkdir(mode=0o700)
            runtime = build_runtime_from_environment({RUNTIME_DIR_ENV: str(secure)})
            runtime.close()
            self.assertTrue((secure / JOB_STORE_FILENAME).is_file())

            for mode in (0o750, 0o755):
                allowed = Path(directory) / ("allowed-" + oct(mode))
                allowed.mkdir(mode=mode)
                os.chmod(allowed, mode)
                runtime = build_runtime_from_environment(
                    {RUNTIME_DIR_ENV: str(allowed)}
                )
                runtime.close()
                self.assertTrue((allowed / JOB_STORE_FILENAME).is_file())

            for mode in (0o770, 0o777):
                unsafe = Path(directory) / ("unsafe-" + oct(mode))
                unsafe.mkdir(mode=mode)
                os.chmod(unsafe, mode)
                with self.assertRaises(ReplayRuntimeConfigurationError):
                    build_runtime_from_environment({RUNTIME_DIR_ENV: str(unsafe)})
            with self.assertRaises(ReplayRuntimeConfigurationError):
                build_runtime_from_environment({})
            with self.assertRaises(ReplayRuntimeConfigurationError):
                build_runtime_from_environment({RUNTIME_DIR_ENV: "relative/runtime"})

            redirected = Path(directory) / "redirected"
            redirected.symlink_to(secure, target_is_directory=True)
            with self.assertRaises(ReplayRuntimeConfigurationError):
                build_runtime_from_environment({RUNTIME_DIR_ENV: str(redirected)})

    def test_success_output_cap_and_ascii_bounded_public_errors(self):
        self.assertEqual(set(ERROR_EXIT_CODES), set(PUBLIC_ERROR_MESSAGES))
        self.assertEqual(
            set(_error("INVALID_JSON")), {"protocol_version", "ok", "error"}
        )
        success = Buffer()
        with patch("ai.replay.cli.MAX_OUTPUT_BYTES", 1):
            with self.assertRaises(ReplayCliError) as raised:
                _write_success(success, {"ok": True})
        self.assertEqual(raised.exception.code, "OUTPUT_TOO_LARGE")
        self.assertEqual(success.value, b"")

        failure = Buffer()
        _write_error(failure, "NOT_PUBLIC")
        parsed = json.loads(failure.value)
        self.assertEqual(parsed, _error("INTERNAL_ERROR"))
        self.assertLessEqual(len(failure.value), 4096)
        self.assertTrue(failure.value.isascii())

    def test_job_store_files_are_owner_only(self):
        with _temporary_directory() as directory:
            runtime = build_submit_status_runtime(
                Path(directory),
                uuid_factory=lambda: JOB_ID,
                clock=lambda: NOW,
            )
            try:
                dispatch(_submit_request(), runtime=runtime)
            finally:
                runtime.close()
            for name in (JOB_STORE_FILENAME, JOB_STORE_FILENAME + ".lock"):
                mode = stat.S_IMODE(os.stat(Path(directory) / name).st_mode)
                self.assertEqual(mode, 0o600)


if __name__ == "__main__":
    unittest.main()
