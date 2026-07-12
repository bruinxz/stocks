from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Optional, Protocol, Sequence


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
    risk_gate: str
    size_hint_tier: str


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
