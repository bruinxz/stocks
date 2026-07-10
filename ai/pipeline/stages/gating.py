class GatingStage:
    """Stage E: filter by RiskGate.ok_to_enter == true + unclassified rejection."""

    def execute(self, ctx):
        for candidate in ctx.candidates:
            features = candidate["features"]

            if not features["risk_gate"]["ok_to_enter"]:
                continue

            catalyst_rel = features.get("catalyst_relevance")
            if catalyst_rel and catalyst_rel["kind"] == "unclassified":
                continue

            ctx.gated_candidates.append(candidate)

        return ctx
