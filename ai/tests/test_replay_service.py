from __future__ import annotations

import copy
import hashlib
import unittest
import uuid
from dataclasses import replace

from ai.replay.service import (
    ReplayConflictError,
    ReplayJobNotFoundError,
    ReplayPinsError,
    ReplayService,
)
from ai.replay.fingerprint import compute_replay_input_fingerprint
from ai.replay.types import (
    ReplayInputs,
    ReplayJob,
    ReplayPins,
    ReplayResult,
    SourceSlice,
)


JOB_ID = uuid.UUID("12345678-1234-4234-8234-567812345678")
SNAPSHOT_ID = "22345678-1234-4234-8234-567812345678"
NOW = "2026-07-12T01:02:03Z"


class ForgedHash(str):
    def __eq__(self, _other: object) -> bool:
        return True

    def __ne__(self, _other: object) -> bool:
        return False

    __hash__ = str.__hash__


class MemoryJobStore:
    def __init__(self):
        self.jobs = {}
        self.idempotency = {}

    def create_or_get(self, job):
        existing_id = self.idempotency.get(job.idempotency_key)
        if existing_id:
            return self.jobs[existing_id], False
        self.jobs[job.job_id] = job
        self.idempotency[job.idempotency_key] = job.job_id
        return job, True

    def get(self, job_id):
        return self.jobs.get(job_id)

    def transition(self, job_id, expected_status, updated):
        current = self.jobs.get(job_id)
        if current is None or current.status != expected_status:
            raise ReplayConflictError("compare-and-swap transition failed")
        if updated.job_id != job_id:
            raise ReplayConflictError("transition changed job identity")
        self.jobs[job_id] = updated
        return updated


class StaleTransitionStore(MemoryJobStore):
    def __init__(self, stale_expected_status):
        super().__init__()
        self.stale_expected_status = stale_expected_status

    def transition(self, job_id, expected_status, updated):
        if expected_status == self.stale_expected_status:
            return self.jobs[job_id]
        return super().transition(job_id, expected_status, updated)


class SubstitutingCreateStore(MemoryJobStore):
    def create_or_get(self, job):
        substituted = replace(
            job,
            job_id="42345678-1234-4234-8234-567812345678",
        )
        self.jobs[substituted.job_id] = substituted
        self.idempotency[job.idempotency_key] = substituted.job_id
        return substituted, True


class SourceStub:
    def __init__(self, source_slice):
        self.source_slice = source_slice
        self.calls = 0

    def _load(self, _pins):
        self.calls += 1
        return self.source_slice

    load_signals = _load
    load_universe = _load
    load_scores = _load
    load_evidence = _load


class PipelineStub:
    def __init__(self, result=None, error=None):
        self.result = result or ReplayResult(
            snapshot_id=SNAPSHOT_ID,
            output_fingerprint="f" * 64,
        )
        self.error = error
        self.calls = []

    def run(self, pins, inputs):
        self.calls.append((pins, inputs))
        if self.error:
            raise self.error
        return self.result


def _records(kind):
    return ({"kind": kind},)


def _content_hash(kind):
    from ai.snapshot.fingerprint import jcs_canonicalize

    return hashlib.sha256(
        jcs_canonicalize(_records(kind)).encode("utf-8")
    ).hexdigest()


def _pins(**overrides):
    values = {
        "trading_day": "2026-07-12",
        "as_of": NOW,
        "profile": "us_preferred",
        "market_scope": "us",
        "profile_version": "3.1.0",
        "contract_version": "0.3.1",
        "input_fingerprint": "0" * 64,
        "strategy_version": "3.1.0",
        "pipeline_version": "3.1.0",
    }
    provisional = ReplayPins(**values)
    values["input_fingerprint"] = compute_replay_input_fingerprint(
        _inputs(provisional)
    )
    values.update(overrides)
    return ReplayPins(**values)


def _source_slice(kind, pins, **overrides):
    values = {
        "kind": kind,
        "trading_day": pins.trading_day,
        "as_of": pins.as_of,
        "profile": pins.profile,
        "market_scope": pins.market_scope,
        "source_version": f"{kind}@1",
        "content_hash": _content_hash(kind),
        "records": _records(kind),
    }
    values.update(overrides)
    return SourceSlice(**values)


def _inputs(pins):
    return ReplayInputs(
        signals=_source_slice("signals", pins),
        universe=_source_slice("universe", pins),
        scores=_source_slice("scores", pins),
        evidence=_source_slice("evidence", pins),
    )


def _service(*, pins=None, pipeline=None, store=None, clock=None):
    pins = pins or _pins()
    sources = {
        kind: SourceStub(_source_slice(kind, pins))
        for kind in ("signals", "universe", "scores", "evidence")
    }
    service = ReplayService(
        signal_source=sources["signals"],
        universe_source=sources["universe"],
        score_source=sources["scores"],
        evidence_cache=sources["evidence"],
        pipeline=pipeline or PipelineStub(),
        job_store=store or MemoryJobStore(),
        uuid_factory=lambda: JOB_ID,
        clock=clock or (lambda: NOW),
    )
    return service, sources


class ReplayServiceTests(unittest.TestCase):
    def test_replay_inputs_subclass_cannot_truncate_named_slices(self):
        class TruncatedReplayInputs(ReplayInputs):
            def ordered(self):
                return (self.signals,)

        class AtomicSource:
            def __init__(self, inputs):
                self.inputs = inputs

            def load_inputs(self, _pins):
                return self.inputs

        pins = _pins()
        exact = _inputs(pins)
        truncated = TruncatedReplayInputs(
            signals=exact.signals,
            universe=exact.universe,
            scores=exact.scores,
            evidence=exact.evidence,
        )

        with self.assertRaises(Exception):
            compute_replay_input_fingerprint(truncated)

        pipeline = PipelineStub()
        service, _ = _service(pins=pins, pipeline=pipeline)
        service._input_source = AtomicSource(truncated)
        failed = service.run(service.submit(pins).job_id)
        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertEqual(pipeline.calls, [])

    def test_source_slice_subclass_cannot_switch_records_after_validation(self):
        class SwitchingSlice(SourceSlice):
            def __getattribute__(self, name):
                if name == "records":
                    reads = object.__getattribute__(self, "__dict__").get(
                        "_reads", 0
                    )
                    object.__setattr__(self, "_reads", reads + 1)
                    if reads >= 3:
                        return ({"kind": "scores", "substituted": True},)
                return super().__getattribute__(name)

        pins = _pins()
        original = _source_slice("scores", pins)
        switching = SwitchingSlice(**original.__dict__)
        pipeline = PipelineStub()
        service, sources = _service(pins=pins, pipeline=pipeline)
        sources["scores"].source_slice = switching

        failed = service.run(service.submit(pins).job_id)

        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertEqual(pipeline.calls, [])

    def test_submit_run_and_terminal_readback(self):
        pins = _pins()
        pipeline = PipelineStub()
        service, sources = _service(pins=pins, pipeline=pipeline)

        queued = service.submit(pins)
        completed = service.run(queued.job_id)

        self.assertEqual(queued.status, "queued")
        self.assertEqual(completed.status, "completed")
        self.assertEqual(completed.snapshot_id, SNAPSHOT_ID)
        self.assertEqual(completed.output_fingerprint, "f" * 64)
        self.assertEqual(service.get(queued.job_id), completed)
        self.assertEqual(len(pipeline.calls), 1)
        self.assertEqual(
            {kind: source.calls for kind, source in sources.items()},
            {kind: 1 for kind in sources},
        )

    def test_identical_submit_is_atomic_idempotent(self):
        store = MemoryJobStore()
        service, _ = _service(store=store)

        first = service.submit(_pins())
        second = service.submit(copy.deepcopy(_pins()))

        self.assertEqual(first, second)
        self.assertEqual(len(store.jobs), 1)

    def test_pipeline_failure_is_retained_and_redacted(self):
        pipeline = PipelineStub(error=RuntimeError("credential=secret"))
        service, _ = _service(pipeline=pipeline)

        queued = service.submit(_pins())
        failed = service.run(queued.job_id)

        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.error_code, "REPLAY_PIPELINE_FAILED")
        self.assertEqual(failed.error_detail, "replay pipeline failed")
        self.assertNotIn("secret", failed.error_detail)
        self.assertEqual(service.run(queued.job_id), failed)

        pipeline2 = PipelineStub(
            error=__import__(
                "ai.replay.service", fromlist=["ReplayPipelineError"]
            ).ReplayPipelineError("credential=domain-secret")
        )
        service2, _ = _service(pipeline=pipeline2)
        failed2 = service2.run(service2.submit(_pins()).job_id)
        self.assertEqual(failed2.error_detail, "replay pipeline failed")
        self.assertNotIn("secret", failed2.error_detail)

    def test_source_pin_and_input_fingerprint_mismatches_fail_closed(self):
        pins = _pins()
        service, sources = _service(pins=pins)
        queued = service.submit(pins)

        sources["scores"].source_slice = replace(
            sources["scores"].source_slice,
            market_scope="cn_a",
        )
        failed = service.run(queued.job_id)
        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertIn("market_scope", failed.error_detail)

        service2, sources2 = _service(pins=pins)
        queued2 = service2.submit(pins)
        sources2["evidence"].source_slice = replace(
            sources2["evidence"].source_slice,
            content_hash="0" * 64,
        )
        failed2 = service2.run(queued2.job_id)
        self.assertEqual(failed2.error_code, "REPLAY_SOURCE_INVALID")
        self.assertIn("content_hash", failed2.error_detail)

    def test_source_version_str_subclass_cannot_forge_ascii_policy(self):
        class ForgedSourceVersion(str):
            def isascii(self):
                return True

            def __iter__(self):
                return iter("scores@1")

        pins = _pins()
        service, sources = _service(pins=pins)
        sources["scores"].source_slice = replace(
            sources["scores"].source_slice,
            source_version=ForgedSourceVersion("版本@1"),
        )

        failed = service.run(service.submit(pins).job_id)

        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertIn("source_version", failed.error_detail)

    def test_content_hash_str_subclass_cannot_override_comparison(self):
        pins = _pins()
        service, sources = _service(pins=pins)
        sources["scores"].source_slice = replace(
            sources["scores"].source_slice,
            content_hash=ForgedHash("f" * 64),
        )

        failed = service.run(service.submit(pins).job_id)

        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertIn("content_hash", failed.error_detail)

    def test_source_records_are_authenticated_by_content_hash(self):
        pins = _pins()
        service, sources = _service(pins=pins)
        sources["scores"].source_slice = replace(
            sources["scores"].source_slice,
            records=({"kind": "scores", "mutated": True},),
        )

        failed = service.run(service.submit(pins).job_id)

        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertIn("content_hash", failed.error_detail)

    def test_source_exceptions_are_redacted_and_classified(self):
        class FailingSource:
            def load_signals(self, _pins):
                raise RuntimeError("credential=secret")

        pins = _pins()
        service, _ = _service(pins=pins)
        service._signal_source = FailingSource()

        failed = service.run(service.submit(pins).job_id)

        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertEqual(failed.error_detail, "replay source invalid")
        self.assertNotIn("secret", failed.error_detail)

        class FailingDomainSource:
            def load_signals(self, _pins):
                from ai.replay.service import ReplaySourceError

                raise ReplaySourceError("credential=domain-secret")

        service2, _ = _service(pins=pins)
        service2._signal_source = FailingDomainSource()
        failed2 = service2.run(service2.submit(pins).job_id)
        self.assertEqual(failed2.error_detail, "replay source invalid")
        self.assertNotIn("secret", failed2.error_detail)

    def test_invalid_profiles_scopes_versions_hashes_and_dates_are_rejected(self):
        class ReplayPinsSubclass(ReplayPins):
            pass

        valid_pins = _pins()
        with self.assertRaises(ReplayPinsError):
            _service()[0].submit(ReplayPinsSubclass(**valid_pins.__dict__))

        invalid = [
            _pins(profile="custom"),
            _pins(profile="japan_blue_chip", market_scope="us"),
            _pins(contract_version="0.3.0"),
            _pins(profile_version="current"),
            _pins(input_fingerprint="not-a-hash"),
            _pins(trading_day="2026-02-30"),
            _pins(as_of="2026-07-12T01:02:03+00:00"),
            _pins(profile_version="1.0.0-."),
            _pins(profile_version="1.0.0-a..b"),
            _pins(profile_version="1.0.0-01"),
            _pins(profile_version="01.0.0"),
            _pins(profile_version="١.0.0"),
            _pins(profile_version="１.0.0"),
            _pins(profile_version="१.0.0"),
        ]
        for pins in invalid:
            with self.subTest(pins=pins):
                service, _ = _service(pins=pins)
                with self.assertRaises(ReplayPinsError):
                    service.submit(pins)

        valid = [
            "1.0.0",
            "1.0.0-alpha-beta",
            "1.0.0-alpha.1",
            "1.0.0+build-1",
            "1.0.0-alpha-beta+build.1",
        ]
        for version in valid:
            with self.subTest(version=version):
                pins = _pins(profile_version=version)
                service, _ = _service(pins=pins)
                self.assertEqual(service.submit(pins).status, "queued")

    def test_all_six_profile_scope_pairs_submit(self):
        pairs = (
            ("us_preferred", "us"),
            ("multibagger", "cn_a"),
            ("japan_blue_chip", "jp"),
            ("japan_multibagger", "jp"),
            ("korea_semiconductor_chain", "kr"),
            ("korea_multibagger", "kr"),
        )
        for profile, market_scope in pairs:
            with self.subTest(profile=profile, market_scope=market_scope):
                pins = _pins(profile=profile, market_scope=market_scope)
                service, _ = _service(pins=pins)
                self.assertEqual(service.submit(pins).status, "queued")

    def test_empty_source_slices_are_allowed(self):
        from ai.snapshot.fingerprint import jcs_canonicalize

        empty_hash = hashlib.sha256(
            jcs_canonicalize(()).encode("utf-8")
        ).hexdigest()
        pins = _pins()
        service, sources = _service(pins=pins)
        sources["universe"].source_slice = replace(
            sources["universe"].source_slice,
            records=(),
            content_hash=empty_hash,
        )
        inputs = ReplayInputs(
            signals=sources["signals"].source_slice,
            universe=sources["universe"].source_slice,
            scores=sources["scores"].source_slice,
            evidence=sources["evidence"].source_slice,
        )
        pins = replace(
            pins,
            input_fingerprint=compute_replay_input_fingerprint(inputs),
        )

        completed = service.run(service.submit(pins).job_id)

        self.assertEqual(completed.status, "completed")

    def test_job_store_corruption_and_invalid_transitions_are_rejected(self):
        store = MemoryJobStore()
        service, _ = _service(store=store)
        queued = service.submit(_pins())

        store.jobs[queued.job_id] = replace(queued, status="running")
        with self.assertRaisesRegex(ReplayConflictError, "cannot run"):
            service.run(queued.job_id)

        store.jobs[queued.job_id] = replace(
            queued, idempotency_key="0" * 64
        )
        with self.assertRaisesRegex(ReplayConflictError, "idempotency"):
            service.get(queued.job_id)

        store.jobs[queued.job_id] = replace(
            queued,
            updated_at="2026-07-12T01:02:02Z",
        )
        with self.assertRaisesRegex(ReplayConflictError, "precedes"):
            service.get(queued.job_id)

    def test_created_job_must_equal_exact_proposal(self):
        service, _ = _service(store=SubstitutingCreateStore())
        with self.assertRaisesRegex(ReplayConflictError, "substituted"):
            service.submit(_pins())

    def test_stale_queued_transition_fails_before_pipeline_effects(self):
        store = StaleTransitionStore("queued")
        pipeline = PipelineStub()
        service, sources = _service(store=store, pipeline=pipeline)
        queued = service.submit(_pins())

        with self.assertRaisesRegex(ReplayConflictError, "exact requested"):
            service.run(queued.job_id)

        self.assertEqual(pipeline.calls, [])
        self.assertEqual(
            {kind: source.calls for kind, source in sources.items()},
            {kind: 0 for kind in sources},
        )
        self.assertEqual(store.jobs[queued.job_id].status, "queued")

    def test_stale_terminal_transition_fails_after_pipeline_effects(self):
        store = StaleTransitionStore("running")
        pipeline = PipelineStub()
        service, _ = _service(store=store, pipeline=pipeline)
        queued = service.submit(_pins())

        with self.assertRaisesRegex(ReplayConflictError, "exact requested"):
            service.run(queued.job_id)

        self.assertEqual(len(pipeline.calls), 1)
        self.assertEqual(store.jobs[queued.job_id].status, "running")

    def test_missing_or_non_uuid_jobs_return_controlled_not_found(self):
        service, _ = _service()
        with self.assertRaises(ReplayJobNotFoundError):
            service.get("missing")
        with self.assertRaises(ReplayJobNotFoundError):
            service.get(str(uuid.uuid4()))

    def test_non_json_source_records_fail_closed(self):
        pins = _pins()
        service, sources = _service(pins=pins)
        sources["signals"].source_slice = replace(
            sources["signals"].source_slice,
            records=({"bad": object()},),
        )

        failed = service.run(service.submit(pins).job_id)

        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertIn("JSON/JCS", failed.error_detail)

    def test_scalar_source_records_fail_closed(self):
        pins = _pins()
        service, sources = _service(pins=pins)
        sources["universe"].source_slice = replace(
            sources["universe"].source_slice,
            records=(1,),
            content_hash=hashlib.sha256(b"[1]").hexdigest(),
        )

        failed = service.run(service.submit(pins).job_id)

        self.assertEqual(failed.error_code, "REPLAY_SOURCE_INVALID")
        self.assertIn("JSON objects", failed.error_detail)


if __name__ == "__main__":
    unittest.main()
