#!/usr/bin/env python3
"""Build 27 A-share PIT checkpoints with prior-session signals and close execution."""

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
TRADE_COST_RATE = 0.001  # 5 bps commission + 5 bps slippage per traded notional

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
), factor_matrix AS (
  SELECT
    stock_code,
    AVG(percentile) FILTER (
      WHERE factor_name IN ('quality', 'quality_high') AND raw_value IS NOT NULL
    ) AS quality,
    AVG(percentile) FILTER (
      WHERE factor_name IN ('growth', 'earnings_surprise', 'analyst_consensus')
        AND raw_value IS NOT NULL
    ) AS growth,
    AVG(percentile) FILTER (
      WHERE factor_name = 'value' AND raw_value IS NOT NULL
    ) AS valuation,
    AVG(percentile) FILTER (
      WHERE factor_name IN ('momentum', 'money_flow', 'northbound')
        AND raw_value IS NOT NULL
    ) AS momentum,
    AVG(percentile) FILTER (
      WHERE factor_name IN ('gradual_breakout', 'industry_momentum')
        AND raw_value IS NOT NULL
    ) AS trend,
    AVG(percentile) FILTER (
      WHERE factor_name IN ('low_vol', 'liquidity') AND raw_value IS NOT NULL
    ) AS risk
  FROM factor_scores
  WHERE trade_date = %s::date
    AND available_at_utc <= (%s::date::text || 'T15:00:00Z')::timestamptz
  GROUP BY stock_code
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
  matrix.quality,
  matrix.growth,
  matrix.valuation,
  matrix.momentum,
  matrix.trend,
  matrix.risk,
  (
    matrix.quality * 0.20 + matrix.growth * 0.20
    + matrix.valuation * 0.15 + matrix.momentum * 0.20
    + matrix.trend * 0.15 + matrix.risk * 0.10
  ) AS rank_score
FROM factor_matrix matrix
JOIN stocks stock ON RIGHT(stock.symbol, 6) = matrix.stock_code
JOIN stats ON stats.stock_id = stock.id
WHERE stats.session_count >= 15
  AND stats.latest_day = %s::date
  AND stock.type = 'stock'
  AND stock.listing_date <= %s::date
  AND (stock.delisting_date IS NULL OR stock.delisting_date > %s::date)
  AND stock.name NOT ILIKE '%%ST%%'
  AND matrix.quality IS NOT NULL
  AND matrix.growth IS NOT NULL
  AND matrix.valuation IS NOT NULL
  AND matrix.momentum IS NOT NULL
  AND matrix.trend IS NOT NULL
  AND matrix.risk IS NOT NULL
ORDER BY rank_score DESC, stock.symbol ASC
LIMIT 3
"""

EVIDENCE_SQL = """
WITH stock_master AS (
  SELECT COUNT(*)::int AS stock_count,
         COUNT(listing_date)::int AS listing_date_count
    FROM stocks
   WHERE type = 'stock'
), factor_day_coverage AS (
  SELECT fs.trade_date,
         COUNT(DISTINCT fs.stock_code)::int AS universe_size,
         COUNT(DISTINCT fs.stock_code) FILTER (
           WHERE fs.factor_name IN ('quality', 'quality_high') AND fs.raw_value IS NOT NULL
             AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                 <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
         )::int AS q_coverage,
         COUNT(DISTINCT fs.stock_code) FILTER (
           WHERE fs.factor_name IN ('growth', 'earnings_surprise', 'analyst_consensus')
             AND fs.raw_value IS NOT NULL
             AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                 <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
         )::int AS g_coverage,
         COUNT(DISTINCT fs.stock_code) FILTER (
           WHERE fs.factor_name = 'value' AND fs.raw_value IS NOT NULL
             AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                 <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
         )::int AS v_coverage,
         COUNT(DISTINCT fs.stock_code) FILTER (
           WHERE fs.factor_name IN ('momentum', 'money_flow', 'northbound')
             AND fs.raw_value IS NOT NULL
             AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                 <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
         )::int AS m_coverage,
         COUNT(DISTINCT fs.stock_code) FILTER (
           WHERE fs.factor_name IN ('gradual_breakout', 'industry_momentum')
             AND fs.raw_value IS NOT NULL
             AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                 <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
         )::int AS t_coverage,
         COUNT(DISTINCT fs.stock_code) FILTER (
           WHERE fs.factor_name IN ('low_vol', 'liquidity') AND fs.raw_value IS NOT NULL
             AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                 <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
         )::int AS r_coverage
    FROM factor_scores fs
   GROUP BY fs.trade_date
), factor_history AS (
  SELECT COUNT(*) FILTER (
           WHERE q_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
             AND g_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
             AND v_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
             AND m_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
             AND t_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
             AND r_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
         )::int AS complete_factor_day_count
    FROM factor_day_coverage
), availability AS (
  SELECT COUNT(DISTINCT table_name)::int AS available_at_table_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN (
       'factor_scores', 'stock_fundamental_factors', 'stock_valuation_factors'
     )
     AND column_name = 'available_at_utc'
)
SELECT stock_master.stock_count,
       stock_master.listing_date_count,
       factor_history.complete_factor_day_count,
       availability.available_at_table_count
  FROM stock_master CROSS JOIN factor_history CROSS JOIN availability
"""

PRICE_SQL = """
SELECT RIGHT(stock.symbol, 6) AS ticker, bar.close
FROM stocks stock
JOIN daily_bars bar ON bar.stock_id = stock.id
WHERE RIGHT(stock.symbol, 6) = ANY(%s)
  AND stock.type = 'stock'
  AND bar.time::date = %s::date
  AND bar.is_trading_day = TRUE
  AND bar.is_suspended = FALSE
  AND bar.close > 0
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
    # Every execution checkpoint needs a completed prior session from which the
    # factor signal was knowable. Never rank on the same close used to execute.
    eligible = sessions[1:]
    if len(eligible) < CHECKPOINT_COUNT:
        raise RuntimeError("production calendar has fewer than 28 valid sessions")
    indexes = [
        round(index * (len(eligible) - 1) / (CHECKPOINT_COUNT - 1))
        for index in range(CHECKPOINT_COUNT)
    ]
    output = [eligible[index] for index in indexes]
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
            cursor.execute(EVIDENCE_SQL)
            evidence = cursor.fetchone()
            if evidence["listing_date_count"] < evidence["stock_count"]:
                raise RuntimeError(
                    "PIT evidence blocked: security lifecycle incomplete "
                    f"{evidence['listing_date_count']}/{evidence['stock_count']}"
                )
            if evidence["complete_factor_day_count"] < CHECKPOINT_COUNT:
                raise RuntimeError(
                    "PIT evidence blocked: complete six-factor checkpoints "
                    f"{evidence['complete_factor_day_count']}/{CHECKPOINT_COUNT}"
                )
            if evidence["available_at_table_count"] < 3:
                raise RuntimeError(
                    "PIT evidence blocked: available_at_utc coverage "
                    f"{evidence['available_at_table_count']}/3"
                )
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
            previous_session = {
                session: sessions[index - 1]
                for index, session in enumerate(sessions)
                if index > 0
            }
            selections = []
            execution_prices = []
            previous_tickers: set[str] = set()
            for checkpoint in checkpoints:
                signal_day = previous_session[checkpoint]
                cursor.execute(
                    RANK_SQL,
                    (
                        signal_day,
                        signal_day,
                        signal_day,
                        signal_day,
                        signal_day,
                        signal_day,
                        checkpoint,
                    ),
                )
                rows = list(cursor.fetchall())
                if len(rows) != 3:
                    raise RuntimeError(f"checkpoint {checkpoint} has fewer than 3 holdings")
                current_tickers = {
                    str(row["symbol"]).split(".")[-1]
                    for row in rows
                }
                required_tickers = sorted(current_tickers | previous_tickers)
                cursor.execute(PRICE_SQL, (required_tickers, checkpoint))
                prices = {
                    str(row["ticker"]): row["close"]
                    for row in cursor.fetchall()
                }
                missing_prices = sorted(set(required_tickers) - set(prices))
                if missing_prices:
                    raise RuntimeError(
                        f"checkpoint {checkpoint} has non-executable holdings: "
                        + ",".join(missing_prices)
                    )
                selections.append(rows)
                execution_prices.append(prices)
                previous_tickers = current_tickers
    return (
        window_start,
        window_end,
        sessions,
        checkpoints,
        selections,
        execution_prices,
    )


def _build_facts(
    sessions,
    checkpoints,
    selections,
    execution_prices,
    window_start: date,
    window_end: date,
    published_at_utc: datetime,
):
    snapshots = []
    nav = 1.0
    peak_nav = 1.0
    interval_returns: list[float] = []
    previous_prices: dict[str, float] = {}
    previous_weights: dict[str, float] = {}
    entry_prices: dict[str, float] = {}
    calendar_hash = _hash([day.isoformat() for day in sessions])
    session_index = {day: index + 1 for index, day in enumerate(sessions)}

    for checkpoint_index, (checkpoint, rows, checkpoint_prices) in enumerate(
        zip(checkpoints, selections, execution_prices)
    ):
        tickers = [row["symbol"].split(".")[-1] for row in rows]
        prices = {
            ticker: float(checkpoint_prices[ticker])
            for ticker in tickers
        }
        target_weights = {
            ticker: float(weight)
            for ticker, weight in zip(tickers, WEIGHTS)
        }
        previous_nav = nav
        if previous_weights:
            gross_factor = sum(
                weight
                * float(checkpoint_prices[ticker])
                / previous_prices[ticker]
                for ticker, weight in previous_weights.items()
            )
            if not math.isfinite(gross_factor) or gross_factor <= 0:
                raise RuntimeError(f"checkpoint {checkpoint} produced invalid gross return")
            pretrade_weights = {
                ticker: (
                    weight
                    * float(checkpoint_prices[ticker])
                    / previous_prices[ticker]
                    / gross_factor
                )
                for ticker, weight in previous_weights.items()
            }
            traded_notional = sum(
                abs(target_weights.get(ticker, 0.0) - pretrade_weights.get(ticker, 0.0))
                for ticker in set(target_weights) | set(pretrade_weights)
            )
            nav *= gross_factor * (1.0 - traded_notional * TRADE_COST_RATE)
            interval_return = nav / previous_nav - 1.0
            interval_returns.append(interval_return)
        else:
            traded_notional = sum(target_weights.values())
            nav *= 1.0 - traded_notional * TRADE_COST_RATE
            interval_returns.append(nav / previous_nav - 1.0)
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
                "signal_day": sessions[session_index[checkpoint] - 2].isoformat(),
                "signal_close": str(row["current_close"]),
                "execution_close": str(checkpoint_prices[ticker]),
                "oldest_close": str(row["oldest_close"]),
                "session_count": row["session_count"],
                "rank_score": str(row["rank_score"]),
                "quality": str(row["quality"]),
                "growth": str(row["growth"]),
                "valuation": str(row["valuation"]),
                "momentum": str(row["momentum"]),
                "trend": str(row["trend"]),
                "risk": str(row["risk"]),
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
                    {
                        "ticker": ticker,
                        "close": source_material["execution_close"],
                        "day": checkpoint.isoformat(),
                    }
                ),
                "score_fact_hash": _hash(source_material),
                "ranking_method": "six-factor point-in-time weighted score",
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
                source_version="daily-bars-close-execution@2.0.0",
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
            "ranking_method": "six-factor point-in-time weighted score",
            "selected_tickers": tickers,
        }
        snapshot_draft = PitSnapshotFact(
            snapshot_id=_uuid4("pit-snapshot", "us_preferred", "cn_a", checkpoint.isoformat()),
            strategy="us_preferred",
            market_scope="cn_a",
            as_of_utc=as_of,
            snapshot_day=checkpoint,
            published_at_utc=published_at_utc,
            is_survivorship_biased=False,
            is_delisted_at_as_of=False,
            source_versions={
                "calendar": f"production-daily-bars-calendar@{window_end.isoformat()}",
                "membership": "stock-master-listing-history@1.0.0",
                "prices": "daily-bars-close-execution@2.0.0",
                "ranking": "six-factor-prior-session@2.0.0",
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
        previous_weights = target_weights
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
    (
        window_start,
        window_end,
        sessions,
        checkpoints,
        selections,
        execution_prices,
    ) = _read_inputs(database_url, args.window_start, args.window_end)
    facts = _build_facts(
        sessions,
        checkpoints,
        selections,
        execution_prices,
        window_start,
        window_end,
        datetime.now(timezone.utc),
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
