#!/usr/bin/env python3
"""Capture selected equities from JPX's official daily quotation PDFs."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urljoin
from urllib.request import Request, urlopen
import uuid


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from datapipeline.contracts import build_capture_wrapper


PAGE_URL = "https://www.jpx.co.jp/english/markets/statistics-equities/daily/index.html"
TERMS_URL = "https://www.jpx.co.jp/english/term-of-use/index.html"
TICKERS = frozenset({"6501", "6758", "6861", "7203", "8035", "8306", "9432", "9984"})
HEADERS = {"User-Agent": "stocks-r1-self-use-test/1.0", "Accept": "*/*"}


def _read(url: str) -> bytes:
    with urlopen(Request(url, headers=HEADERS), timeout=45) as response:
        if response.status != 200:
            raise RuntimeError("JPX source returned a non-success status")
        return response.read()


def _decimal(text: str) -> Decimal:
    return Decimal(text.replace(",", ""))


def _parse_pdf(raw: bytes, trading_day: str) -> tuple[list[dict], int]:
    with tempfile.TemporaryDirectory() as directory:
        pdf = Path(directory) / "source.pdf"
        text = Path(directory) / "source.txt"
        pdf.write_bytes(raw)
        if shutil.which("pdftotext"):
            subprocess.run(
                ["pdftotext", "-layout", str(pdf), str(text)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            lines = text.read_text(encoding="utf-8").splitlines()
        else:
            try:
                from pypdf import PdfReader
            except ImportError as error:
                raise RuntimeError(
                    "JPX PDF parsing requires pdftotext or pypdf; "
                    "install scripts/ops/requirements-global-markets.txt"
                ) from error
            lines = [
                line
                for page in PdfReader(pdf).pages
                for line in (page.extract_text(extraction_mode="layout") or "").splitlines()
            ]

    output: list[dict] = []
    live_rows = 0
    for line in lines:
        parts = re.split(r"\s{2,}", line.strip())
        if len(parts) not in (15, 16) or not re.fullmatch(r"\d{4}", parts[0]):
            continue
        try:
            if len(parts) == 16:
                unit_and_name = parts[1:3]
                market_fields = parts[3:]
            else:
                unit_and_name = parts[1].split(maxsplit=1)
                market_fields = parts[2:]
            if len(unit_and_name) != 2 or not unit_and_name[0].isdigit():
                continue
            morning = list(map(_decimal, market_fields[0:4]))
            afternoon = list(map(_decimal, market_fields[4:8]))
            volume_thousand = _decimal(market_fields[11])
            turnover_thousand = _decimal(market_fields[12])
        except Exception:
            continue
        live_rows += 1
        ticker = parts[0]
        if ticker not in TICKERS:
            continue
        output.append(
            {
                "ticker": ticker,
                "ticker_name_local": unit_and_name[1],
                "ticker_name_en": "",
                "trading_day": trading_day,
                "open": format(morning[0], "f"),
                "high": format(max(morning[1], afternoon[1]), "f"),
                "low": format(min(morning[2], afternoon[2]), "f"),
                "close": format(afternoon[3], "f"),
                "volume": format(volume_thousand * 1000, "f"),
                "turnover": format(turnover_thousand * 1000, "f"),
            }
        )
    if len(output) != len(TICKERS) or live_rows < 1000:
        raise RuntimeError("JPX quotation PDF schema changed")
    return sorted(output, key=lambda row: row["ticker"]), live_rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--days", type=int, default=2)
    parser.add_argument("--confirm-self-use", action="store_true")
    args = parser.parse_args()
    if not args.confirm_self_use:
        raise SystemExit("--confirm-self-use is required")
    if args.days < 2 or args.days > 5:
        raise SystemExit("--days must be between 2 and 5")

    page = _read(PAGE_URL).decode("utf-8")
    links = []
    for match in re.finditer(r'href="([^"]+/stq_(\d{8})[.]pdf)"', page):
        link, day_text = match.groups()
        item = (day_text, urljoin(PAGE_URL, link))
        if item not in links:
            links.append(item)
    links = sorted(links, reverse=True)[: args.days]
    if len(links) != args.days:
        raise RuntimeError("JPX daily page did not expose enough quotation PDFs")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    for day_text, url in links:
        raw = _read(url)
        trading_day = datetime.strptime(day_text, "%Y%m%d").date().isoformat()
        rows, live_rows = _parse_pdf(raw, trading_day)
        captured_at = datetime.now(timezone.utc).replace(microsecond=0)
        wrapper = build_capture_wrapper(
            source_kind="jpx-daily-statistics-pdf",
            source_url=url,
            terms_url=TERMS_URL,
            capture_instance=str(uuid.uuid4()),
            captured_at_utc=captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            captured_response_sha256=hashlib.sha256(raw).hexdigest(),
            declared_live_row_count=live_rows,
            payload={
                "source_document_id": f"jpx-stock-quotations:{trading_day}",
                "rows": rows,
            },
        )
        destination = args.output_dir / f"jpx-kline-{trading_day}.json"
        destination.write_text(
            json.dumps(wrapper, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(
            json.dumps(
                {
                    "trading_day": trading_day,
                    "row_count": len(rows),
                    "declared_live_row_count": live_rows,
                    "wrapper_sha256": wrapper["wrapper_sha256"],
                    "output": str(destination),
                },
                sort_keys=True,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
