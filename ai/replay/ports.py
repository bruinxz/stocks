from __future__ import annotations

from typing import Optional, Protocol

from ai.replay.types import (
    ReplayInputs,
    ReplayJob,
    ReplayPins,
    ReplayResult,
    SourceSlice,
)


class SignalSource(Protocol):
    def load_signals(self, pins: ReplayPins) -> SourceSlice:
        ...


class UniverseSource(Protocol):
    def load_universe(self, pins: ReplayPins) -> SourceSlice:
        ...


class StrategyScoreSource(Protocol):
    def load_scores(self, pins: ReplayPins) -> SourceSlice:
        ...


class EvidenceCache(Protocol):
    def load_evidence(self, pins: ReplayPins) -> SourceSlice:
        ...


class RecommendationReplayPipeline(Protocol):
    def run(self, pins: ReplayPins, inputs: ReplayInputs) -> ReplayResult:
        ...


class ReplayJobStore(Protocol):
    """Atomic persistence port; concrete DB wiring is outside contract-first B4."""

    def create_or_get(self, job: ReplayJob) -> tuple[ReplayJob, bool]:
        ...

    def get(self, job_id: str) -> Optional[ReplayJob]:
        ...

    def transition(
        self, job_id: str, expected_status: str, updated: ReplayJob
    ) -> ReplayJob:
        ...
