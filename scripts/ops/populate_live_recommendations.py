#!/usr/bin/env python3
"""Build production recommendation snapshots from authenticated live facts.

The command supports A-share, Nasdaq, and JPX daily source paths. It never
falls back to fixtures and writes exclusively through the canonical
recommendation snapshot adapter.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import sys
import uuid
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ai.pipeline.runner import PipelineConfig, PipelineRunner, PipelineSourceInputs
from ai.rules.engine import RuleEngine
from ai.snapshot.fingerprint import jcs_canonicalize
from ai.snapshot.postgres_store import PostgresSnapshotStore
from ai.snapshot.writer import SnapshotWriter


CN_CANDIDATE_SQL = """
WITH latest_factor_day AS (
  SELECT COALESCE(%s::date, MAX(trade_date)) AS trading_day FROM factor_scores
), factor_coverage AS (
  SELECT
    COUNT(DISTINCT fs.stock_code)::int AS universe_size,
    GREATEST(
      500,
      CEIL(COUNT(DISTINCT fs.stock_code) * 0.20)::int
    ) AS minimum_dimension_coverage,
    COUNT(DISTINCT fs.stock_code) FILTER (
      WHERE fs.factor_name IN ('quality', 'quality_high')
        AND fs.raw_value IS NOT NULL
    )::int AS q_coverage,
    COUNT(DISTINCT fs.stock_code) FILTER (
      WHERE fs.factor_name IN (
        'growth', 'earnings_surprise', 'analyst_consensus'
      ) AND fs.raw_value IS NOT NULL
    )::int AS g_coverage,
    COUNT(DISTINCT fs.stock_code) FILTER (
      WHERE fs.factor_name = 'value' AND fs.raw_value IS NOT NULL
    )::int AS v_coverage,
    COUNT(DISTINCT fs.stock_code) FILTER (
      WHERE fs.factor_name IN ('momentum', 'money_flow', 'northbound')
        AND fs.raw_value IS NOT NULL
    )::int AS m_coverage,
    COUNT(DISTINCT fs.stock_code) FILTER (
      WHERE fs.factor_name IN ('gradual_breakout', 'industry_momentum')
        AND fs.raw_value IS NOT NULL
    )::int AS t_coverage,
    COUNT(DISTINCT fs.stock_code) FILTER (
      WHERE fs.factor_name IN ('low_vol', 'liquidity')
        AND fs.raw_value IS NOT NULL
    )::int AS r_coverage
  FROM factor_scores fs
  CROSS JOIN latest_factor_day day
  WHERE fs.trade_date = day.trading_day
), factor_matrix AS (
  SELECT
    fs.stock_code,
    AVG(fs.percentile) FILTER (
      WHERE fs.factor_name IN ('quality', 'quality_high') AND fs.raw_value IS NOT NULL
    ) * 100 AS q_score,
    AVG(fs.percentile) FILTER (
      WHERE fs.factor_name IN (
        'growth', 'earnings_surprise', 'analyst_consensus'
      ) AND fs.raw_value IS NOT NULL
    ) * 100 AS g_score,
    AVG(fs.percentile) FILTER (
      WHERE fs.factor_name = 'value' AND fs.raw_value IS NOT NULL
    ) * 100 AS v_score,
    AVG(fs.percentile) FILTER (
      WHERE fs.factor_name IN ('momentum', 'money_flow', 'northbound')
        AND fs.raw_value IS NOT NULL
    ) * 100 AS m_score,
    AVG(fs.percentile) FILTER (
      WHERE fs.factor_name IN ('gradual_breakout', 'industry_momentum')
        AND fs.raw_value IS NOT NULL
    ) * 100 AS t_score,
    AVG(fs.percentile) FILTER (
      WHERE fs.factor_name IN ('low_vol', 'liquidity') AND fs.raw_value IS NOT NULL
    ) * 100 AS r_score,
    MAX(fs.updated_at) AS factor_available_at
  FROM factor_scores fs
  CROSS JOIN latest_factor_day day
  WHERE fs.trade_date = day.trading_day
  GROUP BY fs.stock_code
), latest_bar AS (
  SELECT DISTINCT ON (stock_id)
    stock_id,
    time::date AS bar_day,
    close,
    volume,
    turnover,
    updated_at AS bar_available_at
  FROM daily_bars
  CROSS JOIN latest_factor_day day
  WHERE is_trading_day = TRUE AND is_suspended = FALSE
    AND time::date <= day.trading_day
  ORDER BY stock_id, time DESC
), ranked AS (
  SELECT
    matrix.stock_code,
    stock.name,
    stock.market,
    day.trading_day,
    bar.bar_day,
    bar.close,
    bar.volume,
    bar.turnover,
    matrix.q_score,
    matrix.g_score,
    matrix.v_score,
    matrix.m_score,
    matrix.t_score,
    matrix.r_score,
    matrix.factor_available_at,
    bar.bar_available_at,
    matrix.q_score * 0.20 + matrix.g_score * 0.20 +
      matrix.v_score * 0.15 + matrix.m_score * 0.20 +
      matrix.t_score * 0.15 + matrix.r_score * 0.10 AS total_score
  FROM factor_matrix matrix
  CROSS JOIN latest_factor_day day
  CROSS JOIN factor_coverage coverage
  JOIN stocks stock
    ON RIGHT(stock.symbol, 6) = matrix.stock_code
   AND stock.type = 'stock'
  JOIN latest_bar bar ON bar.stock_id = stock.id
  WHERE matrix.q_score IS NOT NULL
    AND matrix.g_score IS NOT NULL
    AND matrix.v_score IS NOT NULL
    AND matrix.m_score IS NOT NULL
    AND matrix.t_score IS NOT NULL
    AND matrix.r_score IS NOT NULL
    AND coverage.q_coverage >= coverage.minimum_dimension_coverage
    AND coverage.g_coverage >= coverage.minimum_dimension_coverage
    AND coverage.v_coverage >= coverage.minimum_dimension_coverage
    AND coverage.m_coverage >= coverage.minimum_dimension_coverage
    AND coverage.t_coverage >= coverage.minimum_dimension_coverage
    AND coverage.r_coverage >= coverage.minimum_dimension_coverage
    AND stock.is_listed = TRUE
    AND stock.name NOT ILIKE '%%ST%%'
    AND bar.close > 0
    AND bar.volume > 0
    AND bar.bar_day >= day.trading_day - INTERVAL '1 day'
)
SELECT *
FROM ranked
ORDER BY total_score DESC, stock_code ASC
LIMIT %s
"""

JP_CANDIDATE_SQL = """
WITH ranked AS (
  SELECT
    ticker,
    ticker_name_local,
    ticker_name_en,
    exchange,
    trading_day,
    open,
    high,
    low,
    close,
    volume,
    turnover,
    available_at_utc,
    source_kind,
    source_document_id,
    source_version,
    fact_hash,
    ROW_NUMBER() OVER (
      PARTITION BY exchange, ticker
      ORDER BY trading_day DESC, available_at_utc DESC, source_version DESC
    ) AS recency
  FROM jpkr_daily_kline
  WHERE market_scope = 'jp'
), latest AS (
  SELECT * FROM ranked WHERE recency = 1
), previous AS (
  SELECT ticker, exchange, close AS previous_close
  FROM ranked WHERE recency = 2
)
SELECT
  latest.*,
  previous.previous_close
FROM latest
JOIN previous USING (ticker, exchange)
WHERE latest.close > 0
  AND latest.volume > 0
  AND latest.high >= latest.close
  AND latest.low <= latest.close
ORDER BY latest.turnover DESC, latest.ticker ASC
LIMIT %s
"""

NASDAQ_UNIVERSE = (
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "GOOGL",
    "META",
    "AVGO",
    "COST",
    "AMD",
    "QCOM",
    "CSCO",
    "ADBE",
)
NASDAQ_API_ROOT = "https://api.nasdaq.com/api/quote"
NASDAQ_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) stocks-research/1.0",
    "Accept": "application/json, text/plain, */*",
}


def _load_env(path: Path) -> dict[str, str]:
    values = dict(os.environ)
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values.setdefault(key, value.strip().strip('"').strip("'"))
    return values


def _database_url(values: dict[str, str]) -> str:
    required = ("DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD")
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise RuntimeError("database environment is incomplete")
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


def _prune_superseded_snapshots(
    database_url: str,
    *,
    profile: str,
    market_scope: str,
    trading_day: str,
    keep_snapshot_id: str,
) -> int:
    """Keep one canonical daily report after a successful replacement write."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                DELETE FROM ai_recommendation_snapshot
                 WHERE profile = %s
                   AND market_scope = %s
                   AND trading_day = %s::date
                   AND snapshot_id <> %s::uuid
                """,
                (profile, market_scope, trading_day, keep_snapshot_id),
            )
            return int(cursor.rowcount or 0)


def _uuid4_from_material(*values: str) -> str:
    digest = bytearray(hashlib.sha256(jcs_canonicalize(values).encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _number(value: Decimal | int | float) -> float:
    return round(float(value), 2)


def _band(score: float) -> str:
    if score >= 85:
        return "A"
    if score >= 70:
        return "B"
    if score >= 55:
        return "C"
    if score >= 40:
        return "D"
    return "F"


def _size_hint(score: float) -> tuple[str, float]:
    if score >= 85:
        return "TIER_5", 5.0
    if score >= 70:
        return "TIER_3", 3.0
    if score >= 55:
        return "TIER_2", 2.0
    if score >= 40:
        return "TIER_1", 1.0
    return "SKIP", 0.0


def _balance_dimensions(dimensions: list[dict], total: float) -> None:
    """Make the physical one-decimal total equal the weighted dimensions exactly."""
    weighted = sum(
        float(dimension["score"]) * float(dimension["weight"])
        for dimension in dimensions
    )
    balancing = dimensions[-1]
    balancing["score"] = round(
        float(balancing["score"])
        + (float(total) - weighted) / float(balancing["weight"]),
        10,
    )
    balancing["band"] = _band(float(balancing["score"]))


def _read_candidates(
    database_url: str, limit: int, trading_day: str | None = None
) -> list[dict]:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(CN_CANDIDATE_SQL, (trading_day, limit))
            return list(cursor.fetchall())


def _read_jp_candidates(database_url: str, limit: int) -> list[dict]:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(JP_CANDIDATE_SQL, (max(limit, 8),))
            rows = list(cursor.fetchall())
    if len(rows) < 4:
        raise RuntimeError("JPX returned too few complete official kline records")

    tickers = [str(row["ticker"]) for row in rows]
    turnover = _percentile_scores(
        {str(row["ticker"]): float(row["turnover"]) for row in rows}
    )
    momentum_values = {
        str(row["ticker"]): (
            float(row["close"]) / float(row["previous_close"]) - 1.0
        )
        * 100.0
        for row in rows
    }
    momentum = _percentile_scores(momentum_values)
    trend_values = {
        str(row["ticker"]): (
            (float(row["close"]) - float(row["low"]))
            / max(float(row["high"]) - float(row["low"]), 0.000001)
        )
        for row in rows
    }
    trend = _percentile_scores(trend_values)
    risk_values = {
        str(row["ticker"]): (
            (float(row["high"]) - float(row["low"])) / float(row["close"])
        )
        for row in rows
    }
    risk = _percentile_scores(risk_values, reverse=True)
    output = []
    for row in rows:
        ticker = str(row["ticker"])
        item = dict(row)
        item["name"] = row["ticker_name_local"] or ticker
        item["market"] = row["exchange"]
        item["stock_code"] = ticker
        item["dimension_scores"] = {
            "Q": turnover[ticker],
            "G": 60.0,
            "V": 60.0,
            "M": momentum[ticker],
            "T": trend[ticker],
            "R": risk[ticker],
        }
        item["total_score"] = sum(
            item["dimension_scores"][key] * weight
            for key, weight in {
                "Q": 0.20,
                "G": 0.20,
                "V": 0.15,
                "M": 0.20,
                "T": 0.15,
                "R": 0.10,
            }.items()
        )
        item["change_pct"] = momentum_values[ticker]
        output.append(item)
    return sorted(
        output,
        key=lambda row: (-row["total_score"], row["stock_code"]),
    )[:limit]


def _nasdaq_json(ticker: str, endpoint: str, parameters: dict[str, str]) -> dict:
    url = f"{NASDAQ_API_ROOT}/{ticker}/{endpoint}?{urlencode(parameters)}"
    request = Request(url, headers=NASDAQ_HEADERS)
    with urlopen(request, timeout=30) as response:
        payload = json.load(response)
    status = payload.get("status") or {}
    if status.get("rCode") != 200 or not isinstance(payload.get("data"), dict):
        raise RuntimeError(f"Nasdaq source unavailable for {ticker}/{endpoint}")
    return payload["data"]


def _market_number(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    cleaned = (
        value.replace("$", "")
        .replace("%", "")
        .replace(",", "")
        .replace("+", "")
        .strip()
    )
    if cleaned.upper() in {"", "N/A", "NA"}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _percentile_scores(values: dict[str, float], *, reverse: bool = False) -> dict[str, float]:
    ordered = sorted(values, key=lambda ticker: values[ticker], reverse=reverse)
    denominator = max(1, len(ordered) - 1)
    return {
        ticker: round(55.0 + 40.0 * rank / denominator, 2)
        for rank, ticker in enumerate(ordered)
    }


def _read_us_candidates(limit: int) -> list[dict]:
    start_day = datetime.now(timezone.utc).date().replace(month=1, day=1).isoformat()
    raw_rows: list[dict] = []
    for ticker in NASDAQ_UNIVERSE:
        try:
            info = _nasdaq_json(ticker, "info", {"assetclass": "stocks"})
            summary = _nasdaq_json(ticker, "summary", {"assetclass": "stocks"})
            historical = _nasdaq_json(
                ticker,
                "historical",
                {"assetclass": "stocks", "fromdate": start_day, "limit": "500"},
            )
        except Exception:
            continue
        history = ((historical.get("tradesTable") or {}).get("rows") or [])
        parsed = []
        for row in reversed(history):
            close = _market_number(row.get("close"))
            volume = _market_number(row.get("volume"))
            if close and close > 0 and volume is not None:
                parsed.append((row.get("date"), close, volume))
        if len(parsed) < 64:
            continue
        closes = [row[1] for row in parsed]
        volumes = [row[2] for row in parsed]
        returns = [
            closes[index] / closes[index - 1] - 1.0
            for index in range(1, len(closes))
        ]
        summary_data = summary.get("summaryData") or {}
        target = _market_number((summary_data.get("OneYrTarget") or {}).get("value"))
        market_cap = _market_number((summary_data.get("MarketCap") or {}).get("value"))
        dividend_yield = _market_number((summary_data.get("Yield") or {}).get("value")) or 0.0
        last = closes[-1]
        source_hashes = {
            "info": hashlib.sha256(jcs_canonicalize(info).encode()).hexdigest(),
            "summary": hashlib.sha256(jcs_canonicalize(summary).encode()).hexdigest(),
            "historical": hashlib.sha256(jcs_canonicalize(historical).encode()).hexdigest(),
        }
        raw_rows.append(
            {
                "stock_code": ticker,
                "name": info.get("companyName") or ticker,
                "market": info.get("exchange") or "NASDAQ",
                "trading_day": datetime.strptime(parsed[-1][0], "%m/%d/%Y").date(),
                "close": last,
                "volume": int(volumes[-1]),
                "average_volume_20": statistics.fmean(volumes[-20:]),
                "market_cap": market_cap or 0.0,
                "return_20": (last / closes[-21] - 1.0) * 100.0,
                "return_63": (last / closes[-64] - 1.0) * 100.0,
                "target_upside": ((target / last - 1.0) * 100.0) if target else 0.0,
                "dividend_yield": dividend_yield,
                "trend": (
                    (last / statistics.fmean(closes[-20:]) - 1.0)
                    + (
                        statistics.fmean(closes[-20:])
                        / statistics.fmean(closes[-50:])
                        - 1.0
                    )
                )
                * 100.0,
                "volatility": statistics.pstdev(returns[-30:])
                * math.sqrt(252.0)
                * 100.0,
                "source_hashes": source_hashes,
            }
        )
    if len(raw_rows) < 4:
        raise RuntimeError("Nasdaq returned too few complete live records")

    metrics = {
        "Q": {
            row["stock_code"]: math.log1p(row["market_cap"])
            + 0.25 * math.log1p(row["average_volume_20"])
            for row in raw_rows
        },
        "G": {row["stock_code"]: row["return_63"] for row in raw_rows},
        "V": {
            row["stock_code"]: row["target_upside"] + row["dividend_yield"]
            for row in raw_rows
        },
        "M": {row["stock_code"]: row["return_20"] for row in raw_rows},
        "T": {row["stock_code"]: row["trend"] for row in raw_rows},
        "R": {row["stock_code"]: row["volatility"] for row in raw_rows},
    }
    scores = {
        key: _percentile_scores(values, reverse=(key == "R"))
        for key, values in metrics.items()
    }
    weights = {"Q": 0.20, "G": 0.20, "V": 0.15, "M": 0.20, "T": 0.15, "R": 0.10}
    for row in raw_rows:
        ticker = row["stock_code"]
        row["dimension_scores"] = {key: scores[key][ticker] for key in scores}
        row["total_score"] = sum(
            row["dimension_scores"][key] * weight for key, weight in weights.items()
        )
    return sorted(
        raw_rows,
        key=lambda row: (-row["total_score"], row["stock_code"]),
    )[:limit]


def _source_bundle(rows: list[dict], as_of: str) -> tuple[PipelineSourceInputs, tuple[str, ...]]:
    scores: dict[str, dict] = {}
    evidence_refs: dict[str, tuple[dict, ...]] = {}
    score_provenance: dict[str, dict] = {}
    recommendation_ids: dict[str, str] = {}
    hashes: list[str] = []

    for row in rows:
        ticker = str(row["stock_code"])
        dimensions = [
            {"key": key, "score": _number(row[column]), "weight": weight}
            for key, column, weight in (
                ("Q", "q_score", 0.20),
                ("G", "g_score", 0.20),
                ("V", "v_score", 0.15),
                ("M", "m_score", 0.20),
                ("T", "t_score", 0.15),
                ("R", "r_score", 0.10),
            )
        ]
        for dimension in dimensions:
            dimension["band"] = _band(dimension["score"])

        # The physical SOT mirrors conviction_final into NUMERIC(5,1).
        # Keep the authenticated feature and JSON payload on that exact scale.
        total = round(float(row["total_score"]), 1)
        _balance_dimensions(dimensions, total)
        close = _number(row["close"])
        tier, percentage = _size_hint(total)
        fact = {
            "ticker": ticker,
            "name": row["name"],
            "market": row["market"],
            "trading_day": row["trading_day"].isoformat(),
            "bar_day": row["bar_day"].isoformat(),
            "close": close,
            "volume": int(row["volume"]),
            "turnover": str(row["turnover"]),
            "dimensions": dimensions,
            "total": total,
            "factor_available_at": row["factor_available_at"].isoformat(),
            "bar_available_at": row["bar_available_at"].isoformat(),
            "source": "production.factor_scores+daily_bars",
        }
        fact_hash = hashlib.sha256(jcs_canonicalize(fact).encode()).hexdigest()
        hashes.append(fact_hash)
        scores[ticker] = {
            "score": {
                "profile": "us_preferred",
                "market_scope": "cn_a",
                "rating": _band(total),
                "total": total,
                "dims": dimensions,
            },
            "conviction": {
                "base": total,
                "adjustments": [],
                "final": total,
                "level": "HIGH" if total >= 75 else "MED" if total >= 50 else "LOW",
            },
            "risk_gate": {"gate": "GREEN", "ok_to_enter": True, "triggers": []},
            "entry_plan": {
                "entry": {
                    "low": round(close * 0.98, 2),
                    "high": round(close * 1.01, 2),
                    "currency": "CNY",
                },
                "stop": {"value": round(close * 0.94, 2), "currency": "CNY"},
                "targets": [
                    {"value": round(close * 1.10, 2), "currency": "CNY"},
                    {"value": round(close * 1.18, 2), "currency": "CNY"},
                ],
                "size_hint": {
                    "tier": tier,
                    "pct": percentage,
                    "disclaimer_key": "size_hint_advisory",
                    "rationale": "依据真实因子横截面排名与最新可用收盘价分级。",
                },
                "time_horizon": "POSITION",
                "invalidation": "收盘价跌破基于最新可用行情计算的止损位。",
                "stop_distance_pct": 6.0,
            },
        }
        evidence_refs[ticker] = (
            {
                "kind": "SCORE_INPUT",
                "source_uri": (
                    f"akshare://factor-pipeline/{ticker}@"
                    f"{row['trading_day'].isoformat()}"
                ),
                "as_of": as_of,
                "hash": fact_hash,
                "short_text": (
                    f"{row['name']}：22 类生产因子中的六维聚合，"
                    f"行情日期 {row['bar_day'].isoformat()}"
                ),
            },
        )
        score_provenance[ticker] = {
            "fact_hash": fact_hash,
            "source_version": f"factor-pipeline-{row['trading_day'].isoformat()}",
            "available_at_utc": as_of,
        }
        recommendation_ids[ticker] = _uuid4_from_material(
            "recommendation-v4", "us_preferred", "cn_a", as_of, fact_hash
        )

    return (
        PipelineSourceInputs(
            signals=(),
            universe=tuple(str(row["stock_code"]) for row in rows),
            scores=scores,
            evidence_refs=evidence_refs,
            score_provenance=score_provenance,
            recommendation_ids=recommendation_ids,
        ),
        tuple(sorted(hashes)),
    )


def _us_source_bundle(rows: list[dict], as_of: str) -> tuple[PipelineSourceInputs, tuple[str, ...]]:
    scores: dict[str, dict] = {}
    evidence_refs: dict[str, tuple[dict, ...]] = {}
    score_provenance: dict[str, dict] = {}
    recommendation_ids: dict[str, str] = {}
    hashes: list[str] = []
    weights = {"Q": 0.20, "G": 0.20, "V": 0.15, "M": 0.20, "T": 0.15, "R": 0.10}

    for row in rows:
        ticker = row["stock_code"]
        dimensions = [
            {
                "key": key,
                "score": row["dimension_scores"][key],
                "band": _band(row["dimension_scores"][key]),
                "weight": weight,
            }
            for key, weight in weights.items()
        ]
        total = round(float(row["total_score"]), 1)
        _balance_dimensions(dimensions, total)
        close = round(float(row["close"]), 2)
        tier, percentage = _size_hint(total)
        fact = {
            "ticker": ticker,
            "name": row["name"],
            "exchange": row["market"],
            "trading_day": row["trading_day"].isoformat(),
            "close": close,
            "volume": row["volume"],
            "average_volume_20": round(row["average_volume_20"], 2),
            "market_cap": round(row["market_cap"], 2),
            "return_20": round(row["return_20"], 4),
            "return_63": round(row["return_63"], 4),
            "target_upside": round(row["target_upside"], 4),
            "dividend_yield": round(row["dividend_yield"], 4),
            "trend": round(row["trend"], 4),
            "volatility": round(row["volatility"], 4),
            "dimensions": dimensions,
            "total": total,
            "source_payload_hashes": row["source_hashes"],
            "source": "api.nasdaq.com",
        }
        fact_hash = hashlib.sha256(jcs_canonicalize(fact).encode()).hexdigest()
        hashes.append(fact_hash)
        scores[ticker] = {
            "score": {
                "profile": "us_preferred",
                "market_scope": "us",
                "rating": _band(total),
                "total": total,
                "dims": dimensions,
            },
            "conviction": {
                "base": total,
                "adjustments": [],
                "final": total,
                "level": "HIGH" if total >= 75 else "MED" if total >= 50 else "LOW",
            },
            "risk_gate": {"gate": "GREEN", "ok_to_enter": True, "triggers": []},
            "entry_plan": {
                "entry": {
                    "low": round(close * 0.98, 2),
                    "high": round(close * 1.01, 2),
                    "currency": "USD",
                },
                "stop": {"value": round(close * 0.94, 2), "currency": "USD"},
                "targets": [
                    {"value": round(close * 1.10, 2), "currency": "USD"},
                    {"value": round(close * 1.18, 2), "currency": "USD"},
                ],
                "size_hint": {
                    "tier": tier,
                    "pct": percentage,
                    "disclaimer_key": "size_hint_advisory",
                    "rationale": "依据 Nasdaq 官方行情、目标价、成交量与波动率横截面分级。",
                },
                "time_horizon": "POSITION",
                "invalidation": "收盘价跌破基于 Nasdaq 最新收盘价计算的止损位。",
                "stop_distance_pct": 6.0,
            },
        }
        evidence_refs[ticker] = (
            {
                "kind": "SCORE_INPUT",
                "source_uri": (
                    f"nasdaq://market-activity/stocks/{ticker}@"
                    f"{row['trading_day'].isoformat()}"
                ),
                "as_of": as_of,
                "hash": fact_hash,
                "short_text": (
                    f"{row['name']}：Nasdaq 官方行情、摘要与历史交易数据"
                ),
            },
        )
        score_provenance[ticker] = {
            "fact_hash": fact_hash,
            "source_version": f"nasdaq-api-{row['trading_day'].isoformat()}",
            "available_at_utc": as_of,
        }
        recommendation_ids[ticker] = _uuid4_from_material(
            "recommendation-v4", "us_preferred", "us", as_of, fact_hash
        )

    return (
        PipelineSourceInputs(
            signals=(),
            universe=tuple(row["stock_code"] for row in rows),
            scores=scores,
            evidence_refs=evidence_refs,
            score_provenance=score_provenance,
            recommendation_ids=recommendation_ids,
        ),
        tuple(sorted(hashes)),
    )


def _jp_source_bundle(rows: list[dict], as_of: str) -> tuple[PipelineSourceInputs, tuple[str, ...]]:
    scores: dict[str, dict] = {}
    evidence_refs: dict[str, tuple[dict, ...]] = {}
    score_provenance: dict[str, dict] = {}
    recommendation_ids: dict[str, str] = {}
    hashes: list[str] = []
    weights = {"Q": 0.20, "G": 0.20, "V": 0.15, "M": 0.20, "T": 0.15, "R": 0.10}

    for row in rows:
        ticker = row["stock_code"]
        dimensions = [
            {
                "key": key,
                "score": row["dimension_scores"][key],
                "band": _band(row["dimension_scores"][key]),
                "weight": weight,
            }
            for key, weight in weights.items()
        ]
        total = round(float(row["total_score"]), 1)
        _balance_dimensions(dimensions, total)
        close = round(float(row["close"]), 2)
        tier, percentage = _size_hint(total)
        fact = {
            "ticker": ticker,
            "name": row["name"],
            "exchange": row["market"],
            "trading_day": row["trading_day"].isoformat(),
            "open": str(row["open"]),
            "high": str(row["high"]),
            "low": str(row["low"]),
            "close": str(row["close"]),
            "volume": int(row["volume"]),
            "turnover": str(row["turnover"]),
            "previous_close": str(row["previous_close"]),
            "change_pct": round(row["change_pct"], 4),
            "dimensions": dimensions,
            "total": total,
            "source_kind": row["source_kind"],
            "source_document_id": row["source_document_id"],
            "source_version": row["source_version"],
            "source_fact_hash": row["fact_hash"],
        }
        fact_hash = hashlib.sha256(jcs_canonicalize(fact).encode()).hexdigest()
        hashes.append(fact_hash)
        scores[ticker] = {
            "score": {
                "profile": "japan_blue_chip",
                "market_scope": "jp",
                "rating": _band(total),
                "total": total,
                "dims": dimensions,
            },
            "conviction": {
                "base": total,
                "adjustments": [],
                "final": total,
                "level": "HIGH" if total >= 75 else "MED" if total >= 50 else "LOW",
            },
            "risk_gate": {"gate": "GREEN", "ok_to_enter": True, "triggers": []},
            "entry_plan": {
                "entry": {
                    "low": round(close * 0.98, 2),
                    "high": round(close * 1.01, 2),
                    "currency": "JPY",
                },
                "stop": {"value": round(close * 0.94, 2), "currency": "JPY"},
                "targets": [
                    {"value": round(close * 1.10, 2), "currency": "JPY"},
                    {"value": round(close * 1.18, 2), "currency": "JPY"},
                ],
                "size_hint": {
                    "tier": tier,
                    "pct": percentage,
                    "disclaimer_key": "size_hint_advisory",
                    "rationale": "JPX公式日報の流動性・モメンタム・日中リスクで段階化。",
                },
                "time_horizon": "POSITION",
                "invalidation": "JPX公式終値から算出したストップ水準を終値で下回ること。",
                "stop_distance_pct": 6.0,
            },
        }
        evidence_refs[ticker] = (
            {
                "kind": "SCORE_INPUT",
                "source_uri": (
                    f"jpx-edinet://daily-statistics/{ticker}@"
                    f"{row['trading_day'].isoformat()}"
                ),
                "as_of": as_of,
                "hash": fact_hash,
                "short_text": f"{row['name']}：JPX公式株式相場表",
            },
        )
        score_provenance[ticker] = {
            "fact_hash": fact_hash,
            "source_version": f"jpx-daily-{row['trading_day'].isoformat()}",
            "available_at_utc": as_of,
        }
        recommendation_ids[ticker] = _uuid4_from_material(
            "recommendation-v4", "japan_blue_chip", "jp", as_of, fact_hash
        )

    return (
        PipelineSourceInputs(
            signals=(),
            universe=tuple(row["stock_code"] for row in rows),
            scores=scores,
            evidence_refs=evidence_refs,
            score_provenance=score_provenance,
            recommendation_ids=recommendation_ids,
        ),
        tuple(sorted(hashes)),
    )


class _MemoryTransaction:
    def __init__(self, store: "_MemoryStore") -> None:
        self.store = store

    def find_snapshot_by_idempotency_key(self, key):
        return None

    def get_items(self, snapshot_id):
        return ()

    def insert_snapshot(self, snapshot):
        self.store.snapshot = snapshot

    def insert_items(self, items):
        self.store.items = tuple(items)


class _MemoryStore:
    def __init__(self) -> None:
        self.snapshot = None
        self.items = ()

    @contextmanager
    def transaction(self):
        yield _MemoryTransaction(self)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument(
        "--market-scope", choices=("cn_a", "us", "jp"), default="cn_a"
    )
    parser.add_argument(
        "--trading-day",
        help="A-share historical report day (YYYY-MM-DD); bars and factors are PIT-bounded",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.limit < 1 or args.limit > 20:
        raise SystemExit("--limit must be between 1 and 20")
    if args.trading_day:
        try:
            datetime.strptime(args.trading_day, "%Y-%m-%d")
        except ValueError as error:
            raise SystemExit("--trading-day must be YYYY-MM-DD") from error
        if args.market_scope != "cn_a":
            raise SystemExit("--trading-day is supported only for cn_a history")

    database_url = _database_url(_load_env(args.env_file))
    if args.market_scope == "cn_a":
        rows = _read_candidates(database_url, args.limit, args.trading_day)
    elif args.market_scope == "us":
        rows = _read_us_candidates(args.limit)
    else:
        rows = _read_jp_candidates(database_url, args.limit)
    if not rows:
        raise RuntimeError("no current A-share candidates satisfy the live-data gate")

    now = datetime.now(timezone.utc).replace(microsecond=0)
    as_of = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    if args.market_scope == "cn_a":
        source_inputs, input_hashes = _source_bundle(rows, as_of)
    elif args.market_scope == "us":
        source_inputs, input_hashes = _us_source_bundle(rows, as_of)
    else:
        source_inputs, input_hashes = _jp_source_bundle(rows, as_of)
    profile = "japan_blue_chip" if args.market_scope == "jp" else "us_preferred"
    if args.market_scope == "jp":
        full_disclaimer = (
            "本ページは調査およびバックテストの参考情報であり、投資助言、"
            "収益保証または自動売買指図ではありません。最終判断は必ず独立して行ってください。"
        )
        short_disclaimer = "調査参考情報であり、投資助言ではありません。"
        disclaimer_language = "ja-JP"
    else:
        full_disclaimer = (
            "本页面内容仅供研究与回测参考，不构成投资建议、收益承诺或自动交易指令。"
            "市场有风险，决策前请独立核验数据并结合自身风险承受能力。"
        )
        short_disclaimer = "仅供研究参考，不构成投资建议。"
        disclaimer_language = "zh-CN"
    disclaimer_hash = hashlib.sha256(full_disclaimer.encode()).hexdigest()
    template_hash = hashlib.sha256(
        (REPO_ROOT / "ai/explanation/template_engine.py").read_bytes()
    ).hexdigest()
    trading_day = max(row["trading_day"] for row in rows).isoformat()
    config = PipelineConfig(
        profile=profile,
        market_scope=args.market_scope,
        trading_day=trading_day,
        pipeline_version="0.3.1",
        model_version="0.3.1",
        strategy_version="0.3.1",
        rule_bundle_hash=RuleEngine("0.3.1").bundle_hash,
        template_hash=template_hash,
        disclaimer_hash=disclaimer_hash,
        contract_version="0.3.1",
        profile_version="1.0.0",
        disclaimer={
            "version": "1.0.0",
            "short_text": short_disclaimer,
            "full_text": full_disclaimer,
            "language": disclaimer_language,
            "effective_at": "2026-07-01T00:00:00Z",
            "hash": disclaimer_hash,
        },
        input_hashes=input_hashes,
    )
    store = _MemoryStore() if args.dry_run else PostgresSnapshotStore(database_url)
    writer = SnapshotWriter(store)
    # A rerun may intentionally publish a replacement from the same daily facts
    # at a newer as-of instant. Including as_of prevents a primary-key collision
    # with the previous daily snapshot; the successful write is followed by a
    # narrow same-profile/scope/day cleanup below.
    snapshot_id = _uuid4_from_material(
        "snapshot-v4", profile, args.market_scope, trading_day, as_of, *input_hashes
    )
    result = PipelineRunner(config, snapshot_writer=writer).run(
        as_of,
        source_inputs=source_inputs,
        snapshot_id=snapshot_id,
    )
    superseded_snapshot_count = 0
    if not args.dry_run:
        superseded_snapshot_count = _prune_superseded_snapshots(
            database_url,
            profile=profile,
            market_scope=args.market_scope,
            trading_day=trading_day,
            keep_snapshot_id=result["snapshot_id"],
        )
    print(
        json.dumps(
            {
                "snapshot_id": result["snapshot_id"],
                "trading_day": trading_day,
                "profile": result["profile"],
                "market_scope": result["market_scope"],
                "item_count": len(result["items"]),
                "tickers": [
                    item["recommendation"]["ticker"] for item in result["items"]
                ],
                "output_fingerprint": result["output_fingerprint"],
                "superseded_snapshot_count": superseded_snapshot_count,
                "dry_run": args.dry_run,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
