from dataclasses import dataclass, field
from typing import Any

from ai.types import BAND_RATING_SEQUENCE, BAND_RATINGS


@dataclass
class PipelineContext:
    snapshot_id: str
    as_of: str
    config: Any

    signals: list = field(default_factory=list)
    universe: list = field(default_factory=list)
    scores: dict = field(default_factory=dict)
    candidates: list = field(default_factory=list)
    gated_candidates: list = field(default_factory=list)
    recommendations: list = field(default_factory=list)

    evidence_refs: dict = field(default_factory=dict)
    input_hashes: list = field(default_factory=list)

    def build_recommendation_list(self) -> dict:
        from ai.snapshot.fingerprint import compute_output_fingerprint

        items = [
            {
                "recommendation": rec,
                "rating_band": self._score_rating(rec),
            }
            for rec in self.recommendations
        ]

        items.sort(
            key=lambda x: (-x["recommendation"]["conviction"]["final"],
                           x["recommendation"]["ticker"])
        )

        output_fingerprint = compute_output_fingerprint(items)

        return {
            "snapshot_id": self.snapshot_id,
            "as_of": self.as_of,
            "profile": self.config.profile,
            "market_scope": self.config.market_scope,
            "items": items,
            "output_fingerprint": output_fingerprint,
            "disclaimer": None,
            "meta": {
                "strategy_version": self.config.strategy_version,
                "pipeline_version": self.config.pipeline_version,
                "generated_by": f"ai-gamma@{self.snapshot_id[:8]}",
                "generation_ms": 0,
            },
        }

    @staticmethod
    def _score_rating(recommendation: dict) -> str:
        score = recommendation.get("score")
        rating = score.get("rating") if isinstance(score, dict) else None
        if not isinstance(rating, str) or rating not in BAND_RATINGS:
            ticker = recommendation.get("ticker", "<unknown>")
            allowed = "|".join(BAND_RATING_SEQUENCE)
            raise RecommendationContractError(
                f"recommendation {ticker}: score.rating must be one of {allowed}"
            )
        return rating


class RecommendationContractError(ValueError):
    """Raised when a recommendation cannot be serialized per contract."""
