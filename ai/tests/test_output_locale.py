import hashlib
from types import SimpleNamespace
import unittest

from ai.explanation.template_engine import TemplateEngine
from ai.snapshot.store import PROFILE_MARKET_SCOPES
from ai.types import (
    PROFILE_ALLOWED_OUTPUT_LANGUAGES,
    PROFILE_DEFAULT_OUTPUT_LANGUAGE,
)
from ai.validation.output_validator import OutputValidator


def features():
    return {
        "score": {
            "total": 88.0,
            "rating": "A",
            "dims": [{"key": "quality", "score": 90, "band": "A"}],
        },
        "conviction": {
            "level": "HIGH",
            "adjustments": [{"reason": "quality", "delta": 3}],
        },
        "risk_gate": {"triggers": [{"detail": "filing delay"}]},
        "entry_plan": {"size_hint": {"tier": "TIER_1"}},
    }


def recommendation_list(language: str) -> dict:
    full_text = "Research only."
    disclaimer_hash = hashlib.sha256(full_text.encode("utf-8")).hexdigest()
    return {
        "profile": "japan_multibagger",
        "market_scope": "jp",
        "items": [
            {
                "rating_band": "A",
                "recommendation": {
                    "ticker": "7203",
                    "risk_gate": {"ok_to_enter": True},
                    "trigger_signals": [{}],
                    "evidence_refs": [
                        {"id": "E1", "source_uri": "jpx-edinet://filing/1"}
                    ],
                    "weights": {"contributions": [], "normalized": False},
                    "explanation": {"body": "[E1] evidence", "language": language},
                    "catalyst_relevance": {"kind": "product"},
                    "score": {"rating": "A"},
                    "conviction": {"base": 80, "adjustments": [], "final": 80},
                    "entry_plan": {
                        "size_hint": {
                            "tier": "TIER_3",
                            "pct": 3.0,
                            "disclaimer_key": "size_hint_advisory",
                        }
                    },
                    "disclaimer_version": "v1",
                },
            }
        ],
        "disclaimer": {
            "version": "v1",
            "full_text": full_text,
            "language": language,
            "hash": disclaimer_hash,
        },
    }


class OutputLocaleTests(unittest.TestCase):
    def test_template_engine_uses_profile_language_and_localized_copy(self):
        expected_markers = {
            "zh-CN": ("综合评分", "优势维度", "信念调整", "风险提示", "仓位建议偏低"),
            "ja-JP": (
                "総合スコア",
                "強みのある次元",
                "確信度調整",
                "リスク注意",
                "ポジション目安",
            ),
            "ko-KR": (
                "종합 점수",
                "강점 차원",
                "확신도 조정",
                "위험 주의",
                "포지션 제안",
            ),
        }
        for profile, language in PROFILE_DEFAULT_OUTPUT_LANGUAGE.items():
            with self.subTest(profile=profile):
                rendered = TemplateEngine(SimpleNamespace(profile=profile)).render(
                    "7203", features(), [{"detail": "evidence"}]
                )
                self.assertEqual(rendered["language"], language)
                summary, strengths, adjustments, risk, low_size = expected_markers[
                    language
                ]
                for marker in (summary, strengths, adjustments):
                    self.assertIn(marker, rendered["body"])
                self.assertTrue(any(risk in caveat for caveat in rendered["caveats"]))
                self.assertTrue(
                    any(low_size in caveat for caveat in rendered["caveats"])
                )
                self.assertNotIn("?", rendered["headline"])
                self.assertNotIn("?", rendered["body"])

    def test_profile_language_registry_is_internally_consistent(self):
        self.assertEqual(
            set(PROFILE_DEFAULT_OUTPUT_LANGUAGE),
            set(PROFILE_ALLOWED_OUTPUT_LANGUAGES),
        )
        self.assertEqual(
            set(PROFILE_DEFAULT_OUTPUT_LANGUAGE),
            set(PROFILE_MARKET_SCOPES),
        )
        for profile, language in PROFILE_DEFAULT_OUTPUT_LANGUAGE.items():
            with self.subTest(profile=profile):
                self.assertIn(language, PROFILE_ALLOWED_OUTPUT_LANGUAGES[profile])

    def test_output_validator_enforces_profile_language_invariant(self):
        validator = OutputValidator()
        self.assertEqual(validator.validate(recommendation_list("ja-JP")), [])
        errors = OutputValidator().validate(recommendation_list("zh-CN"))
        self.assertIn(
            "items[0]: explanation.language is not allowed for japan_multibagger",
            errors,
        )

        for language in PROFILE_ALLOWED_OUTPUT_LANGUAGES["us_preferred"]:
            with self.subTest(profile="us_preferred", language=language):
                payload = recommendation_list(language)
                payload["profile"] = "us_preferred"
                payload["market_scope"] = "us"
                self.assertEqual(validator.validate(payload), [])

    def test_validator_rejects_missing_or_incompatible_output_locales(self):
        validator = OutputValidator()

        missing_language = recommendation_list("ja-JP")
        missing_language["items"][0]["recommendation"]["explanation"].pop("language")
        self.assertIn(
            "items[0]: explanation.language is not allowed for japan_multibagger",
            validator.validate(missing_language),
        )

        incompatible_disclaimer = recommendation_list("ja-JP")
        incompatible_disclaimer["disclaimer"]["language"] = "zh-CN"
        self.assertIn(
            "disclaimer.language is not allowed for japan_multibagger",
            validator.validate(incompatible_disclaimer),
        )

        unknown_profile = recommendation_list("ja-JP")
        unknown_profile["profile"] = "custom"
        self.assertIn(
            "profile has no authorized output language",
            validator.validate(unknown_profile),
        )


if __name__ == "__main__":
    unittest.main()
