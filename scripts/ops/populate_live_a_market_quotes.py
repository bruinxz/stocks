#!/usr/bin/env python3
"""Refresh A-share stock, index and ETF quotes from Tencent's public quote feed."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


API_URL = "https://qt.gtimg.cn/q="
HEADERS = {
    "Accept": "application/json",
    "Referer": "https://gu.qq.com/",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) stocks-research/1.0",
}


def _load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            values[key] = value.strip().strip('"').strip("'")
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


def _number(value: object) -> float | None:
    if value in (None, "", "-"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _secid(symbol: str, market: str) -> str:
    code = "".join(character for character in symbol if character.isdigit())[-6:]
    prefix = {"SH": "1", "SZ": "0", "BJ": "2"}[market.upper()]
    return f"{prefix}.{code}"


def _fetch_quotes(secids: list[str]) -> list[dict]:
    quotes: list[dict] = []
    for start in range(0, len(secids), 60):
        chunk = secids[start : start + 60]
        symbols = [
            {"1": "sh", "0": "sz", "2": "bj"}[secid.split(".", 1)[0]]
            + secid.split(".", 1)[1]
            for secid in chunk
        ]
        request = Request(API_URL + ",".join(symbols), headers=HEADERS)
        content = None
        for attempt in range(3):
            try:
                with urlopen(request, timeout=20) as response:
                    content = response.read().decode("gbk", errors="replace")
                break
            except (HTTPError, URLError, TimeoutError, OSError):
                if attempt == 2:
                    raise
                time.sleep(1)
        if content is None:
            continue
        for line in content.splitlines():
            if '="' not in line:
                continue
            variable, payload = line.split("=", 1)
            values = payload.strip().rstrip(";").strip('"').split("~")
            if len(values) < 44:
                continue
            market = "1" if variable.startswith("v_sh") else ("2" if variable.startswith("v_bj") else "0")
            exact_amount = values[35].split("/")
            date_text = values[30][:8]
            quotes.append(
                {
                    "secid": f"{market}.{values[2]}",
                    "trade_date": f"{date_text[:4]}-{date_text[4:6]}-{date_text[6:8]}",
                    "f17": values[5],
                    "f2": values[3],
                    "f15": values[33],
                    "f16": values[34],
                    "f5": values[36],
                    "f6": exact_amount[2] if len(exact_amount) > 2 else 0,
                    "f58": values[43],
                    "f3": values[32],
                    "f4": values[31],
                    "f61": values[38],
                    "f12": values[2],
                    "f14": values[1],
                }
            )
    return quotes


SELECT_SECURITIES_SQL = """
SELECT id, symbol, market, type
FROM stocks
WHERE is_listed = TRUE AND type IN ('stock', 'index', 'fund') AND market IN ('SH', 'SZ', 'BJ')
ORDER BY id
"""

UPSERT_BAR_SQL = """
INSERT INTO daily_bars (
  stock_id, time, open, high, low, close, volume, turnover, adj_close,
  turnover_rate, change_percent, amplitude, is_trading_day, is_suspended,
  created_at, updated_at
) VALUES (
  %(stock_id)s, %(time)s, %(open)s, %(high)s, %(low)s, %(close)s, %(volume)s,
  %(turnover)s, %(close)s, %(turnover_rate)s, %(change_percent)s, %(amplitude)s,
  TRUE, FALSE,
  NOW(), NOW()
)
ON CONFLICT (stock_id, time) DO UPDATE SET
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  volume = EXCLUDED.volume,
  turnover = EXCLUDED.turnover,
  adj_close = EXCLUDED.adj_close,
  turnover_rate = EXCLUDED.turnover_rate,
  change_percent = EXCLUDED.change_percent,
  amplitude = EXCLUDED.amplitude,
  is_trading_day = TRUE,
  is_suspended = FALSE,
  updated_at = NOW()
"""

UPDATE_SECURITY_SQL = """
UPDATE stocks
SET price = %(close)s, change_percent = %(change_percent)s, updated_at = NOW()
WHERE id = %(stock_id)s
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    database_group = parser.add_mutually_exclusive_group(required=True)
    database_group.add_argument("--env-file", type=Path)
    database_group.add_argument("--database-url")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    import psycopg

    database_url = args.database_url or _database_url(_load_env(args.env_file))
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(SELECT_SECURITIES_SQL)
            securities = cursor.fetchall()

        by_secid = {
            _secid(symbol, market): {
                "stock_id": stock_id,
                "symbol": symbol,
                "market": market,
                "type": security_type,
            }
            for stock_id, symbol, market, security_type in securities
        }
        raw_quotes = _fetch_quotes(list(by_secid))
        bars: list[dict] = []
        for raw in raw_quotes:
            secid = str(raw.get("secid") or "")
            code = str(raw.get("f12") or "").zfill(6)
            security = by_secid.get(secid)
            close = _number(raw.get("f2"))
            trade_date = str(raw.get("trade_date") or "")
            if security is None or close is None or close <= 0 or not trade_date:
                continue
            open_price = _number(raw.get("f17")) or close
            high = _number(raw.get("f15")) or max(open_price, close)
            low = _number(raw.get("f16")) or min(open_price, close)
            amplitude = _number(raw.get("f58")) or 0
            quote_time = datetime.fromisoformat(f"{trade_date}T15:00:00+08:00")
            bars.append(
                {
                    **security,
                    "name": str(raw.get("f14") or code),
                    "time": datetime.combine(quote_time.date(), datetime.min.time(), tzinfo=timezone.utc),
                    "quote_time": quote_time.isoformat(),
                    "open": open_price,
                    "high": high,
                    "low": low,
                    "close": close,
                    "volume": int(_number(raw.get("f5")) or 0),
                    "turnover": _number(raw.get("f6")) or 0,
                    "turnover_rate": _number(raw.get("f61")) or 0,
                    "change_percent": _number(raw.get("f3")) or 0,
                    "amplitude": amplitude,
                }
            )

        if not args.dry_run:
            with connection.cursor() as cursor:
                cursor.executemany(UPSERT_BAR_SQL, bars)
                cursor.executemany(UPDATE_SECURITY_SQL, bars)
            connection.commit()

    latest_quote_time = max((bar["quote_time"] for bar in bars), default=None)
    counts = {
        security_type: sum(1 for bar in bars if bar["type"] == security_type)
        for security_type in ("stock", "index", "fund")
    }
    print(
        json.dumps(
            {
                "dry_run": args.dry_run,
                "requested": len(securities),
                "received": len(raw_quotes),
                "persisted": 0 if args.dry_run else len(bars),
                "counts": counts,
                "latest_quote_time": latest_quote_time,
                "source": "tencent-public-quote",
            },
            ensure_ascii=False,
        )
    )
    if len(bars) != len(securities):
        missing = sorted(set(by_secid) - {_secid(bar["symbol"], bar["market"]) for bar in bars})
        raise RuntimeError(f"quote coverage incomplete: missing {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
