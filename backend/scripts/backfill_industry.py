#!/usr/bin/env python3
"""
Backfill stocks.industry from cninfo (巨潮行业分类标准) per-stock.

When the AKShare push2.eastmoney endpoints are unreachable (502),
sync-stocks via Sina Finance gets us symbol+name but no industry.
This script uses cninfo's stock_industry_change_cninfo (which goes through
plotinfo.szse.com.cn, not push2.eastmoney) to fill industry per-stock.

Usage:
  DB_PASSWORD=... python3 scripts/data-sync/backfill_industry.py [--limit N]

Each cninfo call is ~250ms; 5500 stocks with 8 workers takes ~10 min.
"""
import warnings
warnings.filterwarnings('ignore')

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import akshare as ak
import psycopg2


def fetch_industry(code: str):
    """Return (code, industry_name); industry=None on any failure."""
    try:
        df = ak.stock_industry_change_cninfo(symbol=code)
        if df is None or df.empty:
            return (code, None)
        # 优先取巨潮行业分类标准
        primary = df[df['分类标准'] == '巨潮行业分类标准']
        if not primary.empty:
            ind = primary.iloc[0].get('行业大类') or primary.iloc[0].get('行业中类')
            return (code, ind)
        return (code, df.iloc[0].get('行业大类'))
    except Exception:
        return (code, None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None,
                        help='Only process first N stocks (for testing)')
    parser.add_argument('--workers', type=int, default=8,
                        help='Concurrent worker threads (default 8)')
    parser.add_argument('--force', action='store_true',
                        help='Overwrite even stocks that already have industry')
    args = parser.parse_args()

    db_pwd = os.environ.get('DB_PASSWORD', '')
    db_host = os.environ.get('DB_HOST', '127.0.0.1')
    db_port = int(os.environ.get('DB_PORT', 5432))
    db_name = os.environ.get('DB_NAME', 'stock_backtest')
    db_user = os.environ.get('DB_USER', 'postgres')

    conn = psycopg2.connect(host=db_host, port=db_port, dbname=db_name,
                            user=db_user, password=db_pwd)
    cur = conn.cursor()

    where = "is_listed = true"
    if not args.force:
        where += " AND (industry IS NULL OR industry = '')"
    cur.execute(f"SELECT symbol FROM stocks WHERE {where} ORDER BY symbol")
    symbols = [r[0] for r in cur.fetchall()]
    if args.limit:
        symbols = symbols[:args.limit]
    print(f"Step 1: fetched {len(symbols)} symbols from DB", flush=True)

    # Extract 6-digit code from sh.600519 / sz.000001 / 600519.SH formats
    def to_code(sym):
        if '.' not in sym:
            return sym
        parts = sym.split('.')
        return parts[1] if len(parts[0]) == 2 else parts[0]

    codes = [to_code(s) for s in symbols]
    print(f"Step 2: fetching cninfo industry ({args.workers} threads)...", flush=True)

    start = time.time()
    results = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_industry, c): c for c in codes}
        done = 0
        for fut in as_completed(futures):
            code, ind = fut.result()
            results[code] = ind
            done += 1
            if done % 200 == 0:
                elapsed = time.time() - start
                rate = done / elapsed
                eta = (len(codes) - done) / rate if rate else 0
                mapped = sum(1 for v in results.values() if v)
                print(f"  [{done}/{len(codes)}] {rate:.1f}/s eta={int(eta)}s mapped={mapped}",
                      flush=True)

    mapped = {k: v for k, v in results.items() if v}
    print(f"\nStep 3: writing back ({len(mapped)}/{len(codes)} stocks have industry)...",
          flush=True)

    updated = 0
    for sym in symbols:
        code = to_code(sym)
        ind = mapped.get(code)
        if not ind:
            continue
        cur.execute(
            "UPDATE stocks SET industry = %s, updated_at = NOW() WHERE symbol = %s",
            (ind, sym)
        )
        updated += cur.rowcount

    conn.commit()
    cur.close()
    conn.close()
    print(f"  ✓ Updated {updated} stocks", flush=True)
    print(f"\nTotal time: {time.time() - start:.0f}s", flush=True)


if __name__ == '__main__':
    main()
