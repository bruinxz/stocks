#!/usr/bin/env python3
"""Persist a bounded US technology watchlist from Yahoo's public chart response."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time
from typing import Callable
from urllib.parse import quote
from urllib.request import Request, urlopen


SOURCE_KIND = "yahoo-chart-public"
SOURCE_VERSION = "v8-1d"
API_ROOT = "https://query1.finance.yahoo.com/v8/finance/chart"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) stocks-research/1.0",
    "Accept": "application/json",
}

# The universe is deliberately compact. Sector proxies drive the first screen;
# stocks and focus ETFs are the only individual instruments exposed by the UI.
UNIVERSE = {
    "SMH": ("VanEck Semiconductor ETF", "etf", "semiconductor", True, True),
    "IGV": ("iShares Expanded Tech-Software ETF", "etf", "software_cloud", True, True),
    "CIBR": ("First Trust Nasdaq Cybersecurity ETF", "etf", "cybersecurity", True, True),
    "FDN": ("First Trust Dow Jones Internet Index Fund", "etf", "internet_platform", True, False),
    "BOTZ": ("Global X Robotics & Artificial Intelligence ETF", "etf", "ai_robotics", True, False),
    "XLK": ("Technology Select Sector SPDR Fund", "etf", "broad_technology", True, True),
    "QQQ": ("Invesco QQQ Trust", "etf", "nasdaq_100", False, True),
    "SOXX": ("iShares Semiconductor ETF", "etf", "semiconductor", False, True),
    "NVDA": ("NVIDIA", "stock", "semiconductor", False, True),
    "AVGO": ("Broadcom", "stock", "semiconductor", False, True),
    "AMD": ("Advanced Micro Devices", "stock", "semiconductor", False, True),
    "MSFT": ("Microsoft", "stock", "software_cloud", False, True),
    "ORCL": ("Oracle", "stock", "software_cloud", False, True),
    "CRWD": ("CrowdStrike", "stock", "cybersecurity", False, True),
    "PANW": ("Palo Alto Networks", "stock", "cybersecurity", False, True),
    "GOOGL": ("Alphabet", "stock", "internet_platform", False, True),
    "META": ("Meta Platforms", "stock", "internet_platform", False, True),
    "AMZN": ("Amazon", "stock", "software_cloud", False, True),
    "TSLA": ("Tesla", "stock", "ai_robotics", False, True),
    "AAPL": ("Apple", "stock", "broad_technology", False, True),
}
MAX_CAPTURE_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = (1.0, 4.0)


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


def _hash(payload: object) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _chart(symbol: str, days: int) -> dict:
    url = f"{API_ROOT}/{quote(symbol)}?range={days}d&interval=1d&events=div%2Csplits"
    request = Request(url, headers=HEADERS)
    with urlopen(request, timeout=25) as response:
        payload = json.load(response)
    result = payload.get("chart", {}).get("result")
    if not isinstance(result, list) or not result:
        raise RuntimeError(f"invalid Yahoo chart response for {symbol}")
    return result[0]


def _rows(symbol: str, days: int, available_at: datetime) -> list[dict]:
    fallback_name, instrument_type, theme, is_sector_proxy, is_focus = UNIVERSE[symbol]
    chart = _chart(symbol, days)
    meta = chart.get("meta") or {}
    timestamps = chart.get("timestamp") or []
    indicators = chart.get("indicators") or {}
    quotes = (indicators.get("quote") or [{}])[0]
    adjusted = (indicators.get("adjclose") or [{}])[0].get("adjclose") or []
    output: list[dict] = []
    for index, timestamp in enumerate(timestamps):
        values = {
            key: (quotes.get(key) or [None] * len(timestamps))[index]
            for key in ("open", "high", "low", "close", "volume")
        }
        if any(values[key] is None for key in ("open", "high", "low", "close")):
            continue
        effective_at = datetime.fromtimestamp(int(timestamp), timezone.utc)
        fact = {
            "symbol": symbol,
            "trading_day": effective_at.date().isoformat(),
            **values,
            "adjusted_close": adjusted[index] if index < len(adjusted) else None,
        }
        output.append(
            {
                "market_scope": "us",
                "exchange": str(meta.get("exchangeName") or "US"),
                "symbol": symbol,
                "instrument_name": str(meta.get("longName") or meta.get("shortName") or fallback_name),
                "instrument_type": instrument_type,
                "theme": theme,
                "is_sector_proxy": is_sector_proxy,
                "is_focus": is_focus,
                "trading_day": effective_at.date(),
                "open": float(values["open"]),
                "high": float(values["high"]),
                "low": float(values["low"]),
                "close": float(values["close"]),
                "adjusted_close": (
                    float(adjusted[index]) if index < len(adjusted) and adjusted[index] is not None else None
                ),
                "volume": int(values["volume"] or 0),
                "currency": "USD",
                "source_kind": SOURCE_KIND,
                "source_document_id": f"yahoo-chart:{symbol}:{effective_at.date().isoformat()}",
                "source_version": SOURCE_VERSION,
                "effective_at_utc": effective_at,
                "available_at_utc": max(available_at, effective_at),
                "fact_hash": _hash(fact),
            }
        )
    if len(output) < 2:
        raise RuntimeError(f"insufficient daily history for {symbol}")
    return output


def _capture_universe(
    days: int,
    available_at: datetime,
    *,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[list[dict], list[dict[str, object]], list[str]]:
    """Capture all symbols, retrying only transiently failed symbols.

    A failed symbol is never replaced with a stored or synthetic quote. Retries use lower
    concurrency to recover from provider throttling while preserving the all-or-nothing
    completeness gate in ``main``.
    """

    remaining = set(UNIVERSE)
    rows_by_symbol: dict[str, list[dict]] = {}
    attempt_errors: list[dict[str, object]] = []

    for attempt in range(1, MAX_CAPTURE_ATTEMPTS + 1):
        if not remaining:
            break
        if attempt > 1:
            sleep(RETRY_BACKOFF_SECONDS[attempt - 2])
        workers = min(5 if attempt == 1 else 2, len(remaining))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            pending = {
                executor.submit(_rows, symbol, days, available_at): symbol
                for symbol in sorted(remaining)
            }
            for future in as_completed(pending):
                symbol = pending[future]
                try:
                    rows_by_symbol[symbol] = future.result()
                except Exception as error:
                    attempt_errors.append(
                        {
                            "symbol": symbol,
                            "attempt": attempt,
                            "error": str(error)[:200],
                        }
                    )
        remaining.difference_update(rows_by_symbol)

    rows = [
        row
        for symbol in UNIVERSE
        for row in rows_by_symbol.get(symbol, [])
    ]
    return rows, attempt_errors, sorted(remaining)


INSERT_SQL = """
INSERT INTO global_tech_daily_quote (
  market_scope, exchange, symbol, instrument_name, instrument_type, theme,
  is_sector_proxy, is_focus, trading_day, open, high, low, close,
  adjusted_close, volume, currency, source_kind, source_document_id,
  source_version, effective_at_utc, available_at_utc, fact_hash
) VALUES (
  %(market_scope)s, %(exchange)s, %(symbol)s, %(instrument_name)s,
  %(instrument_type)s, %(theme)s, %(is_sector_proxy)s, %(is_focus)s,
  %(trading_day)s, %(open)s, %(high)s, %(low)s, %(close)s,
  %(adjusted_close)s, %(volume)s, %(currency)s, %(source_kind)s,
  %(source_document_id)s, %(source_version)s, %(effective_at_utc)s,
  %(available_at_utc)s, %(fact_hash)s
)
ON CONFLICT (market_scope, symbol, trading_day, source_kind, source_version)
DO UPDATE SET
  instrument_name = EXCLUDED.instrument_name,
  exchange = EXCLUDED.exchange,
  theme = EXCLUDED.theme,
  is_sector_proxy = EXCLUDED.is_sector_proxy,
  is_focus = EXCLUDED.is_focus,
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  adjusted_close = EXCLUDED.adjusted_close,
  volume = EXCLUDED.volume,
  available_at_utc = EXCLUDED.available_at_utc,
  fact_hash = EXCLUDED.fact_hash
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.days < 7 or args.days > 30:
        raise SystemExit("--days must be between 7 and 30")

    available_at = datetime.now(timezone.utc).replace(microsecond=0)
    rows, attempt_errors, missing = _capture_universe(args.days, available_at)
    successful_symbols = {row["symbol"] for row in rows}
    if missing:
        raise RuntimeError(f"US technology capture incomplete: {','.join(missing)}")

    inserted = 0
    if not args.dry_run:
        import psycopg

        with psycopg.connect(_database_url(_load_env(args.env_file))) as connection:
            with connection.cursor() as cursor:
                cursor.executemany(INSERT_SQL, rows)
                inserted = cursor.rowcount

    print(
        json.dumps(
            {
                "dry_run": args.dry_run,
                "quote_count": len(rows),
                "inserted_or_updated": inserted,
                "successful_symbols": sorted(successful_symbols),
                "attempt_errors": attempt_errors,
                "latest_trading_day": max(row["trading_day"] for row in rows).isoformat(),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
