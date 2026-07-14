from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Literal, Mapping, Optional

from datapipeline.contracts.market_records import is_canonical_source_version


ReplayStatus = Literal["queued", "running", "completed", "failed"]
SourceKind = Literal["signals", "universe", "scores", "evidence"]


@dataclass(frozen=True)
class ReplayPins:
    trading_day: str
    as_of: str
    profile: str
    market_scope: str
    profile_version: str
    contract_version: str
    input_fingerprint: str
    strategy_version: str
    pipeline_version: str


@dataclass(frozen=True)
class SourceSlice:
    kind: SourceKind
    trading_day: str
    as_of: str
    profile: str
    market_scope: str
    source_version: str
    content_hash: str
    records: tuple[Mapping[str, Any], ...]


@dataclass(frozen=True)
class ReplayInputs:
    signals: SourceSlice
    universe: SourceSlice
    scores: SourceSlice
    evidence: SourceSlice

    def ordered(self) -> tuple[SourceSlice, ...]:
        return (self.signals, self.universe, self.scores, self.evidence)


@dataclass(frozen=True)
class ReplayResult:
    snapshot_id: str
    output_fingerprint: str


@dataclass(frozen=True)
class ReplayJob:
    job_id: str
    idempotency_key: str
    pins: ReplayPins
    status: ReplayStatus
    created_at: str
    updated_at: str
    snapshot_id: Optional[str] = None
    output_fingerprint: Optional[str] = None
    error_code: Optional[str] = None
    error_detail: Optional[str] = None

    def running(self, now: str) -> "ReplayJob":
        return replace(
            self,
            status="running",
            updated_at=now,
            error_code=None,
            error_detail=None,
        )

    def completed(self, result: ReplayResult, now: str) -> "ReplayJob":
        return replace(
            self,
            status="completed",
            updated_at=now,
            snapshot_id=result.snapshot_id,
            output_fingerprint=result.output_fingerprint,
            error_code=None,
            error_detail=None,
        )

    def failed(self, code: str, detail: str, now: str) -> "ReplayJob":
        return replace(
            self,
            status="failed",
            updated_at=now,
            snapshot_id=None,
            output_fingerprint=None,
            error_code=code,
            error_detail=detail,
        )
