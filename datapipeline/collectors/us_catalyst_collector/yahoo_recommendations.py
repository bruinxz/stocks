"""Yahoo Finance analyst recommendations collector.

Data source: Yahoo Finance quoteSummary API (free, no auth, public endpoint).
Rate limit: 2 req/s + random jitter [0.5, 1.5]s.
catalyst_kind: 'upgrade_downgrade' hardcoded.
"""
from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime, timezone

import httpx

from .base import BaseCatalystCollector, CatalystEvent
from .timezone_bridge import us_et_to_cn_trading_day
from collectors.shared.rate_limiter import RateLimiter
from collectors.shared.retry_with_backoff import retry_with_backoff
from collectors.shared.idempotency_hash import compute_idempotency_hash

logger = logging.getLogger(__name__)

YAHOO_QUOTE_SUMMARY_URL = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/{ticker}"
YAHOO_MODULES = "recommendationTrend,upgradeDowngradeHistory"


class YahooRecommendationsCollector(BaseCatalystCollector):
    """Collects analyst upgrade/downgrade events from Yahoo Finance.

    Frequency: daily EOD tier 2.
    Idempotency: UNIQUE (event_source_kind='yahoo_recommendations', ingest_source_hash).
    catalyst_kind: 'upgrade_downgrade' hardcoded.
    Opt-in source — non-critical, 429 graceful degradation.
    """

    def __init__(
        self,
        rate_limiter: RateLimiter,
        event_writer,
        watchlist: list[str] | None = None,
    ) -> None:
        super().__init__(
            source_kind='yahoo_recommendations',
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
        self.watchlist = watchlist or []

    async def fetch_events(self, as_of: datetime) -> list[CatalystEvent]:
        events: list[CatalystEvent] = []
        for ticker in self.watchlist:
            try:
                ticker_events = await self._fetch_ticker_recommendations(
                    ticker, as_of,
                )
                events.extend(ticker_events)
            except Exception:
                logger.warning(
                    "yahoo_recommendations ticker=%s failed, skipping",
                    ticker, exc_info=True,
                )
        return events

    @retry_with_backoff(max_retries=3, base_delay=3.0)
    async def _fetch_ticker_recommendations(
        self, ticker: str, as_of: datetime,
    ) -> list[CatalystEvent]:
        await self.rate_limiter.acquire()
        await asyncio.sleep(random.uniform(0.5, 1.5))

        url = YAHOO_QUOTE_SUMMARY_URL.format(ticker=ticker)
        params = {'modules': YAHOO_MODULES}
        resp = await self.client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

        result = data.get('quoteSummary', {}).get('result', [])
        if not result:
            return []

        summary = result[0]
        events: list[CatalystEvent] = []

        history = summary.get('upgradeDowngradeHistory', {}).get('history', [])
        for entry in history:
            ev = self._parse_upgrade_downgrade(entry, ticker, as_of)
            if ev is not None:
                events.append(ev)

        return events

    def _parse_upgrade_downgrade(
        self, entry: dict, ticker: str, as_of: datetime,
    ) -> CatalystEvent | None:
        firm = entry.get('firm', '')
        to_grade = entry.get('toGrade', '')
        from_grade = entry.get('fromGrade', '')
        action = entry.get('action', '')
        epoch_grade_date = entry.get('epochGradeDate', 0)

        if not firm or not to_grade:
            return None

        event_time = datetime.fromtimestamp(
            epoch_grade_date, tz=timezone.utc,
        ) if epoch_grade_date else as_of

        if (as_of - event_time).days > 7:
            return None

        us_trading_day = event_time.date()
        cn_trading_day = us_et_to_cn_trading_day(us_trading_day)

        action_label = action.capitalize() if action else 'Rated'
        headline = f"{firm} {action_label} {ticker} to {to_grade}"
        if from_grade:
            headline += f" from {from_grade}"

        ingest_source_hash = compute_idempotency_hash(
            f"{ticker}:{firm}:{epoch_grade_date}:{to_grade}",
            self.source_kind,
        )

        ingest_lag = int((as_of - event_time).total_seconds())

        return CatalystEvent(
            catalyst_kind='upgrade_downgrade',
            us_ticker=ticker.upper(),
            us_isin=None,
            event_headline=headline[:200],
            event_body_url=f"https://finance.yahoo.com/quote/{ticker}/",
            event_time_utc=event_time,
            us_trading_day_et=us_trading_day,
            cn_trading_day_asia_shanghai=cn_trading_day,
            ingest_lag_seconds=max(0, ingest_lag),
            ingest_source_hash=ingest_source_hash,
            is_regular_hours=self._is_regular_hours(event_time),
            source_versions={
                'yahoo_quoteSummary': 'v10',
                'ingest_date': as_of.date().isoformat(),
            },
        )

    @staticmethod
    def _is_regular_hours(event_time: datetime) -> bool:
        hour = event_time.hour
        return 13 <= hour <= 21
