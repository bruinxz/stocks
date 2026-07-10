"""Nasdaq earnings calendar collector.

Data source: Nasdaq earnings calendar page (free, no auth).
Rate limit: 1 req/s conservative.
catalyst_kind: 'earnings' hardcoded.
"""
from __future__ import annotations

import logging
from datetime import datetime, date, timezone

import httpx

from .base import BaseCatalystCollector, CatalystEvent
from .timezone_bridge import us_et_to_cn_trading_day
from collectors.shared.rate_limiter import RateLimiter
from collectors.shared.retry_with_backoff import retry_with_backoff
from collectors.shared.idempotency_hash import compute_idempotency_hash

logger = logging.getLogger(__name__)

NASDAQ_CALENDAR_URL = "https://api.nasdaq.com/api/calendar/earnings"


class NasdaqEarningsCalendarCollector(BaseCatalystCollector):
    """Collects earnings calendar events from Nasdaq.

    Frequency: daily EOD tier 2.
    Idempotency: UNIQUE (event_source_kind='nasdaq_earnings', ingest_source_hash).
    catalyst_kind: 'earnings' hardcoded.
    """

    def __init__(self, rate_limiter: RateLimiter, event_writer) -> None:
        super().__init__(
            source_kind='nasdaq_earnings',
            rate_limiter=rate_limiter,
            event_writer=event_writer,
        )
        self.client = httpx.AsyncClient(
            timeout=30.0,
            headers={
                'User-Agent': 'catalyst-900/1.0 (datapipeline@catalyst900.com)',
                'Accept': 'application/json',
            },
        )

    async def fetch_events(self, as_of: datetime) -> list[CatalystEvent]:
        target_date = as_of.date()
        rows = await self._fetch_calendar(target_date)
        events: list[CatalystEvent] = []
        for row in rows:
            ev = self._parse_row(row, target_date, as_of)
            if ev is not None:
                events.append(ev)
        return events

    @retry_with_backoff(max_retries=3, base_delay=2.0)
    async def _fetch_calendar(self, target_date: date) -> list[dict]:
        await self.rate_limiter.acquire()
        params = {'date': target_date.strftime('%Y-%m-%d')}
        resp = await self.client.get(NASDAQ_CALENDAR_URL, params=params)
        resp.raise_for_status()
        data = resp.json()
        rows = data.get('data', {}).get('rows', [])
        return rows if rows else []

    def _parse_row(
        self, row: dict, target_date: date, as_of: datetime,
    ) -> CatalystEvent | None:
        ticker = row.get('symbol', '').strip().upper()
        if not ticker:
            return None

        company_name = row.get('name', '')
        eps_estimate = row.get('epsForecast', '')
        time_slot = row.get('time', '')

        headline = f"{company_name} ({ticker}) earnings {target_date}"
        if eps_estimate:
            headline += f" EPS est {eps_estimate}"

        is_pre_market = 'pre-market' in time_slot.lower() if time_slot else False
        is_after_hours = 'after' in time_slot.lower() if time_slot else False

        event_time = datetime.combine(
            target_date,
            datetime.min.time(),
            tzinfo=timezone.utc,
        )

        cn_trading_day = us_et_to_cn_trading_day(target_date)

        ingest_source_hash = compute_idempotency_hash(
            f"{ticker}:{target_date.isoformat()}",
            self.source_kind,
        )

        ingest_lag = int((as_of - event_time).total_seconds())

        return CatalystEvent(
            catalyst_kind='earnings',
            us_ticker=ticker,
            us_isin=None,
            event_headline=headline[:200],
            event_body_url=f"https://www.nasdaq.com/market-activity/stocks/{ticker.lower()}/earnings",
            event_time_utc=event_time,
            us_trading_day_et=target_date,
            cn_trading_day_asia_shanghai=cn_trading_day,
            ingest_lag_seconds=max(0, ingest_lag),
            ingest_source_hash=ingest_source_hash,
            is_regular_hours=not (is_pre_market or is_after_hours),
            source_versions={
                'nasdaq_calendar': 'api-v1',
                'ingest_date': as_of.date().isoformat(),
            },
        )
