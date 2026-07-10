"""Daily EOD + Realtime RSS pipeline orchestrator.

Two modes:
  1. run_daily_eod_collectors: sequential 4-collector daily batch
  2. run_realtime_rss_monitor: async loop for tier-1 RSS feeds (5-min interval)

Environment variables:
  DATABASE_URL: asyncpg connection string
  YAHOO_OPT_IN: 'true' to enable Yahoo collector (default: 'false')
  RSS_POLL_INTERVAL_SEC: RSS poll interval (default: 300)
"""
from __future__ import annotations

import asyncio
import logging
import os

import asyncpg

from datapipeline.collectors.us_catalyst_collector import (
    SecEdgar8kCollector,
    NasdaqEarningsCalendarCollector,
    YahooRecommendationsCollector,
    PressRssCollector,
    SecEdgarRssMonitor,
    CikTickerMapper,
)
from collectors.shared.rate_limiter import RateLimiter
from datapipeline.storage.us_catalyst.event_writer import EventWriter

logger = logging.getLogger(__name__)


async def run_daily_eod_collectors(pool: asyncpg.Pool) -> dict:
    """Run all EOD collectors once. Returns {source: written_count}."""
    writer = EventWriter(pool)
    results = {}

    mapper = CikTickerMapper()
    await mapper.ensure_loaded()
    logger.info("CIK mapper loaded: %d tickers", mapper.count())

    edgar = SecEdgar8kCollector(
        rate_limiter=RateLimiter(tokens_per_sec=5),
        event_writer=writer,
    )
    results['sec_edgar_8k'] = await edgar.run()

    nasdaq = NasdaqEarningsCalendarCollector(
        rate_limiter=RateLimiter(tokens_per_sec=3),
        event_writer=writer,
    )
    results['nasdaq_earnings'] = await nasdaq.run()

    if os.getenv('YAHOO_OPT_IN', 'false').lower() == 'true':
        yahoo = YahooRecommendationsCollector(
            rate_limiter=RateLimiter(tokens_per_sec=2),
            event_writer=writer,
        )
        results['yahoo_recommendations'] = await yahoo.run()
    else:
        results['yahoo_recommendations'] = 0
        logger.info("yahoo_recommendations: SKIPPED (opt-in=false)")

    rss = PressRssCollector(
        rate_limiter=RateLimiter(tokens_per_sec=2),
        event_writer=writer,
    )
    results['press_rss'] = await rss.run()

    total = sum(results.values())
    logger.info("daily EOD complete: %s total=%d", results, total)
    return results


async def run_realtime_rss_monitor(pool: asyncpg.Pool) -> None:
    """Long-running async loop: EDGAR RSS + press RSS every 5 min."""
    writer = EventWriter(pool)
    interval = int(os.getenv('RSS_POLL_INTERVAL_SEC', '300'))

    edgar_rss = SecEdgarRssMonitor(
        rate_limiter=RateLimiter(tokens_per_sec=5),
        event_writer=writer,
    )
    press_rss = PressRssCollector(
        rate_limiter=RateLimiter(tokens_per_sec=2),
        event_writer=writer,
    )

    logger.info("realtime RSS monitor started interval=%ds", interval)
    while True:
        try:
            n1 = await edgar_rss.run()
            n2 = await press_rss.run()
            logger.info("realtime tick: edgar_rss=%d press_rss=%d", n1, n2)
        except Exception:
            logger.exception("realtime tick error, will retry next interval")
        await asyncio.sleep(interval)


async def main() -> None:
    """Entry point: run daily EOD, then switch to realtime monitor."""
    pool = await asyncpg.create_pool(os.environ['DATABASE_URL'])
    try:
        await run_daily_eod_collectors(pool)
        await run_realtime_rss_monitor(pool)
    finally:
        await pool.close()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
