"""Parsers for owner-approved, sanitized REAL-DATA R1 official-source fixtures."""

from __future__ import annotations

import csv
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import io
from typing import Mapping, Sequence, Tuple

from datapipeline.contracts import (
    FxObservation,
    JpKrDailyKlineRecord,
    JpKrDisclosureRecord,
    JpKrSecurityRecord,
    capture_source_version,
    validate_capture_wrapper,
)
from .fx_rate_fetcher import normalize_fx_rows, parse_boj_csv
from datapipeline.storage.multibagger.canonical_json import canonicalize_json


def _hash(body: Mapping[str, object]) -> str:
    return hashlib.sha256(canonicalize_json(body).encode("utf-8")).hexdigest()


def canonical_security_fact_hash(record: JpKrSecurityRecord) -> str:
    body = {
        "available_at_utc": record.available_at_utc.isoformat().replace("+00:00", "Z"),
        "currency": record.currency,
        "delisting_day": (
            record.delisting_day.isoformat()
            if record.delisting_day is not None
            else None
        ),
        "exchange": record.exchange,
        "is_active": record.is_active,
        "listing_day": (
            record.listing_day.isoformat() if record.listing_day is not None else None
        ),
        "market_scope": record.market_scope,
        "provider_market_label": record.provider_market_label,
        "source_document_id": record.source_document_id,
        "source_kind": record.source_kind,
        "source_payload": record.source_payload,
        "source_version": record.source_version,
        "ticker": record.ticker,
        "ticker_name_en": record.ticker_name_en,
        "ticker_name_local": record.ticker_name_local,
    }
    return _hash(body)


def canonical_kline_fact_hash(record: JpKrDailyKlineRecord) -> str:
    body = {
        "adjusted_close": record.adjusted_close,
        "available_at_utc": record.available_at_utc.isoformat().replace("+00:00", "Z"),
        "close": record.close,
        "corporate_action_version": record.corporate_action_version,
        "currency": record.currency,
        "dividend_amount": record.dividend_amount,
        "effective_at_utc": record.effective_at_utc.isoformat().replace("+00:00", "Z"),
        "exchange": record.exchange,
        "halt_reason_code": record.halt_reason_code,
        "high": record.high,
        "is_halted": record.is_halted,
        "low": record.low,
        "market_cap_local": record.market_cap_local,
        "market_scope": record.market_scope,
        "open": record.open,
        "provider_market_label": record.provider_market_label,
        "source_document_id": record.source_document_id,
        "source_kind": record.source_kind,
        "source_version": record.source_version,
        "split_ratio": record.split_ratio,
        "ticker": record.ticker,
        "ticker_name_en": record.ticker_name_en,
        "ticker_name_local": record.ticker_name_local,
        "trading_day": record.trading_day.isoformat(),
        "turnover": record.turnover,
        "turnover_rate": record.turnover_rate,
        "volume": record.volume,
    }
    return _hash(body)


def canonical_disclosure_fact_hash(record: JpKrDisclosureRecord) -> str:
    body = {
        "available_at_utc": record.available_at_utc.isoformat().replace("+00:00", "Z"),
        "disclosure_kind": record.disclosure_kind,
        "event_body_url": record.event_body_url,
        "event_headline_local": record.event_headline_local,
        "event_time_utc": record.event_time_utc.isoformat().replace("+00:00", "Z"),
        "market_scope": record.market_scope,
        "provider_market_label": record.provider_market_label,
        "source_document_id": record.source_document_id,
        "source_kind": record.source_kind,
        "source_payload": record.source_payload,
        "source_version": record.source_version,
        "ticker": record.ticker,
    }
    return _hash(body)


def parse_jpx_security_fixture(
    payload: Mapping[str, object],
) -> Tuple[JpKrSecurityRecord, ...]:
    capture_payload = validate_capture_wrapper(
        payload, expected_source_kind="jpx-listed-company-monthly"
    )
    available_at_utc = datetime.fromisoformat(
        str(payload["captured_at_utc"]).replace("Z", "+00:00")
    )
    source_version = capture_source_version(payload)
    output = []
    rows = capture_payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("capture rows are required")
    for raw in rows:
        if not isinstance(raw, Mapping):
            raise ValueError("JPX row must be an object")
        effective_text = str(raw.get("effective_day", ""))
        if len(effective_text) != 8 or not effective_text.isascii():
            raise ValueError("JPX effective_day must be YYYYMMDD")
        effective = date(
            int(effective_text[:4]),
            int(effective_text[4:6]),
            int(effective_text[6:]),
        )
        code = str(raw.get("local_code", ""))
        section = str(raw.get("section", ""))
        name = str(raw.get("name_local", ""))
        if (
            not code
            or not code.isascii()
            or not code.isalnum()
            or not name
            or "内国株式" not in section
        ):
            raise ValueError("JPX row is not a domestic listed security")
        exchange = "ose" if "OSE" in section else "tse"
        source_document_id = f"jpx-listed:{effective.isoformat()}:{code}"
        source_payload = {
            "capture_instance": payload["capture_instance"],
            "capture_wrapper_sha256": payload["wrapper_sha256"],
            "section": section,
            "sector_33_code": str(raw.get("sector_33_code", "")),
            "sector_33_name": str(raw.get("sector_33_name", "")),
            "size_code": str(raw.get("size_code", "")),
            "size_name": str(raw.get("size_name", "")),
        }
        draft = JpKrSecurityRecord(
            market_scope="jp",
            exchange=exchange,
            ticker=code,
            ticker_name_local=name,
            ticker_name_en=None,
            currency="JPY",
            listing_day=None,
            delisting_day=None,
            is_active=True,
            source_kind="jpx-listed-company-monthly",
            source_document_id=source_document_id,
            source_version=source_version,
            available_at_utc=available_at_utc,
            fact_hash="0" * 64,
            source_payload=source_payload,
            provider_market_label=section,
        )
        output.append(replace(draft, fact_hash=canonical_security_fact_hash(draft)))
    return tuple(output)


def parse_boj_capture_fixture(
    wrapper: Mapping[str, object],
    *,
    as_of_utc: datetime,
) -> Tuple[FxObservation, ...]:
    capture_payload = validate_capture_wrapper(wrapper, expected_source_kind="BOJ")
    rows = capture_payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("capture rows are required")
    csv_payload = "observation_day,local_per_usd\n" + "\n".join(
        f"{row['observation_day']},{row['local_per_usd']}"
        for row in rows
        if isinstance(row, Mapping)
    )
    if csv_payload.count("\n") != len(rows):
        raise ValueError("BOJ capture row shape drift")
    available_at_utc = datetime.fromisoformat(
        str(wrapper["captured_at_utc"]).replace("Z", "+00:00")
    )
    if available_at_utc > as_of_utc:
        raise ValueError("BOJ capture is not available at as_of_utc")
    return normalize_fx_rows(
        parse_boj_csv(
            csv_payload,
            available_at_utc=available_at_utc,
            source_document_id=("BOJ:FM08'FXERD04:" + str(wrapper["capture_instance"])),
            source_version=capture_source_version(wrapper),
        ),
        as_of_utc=as_of_utc,
    )


def parse_kind_disclosure_fixture(
    payload: Mapping[str, object],
) -> Tuple[JpKrDisclosureRecord, ...]:
    capture_payload = validate_capture_wrapper(payload, expected_source_kind="kind")
    source_day = date.fromisoformat(str(capture_payload.get("source_document_day", "")))
    source_version = capture_source_version(payload)
    available_at_utc = datetime.fromisoformat(
        str(payload["captured_at_utc"]).replace("Z", "+00:00")
    )
    output = []
    rows = capture_payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("capture rows are required")
    for raw in rows:
        if not isinstance(raw, Mapping):
            raise ValueError("KIND row must be an object")
        market = str(raw.get("market", ""))
        exchange = {"유가증권": "krx", "코스닥": "kosdaq"}.get(market)
        if exchange is None:
            raise ValueError("KIND market label is unsupported")
        ticker = str(raw.get("short_code", ""))
        receipt = str(raw.get("receipt_no", ""))
        headline = str(raw.get("headline_local", ""))
        clock = str(raw.get("time_local", ""))
        if (
            len(ticker) != 5
            or not ticker.isdigit()
            or len(receipt) != 14
            or not receipt.isdigit()
            or not headline
            or len(clock) != 5
        ):
            raise ValueError("KIND row shape drift")
        # KIND's repIsuSrtCd is the five-digit representative common-share
        # code; physical JP/KR ticker identity retains the six-digit issue code.
        ticker = ticker + "0"
        hour, minute = map(int, clock.split(":"))
        local = datetime.combine(
            source_day,
            time(hour=hour, minute=minute),
            tzinfo=timezone(timedelta(hours=9)),
        )
        event_time = local.astimezone(timezone.utc)
        source_payload = {
            "capture_instance": payload["capture_instance"],
            "capture_wrapper_sha256": payload["wrapper_sha256"],
            "company_name_local": str(raw.get("company_name_local", "")),
            "market": market,
            "submitter": str(raw.get("submitter", "")),
        }
        draft = JpKrDisclosureRecord(
            market_scope="kr",
            exchange=exchange,
            ticker=ticker,
            disclosure_kind="material_event",
            event_headline_local=headline,
            event_body_url=None,
            event_time_utc=event_time,
            available_at_utc=available_at_utc,
            source_kind="kind",
            source_document_id=receipt,
            source_version=source_version,
            fact_hash="0" * 64,
            source_payload=source_payload,
            provider_market_label=market,
        )
        output.append(replace(draft, fact_hash=canonical_disclosure_fact_hash(draft)))
    return tuple(output)


def parse_jpx_kline_fixture(
    payload: Mapping[str, object],
) -> Tuple[JpKrDailyKlineRecord, ...]:
    capture_payload = validate_capture_wrapper(
        payload, expected_source_kind="jpx-daily-statistics-pdf"
    )
    source_version = capture_source_version(payload)
    available_at_utc = datetime.fromisoformat(
        str(payload["captured_at_utc"]).replace("Z", "+00:00")
    )
    output = []
    rows = capture_payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("capture rows are required")
    for raw in rows:
        if not isinstance(raw, Mapping):
            raise ValueError("JPX kline row must be an object")
        trading_day = date.fromisoformat(str(raw.get("trading_day", "")))
        effective = datetime.combine(trading_day, time(hour=6), tzinfo=timezone.utc)
        fields = {
            field: str(raw.get(field, ""))
            for field in ("open", "high", "low", "close", "volume", "turnover")
        }
        for field, value in fields.items():
            try:
                parsed = Decimal(value)
            except InvalidOperation as error:
                raise ValueError(f"JPX {field} is not decimal") from error
            if not parsed.is_finite() or parsed < 0:
                raise ValueError(f"JPX {field} must be finite/non-negative")
        if not (
            Decimal(fields["high"]) >= Decimal(fields["open"])
            and Decimal(fields["high"]) >= Decimal(fields["close"])
            and Decimal(fields["low"]) <= Decimal(fields["open"])
            and Decimal(fields["low"]) <= Decimal(fields["close"])
        ):
            raise ValueError("JPX OHLC relation is invalid")
        draft = JpKrDailyKlineRecord(
            market_scope="jp",
            exchange="tse",
            ticker=str(raw.get("ticker", "")),
            ticker_name_local=str(raw.get("ticker_name_local", "")),
            ticker_name_en=str(raw.get("ticker_name_en", "")) or None,
            trading_day=trading_day,
            effective_at_utc=effective,
            available_at_utc=available_at_utc,
            open=fields["open"],
            high=fields["high"],
            low=fields["low"],
            close=fields["close"],
            adjusted_close=None,
            corporate_action_version=None,
            volume=fields["volume"],
            turnover=fields["turnover"],
            currency="JPY",
            is_halted=False,
            dividend_amount=None,
            split_ratio=None,
            market_cap_local=None,
            turnover_rate=None,
            halt_reason_code=None,
            source_kind="jpx-daily-statistics-pdf",
            source_document_id=str(capture_payload["source_document_id"]),
            source_version=source_version,
            fact_hash="0" * 64,
            provider_market_label="TSE",
        )
        output.append(replace(draft, fact_hash=canonical_kline_fact_hash(draft)))
    return tuple(output)
