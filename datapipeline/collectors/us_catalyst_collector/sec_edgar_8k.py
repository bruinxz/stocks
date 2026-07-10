"""SEC EDGAR 8-K filing collector.

Data source: EDGAR Full-Text Search API (free, no auth, 10 req/s official).
Rate limit: 5 req/s conservative + backoff.
"""
from __future__ import annotations

import logging
from datetime import datetime, date, timezone

import httpx

from .base import BaseCatalystCollector, CatalystEvent
from .kind_classifier import classify_8k_item
from .timezone_bridge import us_et_to_cn_trading_day
from collectors.shared.rate_limiter import RateLimiter
from collectors.shared.retry_with_backoff import retry_with_backoff
from collectors.shared.idempotency_hash import compute_idempotency_hash

logger = logging.getLogger(__name__)

EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index"

ITEM_KIND_MAP = {
    '1.01': 'ma_activity',
    '1.02': 'ma_activity',
    '2.01': 'ma_activity',
    '2.02': 'earnings',
    '2.05': 'regulator',
    '2.06': 'product',
    '4.01': 'regulator',
    '4.02': 'regulator',
    '5.01': 'leadership',
    '5.02': 'leadership',
    '7.01': 'regulator',
    '8.01': 'unclassified',
}


class SecEdgar8kCollector(BaseCatalystCollector):
    """Collects 8-K filings from SEC EDGAR.

    Frequency: daily EOD tier 2.
    Idempotency: UNIQUE (event_source_kind='sec_edgar_8k', ingest_source_hash).
    """

    def __init__(self, rate_limiter: RateLimiter, event_writer) -> None:
        super().__init__(
            source_kind='sec_edgar_8k',
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
        filings = await self._fetch_recent_8k(as_of)
        events: list[CatalystEvent] = []
        for filing in filings:
            ev = self._parse_filing(filing, as_of)
            if ev is not None:
                events.append(ev)
        return events

    @retry_with_backoff(max_retries=3, base_delay=2.0)
    async def _fetch_recent_8k(self, as_of: datetime) -> list[dict]:
        await self.rate_limiter.acquire()
        filing_date = as_of.strftime('%Y-%m-%d')
        params = {
            'q': '"8-K"',
            'dateRange': 'custom',
            'startdt': filing_date,
            'enddt': filing_date,
            'forms': '8-K',
        }
        resp = await self.client.get(EDGAR_SEARCH_URL, params=params)
        resp.raise_for_status()
        data = resp.json()
        return data.get('hits', {}).get('hits', [])

    def _parse_filing(
        self, filing: dict, as_of: datetime,
    ) -> CatalystEvent | None:
        source = filing.get('_source', {})
        ticker = self._extract_ticker(source)
        if not ticker:
            return None

        items = source.get('items', '').split(',')
        primary_item = items[0].strip() if items else '8.01'
        catalyst_kind = classify_8k_item(primary_item)

        filing_date_str = source.get('file_date', '')
        event_time = self._parse_filing_time(filing_date_str, as_of)
        us_trading_day = event_time.date()
        cn_trading_day = us_et_to_cn_trading_day(us_trading_day)

        ingest_source_hash = compute_idempotency_hash(
            source.get('accession_no', ''),
            self.source_kind,
        )

        ingest_lag = int((as_of - event_time).total_seconds())

        return CatalystEvent(
            catalyst_kind=catalyst_kind,
            us_ticker=ticker,
            us_isin=None,
            event_headline=self._build_headline(source, primary_item)[:200],
            event_body_url=self._build_filing_url(source),
            event_time_utc=event_time,
            us_trading_day_et=us_trading_day,
            cn_trading_day_asia_shanghai=cn_trading_day,
            ingest_lag_seconds=max(0, ingest_lag),
            ingest_source_hash=ingest_source_hash,
            is_regular_hours=self._is_regular_hours(event_time),
            source_versions={'edgar_api': 'efts-v1', 'ingest_date': as_of.date().isoformat()},
        )

    @staticmethod
    def _extract_ticker(source: dict) -> str | None:
        tickers = source.get('tickers', '')
        if not tickers:
            return None
        return tickers.split(',')[0].strip().upper()

    @staticmethod
    def _build_headline(source: dict, item: str) -> str:
        company = source.get('display_names', [''])[0] if source.get('display_names') else ''
        form_type = source.get('form_type', '8-K')
        return f"{company} {form_type} Item {item}"

    @staticmethod
    def _build_filing_url(source: dict) -> str:
        accession = source.get('accession_no', '').replace('-', '')
        cik = source.get('entity_id', '')
        if accession and cik:
            return f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession}"
        return ''

    @staticmethod
    def _parse_filing_time(date_str: str, fallback: datetime) -> datetime:
        if date_str:
            try:
                return datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
            except ValueError:
                pass
        return fallback

    @staticmethod
    def _is_regular_hours(event_time: datetime) -> bool:
        hour = event_time.hour
        return 13 <= hour <= 21
