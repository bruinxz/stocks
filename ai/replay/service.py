from __future__ import annotations

import datetime as _datetime
import hashlib
import re
import uuid
from typing import Callable, Optional

from ai.replay.ports import (
    EvidenceCache,
    RecommendationReplayPipeline,
    ReplayJobStore,
    SignalSource,
    StrategyScoreSource,
    UniverseSource,
)
from ai.replay.types import (
    ReplayInputs,
    ReplayJob,
    ReplayPins,
    ReplayResult,
    SourceSlice,
)
from ai.snapshot.fingerprint import compute_input_fingerprint, jcs_canonicalize


CONTRACT_VERSION = "0.3.1"
PROFILE_MARKET_SCOPES = {
    "us_preferred": frozenset({"us", "cn_a"}),
    "multibagger": frozenset({"us", "cn_a"}),
    "japan_blue_chip": frozenset({"jp"}),
    "japan_multibagger": frozenset({"jp"}),
    "korea_semiconductor_chain": frozenset({"kr"}),
    "korea_multibagger": frozenset({"kr"}),
}
SOURCE_KINDS = ("signals", "universe", "scores", "evidence")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)


class ReplayServiceError(RuntimeError):
    code = "REPLAY_ERROR"


class ReplayPinsError(ReplayServiceError):
    code = "INVALID_REPLAY_PINS"


class ReplayJobNotFoundError(ReplayServiceError):
    code = "REPLAY_JOB_NOT_FOUND"


class ReplayConflictError(ReplayServiceError):
    code = "REPLAY_CONFLICT"


class ReplaySourceError(ReplayServiceError):
    code = "REPLAY_SOURCE_INVALID"


class ReplayPipelineError(ReplayServiceError):
    code = "REPLAY_PIPELINE_FAILED"


class ReplayService:
    """Deterministic replay orchestration with no DB or HTTP dependency."""

    def __init__(
        self,
        *,
        signal_source: SignalSource,
        universe_source: UniverseSource,
        score_source: StrategyScoreSource,
        evidence_cache: EvidenceCache,
        pipeline: RecommendationReplayPipeline,
        job_store: ReplayJobStore,
        uuid_factory: Callable[[], uuid.UUID] = uuid.uuid4,
        clock: Callable[[], str] = lambda: (
            _datetime.datetime.now(_datetime.timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        ),
    ):
        self._signal_source = signal_source
        self._universe_source = universe_source
        self._score_source = score_source
        self._evidence_cache = evidence_cache
        self._pipeline = pipeline
        self._job_store = job_store
        self._uuid_factory = uuid_factory
        self._clock = clock

    def submit(self, pins: ReplayPins) -> ReplayJob:
        self._validate_pins(pins)
        idempotency_key = self._idempotency_key(pins)
        now = self._clock()
        self._validate_utc_seconds(now, "clock")

        generated = self._uuid_factory()
        if not isinstance(generated, uuid.UUID) or generated.version != 4:
            raise ReplayConflictError("uuid_factory must produce UUIDv4")
        proposed = ReplayJob(
            job_id=str(generated),
            idempotency_key=idempotency_key,
            pins=pins,
            status="queued",
            created_at=now,
            updated_at=now,
        )
        job, created = self._job_store.create_or_get(proposed)
        if not created and (
            job.idempotency_key != idempotency_key or job.pins != pins
        ):
            raise ReplayConflictError(
                "idempotency key resolved to different replay pins"
            )
        self._validate_job(job)
        return job

    def run(self, job_id: str) -> ReplayJob:
        job = self.get(job_id)
        if job.status in {"completed", "failed"}:
            return job
        if job.status != "queued":
            raise ReplayConflictError(
                f"replay job cannot run from status {job.status}"
            )

        running = job.running(self._now())
        running = self._job_store.transition(job_id, "queued", running)
        self._validate_job(running)

        try:
            inputs = self._load_inputs(running.pins)
            result = self._pipeline.run(running.pins, inputs)
            self._validate_result(result)
            completed = running.completed(result, self._now())
            completed = self._job_store.transition(
                job_id, "running", completed
            )
            self._validate_job(completed)
            return completed
        except ReplayServiceError as error:
            return self._retain_failure(running, error.code, str(error))
        except Exception:
            return self._retain_failure(
                running,
                ReplayPipelineError.code,
                "replay pipeline failed",
            )

    def get(self, job_id: str) -> ReplayJob:
        try:
            parsed = uuid.UUID(job_id)
        except (AttributeError, TypeError, ValueError) as error:
            raise ReplayJobNotFoundError("replay job not found") from error
        if parsed.version != 4 or str(parsed) != job_id:
            raise ReplayJobNotFoundError("replay job not found")
        job = self._job_store.get(job_id)
        if job is None:
            raise ReplayJobNotFoundError("replay job not found")
        self._validate_job(job)
        return job

    def _load_inputs(self, pins: ReplayPins) -> ReplayInputs:
        slices = ReplayInputs(
            signals=self._signal_source.load_signals(pins),
            universe=self._universe_source.load_universe(pins),
            scores=self._score_source.load_scores(pins),
            evidence=self._evidence_cache.load_evidence(pins),
        )
        for expected_kind, source_slice in zip(
            SOURCE_KINDS, slices.ordered()
        ):
            self._validate_source_slice(expected_kind, pins, source_slice)
        computed = compute_input_fingerprint(
            [source_slice.content_hash for source_slice in slices.ordered()]
        )
        if computed != pins.input_fingerprint:
            raise ReplaySourceError(
                "source content hashes do not match replay input_fingerprint"
            )
        return slices

    def _retain_failure(
        self, running: ReplayJob, code: str, detail: str
    ) -> ReplayJob:
        failed = running.failed(code, detail[:240], self._now())
        failed = self._job_store.transition(
            running.job_id, "running", failed
        )
        self._validate_job(failed)
        return failed

    def _now(self) -> str:
        now = self._clock()
        self._validate_utc_seconds(now, "clock")
        return now

    @classmethod
    def _validate_pins(cls, pins: ReplayPins) -> None:
        if not isinstance(pins, ReplayPins):
            raise ReplayPinsError("pins must be ReplayPins")
        try:
            _datetime.date.fromisoformat(pins.trading_day)
        except (TypeError, ValueError) as error:
            raise ReplayPinsError(
                "trading_day must be a valid YYYY-MM-DD date"
            ) from error
        cls._validate_utc_seconds(pins.as_of, "as_of")
        if (
            pins.profile not in PROFILE_MARKET_SCOPES
            or pins.market_scope not in PROFILE_MARKET_SCOPES[pins.profile]
        ):
            raise ReplayPinsError(
                "profile and market_scope are incompatible or unsupported"
            )
        if pins.contract_version != CONTRACT_VERSION:
            raise ReplayPinsError("contract_version must be 0.3.1")
        for field in (
            "profile_version",
            "strategy_version",
            "pipeline_version",
        ):
            value = getattr(pins, field)
            if not isinstance(value, str) or not _SEMVER_RE.fullmatch(value):
                raise ReplayPinsError(f"{field} must be SemVer")
        cls._require_sha256(pins.input_fingerprint, "input_fingerprint")

    @classmethod
    def _validate_source_slice(
        cls,
        expected_kind: str,
        pins: ReplayPins,
        source_slice: SourceSlice,
    ) -> None:
        if not isinstance(source_slice, SourceSlice):
            raise ReplaySourceError(f"{expected_kind} source returned wrong type")
        if source_slice.kind != expected_kind:
            raise ReplaySourceError(f"{expected_kind} source kind mismatch")
        for field in ("trading_day", "as_of", "profile", "market_scope"):
            if getattr(source_slice, field) != getattr(pins, field):
                raise ReplaySourceError(
                    f"{expected_kind} source {field} pin mismatch"
                )
        if (
            not isinstance(source_slice.source_version, str)
            or not source_slice.source_version
        ):
            raise ReplaySourceError(
                f"{expected_kind} source_version is required"
            )
        cls._require_sha256(
            source_slice.content_hash,
            f"{expected_kind}.content_hash",
            error_type=ReplaySourceError,
        )
        if not isinstance(source_slice.records, tuple):
            raise ReplaySourceError(f"{expected_kind} records must be a tuple")
        try:
            jcs_canonicalize(source_slice.records)
        except (TypeError, ValueError) as error:
            raise ReplaySourceError(
                f"{expected_kind} records must be JSON/JCS serializable"
            ) from error

    @classmethod
    def _validate_result(cls, result: ReplayResult) -> None:
        if not isinstance(result, ReplayResult):
            raise ReplayPipelineError("pipeline returned wrong result type")
        try:
            parsed = uuid.UUID(result.snapshot_id)
        except (AttributeError, TypeError, ValueError) as error:
            raise ReplayPipelineError(
                "pipeline snapshot_id must be UUIDv4"
            ) from error
        if parsed.version != 4 or str(parsed) != result.snapshot_id:
            raise ReplayPipelineError("pipeline snapshot_id must be UUIDv4")
        cls._require_sha256(
            result.output_fingerprint,
            "output_fingerprint",
            error_type=ReplayPipelineError,
        )

    @classmethod
    def _validate_job(cls, job: ReplayJob) -> None:
        if not isinstance(job, ReplayJob):
            raise ReplayConflictError("job store returned wrong type")
        if job.status not in {"queued", "running", "completed", "failed"}:
            raise ReplayConflictError("job store returned invalid status")
        cls._validate_pins(job.pins)
        cls._require_sha256(
            job.idempotency_key,
            "idempotency_key",
            error_type=ReplayConflictError,
        )
        expected_key = cls._idempotency_key(job.pins)
        if job.idempotency_key != expected_key:
            raise ReplayConflictError("job idempotency key mismatch")
        for field in ("created_at", "updated_at"):
            cls._validate_utc_seconds(
                getattr(job, field), field, error_type=ReplayConflictError
            )
        if job.status == "completed":
            if job.error_code is not None or job.error_detail is not None:
                raise ReplayConflictError("completed job cannot retain an error")
            cls._validate_result(
                ReplayResult(
                    snapshot_id=job.snapshot_id or "",
                    output_fingerprint=job.output_fingerprint or "",
                )
            )
        elif job.status == "failed":
            if (
                not isinstance(job.error_code, str)
                or not job.error_code
                or not isinstance(job.error_detail, str)
                or not job.error_detail
                or job.snapshot_id is not None
                or job.output_fingerprint is not None
            ):
                raise ReplayConflictError("failed job has invalid terminal fields")
        elif any(
            value is not None
            for value in (
                job.snapshot_id,
                job.output_fingerprint,
                job.error_code,
                job.error_detail,
            )
        ):
            raise ReplayConflictError(
                "non-terminal job cannot have terminal fields"
            )

    @staticmethod
    def _idempotency_key(pins: ReplayPins) -> str:
        material = {
            "trading_day": pins.trading_day,
            "as_of": pins.as_of,
            "profile": pins.profile,
            "market_scope": pins.market_scope,
            "profile_version": pins.profile_version,
            "contract_version": pins.contract_version,
            "input_fingerprint": pins.input_fingerprint,
            "strategy_version": pins.strategy_version,
            "pipeline_version": pins.pipeline_version,
        }
        return hashlib.sha256(
            jcs_canonicalize(material).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _validate_utc_seconds(
        value: str,
        field: str,
        *,
        error_type: type[ReplayServiceError] = ReplayPinsError,
    ) -> None:
        if not isinstance(value, str) or not value.endswith("Z"):
            raise error_type(f"{field} must be ISO8601 UTC seconds")
        try:
            parsed = _datetime.datetime.fromisoformat(
                value.removesuffix("Z") + "+00:00"
            )
        except ValueError as error:
            raise error_type(f"{field} must be ISO8601 UTC seconds") from error
        if (
            parsed.tzinfo != _datetime.timezone.utc
            or parsed.microsecond != 0
            or value != parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
        ):
            raise error_type(f"{field} must be ISO8601 UTC seconds")

    @staticmethod
    def _require_sha256(
        value: str,
        field: str,
        *,
        error_type: type[ReplayServiceError] = ReplayPinsError,
    ) -> None:
        if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
            raise error_type(f"{field} must be lowercase SHA-256")
