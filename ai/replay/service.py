from __future__ import annotations

import datetime as _datetime
import hashlib
import json
import re
import secrets
import uuid
from collections.abc import Mapping
from typing import Callable, Optional

from ai.replay.ports import (
    EvidenceCache,
    RecommendationReplayPipeline,
    ReplayJobStore,
    SignalSource,
    StrategyScoreSource,
    UniverseSource,
)
from ai.replay.fingerprint import compute_replay_input_fingerprint
from ai.replay.errors import (
    ReplayInfrastructureError,
    ReplayRetryableInterruptionError,
)
from ai.replay.types import (
    ReplayInputs,
    ReplayJob,
    ReplayPins,
    ReplayResult,
    SourceSlice,
    is_canonical_source_version,
)
from ai.snapshot.fingerprint import jcs_canonicalize
from datapipeline.contracts import is_canonical_sha256


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
_SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_SAFE_SOURCE_DETAIL_PATTERNS = (
    re.compile(
        r"^(signals|universe|scores|evidence) source kind mismatch$"
    ),
    re.compile(
        r"^(signals|universe|scores|evidence) source "
        r"(trading_day|as_of|profile|market_scope) pin mismatch$"
    ),
    re.compile(
        r"^(signals|universe|scores|evidence) source_version is required$"
    ),
    re.compile(
        r"^(signals|universe|scores|evidence)\.content_hash "
        r"must be lowercase SHA-256$"
    ),
    re.compile(
        r"^(signals|universe|scores|evidence) records must be "
        r"(a tuple|JSON/JCS serializable)$"
    ),
    re.compile(
        r"^(signals|universe|scores|evidence) "
        r"records must contain JSON objects$"
    ),
    re.compile(
        r"^(signals|universe|scores|evidence) "
        r"content_hash does not match records$"
    ),
    re.compile(
        r"^source content hashes do not match replay input_fingerprint$"
    ),
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
        input_source=None,
        uuid_factory: Callable[[], uuid.UUID] = uuid.uuid4,
        lease_token_factory: Callable[[], str] = lambda: secrets.token_hex(32),
        lease_seconds: int = 150,
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
        self._input_source = input_source
        self._uuid_factory = uuid_factory
        self._lease_token_factory = lease_token_factory
        if (
            isinstance(lease_seconds, bool)
            or not isinstance(lease_seconds, int)
            or not 1 <= lease_seconds <= 3_600
        ):
            raise ReplayPinsError("lease_seconds must be an integer in [1,3600]")
        self._lease_seconds = lease_seconds
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
        if created and job != proposed:
            raise ReplayConflictError(
                "job store created a substituted replay job"
            )
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
        now = self._now()
        if job.status == "running" and not self._lease_expired(job, now):
            raise ReplayConflictError(
                "replay job is already leased"
            )
        if job.status not in {"queued", "running"}:
            raise ReplayConflictError("replay job cannot be claimed")

        lease_token = self._lease_token_factory()
        self._require_sha256(
            lease_token,
            "lease_token",
            error_type=ReplayConflictError,
        )
        lease_expires_at = self._add_seconds(now, self._lease_seconds)
        running = self._transition_exact(
            job,
            job.claimed(
                now,
                lease_token=lease_token,
                lease_expires_at=lease_expires_at,
            ),
        )

        try:
            inputs = self._load_inputs(running.pins)
            result = self._pipeline.run(running.pins, inputs)
            self._validate_result(result)
        except ReplayRetryableInterruptionError:
            raise
        except ReplayInfrastructureError as error:
            raise ReplayRetryableInterruptionError(
                "replay infrastructure is temporarily unavailable"
            ) from error
        except ReplayServiceError as error:
            return self._retain_failure(
                running,
                error.code,
                self._public_error_detail(error),
            )
        except Exception:
            return self._retain_failure(
                running,
                ReplayPipelineError.code,
                "replay pipeline failed",
            )

        completed_at = self._now()
        self._require_live_lease(running, completed_at)
        return self._transition_exact(
            running,
            running.completed(result, completed_at),
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
        if self._input_source is not None:
            try:
                slices = self._input_source.load_inputs(pins)
            except ReplayInfrastructureError as error:
                raise ReplayRetryableInterruptionError(
                    "atomic replay input source is temporarily unavailable"
                ) from error
            except Exception as error:
                raise ReplaySourceError(
                    "atomic replay input source unavailable"
                ) from error
            if type(slices) is not ReplayInputs:
                raise ReplaySourceError(
                    "atomic replay input source returned wrong type"
                )
        else:
            slices = ReplayInputs(
                signals=self._load_source(
                    "signals", self._signal_source.load_signals, pins
                ),
                universe=self._load_source(
                    "universe", self._universe_source.load_universe, pins
                ),
                scores=self._load_source(
                    "scores", self._score_source.load_scores, pins
                ),
                evidence=self._load_source(
                    "evidence", self._evidence_cache.load_evidence, pins
                ),
            )
        ordered = (
            slices.signals,
            slices.universe,
            slices.scores,
            slices.evidence,
        )
        if len(ordered) != len(SOURCE_KINDS):
            raise ReplaySourceError("atomic replay input source count mismatch")
        validated = tuple(
            self._validate_source_slice(expected_kind, pins, source_slice)
            for expected_kind, source_slice in zip(SOURCE_KINDS, ordered)
        )
        slices = ReplayInputs(
            signals=validated[0],
            universe=validated[1],
            scores=validated[2],
            evidence=validated[3],
        )
        computed = compute_replay_input_fingerprint(slices)
        if computed != pins.input_fingerprint:
            raise ReplaySourceError(
                "source content hashes do not match replay input_fingerprint"
            )
        return slices

    @staticmethod
    def _load_source(kind: str, loader, pins: ReplayPins) -> SourceSlice:
        try:
            return loader(pins)
        except ReplayInfrastructureError as error:
            raise ReplayRetryableInterruptionError(
                f"{kind} source is temporarily unavailable"
            ) from error
        except Exception as error:
            raise ReplaySourceError(f"{kind} source unavailable") from error

    def _retain_failure(
        self, running: ReplayJob, code: str, detail: str
    ) -> ReplayJob:
        failed_at = self._now()
        self._require_live_lease(running, failed_at)
        return self._transition_exact(
            running,
            running.failed(code, detail[:240], failed_at),
        )

    def _transition_exact(
        self,
        expected: ReplayJob,
        requested: ReplayJob,
    ) -> ReplayJob:
        returned = self._job_store.transition(
            expected.job_id, expected, requested
        )
        if returned != requested:
            raise ReplayConflictError(
                "job store transition did not persist the exact requested state"
            )
        self._validate_job(returned)
        return returned

    @classmethod
    def _lease_expired(cls, job: ReplayJob, now: str) -> bool:
        if job.status != "running" or job.lease_expires_at is None:
            raise ReplayConflictError("running replay job has no lease")
        return job.lease_expires_at <= now

    @classmethod
    def _require_live_lease(cls, job: ReplayJob, now: str) -> None:
        if cls._lease_expired(job, now):
            raise ReplayConflictError("replay job lease expired")

    @staticmethod
    def _add_seconds(value: str, seconds: int) -> str:
        parsed = _datetime.datetime.fromisoformat(
            value.removesuffix("Z") + "+00:00"
        )
        return (parsed + _datetime.timedelta(seconds=seconds)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

    def _now(self) -> str:
        now = self._clock()
        self._validate_utc_seconds(now, "clock")
        return now

    @classmethod
    def _validate_pins(cls, pins: ReplayPins) -> None:
        if type(pins) is not ReplayPins:
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
    ) -> SourceSlice:
        if type(source_slice) is not SourceSlice:
            raise ReplaySourceError(f"{expected_kind} source returned wrong type")
        if source_slice.kind != expected_kind:
            raise ReplaySourceError(f"{expected_kind} source kind mismatch")
        for field in ("trading_day", "as_of", "profile", "market_scope"):
            if getattr(source_slice, field) != getattr(pins, field):
                raise ReplaySourceError(
                    f"{expected_kind} source {field} pin mismatch"
                )
        if (
            not is_canonical_source_version(source_slice.source_version)
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
        if any(not isinstance(record, Mapping) for record in source_slice.records):
            raise ReplaySourceError(
                f"{expected_kind} records must contain JSON objects"
            )
        try:
            records_jcs = jcs_canonicalize(source_slice.records)
        except (TypeError, ValueError) as error:
            raise ReplaySourceError(
                f"{expected_kind} records must be JSON/JCS serializable"
            ) from error
        records_hash = hashlib.sha256(records_jcs.encode("utf-8")).hexdigest()
        if records_hash != source_slice.content_hash:
            raise ReplaySourceError(
                f"{expected_kind} content_hash does not match records"
            )
        try:
            canonical_records = json.loads(records_jcs)
        except (TypeError, ValueError) as error:
            raise ReplaySourceError(
                f"{expected_kind} records must be JSON/JCS serializable"
            ) from error
        if not isinstance(canonical_records, list) or any(
            type(record) is not dict for record in canonical_records
        ):
            raise ReplaySourceError(
                f"{expected_kind} records must contain JSON objects"
            )
        return SourceSlice(
            kind=source_slice.kind,
            trading_day=source_slice.trading_day,
            as_of=source_slice.as_of,
            profile=source_slice.profile,
            market_scope=source_slice.market_scope,
            source_version=source_slice.source_version,
            content_hash=source_slice.content_hash,
            records=tuple(canonical_records),
        )

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
        try:
            job_id = uuid.UUID(job.job_id)
        except (AttributeError, TypeError, ValueError) as error:
            raise ReplayConflictError("job store returned invalid job_id") from error
        if job_id.version != 4 or str(job_id) != job.job_id:
            raise ReplayConflictError("job store returned invalid job_id")
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
        if job.updated_at < job.created_at:
            raise ReplayConflictError("job updated_at precedes created_at")
        if (
            isinstance(job.attempt, bool)
            or not isinstance(job.attempt, int)
            or not 0 <= job.attempt <= 1_000_000
        ):
            raise ReplayConflictError("job store returned invalid attempt")
        if job.status == "running":
            if job.attempt < 1:
                raise ReplayConflictError("running job has invalid attempt")
            cls._require_sha256(
                job.lease_token,
                "lease_token",
                error_type=ReplayConflictError,
            )
            cls._validate_utc_seconds(
                job.lease_expires_at,
                "lease_expires_at",
                error_type=ReplayConflictError,
            )
            if job.lease_expires_at <= job.updated_at:
                raise ReplayConflictError("running job lease is not in the future")
        elif job.lease_token is not None or job.lease_expires_at is not None:
            raise ReplayConflictError("non-running job cannot retain a lease")
        if job.status == "completed":
            if job.attempt < 1:
                raise ReplayConflictError("completed job has invalid attempt")
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
                job.attempt < 1
                or not isinstance(job.error_code, str)
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
    def _public_error_detail(error: ReplayServiceError) -> str:
        detail = str(error)
        if isinstance(error, ReplaySourceError) and any(
            pattern.fullmatch(detail)
            for pattern in _SAFE_SOURCE_DETAIL_PATTERNS
        ):
            return detail[:240]
        return {
            ReplaySourceError.code: "replay source invalid",
            ReplayPipelineError.code: "replay pipeline failed",
            ReplayPinsError.code: "replay pins invalid",
        }.get(error.code, "replay failed")

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
        if not is_canonical_sha256(value):
            raise error_type(f"{field} must be lowercase SHA-256")
