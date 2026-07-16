"""Immutable normalized records shared by Sprint 3 source adapters and writers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
import re
from typing import List, Literal, Mapping, Union

JsonScalar = Union[str, int, float, bool, None]
JsonValue = Union[JsonScalar, List["JsonValue"], Mapping[str, "JsonValue"]]

MarketScope = Literal["cn_a", "us", "jp", "kr"]
MultibaggerRecordKind = Literal[
    "NEW_LISTING",
    "LIFECYCLE",
    "DAILY",
    "FRENCH_AGGREGATE",
    "TEXT_HIT",
]

_SOURCE_VERSION_RE = re.compile(r"^[!-~]+$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def is_canonical_source_version(value: object) -> bool:
    """Return whether value is an exact non-empty printable-ASCII token."""

    return type(value) is str and _SOURCE_VERSION_RE.fullmatch(value) is not None


def is_canonical_sha256(value: object) -> bool:
    """Return whether value is an exact lowercase SHA-256 hex digest."""

    return type(value) is str and _SHA256_RE.fullmatch(value) is not None


@dataclass(frozen=True)
class MultibaggerSourceRecord:
    """Lossless append-only fact emitted by a multibagger source adapter.

    ``effective_at_utc`` is the economic timestamp. ``available_at_utc`` is
    when the fact became legally observable. Writers reject a fact whose
    availability exceeds its run ``as_of_utc``.
    """

    market: Literal["CN", "US", "JP", "KR"]
    market_scope: MarketScope
    exchange: str
    ticker: str
    record_kind: MultibaggerRecordKind
    source_kind: str
    source_document_id: str
    source_version: str
    effective_at_utc: datetime
    available_at_utc: datetime
    as_of_utc: datetime
    features: Mapping[str, JsonValue]
    evidence_refs: tuple[str, ...]
    fact_hash: str

    def __post_init__(self) -> None:
        expected_scope = {
            "CN": "cn_a",
            "US": "us",
            "JP": "jp",
            "KR": "kr",
        }[self.market]
        if self.market_scope != expected_scope:
            raise ValueError("market and market_scope must use the canonical mapping")
        if self.available_at_utc > self.as_of_utc:
            raise ValueError("available_at_utc must not exceed as_of_utc")
        if not self.source_document_id:
            raise ValueError("source document identity is required")
        if not is_canonical_source_version(self.source_version):
            raise ValueError("source_version must be a printable ASCII token")
        if not is_canonical_sha256(self.fact_hash):
            raise ValueError("fact_hash must be lowercase SHA-256 hex")


@dataclass(frozen=True)
class FxObservation:
    """Official daily FX fact with explicit reciprocal and change lineage."""

    pair: Literal["USDJPY", "USDKRW"]
    observation_day: date
    available_at_utc: datetime
    local_per_usd: Decimal
    usd_per_local: Decimal
    change_pct: Decimal | None
    source_kind: Literal["BOJ", "BOK"]
    source_document_id: str
    source_version: str
    fact_hash: str
    previous_observation_day: date | None = None
    previous_source_kind: Literal["BOJ", "BOK"] | None = None
    previous_source_version: str | None = None
    previous_fact_hash: str | None = None

    def __post_init__(self) -> None:
        expected_source = {"USDJPY": "BOJ", "USDKRW": "BOK"}[self.pair]
        if self.source_kind != expected_source:
            raise ValueError("pair and source_kind must use the frozen provider mapping")
        if not is_canonical_source_version(self.source_version):
            raise ValueError("source_version must be a printable ASCII token")
        if self.local_per_usd <= 0 or self.usd_per_local <= 0:
            raise ValueError("FX rates must be positive")
        if abs((self.local_per_usd * self.usd_per_local) - Decimal(1)) > Decimal(
            "0.00000001"
        ):
            raise ValueError("FX reciprocal exceeds tolerance")
        previous = (
            self.previous_observation_day,
            self.previous_source_kind,
            self.previous_source_version,
            self.previous_fact_hash,
        )
        if self.previous_source_version is not None and not is_canonical_source_version(
            self.previous_source_version
        ):
            raise ValueError(
                "previous_source_version must be a printable ASCII token"
            )
        if self.change_pct is None:
            if any(value is not None for value in previous):
                raise ValueError("previous lineage requires change_pct")
        elif (
            any(value is None for value in previous)
            or self.previous_observation_day >= self.observation_day
            or self.previous_source_kind != self.source_kind
        ):
            raise ValueError("change_pct requires complete earlier-observation lineage")
        for digest in (self.fact_hash, self.previous_fact_hash):
            if digest is not None and not is_canonical_sha256(digest):
                raise ValueError("fact hashes must be lowercase SHA-256 hex")
