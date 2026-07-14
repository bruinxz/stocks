"""Typed, immutable source envelopes for Sprint 3 filing and text writers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
import math
from typing import Literal, Mapping, Sequence

from .market_records import JsonValue, MarketScope

JpKrMarketScope = Literal["jp", "kr"]
JpKrExchange = Literal["tse", "ose", "krx", "kosdaq"]
FilingSourceKind = Literal["jpx-edinet", "dart"]
DisclosureSourceKind = Literal["jpx-edinet", "dart", "kind"]
FiscalPeriodKind = Literal["Q1", "Q3", "SEMIANNUAL", "ANNUAL"]
TextLanguage = Literal["en", "zh", "ja", "ko"]
TextHitKind = Literal["OPTIONALITY", "POSITIVE", "NEGATIVE", "EARLY_NEWS"]
TextField = Literal["TITLE", "BODY"]

_MARKET_SCOPE = {
    "CN": "cn_a",
    "US": "us",
    "JP": "jp",
    "KR": "kr",
}
_JP_EXCHANGES = frozenset(("tse", "ose"))
_KR_EXCHANGES = frozenset(("krx", "kosdaq"))
_FILING_SOURCES = frozenset(("jpx-edinet", "dart"))
_DISCLOSURE_SOURCES = frozenset(("jpx-edinet", "dart", "kind"))
_FISCAL_PERIODS = frozenset(("Q1", "Q3", "SEMIANNUAL", "ANNUAL"))
_TEXT_LANGUAGES = frozenset(("en", "zh", "ja", "ko"))
_TEXT_HIT_KINDS = frozenset(("OPTIONALITY", "POSITIVE", "NEGATIVE", "EARLY_NEWS"))
_TEXT_FIELDS = frozenset(("TITLE", "BODY"))


def _require_non_empty(value: str, field: str) -> None:
    if not value or value.isspace():
        raise ValueError(f"{field} is required")


def _require_sha256(value: str, field: str) -> None:
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError(f"{field} must be lowercase SHA-256 hex")


def _require_utc(value: datetime, field: str) -> None:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be timezone-aware UTC")


def _require_market_exchange(
    market_scope: JpKrMarketScope,
    exchange: JpKrExchange,
    currency: str | None = None,
) -> None:
    if market_scope not in ("jp", "kr"):
        raise ValueError("market_scope must be jp or kr")
    if exchange not in _JP_EXCHANGES | _KR_EXCHANGES:
        raise ValueError("exchange is not supported")
    expected_exchanges = _JP_EXCHANGES if market_scope == "jp" else _KR_EXCHANGES
    if exchange not in expected_exchanges:
        raise ValueError("market_scope and exchange must use the canonical mapping")
    if currency is not None:
        expected_currency = "JPY" if market_scope == "jp" else "KRW"
        if currency != expected_currency:
            raise ValueError("market_scope and currency must use the canonical mapping")


def _require_source_mapping(
    source_kind: FilingSourceKind,
    market_scope: JpKrMarketScope,
    taxonomy_version: str | None = None,
    account_mapping_version: str | None = None,
) -> None:
    if source_kind not in _FILING_SOURCES:
        raise ValueError("source_kind must be jpx-edinet or dart")
    if source_kind == "jpx-edinet":
        if market_scope != "jp":
            raise ValueError("jpx-edinet facts must use market_scope=jp")
        if taxonomy_version is not None:
            _require_non_empty(taxonomy_version, "taxonomy_version")
        if account_mapping_version is not None:
            raise ValueError("jpx-edinet facts cannot carry account_mapping_version")
    else:
        if market_scope != "kr":
            raise ValueError("dart facts must use market_scope=kr")
        if taxonomy_version is not None:
            raise ValueError("dart facts cannot carry taxonomy_version")
        if account_mapping_version is not None:
            _require_non_empty(account_mapping_version, "account_mapping_version")


def _require_finite(value: Decimal | None, field: str) -> None:
    if value is not None:
        if not isinstance(value, Decimal) or not value.is_finite():
            raise ValueError(f"{field} must be a finite Decimal")


def _require_json_value(value: object, field: str) -> None:
    """Reject values that PostgreSQL JSONB cannot represent losslessly."""

    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{field} contains a non-finite JSON number")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{field} contains a non-string JSON object key")
            _require_json_value(item, field)
        return
    if isinstance(value, list):
        for item in value:
            _require_json_value(item, field)
        return
    raise ValueError(f"{field} contains a non-JSON value")


def _require_json_object(value: Mapping[str, JsonValue], field: str) -> None:
    if not isinstance(value, Mapping):
        raise ValueError(f"{field} must be a JSON object")
    _require_json_value(value, field)


def _require_json_object_sequence(
    value: Sequence[Mapping[str, JsonValue]], field: str
) -> None:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ValueError(f"{field} must be a sequence of JSON objects")
    for item in value:
        _require_json_object(item, field)


@dataclass(frozen=True)
class JpKrFinancialRecord:
    """Lossless storage-ready financial fact emitted by EDINET or Open DART."""

    market_scope: JpKrMarketScope
    exchange: JpKrExchange
    ticker: str
    fiscal_period_kind: FiscalPeriodKind
    fiscal_period_start: date | None
    fiscal_period_end: date
    fiscal_quarter: int | None
    currency: Literal["JPY", "KRW"]
    is_consolidated: bool | None
    revenue: Decimal | None
    eps: Decimal | None
    net_income: Decimal | None
    total_assets: Decimal | None
    total_equity: Decimal | None
    total_liabilities: Decimal | None
    operating_cash_flow: Decimal | None
    research_and_development: Decimal | None
    segment_facts: tuple[Mapping[str, JsonValue], ...]
    taxonomy_version: str | None
    parser_version: str
    account_mapping_version: str | None
    concept_provenance: Mapping[str, JsonValue]
    parse_warnings: tuple[str, ...]
    source_payload: Mapping[str, JsonValue]
    source_kind: FilingSourceKind
    source_document_id: str
    source_version: str
    effective_at_utc: datetime
    available_at_utc: datetime
    fact_hash: str
    provider_market_label: str | None = None

    def __post_init__(self) -> None:
        _require_market_exchange(self.market_scope, self.exchange, self.currency)
        _require_source_mapping(
            self.source_kind,
            self.market_scope,
            self.taxonomy_version,
            self.account_mapping_version,
        )
        _require_non_empty(self.ticker, "ticker")
        _require_non_empty(self.parser_version, "parser_version")
        _require_non_empty(self.source_document_id, "source_document_id")
        _require_non_empty(self.source_version, "source_version")
        _require_sha256(self.fact_hash, "fact_hash")
        _require_utc(self.effective_at_utc, "effective_at_utc")
        _require_utc(self.available_at_utc, "available_at_utc")
        if self.source_kind == "jpx-edinet" and self.taxonomy_version is None:
            raise ValueError("taxonomy_version is required for jpx-edinet")
        if self.source_kind == "dart" and self.account_mapping_version is None:
            raise ValueError("account_mapping_version is required for dart")
        if self.fiscal_period_kind not in _FISCAL_PERIODS:
            raise ValueError("fiscal_period_kind is not supported")
        if (
            self.fiscal_period_start is not None
            and self.fiscal_period_start > self.fiscal_period_end
        ):
            raise ValueError("fiscal_period_start must not exceed fiscal_period_end")
        expected_quarter = {"Q1": 1, "Q3": 3, "SEMIANNUAL": None, "ANNUAL": None}[
            self.fiscal_period_kind
        ]
        if self.fiscal_quarter != expected_quarter:
            raise ValueError("fiscal_period_kind and fiscal_quarter are inconsistent")
        if self.effective_at_utc.date() != self.fiscal_period_end:
            raise ValueError("effective_at_utc must use the fiscal period-end date")
        if self.available_at_utc < self.effective_at_utc:
            raise ValueError("available_at_utc must not precede effective_at_utc")
        _require_json_object_sequence(self.segment_facts, "segment_facts")
        _require_json_object(self.concept_provenance, "concept_provenance")
        _require_json_object(self.source_payload, "source_payload")
        for field in (
            "revenue",
            "eps",
            "net_income",
            "total_assets",
            "total_equity",
            "total_liabilities",
            "operating_cash_flow",
            "research_and_development",
        ):
            _require_finite(getattr(self, field), field)
        if any(not warning or warning.isspace() for warning in self.parse_warnings):
            raise ValueError("parse_warnings cannot contain empty values")

    @property
    def identity(self) -> tuple[str, str, str, str]:
        return (
            self.market_scope,
            self.ticker,
            self.source_document_id,
            self.source_version,
        )

    def require_available_by(self, as_of_utc: datetime) -> None:
        _require_utc(as_of_utc, "as_of_utc")
        if self.available_at_utc > as_of_utc:
            raise ValueError(
                "financial fact is not available at the requested as_of_utc"
            )


@dataclass(frozen=True)
class JpKrDisclosureRecord:
    """Versioned disclosure metadata paired with filing financial facts."""

    market_scope: JpKrMarketScope
    exchange: JpKrExchange
    ticker: str
    disclosure_kind: str
    event_headline_local: str
    event_body_url: str | None
    event_time_utc: datetime
    available_at_utc: datetime
    source_kind: DisclosureSourceKind
    source_document_id: str
    source_version: str
    fact_hash: str
    source_payload: Mapping[str, JsonValue]
    provider_market_label: str | None = None

    def __post_init__(self) -> None:
        _require_market_exchange(self.market_scope, self.exchange)
        if self.source_kind not in _DISCLOSURE_SOURCES:
            raise ValueError("disclosure source_kind is not supported")
        if self.source_kind == "kind":
            if self.market_scope != "kr":
                raise ValueError("KIND disclosures must use market_scope=kr")
        else:
            _require_source_mapping(self.source_kind, self.market_scope)
        _require_non_empty(self.ticker, "ticker")
        _require_non_empty(self.disclosure_kind, "disclosure_kind")
        _require_non_empty(self.event_headline_local, "event_headline_local")
        _require_non_empty(self.source_document_id, "source_document_id")
        _require_non_empty(self.source_version, "source_version")
        _require_sha256(self.fact_hash, "fact_hash")
        _require_utc(self.event_time_utc, "event_time_utc")
        _require_utc(self.available_at_utc, "available_at_utc")
        if self.available_at_utc < self.event_time_utc:
            raise ValueError("available_at_utc must not precede event_time_utc")
        _require_json_object(self.source_payload, "source_payload")

    @property
    def identity(self) -> tuple[str, str, str]:
        return (self.source_kind, self.source_document_id, self.source_version)

    def require_available_by(self, as_of_utc: datetime) -> None:
        _require_utc(as_of_utc, "as_of_utc")
        if self.available_at_utc > as_of_utc:
            raise ValueError("disclosure is not available at the requested as_of_utc")


@dataclass(frozen=True)
class JpKrFilingEnvelope:
    """One document-atomic disclosure plus its normalized financial facts."""

    disclosure: JpKrDisclosureRecord
    financials: tuple[JpKrFinancialRecord, ...]

    def __post_init__(self) -> None:
        if not self.financials:
            raise ValueError("filing envelope requires at least one financial fact")
        for financial in self.financials:
            if (
                financial.market_scope != self.disclosure.market_scope
                or financial.exchange != self.disclosure.exchange
                or financial.ticker != self.disclosure.ticker
                or financial.source_kind != self.disclosure.source_kind
                or financial.source_document_id != self.disclosure.source_document_id
            ):
                raise ValueError("filing envelope facts must share document identity")

    def require_available_by(self, as_of_utc: datetime) -> None:
        self.disclosure.require_available_by(as_of_utc)
        for financial in self.financials:
            financial.require_available_by(as_of_utc)


@dataclass(frozen=True)
class ScanDocument:
    """Authorized normalized text input; this contract never fetches its URL."""

    document_id: str
    ticker: str
    market: Literal["CN", "US", "JP", "KR"]
    market_scope: MarketScope
    language: TextLanguage
    title: str
    body: str
    published_at_utc: datetime
    available_at_utc: datetime
    source_kind: str
    source_version: str
    source_url: str | None
    document_fact_hash: str

    def __post_init__(self) -> None:
        if self.market not in _MARKET_SCOPE:
            raise ValueError("market is not supported")
        if self.market_scope != _MARKET_SCOPE[self.market]:
            raise ValueError("market and market_scope must use the canonical mapping")
        if self.language not in _TEXT_LANGUAGES:
            raise ValueError("language is not supported")
        _require_non_empty(self.document_id, "document_id")
        _require_non_empty(self.ticker, "ticker")
        _require_non_empty(self.source_kind, "source_kind")
        _require_non_empty(self.source_version, "source_version")
        if not self.title and not self.body:
            raise ValueError("scan document requires title or body text")
        _require_sha256(self.document_fact_hash, "document_fact_hash")
        _require_utc(self.published_at_utc, "published_at_utc")
        _require_utc(self.available_at_utc, "available_at_utc")
        if self.available_at_utc < self.published_at_utc:
            raise ValueError("available_at_utc must not precede published_at_utc")

    def require_available_by(self, as_of_utc: datetime) -> None:
        _require_utc(as_of_utc, "as_of_utc")
        if self.available_at_utc > as_of_utc:
            raise ValueError(
                "scan document is not available at the requested as_of_utc"
            )


@dataclass(frozen=True)
class TextHit:
    """Deterministic lexical evidence; raw surrounding context is not retained."""

    term_id: str
    hit_kind: TextHitKind
    document_id: str
    ticker: str
    language: TextLanguage
    field: TextField
    start_offset: int
    end_offset: int
    context_hash: str
    taxonomy_version: str

    def __post_init__(self) -> None:
        if self.hit_kind not in _TEXT_HIT_KINDS:
            raise ValueError("hit_kind is not supported")
        if self.language not in _TEXT_LANGUAGES:
            raise ValueError("language is not supported")
        if self.field not in _TEXT_FIELDS:
            raise ValueError("field is not supported")
        _require_non_empty(self.term_id, "term_id")
        _require_non_empty(self.document_id, "document_id")
        _require_non_empty(self.ticker, "ticker")
        _require_non_empty(self.taxonomy_version, "taxonomy_version")
        _require_sha256(self.context_hash, "context_hash")
        if (
            isinstance(self.start_offset, bool)
            or not isinstance(self.start_offset, int)
            or isinstance(self.end_offset, bool)
            or not isinstance(self.end_offset, int)
        ):
            raise ValueError("text-hit offsets must be exact integers")
        if self.start_offset < 0 or self.end_offset <= self.start_offset:
            raise ValueError("text-hit offsets must define a non-empty range")


@dataclass(frozen=True)
class TextHitEnvelope:
    """Lossless writer input formed from the source document and one text hit."""

    document: ScanDocument
    hit: TextHit

    def __post_init__(self) -> None:
        if (
            self.hit.document_id != self.document.document_id
            or self.hit.ticker != self.document.ticker
            or self.hit.language != self.document.language
        ):
            raise ValueError("text hit must match its source document")
        source_text = (
            self.document.title if self.hit.field == "TITLE" else self.document.body
        )
        if self.hit.end_offset > len(source_text):
            raise ValueError("text-hit offsets exceed the selected source field")

    @property
    def identity(self) -> tuple[str, str, str, str, int, int]:
        return (
            self.document.document_fact_hash,
            self.hit.taxonomy_version,
            self.hit.term_id,
            self.hit.field,
            self.hit.start_offset,
            self.hit.end_offset,
        )

    def require_available_by(self, as_of_utc: datetime) -> None:
        self.document.require_available_by(as_of_utc)
