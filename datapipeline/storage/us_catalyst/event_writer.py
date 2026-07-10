"""us_catalyst_event table writer with idempotent upsert.

Idempotency: ON CONFLICT (event_source_kind, ingest_source_hash) DO NOTHING.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

INSERT_SQL = """
INSERT INTO us_catalyst_event (
    us_catalyst_event_id, catalyst_kind, us_ticker, us_isin,
    event_headline, event_body_url, event_source_kind,
    event_time_utc, us_trading_day_et, cn_trading_day_asia_shanghai,
    ingest_lag_seconds, ingest_source_hash, is_regular_hours,
    fact_hash, source_versions
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15
)
ON CONFLICT (event_source_kind, ingest_source_hash) DO NOTHING
"""


class EventWriter:
    """Writes CatalystEvent rows to us_catalyst_event table.

    Uses parameterized SQL with ON CONFLICT for idempotency.
    PG connection injected via config/env.
    """

    def __init__(self, db_pool: Any) -> None:
        self.db_pool = db_pool

    async def upsert_batch(self, events: list) -> int:
        if not events:
            return 0

        written = 0
        async with self.db_pool.acquire() as conn:
            for ev in events:
                result = await conn.execute(
                    INSERT_SQL,
                    ev.us_catalyst_event_id, ev.catalyst_kind,
                    ev.us_ticker, ev.us_isin,
                    ev.event_headline, ev.event_body_url,
                    ev.event_source_kind, ev.event_time_utc,
                    ev.us_trading_day_et, ev.cn_trading_day_asia_shanghai,
                    ev.ingest_lag_seconds, ev.ingest_source_hash,
                    ev.is_regular_hours, ev.fact_hash,
                    ev.source_versions,
                )
                if 'INSERT' in result:
                    written += 1

        logger.info(
            "upsert_batch total=%d written=%d skipped=%d",
            len(events), written, len(events) - written,
        )
        return written

    async def upsert_one(self, ev: Any) -> bool:
        async with self.db_pool.acquire() as conn:
            result = await conn.execute(
                INSERT_SQL,
                ev.us_catalyst_event_id, ev.catalyst_kind,
                ev.us_ticker, ev.us_isin,
                ev.event_headline, ev.event_body_url,
                ev.event_source_kind, ev.event_time_utc,
                ev.us_trading_day_et, ev.cn_trading_day_asia_shanghai,
                ev.ingest_lag_seconds, ev.ingest_source_hash,
                ev.is_regular_hours, ev.fact_hash,
                ev.source_versions,
            )
            return 'INSERT' in result
