"""FDA/DOJ/SEC press release RSS collector.

Data sources (all free, no auth):
  FDA press releases RSS, FDA drug approvals RSS,
  DOJ press releases RSS, SEC litigation releases RSS.
Frequency: real-time tier 1 — 5min poll + ETag/Last-Modified differential.
catalyst_kind: 'regulator' hardcoded.
"""
from __future__ import annotations

import hashlib
import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from .base import BaseCatalystCollector, CatalystEvent
from .timezone_bridge import us_et_to_cn_trading_day
from collectors.shared.rate_limiter import RateLimiter
from collectors.shared.retry_with_backoff import retry_with_backoff
from collectors.shared.idempotency_hash import compute_idempotency_hash

logger = logging.getLogger(__name__)

RSS_FEEDS = [
    {
        'name': 'fda_press',
        'url': 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml',
        'agency': 'FDA',
        'format': 'rss',
    },
    {
        'name': 'fda_drug_approvals',
        'url': 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/drug-approvals/rss.xml',
        'agency': 'FDA',
        'format': 'rss',
    },
    {
        'name': 'doj_press',
        'url': 'https://www.justice.gov/feeds/opa/justice-news.xml',
        'agency': 'DOJ',
        'format': 'rss',
    },
    {
        'name': 'sec_litigation',
        'url': 'https://www.sec.gov/rss/litigation/litreleases.xml',
        'agency': 'SEC',
        'format': 'rss',
    },
]


class PressRssCollector(BaseCatalystCollector):
    """Collects regulatory press releases from FDA/DOJ/SEC RSS feeds.

    Frequency: real-time tier 1 — 5min poll + ETag.
    Idempotency: UNIQUE (event_source_kind='press_rss_{agency}', ingest_source_hash).
    catalyst_kind: 'regulator' hardcoded.
    """

    def __init__(self, rate_limiter: RateLimiter, event_writer) -> None:
        super().__init__(
            source_kind='press_rss',
            rate_limiter=rate_limiter,
            event_writer=event_writer,
        )
        self.client = httpx.AsyncClient(
            timeout=30.0,
            headers={
                'User-Agent': 'catalyst-900/1.0 (datapipeline@catalyst900.com)',
                'Accept': 'application/xml, application/rss+xml, application/atom+xml',
            },
        )
        self._etag_cache: dict[str, str] = {}
        self._last_modified_cache: dict[str, str] = {}

    async def fetch_events(self, as_of: datetime) -> list[CatalystEvent]:
        all_events: list[CatalystEvent] = []
        for feed_config in RSS_FEEDS:
            try:
                feed_events = await self._poll_feed(feed_config, as_of)
                all_events.extend(feed_events)
            except Exception:
                logger.warning(
                    "press_rss feed=%s failed, skipping",
                    feed_config['name'], exc_info=True,
                )
        return all_events

    @retry_with_backoff(max_retries=2, base_delay=5.0)
    async def _poll_feed(
        self, feed_config: dict, as_of: datetime,
    ) -> list[CatalystEvent]:
        await self.rate_limiter.acquire()
        feed_name = feed_config['name']
        url = feed_config['url']
        agency = feed_config['agency']

        headers: dict[str, str] = {}
        if feed_name in self._etag_cache:
            headers['If-None-Match'] = self._etag_cache[feed_name]
        if feed_name in self._last_modified_cache:
            headers['If-Modified-Since'] = self._last_modified_cache[feed_name]

        resp = await self.client.get(url, headers=headers)

        if resp.status_code == 304:
            logger.debug("feed=%s 304 Not Modified, skipping", feed_name)
            return []

        resp.raise_for_status()

        if 'ETag' in resp.headers:
            self._etag_cache[feed_name] = resp.headers['ETag']
        if 'Last-Modified' in resp.headers:
            self._last_modified_cache[feed_name] = resp.headers['Last-Modified']

        return self._parse_rss_feed(resp.text, agency, feed_name, as_of)

    def _parse_rss_feed(
        self, xml_text: str, agency: str, feed_name: str, as_of: datetime,
    ) -> list[CatalystEvent]:
        events: list[CatalystEvent] = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            logger.error("feed=%s XML parse error", feed_name)
            return []

        items = root.findall('.//item')
        if not items:
            items = root.findall('.//{http://www.w3.org/2005/Atom}entry')

        for item in items:
            ev = self._parse_rss_item(item, agency, feed_name, as_of)
            if ev is not None:
                events.append(ev)

        return events

    def _parse_rss_item(
        self, item: ET.Element, agency: str, feed_name: str,
        as_of: datetime,
    ) -> CatalystEvent | None:
        title_el = item.find('title')
        if title_el is None:
            title_el = item.find('{http://www.w3.org/2005/Atom}title')
        title = (title_el.text or '').strip() if title_el is not None else ''
        if not title:
            return None

        link_el = item.find('link')
        if link_el is None:
            link_el = item.find('{http://www.w3.org/2005/Atom}link')
        if link_el is not None:
            link = link_el.text or link_el.get('href', '')
        else:
            link = ''
        link = link.strip()

        pub_date_el = item.find('pubDate')
        if pub_date_el is None:
            pub_date_el = item.find('{http://www.w3.org/2005/Atom}updated')
        event_time = self._parse_rss_date(
            pub_date_el.text if pub_date_el is not None else None,
            as_of,
        )

        if (as_of - event_time).days > 3:
            return None

        us_trading_day = event_time.date()
        cn_trading_day = us_et_to_cn_trading_day(us_trading_day)

        headline = f"[{agency}] {title}"

        guid_el = item.find('guid')
        if guid_el is None:
            guid_el = item.find('{http://www.w3.org/2005/Atom}id')
        guid = (guid_el.text or '').strip() if guid_el is not None else ''
        dedup_key = guid or link or hashlib.md5(title.encode()).hexdigest()

        ingest_source_hash = compute_idempotency_hash(
            dedup_key,
            f"press_rss_{agency.lower()}",
        )

        ingest_lag = int((as_of - event_time).total_seconds())

        return CatalystEvent(
            catalyst_kind='regulator',
            us_ticker=None,
            us_isin=None,
            event_headline=headline[:200],
            event_body_url=link,
            event_source_kind=f"press_rss_{agency.lower()}",
            event_time_utc=event_time,
            us_trading_day_et=us_trading_day,
            cn_trading_day_asia_shanghai=cn_trading_day,
            ingest_lag_seconds=max(0, ingest_lag),
            ingest_source_hash=ingest_source_hash,
            is_regular_hours=self._is_regular_hours(event_time),
            source_versions={
                'feed': feed_name,
                'ingest_date': as_of.date().isoformat(),
            },
        )

    @staticmethod
    def _parse_rss_date(date_str: str | None, fallback: datetime) -> datetime:
        if not date_str:
            return fallback
        try:
            return parsedate_to_datetime(date_str.strip())
        except (ValueError, TypeError):
            pass
        try:
            return datetime.fromisoformat(date_str.strip().replace('Z', '+00:00'))
        except (ValueError, TypeError):
            return fallback

    @staticmethod
    def _is_regular_hours(event_time: datetime) -> bool:
        hour = event_time.hour
        return 13 <= hour <= 21
