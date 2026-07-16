"""Immutable source records for the bounded REAL-DATA R1 evidence path."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal, Mapping

from .market_records import (
    JsonValue,
    is_canonical_sha256,
    is_canonical_source_version,
)

JpKrMarketScope = Literal["jp", "kr"]
JpKrExchange = Literal["tse", "ose", "krx", "kosdaq"]


def _require_text(value: str, field: str) -> None:
    if not isinstance(value, str) or not value or value.isspace():
        raise ValueError(f"{field} is required")


def _require_utc(value: datetime, field: str) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError(f"{field} must be timezone-aware UTC")
    if value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must use UTC")


def _require_hash(value: object, field: str) -> None:
    if not is_canonical_sha256(value):
        raise ValueError(f"{field} must be lowercase SHA-256")


def _require_source_version(value: object) -> None:
    if not is_canonical_source_version(value):
        raise ValueError("source_version must be a printable ASCII token")


def _require_json(value: object, field: str) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError(f"{field} contains a non-finite number")
        return
    if isinstance(value, list):
        for item in value:
            _require_json(item, field)
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{field} contains a non-string key")
            _require_json(item, field)
        return
    raise ValueError(f"{field} contains a non-JSON value")


@dataclass(frozen=True)
class JpKrSecurityRecord:
    market_scope: JpKrMarketScope
    exchange: JpKrExchange
    ticker: str
    ticker_name_local: str
    ticker_name_en: str | None
    currency: Literal["JPY", "KRW"]
    listing_day: date | None
    delisting_day: date | None
    is_active: bool
    source_kind: str
    source_document_id: str
    source_version: str
    available_at_utc: datetime
    fact_hash: str
    source_payload: Mapping[str, JsonValue]
    provider_market_label: str | None = None

    def __post_init__(self) -> None:
        if self.market_scope not in ("jp", "kr"):
            raise ValueError("market_scope must be jp or kr")
        expected_exchanges = {
            "jp": ("tse", "ose"),
            "kr": ("krx", "kosdaq"),
        }[self.market_scope]
        expected_currency = {"jp": "JPY", "kr": "KRW"}[self.market_scope]
        if (
            self.exchange not in expected_exchanges
            or self.currency != expected_currency
        ):
            raise ValueError("market/exchange/currency mapping is invalid")
        for field in (
            "ticker",
            "ticker_name_local",
            "source_kind",
            "source_document_id",
        ):
            _require_text(getattr(self, field), field)
        _require_source_version(self.source_version)
        if (
            self.listing_day is not None
            and self.delisting_day is not None
            and self.delisting_day < self.listing_day
        ):
            raise ValueError("delisting_day must not precede listing_day")
        if not isinstance(self.is_active, bool):
            raise ValueError("is_active must be boolean")
        _require_utc(self.available_at_utc, "available_at_utc")
        _require_hash(self.fact_hash, "fact_hash")
        _require_json(self.source_payload, "source_payload")


@dataclass(frozen=True)
class JpKrDailyKlineRecord:
    market_scope: JpKrMarketScope
    exchange: JpKrExchange
    ticker: str
    ticker_name_local: str
    ticker_name_en: str | None
    trading_day: date
    effective_at_utc: datetime
    available_at_utc: datetime
    open: str
    high: str
    low: str
    close: str
    adjusted_close: str | None
    corporate_action_version: str | None
    volume: str
    turnover: str | None
    currency: Literal["JPY", "KRW"]
    is_halted: bool
    dividend_amount: str | None
    split_ratio: str | None
    market_cap_local: str | None
    turnover_rate: str | None
    halt_reason_code: str | None
    source_kind: str
    source_document_id: str
    source_version: str
    fact_hash: str
    provider_market_label: str | None = None

    def __post_init__(self) -> None:
        if self.market_scope not in ("jp", "kr"):
            raise ValueError("market_scope must be jp or kr")
        expected_exchanges = {
            "jp": ("tse", "ose"),
            "kr": ("krx", "kosdaq"),
        }[self.market_scope]
        expected_currency = {"jp": "JPY", "kr": "KRW"}[self.market_scope]
        if (
            self.exchange not in expected_exchanges
            or self.currency != expected_currency
        ):
            raise ValueError("market/exchange/currency mapping is invalid")
        for field in (
            "ticker",
            "ticker_name_local",
            "source_kind",
            "source_document_id",
            "open",
            "high",
            "low",
            "close",
            "volume",
        ):
            _require_text(getattr(self, field), field)
        _require_source_version(self.source_version)
        _require_utc(self.effective_at_utc, "effective_at_utc")
        _require_utc(self.available_at_utc, "available_at_utc")
        if self.effective_at_utc.date() != self.trading_day:
            raise ValueError("effective_at_utc must use trading_day")
        if self.available_at_utc < self.effective_at_utc:
            raise ValueError("available_at_utc must not precede effective_at_utc")
        if not isinstance(self.is_halted, bool):
            raise ValueError("is_halted must be boolean")
        if self.adjusted_close is not None and not self.corporate_action_version:
            raise ValueError("adjusted_close requires corporate_action_version")
        _require_hash(self.fact_hash, "fact_hash")
