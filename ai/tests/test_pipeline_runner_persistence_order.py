from __future__ import annotations

import copy
import hashlib
import unittest
from typing import Optional
from unittest.mock import patch

from ai.pipeline.context import PipelineContext
from ai.pipeline.runner import (
    PipelineConfig,
    PipelineRunner,
    PipelineValidationError,
)
from ai.snapshot.writer import SnapshotStoreNotConfiguredError


def _config() -> PipelineConfig:
    full_text = "Research only. No investment promise."
    disclaimer_hash = hashlib.sha256(full_text.encode("utf-8")).hexdigest()
    return PipelineConfig(
        profile="us_preferred",
        market_scope="us",
        trading_day="2026-07-12",
        pipeline_version="pipeline@0.3.1",
        model_version="model@0.3.1",
        strategy_version="strategy@0.3.1",
        rule_bundle_hash="a" * 64,
        template_hash="b" * 64,
        disclaimer_hash=disclaimer_hash,
        contract_version="0.3.1",
        profile_version="profile@0.3.1",
        disclaimer={
            "version": "0.3.1",
            "short_text": "Research only.",
            "full_text": full_text,
            "language": "en-US",
            "effective_at": "2026-07-01T00:00:00Z",
            "hash": disclaimer_hash,
        },
        input_hashes=("c" * 64,),
    )


def _envelope() -> dict:
    return {
        "snapshot_id": "12345678-1234-4234-8234-567812345678",
        "as_of": "2026-07-12T01:02:03Z",
        "profile": "us_preferred",
        "market_scope": "us",
        "items": [],
        "output_fingerprint": "d" * 64,
        "disclaimer": copy.deepcopy(_config().disclaimer),
        "meta": {
            "contract_version": "0.3.1",
            "profile_version": "profile@0.3.1",
            "input_fingerprint": "e" * 64,
            "strategy_version": "strategy@0.3.1",
            "pipeline_version": "pipeline@0.3.1",
            "generated_by": "ai-gamma@test",
            "generation_ms": 0,
        },
    }


class _Clock:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> float:
        self.calls += 1
        return 100.0 if self.calls == 1 else 100.5


class _NoopStage:
    def execute(self, ctx):
        return ctx


class _RecordingPublishStage:
    def __init__(self) -> None:
        self.calls = 0

    def execute(self, ctx):
        self.calls += 1
        return ctx


class _GenerationValidator:
    def __init__(self, *, expected: int, reject: bool = False) -> None:
        self.expected = expected
        self.reject = reject
        self.seen: list[int] = []

    def validate(self, envelope: dict) -> list[str]:
        generation_ms = envelope["meta"]["generation_ms"]
        self.seen.append(generation_ms)
        if self.reject:
            return ["injected final validation failure"]
        if generation_ms != self.expected:
            return [
                f"generation_ms must be finalized as {self.expected} "
                f"before validation; got {generation_ms}"
            ]
        return []


class _RecordingValidator:
    def __init__(self) -> None:
        self.seen: list[int] = []

    def validate(self, envelope: dict) -> list[str]:
        self.seen.append(envelope["meta"]["generation_ms"])
        return []


class _RecordingWriter:
    def __init__(self, error: Optional[Exception] = None) -> None:
        self.error = error
        self.calls = 0
        self.payload_at_write: Optional[dict] = None
        self.payload_reference: Optional[dict] = None

    def write(self, _ctx, envelope: dict):
        self.calls += 1
        self.payload_at_write = copy.deepcopy(envelope)
        self.payload_reference = envelope
        if self.error is not None:
            raise self.error
        return object()


def _wire_runner(
    writer: _RecordingWriter,
    validator: _GenerationValidator,
) -> tuple[PipelineRunner, _RecordingPublishStage]:
    runner = PipelineRunner(_config(), snapshot_writer=writer)
    publisher = _RecordingPublishStage()
    runner._stages = [*[_NoopStage() for _ in range(6)], publisher]
    runner._validator = validator
    return runner, publisher


class PipelineRunnerPersistenceOrderTests(unittest.TestCase):
    def test_default_constructor_never_builds_unconfigured_writer(self):
        with patch("ai.pipeline.runner.SnapshotWriter") as writer_type:
            with self.assertRaises(SnapshotStoreNotConfiguredError):
                PipelineRunner(_config())
            writer_type.assert_not_called()

    def test_snapshot_store_factory_is_explicit_and_constructs_writer_once(self):
        store = object()
        writer = object()
        factory_calls = []

        def store_factory():
            factory_calls.append("called")
            return store

        with patch(
            "ai.pipeline.runner.SnapshotWriter", return_value=writer
        ) as writer_type:
            runner = PipelineRunner(
                _config(),
                snapshot_store_factory=store_factory,
            )

        self.assertEqual(factory_calls, ["called"])
        writer_type.assert_called_once_with(store)
        self.assertIs(runner._snapshot_writer, writer)

    def test_explicit_snapshot_writer_injection_remains_supported(self):
        writer = _RecordingWriter()
        runner = PipelineRunner(_config(), snapshot_writer=writer)

        self.assertIs(runner._snapshot_writer, writer)

    def test_generation_is_finalized_and_validated_before_persist(self):
        writer = _RecordingWriter()
        validator = _GenerationValidator(expected=500)
        runner, publisher = _wire_runner(writer, validator)
        envelope = _envelope()

        with patch.object(
            PipelineContext,
            "build_recommendation_list",
            return_value=envelope,
        ), patch("ai.pipeline.runner.time.monotonic", new=_Clock()):
            returned = runner.run("2026-07-12T01:02:03Z")

        self.assertEqual(validator.seen, [500])
        self.assertEqual(writer.calls, 1)
        self.assertEqual(writer.payload_at_write["meta"]["generation_ms"], 500)
        self.assertEqual(returned["meta"]["generation_ms"], 500)
        self.assertEqual(publisher.calls, 1)

    def test_persisted_envelope_equals_returned_and_is_never_mutated_after_write(self):
        writer = _RecordingWriter()
        validator = _RecordingValidator()
        runner, _publisher = _wire_runner(writer, validator)

        with patch.object(
            PipelineContext,
            "build_recommendation_list",
            return_value=_envelope(),
        ), patch("ai.pipeline.runner.time.monotonic", new=_Clock()):
            returned = runner.run("2026-07-12T01:02:03Z")

        self.assertEqual(validator.seen, [500])
        self.assertEqual(writer.payload_at_write, returned)
        self.assertEqual(writer.payload_reference, writer.payload_at_write)

    def test_final_validation_failure_never_persists_or_publishes(self):
        writer = _RecordingWriter()
        validator = _GenerationValidator(expected=500, reject=True)
        runner, publisher = _wire_runner(writer, validator)

        with patch.object(
            PipelineContext,
            "build_recommendation_list",
            return_value=_envelope(),
        ), patch(
            "ai.pipeline.runner.time.monotonic",
            new=_Clock(),
        ), self.assertRaises(
            PipelineValidationError
        ):
            runner.run("2026-07-12T01:02:03Z")

        self.assertEqual(validator.seen, [500])
        self.assertEqual(writer.calls, 0)
        self.assertEqual(publisher.calls, 0)

    def test_persistence_failure_never_publishes_or_mutates_attempted_envelope(self):
        writer = _RecordingWriter(RuntimeError("injected persistence failure"))
        validator = _RecordingValidator()
        runner, publisher = _wire_runner(writer, validator)

        with patch.object(
            PipelineContext,
            "build_recommendation_list",
            return_value=_envelope(),
        ), patch(
            "ai.pipeline.runner.time.monotonic",
            new=_Clock(),
        ), self.assertRaisesRegex(
            RuntimeError,
            "injected persistence failure",
        ):
            runner.run("2026-07-12T01:02:03Z")

        self.assertEqual(validator.seen, [500])
        self.assertEqual(writer.calls, 1)
        self.assertEqual(writer.payload_at_write["meta"]["generation_ms"], 500)
        self.assertEqual(writer.payload_reference, writer.payload_at_write)
        self.assertEqual(publisher.calls, 0)


if __name__ == "__main__":
    unittest.main()
