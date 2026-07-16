"""Runnable typed-source adapters and bounded replay worker.

The adapters consume already-authorized, immutable DataPipeline envelopes.
They never fetch providers and they preserve the B4 ``SourceSlice`` hash and
pin contract at the boundary.
"""

from __future__ import annotations

import copy
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
import hashlib
import math
from collections.abc import Mapping
from typing import Any, Protocol

from ai.replay.service import ReplayService, ReplaySourceError
from ai.replay.fingerprint import compute_replay_input_fingerprint
from ai.replay.types import (
    ReplayInputs,
    ReplayJob,
    ReplayPins,
    SourceSlice,
    is_canonical_source_version,
)
from ai.snapshot.fingerprint import jcs_canonicalize
from datapipeline.contracts import (
    JpKrFilingEnvelope,
    TextHitEnvelope,
    is_canonical_sha256,
)
from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    canonical_disclosure_fact_hash,
)
from datapipeline.storage.jpkr import canonical_financial_fact_hash
from datapipeline.storage.multibagger import build_text_hit_storage_row


SOURCE_VERSION_KEYS = ("signals", "universe", "scores", "evidence")
_BANDS = frozenset({"A", "B", "C", "D", "F"})
_CONVICTION_LEVELS = frozenset({"HIGH", "MED", "LOW"})
_RISK_GATES = frozenset({"GREEN", "YELLOW", "RED"})
_SCORE_DIMENSION_ORDER = ("Q", "G", "V", "M", "T", "R")
_CURRENCIES = frozenset({"USD", "CNY", "HKD", "JPY", "KRW"})
_TIME_HORIZONS = frozenset(
    {"INTRADAY", "SWING", "POSITION", "CORE_HOLD", "LONG_TERM"}
)
_SIZE_TIERS = {
    "TIER_5": 5.0,
    "TIER_3": 3.0,
    "TIER_2": 2.0,
    "TIER_1": 1.0,
    "SKIP": 0.0,
}
SOURCE_SCORE_FEATURE_KEYS = frozenset(
    {"score", "conviction", "risk_gate", "entry_plan"}
)
SOURCE_SCORE_KEYS = frozenset(
    {"profile", "market_scope", "rating", "total", "dims"}
)
SOURCE_DIMENSION_KEYS = frozenset({"key", "score", "band", "weight"})
SOURCE_CONVICTION_KEYS = frozenset(
    {"base", "adjustments", "final", "level"}
)
SOURCE_ADJUSTMENT_REQUIRED_KEYS = frozenset({"delta", "reason"})
SOURCE_ADJUSTMENT_ALLOWED_KEYS = frozenset(
    {"delta", "reason", "kind_ref", "source_ref"}
)
SOURCE_RISK_GATE_KEYS = frozenset(
    {"gate", "ok_to_enter", "triggers"}
)
SOURCE_RISK_TRIGGER_KEYS = frozenset(
    {"code", "severity", "detail"}
)
SOURCE_ENTRY_PLAN_KEYS = frozenset(
    {
        "entry",
        "stop",
        "targets",
        "size_hint",
        "time_horizon",
        "invalidation",
        "stop_distance_pct",
    }
)
SOURCE_SIZE_HINT_KEYS = frozenset(
    {"tier", "pct", "disclaimer_key", "rationale"}
)
SOURCE_PRICE_BAND_KEYS = frozenset({"low", "high", "currency"})
SOURCE_PRICE_KEYS = frozenset({"value", "currency"})
_CATALYST_KINDS = frozenset(
    {
        "earnings",
        "upgrade_downgrade",
        "product",
        "regulator",
        "geo_macro",
        "ma_activity",
        "sector_move",
        "leadership",
        "unclassified",
    }
)
_RISK_TRIGGER_CODES = frozenset(
    {
        "EARNINGS_T-2",
        "EARNINGS_T-0",
        "HALT_ACTIVE",
        "MERGER_PENDING",
        "LITIGATION_MATERIAL",
        "IV_SHOCK",
        "LIQUIDITY_LOW",
        "RESTATEMENT_30D",
        "DELISTING_NOTICE",
        "ST_TAG",
        "PRICE_LIMIT_APPROACH",
        "SUSPENDED",
        "TSE_HALT",
        "EDINET_DELAY",
        "CORPORATE_GOVERNANCE_ISSUE",
        "TSE_TOKUBETSU_CHI",
        "TSE_KANRI",
        "KRX_HALT",
        "DART_LATE_FILING",
        "INSIDER_TRADING_FLAG",
        "KRX_UNFAITHFUL",
        "KRX_INVESTOR_ALERT",
    }
)
_RISK_SEVERITIES = frozenset({"info", "warn", "block"})


class TypedSourceRepository(Protocol):
    def load(self, pins: ReplayPins) -> "TypedSourceSnapshot":
        ...


@dataclass(frozen=True)
class TypedScoreRecord:
    ticker: str
    profile: str
    market_scope: str
    as_of: str
    available_at_utc: datetime
    source_version: str
    features: Mapping[str, Any]
    fact_hash: str


@dataclass(frozen=True)
class TypedTextHitRecord:
    """One TextHit envelope pinned to its DataPipeline physical fact hash."""

    envelope: TextHitEnvelope
    hit_fact_hash: str


@dataclass(frozen=True)
class TypedSourceSnapshot:
    filings: tuple[JpKrFilingEnvelope, ...]
    text_hits: tuple[TypedTextHitRecord, ...]
    scores: tuple[TypedScoreRecord, ...]
    source_versions: Mapping[str, str]


def typed_score_fact_hash(
    *,
    ticker: str,
    profile: str,
    market_scope: str,
    as_of: str,
    available_at_utc: datetime,
    source_version: str,
    features: Mapping[str, Any],
) -> str:
    canonical_features = validate_source_score_features(
        features,
        profile=profile,
        market_scope=market_scope,
    )
    body = {
        "ticker": ticker,
        "profile": profile,
        "market_scope": market_scope,
        "as_of": as_of,
        "available_at_utc": _json_value(available_at_utc),
        "source_version": source_version,
        "features": canonical_features,
    }
    return _sha256(body)


class TypedReplaySources:
    """One immutable repository adapted to all four B4 source ports."""

    def __init__(self, repository: TypedSourceRepository):
        self._repository = repository

    def load_signals(self, pins: ReplayPins) -> SourceSlice:
        snapshot = self._load_capture(pins)
        return self._signals(pins, snapshot)

    def _signals(
        self, pins: ReplayPins, snapshot: TypedSourceSnapshot
    ) -> SourceSlice:
        records = tuple(
            sorted(
                (
                    *(
                        _filing_signal(envelope)
                        for envelope in snapshot.filings
                    ),
                    *(
                        _text_hit_signal(record)
                        for record in snapshot.text_hits
                    ),
                ),
                key=_record_sort_key,
            )
        )
        return self._slice("signals", pins, snapshot, records)

    def load_universe(self, pins: ReplayPins) -> SourceSlice:
        snapshot = self._load_capture(pins)
        return self._universe(pins, snapshot)

    def _universe(
        self, pins: ReplayPins, snapshot: TypedSourceSnapshot
    ) -> SourceSlice:
        tickers = {
            envelope.disclosure.ticker for envelope in snapshot.filings
        }
        tickers.update(
            record.envelope.document.ticker for record in snapshot.text_hits
        )
        tickers.update(record.ticker for record in snapshot.scores)
        records = tuple(
            {"ticker": ticker, "market_scope": pins.market_scope}
            for ticker in sorted(tickers)
        )
        return self._slice("universe", pins, snapshot, records)

    def load_scores(self, pins: ReplayPins) -> SourceSlice:
        snapshot = self._load_capture(pins)
        return self._scores(pins, snapshot)

    def _scores(
        self, pins: ReplayPins, snapshot: TypedSourceSnapshot
    ) -> SourceSlice:
        records = tuple(
            {
                "ticker": score.ticker,
                "profile": score.profile,
                "market_scope": score.market_scope,
                "as_of": score.as_of,
                "available_at_utc": _json_value(score.available_at_utc),
                "source_version": score.source_version,
                "features": _json_value(score.features),
                "fact_hash": score.fact_hash,
            }
            for score in sorted(snapshot.scores, key=lambda item: item.ticker)
        )
        return self._slice("scores", pins, snapshot, records)

    def load_evidence(self, pins: ReplayPins) -> SourceSlice:
        snapshot = self._load_capture(pins)
        return self._evidence(pins, snapshot)

    def _evidence(
        self, pins: ReplayPins, snapshot: TypedSourceSnapshot
    ) -> SourceSlice:
        records = tuple(
            sorted(
                (
                    *(
                        {
                            "kind": "filing",
                            "identity": list(
                                envelope.disclosure.identity
                            ),
                            "envelope": _json_value(asdict(envelope)),
                        }
                        for envelope in snapshot.filings
                    ),
                    *(
                        {
                            "kind": "text_hit",
                            "identity": list(record.envelope.identity),
                            "envelope": {
                                **_json_value(asdict(record.envelope)),
                                "hit_fact_hash": record.hit_fact_hash,
                            },
                        }
                        for record in snapshot.text_hits
                    ),
                ),
                key=_record_sort_key,
            )
        )
        return self._slice("evidence", pins, snapshot, records)

    def source_slices(self, pins: ReplayPins) -> tuple[SourceSlice, ...]:
        return self.load_inputs(pins).ordered()

    def load_inputs(self, pins: ReplayPins) -> ReplayInputs:
        """Load and validate exactly one repository capture per replay."""

        snapshot = self._load_capture(pins)
        return ReplayInputs(
            signals=self._signals(pins, snapshot),
            universe=self._universe(pins, snapshot),
            scores=self._scores(pins, snapshot),
            evidence=self._evidence(pins, snapshot),
        )

    def input_fingerprint(self, pins: ReplayPins) -> str:
        return compute_replay_input_fingerprint(self.load_inputs(pins))

    def _load_capture(self, pins: ReplayPins) -> TypedSourceSnapshot:
        snapshot = copy.deepcopy(self._repository.load(pins))
        if not isinstance(snapshot, TypedSourceSnapshot):
            raise ReplaySourceError(
                "typed source repository returned wrong type"
            )
        if (
            not isinstance(snapshot.filings, tuple)
            or not isinstance(snapshot.text_hits, tuple)
            or not isinstance(snapshot.scores, tuple)
            or not isinstance(snapshot.source_versions, Mapping)
        ):
            raise ReplaySourceError(
                "typed source snapshot collections have invalid types"
            )
        if set(snapshot.source_versions) != set(SOURCE_VERSION_KEYS):
            raise ReplaySourceError(
                "typed source versions must contain exact source kinds"
            )
        if any(
            not is_canonical_source_version(value)
            for value in snapshot.source_versions.values()
        ):
            raise ReplaySourceError(
                "typed source versions must be non-empty strings"
            )
        filing_identities = []
        financial_identities = []
        for envelope in snapshot.filings:
            if not isinstance(envelope, JpKrFilingEnvelope):
                raise ReplaySourceError("filing envelope returned wrong type")
            if (
                not is_canonical_sha256(envelope.disclosure.fact_hash)
                or envelope.disclosure.fact_hash
                != canonical_disclosure_fact_hash(envelope.disclosure)
            ):
                raise ReplaySourceError("disclosure fact_hash is not authentic")
            for financial in envelope.financials:
                if (
                    not is_canonical_sha256(financial.fact_hash)
                    or financial.fact_hash != canonical_financial_fact_hash(financial)
                ):
                    raise ReplaySourceError("financial fact_hash is not authentic")
                financial_identities.append(financial.identity)
            filing_identities.append(
                (
                    envelope.disclosure.source_kind,
                    envelope.disclosure.source_document_id,
                    envelope.disclosure.source_version,
                )
            )
        if len(filing_identities) != len(set(filing_identities)):
            raise ReplaySourceError("filing envelope identity is duplicated")
        if len(financial_identities) != len(set(financial_identities)):
            raise ReplaySourceError("financial fact identity is duplicated")
        text_identities = []
        for record in snapshot.text_hits:
            if type(record) is not TypedTextHitRecord or not isinstance(
                record.envelope, TextHitEnvelope
            ):
                raise ReplaySourceError("typed text hit returned wrong type")
            if (
                not is_canonical_sha256(
                    record.envelope.document.document_fact_hash
                )
                or not is_canonical_sha256(record.envelope.hit.context_hash)
            ):
                raise ReplaySourceError("typed text hit fact_hash is not authentic")
            try:
                expected_hash = build_text_hit_storage_row(
                    record.envelope
                ).hit_fact_hash
            except (TypeError, ValueError) as error:
                raise ReplaySourceError("typed text hit fact is invalid") from error
            if (
                not is_canonical_sha256(record.hit_fact_hash)
                or record.hit_fact_hash != expected_hash
            ):
                raise ReplaySourceError("typed text hit fact_hash is not authentic")
            text_identities.append(record.envelope.identity)
        if len(text_identities) != len(set(text_identities)):
            raise ReplaySourceError("text hit identity is duplicated")
        cutoff = _parse_utc(pins.as_of)
        for envelope in snapshot.filings:
            if envelope.disclosure.market_scope != pins.market_scope:
                raise ReplaySourceError("filing market_scope pin mismatch")
            try:
                envelope.require_available_by(cutoff)
            except ValueError as error:
                raise ReplaySourceError(
                    "filing violates replay PIT cutoff"
                ) from error
        for record in snapshot.text_hits:
            envelope = record.envelope
            if envelope.document.market_scope != pins.market_scope:
                raise ReplaySourceError("text hit market_scope pin mismatch")
            try:
                envelope.require_available_by(cutoff)
            except ValueError as error:
                raise ReplaySourceError(
                    "text hit violates replay PIT cutoff"
                ) from error
        self._validate_scores(snapshot.scores, pins, cutoff)
        return snapshot

    @staticmethod
    def _validate_scores(
        scores: tuple[TypedScoreRecord, ...],
        pins: ReplayPins,
        cutoff: datetime,
    ) -> None:
        if not isinstance(scores, tuple):
            raise ReplaySourceError("typed scores must be a tuple")
        tickers = set()
        for score in scores:
            if not isinstance(score, TypedScoreRecord):
                raise ReplaySourceError("typed score returned wrong type")
            if score.ticker in tickers:
                raise ReplaySourceError("typed score ticker is duplicated")
            tickers.add(score.ticker)
            if not is_canonical_sha256(score.fact_hash):
                raise ReplaySourceError("typed score fact_hash is not authentic")
            if (
                not isinstance(score.ticker, str)
                or not score.ticker
                or not is_canonical_source_version(score.source_version)
                or score.profile != pins.profile
                or score.market_scope != pins.market_scope
                or score.as_of != pins.as_of
            ):
                raise ReplaySourceError("typed score replay pins mismatch")
            if (
                score.available_at_utc.tzinfo is None
                or score.available_at_utc.utcoffset()
                != timezone.utc.utcoffset(score.available_at_utc)
                or score.available_at_utc > cutoff
            ):
                raise ReplaySourceError(
                    "typed score violates replay PIT cutoff"
                )
            expected = typed_score_fact_hash(
                ticker=score.ticker,
                profile=score.profile,
                market_scope=score.market_scope,
                as_of=score.as_of,
                available_at_utc=score.available_at_utc,
                source_version=score.source_version,
                features=score.features,
            )
            if score.fact_hash != expected:
                raise ReplaySourceError(
                    "typed score fact_hash is not authentic"
                )
            validate_source_score_features(
                score.features,
                profile=pins.profile,
                market_scope=pins.market_scope,
            )

    @staticmethod
    def _slice(
        kind: str,
        pins: ReplayPins,
        snapshot: TypedSourceSnapshot,
        records: tuple[Mapping[str, Any], ...],
    ) -> SourceSlice:
        source_version = snapshot.source_versions[kind]
        return SourceSlice(
            kind=kind,  # type: ignore[arg-type]
            trading_day=pins.trading_day,
            as_of=pins.as_of,
            profile=pins.profile,
            market_scope=pins.market_scope,
            source_version=source_version,
            content_hash=_sha256(records),
            records=records,
        )


class ReplayWorker:
    """Bounded worker over the exact B4 compare-and-swap FSM."""

    MAX_BATCH = 100

    def __init__(self, service: ReplayService):
        self._service = service

    def run_job(self, job_id: str) -> ReplayJob:
        return self._service.run(job_id)

    def run_batch(
        self, job_ids: tuple[str, ...], *, limit: int
    ) -> tuple[ReplayJob, ...]:
        if not isinstance(job_ids, tuple):
            raise ValueError("job_ids must be a tuple")
        if len(set(job_ids)) != len(job_ids):
            raise ValueError("job_ids must be unique")
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or limit < 1
            or limit > self.MAX_BATCH
        ):
            raise ValueError("limit must be an integer in [1,100]")
        return tuple(
            self._service.run(job_id) for job_id in job_ids[:limit]
        )


def build_typed_replay_runtime(
    *,
    repository: TypedSourceRepository,
    pipeline,
    job_store,
    uuid_factory=None,
    lease_token_factory=None,
    lease_seconds: int = 150,
    clock=None,
) -> tuple[ReplayService, ReplayWorker, TypedReplaySources]:
    sources = TypedReplaySources(repository)
    kwargs = {
        "signal_source": sources,
        "universe_source": sources,
        "score_source": sources,
        "evidence_cache": sources,
        "pipeline": pipeline,
        "job_store": job_store,
        "input_source": sources,
    }
    if uuid_factory is not None:
        kwargs["uuid_factory"] = uuid_factory
    if lease_token_factory is not None:
        kwargs["lease_token_factory"] = lease_token_factory
    kwargs["lease_seconds"] = lease_seconds
    if clock is not None:
        kwargs["clock"] = clock
    service = ReplayService(**kwargs)
    return service, ReplayWorker(service), sources


def _filing_signal(envelope: JpKrFilingEnvelope) -> dict[str, Any]:
    disclosure = envelope.disclosure
    return {
        "kind": "filing",
        "ticker": disclosure.ticker,
        "market_scope": disclosure.market_scope,
        "source_kind": disclosure.source_kind,
        "source_document_id": disclosure.source_document_id,
        "source_version": disclosure.source_version,
        "available_at_utc": _json_value(disclosure.available_at_utc),
        "fact_hash": disclosure.fact_hash,
        "disclosure_kind": disclosure.disclosure_kind,
        "headline": disclosure.event_headline_local,
    }


def _text_hit_signal(record: TypedTextHitRecord) -> dict[str, Any]:
    envelope = record.envelope
    return {
        "kind": "text_hit",
        "ticker": envelope.document.ticker,
        "market_scope": envelope.document.market_scope,
        "source_kind": envelope.document.source_kind,
        "source_document_id": envelope.document.document_id,
        "source_version": envelope.document.source_version,
        "available_at_utc": _json_value(
            envelope.document.available_at_utc
        ),
        "fact_hash": record.hit_fact_hash,
        "document_fact_hash": envelope.document.document_fact_hash,
        "term_id": envelope.hit.term_id,
        "hit_kind": envelope.hit.hit_kind,
        "field": envelope.hit.field,
        "start_offset": envelope.hit.start_offset,
        "end_offset": envelope.hit.end_offset,
        "context_hash": envelope.hit.context_hash,
    }


def _record_sort_key(record: Mapping[str, Any]) -> str:
    return jcs_canonicalize(dict(record))


def _sha256(value: object) -> str:
    return hashlib.sha256(
        jcs_canonicalize(value).encode("utf-8")
    ).hexdigest()


def _parse_utc(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(
            value.removesuffix("Z") + "+00:00"
        )
    except (AttributeError, ValueError) as error:
        raise ReplaySourceError("replay as_of must be UTC seconds") from error
    if (
        not isinstance(value, str)
        or not value.endswith("Z")
        or parsed.tzinfo != timezone.utc
        or parsed.microsecond != 0
        or value != parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
    ):
        raise ReplaySourceError("replay as_of must be UTC seconds")
    return parsed


def _json_value(value: object) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ReplaySourceError("typed source contains non-finite number")
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ReplaySourceError("typed source contains non-finite Decimal")
        return format(value, "f")
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() != timezone.utc.utcoffset(value):
            raise ReplaySourceError("typed source datetime must be UTC")
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ReplaySourceError(
                "typed source JSON object keys must be strings"
            )
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    raise ReplaySourceError(
        f"typed source contains unsupported {type(value).__name__}"
    )


def validate_source_score_features(
    features: Mapping[str, Any],
    *,
    profile: str,
    market_scope: str,
) -> dict[str, Any]:
    """Validate the exact replay source-feature schema.

    This is intentionally not a Recommendation or EntryPlan validator.  It
    authenticates the compact A/B/C-stage source object consumed by the
    pipeline; downstream assembly and ``OutputValidator`` remain authoritative
    for the complete RecommendationList.
    """

    if not isinstance(features, Mapping):
        raise ReplaySourceError("typed score features must be an object")
    _require_exact_keys(features, SOURCE_SCORE_FEATURE_KEYS, "features")
    score = features.get("score")
    conviction = features.get("conviction")
    risk_gate = features.get("risk_gate")
    entry_plan = features.get("entry_plan")
    if not all(
        isinstance(value, Mapping)
        for value in (score, conviction, risk_gate, entry_plan)
    ):
        raise ReplaySourceError(
            "typed score requires score/conviction/risk_gate/entry_plan"
        )
    _require_exact_keys(score, SOURCE_SCORE_KEYS, "features.score")
    _require_exact_keys(
        conviction, SOURCE_CONVICTION_KEYS, "features.conviction"
    )
    _require_exact_keys(
        risk_gate, SOURCE_RISK_GATE_KEYS, "features.risk_gate"
    )
    _require_exact_keys(
        entry_plan, SOURCE_ENTRY_PLAN_KEYS, "features.entry_plan"
    )
    if (
        score.get("profile") != profile
        or score.get("market_scope") != market_scope
        or score.get("rating") not in _BANDS
        or not _finite_range(score.get("total"), 0.0, 100.0)
    ):
        raise ReplaySourceError("typed score aggregate contract mismatch")
    if score["rating"] != _rating_for(float(score["total"])):
        raise ReplaySourceError("typed score rating relation mismatch")
    dimensions = score.get("dims")
    if not isinstance(dimensions, list) or len(dimensions) != 6:
        raise ReplaySourceError(
            "typed score dimensions must contain Q/G/V/M/T/R"
        )
    total_weight = 0.0
    weighted_total = 0.0
    for dimension, expected_key in zip(dimensions, _SCORE_DIMENSION_ORDER):
        if (
            not isinstance(dimension, Mapping)
            or not isinstance(dimension.get("key"), str)
            or dimension.get("key") != expected_key
            or dimension.get("band") not in _BANDS
            or not _finite_range(dimension.get("score"), 0.0, 100.0)
            or not _finite_range(dimension.get("weight"), 0.0, 1.0)
        ):
            raise ReplaySourceError("typed score dimension is invalid")
        _require_exact_keys(
            dimension,
            SOURCE_DIMENSION_KEYS,
            "features.score.dims[]",
        )
        if dimension["band"] != _rating_for(float(dimension["score"])):
            raise ReplaySourceError(
                "typed score dimension band relation mismatch"
            )
        total_weight += float(dimension["weight"])
        weighted_total += float(dimension["score"]) * float(
            dimension["weight"]
        )
    if abs(total_weight - 1.0) > 1e-9:
        raise ReplaySourceError("typed score dimension weights must sum to 1")
    if abs(float(score["total"]) - round(weighted_total, 1)) > 1e-9:
        raise ReplaySourceError(
            "typed score total must match the weighted dimensions"
        )

    base = conviction.get("base")
    final = conviction.get("final")
    adjustments = conviction.get("adjustments")
    if (
        not _finite_range(base, 0.0, 100.0)
        or not _finite_range(final, 0.0, 100.0)
        or abs(float(base) - float(score["total"])) > 1e-9
        or conviction.get("level") not in _CONVICTION_LEVELS
        or not isinstance(adjustments, list)
    ):
        raise ReplaySourceError("typed conviction contract mismatch")
    if len(adjustments) > 5:
        raise ReplaySourceError("typed conviction has too many adjustments")
    delta = 0.0
    for adjustment in adjustments:
        if (
            not isinstance(adjustment, Mapping)
            or not _finite_range(adjustment.get("delta"), -20.0, 20.0)
            or not isinstance(adjustment.get("reason"), str)
            or not adjustment.get("reason")
        ):
            raise ReplaySourceError("typed conviction adjustment is invalid")
        keys = set(adjustment)
        if (
            not SOURCE_ADJUSTMENT_REQUIRED_KEYS <= keys
            or not keys <= SOURCE_ADJUSTMENT_ALLOWED_KEYS
        ):
            raise ReplaySourceError(
                "typed conviction adjustment keys are invalid"
            )
        if len(adjustment["reason"]) > 200:
            raise ReplaySourceError(
                "typed conviction adjustment reason is too long"
            )
        kind_ref = adjustment.get("kind_ref")
        source_ref = adjustment.get("source_ref")
        if kind_ref is not None and kind_ref not in _CATALYST_KINDS:
            raise ReplaySourceError(
                "typed conviction adjustment kind_ref is invalid"
            )
        if source_ref is not None and (
            not isinstance(source_ref, str) or not source_ref
        ):
            raise ReplaySourceError(
                "typed conviction adjustment source_ref is invalid"
            )
        delta += float(adjustment["delta"])
    if not -20.0 <= delta <= 20.0:
        raise ReplaySourceError(
            "typed conviction adjustment sum is out of range"
        )
    expected_final = max(0.0, min(100.0, float(base) + delta))
    if abs(float(final) - expected_final) > 0.01:
        raise ReplaySourceError("typed conviction final is inconsistent")
    expected_level = (
        "HIGH" if float(final) >= 75 else "MED" if float(final) >= 50 else "LOW"
    )
    if conviction["level"] != expected_level:
        raise ReplaySourceError("typed conviction level relation mismatch")

    gate = risk_gate.get("gate")
    if (
        gate not in _RISK_GATES
        or risk_gate.get("ok_to_enter") is not (gate == "GREEN")
        or not isinstance(risk_gate.get("triggers"), list)
    ):
        raise ReplaySourceError("typed risk gate contract mismatch")
    triggers = risk_gate["triggers"]
    for trigger in triggers:
        if not isinstance(trigger, Mapping):
            raise ReplaySourceError("typed risk trigger must be an object")
        _require_exact_keys(
            trigger,
            SOURCE_RISK_TRIGGER_KEYS,
            "features.risk_gate.triggers[]",
        )
        if (
            trigger.get("code") not in _RISK_TRIGGER_CODES
            or trigger.get("severity") not in _RISK_SEVERITIES
            or not isinstance(trigger.get("detail"), str)
            or not trigger.get("detail")
            or len(trigger["detail"]) > 240
        ):
            raise ReplaySourceError("typed risk trigger is invalid")
    expected_gate = (
        "RED"
        if any(trigger["severity"] == "block" for trigger in triggers)
        else "YELLOW"
        if any(trigger["severity"] == "warn" for trigger in triggers)
        else "GREEN"
    )
    if gate != expected_gate:
        raise ReplaySourceError("typed risk gate severity relation mismatch")

    size_hint = entry_plan.get("size_hint")
    if not isinstance(size_hint, Mapping):
        raise ReplaySourceError("typed entry plan size_hint is required")
    _require_exact_keys(
        size_hint,
        SOURCE_SIZE_HINT_KEYS,
        "features.entry_plan.size_hint",
    )
    tier = size_hint.get("tier")
    rationale = size_hint.get("rationale")
    if (
        tier not in _SIZE_TIERS
        or size_hint.get("pct") != _SIZE_TIERS[tier]
        or size_hint.get("disclaimer_key") != "size_hint_advisory"
        or not isinstance(rationale, str)
        or not rationale
        or len(rationale) > 240
    ):
        raise ReplaySourceError("typed entry plan size_hint mismatch")
    expected_tier = (
        "TIER_5"
        if float(final) >= 85
        else "TIER_3"
        if float(final) >= 70
        else "TIER_2"
        if float(final) >= 55
        else "TIER_1"
        if float(final) >= 40
        else "SKIP"
    )
    if tier != expected_tier:
        raise ReplaySourceError(
            "typed entry plan size_hint does not match conviction"
        )

    entry = entry_plan.get("entry")
    stop = entry_plan.get("stop")
    targets = entry_plan.get("targets")
    if not isinstance(entry, Mapping):
        raise ReplaySourceError("typed entry plan entry is required")
    if not isinstance(stop, Mapping):
        raise ReplaySourceError("typed entry plan stop is required")
    _require_exact_keys(entry, SOURCE_PRICE_BAND_KEYS, "features.entry_plan.entry")
    _require_exact_keys(stop, SOURCE_PRICE_KEYS, "features.entry_plan.stop")
    if (
        not _finite_number(entry.get("low"))
        or not _finite_number(entry.get("high"))
        or float(entry["low"]) > float(entry["high"])
        or entry.get("currency") not in _CURRENCIES
        or not _finite_number(stop.get("value"))
        or stop.get("currency") not in _CURRENCIES
    ):
        raise ReplaySourceError("typed entry plan price band/stop is invalid")
    if not isinstance(targets, list) or not 1 <= len(targets) <= 3:
        raise ReplaySourceError("typed entry plan targets must contain 1..3 prices")
    for target in targets:
        if not isinstance(target, Mapping):
            raise ReplaySourceError("typed entry plan target is invalid")
        _require_exact_keys(
            target,
            SOURCE_PRICE_KEYS,
            "features.entry_plan.targets[]",
        )
        if (
            not _finite_number(target.get("value"))
            or target.get("currency") not in _CURRENCIES
        ):
            raise ReplaySourceError("typed entry plan target is invalid")
    if entry_plan.get("time_horizon") not in _TIME_HORIZONS:
        raise ReplaySourceError("typed entry plan time_horizon is invalid")
    invalidation = entry_plan.get("invalidation")
    if (
        not isinstance(invalidation, str)
        or not invalidation
        or len(invalidation) > 500
    ):
        raise ReplaySourceError("typed entry plan invalidation is invalid")
    if not _finite_range(
        entry_plan.get("stop_distance_pct"), 0.0, 100.0
    ):
        raise ReplaySourceError(
            "typed entry plan stop_distance_pct is invalid"
        )
    return _json_value(features)


def _finite_range(value: object, minimum: float, maximum: float) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and minimum <= float(value) <= maximum
    )


def _finite_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _require_exact_keys(
    value: Mapping[str, Any], expected: frozenset[str], path: str
) -> None:
    if set(value) != set(expected):
        raise ReplaySourceError(f"{path} must contain exact source keys")


def _rating_for(value: float) -> str:
    if value >= 85:
        return "A"
    if value >= 70:
        return "B"
    if value >= 55:
        return "C"
    if value >= 40:
        return "D"
    return "F"
