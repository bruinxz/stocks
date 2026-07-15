"""Assemble complete Strategy-owned recommendation objects from typed facts."""

from __future__ import annotations

import copy
import hashlib
import re
import uuid

from ai.pipeline.context import RecommendationContractError
from ai.snapshot.fingerprint import jcs_canonicalize


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PROVENANCE_KEYS = frozenset(
    {"fact_hash", "source_version", "available_at_utc"}
)


class FeatureAssemblyStage:
    """Stage C: bind authenticated source features to canonical score identity.

    Replay source records intentionally carry Strategy values without output
    storage identities.  This stage derives those identities only from the
    authenticated physical fact and pinned context, while copying all market
    dependent values (including EntryPlan prices) from that fact verbatim.
    """

    def execute(self, ctx):
        assembled = {}
        for ticker in ctx.universe:
            source = ctx.scores.get(ticker)
            if source is None:
                continue
            provenance = ctx.score_provenance.get(ticker)
            self._validate_provenance(ticker, provenance)
            assembled[ticker] = self._assemble(
                ctx,
                ticker,
                copy.deepcopy(source),
                provenance,
            )
        ctx.scores = assembled
        return ctx

    @classmethod
    def _assemble(cls, ctx, ticker, source, provenance):
        try:
            source_score = source["score"]
            source_conviction = source["conviction"]
            source_risk_gate = source["risk_gate"]
            source_entry_plan = source["entry_plan"]
        except (KeyError, TypeError) as error:
            raise RecommendationContractError(
                f"{ticker}: authenticated score features are incomplete"
            ) from error

        score_body = copy.deepcopy(source_score)
        scoring_id = cls._stable_uuid4(
            "strategy-score",
            provenance["fact_hash"],
            provenance["source_version"],
            provenance["available_at_utc"],
        )
        snapshot_hash = hashlib.sha256(
            jcs_canonicalize(score_body).encode("utf-8")
        ).hexdigest()
        score = {
            "scoring_id": scoring_id,
            "snapshot_hash": snapshot_hash,
            **score_body,
        }
        score_ref = {
            "scoring_id": scoring_id,
            "snapshot_hash": snapshot_hash,
        }

        conviction = {
            "ticker": ticker,
            "as_of": ctx.as_of,
            "base": source_conviction["base"],
            "score_ref": copy.deepcopy(score_ref),
            "adjustments": copy.deepcopy(source_conviction["adjustments"]),
            "final": source_conviction["final"],
            "level": source_conviction["level"],
        }
        risk_gate = {
            "ticker": ticker,
            "evaluated_at": ctx.as_of,
            "gate": source_risk_gate["gate"],
            "triggers": copy.deepcopy(source_risk_gate["triggers"]),
            "ok_to_enter": source_risk_gate["ok_to_enter"],
        }
        source_size_hint = source_entry_plan["size_hint"]
        entry_plan = {
            "ticker": ticker,
            "generated_at": ctx.as_of,
            "entry": copy.deepcopy(source_entry_plan["entry"]),
            "stop": copy.deepcopy(source_entry_plan["stop"]),
            "targets": copy.deepcopy(source_entry_plan["targets"]),
            "size_hint": copy.deepcopy(source_size_hint),
            "time_horizon": source_entry_plan["time_horizon"],
            "invalidation": source_entry_plan["invalidation"],
            "conviction_ref": source_conviction["final"],
            "score_ref": copy.deepcopy(score_ref),
        }

        result = {
            "score": score,
            "conviction": conviction,
            "risk_gate": risk_gate,
            "entry_plan": entry_plan,
            # Rule-only, fact-bound metric.  It is deliberately outside the
            # final EntryPlan so the persisted v0.3.1 object has exact keys.
            "entry_plan_metrics": {
                "stop_distance_pct": source_entry_plan["stop_distance_pct"]
            },
        }
        if "catalyst_relevance" in source:
            result["catalyst_relevance"] = copy.deepcopy(
                source["catalyst_relevance"]
            )
        return result

    @staticmethod
    def _validate_provenance(ticker, provenance):
        if not isinstance(provenance, dict) or set(provenance) != set(
            _PROVENANCE_KEYS
        ):
            raise RecommendationContractError(
                f"{ticker}: authenticated score provenance is missing"
            )
        if not isinstance(provenance["fact_hash"], str) or not _SHA256_RE.fullmatch(
            provenance["fact_hash"]
        ):
            raise RecommendationContractError(
                f"{ticker}: score provenance fact_hash is invalid"
            )
        for key in ("source_version", "available_at_utc"):
            if not isinstance(provenance[key], str) or not provenance[key]:
                raise RecommendationContractError(
                    f"{ticker}: score provenance {key} is invalid"
                )

    @staticmethod
    def _stable_uuid4(*material: str) -> str:
        digest = bytearray(
            hashlib.sha256(
                jcs_canonicalize(list(material)).encode("utf-8")
            ).digest()[:16]
        )
        digest[6] = (digest[6] & 0x0F) | 0x40
        digest[8] = (digest[8] & 0x3F) | 0x80
        return str(uuid.UUID(bytes=bytes(digest)))
