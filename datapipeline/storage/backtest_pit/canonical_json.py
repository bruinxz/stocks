"""Strict canonical I-JSON used by PIT writer hashes."""

from __future__ import annotations

from decimal import Decimal
import json
import math
from typing import Mapping

MAX_SAFE_INTEGER = 9007199254740991


def _string(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("JSON strings cannot contain unpaired surrogates") from error
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _number(value: object) -> str:
    if isinstance(value, bool):
        raise ValueError("boolean is not a JSON number")
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError("JSON integer exceeds the I-JSON safe range")
        return str(value)
    if not isinstance(value, float) or not math.isfinite(value):
        raise ValueError("JSON number must be finite")
    if value == 0:
        return "0"
    absolute = abs(value)
    text = repr(value).lower()
    if 1e-6 <= absolute < 1e21:
        fixed = format(Decimal(text), "f")
        return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    mantissa, exponent = text.split("e")
    if mantissa.endswith(".0"):
        mantissa = mantissa[:-2]
    exponent_value = int(exponent)
    sign = "+" if exponent_value >= 0 else ""
    return f"{mantissa}e{sign}{exponent_value}"


def _utf16_key(value: str) -> bytes:
    try:
        return value.encode("utf-16be")
    except UnicodeEncodeError as error:
        raise ValueError(
            "JSON object keys cannot contain unpaired surrogates"
        ) from error


def canonicalize_json(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        keys = list(value)
        if any(not isinstance(key, str) for key in keys):
            raise ValueError("JSON object keys must be strings")
        entries = [
            f"{_string(key)}:{canonicalize_json(value[key])}"
            for key in sorted(keys, key=_utf16_key)
        ]
        return "{" + ",".join(entries) + "}"
    raise ValueError(f"unsupported JSON value type: {type(value).__name__}")
