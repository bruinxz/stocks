from __future__ import annotations

import hashlib
from types import SimpleNamespace
import unittest

from ai.pipeline.context import PipelineContext
from ai.pipeline.stages.assembly import AssemblyStage
from ai.pipeline.stages.feature_assembly import FeatureAssemblyStage
from ai.snapshot.fingerprint import jcs_canonicalize
from strategy.reporting.tab67_projection import validate_recommendation_list


AS_OF = "2026-07-10T06:30:00Z"
TICKER = "AAPL"
TYPED_FACT_HASH = "a" * 64


def _config():
    full_text = "仅供研究参考"
    return SimpleNamespace(
        profile="us_preferred",
        market_scope="us",
        strategy_version="1.0.0",
        pipeline_version="1.0.0",
        model_version="1.0.0",
        rule_bundle_hash="b" * 64,
        template_hash="c" * 64,
        contract_version="0.3.1",
        profile_version="1.0.0",
        disclaimer_hash=hashlib.sha256(full_text.encode("utf-8")).hexdigest(),
        disclaimer={
            "version": "1.0.0",
            "short_text": full_text,
            "full_text": full_text,
            "language": "zh-CN",
            "effective_at": "2026-01-01T00:00:00Z",
            "hash": hashlib.sha256(full_text.encode("utf-8")).hexdigest(),
        },
    )


def _source_features():
    dimensions = [
        {"key": key, "score": 90.0, "band": "A", "weight": weight}
        for key, weight in zip(
            ("Q", "G", "V", "M", "T", "R"),
            (0.2, 0.2, 0.15, 0.2, 0.15, 0.1),
        )
    ]
    return {
        "score": {
            "profile": "us_preferred",
            "market_scope": "us",
            "rating": "A",
            "total": 90.0,
            "dims": dimensions,
        },
        "conviction": {
            "base": 90.0,
            "adjustments": [],
            "final": 90.0,
            "level": "HIGH",
        },
        "risk_gate": {"gate": "GREEN", "ok_to_enter": True, "triggers": []},
        "entry_plan": {
            "entry": {"low": 100.0, "high": 100.0, "currency": "USD"},
            "stop": {"value": 96.0, "currency": "USD"},
            "targets": [
                {"value": 115.0, "currency": "USD"},
                {"value": 130.0, "currency": "USD"},
                {"value": 150.0, "currency": "USD"},
            ],
            "size_hint": {
                "tier": "TIER_5",
                "pct": 5.0,
                "disclaimer_key": "size_hint_advisory",
                "rationale": "High conviction with an authenticated plan.",
            },
            "time_horizon": "POSITION",
            "invalidation": "Close below the authenticated stop price.",
            "stop_distance_pct": 4.0,
        },
    }


class PipelineFeatureAssemblyTests(unittest.TestCase):
    def test_typed_score_becomes_projection_valid_with_physical_provenance(self):
        ctx = PipelineContext(
            snapshot_id="12345678-1234-4234-8234-567812345678",
            as_of=AS_OF,
            config=_config(),
            universe=[TICKER],
            scores={TICKER: _source_features()},
            evidence_refs={
                TICKER: [
                    {
                        "kind": "SCORE_INPUT",
                        "source_uri": "ai-model://strategy-score@score-v1/" + TYPED_FACT_HASH,
                        "as_of": AS_OF,
                        "hash": TYPED_FACT_HASH,
                        "short_text": "Strategy score snapshot",
                    }
                ]
            },
            score_provenance={
                TICKER: {
                    "fact_hash": TYPED_FACT_HASH,
                    "source_version": "score-v1",
                    "available_at_utc": AS_OF,
                }
            },
            recommendation_ids={
                TICKER: "22345678-1234-4234-8234-567812345678"
            },
            input_hashes=["d" * 64, "e" * 64, "f" * 64, "1" * 64],
        )

        FeatureAssemblyStage().execute(ctx)
        features = ctx.scores[TICKER]
        ctx.gated_candidates = [
            {
                "ticker": TICKER,
                "features": features,
                "triggers": [
                    {
                        "code": "CONVICTION_HIGH",
                        "strength": "STRONG",
                        "detail": "Authenticated conviction exceeds the high threshold.",
                    }
                ],
            }
        ]
        AssemblyStage().execute(ctx)
        envelope = ctx.build_recommendation_list()

        validated = validate_recommendation_list(envelope)
        recommendation = validated["items"][0]["recommendation"]
        score = recommendation["score"]
        score_preimage = dict(score)
        del score_preimage["scoring_id"]
        del score_preimage["snapshot_hash"]
        self.assertEqual(
            score["snapshot_hash"],
            hashlib.sha256(
                jcs_canonicalize(score_preimage).encode("utf-8")
            ).hexdigest(),
        )
        expected_ref = {
            "scoring_id": score["scoring_id"],
            "snapshot_hash": score["snapshot_hash"],
        }
        self.assertEqual(recommendation["conviction"]["score_ref"], expected_ref)
        self.assertEqual(recommendation["entry_plan"]["score_ref"], expected_ref)
        self.assertEqual(recommendation["entry_plan"]["entry"]["low"], 100.0)
        self.assertEqual(recommendation["evidence_refs"][0]["hash"], TYPED_FACT_HASH)


if __name__ == "__main__":
    unittest.main()
