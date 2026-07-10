class SignalIntakeStage:
    """Stage A: read catalyst events + market data from DP tables (read-only)."""

    def execute(self, ctx):
        ctx.signals = []
        return ctx
