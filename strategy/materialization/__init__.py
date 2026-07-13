"""Pure Strategy materializers."""

from strategy.materialization.multibagger_candidate import (
    CandidateIdempotencyConflict,
    CandidateMaterializationError,
    CandidateSnapshot,
    candidate_from_row,
    candidate_to_row,
    ClassificationDecision,
    ClassificationPolicy,
    LatestCatalyst,
    MaterializationInput,
    StrategyDecision,
    TextHitFact,
    UniverseFact,
    materialize_candidate,
    write_or_verify_candidate,
)
from strategy.materialization.postgres_candidate_store import PostgresCandidateStore

__all__ = [
    "CandidateIdempotencyConflict",
    "CandidateMaterializationError",
    "CandidateSnapshot",
    "candidate_from_row",
    "candidate_to_row",
    "ClassificationDecision",
    "ClassificationPolicy",
    "LatestCatalyst",
    "MaterializationInput",
    "StrategyDecision",
    "TextHitFact",
    "UniverseFact",
    "materialize_candidate",
    "write_or_verify_candidate",
    "PostgresCandidateStore",
]
