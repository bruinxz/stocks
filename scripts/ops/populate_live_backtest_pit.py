#!/usr/bin/env python3
"""Build 27 real-calendar A-share PIT checkpoints from production daily bars."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_EVEN
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import sys
import uuid
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from datapipeline.storage.backtest_pit.writer import (
    PitHoldingFact,
    PitSnapshotFact,
    PitSnapshotWriter,
    canonical_holding_hash,
    canonical_snapshot_hash,
)


CHECKPOINT_COUNT = 27
DEFAULT_WINDOW_DAYS = 183
WEIGHTS = (Decimal("0.3333333333"), Decimal("0.3333333333"), Decimal("0.3333333334"))

SESSIONS_SQL = """
SELECT time::date AS trading_day
FROM daily_bars
WHERE time::date BETWEEN %s AND %s
  AND is_trading_day = TRUE
GROUP BY time::date
HAVING COUNT(*) >= 100
ORDER BY trading_day
"""

RANK_SQL = """
WITH recent AS (
  SELECT
    bar.stock_id,
    bar.time::date AS trading_day,
    bar.close,
    bar.turnover,
    bar.change_percent
  FROM daily_bars bar
  WHERE bar.time::date <= %s::date
    AND bar.time::date > %s::date - INTERVAL '45 days'
    AND bar.is_trading_day = TRUE
    AND bar.is_suspended = FALSE
    AND bar.close > 0
), stats AS (
  SELECT
    stock_id,
    COUNT(*) AS session_count,
    (ARRAY_AGG(close ORDER BY trading_day DESC))[1] AS current_close,
    (ARRAY_AGG(close ORDER BY trading_day ASC))[1] AS oldest_close,
    AVG(turnover) AS average_turnover,
    COALESCE(STDDEV_POP(change_percent), 0) AS volatility,
    MAX(trading_day) AS latest_day
  FROM recent
  GROUP BY stock_id
)
SELECT
  stock.symbol,
  stock.name,
  stock.market,
  stats.current_close,
  stats.oldest_close,
  stats.session_count,
  stats.average_turnover,
  stats.volatility,
  stats.latest_day,
  stock.listing_date,
  stock.delisting_date,
  (
    ((stats.current_close / NULLIF(stats.oldest_close, 0)) - 1) * 0.70
    + LN(COALESCE(stats.average_turnover, 0) + 1) * 0.01
    - ABS(stats.volatility) * 0.01
  ) AS rank_score
FROM stats
JOIN stocks stock ON stock.id = stats.stock_id
WHERE stats.session_count >= 15
  AND stats.latest_day = %s::date
  AND stock.type = 'stock'
  AND stock.listing_date <= %s::date
  AND (stock.delisting_date IS NULL OR stock.delisting_date > %s::date)
  AND stock.name NOT ILIKE '%%ST%%'
ORDER BY rank_score DESC, stock.symbol ASC
LIMIT 3
"""

PRICE_SQL = """
SELECT RIGHT(stock.symbol, 6) AS ticker, bar.close
FROM stocks stock
JOIN LATERAL (
  SELECT close
  FROM daily_bars
  WHERE stock_id = stock.id
    AND time::date <= %s::date
    AND is_trading_day = TRUE
    AND is_suspended = FALSE
  ORDER BY time DESC
  LIMIT 1
) bar ON TRUE
WHERE RIGHT(stock.symbol, 6) = ANY(%s)
  AND stock.type = 'stock'
"""


def _load_env(path: Path) -> dict[str, str]:
    values = dict(os.environ)
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            values.setdefault(key, value.strip().strip('"').strip("'"))
    return values


def _database_url(values: dict[str, str]) -> str:
    return (
        "postgresql://"
        + quote(values["DB_USER"], safe="")
        + ":"
        + quote(values["DB_PASSWORD"], safe="")
        + "@"
        + values["DB_HOST"]
        + ":"
        + values["DB_PORT"]
        + "/"
        + quote(values["DB_NAME"], safe="")
        + "?sslmode=disable"
    )


def _uuid4(*material: str) -> str:
    digest = bytearray(
        hashlib.sha256(
            json.dumps(material, ensure_ascii=False, separators=(",", ":")).encode()
        ).digest()[:16]
    )
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode()
    ).hexdigest()


def _checkpoints(sessions: list[date]) -> list[date]:
    if len(sessions) < CHECKPOINT_COUNT:
        raise RuntimeError("production calendar has fewer than 27 valid sessions")
    indexes = [round(index * (len(sessions) - 1) / (CHECKPOINT_COUNT - 1)) for index in range(CHECKPOINT_COUNT)]
    output = [sessions[index] for index in indexes]
    if len(set(output)) != CHECKPOINT_COUNT:
        raise RuntimeError("checkpoint sampling produced duplicate sessions")
    return output


def _quantized(value: float) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_EVEN)


def _read_inputs(
    database_url: str,
    requested_start: date | None,
    requested_end: date | None,
):
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            window_end = requested_end
            if window_end is None:
                cursor.execute(
                    """
                    WITH listed AS (
                      SELECT COUNT(*)::numeric AS total
                        FROM stocks
                       WHERE is_listed = TRUE AND type = 'stock'
                    ), coverage AS (
                      SELECT bar.time::date AS trading_day,
                             COUNT(DISTINCT bar.stock_id)::numeric AS covered
                        FROM daily_bars bar
                        JOIN stocks stock ON stock.id = bar.stock_id
                       WHERE bar.is_trading_day = TRUE
                         AND stock.is_listed = TRUE
                         AND stock.type = 'stock'
                       GROUP BY bar.time::date
                    )
                    SELECT MAX(coverage.trading_day) AS trading_day
                      FROM coverage CROSS JOIN listed
                     WHERE coverage.covered >= CEIL(listed.total * 0.80)
                    """
                )
                latest = cursor.fetchone()
                window_end = latest["trading_day"] if latest else None
            if window_end is None:
                raise RuntimeError("daily_bars does not contain a broad-market trading day")
            window_start = requested_start or (window_end - timedelta(days=DEFAULT_WINDOW_DAYS))
            if window_start >= window_end:
                raise RuntimeError("window start must be earlier than window end")
            cursor.execute(SESSIONS_SQL, (window_start, window_end))
            sessions = [row["trading_day"] for row in cursor.fetchall()]
            checkpoints = _checkpoints(sessions)
            selections = []
            for checkpoint in checkpoints:
                cursor.execute(
                    RANK_SQL,
                    (checkpoint, checkpoint, checkpoint, checkpoint, checkpoint),
                )
                rows = list(cursor.fetchall())
                if len(rows) != 3:
                    raise RuntimeError(f"checkpoint {checkpoint} has fewer than 3 holdings")
                selections.append(rows)
    return window_start, window_end, sessions, checkpoints, selections


def _build_facts(sessions, checkpoints, selections, window_start: date, window_end: date):
    snapshots = []
    nav = 1.0
    peak_nav = 1.0
    interval_returns: list[float] = []
    previous_prices: dict[str, float] = {}
    entry_prices: dict[str, float] = {}
    calendar_hash = _hash([day.isoformat() for day in sessions])
    session_index = {day: index + 1 for index, day in enumerate(sessions)}

    for checkpoint_index, (checkpoint, rows) in enumerate(zip(checkpoints, selections)):
        tickers = [row["symbol"].split(".")[-1] for row in rows]
        prices = {
            row["symbol"].split(".")[-1]: float(row["current_close"])
            for row in rows
        }
        if previous_prices:
            comparable = [
                prices[ticker] / previous_prices[ticker] - 1.0
                for ticker in prices
                if ticker in previous_prices
            ]
            gross_return = statistics.fmean(comparable) if comparable else 0.0
            changed = len(set(prices) ^ set(previous_prices)) / 3.0
            interval_return = gross_return - changed * 0.002
            nav *= 1.0 + interval_return
            interval_returns.append(interval_return)
        else:
            nav *= 0.999
            interval_returns.append(-0.001)
        peak_nav = max(peak_nav, nav)

        for ticker in list(entry_prices):
            if ticker not in prices:
                del entry_prices[ticker]
        for ticker, price in prices.items():
            entry_prices.setdefault(ticker, price)

        as_of = datetime.combine(checkpoint, time(hour=7), tzinfo=timezone.utc)
        holdings = []
        for position, (row, weight) in enumerate(zip(rows, WEIGHTS)):
            ticker = tickers[position]
            source_material = {
                "ticker": ticker,
                "checkpoint": checkpoint.isoformat(),
                "close": str(row["current_close"]),
                "oldest_close": str(row["oldest_close"]),
                "session_count": row["session_count"],
                "rank_score": str(row["rank_score"]),
                "listing_date": row["listing_date"].isoformat(),
                "delisting_date": (
                    row["delisting_date"].isoformat()
                    if row["delisting_date"] is not None
                    else None
                ),
            }
            lineage = {
                "is_delisted_at_as_of": False,
                "membership_fact_hash": _hash(
                    {"ticker": ticker, "listing_date": source_material["listing_date"], "day": checkpoint.isoformat()}
                ),
                "price_fact_hash": _hash(
                    {"ticker": ticker, "close": source_material["close"], "day": checkpoint.isoformat()}
                ),
                "score_fact_hash": _hash(source_material),
                "ranking_method": "20-session momentum+liquidity-volatility",
            }
            draft = PitHoldingFact(
                holding_id=_uuid4("pit-holding", "us_preferred", "cn_a", checkpoint.isoformat(), ticker),
                position_order=position,
                market_scope="cn_a",
                ticker=ticker,
                weight=weight,
                return_since_entry=_quantized(prices[ticker] / entry_prices[ticker] - 1.0),
                is_stale=False,
                is_delisted_at_as_of=False,
                source_kind="production-daily-bars",
                source_document_id=f"daily-bars:{ticker}:{checkpoint.isoformat()}",
                source_version="daily-bars-pit@1.0.0",
                available_at_utc=as_of,
                lineage=lineage,
                fact_hash="0" * 64,
            )
            holdings.append(replace(draft, fact_hash=canonical_holding_hash(draft)))

        cumulative = nav - 1.0
        sharpe = None
        if len(interval_returns) >= 2 and statistics.pstdev(interval_returns) > 0:
            sharpe = statistics.fmean(interval_returns) / statistics.pstdev(interval_returns) * math.sqrt(26.0)
        metrics = {
            "net_value": nav,
            "drawdown": nav / peak_nav - 1.0,
            "cumulative_return": cumulative,
            "sharpe_ratio_6m": sharpe,
            "win_rate_6m": sum(value > 0 for value in interval_returns) / len(interval_returns),
            "metric_contract_version": "1.0.0",
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "evaluated_session_count": session_index[checkpoint],
            "checkpoint_index": checkpoint_index,
            "checkpoint_count": CHECKPOINT_COUNT,
            "initial_nav": 1.0,
            "commission_bps_per_side": 5,
            "slippage_bps_per_side": 5,
            "annualization_sessions": 252,
        }
        lineage_closure = {
            "survivorship_evidence": {
                "method": "stock listing_date/delisting_date filtered at every checkpoint",
                "calendar_hash": calendar_hash,
                "source": "production stocks + daily_bars",
            },
            "calendar_sessions_hash": calendar_hash,
            "ranking_method": "20-session momentum+liquidity-volatility",
            "selected_tickers": tickers,
        }
        snapshot_draft = PitSnapshotFact(
            snapshot_id=_uuid4("pit-snapshot", "us_preferred", "cn_a", checkpoint.isoformat()),
            strategy="us_preferred",
            market_scope="cn_a",
            as_of_utc=as_of,
            snapshot_day=checkpoint,
            published_at_utc=as_of + timedelta(minutes=5),
            is_survivorship_biased=False,
            is_delisted_at_as_of=False,
            source_versions={
                "calendar": f"production-daily-bars-calendar@{window_end.isoformat()}",
                "membership": "stock-master-listing-history@1.0.0",
                "prices": "daily-bars-pit@1.0.0",
                "ranking": "momentum-liquidity-risk@1.0.0",
                "cost_model": "commission5-slippage5@1.0.0",
            },
            lineage_closure=lineage_closure,
            metrics=metrics,
            fact_hash="0" * 64,
        )
        snapshot = replace(
            snapshot_draft,
            fact_hash=canonical_snapshot_hash(snapshot_draft, holdings),
        )
        snapshots.append((snapshot, tuple(holdings)))
        previous_prices = prices
    return snapshots


async def _write(values, facts):
    import asyncpg

    pool = await asyncpg.create_pool(
        host=values["DB_HOST"],
        port=int(values["DB_PORT"]),
        database=values["DB_NAME"],
        user=values["DB_USER"],
        password=values["DB_PASSWORD"],
        min_size=1,
        max_size=2,
    )
    manifests = []
    deleted = 0
    try:
        writer = PitSnapshotWriter(pool, validation_profile="rolling_production")
        # Validate every immutable fact before replacing the previous production
        # window. Frozen fixture rows use a different calendar source and are never
        # touched by this live maintenance script.
        for snapshot, holdings in facts:
            writer.validate(snapshot, holdings)
        async with pool.acquire() as connection:
            deleted = await connection.fetchval(
                """
                WITH deleted AS (
                  DELETE FROM backtest_pit_snapshot
                   WHERE strategy = 'us_preferred'
                     AND market_scope = 'cn_a'
                     AND source_versions->>'calendar'
                         LIKE 'production-daily-bars-calendar@%'
                  RETURNING 1
                )
                SELECT COUNT(*) FROM deleted
                """
            )
        for snapshot, holdings in facts:
            manifests.append(await writer.write_or_verify(snapshot, holdings))
    finally:
        await pool.close()
    return manifests, int(deleted or 0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--window-start", type=date.fromisoformat)
    parser.add_argument("--window-end", type=date.fromisoformat)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    values = _load_env(args.env_file)
    database_url = _database_url(values)
    window_start, window_end, sessions, checkpoints, selections = _read_inputs(
        database_url,
        args.window_start,
        args.window_end,
    )
    facts = _build_facts(
        sessions,
        checkpoints,
        selections,
        window_start,
        window_end,
    )
    if args.dry_run:
        manifests = []
        deleted = 0
    else:
        manifests, deleted = asyncio.run(_write(values, facts))
    print(
        json.dumps(
            {
                "strategy": "us_preferred",
                "market_scope": "cn_a",
                "dry_run": args.dry_run,
                "actual_session_count": len(sessions),
                "snapshot_count": len(facts),
                "holding_count": len(facts) * 3,
                "inserted": sum(manifest.inserted for manifest in manifests),
                "replaced_snapshot_count": deleted,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "first_day": checkpoints[0].isoformat(),
                "last_day": checkpoints[-1].isoformat(),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
