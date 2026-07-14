from dataclasses import asdict
import json
import os
import subprocess
import sys

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from strategy.materialization import (
    candidate_from_row,
)
from strategy.tests.test_multibagger_candidate_materializer import (
    request,
    text_hit,
    universe_fact,
)


def main() -> None:
    database_url = os.environ["TAB4_DATABASE_URL"]
    source = universe_fact()
    hit = text_hit()
    with psycopg.connect(database_url, passfile="") as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO multibagger_universe (
                  market_scope, provider_market_label, exchange, ticker,
                  record_kind, universe_source_kind, source_document_id,
                  source_version, effective_at_utc, available_at_utc, as_of_utc,
                  features, evidence_refs, text_hit_kinds, fundamental_snapshot,
                  filter_pass_bitmap, market_cap_cny_100m, fact_hash
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    source.market_scope,
                    source.provider_market_label,
                    source.exchange,
                    source.ticker,
                    source.record_kind,
                    source.universe_source_kind,
                    source.source_document_id,
                    source.source_version,
                    source.effective_at_utc,
                    source.available_at_utc,
                    source.as_of_utc,
                    Jsonb(dict(source.features)),
                    Jsonb(list(source.evidence_refs)),
                    Jsonb(list(source.text_hit_kinds)),
                    Jsonb(dict(source.fundamental_snapshot)),
                    source.filter_pass_bitmap,
                    source.market_cap_cny_100m,
                    source.fact_hash,
                ),
            )
            cursor.execute(
                """
                INSERT INTO multibagger_text_hit (
                  market_scope, ticker, source_kind, source_document_id, source_version,
                  document_fact_hash, taxonomy_version, term_id, hit_kind,
                  language, field, start_offset, end_offset, context_hash, hit_fact_hash,
                  effective_at_utc, available_at_utc
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    hit.market_scope,
                    hit.ticker,
                    hit.source_kind,
                    hit.source_document_id,
                    hit.source_version,
                    hit.document_fact_hash,
                    hit.taxonomy_version,
                    hit.term_id,
                    hit.hit_kind,
                    hit.language,
                    hit.field,
                    hit.start_offset,
                    hit.end_offset,
                    hit.context_hash,
                    hit.hit_fact_hash,
                    hit.effective_at_utc,
                    hit.available_at_utc,
                ),
            )

    materialization = request(text_hits=())
    decision = materialization.decision
    catalyst = materialization.latest_catalyst
    payload = {
        "market_scope": materialization.market_scope,
        "exchange": materialization.exchange,
        "ticker": materialization.ticker,
        "as_of_utc": materialization.as_of_utc.isoformat().replace("+00:00", "Z"),
        "decision": {
            "score": dict(decision.score),
            "conviction": dict(decision.conviction),
            "risk_gate": dict(decision.risk_gate),
            "entry_plan": dict(decision.entry_plan) if decision.entry_plan else None,
            "strategy_version": decision.strategy_version,
        },
        "classification": {
            "stage": "growth",
            "conclusion": "MULTIBAGGER_5X",
            "policy_version": "stage-policy@1.0.0",
            "reason_codes": ["CAPTURED_SOURCE"],
        },
        "latest_catalyst": None if catalyst is None else asdict(catalyst),
    }
    payload["latest_catalyst"]["occurred_at"] = (
        catalyst.occurred_at.isoformat().replace("+00:00", "Z")
    )
    payload["latest_catalyst"]["available_at_utc"] = (
        catalyst.available_at_utc.isoformat().replace("+00:00", "Z")
    )
    env = {
        **os.environ,
        "TAB4_DATABASE_URL": database_url,
        "TAB4_CANDIDATE_DISPOSABLE_WRITE": "1",
    }
    outputs = []
    for _ in range(2):
        completed = subprocess.run(
            [sys.executable, "-m", "strategy.materialization.cli", "--write-disposable"],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr
        assert completed.stderr == ""
        outputs.append(json.loads(completed.stdout))
    assert outputs[0] == outputs[1]

    with psycopg.connect(database_url, row_factory=dict_row, passfile="") as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                  market_scope, exchange, ticker,
                  to_char(as_of_utc AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS as_of_utc,
                  to_char(available_at_utc AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS available_at_utc,
                  stage, conclusion, score, rating, conviction, risk_gate,
                  entry_plan, latest_catalyst, source_fact_hashes,
                  strategy_version, classification_policy_version,
                  classification_reason_codes, fact_hash
                FROM multibagger_candidate_snapshot
                """
            )
            rows = cursor.fetchall()
    assert len(rows) == 1
    candidate = candidate_from_row(rows[0])
    assert outputs[0] == dict(rows[0])
    print(
        "tab4-live-seed: PASS "
        f"(ticker={candidate.ticker}, fact_hash={candidate.fact_hash})"
    )


if __name__ == "__main__":
    main()
