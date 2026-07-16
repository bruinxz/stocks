from dataclasses import dataclass, field
import copy
import hashlib
import re
from typing import Any

from ai.types import BAND_RATING_SEQUENCE, BAND_RATINGS


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


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
    score_provenance: dict = field(default_factory=dict)
    recommendation_ids: dict = field(default_factory=dict)
    input_hashes: list = field(default_factory=list)

    def build_recommendation_list(self) -> dict:
        from ai.snapshot.fingerprint import (
            compute_input_fingerprint,
            compute_output_fingerprint,
        )

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

        contract_version = getattr(self.config, "contract_version", None)
        profile_version = getattr(self.config, "profile_version", None)
        disclaimer = getattr(self.config, "disclaimer", None)
        if contract_version != "0.3.1":
            raise RecommendationContractError(
                "config.contract_version must equal 0.3.1"
            )
        if not isinstance(profile_version, str) or not profile_version:
            raise RecommendationContractError(
                "config.profile_version must be non-empty"
            )
        if not isinstance(disclaimer, dict):
            raise RecommendationContractError(
                "config.disclaimer must be a complete object"
            )
        required_disclaimer = {
            "version",
            "short_text",
            "full_text",
            "language",
            "effective_at",
            "hash",
        }
        if not required_disclaimer.issubset(disclaimer):
            raise RecommendationContractError(
                "config.disclaimer missing required fields"
            )
        disclaimer_hash = getattr(self.config, "disclaimer_hash", None)
        if (
            not isinstance(disclaimer_hash, str)
            or not _SHA256_RE.fullmatch(disclaimer_hash)
            or disclaimer.get("hash") != disclaimer_hash
        ):
            raise RecommendationContractError(
                "config.disclaimer_hash must match disclaimer.hash"
            )
        full_text = disclaimer.get("full_text")
        if not isinstance(full_text, str) or hashlib.sha256(
            full_text.encode("utf-8")
        ).hexdigest() != disclaimer_hash:
            raise RecommendationContractError(
                "config.disclaimer_hash must authenticate disclaimer.full_text"
            )
        if not self.input_hashes or any(
            not isinstance(value, str) or not value
            for value in self.input_hashes
        ):
            raise RecommendationContractError(
                "context.input_hashes must be non-empty strings"
            )

        recommendation_list = {
            "snapshot_id": self.snapshot_id,
            "as_of": self.as_of,
            "profile": self.config.profile,
            "market_scope": self.config.market_scope,
            "items": items,
            "disclaimer": copy.deepcopy(disclaimer),
            "meta": {
                "contract_version": contract_version,
                "profile_version": profile_version,
                "input_fingerprint": compute_input_fingerprint(self.input_hashes),
                "strategy_version": self.config.strategy_version,
                "pipeline_version": self.config.pipeline_version,
                "generated_by": f"ai-gamma@{self.snapshot_id[:8]}",
                "generation_ms": 0,
            },
        }
        from ai.validation.output_validator import OutputValidator

        validation_errors = OutputValidator().validate(recommendation_list)
        if validation_errors:
            raise RecommendationContractError(
                "recommendation list failed validation before fingerprint: "
                + "; ".join(validation_errors)
            )
        recommendation_list["output_fingerprint"] = compute_output_fingerprint(
            recommendation_list
        )
        return recommendation_list

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
