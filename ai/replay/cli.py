"""Strict single-request JSON CLI for durable recommendation replay jobs.

``submit`` and ``status`` use the production ``ReplayService`` contract and
the atomic file job store.  The execution worker is an explicit dependency:
until the PostgreSQL typed-source repository and pipeline adapter are wired,
``run_one`` fails closed without changing a queued job.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import stat
import sys
from typing import Any, Callable, Mapping, Optional
import uuid

from ai.replay.file_store import (
    AtomicFileReplayJobStore,
    ReplayJobStoreConfigurationError,
    ReplayJobStoreCorruptError,
)
from ai.replay.ports import ReplayWorkerPort
from ai.replay.service import (
    ReplayConflictError,
    ReplayJobNotFoundError,
    ReplayPinsError,
    ReplayService,
    ReplayServiceError,
)
from ai.replay.types import ReplayJob, ReplayPins


PROTOCOL_VERSION = "1.0.0"
MAX_INPUT_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
MAX_ERROR_BYTES = 4096
RUNTIME_DIR_ENV = "STOCKS_REPLAY_RUNTIME_DIR"
JOB_STORE_FILENAME = "replay_jobs.json"

PIN_KEYS = frozenset(
    (
        "trading_day",
        "as_of",
        "profile",
        "market_scope",
        "profile_version",
        "contract_version",
        "input_fingerprint",
        "strategy_version",
        "pipeline_version",
    )
)
REQUEST_KEYS = {
    "submit": frozenset(("protocol_version", "op", "pins")),
    "status": frozenset(("protocol_version", "op", "job_id")),
    "run_one": frozenset(("protocol_version", "op", "job_id")),
}
PUBLIC_ERROR_MESSAGES = {
    "INPUT_TOO_LARGE": "replay request too large",
    "INVALID_JSON": "invalid replay request",
    "INVALID_PROTOCOL": "unsupported replay protocol",
    "INVALID_OPERATION": "unsupported replay operation",
    "INVALID_REQUEST": "invalid replay request",
    "INVALID_REPLAY_PINS": "invalid replay pins",
    "REPLAY_JOB_NOT_FOUND": "replay job not found",
    "REPLAY_CONFLICT": "replay job conflict",
    "REPLAY_RUNTIME_UNAVAILABLE": "replay runtime unavailable",
    "REPLAY_STORE_UNAVAILABLE": "replay job store unavailable",
    "OUTPUT_TOO_LARGE": "replay response too large",
    "INVALID_OUTPUT": "invalid replay response",
    "INTERNAL_ERROR": "replay failed",
}
ERROR_EXIT_CODES = {
    "INPUT_TOO_LARGE": 2,
    "INVALID_JSON": 2,
    "INVALID_PROTOCOL": 2,
    "INVALID_OPERATION": 2,
    "INVALID_REQUEST": 2,
    "INVALID_REPLAY_PINS": 3,
    "REPLAY_JOB_NOT_FOUND": 3,
    "REPLAY_CONFLICT": 3,
    "REPLAY_RUNTIME_UNAVAILABLE": 4,
    "REPLAY_STORE_UNAVAILABLE": 4,
    "OUTPUT_TOO_LARGE": 4,
    "INVALID_OUTPUT": 4,
    "INTERNAL_ERROR": 4,
}


class ReplayCliError(ValueError):
    def __init__(self, code: str):
        if code not in PUBLIC_ERROR_MESSAGES:
            code = "INTERNAL_ERROR"
        super().__init__(PUBLIC_ERROR_MESSAGES[code])
        self.code = code


class ReplayRuntimeUnavailableError(RuntimeError):
    pass


class ReplayRuntimeConfigurationError(RuntimeError):
    pass


class _UnavailableSource:
    """Constructor-only placeholder; execution is blocked before this port."""

    @staticmethod
    def _unavailable(_pins):
        raise ReplayRuntimeUnavailableError("replay source is not configured")

    load_signals = _unavailable
    load_universe = _unavailable
    load_scores = _unavailable
    load_evidence = _unavailable


class _UnavailablePipeline:
    @staticmethod
    def run(_pins, _inputs):
        raise ReplayRuntimeUnavailableError("replay pipeline is not configured")


class ReplayCliRuntime:
    """Protocol-facing dependency boundary for service and worker ports."""

    def __init__(
        self,
        *,
        service: ReplayService,
        worker: Optional[ReplayWorkerPort] = None,
        close: Optional[Callable[[], None]] = None,
    ):
        self._service = service
        self._worker = worker
        self._close = close

    def submit(self, pins: ReplayPins) -> ReplayJob:
        return self._service.submit(pins)

    def status(self, job_id: str) -> ReplayJob:
        return self._service.get(job_id)

    def run_one(self, job_id: str) -> ReplayJob:
        current = self._service.get(job_id)
        if current.status in {"completed", "failed"}:
            return current
        if self._worker is None:
            raise ReplayRuntimeUnavailableError(
                "concrete replay worker is not configured"
            )
        returned = self._worker.run_job(job_id)
        ReplayService._validate_job(returned)
        persisted = self._service.get(job_id)
        if returned != persisted:
            raise ReplayConflictError(
                "replay worker did not return the persisted job state"
            )
        return persisted

    def close(self) -> None:
        if self._close is not None:
            close, self._close = self._close, None
            close()


def build_submit_status_runtime(
    runtime_dir: Path,
    *,
    uuid_factory=None,
    clock=None,
) -> ReplayCliRuntime:
    """Build the durable CLI subset without pretending execution is wired."""

    _validate_runtime_directory(runtime_dir)
    store = AtomicFileReplayJobStore(runtime_dir / JOB_STORE_FILENAME)
    unavailable_source = _UnavailableSource()
    kwargs = {
        "signal_source": unavailable_source,
        "universe_source": unavailable_source,
        "score_source": unavailable_source,
        "evidence_cache": unavailable_source,
        "pipeline": _UnavailablePipeline(),
        "job_store": store,
    }
    if uuid_factory is not None:
        kwargs["uuid_factory"] = uuid_factory
    if clock is not None:
        kwargs["clock"] = clock
    try:
        service = ReplayService(**kwargs)
        return ReplayCliRuntime(service=service, close=store.close)
    except Exception:
        store.close()
        raise


def build_runtime_from_environment(
    environ: Optional[Mapping[str, str]] = None,
) -> ReplayCliRuntime:
    """Open only an explicitly provisioned, owner-only runtime directory."""

    values = os.environ if environ is None else environ
    raw = values.get(RUNTIME_DIR_ENV)
    if not isinstance(raw, str) or not raw:
        raise ReplayRuntimeConfigurationError(
            "replay runtime directory is not configured"
        )
    runtime_dir = Path(raw)
    _validate_runtime_directory(runtime_dir)
    return build_submit_status_runtime(runtime_dir)


def _validate_runtime_directory(runtime_dir: Path) -> None:
    if not runtime_dir.is_absolute() or ".." in runtime_dir.parts:
        raise ReplayRuntimeConfigurationError(
            "replay runtime directory must be an absolute normalized path"
        )
    try:
        metadata = os.lstat(runtime_dir)
    except OSError as error:
        raise ReplayRuntimeConfigurationError(
            "replay runtime directory is unavailable"
        ) from error
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise ReplayRuntimeConfigurationError(
            "replay runtime directory must be an owner-only directory"
        )


def dispatch(
    request: Any,
    *,
    runtime: Optional[ReplayCliRuntime] = None,
    runtime_factory: Callable[[], ReplayCliRuntime] = build_runtime_from_environment,
) -> dict[str, Any]:
    if not isinstance(request, Mapping):
        raise ReplayCliError("INVALID_REQUEST")
    if request.get("protocol_version") != PROTOCOL_VERSION:
        raise ReplayCliError("INVALID_PROTOCOL")
    op = request.get("op")
    if not isinstance(op, str) or op not in REQUEST_KEYS:
        raise ReplayCliError("INVALID_OPERATION")
    if frozenset(request) != REQUEST_KEYS[op]:
        raise ReplayCliError("INVALID_REQUEST")

    pins = None
    job_id = None
    if op == "submit":
        raw_pins = request.get("pins")
        if (
            not isinstance(raw_pins, Mapping)
            or frozenset(raw_pins) != PIN_KEYS
            or any(not isinstance(value, str) for value in raw_pins.values())
        ):
            raise ReplayCliError("INVALID_REQUEST")
        pins = ReplayPins(**raw_pins)
    else:
        job_id = request.get("job_id")
        if not _is_uuid_v4(job_id):
            raise ReplayCliError("INVALID_REQUEST")

    owned_runtime = runtime is None
    selected = runtime_factory() if runtime is None else runtime
    try:
        if op == "submit":
            job = selected.submit(pins)
        elif op == "status":
            job = selected.status(job_id)
        else:
            job = selected.run_one(job_id)
        return {
            "protocol_version": PROTOCOL_VERSION,
            "ok": True,
            "result": {"job": _job_payload(job)},
        }
    finally:
        if owned_runtime:
            selected.close()


def _job_payload(job: ReplayJob) -> dict[str, Any]:
    ReplayService._validate_job(job)
    payload: dict[str, Any] = {
        "job_id": job.job_id,
        "status": job.status,
    }
    if job.status == "completed":
        payload["snapshot_id"] = job.snapshot_id
    elif job.status == "failed":
        payload["error"] = "replay failed"
    return payload


def _is_uuid_v4(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value


def _reject_constant(_value: str):
    raise ReplayCliError("INVALID_JSON")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ReplayCliError("INVALID_JSON")
        value[key] = item
    return value


def _validate_json_tree(value: Any) -> None:
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise ReplayCliError("INVALID_JSON")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ReplayCliError("INVALID_JSON")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            _validate_json_tree(key)
            _validate_json_tree(item)
        return
    if isinstance(value, list):
        for item in value:
            _validate_json_tree(item)


def _encode_json(value: Mapping[str, Any], *, ensure_ascii: bool) -> bytes:
    try:
        return (
            json.dumps(
                value,
                ensure_ascii=ensure_ascii,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
        ).encode("ascii" if ensure_ascii else "utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        raise ReplayCliError("INVALID_OUTPUT") from error


def _write_success(stream, value: Mapping[str, Any]) -> None:
    encoded = _encode_json(value, ensure_ascii=False)
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise ReplayCliError("OUTPUT_TOO_LARGE")
    stream.buffer.write(encoded)
    stream.flush()


def _error(code: str) -> dict[str, Any]:
    if code not in PUBLIC_ERROR_MESSAGES:
        code = "INTERNAL_ERROR"
    return {
        "protocol_version": PROTOCOL_VERSION,
        "ok": False,
        "error": {
            "code": code,
            "message": PUBLIC_ERROR_MESSAGES[code],
        },
    }


def _write_error(stream, code: str) -> None:
    """Emit one bounded ASCII object without attacker-controlled text."""

    try:
        encoded = _encode_json(_error(code), ensure_ascii=True)
        if len(encoded) > MAX_ERROR_BYTES:
            encoded = _encode_json(_error("INTERNAL_ERROR"), ensure_ascii=True)
    except Exception:
        encoded = (
            '{"error":{"code":"INTERNAL_ERROR","message":"replay failed"},'
            '"ok":false,"protocol_version":"1.0.0"}\n'
        ).encode("ascii")
    stream.buffer.write(encoded)
    stream.flush()


def _exit_code(code: str) -> int:
    return ERROR_EXIT_CODES.get(code, ERROR_EXIT_CODES["INTERNAL_ERROR"])


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        _write_error(sys.stderr, "INPUT_TOO_LARGE")
        return 2
    try:
        request = json.loads(
            raw.decode("utf-8"),
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
        _validate_json_tree(request)
        response = dispatch(request)
        _write_success(sys.stdout, response)
        return 0
    except (UnicodeDecodeError, json.JSONDecodeError):
        code = "INVALID_JSON"
    except ReplayCliError as error:
        code = error.code
    except ReplayPinsError:
        code = "INVALID_REPLAY_PINS"
    except ReplayJobNotFoundError:
        code = "REPLAY_JOB_NOT_FOUND"
    except ReplayConflictError:
        code = "REPLAY_CONFLICT"
    except ReplayRuntimeUnavailableError:
        code = "REPLAY_RUNTIME_UNAVAILABLE"
    except (
        ReplayRuntimeConfigurationError,
        ReplayJobStoreConfigurationError,
        ReplayJobStoreCorruptError,
        OSError,
    ):
        code = "REPLAY_STORE_UNAVAILABLE"
    except ReplayServiceError:
        code = "INTERNAL_ERROR"
    except Exception:
        code = "INTERNAL_ERROR"
    _write_error(sys.stderr, code)
    return _exit_code(code)


if __name__ == "__main__":
    raise SystemExit(main())
