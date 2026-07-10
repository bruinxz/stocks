"""SEC EDGAR RSS real-time filing monitor.

Data source: SEC EDGAR company filings RSS/Atom feed.
Frequency: real-time tier 1 — 5min poll + ETag.
Complements SecEdgar8kCollector: daily EOD batch via EFTS, this = real-time RSS.
"""
from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import httpx

from .base import BaseCatalystCollector, CatalystEvent
from .kind_classifier import classify_8k_item, classify_headline
from .timezone_bridge import us_et_to_cn_trading_day
from collectors.shared.rate_limiter import RateLimiter
from collectors.shared.retry_with_backoff import retry_with_backoff
from collectors.shared.idempotency_hash import compute_idempotency_hash

logger = logging.getLogger(__name__)

ATOM_NS = 'http://www.w3.org/2005/Atom'
EDGAR_8K_RSS_URL = (
    "https://www.sec.gov/cgi-bin/browse-edgar"
    "?action=getcompany&type=8-K&dateb=&owner=include&count=40&output=atom"
)


class SecEdgarRssMonitor(BaseCatalystCollector):
    """Real-time SEC EDGAR 8-K filing monitor via Atom RSS feed.

    Frequency: real-time tier 1 — 5min poll.
    Idempotency: UNIQUE (event_source_kind='sec_edgar_rss', ingest_source_hash).
    Cross-source dedup: accession_no overlap with EFTS batch handled by ON CONFLICT DO NOTHING.
    """

    def __init__(self, rate_limiter: RateLimiter, event_writer) -> None:
        super().__init__(
            source_kind='sec_edgar_rss',
            rate_limiter=rate_limiter,
            event_writer=event_writer,
        )
        self.client = httpx.AsyncClient(
            timeout=30.0,
            headers={
                'User-Agent': 'catalyst-900/1.0 (datapipeline@catalyst900.com)',
                'Accept': 'application/atom+xml',
            },
        )
        self._last_etag: str | None = None
        self._last_modified: str | None = None

    async def fetch_events(self, as_of: datetime) -> list[CatalystEvent]:
        entries = await self._poll_rss(as_of)
        events: list[CatalystEvent] = []
        for entry in entries:
            ev = self._parse_atom_entry(entry, as_of)
            if ev is not None:
                events.append(ev)
        return events

    @retry_with_backoff(max_retries=2, base_delay=5.0)
    async def _poll_rss(self, as_of: datetime) -> list[ET.Element]:
        await self.rate_limiter.acquire()

        headers: dict[str, str] = {}
        if self._last_etag:
            headers['If-None-Match'] = self._last_etag
        if self._last_modified:
            headers['If-Modified-Since'] = self._last_modified

        resp = await self.client.get(EDGAR_8K_RSS_URL, headers=headers)

        if resp.status_code == 304:
            return []

        resp.raise_for_status()

        if 'ETag' in resp.headers:
            self._last_etag = resp.headers['ETag']
        if 'Last-Modified' in resp.headers:
            self._last_modified = resp.headers['Last-Modified']

        try:
            root = ET.fromstring(resp.text)
        except ET.ParseError:
            logger.error("sec_edgar_rss XML parse error")
            return []

        return root.findall(f'{{{ATOM_NS}}}entry')

    def _parse_atom_entry(
        self, entry: ET.Element, as_of: datetime,
    ) -> CatalystEvent | None:
        title_el = entry.find(f'{{{ATOM_NS}}}title')
        title = (title_el.text or '').strip() if title_el is not None else ''
        if not title:
            return None

        link_el = entry.find(f'{{{ATOM_NS}}}link')
        link = link_el.get('href', '') if link_el is not None else ''

        updated_el = entry.find(f'{{{ATOM_NS}}}updated')
        event_time = self._parse_atom_date(
            updated_el.text if updated_el is not None else None, as_of,
        )

        if (as_of - event_time).days > 1:
            return None

        accession_no = self._extract_accession(link)
        ticker = self._extract_ticker_from_title(title)

        item_number = self._extract_8k_item(title)
        catalyst_kind = classify_8k_item(item_number) if item_number else classify_headline(title)

        us_trading_day = event_time.date()
        cn_trading_day = us_et_to_cn_trading_day(us_trading_day)

        ingest_source_hash = compute_idempotency_hash(
            accession_no or title,
            self.source_kind,
        )

        ingest_lag = int((as_of - event_time).total_seconds())

        return CatalystEvent(
            catalyst_kind=catalyst_kind,
            us_ticker=ticker,
            us_isin=None,
            event_headline=f"[EDGAR RSS] {title}"[:200],
            event_body_url=link,
            event_time_utc=event_time,
            us_trading_day_et=us_trading_day,
            cn_trading_day_asia_shanghai=cn_trading_day,
            ingest_lag_seconds=max(0, ingest_lag),
            ingest_source_hash=ingest_source_hash,
            is_regular_hours=self._is_regular_hours(event_time),
            source_versions={
                'edgar_rss': 'atom-v1',
                'ingest_date': as_of.date().isoformat(),
            },
        )

    @staticmethod
    def _parse_atom_date(date_str: str | None, fallback: datetime) -> datetime:
        if not date_str:
            return fallback
        try:
            return datetime.fromisoformat(date_str.strip().replace('Z', '+00:00'))
        except (ValueError, TypeError):
            return fallback

    @staticmethod
    def _extract_accession(url: str) -> str:
        parts = url.rstrip('/').split('/')
        for i, p in enumerate(parts):
            if p == 'Archives' and i + 4 < len(parts):
                return parts[i + 3]
        return ''

    @staticmethod
    def _extract_ticker_from_title(title: str) -> str | None:
        if '(' in title and ')' in title:
            start = title.index('(') + 1
            end = title.index(')')
            candidate = title[start:end].strip().upper()
            if candidate.isalpha() and 1 <= len(candidate) <= 5:
                return candidate
        return None

    @staticmethod
    def _extract_8k_item(title: str) -> str | None:
        match = re.search(r'Item\s+(\d+\.\d+)', title)
        return match.group(1) if match else None

    @staticmethod
    def _is_regular_hours(event_time: datetime) -> bool:
        hour = event_time.hour
        return 13 <= hour <= 21
