"""Base class for all US catalyst event collectors.

Shared base: retry_with_backoff + rate_limiter + idempotency_hash
from collector/shared/ (Path D 9ec3f104 KEEP-REUSE).
"""
from __future__ import annotations

import abc
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from collectors.shared.rate_limiter import RateLimiter
from collectors.shared.retry_with_backoff import retry_with_backoff
from collectors.shared.idempotency_hash import compute_idempotency_hash

logger = logging.getLogger(__name__)

CATALYST_KINDS = frozenset({
    'earnings', 'upgrade_downgrade', 'ma_activity', 'sector_move',
    'regulator', 'geo_macro', 'product', 'leadership', 'unclassified',
})


class CatalystEvent:
    """Row-level DTO aligned with us_catalyst_event DDL (notes/180 v0.2 §6.1)."""

    __slots__ = (
        'us_catalyst_event_id', 'catalyst_kind', 'us_ticker',
        'us_isin', 'event_headline', 'event_body_url',
        'event_source_kind', 'event_time_utc', 'us_trading_day_et',
        'cn_trading_day_asia_shanghai', 'ingest_lag_seconds',
        'ingest_source_hash', 'is_regular_hours', 'fact_hash',
        'source_versions',
    )

    def __init__(self, **kwargs: Any) -> None:
        for slot in self.__slots__:
            setattr(self, slot, kwargs.get(slot))
        if self.us_catalyst_event_id is None:
            self.us_catalyst_event_id = str(uuid4())

    def validate(self) -> None:
        assert self.catalyst_kind in CATALYST_KINDS, (
            f"invalid catalyst_kind: {self.catalyst_kind}"
        )
        assert self.event_headline and len(self.event_headline) <= 200
        assert self.ingest_lag_seconds >= 0
        assert self.event_source_kind
        assert self.ingest_source_hash
        assert self.fact_hash

    def compute_fact_hash(self) -> str:
        canonical = json.dumps({
            'catalyst_kind': self.catalyst_kind,
            'us_ticker': self.us_ticker,
            'event_headline': self.event_headline,
            'event_source_kind': self.event_source_kind,
            'event_time_utc': self.event_time_utc.isoformat(),
            'us_trading_day_et': str(self.us_trading_day_et),
        }, sort_keys=True, ensure_ascii=False)
        self.fact_hash = hashlib.sha256(canonical.encode()).hexdigest()
        return self.fact_hash


class BaseCatalystCollector(abc.ABC):
    """ABC for US catalyst event collectors.

    Subclasses implement fetch_events() to produce CatalystEvent rows.
    The base handles rate limiting, retrying, dedup, and writing.
    """

    def __init__(
        self,
        source_kind: str,
        rate_limiter: RateLimiter,
        event_writer: Any,
    ) -> None:
        self.source_kind = source_kind
        self.rate_limiter = rate_limiter
        self.event_writer = event_writer

    @abc.abstractmethod
    async def fetch_events(self, as_of: datetime) -> list[CatalystEvent]:
        """Fetch catalyst events up to as_of. Returns deduplicated list."""

    async def run(self, as_of: datetime | None = None) -> int:
        if as_of is None:
            as_of = datetime.now(timezone.utc)
        logger.info("collector=%s start as_of=%s", self.source_kind, as_of)
        events = await self.fetch_events(as_of)
        for ev in events:
            ev.event_source_kind = self.source_kind
            ev.compute_fact_hash()
            ev.validate()
        written = await self.event_writer.upsert_batch(events)
        logger.info(
            "collector=%s fetched=%d written=%d",
            self.source_kind, len(events), written,
        )
        return written
