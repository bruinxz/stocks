import unittest
import hashlib
from types import SimpleNamespace

from ai.pipeline.context import PipelineContext, RecommendationContractError
from ai.types import BAND_RATING_SEQUENCE
from ai.validation.output_validator import OutputValidator


def _config():
    full_text = "Research only. No investment promise."
    return SimpleNamespace(
        profile="us_preferred",
        market_scope="us",
        strategy_version="strategy@v0.3.1",
        pipeline_version="pipeline@v0.3.1",
        contract_version="0.3.1",
        profile_version="profile@v0.3.1",
        disclaimer_hash=hashlib.sha256(full_text.encode("utf-8")).hexdigest(),
        disclaimer={
            "version": "none",
            "short_text": "Research only.",
            "full_text": full_text,
            "language": "en-US",
            "effective_at": "2026-07-01T00:00:00Z",
            "hash": hashlib.sha256(full_text.encode("utf-8")).hexdigest(),
        },
    )


def _recommendation(weights, score=None, ticker="AAPL"):
    ids = {
        "AAPL": "22345678-1234-4234-8234-567812345678",
        "MSFT": "32345678-1234-4234-8234-567812345678",
        "LEGACY": "42345678-1234-4234-8234-567812345678",
        "INVALID": "52345678-1234-4234-8234-567812345678",
        "TICKER-A": "62345678-1234-4234-8234-567812345678",
        "TICKER-B": "72345678-1234-4234-8234-567812345678",
        "TICKER-C": "82345678-1234-4234-8234-567812345678",
        "TICKER-D": "92345678-1234-4234-8234-567812345678",
        "TICKER-F": "a2345678-1234-4234-8234-567812345678",
    }
    return {
        "id": ids[ticker],
        "snapshot_id": "12345678-1234-4234-8234-567812345678",
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
        snapshot_id="12345678-1234-4234-8234-567812345678",
        as_of="2026-07-11T00:00:00Z",
        config=_config(),
    )
    ctx.recommendations.append(recommendation)
    ctx.input_hashes.extend(["a" * 64, "b" * 64])
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

    def test_all_canonical_ratings_pass_context_and_validator(self):
        for rating in BAND_RATING_SEQUENCE:
            with self.subTest(rating=rating):
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
                        "scoring_id": f"score-{rating}",
                        "snapshot_hash": f"hash-{rating}",
                        "profile": "us_preferred",
                        "market_scope": "us",
                        "total": 80.0,
                        "rating": rating,
                        "dims": [],
                    },
                    ticker=f"TICKER-{rating}",
                )

                recommendation_list = (
                    _context_with(recommendation).build_recommendation_list()
                )

                self.assertEqual(
                    recommendation_list["items"][0]["rating_band"],
                    rating,
                )
                self.assertEqual(
                    self.validator.validate(recommendation_list),
                    [],
                )

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
            r"LEGACY: score\.rating must be one of A\|B\|C\|D\|F",
        ):
            _context_with(recommendation).build_recommendation_list()

    def test_invalid_score_ratings_fail_with_contract_error(self):
        invalid_ratings = [None, "Z", 85, True, ["A"]]

        for rating in invalid_ratings:
            with self.subTest(rating=rating):
                recommendation = _recommendation(
                    weights={"contributions": [], "normalized": False},
                    score={
                        "scoring_id": "score-invalid",
                        "snapshot_hash": "hash-invalid",
                        "profile": "us_preferred",
                        "market_scope": "us",
                        "total": 80.0,
                        "rating": rating,
                        "dims": [],
                    },
                    ticker="INVALID",
                )

                with self.assertRaisesRegex(
                    RecommendationContractError,
                    r"INVALID: score\.rating must be one of A\|B\|C\|D\|F",
                ):
                    _context_with(recommendation).build_recommendation_list()

    def test_validator_rejects_invalid_and_mismatched_bands(self):
        invalid_cases = [
            (None, "A", "score.rating must be one of"),
            ("Z", "Z", "score.rating must be one of"),
            (85, "A", "score.rating must be one of"),
            ("A", None, "rating_band must be one of"),
            ("A", "Z", "rating_band must be one of"),
            ("A", 85, "rating_band must be one of"),
            ("A", "B", "rating_band != score.rating"),
        ]

        for score_rating, rating_band, expected_error in invalid_cases:
            with self.subTest(
                score_rating=score_rating,
                rating_band=rating_band,
            ):
                recommendation = _recommendation(
                    weights={"contributions": [], "normalized": False},
                    score={
                        "scoring_id": "score-invalid",
                        "snapshot_hash": "hash-invalid",
                        "profile": "us_preferred",
                        "market_scope": "us",
                        "total": 80.0,
                        "rating": score_rating,
                        "dims": [],
                    },
                )
                recommendation_list = {
                    "items": [
                        {
                            "recommendation": recommendation,
                            "rating_band": rating_band,
                        }
                    ],
                    "disclaimer": None,
                }

                errors = self.validator.validate(recommendation_list)

                self.assertTrue(
                    any(expected_error in error for error in errors),
                    errors,
                )

    def test_missing_pins_disclaimer_and_inputs_fail_closed(self):
        recommendation = _recommendation(
            weights={"contributions": [], "normalized": False}
        )
        cases = (
            "contract_version",
            "profile_version",
            "disclaimer",
            "disclaimer_hash",
            "disclaimer_hash_mismatch",
            "inputs",
        )
        for case in cases:
            with self.subTest(case=case):
                ctx = _context_with(recommendation)
                if case == "inputs":
                    ctx.input_hashes = []
                elif case == "disclaimer_hash_mismatch":
                    ctx.config.disclaimer_hash = "0" * 64
                else:
                    delattr(ctx.config, case)
                with self.assertRaises(RecommendationContractError):
                    ctx.build_recommendation_list()


if __name__ == "__main__":
    unittest.main()
