from __future__ import annotations

import hashlib
import re
import uuid
from contextlib import AbstractContextManager
from dataclasses import dataclass, fields
from typing import Any, Optional, Protocol, Sequence

from ai.snapshot.fingerprint import jcs_canonicalize


PROFILE_MARKET_SCOPES = {
    "us_preferred": frozenset({"us", "cn_a"}),
    "multibagger": frozenset({"us", "cn_a"}),
    "japan_blue_chip": frozenset({"jp"}),
    "japan_multibagger": frozenset({"jp"}),
    "korea_semiconductor_chain": frozenset({"kr"}),
    "korea_multibagger": frozenset({"kr"}),
}
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TRADING_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


@dataclass(frozen=True)
class SnapshotRow:
    snapshot_id: str
    as_of_utc: str
    trading_day: str
    profile: str
    market_scope: str
    contract_version: str
    profile_version: str
    pipeline_version: str
    model_version: str
    strategy_version: str
    rule_bundle_hash: str
    template_hash: str
    disclaimer_hash: str
    input_fingerprint: str
    output_fingerprint: str
    fingerprint_preimage_jcs: str
    idempotency_key: str
    item_count: int
    envelope_json: dict[str, Any]


@dataclass(frozen=True)
class SnapshotItemRow:
    item_id: str
    snapshot_id: str
    ticker: str
    sort_rank: int
    recommendation_json: dict
    recommendation_jcs: str
    recommendation_hash: str
    rating_band: str
    conviction_final: float
    risk_gate_status: str
    size_hint_tier: str


SNAPSHOT_SCALAR_FIELDS = tuple(
    field.name for field in fields(SnapshotRow) if field.name != "envelope_json"
)


def snapshot_scalar_mismatches(
    expected: SnapshotRow, actual: SnapshotRow
) -> tuple[str, ...]:
    return tuple(
        field
        for field in SNAPSHOT_SCALAR_FIELDS
        if getattr(expected, field) != getattr(actual, field)
    )


def snapshot_idempotency_material(snapshot: SnapshotRow) -> dict[str, Any]:
    return {
        "as_of": snapshot.as_of_utc,
        "trading_day": snapshot.trading_day,
        "profile": snapshot.profile,
        "market_scope": snapshot.market_scope,
        "contract_version": snapshot.contract_version,
        "profile_version": snapshot.profile_version,
        "pipeline_version": snapshot.pipeline_version,
        "model_version": snapshot.model_version,
        "strategy_version": snapshot.strategy_version,
        "rule_bundle_hash": snapshot.rule_bundle_hash,
        "template_hash": snapshot.template_hash,
        "disclaimer_hash": snapshot.disclaimer_hash,
        "input_fingerprint": snapshot.input_fingerprint,
    }


def compute_snapshot_idempotency_key(snapshot: SnapshotRow) -> str:
    canonical = jcs_canonicalize(snapshot_idempotency_material(snapshot))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def snapshot_row_integrity_errors(snapshot: SnapshotRow) -> tuple[str, ...]:
    errors = []
    try:
        parsed = uuid.UUID(snapshot.snapshot_id)
    except (AttributeError, TypeError, ValueError):
        parsed = None
    if (
        parsed is None
        or parsed.version != 4
        or str(parsed) != snapshot.snapshot_id
    ):
        errors.append("snapshot_id")
    if not isinstance(snapshot.as_of_utc, str) or not snapshot.as_of_utc:
        errors.append("as_of_utc")
    if (
        not isinstance(snapshot.trading_day, str)
        or not _TRADING_DAY_RE.fullmatch(snapshot.trading_day)
    ):
        errors.append("trading_day")
    if (
        snapshot.profile not in PROFILE_MARKET_SCOPES
        or snapshot.market_scope not in PROFILE_MARKET_SCOPES[snapshot.profile]
    ):
        errors.append("profile/market_scope")
    if snapshot.contract_version != "0.3.1":
        errors.append("contract_version")
    for field in (
        "profile_version",
        "pipeline_version",
        "model_version",
        "strategy_version",
    ):
        value = getattr(snapshot, field)
        if not isinstance(value, str) or not _SEMVER_RE.fullmatch(value):
            errors.append(field)
    for field in (
        "rule_bundle_hash",
        "template_hash",
        "disclaimer_hash",
        "input_fingerprint",
        "output_fingerprint",
        "idempotency_key",
    ):
        value = getattr(snapshot, field)
        if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
            errors.append(field)
    if not isinstance(snapshot.fingerprint_preimage_jcs, str):
        errors.append("fingerprint_preimage_jcs")
    elif hashlib.sha256(
        snapshot.fingerprint_preimage_jcs.encode("utf-8")
    ).hexdigest() != snapshot.output_fingerprint:
        errors.append("fingerprint_preimage_jcs/output_fingerprint")
    if (
        isinstance(snapshot.item_count, bool)
        or not isinstance(snapshot.item_count, int)
        or snapshot.item_count < 0
    ):
        errors.append("item_count")
    try:
        expected_idempotency = compute_snapshot_idempotency_key(snapshot)
    except (TypeError, ValueError):
        expected_idempotency = None
    if expected_idempotency != snapshot.idempotency_key:
        errors.append("idempotency_key/material")
    return tuple(errors)


class SnapshotTransaction(Protocol):
    def find_snapshot_by_idempotency_key(
        self, idempotency_key: str
    ) -> Optional[SnapshotRow]:
        ...

    def get_items(self, snapshot_id: str) -> Sequence[SnapshotItemRow]:
        ...

    def insert_snapshot(self, snapshot: SnapshotRow) -> None:
        ...

    def insert_items(self, items: Sequence[SnapshotItemRow]) -> None:
        ...


class SnapshotStore(Protocol):
    """Storage port implemented by the Phase B1 physical persistence adapter."""

    def transaction(self) -> AbstractContextManager[SnapshotTransaction]:
        ...

    def get_snapshot(self, snapshot_id: str) -> Optional[SnapshotRow]:
        ...

    def get_items(self, snapshot_id: str) -> Sequence[SnapshotItemRow]:
        ...

    def list_snapshots(
        self,
        *,
        profile: str,
        market_scope: str,
        trading_day: Optional[str] = None,
    ) -> Sequence[SnapshotRow]:
        ...
