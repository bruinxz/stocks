#!/usr/bin/env python3
"""Persist replayable typed score captures from production recommendations."""

from __future__ import annotations

import argparse
from datetime import timezone
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ai.replay.postgres_capture_writer import PostgresTypedCaptureWriter
from ai.replay.runtime import TypedScoreRecord, typed_score_fact_hash
from ai.replay.typed_capture import TypedCaptureRequest


def _load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            values[key] = value.strip().strip('"').strip("'")
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


def _read_snapshots(database_url: str) -> list[dict]:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT DISTINCT ON (profile, market_scope)
                  snapshot_id, as_of_utc, trading_day, profile, market_scope,
                  contract_version, profile_version, pipeline_version,
                  strategy_version, envelope_json
                FROM ai_recommendation_snapshot
                ORDER BY profile, market_scope, as_of_utc DESC, snapshot_id DESC
                """
            )
            return list(cursor.fetchall())


def _size_hint(total: float) -> tuple[str, float]:
    if total >= 85:
        return "TIER_5", 5.0
    if total >= 70:
        return "TIER_3", 3.0
    if total >= 55:
        return "TIER_2", 2.0
    if total >= 40:
        return "TIER_1", 1.0
    return "SKIP", 0.0


def _features(recommendation: dict, profile: str, market_scope: str) -> dict:
    score = recommendation["score"]
    total = float(score["total"])
    tier, percentage = _size_hint(total)
    entry_plan = recommendation["entry_plan"]
    low = float(entry_plan["entry"]["low"])
    stop = float(entry_plan["stop"]["value"])
    conviction = recommendation["conviction"]
    final = float(conviction["final"])
    return {
        "score": {
            "profile": profile,
            "market_scope": market_scope,
            "rating": score["rating"],
            "total": total,
            "dims": [
                {
                    "key": dimension["key"],
                    "score": float(dimension["score"]),
                    "band": dimension["band"],
                    "weight": float(dimension["weight"]),
                }
                for dimension in score["dims"]
            ],
        },
        "conviction": {
            "base": float(conviction["base"]),
            "adjustments": list(conviction["adjustments"]),
            "final": final,
            "level": "HIGH" if final >= 75 else "MED" if final >= 50 else "LOW",
        },
        "risk_gate": {
            "gate": recommendation["risk_gate"]["gate"],
            "ok_to_enter": recommendation["risk_gate"]["ok_to_enter"],
            "triggers": list(recommendation["risk_gate"]["triggers"]),
        },
        "entry_plan": {
            "entry": dict(entry_plan["entry"]),
            "stop": dict(entry_plan["stop"]),
            "targets": list(entry_plan["targets"]),
            "size_hint": {
                **dict(entry_plan["size_hint"]),
                "tier": tier,
                "pct": percentage,
            },
            "time_horizon": entry_plan["time_horizon"],
            "invalidation": entry_plan["invalidation"],
            "stop_distance_pct": round(abs(low - stop) / low * 100.0, 6),
        },
    }


def _request(row: dict) -> TypedCaptureRequest:
    envelope = row["envelope_json"]
    as_of = row["as_of_utc"].astimezone(timezone.utc).replace(microsecond=0)
    as_of_text = as_of.strftime("%Y-%m-%dT%H:%M:%SZ")
    source_version = f"recommendation-snapshot-{row['snapshot_id']}"
    scores = []
    for item in envelope["items"]:
        recommendation = item["recommendation"]
        features = _features(
            recommendation,
            row["profile"],
            row["market_scope"],
        )
        values = {
            "ticker": recommendation["ticker"],
            "profile": row["profile"],
            "market_scope": row["market_scope"],
            "as_of": as_of_text,
            "available_at_utc": as_of,
            "source_version": source_version,
            "features": features,
        }
        scores.append(
            TypedScoreRecord(
                **values,
                fact_hash=typed_score_fact_hash(**values),
            )
        )
    return TypedCaptureRequest(
        trading_day=row["trading_day"].isoformat(),
        as_of=as_of_text,
        profile=row["profile"],
        market_scope=row["market_scope"],
        profile_version=row["profile_version"],
        contract_version=row["contract_version"],
        strategy_version=row["strategy_version"],
        pipeline_version=row["pipeline_version"],
        source_versions={
            "signals": "recommendation-evidence@1.0.0",
            "universe": "recommendation-universe@1.0.0",
            "scores": source_version,
            "evidence": "recommendation-evidence@1.0.0",
        },
        filings=(),
        text_hits=(),
        scores=tuple(scores),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args()
    database_url = _database_url(_load_env(args.env_file))
    writer = PostgresTypedCaptureWriter(database_url)
    receipts = [writer.write(_request(row)) for row in _read_snapshots(database_url)]
    print(
        json.dumps(
            {
                "capture_count": len(receipts),
                "created": sum(receipt.created for receipt in receipts),
                "captures": [
                    {
                        "capture_id": receipt.capture_id,
                        "profile": receipt.pins.profile,
                        "market_scope": receipt.pins.market_scope,
                        "trading_day": receipt.pins.trading_day,
                        "input_fingerprint": receipt.pins.input_fingerprint,
                        "capture_hash": receipt.capture_hash,
                    }
                    for receipt in receipts
                ],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
