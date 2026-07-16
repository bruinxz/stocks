"""Versioned provenance envelope for bounded anonymous official-source captures."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import re
from typing import Any, Mapping
import uuid

from datapipeline.storage.multibagger.canonical_json import canonicalize_json

CAPTURE_SCHEMA_VERSION = "1.0.0"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_JPX_DAILY_SOURCE_RE = re.compile(
    r"^https://www[.]jpx[.]co[.]jp/english/markets/statistics-equities/"
    r"daily/[a-z0-9]+-att/stq_[0-9]{8}[.]pdf$"
)
_ALLOWED_SOURCES = {
    "BOJ": (
        "https://www.stat-search.boj.or.jp/ssi/mtshtml/csv/fm08_d_1_en.csv",
        "https://www.boj.or.jp/en/copyright.htm",
    ),
    "jpx-listed-company-monthly": (
        "https://www.jpx.co.jp/markets/statistics-equities/misc/"
        "tvdivq0000001vg2-att/data_j.xls",
        "https://www.jpx.co.jp/english/term-of-use/index.html",
    ),
    "jpx-daily-statistics-pdf": (
        "https://www.jpx.co.jp/english/markets/statistics-equities/daily/"
        "vk0khi000001vg1y-att/stq_20260710.pdf",
        "https://www.jpx.co.jp/english/term-of-use/index.html",
    ),
    "kind": (
        "https://kind.krx.co.kr/disclosure/todaydisclosure.do",
        "https://kind.krx.co.kr/",
    ),
}
_WRAPPER_KEYS = frozenset(
    {
        "capture_instance",
        "capture_schema_version",
        "captured_at_utc",
        "captured_response_sha256",
        "declared_live_row_count",
        "fixture_mode",
        "payload",
        "payload_sha256",
        "production_seed_allowed",
        "source_kind",
        "source_url",
        "terms_url",
        "wrapper_sha256",
    }
)


class CaptureProvenanceError(ValueError):
    pass


def _hash(value: object) -> str:
    return hashlib.sha256(canonicalize_json(value).encode("utf-8")).hexdigest()


def _canonical_utc(value: object) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise CaptureProvenanceError("captured_at_utc must be UTC seconds")
    try:
        parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise CaptureProvenanceError("captured_at_utc must be UTC seconds") from error
    if (
        parsed.tzinfo != timezone.utc
        or parsed.microsecond != 0
        or value != parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
    ):
        raise CaptureProvenanceError("captured_at_utc must be UTC seconds")
    return value


def _canonical_uuid4(value: object) -> str:
    try:
        parsed = uuid.UUID(value)
    except (AttributeError, TypeError, ValueError) as error:
        raise CaptureProvenanceError("capture_instance must be UUIDv4") from error
    if parsed.version != 4 or str(parsed) != value:
        raise CaptureProvenanceError("capture_instance must be UUIDv4")
    return value


def build_capture_wrapper(
    *,
    source_kind: str,
    source_url: str,
    terms_url: str,
    capture_instance: str,
    captured_at_utc: str,
    captured_response_sha256: str,
    declared_live_row_count: int,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    wrapper = {
        "capture_instance": _canonical_uuid4(capture_instance),
        "capture_schema_version": CAPTURE_SCHEMA_VERSION,
        "captured_at_utc": _canonical_utc(captured_at_utc),
        "captured_response_sha256": captured_response_sha256,
        "declared_live_row_count": declared_live_row_count,
        "fixture_mode": False,
        "payload": dict(payload),
        "payload_sha256": _hash(payload),
        "production_seed_allowed": False,
        "source_kind": source_kind,
        "source_url": source_url,
        "terms_url": terms_url,
    }
    wrapper["wrapper_sha256"] = _hash(wrapper)
    validate_capture_wrapper(wrapper, expected_source_kind=source_kind)
    return wrapper


def validate_capture_wrapper(
    wrapper: object,
    *,
    expected_source_kind: str,
) -> Mapping[str, Any]:
    if not isinstance(wrapper, Mapping) or set(wrapper) != _WRAPPER_KEYS:
        raise CaptureProvenanceError("capture wrapper keys are not exact")
    if wrapper["capture_schema_version"] != CAPTURE_SCHEMA_VERSION:
        raise CaptureProvenanceError("capture schema version is invalid")
    if wrapper["fixture_mode"] is not False:
        raise CaptureProvenanceError("real capture fixture_mode must be false")
    if wrapper["production_seed_allowed"] is not False:
        raise CaptureProvenanceError("real capture cannot seed production")
    if wrapper["source_kind"] != expected_source_kind:
        raise CaptureProvenanceError("capture source_kind mismatch")
    allowed = _ALLOWED_SOURCES.get(expected_source_kind)
    source_pair = (wrapper["source_url"], wrapper["terms_url"])
    rotating_jpx_daily_source = (
        expected_source_kind == "jpx-daily-statistics-pdf"
        and isinstance(wrapper["source_url"], str)
        and _JPX_DAILY_SOURCE_RE.fullmatch(wrapper["source_url"]) is not None
        and wrapper["terms_url"]
        == "https://www.jpx.co.jp/english/term-of-use/index.html"
    )
    if allowed is None or (source_pair != allowed and not rotating_jpx_daily_source):
        raise CaptureProvenanceError("capture source/terms URL is not allowlisted")
    _canonical_uuid4(wrapper["capture_instance"])
    _canonical_utc(wrapper["captured_at_utc"])
    if (
        not isinstance(wrapper["declared_live_row_count"], int)
        or isinstance(wrapper["declared_live_row_count"], bool)
        or wrapper["declared_live_row_count"] <= 0
    ):
        raise CaptureProvenanceError("declared live row count is invalid")
    for field in (
        "captured_response_sha256",
        "payload_sha256",
        "wrapper_sha256",
    ):
        if not isinstance(wrapper[field], str) or not _SHA256.fullmatch(wrapper[field]):
            raise CaptureProvenanceError(f"{field} must be lowercase SHA-256")
    payload = wrapper["payload"]
    if not isinstance(payload, Mapping):
        raise CaptureProvenanceError("capture payload must be an object")
    if _hash(payload) != wrapper["payload_sha256"]:
        raise CaptureProvenanceError("capture payload hash mismatch")
    unsigned = {key: wrapper[key] for key in wrapper if key != "wrapper_sha256"}
    if _hash(unsigned) != wrapper["wrapper_sha256"]:
        raise CaptureProvenanceError("capture wrapper hash mismatch")
    return payload


def capture_source_version(wrapper: Mapping[str, Any]) -> str:
    return ":".join(
        (
            CAPTURE_SCHEMA_VERSION,
            wrapper["capture_instance"],
            wrapper["captured_response_sha256"],
            wrapper["wrapper_sha256"],
        )
    )
