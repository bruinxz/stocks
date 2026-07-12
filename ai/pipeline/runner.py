from dataclasses import dataclass
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
from ai.snapshot.writer import SnapshotWriter
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


class PipelineRunner:
    """7-stage pipeline: A→B→C→D→E→F→G(snapshot)→H(publish)."""

    def __init__(self, config: PipelineConfig, snapshot_writer=None):
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
        self._snapshot_writer = snapshot_writer or SnapshotWriter()
        self._validator = OutputValidator()

    def run(self, as_of: str) -> dict:
        ctx = PipelineContext(
            snapshot_id=str(uuid.uuid4()),
            as_of=as_of,
            config=self._config,
            input_hashes=list(self._config.input_hashes),
        )

        start_ms = time.monotonic()

        for stage in self._stages[:-1]:
            ctx = stage.execute(ctx)

        recommendation_list = ctx.build_recommendation_list()

        validation_errors = self._validator.validate(recommendation_list)
        if validation_errors:
            raise PipelineValidationError(validation_errors)

        self._snapshot_writer.write(ctx, recommendation_list)

        self._stages[-1].execute(ctx)

        generation_ms = int((time.monotonic() - start_ms) * 1000)
        recommendation_list["meta"]["generation_ms"] = generation_ms

        return recommendation_list


class PipelineValidationError(Exception):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"Pipeline validation failed: {len(errors)} errors")
