"""Fixture-first BOJ/BOK FX parsing and deterministic normalization.

This module performs no network or credential access. A runner supplies the
provider payload together with versioned publication metadata.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
import hashlib
import io
import json
from typing import Iterable, Literal, Mapping, Optional, Sequence, Tuple

from datapipeline.contracts import FxObservation

FxPair = Literal["USDJPY", "USDKRW"]
FxSourceKind = Literal["BOJ", "BOK"]

DIRECTION = "LOCAL_PER_USD_WITH_RECIPROCAL"
LOCAL_RATE_QUANTUM = Decimal("0.0000000001")
RECIPROCAL_QUANTUM = Decimal("0.00000000000001")
CHANGE_PCT_QUANTUM = Decimal("0.00000001")
_PAIR_SOURCE = {"USDJPY": "BOJ", "USDKRW": "BOK"}


class FxParseError(ValueError):
    """Provider payload cannot be normalized without guessing."""


@dataclass(frozen=True)
class FxSourceRow:
    """One provider observation before reciprocal/change derivation."""

    pair: FxPair
    observation_day: date
    available_at_utc: datetime
    local_per_usd: Decimal
    source_kind: FxSourceKind
    source_document_id: str
    source_version: str

    def __post_init__(self) -> None:
        expected_source = _PAIR_SOURCE.get(self.pair)
        if expected_source is None or self.source_kind != expected_source:
            raise ValueError(
                "pair and source_kind must use the frozen provider mapping"
            )
        _require_utc(self.available_at_utc, "available_at_utc")
        _require_non_empty(self.source_document_id, "source_document_id")
        _require_non_empty(self.source_version, "source_version")
        if not isinstance(self.local_per_usd, Decimal):
            raise ValueError("local_per_usd must be Decimal")
        if not self.local_per_usd.is_finite() or self.local_per_usd <= 0:
            raise ValueError("local_per_usd must be finite and positive")
        _require_decimal_authority(
            self.local_per_usd,
            field="local_per_usd",
            max_precision=24,
            max_scale=10,
        )

    @property
    def identity(self) -> Tuple[str, date, str, str]:
        return (
            self.pair,
            self.observation_day,
            self.source_kind,
            self.source_version,
        )


def _require_non_empty(value: str, field: str) -> None:
    if not value or value.isspace():
        raise ValueError(f"{field} is required")


def _require_utc(value: datetime, field: str) -> None:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be timezone-aware UTC")


def _require_decimal_authority(
    value: Decimal,
    *,
    field: str,
    max_precision: int,
    max_scale: int,
) -> None:
    scale = max(-value.as_tuple().exponent, 0)
    integer_digits = 1 if value.is_zero() else max(value.copy_abs().adjusted() + 1, 0)
    if scale > max_scale:
        raise ValueError(f"{field} exceeds storage scale {max_scale}")
    if integer_digits > max_precision - max_scale:
        raise ValueError(
            f"{field} exceeds storage integer digits {max_precision - max_scale}"
        )


def _parse_decimal(value: object, field: str) -> Decimal:
    text = str(value).strip().replace(",", "")
    if not text:
        raise FxParseError(f"{field} is required")
    try:
        parsed = Decimal(text)
    except InvalidOperation as error:
        raise FxParseError(f"{field} is not a decimal") from error
    if not parsed.is_finite() or parsed <= 0:
        raise FxParseError(f"{field} must be finite and positive")
    return parsed


def _parse_iso_day(value: object, field: str) -> date:
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError as error:
        raise FxParseError(f"{field} must be YYYY-MM-DD") from error


def _parse_bok_day(value: object) -> date:
    text = str(value).strip()
    if len(text) != 8 or not text.isdigit():
        raise FxParseError("BOK TIME must be YYYYMMDD")
    return date(int(text[:4]), int(text[4:6]), int(text[6:]))


def parse_boj_csv(
    payload: str,
    *,
    available_at_utc: datetime,
    source_document_id: str,
    source_version: str,
) -> Tuple[FxSourceRow, ...]:
    """Parse a reviewed BOJ CSV projection.

    Required columns are ``observation_day`` and ``local_per_usd``. The caller
    pins the exact upstream dataset/column in ``source_version``.
    """

    _require_utc(available_at_utc, "available_at_utc")
    reader = csv.DictReader(io.StringIO(payload))
    required = {"observation_day", "local_per_usd"}
    if reader.fieldnames is None or not required.issubset(reader.fieldnames):
        raise FxParseError("BOJ CSV schema drift")
    rows = []
    for row_number, row in enumerate(reader, start=2):
        try:
            rows.append(
                FxSourceRow(
                    pair="USDJPY",
                    observation_day=_parse_iso_day(
                        row.get("observation_day"), "BOJ observation_day"
                    ),
                    available_at_utc=available_at_utc,
                    local_per_usd=_parse_decimal(
                        row.get("local_per_usd"), "BOJ local_per_usd"
                    ),
                    source_kind="BOJ",
                    source_document_id=source_document_id,
                    source_version=source_version,
                )
            )
        except (FxParseError, ValueError) as error:
            raise FxParseError(f"invalid BOJ row {row_number}: {error}") from error
    return tuple(rows)


def parse_bok_json(
    payload: Mapping[str, object],
    *,
    available_at_utc: datetime,
    source_document_id: str,
    source_version: str,
) -> Tuple[FxSourceRow, ...]:
    """Parse the reviewed BOK ECOS ``StatisticSearch.row`` projection."""

    _require_utc(available_at_utc, "available_at_utc")
    search = payload.get("StatisticSearch")
    if not isinstance(search, Mapping):
        raise FxParseError("BOK response is missing StatisticSearch")
    raw_rows = search.get("row")
    if not isinstance(raw_rows, list):
        raise FxParseError("BOK response is missing row list")
    rows = []
    for row_number, row in enumerate(raw_rows, start=1):
        if not isinstance(row, Mapping):
            raise FxParseError(f"invalid BOK row {row_number}: row must be an object")
        try:
            rows.append(
                FxSourceRow(
                    pair="USDKRW",
                    observation_day=_parse_bok_day(row.get("TIME")),
                    available_at_utc=available_at_utc,
                    local_per_usd=_parse_decimal(
                        row.get("DATA_VALUE"), "BOK DATA_VALUE"
                    ),
                    source_kind="BOK",
                    source_document_id=source_document_id,
                    source_version=source_version,
                )
            )
        except (FxParseError, ValueError) as error:
            raise FxParseError(f"invalid BOK row {row_number}: {error}") from error
    return tuple(rows)


def _decimal_text(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _utc_text(value: datetime) -> str:
    _require_utc(value, "timestamp")
    return value.isoformat().replace("+00:00", "Z")


def canonical_fx_fact_hash(
    *,
    pair: FxPair,
    observation_day: date,
    available_at_utc: datetime,
    local_per_usd: Decimal,
    usd_per_local: Decimal,
    change_pct: Optional[Decimal],
    source_kind: FxSourceKind,
    source_document_id: str,
    source_version: str,
    previous_observation_day: Optional[date],
    previous_source_kind: Optional[FxSourceKind],
    previous_source_version: Optional[str],
    previous_fact_hash: Optional[str],
) -> str:
    """SHA-256 over the canonical storage fact, excluding ``fact_hash``."""

    body = {
        "available_at_utc": _utc_text(available_at_utc),
        "change_pct": _decimal_text(change_pct),
        "direction": DIRECTION,
        "local_per_usd": _decimal_text(local_per_usd),
        "observation_day": observation_day.isoformat(),
        "pair": pair,
        "previous_fact_hash": previous_fact_hash,
        "previous_observation_day": (
            previous_observation_day.isoformat()
            if previous_observation_day is not None
            else None
        ),
        "previous_source_kind": previous_source_kind,
        "previous_source_version": previous_source_version,
        "source_document_id": source_document_id,
        "source_kind": source_kind,
        "source_version": source_version,
        "usd_per_local": _decimal_text(usd_per_local),
    }
    canonical = json.dumps(
        body, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _source_row_dedup(rows: Iterable[FxSourceRow]) -> Tuple[FxSourceRow, ...]:
    unique = {}
    for row in rows:
        existing = unique.get(row.identity)
        if existing is None:
            unique[row.identity] = row
        elif existing != row:
            raise ValueError("conflicting FX source rows share one identity")
    return tuple(
        sorted(
            unique.values(),
            key=lambda row: (
                row.pair,
                row.observation_day,
                row.available_at_utc,
                row.source_version,
            ),
        )
    )


def normalize_fx_rows(
    rows: Sequence[FxSourceRow],
    *,
    as_of_utc: datetime,
    previous_by_pair: Optional[Mapping[str, FxObservation]] = None,
) -> Tuple[FxObservation, ...]:
    """Normalize provider rows into versioned storage facts.

    Rows are processed chronologically per pair. A same-batch prior observation
    becomes the change lineage for the next day.
    """

    _require_utc(as_of_utc, "as_of_utc")
    prior = dict(previous_by_pair or {})
    output = []
    for row in _source_row_dedup(rows):
        if row.available_at_utc > as_of_utc:
            raise ValueError("FX observation is not available at as_of_utc")
        previous = prior.get(row.pair)
        if previous is not None:
            if previous.pair != row.pair or previous.source_kind != row.source_kind:
                raise ValueError("previous FX observation has incompatible lineage")
            if previous.observation_day >= row.observation_day:
                raise ValueError("previous FX observation must have an earlier day")
            if previous.available_at_utc > row.available_at_utc:
                raise ValueError("previous FX observation was not yet available")

        local_per_usd = row.local_per_usd
        usd_per_local = (Decimal(1) / local_per_usd).quantize(
            RECIPROCAL_QUANTUM, rounding=ROUND_HALF_EVEN
        )
        _require_decimal_authority(
            usd_per_local,
            field="usd_per_local",
            max_precision=24,
            max_scale=14,
        )
        change_pct = None
        if previous is not None:
            change_pct = (
                (local_per_usd / previous.local_per_usd - Decimal(1)) * Decimal(100)
            ).quantize(CHANGE_PCT_QUANTUM, rounding=ROUND_HALF_EVEN)
            _require_decimal_authority(
                change_pct,
                field="change_pct",
                max_precision=18,
                max_scale=8,
            )

        fact_hash = canonical_fx_fact_hash(
            pair=row.pair,
            observation_day=row.observation_day,
            available_at_utc=row.available_at_utc,
            local_per_usd=local_per_usd,
            usd_per_local=usd_per_local,
            change_pct=change_pct,
            source_kind=row.source_kind,
            source_document_id=row.source_document_id,
            source_version=row.source_version,
            previous_observation_day=(
                previous.observation_day if previous is not None else None
            ),
            previous_source_kind=(
                previous.source_kind if previous is not None else None
            ),
            previous_source_version=(
                previous.source_version if previous is not None else None
            ),
            previous_fact_hash=(previous.fact_hash if previous is not None else None),
        )
        observation = FxObservation(
            pair=row.pair,
            observation_day=row.observation_day,
            available_at_utc=row.available_at_utc,
            local_per_usd=local_per_usd,
            usd_per_local=usd_per_local,
            change_pct=change_pct,
            source_kind=row.source_kind,
            source_document_id=row.source_document_id,
            source_version=row.source_version,
            fact_hash=fact_hash,
            previous_observation_day=(
                previous.observation_day if previous is not None else None
            ),
            previous_source_kind=(
                previous.source_kind if previous is not None else None
            ),
            previous_source_version=(
                previous.source_version if previous is not None else None
            ),
            previous_fact_hash=(previous.fact_hash if previous is not None else None),
        )
        output.append(observation)
        prior[row.pair] = observation
    return tuple(output)
