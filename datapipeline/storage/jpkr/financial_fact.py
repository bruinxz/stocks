"""DataPipeline-owned canonical hash for JP/KR financial facts."""

from __future__ import annotations

from dataclasses import asdict, fields
from datetime import date, datetime, timedelta
from decimal import Decimal
import hashlib
from typing import Mapping

from datapipeline.contracts import JpKrFinancialRecord
from datapipeline.storage.multibagger.canonical_json import canonicalize_json


_FINANCIAL_FIELDS = frozenset(field.name for field in fields(JpKrFinancialRecord))


def _utc_text(value: datetime, field: str) -> str:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be timezone-aware UTC")
    timespec = "microseconds" if value.microsecond else "seconds"
    return value.isoformat(timespec=timespec).replace("+00:00", "Z")


def _json_value(value: object) -> object:
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("financial fact contains non-finite Decimal")
        return format(value, "f")
    if isinstance(value, datetime):
        return _utc_text(value, "financial fact datetime")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("financial fact keys must be strings")
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    raise ValueError(f"unsupported financial fact value: {type(value).__name__}")


def financial_fact_body(
    value: JpKrFinancialRecord | Mapping[str, object],
) -> Mapping[str, object]:
    """Return the exact physical hash preimage for one financial fact."""

    if isinstance(value, JpKrFinancialRecord):
        payload = _json_value(asdict(value))
    elif isinstance(value, Mapping):
        payload = _json_value(dict(value))
    else:
        raise TypeError("financial fact must be a record or JSON object")
    if not isinstance(payload, dict) or set(payload) != _FINANCIAL_FIELDS:
        raise ValueError("financial fact keys are not exact")
    return {key: payload[key] for key in payload if key != "fact_hash"}


def canonical_financial_fact_hash(
    value: JpKrFinancialRecord | Mapping[str, object],
) -> str:
    body = financial_fact_body(value)
    return hashlib.sha256(canonicalize_json(body).encode("utf-8")).hexdigest()
