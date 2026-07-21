#!/usr/bin/env python3
"""Persist a bounded Korean technology representative watchlist from Naver quotes."""

from __future__ import annotations

import argparse
from datetime import date, datetime, time, timezone
import hashlib
import json
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


UNIVERSE = {
    "005930": {"name_en": "Samsung Electronics", "sector": "semiconductor"},
    "000660": {"name_en": "SK Hynix", "sector": "semiconductor"},
    "042700": {"name_en": "Hanmi Semiconductor", "sector": "semiconductor"},
    "035420": {"name_en": "NAVER", "sector": "internet_platform"},
    "035720": {"name_en": "Kakao", "sector": "internet_platform"},
    "373220": {"name_en": "LG Energy Solution", "sector": "battery"},
    "006400": {"name_en": "Samsung SDI", "sector": "battery"},
    "277810": {"name_en": "Rainbow Robotics", "sector": "ai_robotics"},
}
SOURCE_KIND = "naver-public"
SOURCE_VERSION = "naver-mobile-v1"
API_ROOT = "https://m.stock.naver.com/api/stock"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) stocks-research/1.0",
    "Accept": "application/json",
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


def _json(path: str) -> object:
    request = Request(f"{API_ROOT}/{path}", headers=HEADERS)
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def _number(value: object) -> float:
    text = str(value or "0").replace(",", "").strip()
    return float(text or "0")


def _hash(payload: object) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _effective_at(trading_day: date) -> datetime:
    return datetime.combine(trading_day, time(6, 30), tzinfo=timezone.utc)


SECURITY_SQL = """
INSERT INTO jpkr_security_master (
  market_scope, provider_market_label, exchange, ticker, ticker_name_local,
  ticker_name_en, currency, is_active, source_kind, source_document_id,
  source_version, available_at_utc, fact_hash, source_payload
) VALUES (
  'kr', 'NAVER_KR', %(exchange)s, %(ticker)s, %(name_local)s,
  %(name_en)s, 'KRW', TRUE, %(source_kind)s, %(source_document_id)s,
  %(source_version)s, %(available_at)s, %(fact_hash)s, %(payload)s::jsonb
)
ON CONFLICT (source_kind, source_document_id, source_version, ticker)
DO NOTHING
"""

KLINE_SQL = """
INSERT INTO jpkr_daily_kline (
  market_scope, provider_market_label, exchange, ticker, ticker_name_local,
  ticker_name_en, trading_day, open, high, low, close, adjusted_close,
  corporate_action_version, volume, currency, is_halted, source_kind,
  source_document_id, source_version, fact_hash, effective_at_utc,
  available_at_utc
) VALUES (
  'kr', 'NAVER_KR', %(exchange)s, %(ticker)s, %(name_local)s,
  %(name_en)s, %(trading_day)s, %(open)s, %(high)s, %(low)s, %(close)s,
  %(close)s, 'raw-v1', %(volume)s, 'KRW', FALSE, %(source_kind)s,
  %(source_document_id)s, %(source_version)s, %(fact_hash)s,
  %(effective_at)s, %(available_at)s
)
ON CONFLICT (exchange, ticker, trading_day, source_kind, source_version)
DO NOTHING
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--days", type=int, default=10)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.days < 2 or args.days > 30:
        raise SystemExit("--days must be between 2 and 30")

    available_at = datetime.now(timezone.utc).replace(microsecond=0)
    securities: list[dict] = []
    klines: list[dict] = []
    for ticker, metadata in UNIVERSE.items():
        name_en = metadata["name_en"]
        sector = metadata["sector"]
        basic = _json(f"{ticker}/basic")
        prices = _json(f"{ticker}/price?pageSize={args.days}&page=1")
        if not isinstance(basic, dict) or not isinstance(prices, list):
            raise RuntimeError(f"invalid Naver response for {ticker}")
        exchange = "krx" if str(basic.get("sosok")) == "0" else "kosdaq"
        name_local = str(basic.get("stockName") or ticker)
        security_payload = {
            "ticker": ticker,
            "name_local": name_local,
            "name_en": name_en,
            "exchange": exchange,
            "sector": sector,
            "source_url": f"{API_ROOT}/{ticker}/basic",
        }
        securities.append(
            {
                "exchange": exchange,
                "ticker": ticker,
                "name_local": name_local,
                "name_en": name_en,
                "source_kind": SOURCE_KIND,
                "source_document_id": f"naver-security:{ticker}",
                "source_version": SOURCE_VERSION,
                "available_at": available_at,
                "fact_hash": _hash(security_payload),
                "payload": json.dumps(security_payload, ensure_ascii=False),
            }
        )
        for price in prices:
            if not isinstance(price, dict):
                continue
            trading_day = date.fromisoformat(str(price["localTradedAt"]))
            payload = {
                "ticker": ticker,
                "trading_day": trading_day.isoformat(),
                "open": _number(price.get("openPrice")),
                "high": _number(price.get("highPrice")),
                "low": _number(price.get("lowPrice")),
                "close": _number(price.get("closePrice")),
                "volume": int(_number(price.get("accumulatedTradingVolume"))),
                "source_url": f"{API_ROOT}/{ticker}/price",
            }
            if payload["high"] < max(payload["open"], payload["close"]):
                raise RuntimeError(f"invalid high price for {ticker}/{trading_day}")
            if payload["low"] > min(payload["open"], payload["close"]):
                raise RuntimeError(f"invalid low price for {ticker}/{trading_day}")
            klines.append(
                {
                    **payload,
                    "exchange": exchange,
                    "name_local": name_local,
                    "name_en": name_en,
                    "source_kind": SOURCE_KIND,
                    "source_document_id": f"naver-price:{ticker}:{trading_day}",
                    "source_version": SOURCE_VERSION,
                    "fact_hash": _hash(payload),
                    "effective_at": _effective_at(trading_day),
                    "available_at": max(available_at, _effective_at(trading_day)),
                }
            )

    if not args.dry_run:
        import psycopg

        with psycopg.connect(_database_url(_load_env(args.env_file))) as connection:
            with connection.cursor() as cursor:
                cursor.executemany(SECURITY_SQL, securities)
                security_inserted = cursor.rowcount
                cursor.executemany(KLINE_SQL, klines)
                kline_inserted = cursor.rowcount
    else:
        security_inserted = 0
        kline_inserted = 0

    print(
        json.dumps(
            {
                "dry_run": args.dry_run,
                "security_count": len(securities),
                "kline_count": len(klines),
                "security_inserted": security_inserted,
                "kline_inserted": kline_inserted,
                "latest_trading_day": max(row["trading_day"] for row in klines),
                "tickers": sorted(UNIVERSE),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
