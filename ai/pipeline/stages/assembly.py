import uuid as _uuid


class AssemblyStage:
    """Stage F: assemble Recommendation objects with explanation + weights + evidence."""

    def execute(self, ctx):
        from ai.explanation.template_engine import TemplateEngine

        tmpl = TemplateEngine(ctx.config)

        for candidate in ctx.gated_candidates:
            features = candidate["features"]
            triggers = candidate["triggers"]

            weights = self._compute_weights(triggers, features)
            explanation = tmpl.render(candidate["ticker"], features, triggers)
            evidence = self._collect_evidence(candidate, ctx)

            rec = {
                "id": str(_uuid.uuid4()),
                "snapshot_id": ctx.snapshot_id,
                "ticker": candidate["ticker"],
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
                "disclaimer_version": ctx.config.disclaimer_hash[:8],
            }
            ctx.recommendations.append(rec)

        return ctx

    def _compute_weights(self, triggers, features):
        contributions = []
        total_abs = 0.0

        for t in triggers:
            delta = {"STRONG": 0.3, "MEDIUM": 0.2, "WEAK": 0.1}.get(t["strength"], 0.1)
            total_abs += abs(delta)
            contributions.append({
                "source_kind": "trigger",
                "source_ref": t["code"],
                "weight": delta,
            })

        for dim in features["score"].get("dims", []):
            delta = dim["weight"] * dim["score"] / 100.0 * 0.5
            total_abs += abs(delta)
            contributions.append({
                "source_kind": "score_dim",
                "source_ref": dim["key"],
                "weight": delta,
            })

        base_weight = max(total_abs, 1e-9)
        for c in contributions:
            c["weight"] = c["weight"] / base_weight

        return {"contributions": contributions, "normalized": True}

    def _collect_evidence(self, candidate, ctx):
        evidence = []
        idx = 1
        for t in candidate["triggers"]:
            if t.get("source_ref"):
                evidence.append({
                    "id": f"E{idx}",
                    "kind": "RULE",
                    "source_uri": f"ai-rule://{ctx.config.model_version}/{t['code']}@{ctx.config.pipeline_version}",
                    "as_of": ctx.as_of,
                    "hash": "",
                })
                idx += 1
        return evidence
