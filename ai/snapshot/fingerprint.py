import hashlib
import json
import math
import re
import uuid
from copy import deepcopy
from typing import Any


_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class JCSCanonicalizationError(ValueError):
    """Raised when a value cannot be represented by RFC 8785 / I-JSON."""


def jcs_canonicalize(obj: Any) -> str:
    """Serialize the supported I-JSON domain using RFC 8785 canonical form."""
    return _encode_jcs(obj, set())


def _encode_jcs(value: Any, active_containers: set[int]) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        _validate_unicode(value)
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        if abs(value) > _MAX_SAFE_INTEGER:
            raise JCSCanonicalizationError(
                "integer exceeds the exact IEEE-754 safe range"
            )
        return str(value)
    if isinstance(value, float):
        return _serialize_number(value)
    if isinstance(value, (list, tuple)):
        return _encode_container(
            value,
            active_containers,
            lambda: "[" + ",".join(
                _encode_jcs(item, active_containers) for item in value
            ) + "]",
        )
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise JCSCanonicalizationError("JSON object keys must be strings")
            _validate_unicode(key)

        def encode_object() -> str:
            keys = sorted(value, key=_utf16_sort_key)
            return "{" + ",".join(
                _encode_jcs(key, active_containers)
                + ":"
                + _encode_jcs(value[key], active_containers)
                for key in keys
            ) + "}"

        return _encode_container(value, active_containers, encode_object)
    raise JCSCanonicalizationError(
        f"unsupported JSON value type: {type(value).__name__}"
    )


def _encode_container(value, active_containers, encoder) -> str:
    identity = id(value)
    if identity in active_containers:
        raise JCSCanonicalizationError("cyclic JSON value")
    active_containers.add(identity)
    try:
        return encoder()
    finally:
        active_containers.remove(identity)


def _validate_unicode(value: str) -> None:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise JCSCanonicalizationError(
            "lone Unicode surrogate is not valid I-JSON"
        ) from error


def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16be")


def _serialize_number(value: float) -> str:
    if not math.isfinite(value):
        raise JCSCanonicalizationError("non-finite JSON number")
    if value == 0:
        return "0"

    rendered = repr(value).lower()
    if "e" not in rendered:
        return rendered[:-2] if rendered.endswith(".0") else rendered

    mantissa, exponent_text = rendered.split("e")
    exponent = int(exponent_text)
    negative = mantissa.startswith("-")
    unsigned_mantissa = mantissa.removeprefix("-")
    digits = unsigned_mantissa.replace(".", "")

    # ECMAScript JSON.stringify uses fixed notation for exponents -6..20.
    if -6 <= exponent < 21:
        decimal_position = 1 + exponent
        if decimal_position <= 0:
            body = "0." + ("0" * -decimal_position) + digits
        elif decimal_position >= len(digits):
            body = digits + ("0" * (decimal_position - len(digits)))
        else:
            body = digits[:decimal_position] + "." + digits[decimal_position:]
        return ("-" if negative else "") + body

    normalized_mantissa = (
        unsigned_mantissa[:-2]
        if unsigned_mantissa.endswith(".0")
        else unsigned_mantissa
    )
    exponent_rendered = f"+{exponent}" if exponent >= 0 else str(exponent)
    return (
        ("-" if negative else "")
        + normalized_mantissa
        + "e"
        + exponent_rendered
    )


def compute_input_fingerprint(input_hashes: list[str]) -> str:
    if not isinstance(input_hashes, (list, tuple)) or not input_hashes:
        raise JCSCanonicalizationError(
            "input hash manifest must be a non-empty array"
        )
    if any(
        isinstance(value, bool)
        or not isinstance(value, str)
        or not _SHA256_RE.fullmatch(value)
        for value in input_hashes
    ):
        raise JCSCanonicalizationError(
            "input hashes must be lowercase SHA-256 strings"
        )
    if len(set(input_hashes)) != len(input_hashes):
        raise JCSCanonicalizationError("input hash manifest contains duplicates")
    manifest = sorted(input_hashes)
    canonical = jcs_canonicalize(manifest)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def canonicalize_output_fingerprint_preimage(
    recommendation_list: dict,
) -> str:
    """Validate and return the strict RFC 8785 semantic-envelope preimage."""
    if not isinstance(recommendation_list, dict):
        raise JCSCanonicalizationError("RecommendationList must be an object")
    semantic = deepcopy(recommendation_list)
    top_snapshot_id = semantic.get("snapshot_id")
    _require_uuidv4(top_snapshot_id, "RecommendationList.snapshot_id")
    semantic.pop("output_fingerprint", None)
    semantic.pop("snapshot_id", None)

    meta = semantic.get("meta")
    if not isinstance(meta, dict):
        raise JCSCanonicalizationError("RecommendationList.meta must be an object")
    generated_by = meta.get("generated_by")
    generation_ms = meta.get("generation_ms")
    if not isinstance(generated_by, str) or not generated_by:
        raise JCSCanonicalizationError(
            "RecommendationList.meta.generated_by must be non-empty"
        )
    if (
        isinstance(generation_ms, bool)
        or not isinstance(generation_ms, (int, float))
        or not math.isfinite(generation_ms)
        or generation_ms < 0
    ):
        raise JCSCanonicalizationError(
            "RecommendationList.meta.generation_ms must be finite and non-negative"
        )
    meta.pop("generated_by", None)
    meta.pop("generation_ms", None)

    items = semantic.get("items")
    if not isinstance(items, list):
        raise JCSCanonicalizationError("RecommendationList.items must be an array")
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise JCSCanonicalizationError(f"items[{index}] must be an object")
        recommendation = item.get("recommendation")
        if not isinstance(recommendation, dict):
            raise JCSCanonicalizationError(
                f"items[{index}].recommendation must be an object"
            )
        recommendation_id = recommendation.get("id")
        recommendation_snapshot_id = recommendation.get("snapshot_id")
        _require_uuidv4(
            recommendation_id, f"items[{index}].recommendation.id"
        )
        _require_uuidv4(
            recommendation_snapshot_id,
            f"items[{index}].recommendation.snapshot_id",
        )
        if recommendation_snapshot_id != top_snapshot_id:
            raise JCSCanonicalizationError(
                f"items[{index}].recommendation.snapshot_id mismatch"
            )
        recommendation.pop("id", None)
        recommendation.pop("snapshot_id", None)

    return jcs_canonicalize(semantic)


def compute_output_fingerprint(recommendation_list: dict) -> str:
    """SHA-256 the exact UTF-8 semantic-envelope preimage."""
    canonical = canonicalize_output_fingerprint_preimage(recommendation_list)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _require_uuidv4(value: object, field: str) -> None:
    try:
        parsed = uuid.UUID(value)
    except (AttributeError, TypeError, ValueError) as error:
        raise JCSCanonicalizationError(f"{field} must be UUIDv4") from error
    if parsed.version != 4 or str(parsed) != value:
        raise JCSCanonicalizationError(f"{field} must be canonical UUIDv4")
