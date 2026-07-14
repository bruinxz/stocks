import hashlib
import math
import re

from ai.types import (
    BAND_RATING_SEQUENCE,
    BAND_RATINGS,
    PROFILE_ALLOWED_OUTPUT_LANGUAGES,
)


class OutputValidator:
    """Enforce output invariants per contracts/recommendation.md §8."""

    def validate(self, recommendation_list: dict) -> list[str]:
        errors = []
        items = recommendation_list.get("items", [])
        disclaimer = recommendation_list.get("disclaimer")
        profile = recommendation_list.get("profile")
        allowed_languages = PROFILE_ALLOWED_OUTPUT_LANGUAGES.get(profile)
        if allowed_languages is None:
            errors.append("profile has no authorized output language")

        if (
            disclaimer is not None
            and allowed_languages is not None
            and disclaimer.get("language") not in allowed_languages
        ):
            errors.append(f"disclaimer.language is not allowed for {profile}")

        for i, entry in enumerate(items):
            rec = entry["recommendation"]
            prefix = f"items[{i}]"

            explanation_language = rec.get("explanation", {}).get("language")
            if (
                allowed_languages is not None
                and explanation_language not in allowed_languages
            ):
                errors.append(
                    f"{prefix}: explanation.language is not allowed for {profile}"
                )

            if not rec["risk_gate"]["ok_to_enter"]:
                errors.append(f"{prefix}: risk_gate.ok_to_enter must be true")

            if len(rec["trigger_signals"]) < 1:
                errors.append(f"{prefix}: trigger_signals must have >= 1 entry")

            if len(rec["evidence_refs"]) < 1:
                errors.append(f"{prefix}: evidence_refs must have >= 1 entry")

            errors.extend(
                self._validate_weight_attribution(rec.get("weights"), prefix)
            )

            markers = set(re.findall(r'\[E(\d+)\]', rec["explanation"]["body"]))
            evidence_ids = {e["id"] for e in rec["evidence_refs"]}
            for m in markers:
                if f"E{m}" not in evidence_ids:
                    errors.append(f"{prefix}: [E{m}] has no matching evidence_ref")

            for e in rec["evidence_refs"]:
                if not self._is_canonical_uri(e["source_uri"]):
                    errors.append(f"{prefix}: invalid source_uri {e['source_uri']}")

            cr = rec.get("catalyst_relevance")
            if cr and cr["kind"] == "unclassified":
                errors.append(f"{prefix}: catalyst_relevance.kind must not be unclassified")

            score = rec.get("score")
            score_rating = score.get("rating") if isinstance(score, dict) else None
            rating_band = entry.get("rating_band")
            allowed_bands = "|".join(BAND_RATING_SEQUENCE)

            if not isinstance(score_rating, str) or score_rating not in BAND_RATINGS:
                errors.append(
                    f"{prefix}: score.rating must be one of {allowed_bands}"
                )
            if not isinstance(rating_band, str) or rating_band not in BAND_RATINGS:
                errors.append(
                    f"{prefix}: rating_band must be one of {allowed_bands}"
                )
            if rating_band != score_rating:
                errors.append(f"{prefix}: rating_band != score.rating")

            conv = rec["conviction"]
            expected_final = max(0, min(100, conv["base"] + sum(a["delta"] for a in conv["adjustments"])))
            if abs(conv["final"] - expected_final) > 0.01:
                errors.append(f"{prefix}: conviction.final mismatch")

            sh = rec["entry_plan"]["size_hint"]
            tier_pct = {"TIER_5": 5.0, "TIER_3": 3.0, "TIER_2": 2.0, "TIER_1": 1.0, "SKIP": 0.0}
            expected_pct = tier_pct.get(sh["tier"])
            if expected_pct is not None and sh["pct"] != expected_pct:
                errors.append(f"{prefix}: size_hint.pct {sh['pct']} != tier map {expected_pct}")

            if sh["disclaimer_key"] != "size_hint_advisory":
                errors.append(f"{prefix}: disclaimer_key must be 'size_hint_advisory'")

        if disclaimer:
            expected_hash = hashlib.sha256(disclaimer["full_text"].encode()).hexdigest()
            if disclaimer["hash"] != expected_hash:
                errors.append("disclaimer.hash mismatch")

            for i, entry in enumerate(items):
                if entry["recommendation"]["disclaimer_version"] != disclaimer["version"]:
                    errors.append(f"items[{i}]: disclaimer_version mismatch")

        for i in range(1, len(items)):
            prev = items[i - 1]["recommendation"]
            curr = items[i]["recommendation"]
            if prev["conviction"]["final"] < curr["conviction"]["final"]:
                errors.append(f"items[{i}]: sort order violation (conviction.final)")
            elif prev["conviction"]["final"] == curr["conviction"]["final"]:
                if prev["ticker"] > curr["ticker"]:
                    errors.append(f"items[{i}]: sort order violation (ticker)")

        return errors

    def _is_canonical_uri(self, uri: str) -> bool:
        from ai.types import CANONICAL_URI_PREFIXES
        return any(uri.startswith(p) for p in CANONICAL_URI_PREFIXES)

    def _validate_weight_attribution(self, attribution, prefix: str) -> list[str]:
        errors = []
        if not isinstance(attribution, dict):
            return [f"{prefix}: weights must be an object"]

        contributions = attribution.get("contributions")
        normalized = attribution.get("normalized")

        if not isinstance(contributions, list):
            return [f"{prefix}: weights.contributions must be an array"]

        if not contributions:
            if normalized is not False:
                errors.append(
                    f"{prefix}: empty contributions require normalized=false"
                )
            return errors

        if normalized is not True:
            errors.append(
                f"{prefix}: non-empty contributions require normalized=true"
            )

        weights = []
        for index, contribution in enumerate(contributions):
            weight = (
                contribution.get("weight")
                if isinstance(contribution, dict)
                else None
            )
            if (
                isinstance(weight, bool)
                or not isinstance(weight, (int, float))
                or not math.isfinite(weight)
            ):
                errors.append(
                    f"{prefix}: contributions[{index}].weight must be finite"
                )
                continue
            weights.append(float(weight))

        if len(weights) != len(contributions):
            return errors

        l1_sum = sum(abs(weight) for weight in weights)
        if abs(l1_sum - 1.0) > 1e-6:
            errors.append(
                f"{prefix}: contribution L1 sum {l1_sum} != 1.0"
            )

        return errors
