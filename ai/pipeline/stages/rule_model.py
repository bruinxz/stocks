class RuleModelStage:
    """Stage D: apply rules/model to produce candidate set with trigger signals."""

    def execute(self, ctx):
        from ai.rules.engine import RuleEngine

        engine = RuleEngine(ctx.config.model_version)

        for ticker in ctx.universe:
            features = ctx.scores.get(ticker)
            if not features:
                continue

            triggers = engine.evaluate(ticker, features, ctx.signals)
            if triggers:
                ctx.candidates.append({
                    "ticker": ticker,
                    "features": features,
                    "triggers": triggers,
                })

        return ctx
