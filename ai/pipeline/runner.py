from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any
import uuid
import time

from ai.pipeline.context import PipelineContext
from ai.pipeline.stages.signal_intake import SignalIntakeStage
from ai.pipeline.stages.universe import UniverseStage
from ai.pipeline.stages.feature_assembly import FeatureAssemblyStage
from ai.pipeline.stages.rule_model import RuleModelStage
from ai.pipeline.stages.gating import GatingStage
from ai.pipeline.stages.assembly import AssemblyStage
from ai.pipeline.stages.publish import PublishStage
from ai.snapshot.writer import SnapshotStoreNotConfiguredError, SnapshotWriter
from ai.validation.output_validator import OutputValidator


@dataclass
class PipelineConfig:
    profile: str
    market_scope: str
    trading_day: str
    pipeline_version: str
    model_version: str
    strategy_version: str
    rule_bundle_hash: str
    template_hash: str
    disclaimer_hash: str
    contract_version: str
    profile_version: str
    disclaimer: dict[str, Any]
    input_hashes: tuple[str, ...]


@dataclass(frozen=True)
class PipelineSourceInputs:
    """Authenticated A/B/C-stage inputs supplied by a replay adapter.

    The ordinary runner still defaults to empty collections.  Production
    replay must pass one fully validated bundle so the three input stages do
    not perform independent reads and accidentally assemble a mixed snapshot.
    """

    signals: tuple[dict[str, Any], ...] = ()
    universe: tuple[str, ...] = ()
    scores: dict[str, dict[str, Any]] = field(default_factory=dict)
    evidence_refs: dict[str, tuple[dict[str, Any], ...]] = field(
        default_factory=dict
    )


class PipelineRunner:
    """7-stage pipeline: A→B→C→D→E→F→G(snapshot)→H(publish)."""

    def __init__(
        self,
        config: PipelineConfig,
        snapshot_writer=None,
        snapshot_store_factory=None,
    ):
        if snapshot_writer is not None and snapshot_store_factory is not None:
            raise ValueError(
                "snapshot_writer and snapshot_store_factory are mutually exclusive"
            )
        if snapshot_writer is None:
            if snapshot_store_factory is None:
                raise SnapshotStoreNotConfiguredError(
                    "PipelineRunner requires an injected snapshot writer or "
                    "snapshot store factory"
                )
            snapshot_store = snapshot_store_factory()
            snapshot_writer = SnapshotWriter(snapshot_store)

        self._config = config
        self._stages = [
            SignalIntakeStage(),
            UniverseStage(),
            FeatureAssemblyStage(),
            RuleModelStage(),
            GatingStage(),
            AssemblyStage(),
            PublishStage(),
        ]
        self._snapshot_writer = snapshot_writer
        self._validator = OutputValidator()

    def run(
        self,
        as_of: str,
        source_inputs: PipelineSourceInputs | None = None,
    ) -> dict:
        if source_inputs is None:
            source_inputs = PipelineSourceInputs()
        if not isinstance(source_inputs, PipelineSourceInputs):
            raise TypeError("source_inputs must be PipelineSourceInputs")
        ctx = PipelineContext(
            snapshot_id=str(uuid.uuid4()),
            as_of=as_of,
            config=self._config,
            signals=copy.deepcopy(list(source_inputs.signals)),
            universe=list(source_inputs.universe),
            scores=copy.deepcopy(dict(source_inputs.scores)),
            evidence_refs=copy.deepcopy(
                {
                    ticker: list(refs)
                    for ticker, refs in source_inputs.evidence_refs.items()
                }
            ),
            input_hashes=list(self._config.input_hashes),
        )

        start_ms = time.monotonic()

        for stage in self._stages[:-1]:
            ctx = stage.execute(ctx)

        recommendation_list = ctx.build_recommendation_list()

        generation_ms = int((time.monotonic() - start_ms) * 1000)
        recommendation_list["meta"]["generation_ms"] = generation_ms

        validation_errors = self._validator.validate(recommendation_list)
        if validation_errors:
            raise PipelineValidationError(validation_errors)

        self._snapshot_writer.write(ctx, recommendation_list)

        self._stages[-1].execute(ctx)

        return recommendation_list


class PipelineValidationError(Exception):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"Pipeline validation failed: {len(errors)} errors")
