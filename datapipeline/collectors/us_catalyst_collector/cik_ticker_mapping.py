"""CIK-Ticker mapping table maintenance.

Data source: SEC EDGAR company_tickers.json (free, no auth).
Maintains in-memory + DB mapping for CIK-Ticker resolution.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import httpx

from collectors.shared.rate_limiter import RateLimiter
from collectors.shared.retry_with_backoff import retry_with_backoff

logger = logging.getLogger(__name__)

SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"


class CikTickerMapper:
    """Maintains CIK-Ticker bidirectional mapping.

    Loads from SEC EDGAR company_tickers.json (updated daily by SEC).
    Cache refreshed daily; stale cache used as fallback on fetch failure.
    """

    def __init__(self, rate_limiter: RateLimiter | None = None, db_pool: Any = None) -> None:
        self.rate_limiter = rate_limiter
        self.db_pool = db_pool
        self.client = httpx.AsyncClient(
            timeout=30.0,
            headers={
                'User-Agent': 'catalyst-900/1.0 (datapipeline@catalyst900.com)',
                'Accept': 'application/json',
            },
        )
        self._ticker_to_cik: dict[str, str] = {}
        self._cik_to_ticker: dict[str, str] = {}
        self._last_refresh: datetime | None = None

    def count(self) -> int:
        return len(self._ticker_to_cik)

    async def ensure_loaded(self) -> None:
        if self._ticker_to_cik:
            hours_since = (
                (datetime.now(timezone.utc) - self._last_refresh).total_seconds() / 3600
                if self._last_refresh else float('inf')
            )
            if hours_since < 24:
                return
        await self.refresh()

    @retry_with_backoff(max_retries=3, base_delay=5.0)
    async def refresh(self) -> int:
        if self.rate_limiter:
            await self.rate_limiter.acquire()
        resp = await self.client.get(SEC_TICKERS_URL)
        resp.raise_for_status()
        data = resp.json()

        ticker_to_cik: dict[str, str] = {}
        cik_to_ticker: dict[str, str] = {}

        for _idx, entry in data.items():
            cik_str = str(entry.get('cik_str', '')).zfill(10)
            ticker = entry.get('ticker', '').strip().upper()
            if ticker and cik_str:
                ticker_to_cik[ticker] = cik_str
                cik_to_ticker[cik_str] = ticker

        self._ticker_to_cik = ticker_to_cik
        self._cik_to_ticker = cik_to_ticker
        self._last_refresh = datetime.now(timezone.utc)

        logger.info("cik_ticker_mapping refreshed: %d entries", len(ticker_to_cik))

        if self.db_pool is not None:
            await self._persist_to_db(ticker_to_cik)

        return len(ticker_to_cik)

    def ticker_to_cik(self, ticker: str) -> str | None:
        return self._ticker_to_cik.get(ticker.upper())

    def cik_to_ticker(self, cik: str) -> str | None:
        return self._cik_to_ticker.get(cik.zfill(10))

    def ticker_to_cik_url(self, ticker: str) -> str | None:
        cik = self.ticker_to_cik(ticker)
        if cik:
            return f"https://data.sec.gov/submissions/CIK{cik}.json"
        return None

    async def _persist_to_db(self, mapping: dict[str, str]) -> None:
        sql = """
            INSERT INTO cik_ticker_mapping (ticker, cik, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (ticker) DO UPDATE SET cik = $2, updated_at = NOW()
        """
        async with self.db_pool.acquire() as conn:
            for ticker, cik in mapping.items():
                await conn.execute(sql, ticker, cik)
        logger.info("cik_ticker_mapping persisted %d rows", len(mapping))
