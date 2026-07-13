"""Manual opt-in, read-only capture of owner-approved REAL-DATA R1 sources."""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import io
import json
from pathlib import Path
import re
import sys
import uuid
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen

from datapipeline.contracts import build_capture_wrapper

JPX_SECURITY_URL = (
    "https://www.jpx.co.jp/markets/statistics-equities/misc/"
    "tvdivq0000001vg2-att/data_j.xls"
)
BOJ_FX_URL = "https://www.stat-search.boj.or.jp/ssi/mtshtml/csv/fm08_d_1_en.csv"
KIND_URL = "https://kind.krx.co.kr/disclosure/todaydisclosure.do"
JPX_TERMS_URL = "https://www.jpx.co.jp/english/term-of-use/index.html"
KIND_TERMS_URL = "https://kind.krx.co.kr/"
BOJ_TERMS_URL = "https://www.boj.or.jp/en/copyright.htm"


class LiveCaptureError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class BoundedArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise LiveCaptureError("INVALID_ARGUMENTS")


def _read(url: str, *, data: bytes | None = None) -> tuple[bytes, int, str]:
    request = Request(
        url,
        data=data,
        headers={"User-Agent": "stocks-r1-self-use-test/1.0", "Accept": "*/*"},
        method="POST" if data is not None else "GET",
    )
    try:
        with urlopen(request, timeout=30) as response:
            return response.read(), response.status, response.headers.get_content_type()
    except Exception:
        raise LiveCaptureError("SOURCE_READ_FAILED") from None


def _captured_at() -> str:
    return (
        datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _wrap(
    *,
    source_kind: str,
    source_url: str,
    terms_url: str,
    raw: bytes,
    status: int,
    live_row_count: int,
    payload: dict,
) -> dict:
    if status != 200 or not raw or live_row_count <= 0:
        raise LiveCaptureError("SOURCE_READ_FAILED")
    import hashlib

    return build_capture_wrapper(
        source_kind=source_kind,
        source_url=source_url,
        terms_url=terms_url,
        capture_instance=str(uuid.uuid4()),
        captured_at_utc=_captured_at(),
        captured_response_sha256=hashlib.sha256(raw).hexdigest(),
        declared_live_row_count=live_row_count,
        payload=payload,
    )


def capture_boj(start: date, end: date) -> dict:
    raw, status, _ = _read(BOJ_FX_URL)
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise LiveCaptureError("SOURCE_SCHEMA_INVALID") from None
    all_rows = []
    for line in text.splitlines():
        match = re.fullmatch(r"(\d{4}/\d{2}/\d{2}),([0-9.]+),([0-9.]+)", line)
        if match:
            all_rows.append(
                {
                    "observation_day": match.group(1).replace("/", "-"),
                    "local_per_usd": match.group(2),
                }
            )
    selected = [
        row
        for row in all_rows
        if start <= date.fromisoformat(row["observation_day"]) <= end
    ]
    if not selected:
        raise LiveCaptureError("SOURCE_SCHEMA_INVALID")
    return _wrap(
        source_kind="BOJ",
        source_url=BOJ_FX_URL,
        terms_url=BOJ_TERMS_URL,
        raw=raw,
        status=status,
        live_row_count=len(all_rows),
        payload={"rows": selected},
    )


def capture_jpx_security() -> dict:
    raw, status, _ = _read(JPX_SECURITY_URL)
    try:
        import pandas

        frame = pandas.read_excel(io.BytesIO(raw), dtype=str).fillna("")
    except Exception:
        raise LiveCaptureError("SOURCE_SCHEMA_INVALID") from None
    expected = {
        "日付",
        "コード",
        "銘柄名",
        "市場・商品区分",
        "33業種コード",
        "33業種区分",
        "規模コード",
        "規模区分",
    }
    if not expected.issubset(frame.columns):
        raise LiveCaptureError("SOURCE_SCHEMA_INVALID")
    domestic = frame[frame["市場・商品区分"].str.contains("内国株式", na=False)].head(3)
    rows = [
        {
            "effective_day": row["日付"],
            "local_code": row["コード"],
            "name_local": row["銘柄名"],
            "section": row["市場・商品区分"],
            "sector_33_code": row["33業種コード"],
            "sector_33_name": row["33業種区分"],
            "size_code": row["規模コード"],
            "size_name": row["規模区分"],
        }
        for _, row in domestic.iterrows()
    ]
    return _wrap(
        source_kind="jpx-listed-company-monthly",
        source_url=JPX_SECURITY_URL,
        terms_url=JPX_TERMS_URL,
        raw=raw,
        status=status,
        live_row_count=len(frame),
        payload={"rows": rows},
    )


def capture_kind(day: date) -> dict:
    opener = build_opener(HTTPCookieProcessor())
    try:
        main = Request(
            KIND_URL + "?method=searchTodayDisclosureMain",
            headers={"User-Agent": "stocks-r1-self-use-test/1.0"},
        )
        with opener.open(main, timeout=30) as response:
            if response.status != 200:
                raise LiveCaptureError("SOURCE_READ_FAILED")
            response.read()
        body = urlencode(
            {
                "method": "searchTodayDisclosureSub",
                "currentPageSize": "100",
                "pageIndex": "1",
                "orderMode": "0",
                "orderStat": "D",
                "marketType": "",
                "forward": "todaydisclosure_sub",
                "todayFlag": "N",
                "selDate": day.isoformat(),
                "searchCorpName": "",
            }
        ).encode("ascii")
        request = Request(
            KIND_URL,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "stocks-r1-self-use-test/1.0",
            },
            method="POST",
        )
        with opener.open(request, timeout=30) as response:
            raw, status = response.read(), response.status
    except LiveCaptureError:
        raise
    except Exception:
        raise LiveCaptureError("SOURCE_READ_FAILED") from None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise LiveCaptureError("SOURCE_SCHEMA_INVALID") from None
    pattern = re.compile(
        r'<tr id="parkman".*?<td class="first txc">(?P<time>\d\d:\d\d)</td>.*?'
        r"<img [^>]*alt='(?P<market>[^']+)'.*?companysummary_open\('(?P<code>\d{5})'\).*?"
        r"title='(?P<company>[^']+)'.*?openDisclsViewer\('(?P<receipt>\d{14})',''\).*?"
        r"title='(?P<headline>[^']+)'.*?<td>(?P<submitter>[^<]+)</td>",
        re.DOTALL,
    )
    all_rows = [match.groupdict() for match in pattern.finditer(text)]
    if not all_rows:
        raise LiveCaptureError("SOURCE_SCHEMA_INVALID")
    rows = [
        {
            "time_local": row["time"],
            "market": row["market"],
            "short_code": row["code"],
            "company_name_local": row["company"],
            "receipt_no": row["receipt"],
            "headline_local": row["headline"],
            "submitter": row["submitter"].strip(),
        }
        for row in all_rows[:3]
    ]
    return _wrap(
        source_kind="kind",
        source_url=KIND_URL,
        terms_url=KIND_TERMS_URL,
        raw=raw,
        status=status,
        live_row_count=len(all_rows),
        payload={"source_document_day": day.isoformat(), "rows": rows},
    )


def write_fixture(payload: dict, output: Path) -> None:
    if output.exists():
        raise LiveCaptureError("OUTPUT_EXISTS")
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write("\n")
    except OSError:
        raise LiveCaptureError("OUTPUT_WRITE_FAILED") from None


def main(argv: list[str] | None = None) -> int:
    parser = BoundedArgumentParser(add_help=False)
    parser.add_argument("--confirm-self-use", action="store_true")
    parser.add_argument(
        "--source", choices=("boj", "jpx-security", "kind"), required=True
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--start")
    parser.add_argument("--end")
    args = parser.parse_args(argv)
    if not args.confirm_self_use:
        raise LiveCaptureError("SELF_USE_CONFIRMATION_REQUIRED")
    try:
        start = date.fromisoformat(args.start) if args.start else None
        end = date.fromisoformat(args.end) if args.end else None
    except ValueError:
        raise LiveCaptureError("INVALID_DATE_WINDOW") from None
    if args.source == "boj":
        if start is None or end is None or start > end:
            raise LiveCaptureError("INVALID_DATE_WINDOW")
        payload = capture_boj(start, end)
    elif args.source == "jpx-security":
        payload = capture_jpx_security()
    else:
        if start is None or end is None or start != end:
            raise LiveCaptureError("INVALID_DATE_WINDOW")
        payload = capture_kind(start)
    write_fixture(payload, args.output)
    print(
        json.dumps(
            {
                "capture_instance": payload["capture_instance"],
                "captured_response_sha256": payload["captured_response_sha256"],
                "declared_live_row_count": payload["declared_live_row_count"],
                "output": str(args.output),
                "source_kind": payload["source_kind"],
                "wrapper_sha256": payload["wrapper_sha256"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LiveCaptureError as error:
        print(json.dumps({"error": error.code}), file=sys.stderr)
        raise SystemExit(2)
    except Exception:
        print(json.dumps({"error": "INTERNAL_CAPTURE_ERROR"}), file=sys.stderr)
        raise SystemExit(2)
