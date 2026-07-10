import hashlib
import re


class OutputValidator:
    """Enforce 14 output invariants per contracts/recommendation.md §8."""

    def validate(self, recommendation_list: dict) -> list[str]:
        errors = []
        items = recommendation_list.get("items", [])
        disclaimer = recommendation_list.get("disclaimer")

        for i, entry in enumerate(items):
            rec = entry["recommendation"]
            prefix = f"items[{i}]"

            if not rec["risk_gate"]["ok_to_enter"]:
                errors.append(f"{prefix}: risk_gate.ok_to_enter must be true")

            if len(rec["trigger_signals"]) < 1:
                errors.append(f"{prefix}: trigger_signals must have >= 1 entry")

            if len(rec["evidence_refs"]) < 1:
                errors.append(f"{prefix}: evidence_refs must have >= 1 entry")

            weight_sum = sum(c["weight"] for c in rec["weights"]["contributions"])
            if abs(weight_sum - 1.0) > 1e-6:
                errors.append(f"{prefix}: weight sum {weight_sum} != 1.0")

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

            if entry["rating_band"] != rec["score"]["band"]:
                errors.append(f"{prefix}: rating_band != score.band")

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
