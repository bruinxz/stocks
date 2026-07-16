"""Cross-adapter replay infrastructure failures with retry semantics."""


class ReplayInfrastructureError(RuntimeError):
    """Transient/configurable infrastructure failure; never terminalize a job."""


class ReplayRetryableInterruptionError(BaseException):
    """Abort the current worker while leaving its durable lease recoverable."""
