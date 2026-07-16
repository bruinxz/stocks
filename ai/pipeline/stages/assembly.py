import copy
import hashlib
import math
import uuid as _uuid


class AssemblyStage:
    """Stage F: assemble Recommendation objects with explanation + weights + evidence."""

    def execute(self, ctx):
        from ai.explanation.template_engine import TemplateEngine

        tmpl = TemplateEngine(ctx.config)

        for candidate in ctx.gated_candidates:
            features = candidate["features"]
            triggers = candidate["triggers"]
            ticker = candidate["ticker"]

            weights = self._compute_weights(triggers, features)
            explanation = tmpl.render(candidate["ticker"], features, triggers)
            evidence = self._collect_evidence(candidate, ctx)

            rec = {
                "id": ctx.recommendation_ids.get(ticker) or str(_uuid.uuid4()),
                "snapshot_id": ctx.snapshot_id,
                "ticker": ticker,
                "as_of": ctx.as_of,
                "score": features["score"],
                "conviction": features["conviction"],
                "risk_gate": features["risk_gate"],
                "entry_plan": features["entry_plan"],
                "catalyst_relevance": features.get("catalyst_relevance"),
                "trigger_signals": triggers,
                "weights": weights,
                "explanation": explanation,
                "evidence_refs": evidence,
                "model_version": ctx.config.model_version,
                "disclaimer_version": ctx.config.disclaimer["version"],
            }
            ctx.recommendations.append(rec)

        return ctx

    def _compute_weights(self, triggers, features):
        raw_contributions = []

        for t in triggers:
            raw_contribution = {
                "STRONG": 0.3,
                "MEDIUM": 0.2,
                "WEAK": 0.1,
            }.get(t["strength"], 0.1)
            raw_contributions.append({
                "source_kind": "trigger",
                "source_ref": t["code"],
                "raw_contribution": raw_contribution,
            })

        for dim in features["score"].get("dims", []):
            raw_contribution = dim["weight"] * dim["score"] / 100.0 * 0.5
            raw_contributions.append({
                "source_kind": "score_dim",
                "source_ref": dim["key"],
                "raw_contribution": raw_contribution,
            })

        return self._normalize_contributions(raw_contributions)

    @staticmethod
    def _normalize_contributions(raw_contributions):
        prepared = []
        denominator = 0.0

        for raw in raw_contributions:
            raw_input = raw["raw_contribution"]
            if isinstance(raw_input, bool):
                raise ValueError("raw contribution must be a finite number")

            raw_value = float(raw_input)
            if not math.isfinite(raw_value):
                raise ValueError("raw contribution must be a finite number")

            prepared.append((raw, raw_value))
            denominator += abs(raw_value)

        if not math.isfinite(denominator):
            raise ValueError("raw contribution L1 denominator must be finite")

        if denominator == 0.0:
            return {"contributions": [], "normalized": False}

        contributions = []
        for raw, raw_value in prepared:
            contribution = {
                key: value
                for key, value in raw.items()
                if key != "raw_contribution"
            }
            contribution["weight"] = raw_value / denominator
            contributions.append(contribution)

        return {"contributions": contributions, "normalized": True}

    def _collect_evidence(self, candidate, ctx):
        ticker = candidate["ticker"]
        evidence = [
            {"id": f"E{index}", **copy.deepcopy(ref)}
            for index, ref in enumerate(
                ctx.evidence_refs.get(ticker, ()), start=1
            )
        ]

        # Explanation markers are emitted for the first three triggers.  If a
        # ticker has fewer physical evidence records than markers, preserve the
        # source evidence and append an authenticated rule trace.  This is a
        # deterministic pipeline trace, not a synthetic market fact.
        required = min(3, len(candidate["triggers"]))
        for trigger in candidate["triggers"][len(evidence) : required]:
            rule_material = (
                f"{ctx.config.rule_bundle_hash}:{trigger['code']}:"
                f"{ctx.config.pipeline_version}"
            )
            evidence.append({
                "id": f"E{len(evidence) + 1}",
                "kind": "RULE",
                "source_uri": (
                    f"ai-rule://{ctx.config.model_version}/"
                    f"{trigger['code']}@{ctx.config.pipeline_version}"
                ),
                "as_of": ctx.as_of,
                "hash": hashlib.sha256(
                    rule_material.encode("utf-8")
                ).hexdigest(),
            })
        return evidence
