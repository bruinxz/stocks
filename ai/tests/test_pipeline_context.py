import unittest
from types import SimpleNamespace

from ai.pipeline.context import PipelineContext, RecommendationContractError
from ai.validation.output_validator import OutputValidator


def _config():
    return SimpleNamespace(
        profile="us_preferred",
        market_scope="us",
        strategy_version="strategy@v0.3.1",
        pipeline_version="pipeline@v0.3.1",
    )


def _recommendation(weights, score=None, ticker="AAPL"):
    return {
        "id": f"rec-{ticker}",
        "snapshot_id": "snapshot-1",
        "ticker": ticker,
        "as_of": "2026-07-11T00:00:00Z",
        "score": score or {
            "scoring_id": "score-1",
            "snapshot_hash": "hash-1",
            "profile": "us_preferred",
            "market_scope": "us",
            "total": 80.0,
            "rating": "A",
            "dims": [],
        },
        "conviction": {
            "base": 80.0,
            "adjustments": [],
            "final": 80.0,
            "level": "HIGH",
        },
        "risk_gate": {
            "gate": "GREEN",
            "ok_to_enter": True,
            "triggers": [],
        },
        "entry_plan": {
            "size_hint": {
                "tier": "TIER_3",
                "pct": 3.0,
                "disclaimer_key": "size_hint_advisory",
            }
        },
        "trigger_signals": [{"code": "RULE_MATCHED"}],
        "weights": weights,
        "explanation": {"body": "[E1]"},
        "evidence_refs": [
            {
                "id": "E1",
                "source_uri": "ai-rule://bundle/rule@1.0.0",
            }
        ],
        "model_version": "model@v0.3.1",
        "disclaimer_version": "none",
    }


def _context_with(recommendation):
    ctx = PipelineContext(
        snapshot_id="12345678-1234-5678-1234-567812345678",
        as_of="2026-07-11T00:00:00Z",
        config=_config(),
    )
    ctx.recommendations.append(recommendation)
    return ctx


class PipelineContextRatingBandTests(unittest.TestCase):
    def setUp(self):
        self.validator = OutputValidator()

    def test_rating_only_score_with_normalized_attribution_passes(self):
        recommendation = _recommendation(
            weights={
                "contributions": [
                    {
                        "source_kind": "trigger",
                        "source_ref": "RULE_MATCHED",
                        "weight": 1.0,
                    }
                ],
                "normalized": True,
            }
        )

        recommendation_list = _context_with(recommendation).build_recommendation_list()

        self.assertEqual(recommendation_list["items"][0]["rating_band"], "A")
        self.assertEqual(self.validator.validate(recommendation_list), [])

    def test_rating_only_score_with_zero_mass_attribution_passes(self):
        recommendation = _recommendation(
            weights={"contributions": [], "normalized": False},
            ticker="MSFT",
        )

        recommendation_list = _context_with(recommendation).build_recommendation_list()

        self.assertEqual(recommendation_list["items"][0]["rating_band"], "A")
        self.assertEqual(self.validator.validate(recommendation_list), [])

    def test_aggregate_band_without_rating_fails_with_contract_error(self):
        recommendation = _recommendation(
            weights={
                "contributions": [
                    {
                        "source_kind": "trigger",
                        "source_ref": "RULE_MATCHED",
                        "weight": 1.0,
                    }
                ],
                "normalized": True,
            },
            score={
                "scoring_id": "score-legacy",
                "snapshot_hash": "hash-legacy",
                "profile": "us_preferred",
                "market_scope": "us",
                "total": 80.0,
                "band": "A",
                "dims": [],
            },
            ticker="LEGACY",
        )

        with self.assertRaisesRegex(
            RecommendationContractError,
            "LEGACY: score.rating is required",
        ):
            _context_with(recommendation).build_recommendation_list()


if __name__ == "__main__":
    unittest.main()
