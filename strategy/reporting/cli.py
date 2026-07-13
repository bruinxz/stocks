"""Strict JSON stdin/stdout boundary for the Tab 6/7 projection SOT."""

import json
import sys
from typing import Any, Dict, Mapping

from strategy.reporting.tab67_projection import (
    ProjectionContractError,
    project_daily_report,
    project_report_history,
)


MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
PROTOCOL_VERSION = "1.0.0"
REQUEST_KEYS = {
    "daily": frozenset(("protocol_version", "op", "envelope")),
    "history": frozenset(
        (
            "protocol_version",
            "op",
            "envelopes",
            "query",
            "profile",
            "market_scope",
            "from_day",
            "to_day",
        )
    ),
}
HISTORY_REQUIRED_KEYS = frozenset(("protocol_version", "op", "envelopes"))
PUBLIC_ERROR_MESSAGES = {
    "INPUT_TOO_LARGE": "input too large",
    "INVALID_JSON": "invalid JSON input",
    "INVALID_PROTOCOL": "invalid projection protocol",
    "INVALID_OPERATION": "unsupported projection op",
    "INVALID_REQUEST": "invalid projection request",
    "CONTRACT_ERROR": "projection contract rejected input",
    "OUTPUT_TOO_LARGE": "projection output too large",
    "INVALID_OUTPUT": "projection output is invalid",
    "INTERNAL_ERROR": "projection failed",
}


class ProjectionCliError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _strict_keys(
    request: Mapping[str, Any],
    allowed: frozenset,
    required: frozenset,
) -> None:
    actual = frozenset(request)
    missing = sorted(required - actual)
    extra = sorted(actual - allowed)
    if missing or extra:
        raise ProjectionCliError(
            "INVALID_REQUEST",
            "request key mismatch missing={} extra={}".format(missing, extra),
        )


def dispatch(request: Any) -> Dict[str, Any]:
    if not isinstance(request, Mapping):
        raise ProjectionCliError("INVALID_REQUEST", "request must be an object")
    if request.get("protocol_version") != PROTOCOL_VERSION:
        raise ProjectionCliError(
            "INVALID_PROTOCOL",
            "protocol_version must equal {}".format(PROTOCOL_VERSION),
        )
    op = request.get("op")
    if op not in REQUEST_KEYS:
        raise ProjectionCliError("INVALID_OPERATION", "unsupported projection op")

    if op == "daily":
        _strict_keys(request, REQUEST_KEYS[op], REQUEST_KEYS[op])
        return {
            "protocol_version": PROTOCOL_VERSION,
            "ok": True,
            "result": project_daily_report(request["envelope"]),
        }

    _strict_keys(request, REQUEST_KEYS[op], HISTORY_REQUIRED_KEYS)
    envelopes = request["envelopes"]
    if not isinstance(envelopes, list):
        raise ProjectionCliError(
            "INVALID_REQUEST", "history envelopes must be an array"
        )
    return {
        "protocol_version": PROTOCOL_VERSION,
        "ok": True,
        "result": project_report_history(
            envelopes,
            query=request.get("query"),
            profile=request.get("profile"),
            market_scope=request.get("market_scope"),
            from_day=request.get("from_day"),
            to_day=request.get("to_day"),
        ),
    }


def _write_json(stream, value: Mapping[str, Any]) -> None:
    encoded = _encode_json(value, ensure_ascii=False)
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise ProjectionCliError("OUTPUT_TOO_LARGE", "projection output too large")
    stream.buffer.write(encoded)
    stream.flush()


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
        raise ProjectionCliError(
            "INVALID_OUTPUT", "projection output is not valid JSON"
        ) from error


def _write_error(stream, value: Mapping[str, Any]) -> None:
    """Always emit bounded ASCII JSON; never serialize attacker text directly."""

    try:
        error = value.get("error") if isinstance(value, Mapping) else None
        code = error.get("code") if isinstance(error, Mapping) else None
        if code not in PUBLIC_ERROR_MESSAGES:
            code = "INTERNAL_ERROR"
        safe = _error(code, PUBLIC_ERROR_MESSAGES[code])
        encoded = _encode_json(safe, ensure_ascii=True)
        if len(encoded) > 4096:
            encoded = _encode_json(
                _error("INTERNAL_ERROR", "projection failed"),
                ensure_ascii=True,
            )
    except ProjectionCliError:
        encoded = (
            '{"error":{"code":"INTERNAL_ERROR","message":"projection failed"},'
            '"ok":false,"protocol_version":"1.0.0"}\n'
        ).encode("ascii")
    stream.buffer.write(encoded)
    stream.flush()


def _reject_constant(value: str):
    raise ProjectionCliError(
        "INVALID_JSON", "non-standard JSON constant is forbidden"
    )


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ProjectionCliError(
                "INVALID_JSON", "duplicate JSON object key is forbidden"
            )
        value[key] = item
    return value


def _error(code: str, message: str) -> Dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "ok": False,
        "error": {"code": code, "message": message},
    }


def _validate_unicode_tree(value: Any, path: str = "$") -> None:
    """Reject lone UTF-16 surrogates recursively in keys and values."""

    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise ProjectionCliError(
                "INVALID_JSON", "input contains an unpaired Unicode surrogate"
            )
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            _validate_unicode_tree(key, path + ".<key>")
            _validate_unicode_tree(item, path + "." + str(key))
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_unicode_tree(item, "{}[{}]".format(path, index))


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        _write_error(
            sys.stderr,
            _error("INPUT_TOO_LARGE", "input too large"),
        )
        return 2
    try:
        request = json.loads(
            raw.decode("utf-8"),
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
        _validate_unicode_tree(request)
        response = dispatch(request)
        _write_json(sys.stdout, response)
        return 0
    except (UnicodeDecodeError, json.JSONDecodeError):
        _write_error(
            sys.stderr,
            _error("INVALID_JSON", "invalid JSON input"),
        )
        return 2
    except ProjectionContractError as error:
        _write_error(
            sys.stderr,
            _error("CONTRACT_ERROR", "projection contract rejected input"),
        )
        return 3
    except ProjectionCliError as error:
        _write_error(
            sys.stderr,
            _error(error.code, str(error)[:1000]),
        )
        return 2
    except Exception:
        _write_error(
            sys.stderr,
            _error("INTERNAL_ERROR", "projection failed"),
        )
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
