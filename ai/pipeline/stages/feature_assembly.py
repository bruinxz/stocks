class FeatureAssemblyStage:
    """Stage C: fetch Strategy scores for universe (read-only from scoring contract)."""

    def execute(self, ctx):
        ctx.scores = {}
        return ctx
