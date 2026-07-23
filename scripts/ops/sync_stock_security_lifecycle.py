#!/usr/bin/env python3
"""Synchronize A-share listing/delisting dates from official exchange catalogues."""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
from typing import Iterable, Mapping
from urllib.parse import quote


SOURCE_KIND = "official-exchange-catalogue-via-akshare"
SOURCE_DOCUMENTS = (
    "SSE:stock_info_sh_name_code",
    "SSE:stock_info_sh_delist",
    "SZSE:stock_info_sz_name_code",
    "SZSE:stock_info_sz_delist",
    "BSE:stock_info_bj_name_code",
)


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


def _database_url(values: Mapping[str, str]) -> str:
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


def _day(value: object, field: str) -> date:
    if isinstance(value, datetime):
        parsed = value.date()
    elif isinstance(value, date):
        parsed = value
    else:
        try:
            parsed = date.fromisoformat(str(value).strip()[:10])
        except ValueError as error:
            raise RuntimeError(f"invalid {field}") from error
    if parsed > datetime.now(timezone.utc).date():
        raise RuntimeError(f"future {field}")
    return parsed


def _records(
    rows: Iterable[Mapping[str, object]],
    *,
    market: str,
    code_field: str,
    listing_field: str,
    delisting_field: str | None,
    is_listed: bool,
) -> dict[str, dict[str, object]]:
    output: dict[str, dict[str, object]] = {}
    for row in rows:
        code = str(row.get(code_field) or "").strip().zfill(6)
        if len(code) != 6 or not code.isdigit():
            raise RuntimeError(f"invalid official security code: {code}")
        listing_date = _day(row.get(listing_field), "listing_date")
        delisting_date = (
            _day(row.get(delisting_field), "delisting_date")
            if delisting_field and row.get(delisting_field) not in (None, "")
            else None
        )
        if delisting_date is not None and delisting_date < listing_date:
            raise RuntimeError(f"delisting precedes listing for {code}")
        symbol = f"{market}.{code}"
        output[symbol] = {
            "symbol": symbol,
            "listing_date": listing_date,
            "delisting_date": delisting_date,
            "is_listed": is_listed,
        }
    return output


def _fetch_official_lifecycle() -> dict[str, dict[str, object]]:
    import akshare as ak

    lifecycle: dict[str, dict[str, object]] = {}
    # Load historical exits first. A currently listed catalogue row wins if an
    # exchange keeps an old exit record for a subsequently relisted security.
    lifecycle.update(
        _records(
            ak.stock_info_sh_delist().to_dict("records"),
            market="sh",
            code_field="公司代码",
            listing_field="上市日期",
            delisting_field="暂停上市日期",
            is_listed=False,
        )
    )
    lifecycle.update(
        _records(
            ak.stock_info_sz_delist().to_dict("records"),
            market="sz",
            code_field="证券代码",
            listing_field="上市日期",
            delisting_field="终止上市日期",
            is_listed=False,
        )
    )
    for symbol in ("主板A股", "科创板"):
        lifecycle.update(
            _records(
                ak.stock_info_sh_name_code(symbol=symbol).to_dict("records"),
                market="sh",
                code_field="证券代码",
                listing_field="上市日期",
                delisting_field=None,
                is_listed=True,
            )
        )
    lifecycle.update(
        _records(
            ak.stock_info_sz_name_code(symbol="A股列表").to_dict("records"),
            market="sz",
            code_field="A股代码",
            listing_field="A股上市日期",
            delisting_field=None,
            is_listed=True,
        )
    )
    lifecycle.update(
        _records(
            ak.stock_info_bj_name_code().to_dict("records"),
            market="bj",
            code_field="证券代码",
            listing_field="上市日期",
            delisting_field=None,
            is_listed=True,
        )
    )
    if len(lifecycle) < 5_000:
        raise RuntimeError("official exchange lifecycle coverage is unexpectedly small")
    return lifecycle


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    import psycopg
    from psycopg.rows import dict_row

    lifecycle = _fetch_official_lifecycle()
    database_url = _database_url(_load_env(args.env_file))
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT symbol, listing_date, delisting_date, is_listed "
                "FROM stocks WHERE type = 'stock'"
            )
            stored = {str(row["symbol"]): row for row in cursor.fetchall()}
            missing = sorted(set(stored) - set(lifecycle))
            if missing:
                raise RuntimeError(
                    "official lifecycle missing stored securities: " + ",".join(missing[:20])
                )
            matched = [lifecycle[symbol] for symbol in sorted(set(stored) & set(lifecycle))]
            conflicts = []
            for fact in matched:
                row = stored[str(fact["symbol"])]
                existing_listing = row["listing_date"]
                if (
                    existing_listing is not None
                    and existing_listing != date(2000, 1, 1)
                    and existing_listing != fact["listing_date"]
                ):
                    conflicts.append(str(fact["symbol"]))
                existing_delisting = row["delisting_date"]
                if (
                    existing_delisting is not None
                    and fact["delisting_date"] is not None
                    and existing_delisting != fact["delisting_date"]
                ):
                    conflicts.append(str(fact["symbol"]))
            if conflicts:
                raise RuntimeError(
                    "stored lifecycle conflicts with official catalogue: "
                    + ",".join(sorted(set(conflicts))[:20])
                )

            if not args.dry_run:
                cursor.executemany(
                    """
                    UPDATE stocks
                       SET listing_date = %(listing_date)s,
                           delisting_date = %(delisting_date)s,
                           is_listed = %(is_listed)s,
                           updated_at = NOW()
                     WHERE symbol = %(symbol)s AND type = 'stock'
                       AND (
                         listing_date IS DISTINCT FROM %(listing_date)s
                         OR delisting_date IS DISTINCT FROM %(delisting_date)s
                         OR is_listed IS DISTINCT FROM %(is_listed)s
                       )
                    """,
                    matched,
                )
            cursor.execute(
                "SELECT COUNT(*)::int AS total, "
                "COUNT(listing_date)::int AS listing_dates "
                "FROM stocks WHERE type = 'stock'"
            )
            coverage = cursor.fetchone()

    listing_dates = len(matched) if args.dry_run else int(coverage["listing_dates"])
    total = int(coverage["total"])
    if listing_dates != total:
        raise RuntimeError(f"stock lifecycle remains incomplete: {listing_dates}/{total}")
    print(
        json.dumps(
            {
                "dry_run": args.dry_run,
                "source_kind": SOURCE_KIND,
                "source_documents": SOURCE_DOCUMENTS,
                "official_fact_count": len(lifecycle),
                "stored_stock_count": total,
                "matched_stock_count": len(matched),
                "listing_date_count": listing_dates,
                "current_count": sum(bool(row["is_listed"]) for row in matched),
                "delisted_count": sum(not bool(row["is_listed"]) for row in matched),
                "official_only_count": len(set(lifecycle) - set(stored)),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
