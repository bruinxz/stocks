#!/usr/bin/env python3
"""Materialize live A-share multibagger candidates from production facts."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import replace
from datetime import datetime, time, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ai.snapshot.fingerprint import jcs_canonicalize
from datapipeline.contracts import (
    MultibaggerSourceRecord,
    ScanDocument,
    TextHit,
    TextHitEnvelope,
)
from datapipeline.storage.multibagger import (
    MultibaggerSourceWriter,
    TextHitWriter,
    build_storage_row,
    build_text_hit_storage_row,
    canonical_multibagger_fact_hash,
    canonical_scan_document_fact_hash,
    canonical_text_context_hash,
)
from strategy.materialization.multibagger_candidate import (
    ClassificationDecision,
    LatestCatalyst,
    MaterializationInput,
    StrategyDecision,
    TextHitFact,
    UniverseFact,
    materialize_candidate,
)
from strategy.materialization.postgres_candidate_store import PostgresCandidateStore


CANDIDATE_SQL = """
WITH day AS (
  SELECT MAX(trade_date) AS trading_day FROM factor_scores
), factor_matrix AS (
  SELECT
    stock_code,
    MAX(percentile) FILTER (WHERE factor_name = 'quality') * 100 AS quality,
    MAX(percentile) FILTER (WHERE factor_name = 'growth') * 100 AS growth,
    MAX(percentile) FILTER (WHERE factor_name = 'value') * 100 AS valuation,
    AVG(percentile) FILTER (
      WHERE factor_name IN ('concept_heat', 'earnings_surprise')
    ) * 100 AS moat,
    AVG(percentile) FILTER (
      WHERE factor_name IN ('momentum', 'gradual_breakout', 'money_flow')
    ) * 100 AS trend,
    AVG(percentile) FILTER (
      WHERE factor_name IN ('low_vol', 'liquidity')
    ) * 100 AS risk,
    MAX(updated_at) AS factor_available_at
  FROM factor_scores CROSS JOIN day
  WHERE trade_date = day.trading_day
  GROUP BY stock_code
), latest_bar AS (
  SELECT DISTINCT ON (stock_id)
    stock_id, time::date AS bar_day, close, volume, turnover, updated_at
  FROM daily_bars
  WHERE is_trading_day = TRUE AND is_suspended = FALSE
  ORDER BY stock_id, time DESC
), catalyst AS (
  SELECT DISTINCT ON (stock_code)
    id, stock_code, stock_name, announce_date, original_title, summary,
    url, sentiment, created_at, updated_at
  FROM announcement_summaries
  WHERE announce_date >= CURRENT_DATE - INTERVAL '60 days'
    AND (
      original_title ILIKE ANY(ARRAY[
        '%%扩产%%', '%%产能%%', '%%中标%%', '%%合同%%', '%%收购%%', '%%订单%%'
      ])
      OR summary ILIKE ANY(ARRAY[
        '%%扩产%%', '%%产能%%', '%%中标%%', '%%合同%%', '%%收购%%', '%%订单%%'
      ])
    )
  ORDER BY stock_code, announce_date DESC, id DESC
)
SELECT
  matrix.stock_code,
  stock.name,
  LOWER(stock.market) AS exchange,
  day.trading_day,
  bar.bar_day,
  bar.close,
  bar.volume,
  bar.turnover,
  matrix.quality,
  matrix.growth,
  matrix.valuation,
  matrix.moat,
  matrix.trend,
  matrix.risk,
  matrix.factor_available_at,
  bar.updated_at AS bar_available_at,
  catalyst.id AS announcement_id,
  catalyst.announce_date,
  catalyst.original_title,
  catalyst.summary,
  catalyst.url,
  catalyst.sentiment,
  catalyst.updated_at AS announcement_available_at,
  (
    matrix.quality * 0.15 + matrix.growth * 0.20 +
    matrix.valuation * 0.10 + matrix.moat * 0.15 +
    matrix.trend * 0.25 + matrix.risk * 0.15
  ) AS total_score
FROM factor_matrix matrix
CROSS JOIN day
JOIN stocks stock
  ON RIGHT(stock.symbol, 6) = matrix.stock_code
 AND stock.type = 'stock'
JOIN latest_bar bar ON bar.stock_id = stock.id
JOIN catalyst ON catalyst.stock_code = matrix.stock_code
WHERE matrix.quality IS NOT NULL
  AND matrix.growth IS NOT NULL
  AND matrix.valuation IS NOT NULL
  AND matrix.moat IS NOT NULL
  AND matrix.trend IS NOT NULL
  AND matrix.risk IS NOT NULL
  AND stock.is_listed = TRUE
  AND stock.name NOT ILIKE '%%ST%%'
  AND bar.close > 0
  AND bar.volume > 0
  AND bar.bar_day >= day.trading_day - INTERVAL '10 days'
ORDER BY total_score DESC, catalyst.announce_date DESC, matrix.stock_code
LIMIT %s
"""

WEIGHTS = {
    "quality": 0.15,
    "growth": 0.20,
    "valuation": 0.10,
    "moat": 0.15,
    "trend": 0.25,
    "risk": 0.15,
}
KEYWORDS = (
    ("扩产", "capacity_expansion", "OPTIONALITY"),
    ("产能", "capacity", "OPTIONALITY"),
    ("中标", "contract_award", "POSITIVE"),
    ("订单", "new_orders", "POSITIVE"),
    ("收购", "acquisition", "OPTIONALITY"),
    ("合同", "material_contract", "POSITIVE"),
)


def _load_env(path: Path) -> dict[str, str]:
    values = dict(os.environ)
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            values.setdefault(key, value.strip().strip('"').strip("'"))
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


def _uuid4(*material: str) -> str:
    digest = bytearray(hashlib.sha256(jcs_canonicalize(material).encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _hash(value: object) -> str:
    return hashlib.sha256(jcs_canonicalize(value).encode()).hexdigest()


def _band(score: float) -> str:
    return "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 55 else "D" if score >= 40 else "F"


def _utc_seconds(value: datetime) -> datetime:
    normalized = value.astimezone(timezone.utc).replace(microsecond=0)
    return normalized


def _read_rows(database_url: str, limit: int) -> list[dict]:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(CANDIDATE_SQL, (limit,))
            return list(cursor.fetchall())


def _stable_as_of(database_url: str, rows: list[dict]) -> datetime:
    import psycopg

    source_version = f"live-{rows[0]['trading_day'].isoformat()}"
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT MAX(as_of_utc)
                FROM multibagger_universe
                WHERE universe_source_kind = 'factor-announcement-pipeline'
                  AND source_version = %s
                """,
                (source_version,),
            )
            existing = cursor.fetchone()[0]
    if existing is not None:
        return _utc_seconds(existing)
    return max(
        _utc_seconds(row[field])
        for row in rows
        for field in (
            "factor_available_at",
            "bar_available_at",
            "announcement_available_at",
        )
    )


def _source_record(row: dict, as_of: datetime) -> MultibaggerSourceRecord:
    available_at = min(
        as_of,
        max(
            _utc_seconds(row["factor_available_at"]),
            _utc_seconds(row["bar_available_at"]),
            _utc_seconds(row["announcement_available_at"]),
        ),
    )
    effective_at = datetime.combine(
        row["announce_date"], time.min, tzinfo=timezone.utc
    )
    features = {
        "name": row["name"],
        "factor_percentiles": {
            key: round(float(row[key]), 4) for key in WEIGHTS
        },
        "latest_bar": {
            "trading_day": row["bar_day"].isoformat(),
            "close": str(row["close"]),
            "volume": int(row["volume"]),
            "turnover": str(row["turnover"]),
        },
        "announcement": {
            "id": row["announcement_id"],
            "date": row["announce_date"].isoformat(),
            "title": row["original_title"],
            "sentiment": row["sentiment"],
            "url": row["url"],
        },
    }
    draft = MultibaggerSourceRecord(
        market="CN",
        market_scope="cn_a",
        exchange=row["exchange"],
        ticker=row["stock_code"],
        record_kind="DAILY",
        source_kind="factor-announcement-pipeline",
        source_document_id=(
            f"announcement:{row['announcement_id']}:{row['stock_code']}"
        ),
        source_version=f"live-{row['trading_day'].isoformat()}",
        effective_at_utc=effective_at,
        available_at_utc=available_at,
        as_of_utc=as_of,
        features=features,
        evidence_refs=(row["url"],),
        fact_hash="0" * 64,
    )
    return replace(draft, fact_hash=canonical_multibagger_fact_hash(draft))


def _text_envelope(row: dict) -> TextHitEnvelope:
    title = row["original_title"] or ""
    body = row["summary"] or title
    selected_field = "TITLE"
    selected_text = title
    match = None
    for keyword, term_id, hit_kind in KEYWORDS:
        offset = selected_text.find(keyword)
        if offset < 0:
            selected_field, selected_text = "BODY", body
            offset = selected_text.find(keyword)
        if offset >= 0:
            match = (keyword, term_id, hit_kind, offset)
            break
    if match is None:
        raise RuntimeError("candidate announcement lost its matched keyword")
    keyword, term_id, hit_kind, offset = match
    published = datetime.combine(row["announce_date"], time.min, tzinfo=timezone.utc)
    available = _utc_seconds(row["announcement_available_at"])
    document = ScanDocument(
        document_id=f"eastmoney-announcement:{row['announcement_id']}",
        ticker=row["stock_code"],
        market="CN",
        market_scope="cn_a",
        language="zh",
        title=title,
        body=body,
        published_at_utc=published,
        available_at_utc=available,
        source_kind="eastmoney-announcement",
        source_version=f"announcement-live-{row['announcement_id']}",
        source_url=row["url"],
        document_fact_hash="0" * 64,
    )
    document = replace(
        document,
        document_fact_hash=canonical_scan_document_fact_hash(document),
    )
    return TextHitEnvelope(
        document=document,
        hit=TextHit(
            term_id=term_id,
            hit_kind=hit_kind,
            document_id=document.document_id,
            ticker=document.ticker,
            language=document.language,
            field=selected_field,
            start_offset=offset,
            end_offset=offset + len(keyword),
            context_hash=canonical_text_context_hash(
                selected_text[offset : offset + len(keyword)]
            ),
            taxonomy_version="multibagger-zh@1.0.0",
        ),
    )


def _universe_fact(record: MultibaggerSourceRecord) -> UniverseFact:
    storage = build_storage_row(record)
    body = storage.canonical_body
    return UniverseFact(
        market_scope=body["market_scope"],
        provider_market_label=body["provider_market_label"],
        exchange=body["exchange"],
        ticker=body["ticker"],
        record_kind=body["record_kind"],
        universe_source_kind=body["universe_source_kind"],
        source_document_id=body["source_document_id"],
        source_version=body["source_version"],
        effective_at_utc=record.effective_at_utc,
        available_at_utc=record.available_at_utc,
        as_of_utc=record.as_of_utc,
        features=dict(body["features"]),
        evidence_refs=tuple(body["evidence_refs"]),
        text_hit_kinds=tuple(body["text_hit_kinds"]),
        fundamental_snapshot=dict(body["fundamental_snapshot"]),
        filter_pass_bitmap=body["filter_pass_bitmap"],
        market_cap_cny_100m=body["market_cap_cny_100m"],
        fact_hash=record.fact_hash,
    )


def _text_fact(envelope: TextHitEnvelope) -> TextHitFact:
    return TextHitFact(**build_text_hit_storage_row(envelope).__dict__)


def _decision(row: dict, as_of: datetime) -> StrategyDecision:
    as_of_text = as_of.strftime("%Y-%m-%dT%H:%M:%SZ")
    dimensions = {
        key: {
            "score": round(float(row[key]), 2),
            "band": _band(float(row[key])),
            "evidence": [
                f"factor_scores:{key}:{row['trading_day'].isoformat()}",
                f"announcement:{row['announcement_id']}",
            ],
            "inputs": {
                "percentile": round(float(row[key]) / 100.0, 6),
                "announcement_id": row["announcement_id"],
            },
        }
        for key in WEIGHTS
    }
    total = round(sum(dimensions[key]["score"] * WEIGHTS[key] for key in WEIGHTS), 1)
    score_body = {
        "ticker": row["stock_code"],
        "as_of": as_of_text,
        "market_scope": "cn_a",
        **dimensions,
        "weights": WEIGHTS,
        "weights_profile": "multibagger",
        "total": total,
        "rating": _band(total),
        "computed_at": as_of_text,
        "source_versions": {
            f"{key}_engine": f"factor-{key}@{row['trading_day'].isoformat()}"
            for key in WEIGHTS
        },
    }
    score_body["snapshot_hash"] = _hash(score_body)
    score_body["scoring_id"] = _uuid4(
        "multibagger-score", row["stock_code"], score_body["snapshot_hash"]
    )
    score_ref = {
        "scoring_id": score_body["scoring_id"],
        "snapshot_hash": score_body["snapshot_hash"],
    }
    close = round(float(row["close"]), 2)
    if total >= 85:
        tier, pct = "TIER_5", 5.0
    elif total >= 70:
        tier, pct = "TIER_3", 3.0
    elif total >= 55:
        tier, pct = "TIER_2", 2.0
    elif total >= 40:
        tier, pct = "TIER_1", 1.0
    else:
        tier, pct = "SKIP", 0.0
    return StrategyDecision(
        score=score_body,
        conviction={
            "ticker": row["stock_code"],
            "as_of": as_of_text,
            "base": total,
            "score_ref": score_ref,
            "adjustments": [],
            "final": total,
            "level": "HIGH" if total >= 75 else "MED" if total >= 50 else "LOW",
        },
        risk_gate={
            "ticker": row["stock_code"],
            "evaluated_at": as_of_text,
            "gate": "GREEN",
            "triggers": [],
            "ok_to_enter": True,
        },
        entry_plan={
            "ticker": row["stock_code"],
            "generated_at": as_of_text,
            "entry": {
                "low": round(close * 0.97, 2),
                "high": round(close * 1.01, 2),
                "currency": "CNY",
            },
            "stop": {"value": round(close * 0.91, 2), "currency": "CNY"},
            "targets": [
                {"value": round(close * 1.25, 2), "currency": "CNY"},
                {"value": round(close * 1.60, 2), "currency": "CNY"},
            ],
            "size_hint": {
                "tier": tier,
                "pct": pct,
                "disclaimer_key": "size_hint_advisory",
                "rationale": "真实公告催化与多因子排名共同确认。",
            },
            "time_horizon": "POSITION",
            "invalidation": "公告催化失效或收盘价跌破正式止损位。",
            "conviction_ref": total,
            "score_ref": score_ref,
        },
        strategy_version="multibagger-live@1.0.0",
    )


class _Policy:
    def classify(self, sources, text_hits, strategy_decision):
        total = float(strategy_decision.score["total"])
        return ClassificationDecision(
            stage="growth" if total >= 75 else "early",
            conclusion="MULTIBAGGER_5X" if total >= 85 else "MULTIBAGGER_2X",
            policy_version="live-catalyst-policy@1.0.0",
            reason_codes=("ANNOUNCEMENT_CATALYST", "FACTOR_RANK_CONFIRMED"),
        )


async def _write_sources(values: dict[str, str], records, envelopes, as_of):
    import asyncpg

    pool = await asyncpg.create_pool(
        host=values["DB_HOST"],
        port=int(values["DB_PORT"]),
        database=values["DB_NAME"],
        user=values["DB_USER"],
        password=values["DB_PASSWORD"],
        min_size=1,
        max_size=2,
    )
    try:
        source_result = await MultibaggerSourceWriter(pool).write_batch(records)
        hit_result = await TextHitWriter(pool).write_batch(envelopes, as_of_utc=as_of)
        return source_result, hit_result
    finally:
        await pool.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate the production query and preview the daily batch without writing facts.",
    )
    args = parser.parse_args()
    if args.limit < 1 or args.limit > 20:
        raise SystemExit("--limit must be between 1 and 20")
    values = _load_env(args.env_file)
    database_url = _database_url(values)
    rows = _read_rows(database_url, args.limit)
    if not rows:
        raise RuntimeError("no live announcement/factor candidates were found")
    as_of = _stable_as_of(database_url, rows)
    records = tuple(_source_record(row, as_of) for row in rows)
    envelopes = tuple(_text_envelope(row) for row in rows)
    if args.dry_run:
        print(
            json.dumps(
                {
                    "as_of": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "dry_run": True,
                    "research_day": rows[0]["trading_day"].isoformat(),
                    "candidate_count": len(rows),
                    "tickers": [row["stock_code"] for row in rows],
                    "source_versions": sorted(
                        {record.source_version for record in records}
                    ),
                    "would_write_universe": len(records),
                    "would_write_text_hits": len(envelopes),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return 0
    source_result, hit_result = asyncio.run(
        _write_sources(values, records, envelopes, as_of)
    )

    store = PostgresCandidateStore(database_url)
    candidates = []
    for row, record, envelope in zip(rows, records, envelopes):
        text_fact = _text_fact(envelope)
        catalyst_kind = (
            "ma_activity" if "收购" in row["original_title"] else "product"
        )
        candidate = materialize_candidate(
            MaterializationInput(
                market_scope="cn_a",
                exchange=row["exchange"],
                ticker=row["stock_code"],
                as_of_utc=as_of,
                sources=(_universe_fact(record),),
                text_hits=(text_fact,),
                decision=_decision(row, as_of),
                latest_catalyst=LatestCatalyst(
                    kind=catalyst_kind,
                    title=row["original_title"],
                    occurred_at=datetime.combine(
                        row["announce_date"], time.min, tzinfo=timezone.utc
                    ),
                    available_at_utc=text_fact.available_at_utc,
                    source_ref=text_fact.source_document_id,
                    fact_hash=text_fact.document_fact_hash,
                ),
            ),
            _Policy(),
        )
        candidates.append(store.write_or_verify(candidate))

    print(
        json.dumps(
            {
                "as_of": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "universe_write": source_result.__dict__,
                "text_hit_write": hit_result.__dict__,
                "candidate_count": len(candidates),
                "tickers": [candidate.ticker for candidate in candidates],
                "candidate_fact_hashes": [candidate.fact_hash for candidate in candidates],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
