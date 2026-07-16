#!/usr/bin/env python3
"""Persist owner-approved live JPX/KIND/BOJ capture wrappers."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    parse_boj_capture_fixture,
    parse_jpx_kline_fixture,
    parse_jpx_security_fixture,
    parse_kind_disclosure_fixture,
)
from datapipeline.storage.jpkr import FxObservationWriter, JpKrOfficialWriter


def _load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            values[key] = value.strip().strip('"').strip("'")
    return values


def _load_json(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain one capture wrapper")
    return payload


async def _run(args: argparse.Namespace) -> dict:
    import asyncpg

    values = _load_env(args.env_file)
    required = ("DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD")
    if any(not values.get(key) for key in required):
        raise RuntimeError("database environment is incomplete")

    as_of = datetime.now(timezone.utc).replace(microsecond=0)
    securities = parse_jpx_security_fixture(_load_json(args.jpx))
    klines = tuple(
        record
        for path in args.jpx_kline
        for record in parse_jpx_kline_fixture(_load_json(path))
    )
    disclosures = parse_kind_disclosure_fixture(_load_json(args.kind))
    observations = parse_boj_capture_fixture(_load_json(args.boj), as_of_utc=as_of)

    pool = await asyncpg.create_pool(
        host=values["DB_HOST"],
        port=int(values["DB_PORT"]),
        database=values["DB_NAME"],
        user=values["DB_USER"],
        password=values["DB_PASSWORD"],
        min_size=1,
        max_size=2,
        command_timeout=30,
    )
    try:
        official = JpKrOfficialWriter(pool)
        security_result = await official.write_security(securities)
        kline_result = await official.write_klines(klines)
        disclosure_result = await official.write_disclosures(disclosures)
        fx_result = await FxObservationWriter(pool).write_batch(
            observations,
            as_of_utc=as_of,
        )
    finally:
        await pool.close()

    return {
        "as_of": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "security": security_result.__dict__,
        "kline": kline_result.__dict__,
        "disclosure": disclosure_result.__dict__,
        "fx": fx_result.__dict__,
        "source_wrappers": {
            "jpx": _load_json(args.jpx)["wrapper_sha256"],
            "kind": _load_json(args.kind)["wrapper_sha256"],
            "boj": _load_json(args.boj)["wrapper_sha256"],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--jpx", type=Path, required=True)
    parser.add_argument("--jpx-kline", type=Path, action="append", default=[])
    parser.add_argument("--kind", type=Path, required=True)
    parser.add_argument("--boj", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(_run(args)), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
