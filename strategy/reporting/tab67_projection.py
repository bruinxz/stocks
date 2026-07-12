"""Pure v0.3.1 RecommendationList -> CatDesk Tab 6/7 projections.

This module deliberately owns no database, HTTP, clock, or outcome lookup.
Recommendation snapshot/item storage remains the sole archive source of truth.
The projections are deterministic views over validated RecommendationList
envelopes and preserve every list item byte-for-byte at the Python value level.
"""

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from uuid import UUID

from ai.snapshot.fingerprint import compute_output_fingerprint
from ai.types import (
    CANONICAL_URI_PREFIXES,
    RISK_TRIGGER_CODES,
    SIZE_HINT_TIER_PCT,
)
from ai.validation.output_validator import OutputValidator
from strategy.reporting.types import DailyReportDto, ReportHistoryDto

PROJECTION_VERSION = "0.1.0"
CONTRACT_VERSION = "0.3.1"

PROFILE_SCOPE = {
    "us_preferred": frozenset(("cn_a", "us")),
    "multibagger": frozenset(("cn_a", "us")),
    "japan_blue_chip": frozenset(("jp",)),
    "korea_semiconductor_chain": frozenset(("kr",)),
    "japan_multibagger": frozenset(("jp",)),
    "korea_multibagger": frozenset(("kr",)),
}
PROFILE_ORDER = tuple(PROFILE_SCOPE)
MARKET_ORDER = ("cn_a", "us", "jp", "kr")
BANDS = ("A", "B", "C", "D", "F")
LANGUAGES = ("zh-CN", "en-US", "ja-JP", "ko-KR")
SCORE_DIM_KEYS = ("Q", "G", "V", "M", "T", "R")
TRIGGER_SIGNAL_CODES = frozenset(
    (
        "CATALYST_MATCHED",
        "CONVICTION_HIGH",
        "SCORE_TOTAL_TOP",
        "DIM_BAND_A",
        "RISK_GATE_CLEAN",
        "ENTRY_PLAN_TIGHT",
        "EVENT_FRESH",
        "SECTOR_MOMENTUM",
        "RULE_MATCHED",
        "MODEL_INFERENCE",
    )
)
CATALYST_KINDS = frozenset(
    (
        "earnings",
        "upgrade_downgrade",
        "product",
        "regulator",
        "geo_macro",
        "ma_activity",
        "sector_move",
        "leadership",
        "unclassified",
    )
)
TIME_HORIZONS = frozenset(
    ("INTRADAY", "SWING", "POSITION", "CORE_HOLD", "LONG_TERM")
)
CURRENCIES = frozenset(("USD", "CNY", "HKD", "JPY", "KRW"))
PROFILE_LANGUAGES = {
    "us_preferred": frozenset(("zh-CN", "en-US")),
    "multibagger": frozenset(("zh-CN", "en-US")),
    "japan_blue_chip": frozenset(("ja-JP",)),
    "japan_multibagger": frozenset(("ja-JP",)),
    "korea_semiconductor_chain": frozenset(("ko-KR",)),
    "korea_multibagger": frozenset(("ko-KR",)),
}
RISK_TRIGGER_RULES = {
    "EARNINGS_T-2": ("warn", frozenset(("us",))),
    "EARNINGS_T-0": ("block", frozenset(("us",))),
    "HALT_ACTIVE": ("block", frozenset(("us",))),
    "MERGER_PENDING": ("warn", frozenset(("us",))),
    "LITIGATION_MATERIAL": ("warn", frozenset(("us",))),
    "IV_SHOCK": ("warn", frozenset(("us",))),
    "LIQUIDITY_LOW": ("warn", frozenset(("us",))),
    "RESTATEMENT_30D": ("block", frozenset(("us",))),
    "DELISTING_NOTICE": ("block", frozenset(("us",))),
    "ST_TAG": ("block", frozenset(("cn_a",))),
    "PRICE_LIMIT_APPROACH": ("warn", frozenset(("cn_a",))),
    "SUSPENDED": ("block", frozenset(("cn_a",))),
    "TSE_HALT": ("block", frozenset(("jp",))),
    "EDINET_DELAY": ("warn", frozenset(("jp",))),
    "CORPORATE_GOVERNANCE_ISSUE": ("warn", frozenset(("jp",))),
    "TSE_TOKUBETSU_CHI": ("warn", frozenset(("jp",))),
    "TSE_KANRI": ("block", frozenset(("jp",))),
    "KRX_HALT": ("block", frozenset(("kr",))),
    "DART_LATE_FILING": ("warn", frozenset(("kr",))),
    "INSIDER_TRADING_FLAG": ("block", frozenset(("kr",))),
    "KRX_UNFAITHFUL": ("warn", frozenset(("kr",))),
    "KRX_INVESTOR_ALERT": ("warn", frozenset(("kr",))),
}

TOP_LEVEL_KEYS = frozenset(
    (
        "snapshot_id",
        "as_of",
        "profile",
        "market_scope",
        "items",
        "output_fingerprint",
        "disclaimer",
        "meta",
    )
)
META_KEYS = frozenset(
    (
        "contract_version",
        "profile_version",
        "input_fingerprint",
        "strategy_version",
        "pipeline_version",
        "generated_by",
        "generation_ms",
    )
)
DISCLAIMER_KEYS = frozenset(
    ("version", "short_text", "full_text", "language", "effective_at", "hash")
)
ITEM_KEYS = frozenset(("recommendation", "rating_band"))
SCORE_KEYS = frozenset(
    (
        "scoring_id",
        "snapshot_hash",
        "profile",
        "market_scope",
        "total",
        "rating",
        "dims",
    )
)
SCORE_DIM_KEYS_SET = frozenset(("key", "score", "band", "weight"))
CONVICTION_KEYS = frozenset(
    ("ticker", "as_of", "base", "score_ref", "adjustments", "final", "level")
)
SCORE_REF_KEYS = frozenset(("scoring_id", "snapshot_hash"))
ADJUSTMENT_REQUIRED_KEYS = frozenset(("delta", "reason"))
ADJUSTMENT_ALLOWED_KEYS = ADJUSTMENT_REQUIRED_KEYS | frozenset(
    ("kind_ref", "source_ref")
)
RISK_GATE_KEYS = frozenset(
    ("ticker", "evaluated_at", "gate", "triggers", "ok_to_enter")
)
RISK_TRIGGER_KEYS = frozenset(("code", "severity", "detail"))
ENTRY_PLAN_KEYS = frozenset(
    (
        "ticker",
        "generated_at",
        "entry",
        "stop",
        "targets",
        "size_hint",
        "time_horizon",
        "invalidation",
        "conviction_ref",
        "score_ref",
    )
)
PRICE_BAND_KEYS = frozenset(("low", "high", "currency"))
PRICE_KEYS = frozenset(("value", "currency"))
SIZE_HINT_KEYS = frozenset(
    ("tier", "pct", "disclaimer_key", "rationale")
)
TRIGGER_SIGNAL_REQUIRED_KEYS = frozenset(("code", "strength", "detail"))
TRIGGER_SIGNAL_ALLOWED_KEYS = TRIGGER_SIGNAL_REQUIRED_KEYS | frozenset(
    ("source_ref",)
)
WEIGHT_ATTRIBUTION_KEYS = frozenset(("contributions", "normalized"))
CONTRIBUTION_REQUIRED_KEYS = frozenset(("source_kind", "source_ref", "weight"))
CONTRIBUTION_ALLOWED_KEYS = CONTRIBUTION_REQUIRED_KEYS | frozenset(("note",))
EXPLANATION_KEYS = frozenset(
    ("headline", "body", "caveats", "language", "template_id", "template_hash")
)
RECOMMENDATION_KEYS = frozenset(
    (
        "id",
        "snapshot_id",
        "ticker",
        "as_of",
        "score",
        "conviction",
        "risk_gate",
        "entry_plan",
        "catalyst_relevance",
        "trigger_signals",
        "weights",
        "explanation",
        "evidence_refs",
        "model_version",
        "disclaimer_version",
    )
)

HEX_64 = re.compile(r"^[0-9a-f]{64}$")
EVIDENCE_MARKER = re.compile(r"\[E(\d+)\]")
SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ProjectionContractError(ValueError):
    """Raised when projection input is not a strict v0.3.1 envelope."""


def _fail(path: str, message: str) -> None:
    raise ProjectionContractError("{}: {}".format(path, message))


def _require_mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(path, "must be an object")
    return value


def _require_exact_keys(
    value: Mapping[str, Any], expected: frozenset, path: str
) -> None:
    actual = frozenset(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        _fail(path, "key mismatch missing={} extra={}".format(missing, extra))


def _require_nonempty_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(path, "must be a non-empty string")
    return value


def _require_hash(value: Any, path: str) -> str:
    text = _require_nonempty_string(value, path)
    if not HEX_64.fullmatch(text):
        _fail(path, "must be a lowercase SHA-256 hex digest")
    return text


def _require_uuid4(value: Any, path: str) -> str:
    text = _require_nonempty_string(value, path)
    try:
        parsed = UUID(text)
    except (ValueError, AttributeError):
        _fail(path, "must be a UUIDv4")
    if parsed.version != 4 or str(parsed) != text.lower():
        _fail(path, "must be a canonical lowercase UUIDv4")
    return text


def _require_semver(value: Any, path: str) -> str:
    text = _require_nonempty_string(value, path)
    if not SEMVER.fullmatch(text):
        _fail(path, "must be SemVer")
    return text


def _require_day(value: Any, path: str) -> str:
    text = _require_nonempty_string(value, path)
    if not DAY.fullmatch(text):
        _fail(path, "must be YYYY-MM-DD")
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        _fail(path, "must be a valid calendar date")
    return text


def _parse_utc_seconds(value: Any, path: str) -> datetime:
    text = _require_nonempty_string(value, path)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", text):
        _fail(path, "must be ISO8601 UTC seconds (YYYY-MM-DDTHH:MM:SSZ)")
    parsed = datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
    return parsed.replace(tzinfo=timezone.utc)


def _require_number(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "must be a number")
    return float(value)


def _require_bounded_number(
    value: Any, path: str, lower: float, upper: float
) -> float:
    number = _require_number(value, path)
    if number < lower or number > upper:
        _fail(path, "must be in [{}, {}]".format(lower, upper))
    return number


def _validate_score_ref(
    raw: Any, path: str, scoring_id: str, snapshot_hash: str
) -> None:
    score_ref = _require_mapping(raw, path)
    _require_exact_keys(score_ref, SCORE_REF_KEYS, path)
    if (
        score_ref["scoring_id"] != scoring_id
        or score_ref["snapshot_hash"] != snapshot_hash
    ):
        _fail(path, "does not match score identity")


def _validate_score(
    raw: Any, path: str, profile: str, market_scope: str
) -> Tuple[str, str, str]:
    score = _require_mapping(raw, path)
    _require_exact_keys(score, SCORE_KEYS, path)
    scoring_id = _require_uuid4(score["scoring_id"], path + ".scoring_id")
    snapshot_hash = _require_hash(
        score["snapshot_hash"], path + ".snapshot_hash"
    )
    if score["profile"] != profile:
        _fail(path + ".profile", "does not match envelope")
    if score["market_scope"] != market_scope:
        _fail(path + ".market_scope", "does not match envelope")
    total = _require_bounded_number(score["total"], path + ".total", 0, 100)
    rating = score["rating"]
    if rating not in BANDS:
        _fail(path + ".rating", "must be A|B|C|D|F")
    dims = score["dims"]
    if not isinstance(dims, list) or len(dims) != 6:
        _fail(path + ".dims", "must contain exactly six dimensions")
    total_weight = 0.0
    for index, (raw_dim, expected_key) in enumerate(zip(dims, SCORE_DIM_KEYS)):
        dim_path = "{}.dims[{}]".format(path, index)
        dim = _require_mapping(raw_dim, dim_path)
        _require_exact_keys(dim, SCORE_DIM_KEYS_SET, dim_path)
        if dim["key"] != expected_key:
            _fail(dim_path + ".key", "must follow Q/G/V/M/T/R order")
        _require_bounded_number(dim["score"], dim_path + ".score", 0, 100)
        if dim["band"] not in BANDS:
            _fail(dim_path + ".band", "must be A|B|C|D|F")
        total_weight += _require_bounded_number(
            dim["weight"], dim_path + ".weight", 0, 1
        )
    if abs(total_weight - 1.0) > 1e-9:
        _fail(path + ".dims", "weights must sum to 1.0")
    return scoring_id, snapshot_hash, rating


def _validate_conviction(
    raw: Any,
    path: str,
    ticker: str,
    as_of: str,
    scoring_id: str,
    snapshot_hash: str,
) -> Tuple[float, str]:
    conviction = _require_mapping(raw, path)
    _require_exact_keys(conviction, CONVICTION_KEYS, path)
    if conviction["ticker"] != ticker:
        _fail(path + ".ticker", "does not match recommendation")
    if conviction["as_of"] != as_of:
        _fail(path + ".as_of", "does not match recommendation")
    base = _require_bounded_number(conviction["base"], path + ".base", 0, 100)
    _validate_score_ref(
        conviction["score_ref"],
        path + ".score_ref",
        scoring_id,
        snapshot_hash,
    )
    adjustments = conviction["adjustments"]
    if not isinstance(adjustments, list) or len(adjustments) > 5:
        _fail(path + ".adjustments", "must be an array with at most 5 entries")
    delta_sum = 0.0
    for index, raw_adjustment in enumerate(adjustments):
        adjustment_path = "{}.adjustments[{}]".format(path, index)
        adjustment = _require_mapping(raw_adjustment, adjustment_path)
        actual = frozenset(adjustment)
        if not ADJUSTMENT_REQUIRED_KEYS.issubset(actual) or not actual.issubset(
            ADJUSTMENT_ALLOWED_KEYS
        ):
            _fail(adjustment_path, "has missing or unknown keys")
        delta_sum += _require_bounded_number(
            adjustment["delta"], adjustment_path + ".delta", -20, 20
        )
        reason = _require_nonempty_string(
            adjustment["reason"], adjustment_path + ".reason"
        )
        if len(reason) > 200:
            _fail(adjustment_path + ".reason", "must contain at most 200 characters")
        if "kind_ref" in adjustment and adjustment["kind_ref"] not in CATALYST_KINDS:
            _fail(adjustment_path + ".kind_ref", "is invalid")
        if "source_ref" in adjustment:
            _require_nonempty_string(
                adjustment["source_ref"], adjustment_path + ".source_ref"
            )
    if abs(delta_sum) > 20:
        _fail(path + ".adjustments", "delta sum must be in [-20, 20]")
    final = _require_bounded_number(
        conviction["final"], path + ".final", 0, 100
    )
    expected_final = max(0.0, min(100.0, base + delta_sum))
    if abs(final - expected_final) > 0.01:
        _fail(path + ".final", "does not equal clamped base + adjustments")
    if conviction["level"] not in ("HIGH", "MED", "LOW"):
        _fail(path + ".level", "must be HIGH|MED|LOW")
    expected_level = "HIGH" if final >= 75 else "MED" if final >= 50 else "LOW"
    if conviction["level"] != expected_level:
        _fail(path + ".level", "does not match conviction.final")
    return final, conviction["level"]


def _validate_price(raw: Any, path: str) -> None:
    price = _require_mapping(raw, path)
    _require_exact_keys(price, PRICE_KEYS, path)
    _require_number(price["value"], path + ".value")
    if price["currency"] not in CURRENCIES:
        _fail(path + ".currency", "is invalid")


def _validate_entry_plan(
    raw: Any,
    path: str,
    ticker: str,
    conviction_final: float,
    scoring_id: str,
    snapshot_hash: str,
) -> None:
    entry_plan = _require_mapping(raw, path)
    _require_exact_keys(entry_plan, ENTRY_PLAN_KEYS, path)
    if entry_plan["ticker"] != ticker:
        _fail(path + ".ticker", "does not match recommendation")
    _parse_utc_seconds(entry_plan["generated_at"], path + ".generated_at")
    entry = _require_mapping(entry_plan["entry"], path + ".entry")
    _require_exact_keys(entry, PRICE_BAND_KEYS, path + ".entry")
    low = _require_number(entry["low"], path + ".entry.low")
    high = _require_number(entry["high"], path + ".entry.high")
    if low > high:
        _fail(path + ".entry", "low must be <= high")
    if entry["currency"] not in CURRENCIES:
        _fail(path + ".entry.currency", "is invalid")
    _validate_price(entry_plan["stop"], path + ".stop")
    targets = entry_plan["targets"]
    if not isinstance(targets, list) or not 1 <= len(targets) <= 3:
        _fail(path + ".targets", "must contain 1..3 prices")
    for index, target in enumerate(targets):
        _validate_price(target, "{}.targets[{}]".format(path, index))
    size_hint = _require_mapping(entry_plan["size_hint"], path + ".size_hint")
    _require_exact_keys(size_hint, SIZE_HINT_KEYS, path + ".size_hint")
    if size_hint["tier"] not in SIZE_HINT_TIER_PCT:
        _fail(path + ".size_hint.tier", "is invalid")
    if size_hint["pct"] != SIZE_HINT_TIER_PCT[size_hint["tier"]]:
        _fail(path + ".size_hint.pct", "does not match tier")
    if size_hint["disclaimer_key"] != "size_hint_advisory":
        _fail(path + ".size_hint.disclaimer_key", "must be size_hint_advisory")
    _require_nonempty_string(size_hint["rationale"], path + ".size_hint.rationale")
    if entry_plan["time_horizon"] not in TIME_HORIZONS:
        _fail(path + ".time_horizon", "is invalid")
    _require_nonempty_string(entry_plan["invalidation"], path + ".invalidation")
    conviction_ref = _require_bounded_number(
        entry_plan["conviction_ref"], path + ".conviction_ref", 0, 100
    )
    if abs(conviction_ref - conviction_final) > 0.01:
        _fail(path + ".conviction_ref", "does not match conviction.final")
    _validate_score_ref(
        entry_plan["score_ref"],
        path + ".score_ref",
        scoring_id,
        snapshot_hash,
    )


def _validate_trigger_signals(raw: Any, path: str) -> None:
    if not isinstance(raw, list) or not raw:
        _fail(path, "must be a non-empty array")
    for index, raw_signal in enumerate(raw):
        signal_path = "{}[{}]".format(path, index)
        signal = _require_mapping(raw_signal, signal_path)
        actual = frozenset(signal)
        if not TRIGGER_SIGNAL_REQUIRED_KEYS.issubset(actual) or not actual.issubset(
            TRIGGER_SIGNAL_ALLOWED_KEYS
        ):
            _fail(signal_path, "has missing or unknown keys")
        if signal["code"] not in TRIGGER_SIGNAL_CODES:
            _fail(signal_path + ".code", "is invalid")
        if signal["strength"] not in ("STRONG", "MEDIUM", "WEAK"):
            _fail(signal_path + ".strength", "is invalid")
        _require_nonempty_string(signal["detail"], signal_path + ".detail")
        if len(signal["detail"]) > 240:
            _fail(signal_path + ".detail", "must contain at most 240 characters")
        if "source_ref" in signal:
            _require_nonempty_string(signal["source_ref"], signal_path + ".source_ref")


def _validate_profile_scope(profile: Any, market_scope: Any, path: str) -> None:
    if profile not in PROFILE_SCOPE:
        _fail(path + ".profile", "must be one of the six persisted profiles")
    if market_scope not in PROFILE_SCOPE[profile]:
        _fail(
            path + ".market_scope",
            "{} is incompatible with profile {}".format(market_scope, profile),
        )


def _validate_disclaimer(disclaimer: Any, path: str) -> None:
    obj = _require_mapping(disclaimer, path)
    _require_exact_keys(obj, DISCLAIMER_KEYS, path)
    _require_semver(obj["version"], path + ".version")
    short_text = _require_nonempty_string(obj["short_text"], path + ".short_text")
    full_text = _require_nonempty_string(obj["full_text"], path + ".full_text")
    if len(short_text) > 200:
        _fail(path + ".short_text", "must contain at most 200 characters")
    if len(full_text) > 4000:
        _fail(path + ".full_text", "must contain at most 4000 characters")
    if obj["language"] not in LANGUAGES:
        _fail(path + ".language", "must be a v0.3.1 locale")
    _parse_utc_seconds(obj["effective_at"], path + ".effective_at")
    digest = _require_hash(obj["hash"], path + ".hash")
    expected = hashlib.sha256(full_text.encode("utf-8")).hexdigest()
    if digest != expected:
        _fail(path + ".hash", "does not match SHA-256(full_text)")


def _validate_meta(meta: Any, path: str) -> None:
    obj = _require_mapping(meta, path)
    _require_exact_keys(obj, META_KEYS, path)
    if obj["contract_version"] != CONTRACT_VERSION:
        _fail(path + ".contract_version", "must equal 0.3.1")
    for name in (
        "profile_version",
        "strategy_version",
        "pipeline_version",
    ):
        _require_semver(obj[name], path + "." + name)
    _require_nonempty_string(obj["generated_by"], path + ".generated_by")
    _require_hash(obj["input_fingerprint"], path + ".input_fingerprint")
    generation_ms = _require_number(obj["generation_ms"], path + ".generation_ms")
    if generation_ms < 0:
        _fail(path + ".generation_ms", "must be non-negative")


def _validate_evidence_refs(value: Any, path: str) -> frozenset:
    if not isinstance(value, list) or not value:
        _fail(path, "must be a non-empty array")
    ids = set()
    for index, raw in enumerate(value):
        item_path = "{}[{}]".format(path, index)
        item = _require_mapping(raw, item_path)
        required = frozenset(("id", "kind", "source_uri", "as_of", "hash"))
        allowed = required | frozenset(("short_text",))
        actual = frozenset(item)
        if not required.issubset(actual) or not actual.issubset(allowed):
            _fail(item_path, "must contain only canonical EvidenceRef keys")
        evidence_id = _require_nonempty_string(item["id"], item_path + ".id")
        if evidence_id in ids:
            _fail(item_path + ".id", "must be unique")
        ids.add(evidence_id)
        _require_nonempty_string(item["kind"], item_path + ".kind")
        source_uri = _require_nonempty_string(
            item["source_uri"], item_path + ".source_uri"
        )
        if not any(
            source_uri.startswith(prefix) for prefix in CANONICAL_URI_PREFIXES
        ):
            _fail(item_path + ".source_uri", "must use a canonical URI scheme")
        _parse_utc_seconds(item["as_of"], item_path + ".as_of")
        _require_hash(item["hash"], item_path + ".hash")
        if "short_text" in item and not isinstance(item["short_text"], str):
            _fail(item_path + ".short_text", "must be a string")
    return frozenset(ids)


def _validate_recommendation(
    recommendation: Any,
    entry_path: str,
    snapshot_id: str,
    as_of: str,
    profile: str,
    market_scope: str,
    disclaimer_version: str,
) -> Tuple[float, str]:
    obj = _require_mapping(recommendation, entry_path + ".recommendation")
    actual = frozenset(obj)
    required = RECOMMENDATION_KEYS - frozenset(("catalyst_relevance",))
    if not required.issubset(actual) or not actual.issubset(RECOMMENDATION_KEYS):
        _fail(entry_path + ".recommendation", "has missing or unknown keys")
    _require_uuid4(obj["id"], entry_path + ".recommendation.id")
    if obj["snapshot_id"] != snapshot_id:
        _fail(entry_path + ".recommendation.snapshot_id", "does not match envelope")
    ticker = _require_nonempty_string(
        obj["ticker"], entry_path + ".recommendation.ticker"
    )
    if obj["as_of"] != as_of:
        _fail(entry_path + ".recommendation.as_of", "does not match envelope")

    scoring_id, snapshot_hash, rating = _validate_score(
        obj["score"],
        entry_path + ".recommendation.score",
        profile,
        market_scope,
    )
    final, _level = _validate_conviction(
        obj["conviction"],
        entry_path + ".recommendation.conviction",
        ticker,
        as_of,
        scoring_id,
        snapshot_hash,
    )

    risk_gate = _require_mapping(
        obj["risk_gate"], entry_path + ".recommendation.risk_gate"
    )
    if risk_gate.get("ok_to_enter") is not True:
        _fail(
            entry_path + ".recommendation.risk_gate.ok_to_enter",
            "must be true",
        )
    if risk_gate.get("gate") not in ("GREEN", "YELLOW"):
        _fail(
            entry_path + ".recommendation.risk_gate.gate",
            "must be GREEN or YELLOW when entry is allowed",
        )
    triggers = risk_gate.get("triggers")
    if not isinstance(triggers, list):
        _fail(entry_path + ".recommendation.risk_gate.triggers", "must be an array")
    severities = []
    for index, raw_trigger in enumerate(triggers):
        trigger_path = "{}.recommendation.risk_gate.triggers[{}]".format(
            entry_path, index
        )
        trigger = _require_mapping(raw_trigger, trigger_path)
        code = trigger.get("code")
        if code not in RISK_TRIGGER_CODES or code not in RISK_TRIGGER_RULES:
            _fail(trigger_path + ".code", "must be a canonical v0.3 trigger")
        expected_severity, scopes = RISK_TRIGGER_RULES[code]
        if trigger.get("severity") != expected_severity:
            _fail(trigger_path + ".severity", "does not match trigger code")
        if market_scope not in scopes:
            _fail(trigger_path + ".code", "does not apply to market_scope")
        _require_nonempty_string(trigger.get("detail"), trigger_path + ".detail")
        severities.append(expected_severity)
    expected_gate = (
        "RED"
        if "block" in severities
        else "YELLOW"
        if "warn" in severities
        else "GREEN"
    )
    if risk_gate.get("gate") != expected_gate:
        _fail(
            entry_path + ".recommendation.risk_gate.gate",
            "does not match trigger severities",
        )
    if risk_gate.get("ok_to_enter") != (expected_gate == "GREEN"):
        _fail(
            entry_path + ".recommendation.risk_gate.ok_to_enter",
            "does not match derived gate",
        )

    _validate_entry_plan(
        obj["entry_plan"],
        entry_path + ".recommendation.entry_plan",
        ticker,
        final,
        scoring_id,
        snapshot_hash,
    )
    _validate_trigger_signals(
        obj["trigger_signals"],
        entry_path + ".recommendation.trigger_signals",
    )
    weights = _require_mapping(
        obj["weights"], entry_path + ".recommendation.weights"
    )
    _require_exact_keys(
        weights, WEIGHT_ATTRIBUTION_KEYS, entry_path + ".recommendation.weights"
    )
    contributions = weights["contributions"]
    if not isinstance(contributions, list):
        _fail(
            entry_path + ".recommendation.weights.contributions",
            "must be an array",
        )
    for index, raw_contribution in enumerate(contributions):
        contribution_path = "{}.recommendation.weights.contributions[{}]".format(
            entry_path, index
        )
        contribution = _require_mapping(raw_contribution, contribution_path)
        actual = frozenset(contribution)
        if not CONTRIBUTION_REQUIRED_KEYS.issubset(actual) or not actual.issubset(
            CONTRIBUTION_ALLOWED_KEYS
        ):
            _fail(contribution_path, "has missing or unknown keys")
    explanation = _require_mapping(
        obj["explanation"], entry_path + ".recommendation.explanation"
    )
    _require_exact_keys(
        explanation,
        EXPLANATION_KEYS,
        entry_path + ".recommendation.explanation",
    )
    headline = _require_nonempty_string(
        explanation.get("headline"),
        entry_path + ".recommendation.explanation.headline",
    )
    body = _require_nonempty_string(
        explanation.get("body"),
        entry_path + ".recommendation.explanation.body",
    )
    caveats = explanation["caveats"]
    if not isinstance(caveats, list) or len(caveats) > 3:
        _fail(
            entry_path + ".recommendation.explanation.caveats",
            "must be an array with at most 3 entries",
        )
    for index, caveat in enumerate(caveats):
        text = _require_nonempty_string(
            caveat,
            "{}.recommendation.explanation.caveats[{}]".format(
                entry_path, index
            ),
        )
        if len(text) > 120:
            _fail(
                "{}.recommendation.explanation.caveats[{}]".format(
                    entry_path, index
                ),
                "must contain at most 120 characters",
            )
    if explanation.get("language") not in PROFILE_LANGUAGES[profile]:
        _fail(
            entry_path + ".recommendation.explanation.language",
            "is incompatible with profile",
        )
    _require_nonempty_string(
        explanation["template_id"],
        entry_path + ".recommendation.explanation.template_id",
    )
    _require_hash(
        explanation["template_hash"],
        entry_path + ".recommendation.explanation.template_hash",
    )
    evidence_ids = _validate_evidence_refs(
        obj["evidence_refs"], entry_path + ".recommendation.evidence_refs"
    )
    for marker in EVIDENCE_MARKER.findall(body):
        if "E" + marker not in evidence_ids:
            _fail(
                entry_path + ".recommendation.explanation.body",
                "[E{}] has no matching evidence".format(marker),
            )
    if obj["disclaimer_version"] != disclaimer_version:
        _fail(
            entry_path + ".recommendation.disclaimer_version",
            "does not match envelope disclaimer",
        )
    _require_semver(
        obj["model_version"], entry_path + ".recommendation.model_version"
    )
    return final, ticker


def validate_recommendation_list(envelope: Any) -> Mapping[str, Any]:
    """Validate the strict boundary needed by deterministic report projection."""

    obj = _require_mapping(envelope, "recommendation_list")
    _require_exact_keys(obj, TOP_LEVEL_KEYS, "recommendation_list")
    snapshot_id = _require_uuid4(
        obj["snapshot_id"], "recommendation_list.snapshot_id"
    )
    as_of = _require_nonempty_string(obj["as_of"], "recommendation_list.as_of")
    _parse_utc_seconds(as_of, "recommendation_list.as_of")
    profile = obj["profile"]
    market_scope = obj["market_scope"]
    _validate_profile_scope(profile, market_scope, "recommendation_list")
    _require_hash(
        obj["output_fingerprint"], "recommendation_list.output_fingerprint"
    )
    _validate_disclaimer(obj["disclaimer"], "recommendation_list.disclaimer")
    if obj["disclaimer"]["language"] not in PROFILE_LANGUAGES[profile]:
        _fail(
            "recommendation_list.disclaimer.language",
            "is incompatible with profile",
        )
    _validate_meta(obj["meta"], "recommendation_list.meta")

    items = obj["items"]
    if not isinstance(items, list):
        _fail("recommendation_list.items", "must be an array")
    previous = None
    seen_tickers = set()
    disclaimer_version = obj["disclaimer"]["version"]
    for index, raw in enumerate(items):
        path = "recommendation_list.items[{}]".format(index)
        item = _require_mapping(raw, path)
        _require_exact_keys(item, ITEM_KEYS, path)
        final, ticker = _validate_recommendation(
            item["recommendation"],
            path,
            snapshot_id,
            as_of,
            profile,
            market_scope,
            disclaimer_version,
        )
        if item["rating_band"] != item["recommendation"]["score"]["rating"]:
            _fail(path + ".rating_band", "does not mirror score.rating")
        if ticker in seen_tickers:
            _fail(path + ".recommendation.ticker", "must be unique in snapshot")
        seen_tickers.add(ticker)
        order_key = (-final, ticker)
        if previous is not None and order_key < previous:
            _fail(path, "violates conviction DESC, ticker ASC ordering")
        previous = order_key
    expected_fingerprint = compute_output_fingerprint(items)
    if obj["output_fingerprint"] != expected_fingerprint:
        _fail(
            "recommendation_list.output_fingerprint",
            "does not match SHA-256(JCS(items))",
        )
    try:
        shared_errors = OutputValidator().validate(dict(obj))
    except (KeyError, TypeError, ValueError) as error:
        _fail("recommendation_list", "shared §8 validation failed: {}".format(error))
    if shared_errors:
        _fail("recommendation_list", "; ".join(shared_errors))
    return obj


def _rating_counts(items: Sequence[Mapping[str, Any]]) -> Dict[str, int]:
    counts = {band: 0 for band in BANDS}
    for item in items:
        counts[item["rating_band"]] += 1
    return counts


def _report_id(day: str, profile: str, market_scope: str) -> str:
    return "daily-report:{}:{}:{}".format(day, profile, market_scope)


def _render_markdown(report: Mapping[str, Any]) -> str:
    lines = [
        "# AI 荐股日报 · {}".format(report["trading_day"]),
        "",
        "- Profile: `{}`".format(report["profile"]),
        "- Market scope: `{}`".format(report["market_scope"]),
        "- Source snapshot: `{}`".format(report["source_snapshot_id"]),
        "- Source as-of: `{}`".format(report["source_as_of"]),
        "- Output fingerprint: `{}`".format(
            report["source_output_fingerprint"]
        ),
        "- Input fingerprint: `{}`".format(
            report["meta"]["input_fingerprint"]
        ),
        "",
        "## 摘要",
        "",
        "- 推荐数: {}".format(report["summary"]["item_count"]),
        "- 高信念推荐数: {}".format(
            report["summary"]["high_conviction_count"]
        ),
        "- 评级分布: {}".format(
            " · ".join(
                "{}={}".format(band, report["summary"]["rating_counts"][band])
                for band in BANDS
            )
        ),
    ]
    if not report["entries"]:
        lines.extend(("", "本期无通过风险门禁的推荐。"))

    for index, entry in enumerate(report["entries"], 1):
        recommendation = entry["recommendation"]
        explanation = recommendation["explanation"]
        lines.extend(
            (
                "",
                "## {}. {} · {}".format(
                    index, recommendation["ticker"], entry["rating_band"]
                ),
                "",
                "**{}**".format(explanation["headline"]),
                "",
                explanation["body"],
                "",
                "- Conviction: {} ({})".format(
                    recommendation["conviction"]["final"],
                    recommendation["conviction"]["level"],
                ),
                "- Risk gate: {}".format(recommendation["risk_gate"]["gate"]),
                "- Size hint: {} / {}%".format(
                    recommendation["entry_plan"]["size_hint"]["tier"],
                    recommendation["entry_plan"]["size_hint"]["pct"],
                ),
                "- Evidence:",
            )
        )
        for evidence in recommendation["evidence_refs"]:
            lines.append(
                "  - [{}]({}) · {}".format(
                    evidence["id"],
                    evidence["source_uri"],
                    evidence.get("short_text", evidence["kind"]),
                )
            )

    disclaimer = report["disclaimer"]
    lines.extend(
        (
            "",
            "## 免责声明",
            "",
            disclaimer["full_text"],
            "",
            "_Disclaimer version: {} · hash: {}_".format(
                disclaimer["version"], disclaimer["hash"]
            ),
        )
    )
    return "\n".join(lines) + "\n"


def project_daily_report(envelope: Any) -> DailyReportDto:
    """Project one validated RecommendationList into the Tab 6 DTO."""

    source = validate_recommendation_list(envelope)
    trading_day = source["as_of"][:10]
    entries = deepcopy(source["items"])
    rating_counts = _rating_counts(entries)
    summary = {
        "item_count": len(entries),
        "high_conviction_count": sum(
            1
            for entry in entries
            if entry["recommendation"]["conviction"]["level"] == "HIGH"
        ),
        "rating_counts": rating_counts,
    }
    sections = [
        {
            "kind": "summary",
            "section_id": "summary",
            "title": "摘要",
            "item_count": summary["item_count"],
            "high_conviction_count": summary["high_conviction_count"],
            "rating_counts": deepcopy(rating_counts),
        }
    ]
    sections.extend(
        {
            "kind": "recommendation",
            "section_id": "recommendation-{}".format(
                entry["recommendation"]["ticker"].lower().replace(".", "-")
            ),
            "title": entry["recommendation"]["ticker"],
            "ticker": entry["recommendation"]["ticker"],
            "rating_band": entry["rating_band"],
            "evidence_ids": [
                evidence["id"]
                for evidence in entry["recommendation"]["evidence_refs"]
            ],
        }
        for entry in entries
    )
    report = {
        "projection_version": PROJECTION_VERSION,
        "report_id": _report_id(
            trading_day, source["profile"], source["market_scope"]
        ),
        "trading_day": trading_day,
        "profile": source["profile"],
        "market_scope": source["market_scope"],
        "source_snapshot_id": source["snapshot_id"],
        "source_as_of": source["as_of"],
        "source_output_fingerprint": source["output_fingerprint"],
        "disclaimer": deepcopy(source["disclaimer"]),
        "meta": deepcopy(source["meta"]),
        "summary": summary,
        "entries": entries,
        "sections": sections,
    }
    report["markdown"] = _render_markdown(report)
    return report


def _select_daily_sources(
    envelopes: Iterable[Any],
) -> List[Mapping[str, Any]]:
    """Select latest as-of per canonical report identity deterministically."""

    selected = {}
    for raw in envelopes:
        source = validate_recommendation_list(raw)
        identity = (
            source["as_of"][:10],
            source["profile"],
            source["market_scope"],
        )
        candidate_key = (source["as_of"], source["snapshot_id"])
        previous = selected.get(identity)
        if previous is None or candidate_key > (
            previous["as_of"],
            previous["snapshot_id"],
        ):
            selected[identity] = source
    return list(selected.values())


def _history_search_text(report: Mapping[str, Any]) -> str:
    parts = [
        report["trading_day"],
        report["profile"],
        report["market_scope"],
        report["source_snapshot_id"],
    ]
    for entry in report["entries"]:
        recommendation = entry["recommendation"]
        parts.extend(
            (
                recommendation["ticker"],
                recommendation["explanation"]["headline"],
                recommendation["explanation"]["body"],
            )
        )
    return "\n".join(parts).casefold()


def project_report_history(
    envelopes: Iterable[Any],
    query: Optional[str] = None,
    profile: Optional[str] = None,
    market_scope: Optional[str] = None,
    from_day: Optional[str] = None,
    to_day: Optional[str] = None,
) -> ReportHistoryDto:
    """Project deterministic Tab 7 history with exact filters and search."""

    if profile is not None and profile not in PROFILE_SCOPE:
        _fail("history.profile", "must be one of the six persisted profiles")
    if market_scope is not None and market_scope not in MARKET_ORDER:
        _fail("history.market_scope", "must be cn_a|us|jp|kr")
    if profile is not None and market_scope is not None:
        _validate_profile_scope(profile, market_scope, "history")
    if from_day is not None:
        from_day = _require_day(from_day, "history.from_day")
    if to_day is not None:
        to_day = _require_day(to_day, "history.to_day")
    if from_day is not None and to_day is not None and from_day > to_day:
        _fail("history", "from_day must be <= to_day")
    normalized_query = "" if query is None else query.strip().casefold()

    reports = [
        project_daily_report(source) for source in _select_daily_sources(envelopes)
    ]
    reports = [
        report
        for report in reports
        if (profile is None or report["profile"] == profile)
        and (market_scope is None or report["market_scope"] == market_scope)
        and (from_day is None or report["trading_day"] >= from_day)
        and (to_day is None or report["trading_day"] <= to_day)
        and (
            not normalized_query
            or normalized_query in _history_search_text(report)
        )
    ]
    reports.sort(
        key=lambda report: (
            -int(report["trading_day"].replace("-", "")),
            PROFILE_ORDER.index(report["profile"]),
            MARKET_ORDER.index(report["market_scope"]),
            report["source_snapshot_id"],
        )
    )
    entries = [
        {
            "report_id": report["report_id"],
            "trading_day": report["trading_day"],
            "profile": report["profile"],
            "market_scope": report["market_scope"],
            "source_snapshot_id": report["source_snapshot_id"],
            "source_as_of": report["source_as_of"],
            "source_output_fingerprint": report[
                "source_output_fingerprint"
            ],
            "input_fingerprint": report["meta"]["input_fingerprint"],
            "contract_version": report["meta"]["contract_version"],
            "profile_version": report["meta"]["profile_version"],
            "strategy_version": report["meta"]["strategy_version"],
            "pipeline_version": report["meta"]["pipeline_version"],
            "disclaimer_version": report["disclaimer"]["version"],
            "item_count": report["summary"]["item_count"],
            "high_conviction_count": report["summary"][
                "high_conviction_count"
            ],
            "rating_counts": deepcopy(report["summary"]["rating_counts"]),
            "content_preview": report["markdown"][:200],
        }
        for report in reports
    ]
    return {
        "projection_version": PROJECTION_VERSION,
        "filters": {
            "query": normalized_query,
            "profile": profile,
            "market_scope": market_scope,
            "from_day": from_day,
            "to_day": to_day,
        },
        "entries": entries,
        "total": len(entries),
    }
