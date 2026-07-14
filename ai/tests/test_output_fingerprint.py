import copy
import hashlib
import math
import unittest

from ai.pipeline.context import PipelineContext
from ai.snapshot.fingerprint import (
    JCSCanonicalizationError,
    canonicalize_output_fingerprint_preimage,
    compute_input_fingerprint,
    compute_output_fingerprint,
    jcs_canonicalize,
)


def _envelope():
    return {
        "snapshot_id": "12345678-1234-4234-8234-567812345678",
        "as_of": "2026-07-12T01:02:03Z",
        "profile": "us_preferred",
        "market_scope": "us",
        "items": [
            {
                "recommendation": {
                    "id": "22345678-1234-4234-8234-567812345678",
                    "snapshot_id": "12345678-1234-4234-8234-567812345678",
                    "ticker": "ZZZ",
                    "conviction": {"final": 90},
                    "weights": {"normalized": False, "contributions": []},
                },
                "rating_band": "A",
            },
            {
                "recommendation": {
                    "id": "32345678-1234-4234-8234-567812345678",
                    "snapshot_id": "12345678-1234-4234-8234-567812345678",
                    "ticker": "AAA",
                    "conviction": {"final": 80},
                    "weights": {"normalized": False, "contributions": []},
                },
                "rating_band": "B",
            },
        ],
        "disclaimer": {
            "version": "3.1.0",
            "full_text": "日本株 📈",
            "hash": "a" * 64,
        },
        "meta": {
            "contract_version": "0.3.1",
            "profile_version": "3.1.0",
            "input_fingerprint": "b" * 64,
            "strategy_version": "3.1.0",
            "pipeline_version": "3.1.0",
            "generated_by": "worker-a",
            "generation_ms": 1,
        },
    }


class OutputFingerprintTests(unittest.TestCase):
    def test_empty_items_golden(self):
        envelope = _envelope()
        envelope["items"] = []
        preimage = canonicalize_output_fingerprint_preimage(envelope)
        self.assertEqual(
            hashlib.sha256(preimage.encode("utf-8")).hexdigest(),
            "528ecd4ff12940009112ef784673d30cde4a66ff521ca134"
            "8b7e4a685fb0f3ea",
        )
        self.assertEqual(compute_output_fingerprint(envelope), hashlib.sha256(
            preimage.encode("utf-8")
        ).hexdigest())

    def test_identity_and_telemetry_only_mutations_are_invariant(self):
        original = _envelope()
        mutated = copy.deepcopy(original)
        mutated["snapshot_id"] = "42345678-1234-4234-8234-567812345678"
        mutated["output_fingerprint"] = "f" * 64
        mutated["meta"]["generated_by"] = "worker-b"
        mutated["meta"]["generation_ms"] = 999
        for index, item in enumerate(mutated["items"]):
            item["recommendation"]["id"] = (
                f"{index + 5}2345678-1234-4234-8234-567812345678"
            )
            item["recommendation"]["snapshot_id"] = mutated["snapshot_id"]
        self.assertEqual(
            compute_output_fingerprint(original),
            compute_output_fingerprint(mutated),
        )

    def test_identity_presence_version_and_binding_fail_closed(self):
        invalid = []
        for path, value in (
            (("snapshot_id",), None),
            (("snapshot_id",), "not-a-uuid"),
            (("items", 0, "recommendation", "id"), None),
            (("items", 0, "recommendation", "id"), "not-a-uuid"),
            (
                ("items", 0, "recommendation", "snapshot_id"),
                "42345678-1234-4234-8234-567812345678",
            ),
        ):
            envelope = _envelope()
            target = envelope
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            invalid.append(envelope)
        for envelope in invalid:
            with self.subTest(envelope=envelope):
                with self.assertRaises(JCSCanonicalizationError):
                    compute_output_fingerprint(envelope)

    def test_volatile_telemetry_must_be_valid_before_exclusion(self):
        invalid = []
        for field, value in (
            ("generated_by", None),
            ("generated_by", ""),
            ("generation_ms", None),
            ("generation_ms", True),
            ("generation_ms", -1),
            ("generation_ms", math.nan),
            ("generation_ms", math.inf),
        ):
            envelope = _envelope()
            if value is None:
                envelope["meta"].pop(field)
            else:
                envelope["meta"][field] = value
            invalid.append(envelope)
        for envelope in invalid:
            with self.subTest(envelope=envelope):
                with self.assertRaises(JCSCanonicalizationError):
                    compute_output_fingerprint(envelope)

    def test_business_pin_disclaimer_and_order_mutations_change_hash(self):
        original = _envelope()
        mutations = []
        for path, value in (
            (("profile",), "multibagger"),
            (("as_of",), "2026-07-12T02:02:03Z"),
            (("meta", "input_fingerprint"), "c" * 64),
            (("disclaimer", "full_text"), "changed"),
            (("items", 0, "recommendation", "ticker"), "CHANGED"),
        ):
            mutated = copy.deepcopy(original)
            target = mutated
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            mutations.append(mutated)
        reordered = copy.deepcopy(original)
        reordered["items"].reverse()
        mutations.append(reordered)

        original_hash = compute_output_fingerprint(original)
        for mutated in mutations:
            with self.subTest(mutated=mutated):
                self.assertNotEqual(
                    original_hash, compute_output_fingerprint(mutated)
                )

    def test_unicode_numbers_negative_zero_and_exponent_golden(self):
        envelope = _envelope()
        envelope["items"][0]["recommendation"]["metrics"] = {
            "negative_zero": -0.0,
            "one_float": 1.0,
            "small": 0.000001,
            "tiny": 0.0000001,
            "large": 1e20,
            "huge": 1e21,
        }
        preimage = canonicalize_output_fingerprint_preimage(envelope)
        self.assertEqual(
            hashlib.sha256(preimage.encode("utf-8")).hexdigest(),
            "d4a04ac38e5564391ca954b003db81f087920d597ae3ff04"
            "e2cd4c27ce7c03fa",
        )
        self.assertEqual(
            compute_output_fingerprint(envelope),
            hashlib.sha256(preimage.encode("utf-8")).hexdigest(),
        )

    def test_public_preimage_helper_is_importable_and_exact(self):
        envelope = _envelope()
        preimage = canonicalize_output_fingerprint_preimage(envelope)
        self.assertIsInstance(preimage, str)
        self.assertNotIn("output_fingerprint", preimage)
        self.assertNotIn(envelope["snapshot_id"], preimage)
        self.assertNotIn(envelope["items"][0]["recommendation"]["id"], preimage)
        self.assertIn('"profile":"us_preferred"', preimage)
        self.assertIn('"full_text":"日本株 📈"', preimage)
        self.assertEqual(
            compute_output_fingerprint(envelope),
            hashlib.sha256(preimage.encode("utf-8")).hexdigest(),
        )

    def test_rfc8785_numeric_and_utf16_vectors(self):
        self.assertEqual(
            jcs_canonicalize(
                [1e30, 4.50, 2e-3, 1e-27, 333333333.33333329]
            ),
            "[1e+30,4.5,0.002,1e-27,333333333.3333333]",
        )
        self.assertEqual(
            jcs_canonicalize({"\ue000": "bmp", "😀": "supplementary"}),
            '{"😀":"supplementary","\ue000":"bmp"}',
        )

    def test_finite_safe_json_values_only(self):
        invalid = [
            math.nan,
            math.inf,
            -math.inf,
            9_007_199_254_740_992,
            {"bad": object()},
            {"bad": "\ud800"},
            {1: "non-string-key"},
        ]
        cyclic = []
        cyclic.append(cyclic)
        invalid.append(cyclic)
        for value in invalid:
            with self.subTest(value=repr(value)):
                with self.assertRaises(JCSCanonicalizationError):
                    jcs_canonicalize(value)

    def test_strict_envelope_shape(self):
        invalid = [[], {"items": []}, {**_envelope(), "meta": None}]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(JCSCanonicalizationError):
                    compute_output_fingerprint(value)

    def test_input_fingerprint_manifest_order_and_fail_closed(self):
        hashes = ["b" * 64, "a" * 64]
        expected_manifest = '["' + ("a" * 64) + '","' + ("b" * 64) + '"]'
        expected = hashlib.sha256(
            expected_manifest.encode("utf-8")
        ).hexdigest()
        self.assertEqual(compute_input_fingerprint(hashes), expected)
        self.assertEqual(
            compute_input_fingerprint(list(reversed(hashes))), expected
        )
        for invalid in (
            [],
            ["a" * 64, "a" * 64],
            ["bad"],
            [True],
            [None],
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(JCSCanonicalizationError):
                    compute_input_fingerprint(invalid)

    def test_pipeline_context_production_path_matches_helper(self):
        full_text = "Research only. No investment promise."
        config = type(
            "Config",
            (),
            {
                "profile": "us_preferred",
                "market_scope": "us",
                "contract_version": "0.3.1",
                "profile_version": "3.1.0",
                "strategy_version": "3.1.0",
                "pipeline_version": "3.1.0",
                "disclaimer_hash": hashlib.sha256(
                    full_text.encode("utf-8")
                ).hexdigest(),
                "disclaimer": {
                    "version": "3.1.0",
                    "short_text": "Research only.",
                    "full_text": full_text,
                    "language": "en-US",
                    "effective_at": "2026-07-01T00:00:00Z",
                    "hash": hashlib.sha256(
                        full_text.encode("utf-8")
                    ).hexdigest(),
                },
            },
        )()
        ctx = PipelineContext(
            snapshot_id="12345678-1234-4234-8234-567812345678",
            as_of="2026-07-12T01:02:03Z",
            config=config,
            input_hashes=["a" * 64],
        )
        recommendation = _envelope()["items"][0]["recommendation"]
        recommendation.update(
            {
                "score": {"rating": "A"},
                "conviction": {
                    "base": 90,
                    "adjustments": [],
                    "final": 90,
                },
                "risk_gate": {"gate": "GREEN", "ok_to_enter": True},
                "trigger_signals": [{"code": "RULE_MATCHED"}],
                "evidence_refs": [
                    {
                        "id": "E1",
                        "source_uri": "ai-rule://bundle/rule@1.0.0",
                    }
                ],
                "weights": {"contributions": [], "normalized": False},
                "explanation": {"body": "[E1]", "language": "en-US"},
                "entry_plan": {
                    "size_hint": {
                        "tier": "TIER_3",
                        "pct": 3.0,
                        "disclaimer_key": "size_hint_advisory",
                    }
                },
                "disclaimer_version": "3.1.0",
            }
        )
        ctx.recommendations.append(recommendation)

        result = ctx.build_recommendation_list()
        self.assertEqual(
            result["output_fingerprint"], compute_output_fingerprint(result)
        )

        volatile = copy.deepcopy(result)
        volatile["snapshot_id"] = "42345678-1234-4234-8234-567812345678"
        volatile["meta"]["generated_by"] = "other"
        volatile["meta"]["generation_ms"] = 999
        volatile["items"][0]["recommendation"]["id"] = (
            "52345678-1234-4234-8234-567812345678"
        )
        volatile["items"][0]["recommendation"]["snapshot_id"] = (
            volatile["snapshot_id"]
        )
        self.assertEqual(
            result["output_fingerprint"], compute_output_fingerprint(volatile)
        )

    def test_pipeline_context_validates_before_fingerprinting(self):
        from ai.pipeline.context import RecommendationContractError

        full_text = "Research only. No investment promise."
        config = type(
            "Config",
            (),
            {
                "profile": "us_preferred",
                "market_scope": "us",
                "contract_version": "0.3.1",
                "profile_version": "3.1.0",
                "strategy_version": "3.1.0",
                "pipeline_version": "3.1.0",
                "disclaimer_hash": "0" * 64,
                "disclaimer": {
                    "version": "3.1.0",
                    "short_text": "Research only.",
                    "full_text": full_text,
                    "language": "en-US",
                    "effective_at": "2026-07-01T00:00:00Z",
                    "hash": "0" * 64,
                },
            },
        )()
        ctx = PipelineContext(
            snapshot_id="12345678-1234-4234-8234-567812345678",
            as_of="2026-07-12T01:02:03Z",
            config=config,
            input_hashes=["a" * 64],
        )
        with self.assertRaisesRegex(
            RecommendationContractError,
            "config.disclaimer_hash must authenticate disclaimer.full_text",
        ):
            ctx.build_recommendation_list()


if __name__ == "__main__":
    unittest.main()
