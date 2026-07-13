"""Transactional writers for bounded JP/KR security, kline and disclosure facts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence, Tuple

from datapipeline.contracts import (
    JpKrDailyKlineRecord,
    JpKrDisclosureRecord,
    JpKrSecurityRecord,
)
from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    canonical_disclosure_fact_hash,
    canonical_kline_fact_hash,
    canonical_security_fact_hash,
)
from datapipeline.storage.multibagger.canonical_json import canonicalize_json

SECURITY_INSERT_SQL = """
INSERT INTO jpkr_security_master (
  market_scope, provider_market_label, exchange, ticker, ticker_name_local,
  ticker_name_en, currency, listing_day, delisting_day, is_active,
  source_kind, source_document_id, source_version, available_at_utc,
  fact_hash, source_payload
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  $11, $12, $13, $14, $15, $16::jsonb
)
ON CONFLICT (source_kind, source_document_id, source_version, ticker)
DO NOTHING
RETURNING security_id
"""
SECURITY_HASH_SQL = """
SELECT fact_hash FROM jpkr_security_master
WHERE source_kind=$1 AND source_document_id=$2 AND source_version=$3 AND ticker=$4
"""

KLINE_INSERT_SQL = """
INSERT INTO jpkr_daily_kline (
  market_scope, provider_market_label, exchange, ticker, ticker_name_local,
  ticker_name_en, trading_day, open, high, low, close, adjusted_close,
  corporate_action_version, volume, turnover, currency, dividend_amount,
  split_ratio, market_cap_local, turnover_rate, is_halted, halt_reason_code,
  source_kind, source_document_id, source_version, fact_hash,
  effective_at_utc, available_at_utc
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
  $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
)
ON CONFLICT (exchange, ticker, trading_day, source_kind, source_version)
DO NOTHING
RETURNING jpkr_daily_kline_id
"""
KLINE_HASH_SQL = """
SELECT fact_hash FROM jpkr_daily_kline
WHERE exchange=$1 AND ticker=$2 AND trading_day=$3
  AND source_kind=$4 AND source_version=$5
"""

DISCLOSURE_INSERT_SQL = """
INSERT INTO jpkr_disclosure_event (
  market_scope, provider_market_label, ticker, disclosure_kind,
  event_headline_local, event_body_url, event_time_utc, available_at_utc,
  source_kind, source_document_id, source_version, fact_hash, source_payload
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb
)
ON CONFLICT (source_kind, source_document_id, source_version)
DO NOTHING
RETURNING jpkr_disclosure_event_id
"""
DISCLOSURE_HASH_SQL = """
SELECT fact_hash FROM jpkr_disclosure_event
WHERE source_kind=$1 AND source_document_id=$2 AND source_version=$3
"""


class OfficialFactConflict(RuntimeError):
    """One physical identity was observed with two fact hashes."""


@dataclass(frozen=True)
class OfficialWriteResult:
    attempted: int
    inserted: int
    deduplicated: int


def _deduplicate(records: Iterable[object], identity) -> tuple[tuple, int]:
    unique = {}
    duplicates = 0
    for record in records:
        key = identity(record)
        existing = unique.get(key)
        if existing is None:
            unique[key] = record
        elif existing.fact_hash == record.fact_hash:
            duplicates += 1
        else:
            raise OfficialFactConflict("batch identity has conflicting fact hashes")
    return tuple(unique[key] for key in sorted(unique)), duplicates


class JpKrOfficialWriter:
    def __init__(self, db_pool: object) -> None:
        self._db_pool = db_pool

    async def write_security(
        self, records: Sequence[JpKrSecurityRecord]
    ) -> OfficialWriteResult:
        for record in records:
            if not isinstance(
                record, JpKrSecurityRecord
            ) or record.fact_hash != canonical_security_fact_hash(record):
                raise ValueError("security fact hash is not canonical")
        rows, deduplicated = _deduplicate(
            records,
            lambda row: (
                row.source_kind,
                row.source_document_id,
                row.source_version,
                row.ticker,
            ),
        )
        return await self._write(
            rows,
            len(records),
            deduplicated,
            SECURITY_HASH_SQL,
            SECURITY_INSERT_SQL,
            lambda row: (
                row.source_kind,
                row.source_document_id,
                row.source_version,
                row.ticker,
            ),
            lambda row: (
                row.market_scope,
                row.provider_market_label,
                row.exchange,
                row.ticker,
                row.ticker_name_local,
                row.ticker_name_en,
                row.currency,
                row.listing_day,
                row.delisting_day,
                row.is_active,
                row.source_kind,
                row.source_document_id,
                row.source_version,
                row.available_at_utc,
                row.fact_hash,
                canonicalize_json(row.source_payload),
            ),
        )

    async def write_klines(
        self, records: Sequence[JpKrDailyKlineRecord]
    ) -> OfficialWriteResult:
        for record in records:
            if not isinstance(
                record, JpKrDailyKlineRecord
            ) or record.fact_hash != canonical_kline_fact_hash(record):
                raise ValueError("kline fact hash is not canonical")
        rows, deduplicated = _deduplicate(
            records,
            lambda row: (
                row.exchange,
                row.ticker,
                row.trading_day,
                row.source_kind,
                row.source_version,
            ),
        )
        return await self._write(
            rows,
            len(records),
            deduplicated,
            KLINE_HASH_SQL,
            KLINE_INSERT_SQL,
            lambda row: (
                row.exchange,
                row.ticker,
                row.trading_day,
                row.source_kind,
                row.source_version,
            ),
            lambda row: (
                row.market_scope,
                row.provider_market_label,
                row.exchange,
                row.ticker,
                row.ticker_name_local,
                row.ticker_name_en,
                row.trading_day,
                row.open,
                row.high,
                row.low,
                row.close,
                row.adjusted_close,
                row.corporate_action_version,
                row.volume,
                row.turnover,
                row.currency,
                row.dividend_amount,
                row.split_ratio,
                row.market_cap_local,
                row.turnover_rate,
                row.is_halted,
                row.halt_reason_code,
                row.source_kind,
                row.source_document_id,
                row.source_version,
                row.fact_hash,
                row.effective_at_utc,
                row.available_at_utc,
            ),
        )

    async def write_disclosures(
        self, records: Sequence[JpKrDisclosureRecord]
    ) -> OfficialWriteResult:
        for record in records:
            if not isinstance(
                record, JpKrDisclosureRecord
            ) or record.fact_hash != canonical_disclosure_fact_hash(record):
                raise ValueError("disclosure fact hash is not canonical")
        rows, deduplicated = _deduplicate(
            records,
            lambda row: (
                row.source_kind,
                row.source_document_id,
                row.source_version,
            ),
        )
        return await self._write(
            rows,
            len(records),
            deduplicated,
            DISCLOSURE_HASH_SQL,
            DISCLOSURE_INSERT_SQL,
            lambda row: (
                row.source_kind,
                row.source_document_id,
                row.source_version,
            ),
            lambda row: (
                row.market_scope,
                row.provider_market_label,
                row.ticker,
                row.disclosure_kind,
                row.event_headline_local,
                row.event_body_url,
                row.event_time_utc,
                row.available_at_utc,
                row.source_kind,
                row.source_document_id,
                row.source_version,
                row.fact_hash,
                canonicalize_json(row.source_payload),
            ),
        )

    async def _write(
        self,
        rows: tuple,
        attempted: int,
        deduplicated: int,
        select_sql: str,
        insert_sql: str,
        identity,
        values,
    ) -> OfficialWriteResult:
        if not rows:
            return OfficialWriteResult(0, 0, deduplicated)
        inserted = 0
        async with self._db_pool.acquire() as connection:
            async with connection.transaction():
                for row in rows:
                    key = identity(row)
                    existing = await connection.fetchval(select_sql, *key)
                    if existing is not None:
                        if str(existing) != row.fact_hash:
                            raise OfficialFactConflict(
                                "stored identity has a different fact_hash"
                            )
                        deduplicated += 1
                        continue
                    result = await connection.fetchrow(insert_sql, *values(row))
                    if result is not None:
                        inserted += 1
                        continue
                    raced = await connection.fetchval(select_sql, *key)
                    if raced is None:
                        raise RuntimeError("official fact disappeared after conflict")
                    if str(raced) != row.fact_hash:
                        raise OfficialFactConflict(
                            "raced identity has a different fact_hash"
                        )
                    deduplicated += 1
        return OfficialWriteResult(attempted, inserted, deduplicated)
