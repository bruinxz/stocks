import math
import unittest

from ai.pipeline.stages.assembly import AssemblyStage
from ai.types import WeightAttribution
from ai.validation.output_validator import OutputValidator


def _raw(*values):
    return [
        {
            "source_kind": "trigger",
            "source_ref": f"source-{index}",
            "raw_contribution": value,
        }
        for index, value in enumerate(values)
    ]


def _recommendation_list(attribution):
    return {
        "items": [
            {
                "recommendation": {
                    "risk_gate": {"ok_to_enter": True},
                    "trigger_signals": [{"code": "RULE_MATCHED"}],
                    "evidence_refs": [
                        {
                            "id": "E1",
                            "source_uri": "ai-rule://bundle/rule@1.0.0",
                        }
                    ],
                    "weights": attribution,
                    "explanation": {"body": "[E1]"},
                    "score": {"rating": "A"},
                    "conviction": {
                        "base": 80.0,
                        "adjustments": [],
                        "final": 80.0,
                    },
                    "entry_plan": {
                        "size_hint": {
                            "tier": "TIER_3",
                            "pct": 3.0,
                            "disclaimer_key": "size_hint_advisory",
                        }
                    },
                },
                "rating_band": "A",
            }
        ],
        "disclaimer": None,
    }


class AssemblySignedL1Tests(unittest.TestCase):
    def test_all_positive_contributions(self):
        attribution = AssemblyStage._normalize_contributions(_raw(3.0, 1.0))

        self.assertTrue(attribution["normalized"])
        self.assertEqual(
            [contribution["weight"] for contribution in attribution["contributions"]],
            [0.75, 0.25],
        )
        self.assertAlmostEqual(
            sum(abs(c["weight"]) for c in attribution["contributions"]),
            1.0,
        )

    def test_mixed_sign_contributions_with_zero_signed_net(self):
        attribution = AssemblyStage._normalize_contributions(_raw(2.0, -2.0))
        weights = [c["weight"] for c in attribution["contributions"]]

        self.assertEqual(weights, [0.5, -0.5])
        self.assertAlmostEqual(sum(abs(weight) for weight in weights), 1.0)
        self.assertAlmostEqual(sum(weights), 0.0)

    def test_single_negative_contribution(self):
        attribution = AssemblyStage._normalize_contributions(_raw(-4.0))

        self.assertTrue(attribution["normalized"])
        self.assertEqual(attribution["contributions"][0]["weight"], -1.0)

    def test_zero_mass_collapses_to_empty_unnormalized_state(self):
        for raw in ([], _raw(0.0, -0.0)):
            with self.subTest(raw=raw):
                attribution = AssemblyStage._normalize_contributions(raw)
                self.assertEqual(
                    attribution,
                    {"contributions": [], "normalized": False},
                )

        self.assertEqual(
            AssemblyStage()._compute_weights([], {"score": {"dims": []}}),
            {"contributions": [], "normalized": False},
        )

    def test_normalization_is_deterministic_and_rejects_non_finite_input(self):
        raw = _raw(0.3, -0.1, 0.2)
        self.assertEqual(
            AssemblyStage._normalize_contributions(raw),
            AssemblyStage._normalize_contributions(raw),
        )

        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "must be a finite number"):
                    AssemblyStage._normalize_contributions(_raw(value))

    def test_boolean_raw_contribution_is_rejected(self):
        for value in (True, False):
            with self.subTest(value=value):
                with self.assertRaisesRegex(
                    ValueError,
                    "must be a finite number",
                ):
                    AssemblyStage._normalize_contributions(_raw(value))

    def test_overflowing_l1_denominator_is_rejected(self):
        with self.assertRaisesRegex(
            ValueError,
            "L1 denominator must be finite",
        ):
            AssemblyStage._normalize_contributions(_raw(1e308, 1e308))


class ValidatorSignedL1Tests(unittest.TestCase):
    def setUp(self):
        self.validator = OutputValidator()

    def test_all_positive_contributions_pass(self):
        attribution = AssemblyStage._normalize_contributions(_raw(3.0, 1.0))
        self.assertEqual(
            self.validator.validate(_recommendation_list(attribution)),
            [],
        )

    def test_mixed_sign_zero_net_passes_l1_rule(self):
        attribution = AssemblyStage._normalize_contributions(_raw(1.0, -1.0))
        signed_sum = sum(
            contribution["weight"]
            for contribution in attribution["contributions"]
        )
        legacy_signed_sum_error = abs(signed_sum - 1.0) > 1e-6

        self.assertEqual(signed_sum, 0.0)
        self.assertTrue(legacy_signed_sum_error)
        self.assertEqual(
            self.validator.validate(_recommendation_list(attribution)),
            [],
        )

    def test_single_negative_contribution_passes(self):
        attribution = AssemblyStage._normalize_contributions(_raw(-1.0))
        self.assertEqual(
            self.validator.validate(_recommendation_list(attribution)),
            [],
        )

    def test_empty_unnormalized_state_passes(self):
        attribution = {"contributions": [], "normalized": False}
        self.assertEqual(
            self.validator.validate(_recommendation_list(attribution)),
            [],
        )

    def test_invalid_state_combinations_fail_closed(self):
        invalid_attributions = [
            {"contributions": [], "normalized": True},
            {
                "contributions": [
                    {
                        "source_kind": "trigger",
                        "source_ref": "zero",
                        "weight": 0.0,
                    }
                ],
                "normalized": True,
            },
            {
                "contributions": [
                    {
                        "source_kind": "trigger",
                        "source_ref": "not-normalized",
                        "weight": 1.0,
                    }
                ],
                "normalized": False,
            },
        ]

        for attribution in invalid_attributions:
            with self.subTest(attribution=attribution):
                errors = self.validator.validate(
                    _recommendation_list(attribution)
                )
                self.assertTrue(
                    any(
                        "contribution" in error or "normalized" in error
                        for error in errors
                    ),
                    errors,
                )

    def test_aggregate_score_band_without_rating_fails_closed(self):
        attribution = AssemblyStage._normalize_contributions(_raw(1.0))
        recommendation_list = _recommendation_list(attribution)
        recommendation_list["items"][0]["recommendation"]["score"] = {"band": "A"}

        errors = self.validator.validate(recommendation_list)

        self.assertIn(
            "items[0]: rating_band != score.rating",
            errors,
        )

    def test_default_dataclass_matches_zero_mass_contract(self):
        attribution = WeightAttribution()
        self.assertEqual(attribution.contributions, [])
        self.assertFalse(attribution.normalized)


if __name__ == "__main__":
    unittest.main()
