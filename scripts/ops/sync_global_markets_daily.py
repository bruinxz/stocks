#!/usr/bin/env python3
"""Daily 09:00 Asia/Shanghai refresh for A-share reports and overseas catalysts.

The job intentionally keeps overseas coverage compact: JP/KR market snapshots and
US/JP recommendation snapshots are refreshed as context for A-share research. It
does not fan out one report per overseas security.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Mapping, Sequence
from zoneinfo import ZoneInfo


repo_root_override = os.environ.get("STOCKS_REPO_ROOT")
REPO_ROOT = (
    Path(repo_root_override)
    if repo_root_override
    else Path(__file__).resolve().parents[2]
).resolve()
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    parse_boj_capture_fixture,
    parse_jpx_kline_fixture,
)
from datapipeline.collectors.jpkr_deep.fx_rate_fetcher import (
    FxSourceRow,
    normalize_fx_rows,
)
from datapipeline.contracts import FxObservation
from datapipeline.storage.jpkr import FxObservationWriter, JpKrOfficialWriter


def _load_env(path: Path) -> dict[str, str]:
    values = dict(os.environ)
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key, value = stripped.split("=", 1)
                values.setdefault(key, value.strip().strip('"').strip("'"))
    return values


def _run(name: str, args: list[str], timeout: int) -> dict:
    try:
        completed = subprocess.run(
            [sys.executable, *args],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "name": name,
            "ok": False,
            "exit_code": 124,
            "error": f"timed out after {timeout} seconds",
        }
    except OSError as error:
        return {
            "name": name,
            "ok": False,
            "exit_code": 127,
            "error": str(error)[:500],
        }
    tail = (completed.stdout or "").strip().splitlines()
    result: dict[str, object] = {
        "name": name,
        "ok": completed.returncode == 0,
        "exit_code": completed.returncode,
    }
    if tail:
        try:
            result["result"] = json.loads(tail[-1])
        except json.JSONDecodeError:
            result["message"] = tail[-1][-500:]
    if completed.returncode != 0:
        error_tail = (completed.stderr or completed.stdout or "").strip().splitlines()
        result["error"] = error_tail[-1][-500:] if error_tail else "command failed"
    return result


def _stored_fx_observation(row: Mapping[str, object]) -> FxObservation:
    return FxObservation(
        pair=str(row["pair"]),
        observation_day=row["observation_day"],
        available_at_utc=row["available_at_utc"],
        local_per_usd=Decimal(str(row["local_per_usd"])),
        usd_per_local=Decimal(str(row["usd_per_local"])),
        change_pct=(
            None if row["change_pct"] is None else Decimal(str(row["change_pct"]))
        ),
        source_kind=str(row["source_kind"]),
        source_document_id=str(row["source_document_id"]),
        source_version=str(row["source_version"]),
        fact_hash=str(row["fact_hash"]),
        previous_observation_day=row["previous_observation_day"],
        previous_source_kind=row["previous_source_kind"],
        previous_source_version=row["previous_source_version"],
        previous_fact_hash=row["previous_fact_hash"],
    )


def _rebase_pending_fx(
    captured: Sequence[FxObservation],
    stored_latest: Mapping[str, FxObservation],
    *,
    as_of_utc: datetime,
) -> tuple[FxObservation, ...]:
    """Rebuild only-new rows against the authoritative persisted predecessor."""

    pending_rows = tuple(
        FxSourceRow(
            pair=observation.pair,
            observation_day=observation.observation_day,
            available_at_utc=observation.available_at_utc,
            local_per_usd=observation.local_per_usd,
            source_kind=observation.source_kind,
            source_document_id=observation.source_document_id,
            source_version=observation.source_version,
        )
        for observation in captured
        if stored_latest.get(observation.pair) is None
        or observation.observation_day > stored_latest[observation.pair].observation_day
    )
    return normalize_fx_rows(
        pending_rows,
        as_of_utc=as_of_utc,
        previous_by_pair=stored_latest,
    )


async def _persist_official(
    env: dict[str, str], jpx_files: list[Path], boj_file: Path
) -> dict[str, object]:
    import asyncpg

    required = ("DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD")
    missing = [key for key in required if not env.get(key)]
    if missing:
        raise RuntimeError("database environment is incomplete")
    pool = await asyncpg.create_pool(
        host=env["DB_HOST"],
        port=int(env.get("DB_PORT", "5432")),
        database=env["DB_NAME"],
        user=env["DB_USER"],
        password=env["DB_PASSWORD"],
        min_size=1,
        max_size=2,
        command_timeout=60,
    )
    try:
        klines = tuple(
            record
            for path in jpx_files
            for record in parse_jpx_kline_fixture(
                json.loads(path.read_text(encoding="utf-8"))
            )
        )
        as_of = datetime.now(timezone.utc).replace(microsecond=0)
        fx = parse_boj_capture_fixture(
            json.loads(boj_file.read_text(encoding="utf-8")), as_of_utc=as_of
        )
        latest_fx_rows = await pool.fetch(
            "SELECT DISTINCT ON (pair) pair, observation_day, available_at_utc, "
            "local_per_usd, usd_per_local, change_pct, source_kind, "
            "source_document_id, source_version, fact_hash, "
            "previous_observation_day, previous_source_kind, "
            "previous_source_version, previous_fact_hash "
            "FROM jpkr_fx_observation WHERE source_kind IN ('BOJ', 'BOK') "
            "ORDER BY pair, observation_day DESC, available_at_utc DESC, "
            "source_version DESC, created_at DESC"
        )
        latest_fx = {
            str(row["pair"]): _stored_fx_observation(row) for row in latest_fx_rows
        }
        # Captures intentionally overlap recent days. FxObservationWriter verifies
        # exact predecessor version/hash. Re-normalize the new suffix so its first
        # row cites PostgreSQL's authoritative watermark instead of the overlapping
        # capture's same-day row from a newer capture version.
        pending_fx = _rebase_pending_fx(
            fx,
            latest_fx,
            as_of_utc=as_of,
        )
        kline_result = await JpKrOfficialWriter(pool).write_klines(klines)
        fx_result = await FxObservationWriter(pool).write_batch(
            pending_fx, as_of_utc=as_of
        )
        return {
            "ok": True,
            "jp_kline": kline_result.__dict__,
            "jpy_fx": fx_result.__dict__,
        }
    finally:
        await pool.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(os.environ.get("BACKEND_ENV_FILE", REPO_ROOT / "backend/.env")),
    )
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.limit < 4 or args.limit > 20:
        raise SystemExit("--limit must be between 4 and 20")

    env = _load_env(args.env_file)
    now_shanghai = datetime.now(ZoneInfo("Asia/Shanghai"))
    today = now_shanghai.date()
    results: list[dict[str, object]] = []

    with tempfile.TemporaryDirectory(prefix="stocks-global-market-") as directory:
        temp = Path(directory)
        jpx_dir = temp / "jpx"
        boj_file = temp / "boj.json"
        results.append(
            _run(
                "capture_jpx",
                [
                    "scripts/ops/capture_live_jpx_klines.py",
                    "--output-dir",
                    str(jpx_dir),
                    "--days",
                    "2",
                    "--confirm-self-use",
                ],
                600,
            )
        )
        results.append(
            _run(
                "capture_boj",
                [
                    "-m",
                    "datapipeline.collectors.jpkr_deep.live_capture",
                    "--confirm-self-use",
                    "--source",
                    "boj",
                    "--output",
                    str(boj_file),
                    "--start",
                    (today - timedelta(days=10)).isoformat(),
                    "--end",
                    today.isoformat(),
                ],
                90,
            )
        )
        capture_ok = all(item["ok"] for item in results)
        if capture_ok and not args.dry_run:
            try:
                persisted = asyncio.run(
                    _persist_official(env, sorted(jpx_dir.glob("*.json")), boj_file)
                )
                results.append({"name": "persist_jp_official", **persisted})
            except Exception as error:
                results.append(
                    {
                        "name": "persist_jp_official",
                        "ok": False,
                        "error": str(error)[:500],
                    }
                )

        kr_args = [
            "scripts/ops/populate_live_kr_market.py",
            "--env-file",
            str(args.env_file),
            "--days",
            "10",
        ]
        if args.dry_run:
            kr_args.append("--dry-run")
        results.append(_run("refresh_kr_market", kr_args, 240))

        for market_scope in ("cn_a", "us", "jp"):
            command = [
                "scripts/ops/populate_live_recommendations.py",
                "--env-file",
                str(args.env_file),
                "--market-scope",
                market_scope,
                "--limit",
                str(args.limit),
            ]
            if args.dry_run:
                command.append("--dry-run")
            results.append(_run(f"refresh_recommendation_{market_scope}", command, 600))

    failed = [item for item in results if not item.get("ok")]
    summary = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "schedule": "09:00 Asia/Shanghai",
        "dry_run": args.dry_run,
        "success": not failed,
        "failed_steps": [item["name"] for item in failed],
        "steps": results,
    }
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True, default=str))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
