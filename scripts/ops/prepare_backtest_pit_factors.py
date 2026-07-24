#!/usr/bin/env python3
"""Incrementally materialize the six audited factor slices needed by CN-A PIT replay."""

from __future__ import annotations

import argparse
from datetime import date, timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"
CHECKPOINT_COUNT = 27
WINDOW_DAYS = 183
FACTOR_NAMES = (
    "quality",
    "growth",
    "value",
    "momentum",
    "gradual_breakout",
    "low_vol",
)
FACTOR_CSV = ",".join(FACTOR_NAMES)


def _load_env(path: Path) -> dict[str, str]:
    values = dict(os.environ)
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key, value = stripped.split("=", 1)
                values.setdefault(key, value.strip().strip('"').strip("'"))
    values.setdefault("DB_HOST", "localhost")
    values.setdefault("DB_PORT", "5432")
    values.setdefault("DB_NAME", "stock_backtest")
    values.setdefault("DB_USER", "postgres")
    values.setdefault("DB_PASSWORD", "postgres")
    required = ("DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD")
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise RuntimeError("database environment is incomplete")
    return values


def _database_url(values: dict[str, str]) -> str:
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


def _checkpoints(sessions: list[date]) -> list[date]:
    eligible = sessions[1:]
    if len(eligible) < CHECKPOINT_COUNT:
        raise RuntimeError("production calendar has fewer than 28 valid sessions")
    indexes = [
        round(index * (len(eligible) - 1) / (CHECKPOINT_COUNT - 1))
        for index in range(CHECKPOINT_COUNT)
    ]
    checkpoints = [eligible[index] for index in indexes]
    if len(set(checkpoints)) != CHECKPOINT_COUNT:
        raise RuntimeError("checkpoint sampling produced duplicate sessions")
    return checkpoints


def _load_signal_days(database_url: str) -> tuple[date, tuple[date, ...]]:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                WITH listed AS (
                  SELECT COUNT(*)::numeric AS total
                    FROM stocks
                   WHERE is_listed = TRUE AND type = 'stock'
                ), coverage AS (
                  SELECT bar.time::date AS trading_day,
                         COUNT(DISTINCT bar.stock_id)::numeric AS covered
                    FROM daily_bars bar
                    JOIN stocks stock ON stock.id = bar.stock_id
                   WHERE bar.is_trading_day = TRUE
                     AND stock.is_listed = TRUE
                     AND stock.type = 'stock'
                   GROUP BY bar.time::date
                )
                SELECT MAX(coverage.trading_day) AS trading_day
                  FROM coverage CROSS JOIN listed
                 WHERE coverage.covered >= CEIL(listed.total * 0.80)
                """
            )
            row = cursor.fetchone()
            window_end = row["trading_day"] if row else None
            if window_end is None:
                raise RuntimeError("daily_bars does not contain a broad-market trading day")
            cursor.execute(
                """
                SELECT time::date AS trading_day
                  FROM daily_bars
                 WHERE time::date BETWEEN %s AND %s
                   AND is_trading_day = TRUE
                 GROUP BY time::date
                HAVING COUNT(*) >= 100
                 ORDER BY trading_day
                """,
                (window_end - timedelta(days=WINDOW_DAYS), window_end),
            )
            sessions = [item["trading_day"] for item in cursor.fetchall()]
    checkpoints = _checkpoints(sessions)
    previous = {session: sessions[index - 1] for index, session in enumerate(sessions) if index}
    return window_end, tuple(dict.fromkeys(previous[checkpoint] for checkpoint in checkpoints))


def _coverage(database_url: str, trading_day: date) -> dict[str, object]:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT factor_name,
                       COUNT(*)::int AS rows,
                       COUNT(*) FILTER (WHERE raw_value IS NOT NULL)::int AS effective
                  FROM factor_scores
                 WHERE trade_date = %s
                   AND factor_name = ANY(%s)
                   AND (
                     available_at_utc <= (%s::date::text || 'T15:00:00Z')::timestamptz
                     OR (
                       source = 'historical_pit_replay@1.0.0'
                       AND pit_replay_as_of_utc IS NOT NULL
                       AND pit_replay_as_of_utc
                           <= (%s::date::text || 'T15:00:00Z')::timestamptz
                     )
                   )
                 GROUP BY factor_name
                """,
                (trading_day, list(FACTOR_NAMES), trading_day, trading_day),
            )
            rows = {item["factor_name"]: item for item in cursor.fetchall()}
            universe_size = max((int(item["rows"]) for item in rows.values()), default=0)
            minimum = max(500, (universe_size + 4) // 5)
            incomplete = [
                factor
                for factor in FACTOR_NAMES
                if factor not in rows or int(rows[factor]["effective"]) < minimum
            ]
            return {
                "ready": not incomplete and universe_size >= 500,
                "universe_size": universe_size,
                "minimum_effective": minimum,
                "effective": {
                    factor: int(rows[factor]["effective"]) if factor in rows else 0
                    for factor in FACTOR_NAMES
                },
                "incomplete_factors": incomplete,
            }


def _compute_command(trading_day: date) -> list[str]:
    source_runner = BACKEND_ROOT / "node_modules/.bin/ts-node"
    compiled = BACKEND_ROOT / "dist/scripts/compute-factors.js"
    args = [
        f"--date={trading_day.isoformat()}",
        f"--factors={FACTOR_CSV}",
        "--historical-pit-replay",
    ]
    if source_runner.exists():
        return [str(source_runner), "src/scripts/compute-factors.ts", *args]
    if compiled.exists():
        return ["node", str(compiled), *args]
    raise RuntimeError("compute-factors runtime is unavailable")


def _compute(values: dict[str, str], trading_day: date) -> dict[str, object]:
    completed = subprocess.run(
        _compute_command(trading_day),
        cwd=BACKEND_ROOT,
        env=values,
        text=True,
        capture_output=True,
        timeout=240,
        check=False,
    )
    lines = (completed.stdout or "").strip().splitlines()
    payload: dict[str, object] = {}
    if lines:
        try:
            payload = json.loads(lines[-1])
        except json.JSONDecodeError:
            payload = {"message": lines[-1][-500:]}
    if completed.returncode != 0 or not payload.get("ok"):
        error_lines = (completed.stderr or completed.stdout or "").strip().splitlines()
        detail = error_lines[-1][-500:] if error_lines else "factor replay failed"
        raise RuntimeError(f"{trading_day.isoformat()}: {detail}")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    values = _load_env(args.env_file)
    database_url = _database_url(values)
    window_end, signal_days = _load_signal_days(database_url)
    before = {day: _coverage(database_url, day) for day in signal_days}
    missing = [day for day in signal_days if not before[day]["ready"]]
    computed: list[dict[str, object]] = []
    if not args.dry_run:
        for index, trading_day in enumerate(missing, start=1):
            print(
                f"[pit-factor-replay] {index}/{len(missing)} {trading_day.isoformat()}",
                file=sys.stderr,
                flush=True,
            )
            computed.append(_compute(values, trading_day))
        after = {day: _coverage(database_url, day) for day in signal_days}
        incomplete = [day.isoformat() for day in signal_days if not after[day]["ready"]]
        if incomplete:
            raise RuntimeError("PIT factor coverage incomplete after replay: " + ",".join(incomplete))
    else:
        after = before
        incomplete = [day.isoformat() for day in missing]

    print(
        json.dumps(
            {
                "scenario": "prepare_backtest_pit_factors",
                "ok": True,
                "dry_run": args.dry_run,
                "window_end": window_end.isoformat(),
                "required_signal_days": len(signal_days),
                "already_ready": len(signal_days) - len(missing),
                "computed": len(computed),
                "pending_dates": incomplete if args.dry_run else [],
                "source": "historical_pit_replay@1.0.0",
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(
            json.dumps(
                {
                    "scenario": "prepare_backtest_pit_factors",
                    "ok": False,
                    "error": str(error)[:500],
                },
                sort_keys=True,
            )
        )
        raise SystemExit(1)
