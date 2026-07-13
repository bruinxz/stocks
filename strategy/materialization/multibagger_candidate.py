"""Deterministic source-fact -> multibagger candidate materialization.

Storage facts never own Strategy outputs. A caller must inject a complete
Strategy decision and an auditable stage/conclusion classification. This
module binds and authenticates those inputs without fetching data or inventing
scores, convictions, risk gates, entry plans, stages, or conclusions.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
import hashlib
from typing import Any, Mapping, Optional, Protocol, Sequence, Tuple
from uuid import UUID

from ai.snapshot.fingerprint import jcs_canonicalize
from ai.types import RISK_TRIGGER_CODES
from strategy.reporting import (
    parse_utc_seconds,
    require_finite_number,
    validate_conviction,
    validate_entry_plan,
    validate_score_snapshot,
)
from strategy.reporting.tab67_projection import (
    CATALYST_KINDS,
    RISK_TRIGGER_KEYS,
    RISK_TRIGGER_RULES,
)


MARKET_EXCHANGES = {
    "cn_a": frozenset(("sh", "sz", "bj")),
    "us": frozenset(("nyse", "nasdaq")),
    "jp": frozenset(("tse", "ose")),
    "kr": frozenset(("krx", "kosdaq")),
}
MULTIBAGGER_PROFILE = {
    "cn_a": "multibagger",
    "us": "multibagger",
    "jp": "japan_multibagger",
    "kr": "korea_multibagger",
}
STAGES = frozenset(("seed", "early", "growth", "break_below", "deep"))
CONCLUSIONS = frozenset(
    ("MULTIBAGGER_2X", "MULTIBAGGER_5X", "MULTIBAGGER_10X", "SKIP")
)
HIT_KINDS = frozenset(("OPTIONALITY", "POSITIVE", "NEGATIVE", "EARLY_NEWS"))
SCORE_DIMENSIONS = ("quality", "growth", "valuation", "moat", "trend", "risk")
SCORE_KEYS = frozenset(
    (
        "scoring_id",
        "snapshot_hash",
        "ticker",
        "as_of",
        "market_scope",
        *SCORE_DIMENSIONS,
        "weights",
        "weights_profile",
        "total",
        "rating",
        "computed_at",
        "source_versions",
    )
)
DIMENSION_KEYS = frozenset(("score", "band", "evidence", "inputs"))
SOURCE_VERSION_KEYS = frozenset(
    (
        "quality_engine",
        "growth_engine",
        "valuation_engine",
        "moat_engine",
        "trend_engine",
        "risk_engine",
    )
)
RISK_GATE_KEYS = frozenset(
    ("ticker", "evaluated_at", "gate", "triggers", "ok_to_enter")
)
CATALYST_KEYS = frozenset(
    ("kind", "title", "occurred_at", "source_ref", "fact_hash")
)
HEX = frozenset("0123456789abcdef")


class CandidateMaterializationError(ValueError):
    pass


class CandidateIdempotencyConflict(RuntimeError):
    pass


def _fail(message: str) -> None:
    raise CandidateMaterializationError(message)


def _require_exact_keys(value: Mapping[str, Any], expected: frozenset, field: str) -> None:
    actual = frozenset(value)
    if actual != expected:
        _fail(
            "{} key mismatch missing={} extra={}".format(
                field, sorted(expected - actual), sorted(actual - expected)
            )
        )


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value.isspace():
        _fail("{} is required".format(field))
    return value


def _require_number(value: Any, field: str, lower: float, upper: float) -> float:
    try:
        numeric = require_finite_number(value, field)
    except ValueError as error:
        raise CandidateMaterializationError(str(error)) from error
    if numeric < lower or numeric > upper:
        _fail("{} is out of range".format(field))
    return numeric


def _require_utc(value: datetime, field: str) -> None:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() != timedelta(0)
        or value.microsecond
    ):
        _fail("{} must be UTC seconds".format(field))


def _utc_text(value: datetime) -> str:
    _require_utc(value, "timestamp")
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _require_hash(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in HEX for character in value)
    ):
        _fail("{} must be lowercase SHA-256".format(field))
    return value


def _require_uuid4(value: Any, field: str) -> str:
    try:
        parsed = UUID(value)
    except (TypeError, ValueError, AttributeError):
        _fail("{} must be UUIDv4".format(field))
    if parsed.version != 4 or str(parsed) != value:
        _fail("{} must be canonical UUIDv4".format(field))
    return value


def _band(score: float) -> str:
    return (
        "A"
        if score >= 85
        else "B"
        if score >= 70
        else "C"
        if score >= 55
        else "D"
        if score >= 40
        else "F"
    )


def _canonical_hash(value: object) -> str:
    return hashlib.sha256(jcs_canonicalize(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class UniverseFact:
    market_scope: str
    provider_market_label: Optional[str]
    exchange: str
    ticker: str
    record_kind: str
    universe_source_kind: str
    source_document_id: str
    source_version: str
    effective_at_utc: datetime
    available_at_utc: datetime
    as_of_utc: datetime
    features: Mapping[str, Any]
    evidence_refs: Tuple[str, ...]
    text_hit_kinds: Tuple[str, ...]
    fundamental_snapshot: Mapping[str, Any]
    filter_pass_bitmap: int
    market_cap_cny_100m: Optional[str]
    fact_hash: str


@dataclass(frozen=True)
class TextHitFact:
    market_scope: str
    ticker: str
    source_kind: str
    source_document_id: str
    document_fact_hash: str
    taxonomy_version: str
    term_id: str
    hit_kind: str
    language: str
    field: str
    start_offset: int
    end_offset: int
    context_hash: str
    effective_at_utc: datetime
    available_at_utc: datetime


@dataclass(frozen=True)
class StrategyDecision:
    score: Mapping[str, Any]
    conviction: Mapping[str, Any]
    risk_gate: Mapping[str, Any]
    entry_plan: Optional[Mapping[str, Any]]
    strategy_version: str


@dataclass(frozen=True)
class LatestCatalyst:
    kind: str
    title: str
    occurred_at: datetime
    source_ref: str
    fact_hash: str


@dataclass(frozen=True)
class ClassificationDecision:
    stage: str
    conclusion: str
    policy_version: str
    reason_codes: Tuple[str, ...]


class ClassificationPolicy(Protocol):
    def classify(
        self,
        sources: Sequence[UniverseFact],
        text_hits: Sequence[TextHitFact],
        decision: StrategyDecision,
    ) -> ClassificationDecision:
        ...


class CandidateStore(Protocol):
    def write_or_verify(self, candidate: "CandidateSnapshot") -> "CandidateSnapshot":
        ...


@dataclass(frozen=True)
class MaterializationInput:
    market_scope: str
    exchange: str
    ticker: str
    as_of_utc: datetime
    sources: Tuple[UniverseFact, ...]
    text_hits: Tuple[TextHitFact, ...]
    decision: StrategyDecision
    latest_catalyst: Optional[LatestCatalyst] = None


@dataclass(frozen=True)
class CandidateSnapshot:
    market_scope: str
    exchange: str
    ticker: str
    as_of_utc: str
    available_at_utc: str
    stage: str
    conclusion: str
    score: Mapping[str, Any]
    rating: str
    conviction: Mapping[str, Any]
    risk_gate: Mapping[str, Any]
    entry_plan: Optional[Mapping[str, Any]]
    latest_catalyst: Optional[Mapping[str, Any]]
    source_fact_hashes: Tuple[str, ...]
    strategy_version: str
    classification_policy_version: str
    classification_reason_codes: Tuple[str, ...]
    fact_hash: str

    @property
    def identity(self) -> Tuple[str, str, str, str, str]:
        return (
            self.market_scope,
            self.exchange,
            self.ticker,
            self.as_of_utc,
            self.strategy_version,
        )


CANDIDATE_ROW_KEYS = frozenset(
    (
        "market_scope",
        "exchange",
        "ticker",
        "as_of_utc",
        "available_at_utc",
        "stage",
        "conclusion",
        "score",
        "rating",
        "conviction",
        "risk_gate",
        "entry_plan",
        "latest_catalyst",
        "source_fact_hashes",
        "strategy_version",
        "classification_policy_version",
        "classification_reason_codes",
        "fact_hash",
    )
)


def candidate_to_row(candidate: CandidateSnapshot) -> Mapping[str, Any]:
    return {
        "market_scope": candidate.market_scope,
        "exchange": candidate.exchange,
        "ticker": candidate.ticker,
        "as_of_utc": candidate.as_of_utc,
        "available_at_utc": candidate.available_at_utc,
        "stage": candidate.stage,
        "conclusion": candidate.conclusion,
        "score": dict(candidate.score),
        "rating": candidate.rating,
        "conviction": dict(candidate.conviction),
        "risk_gate": dict(candidate.risk_gate),
        "entry_plan": None if candidate.entry_plan is None else dict(candidate.entry_plan),
        "latest_catalyst": candidate.latest_catalyst,
        "source_fact_hashes": list(candidate.source_fact_hashes),
        "strategy_version": candidate.strategy_version,
        "classification_policy_version": candidate.classification_policy_version,
        "classification_reason_codes": list(candidate.classification_reason_codes),
        "fact_hash": candidate.fact_hash,
    }


def candidate_from_row(row: Mapping[str, Any]) -> CandidateSnapshot:
    _require_exact_keys(row, CANDIDATE_ROW_KEYS, "candidate row")
    classification = ClassificationDecision(
        stage=row["stage"],
        conclusion=row["conclusion"],
        policy_version=_require_string(
            row["classification_policy_version"], "classification_policy_version"
        ),
        reason_codes=tuple(row["classification_reason_codes"]),
    )
    if (
        not classification.reason_codes
        or tuple(sorted(set(classification.reason_codes)))
        != classification.reason_codes
    ):
        _fail("classification_reason_codes must be sorted and unique")
    candidate = CandidateSnapshot(
        market_scope=row["market_scope"],
        exchange=row["exchange"],
        ticker=row["ticker"],
        as_of_utc=row["as_of_utc"],
        available_at_utc=row["available_at_utc"],
        stage=classification.stage,
        conclusion=classification.conclusion,
        score=dict(row["score"]),
        rating=row["rating"],
        conviction=dict(row["conviction"]),
        risk_gate=dict(row["risk_gate"]),
        entry_plan=None if row["entry_plan"] is None else dict(row["entry_plan"]),
        latest_catalyst=row["latest_catalyst"],
        source_fact_hashes=tuple(row["source_fact_hashes"]),
        strategy_version=row["strategy_version"],
        classification_policy_version=classification.policy_version,
        classification_reason_codes=classification.reason_codes,
        fact_hash=row["fact_hash"],
    )
    body = dict(row)
    body.pop("fact_hash")
    if _canonical_hash(body) != _require_hash(candidate.fact_hash, "candidate fact_hash"):
        _fail("candidate fact_hash does not authenticate physical row")
    return candidate


def _universe_body(fact: UniverseFact) -> Mapping[str, Any]:
    return {
        "as_of_utc": _utc_text(fact.as_of_utc),
        "available_at_utc": _utc_text(fact.available_at_utc),
        "effective_at_utc": _utc_text(fact.effective_at_utc),
        "evidence_refs": list(fact.evidence_refs),
        "exchange": fact.exchange,
        "features": dict(fact.features),
        "filter_pass_bitmap": fact.filter_pass_bitmap,
        "fundamental_snapshot": dict(fact.fundamental_snapshot),
        "market_cap_cny_100m": fact.market_cap_cny_100m,
        "market_scope": fact.market_scope,
        "provider_market_label": fact.provider_market_label,
        "record_kind": fact.record_kind,
        "source_document_id": fact.source_document_id,
        "source_version": fact.source_version,
        "text_hit_kinds": list(fact.text_hit_kinds),
        "ticker": fact.ticker,
        "universe_source_kind": fact.universe_source_kind,
    }


def _validate_universe_fact(fact: UniverseFact, request: MaterializationInput) -> None:
    if (
        fact.market_scope != request.market_scope
        or fact.exchange != request.exchange
        or fact.ticker != request.ticker
    ):
        _fail("universe fact identity mismatch")
    for field in ("effective_at_utc", "available_at_utc", "as_of_utc"):
        _require_utc(getattr(fact, field), field)
    if fact.available_at_utc > request.as_of_utc or fact.as_of_utc > request.as_of_utc:
        _fail("universe fact is not PIT-visible")
    if isinstance(fact.filter_pass_bitmap, bool) or not isinstance(
        fact.filter_pass_bitmap, int
    ) or fact.filter_pass_bitmap < 0:
        _fail("filter_pass_bitmap is invalid")
    jcs_canonicalize(_universe_body(fact))
    expected_hash = _canonical_hash(_universe_body(fact))
    if _require_hash(fact.fact_hash, "universe fact_hash") != expected_hash:
        _fail("universe fact_hash mismatch")


def _validate_text_hit(hit: TextHitFact, request: MaterializationInput) -> None:
    if hit.market_scope != request.market_scope or hit.ticker != request.ticker:
        _fail("text hit identity mismatch")
    if hit.hit_kind not in HIT_KINDS or hit.field not in ("TITLE", "BODY"):
        _fail("text hit enum is invalid")
    if (
        isinstance(hit.start_offset, bool)
        or isinstance(hit.end_offset, bool)
        or not isinstance(hit.start_offset, int)
        or not isinstance(hit.end_offset, int)
        or hit.start_offset < 0
        or hit.end_offset <= hit.start_offset
    ):
        _fail("text hit offsets are invalid")
    _require_utc(hit.effective_at_utc, "text hit effective_at_utc")
    _require_utc(hit.available_at_utc, "text hit available_at_utc")
    if hit.available_at_utc > request.as_of_utc:
        _fail("text hit is not PIT-visible")
    _require_hash(hit.document_fact_hash, "document_fact_hash")
    _require_hash(hit.context_hash, "context_hash")
    for value, field in (
        (hit.source_kind, "text hit source_kind"),
        (hit.source_document_id, "text hit source_document_id"),
        (hit.taxonomy_version, "taxonomy_version"),
        (hit.term_id, "term_id"),
    ):
        _require_string(value, field)


def _score_projection(score: Mapping[str, Any]) -> Tuple[Mapping[str, Any], float]:
    _require_exact_keys(score, SCORE_KEYS, "score")
    _require_string(score["ticker"], "score.ticker")
    _require_string(score["as_of"], "score.as_of")
    parse_utc_seconds(score["computed_at"], "score.computed_at")
    _require_exact_keys(score["weights"], frozenset(SCORE_DIMENSIONS), "score.weights")
    _require_exact_keys(score["source_versions"], SOURCE_VERSION_KEYS, "score.source_versions")
    for key, value in score["source_versions"].items():
        _require_string(value, "score.source_versions." + key)
    dims = []
    for key, name in zip(("Q", "G", "V", "M", "T", "R"), SCORE_DIMENSIONS):
        dimension = score[name]
        _require_exact_keys(dimension, DIMENSION_KEYS, "score." + name)
        if not isinstance(dimension["evidence"], list) or not dimension["evidence"]:
            _fail("dimension evidence must be non-empty")
        if any(
            not isinstance(item, str) or not item or len(item) > 200
            for item in dimension["evidence"]
        ):
            _fail("dimension evidence is invalid")
        jcs_canonicalize(dimension["inputs"])
        dims.append(
            {
                "key": key,
                "score": dimension["score"],
                "band": dimension["band"],
                "weight": score["weights"][name],
            }
        )
    projection = {
        "scoring_id": score["scoring_id"],
        "snapshot_hash": score["snapshot_hash"],
        "profile": score["weights_profile"],
        "market_scope": score["market_scope"],
        "total": score["total"],
        "rating": score["rating"],
        "dims": dims,
    }
    try:
        validate_score_snapshot(
            projection,
            "score",
            score["weights_profile"],
            score["market_scope"],
        )
    except ValueError as error:
        raise CandidateMaterializationError(str(error)) from error
    snapshot_body = dict(score)
    snapshot_body.pop("scoring_id")
    snapshot_body.pop("snapshot_hash")
    if score["snapshot_hash"] != _canonical_hash(snapshot_body):
        _fail("score.snapshot_hash mismatch")
    return projection, float(score["total"])


def _validate_decision(request: MaterializationInput) -> str:
    decision = request.decision
    _require_string(decision.strategy_version, "strategy_version")
    score = decision.score
    if score.get("weights_profile") != MULTIBAGGER_PROFILE[request.market_scope]:
        _fail("decision profile and market_scope mismatch")
    if score.get("ticker") != request.ticker or score.get("market_scope") != request.market_scope:
        _fail("score identity mismatch")
    if score.get("as_of") not in (
        request.as_of_utc.date().isoformat(),
        _utc_text(request.as_of_utc),
    ):
        _fail("score as_of mismatch")
    projection, total = _score_projection(score)
    conviction = decision.conviction
    try:
        final, _ = validate_conviction(
            conviction,
            "conviction",
            request.ticker,
            score["as_of"],
            score["scoring_id"],
            score["snapshot_hash"],
            total,
        )
    except ValueError as error:
        raise CandidateMaterializationError(str(error)) from error

    risk_gate = decision.risk_gate
    _require_exact_keys(risk_gate, RISK_GATE_KEYS, "risk_gate")
    if risk_gate["ticker"] != request.ticker or not isinstance(risk_gate["triggers"], list):
        _fail("risk_gate identity invalid")
    parse_utc_seconds(risk_gate["evaluated_at"], "risk_gate.evaluated_at")
    severities = []
    for trigger in risk_gate["triggers"]:
        _require_exact_keys(trigger, RISK_TRIGGER_KEYS, "risk trigger")
        code = trigger.get("code")
        if code not in RISK_TRIGGER_CODES or code not in RISK_TRIGGER_RULES:
            _fail("risk trigger code invalid")
        severity, scopes = RISK_TRIGGER_RULES[code]
        if trigger.get("severity") != severity or request.market_scope not in scopes:
            _fail("risk trigger severity or market invalid")
        detail = _require_string(trigger.get("detail"), "risk trigger detail")
        if len(detail) > 240:
            _fail("risk trigger detail is too long")
        severities.append(severity)
    expected_gate = "RED" if "block" in severities else "YELLOW" if "warn" in severities else "GREEN"
    if risk_gate["gate"] != expected_gate or risk_gate["ok_to_enter"] != (expected_gate == "GREEN"):
        _fail("risk gate derivation mismatch")

    if decision.entry_plan is not None:
        try:
            validate_entry_plan(
                decision.entry_plan,
                "entry_plan",
                request.ticker,
                final,
                score["scoring_id"],
                score["snapshot_hash"],
            )
        except ValueError as error:
            raise CandidateMaterializationError(str(error)) from error
    return projection["rating"]


def _candidate_body(
    request: MaterializationInput,
    classification: ClassificationDecision,
    source_hashes: Tuple[str, ...],
    rating: str,
    available_at_utc: datetime,
) -> Mapping[str, Any]:
    return {
        "as_of_utc": _utc_text(request.as_of_utc),
        "available_at_utc": _utc_text(available_at_utc),
        "classification_policy_version": classification.policy_version,
        "classification_reason_codes": list(classification.reason_codes),
        "conclusion": classification.conclusion,
        "conviction": dict(request.decision.conviction),
        "entry_plan": None if request.decision.entry_plan is None else dict(request.decision.entry_plan),
        "exchange": request.exchange,
        "latest_catalyst": (
            None
            if request.latest_catalyst is None
            else {
                "kind": request.latest_catalyst.kind,
                "title": request.latest_catalyst.title,
                "occurred_at": _utc_text(request.latest_catalyst.occurred_at),
                "source_ref": request.latest_catalyst.source_ref,
                "fact_hash": request.latest_catalyst.fact_hash,
            }
        ),
        "market_scope": request.market_scope,
        "rating": rating,
        "risk_gate": dict(request.decision.risk_gate),
        "score": dict(request.decision.score),
        "source_fact_hashes": list(source_hashes),
        "stage": classification.stage,
        "strategy_version": request.decision.strategy_version,
        "ticker": request.ticker,
    }


def materialize_candidate(
    request: MaterializationInput, policy: ClassificationPolicy
) -> CandidateSnapshot:
    if request.market_scope not in MARKET_EXCHANGES:
        _fail("market_scope is invalid")
    if request.exchange not in MARKET_EXCHANGES[request.market_scope]:
        _fail("market_scope and exchange mismatch")
    if not request.ticker or request.ticker.startswith("__AGGREGATE__:"):
        _fail("ticker is invalid")
    _require_utc(request.as_of_utc, "as_of_utc")
    if not request.sources:
        _fail("at least one universe source fact is required")
    for source in request.sources:
        _validate_universe_fact(source, request)
    for hit in request.text_hits:
        _validate_text_hit(hit, request)
    rating = _validate_decision(request)
    classification = policy.classify(request.sources, request.text_hits, request.decision)
    reason_codes = tuple(sorted(set(classification.reason_codes)))
    if (
        classification.stage not in STAGES
        or classification.conclusion not in CONCLUSIONS
        or not classification.policy_version
        or not reason_codes
        or any(not code for code in reason_codes)
    ):
        _fail("classification is invalid")
    classification = ClassificationDecision(
        stage=classification.stage,
        conclusion=classification.conclusion,
        policy_version=classification.policy_version,
        reason_codes=reason_codes,
    )
    if (
        request.decision.risk_gate["ok_to_enter"] is not True
        or request.decision.entry_plan is None
    ) and classification.conclusion != "SKIP":
        _fail("closed gate or missing EntryPlan requires SKIP")
    if request.latest_catalyst is not None:
        catalyst = request.latest_catalyst
        if catalyst.kind not in CATALYST_KINDS or catalyst.kind == "unclassified":
            _fail("latest catalyst kind is invalid")
        _require_string(catalyst.title, "latest catalyst title")
        _require_utc(catalyst.occurred_at, "latest catalyst occurred_at")
        if catalyst.occurred_at > request.as_of_utc:
            _fail("latest catalyst is not PIT-visible")
        _require_string(catalyst.source_ref, "latest catalyst source_ref")
        _require_hash(catalyst.fact_hash, "latest catalyst fact_hash")
        expected = _canonical_hash(
            {
                "kind": catalyst.kind,
                "title": catalyst.title,
                "occurred_at": _utc_text(catalyst.occurred_at),
                "source_ref": catalyst.source_ref,
            }
        )
        if catalyst.fact_hash != expected:
            _fail("latest catalyst fact_hash mismatch")
    source_hashes = tuple(
        sorted(
            {source.fact_hash for source in request.sources}
            | {hit.document_fact_hash for hit in request.text_hits}
            | {hit.context_hash for hit in request.text_hits}
        )
    )
    if not source_hashes:
        _fail("source closure is empty")
    available = max(
        [source.available_at_utc for source in request.sources]
        + [hit.available_at_utc for hit in request.text_hits]
    )
    body = _candidate_body(request, classification, source_hashes, rating, available)
    fact_hash = _canonical_hash(body)
    candidate = CandidateSnapshot(
        market_scope=request.market_scope,
        exchange=request.exchange,
        ticker=request.ticker,
        as_of_utc=body["as_of_utc"],
        available_at_utc=body["available_at_utc"],
        stage=classification.stage,
        conclusion=classification.conclusion,
        score=body["score"],
        rating=rating,
        conviction=body["conviction"],
        risk_gate=body["risk_gate"],
        entry_plan=body["entry_plan"],
        latest_catalyst=body["latest_catalyst"],
        source_fact_hashes=source_hashes,
        strategy_version=request.decision.strategy_version,
        classification_policy_version=classification.policy_version,
        classification_reason_codes=classification.reason_codes,
        fact_hash=fact_hash,
    )
    # Ensure the public physical row representation is exactly the authenticated
    # body plus fact_hash, including classification provenance.
    if candidate_from_row(candidate_to_row(candidate)) != candidate:
        _fail("candidate physical row roundtrip mismatch")
    return candidate


def write_or_verify_candidate(
    store: CandidateStore, candidate: CandidateSnapshot
) -> CandidateSnapshot:
    return store.write_or_verify(candidate)
