from __future__ import annotations

import hashlib
import json
import math
import re
import uuid
from dataclasses import dataclass
from typing import Optional, Sequence

from ai.snapshot.fingerprint import (
    compute_input_fingerprint,
    compute_output_fingerprint,
    jcs_canonicalize,
)
from ai.snapshot.store import (
    SnapshotItemRow,
    SnapshotRow,
    SnapshotStore,
)


CONTRACT_VERSION = "0.3.1"
PROFILE_MARKET_SCOPES = {
    "us_preferred": frozenset({"us", "cn_a"}),
    "multibagger": frozenset({"us", "cn_a"}),
    "japan_blue_chip": frozenset({"jp"}),
    "japan_multibagger": frozenset({"jp"}),
    "korea_semiconductor_chain": frozenset({"kr"}),
    "korea_multibagger": frozenset({"kr"}),
}
RISK_GATES = frozenset({"GREEN", "YELLOW", "RED"})
SIZE_HINT_TIERS = frozenset(
    {"TIER_5", "TIER_3", "TIER_2", "TIER_1", "SKIP"}
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TRADING_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SnapshotPersistenceError(RuntimeError):
    """Base class for fail-closed persistence errors."""


class SnapshotStoreNotConfiguredError(SnapshotPersistenceError):
    pass


class SnapshotContractError(SnapshotPersistenceError):
    pass


class SnapshotIdempotencyConflictError(SnapshotPersistenceError):
    pass


@dataclass(frozen=True)
class SnapshotWriteResult:
    snapshot_id: str
    idempotency_key: str
    created: bool


class SnapshotWriter:
    """Atomically persist a v0.3.1 recommendation list through an injected port."""

    def __init__(self, store: Optional[SnapshotStore] = None):
        self._store = store

    def write(self, ctx, recommendation_list: dict) -> SnapshotWriteResult:
        if self._store is None:
            raise SnapshotStoreNotConfiguredError(
                "SnapshotWriter requires an injected SnapshotStore"
            )

        snapshot, items = self._build_rows(ctx, recommendation_list)

        with self._store.transaction() as transaction:
            existing = transaction.find_snapshot_by_idempotency_key(
                snapshot.idempotency_key
            )
            if existing is not None:
                existing_items = transaction.get_items(existing.snapshot_id)
                if not self._same_payload(existing, existing_items, snapshot, items):
                    raise SnapshotIdempotencyConflictError(
                        "identical replay pins produced different snapshot payload"
                    )
                return SnapshotWriteResult(
                    snapshot_id=existing.snapshot_id,
                    idempotency_key=existing.idempotency_key,
                    created=False,
                )

            transaction.insert_snapshot(snapshot)
            transaction.insert_items(items)

        return SnapshotWriteResult(
            snapshot_id=snapshot.snapshot_id,
            idempotency_key=snapshot.idempotency_key,
            created=True,
        )

    def _build_rows(
        self, ctx, recommendation_list: dict
    ) -> tuple[SnapshotRow, tuple[SnapshotItemRow, ...]]:
        self._validate_envelope(ctx, recommendation_list)

        input_fingerprint = compute_input_fingerprint(ctx.input_hashes)
        meta = recommendation_list["meta"]
        disclaimer = recommendation_list["disclaimer"]

        envelope = dict(recommendation_list)
        entries = recommendation_list["items"]
        try:
            envelope_json = jcs_canonicalize(envelope)
        except (TypeError, ValueError) as error:
            raise SnapshotContractError(
                "recommendation envelope must be JCS serializable"
            ) from error

        idempotency_material = {
            "as_of": recommendation_list["as_of"],
            "trading_day": ctx.config.trading_day,
            "profile": recommendation_list["profile"],
            "market_scope": recommendation_list["market_scope"],
            "contract_version": meta["contract_version"],
            "profile_version": meta["profile_version"],
            "pipeline_version": meta["pipeline_version"],
            "model_version": ctx.config.model_version,
            "strategy_version": meta["strategy_version"],
            "rule_bundle_hash": ctx.config.rule_bundle_hash,
            "template_hash": ctx.config.template_hash,
            "disclaimer_hash": disclaimer["hash"],
            "input_fingerprint": input_fingerprint,
        }
        try:
            idempotency_json = jcs_canonicalize(idempotency_material)
        except (TypeError, ValueError) as error:
            raise SnapshotContractError(
                "idempotency pins must be JCS serializable"
            ) from error
        idempotency_key = hashlib.sha256(
            idempotency_json.encode("utf-8")
        ).hexdigest()

        snapshot = SnapshotRow(
            snapshot_id=recommendation_list["snapshot_id"],
            as_of_utc=recommendation_list["as_of"],
            trading_day=ctx.config.trading_day,
            profile=recommendation_list["profile"],
            market_scope=recommendation_list["market_scope"],
            contract_version=meta["contract_version"],
            profile_version=meta["profile_version"],
            pipeline_version=meta["pipeline_version"],
            model_version=ctx.config.model_version,
            strategy_version=meta["strategy_version"],
            rule_bundle_hash=ctx.config.rule_bundle_hash,
            template_hash=ctx.config.template_hash,
            disclaimer_hash=disclaimer["hash"],
            input_fingerprint=input_fingerprint,
            output_fingerprint=recommendation_list["output_fingerprint"],
            idempotency_key=idempotency_key,
            item_count=len(entries),
            envelope_json=json.loads(envelope_json),
        )

        item_rows = tuple(
            self._build_item_row(snapshot.snapshot_id, rank, entry)
            for rank, entry in enumerate(entries)
        )
        return snapshot, item_rows

    @staticmethod
    def _build_item_row(
        snapshot_id: str, sort_rank: int, entry: dict
    ) -> SnapshotItemRow:
        recommendation = entry["recommendation"]
        size_hint = recommendation["entry_plan"]["size_hint"]
        try:
            recommendation_json = jcs_canonicalize(recommendation)
        except (TypeError, ValueError) as error:
            raise SnapshotContractError(
                f"{recommendation.get('ticker', '<unknown>')}: "
                "recommendation must be JCS serializable"
            ) from error
        recommendation_hash = hashlib.sha256(
            recommendation_json.encode("utf-8")
        ).hexdigest()
        return SnapshotItemRow(
            item_id=recommendation["id"],
            snapshot_id=snapshot_id,
            ticker=recommendation["ticker"],
            sort_rank=sort_rank,
            recommendation_json=recommendation,
            recommendation_jcs=recommendation_json,
            recommendation_hash=recommendation_hash,
            rating_band=entry["rating_band"],
            conviction_final=float(recommendation["conviction"]["final"]),
            risk_gate=recommendation["risk_gate"]["gate"],
            size_hint_tier=size_hint["tier"],
        )

    @classmethod
    def _validate_envelope(cls, ctx, recommendation_list: dict) -> None:
        if not isinstance(recommendation_list, dict):
            raise SnapshotContractError("recommendation list must be an object")

        required = {
            "snapshot_id",
            "as_of",
            "profile",
            "market_scope",
            "items",
            "output_fingerprint",
            "disclaimer",
            "meta",
        }
        missing = sorted(required - recommendation_list.keys())
        if missing:
            raise SnapshotContractError(
                f"recommendation list missing fields: {', '.join(missing)}"
            )

        profile = recommendation_list["profile"]
        market_scope = recommendation_list["market_scope"]
        if (
            profile not in PROFILE_MARKET_SCOPES
            or market_scope not in PROFILE_MARKET_SCOPES[profile]
        ):
            raise SnapshotContractError(
                f"incompatible profile/market_scope: {profile}/{market_scope}"
            )
        if profile != ctx.config.profile or market_scope != ctx.config.market_scope:
            raise SnapshotContractError("context/list profile or market_scope mismatch")
        if recommendation_list["snapshot_id"] != ctx.snapshot_id:
            raise SnapshotContractError("context/list snapshot_id mismatch")
        cls._require_uuidv4(recommendation_list["snapshot_id"], "snapshot_id")
        if recommendation_list["as_of"] != ctx.as_of:
            raise SnapshotContractError("context/list as_of mismatch")
        if not _TRADING_DAY_RE.fullmatch(ctx.config.trading_day):
            raise SnapshotContractError("trading_day must be YYYY-MM-DD")

        items = recommendation_list["items"]
        if not isinstance(items, list):
            raise SnapshotContractError("items must be an array")
        tickers: set[str] = set()
        recommendation_ids: set[str] = set()
        for entry in items:
            cls._validate_item(
                entry,
                snapshot_id=ctx.snapshot_id,
                profile=profile,
                market_scope=market_scope,
                tickers=tickers,
                recommendation_ids=recommendation_ids,
            )

        meta = recommendation_list["meta"]
        if not isinstance(meta, dict):
            raise SnapshotContractError("meta must be an object")
        required_meta = {
            "contract_version",
            "profile_version",
            "input_fingerprint",
            "strategy_version",
            "pipeline_version",
            "generated_by",
            "generation_ms",
        }
        missing_meta = sorted(required_meta - meta.keys())
        if missing_meta:
            raise SnapshotContractError(
                f"meta missing fields: {', '.join(missing_meta)}"
            )
        if meta["contract_version"] != CONTRACT_VERSION:
            raise SnapshotContractError("contract_version must be 0.3.1")
        for field in (
            "profile_version",
            "strategy_version",
            "pipeline_version",
            "generated_by",
        ):
            if not isinstance(meta[field], str) or not meta[field]:
                raise SnapshotContractError(f"meta.{field} must be non-empty")
        generation_ms = meta["generation_ms"]
        if (
            isinstance(generation_ms, bool)
            or not isinstance(generation_ms, int)
            or generation_ms < 0
        ):
            raise SnapshotContractError("meta.generation_ms must be a non-negative int")
        if meta["strategy_version"] != ctx.config.strategy_version:
            raise SnapshotContractError("strategy_version context/list mismatch")
        if meta["pipeline_version"] != ctx.config.pipeline_version:
            raise SnapshotContractError("pipeline_version context/list mismatch")
        expected_input_fingerprint = compute_input_fingerprint(ctx.input_hashes)
        if meta["input_fingerprint"] != expected_input_fingerprint:
            raise SnapshotContractError("input_fingerprint context/list mismatch")
        cls._require_sha256(meta["input_fingerprint"], "meta.input_fingerprint")
        cls._require_sha256(
            recommendation_list["output_fingerprint"], "output_fingerprint"
        )
        try:
            expected_output_fingerprint = compute_output_fingerprint(items)
        except (TypeError, ValueError) as error:
            raise SnapshotContractError(
                "items must be JCS serializable with finite numbers"
            ) from error
        if recommendation_list["output_fingerprint"] != expected_output_fingerprint:
            raise SnapshotContractError("output_fingerprint does not match items")

        disclaimer = recommendation_list["disclaimer"]
        if not isinstance(disclaimer, dict):
            raise SnapshotContractError("disclaimer must be an object")
        for field in (
            "version",
            "short_text",
            "full_text",
            "language",
            "effective_at",
            "hash",
        ):
            if field not in disclaimer:
                raise SnapshotContractError(f"disclaimer.{field} is required")
        cls._require_sha256(disclaimer["hash"], "disclaimer.hash")
        expected_disclaimer_hash = hashlib.sha256(
            disclaimer["full_text"].encode("utf-8")
        ).hexdigest()
        if disclaimer["hash"] != expected_disclaimer_hash:
            raise SnapshotContractError(
                "disclaimer.hash does not match disclaimer.full_text"
            )
        if disclaimer["hash"] != ctx.config.disclaimer_hash:
            raise SnapshotContractError("disclaimer hash context/list mismatch")
        disclaimer_version = disclaimer["version"]
        for entry in items:
            recommendation = entry["recommendation"]
            if recommendation.get("disclaimer_version") != disclaimer_version:
                ticker = recommendation.get("ticker", "<unknown>")
                raise SnapshotContractError(
                    f"{ticker}: disclaimer_version does not match list disclaimer"
                )

        for field in (
            "model_version",
            "rule_bundle_hash",
            "template_hash",
        ):
            value = getattr(ctx.config, field, None)
            if not isinstance(value, str) or not value:
                raise SnapshotContractError(f"context config {field} is required")
        cls._require_sha256(ctx.config.rule_bundle_hash, "rule_bundle_hash")
        cls._require_sha256(ctx.config.template_hash, "template_hash")

    @classmethod
    def _validate_item(
        cls,
        entry: dict,
        *,
        snapshot_id: str,
        profile: str,
        market_scope: str,
        tickers: set[str],
        recommendation_ids: set[str],
    ) -> None:
        if not isinstance(entry, dict) or not isinstance(
            entry.get("recommendation"), dict
        ):
            raise SnapshotContractError("each item requires a recommendation object")
        recommendation = entry["recommendation"]
        ticker = recommendation.get("ticker")
        if not isinstance(ticker, str) or not ticker:
            raise SnapshotContractError("recommendation ticker must be non-empty")
        if ticker in tickers:
            raise SnapshotContractError(f"duplicate ticker: {ticker}")
        tickers.add(ticker)
        recommendation_id = recommendation.get("id")
        cls._require_uuidv4(recommendation_id, f"{ticker}: recommendation.id")
        if recommendation_id in recommendation_ids:
            raise SnapshotContractError(
                f"duplicate recommendation id: {recommendation_id}"
            )
        recommendation_ids.add(recommendation_id)
        if recommendation.get("snapshot_id") != snapshot_id:
            raise SnapshotContractError(f"{ticker}: snapshot_id mismatch")

        score = recommendation.get("score")
        if not isinstance(score, dict):
            raise SnapshotContractError(f"{ticker}: score object is required")
        if score.get("profile") != profile or score.get("market_scope") != market_scope:
            raise SnapshotContractError(f"{ticker}: score profile/scope mismatch")
        if entry.get("rating_band") != score.get("rating"):
            raise SnapshotContractError(f"{ticker}: rating_band mirror mismatch")

        conviction = recommendation.get("conviction")
        risk_gate = recommendation.get("risk_gate")
        entry_plan = recommendation.get("entry_plan")
        if not isinstance(conviction, dict) or not cls._is_finite_number(
            conviction.get("final")
        ):
            raise SnapshotContractError(f"{ticker}: conviction.final is required")
        if (
            not isinstance(risk_gate, dict)
            or risk_gate.get("ok_to_enter") is not True
            or risk_gate.get("gate") != "GREEN"
        ):
            raise SnapshotContractError(f"{ticker}: risk gate must allow entry")
        if not isinstance(entry_plan, dict) or not isinstance(
            entry_plan.get("size_hint"), dict
        ):
            raise SnapshotContractError(f"{ticker}: entry_plan.size_hint is required")
        size_hint = entry_plan["size_hint"]
        if (
            size_hint.get("tier") not in SIZE_HINT_TIERS
            or not cls._is_finite_number(size_hint.get("pct"))
        ):
            raise SnapshotContractError(f"{ticker}: invalid size hint")

    @staticmethod
    def _require_sha256(value, field: str) -> None:
        if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
            raise SnapshotContractError(f"{field} must be lowercase SHA-256")

    @staticmethod
    def _require_uuidv4(value, field: str) -> None:
        try:
            parsed = uuid.UUID(value)
        except (AttributeError, TypeError, ValueError) as error:
            raise SnapshotContractError(f"{field} must be UUIDv4") from error
        if parsed.version != 4 or str(parsed) != value:
            raise SnapshotContractError(f"{field} must be canonical UUIDv4")

    @staticmethod
    def _is_finite_number(value) -> bool:
        return (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
        )

    @staticmethod
    def _same_payload(
        existing: SnapshotRow,
        existing_items: Sequence[SnapshotItemRow],
        proposed: SnapshotRow,
        proposed_items: Sequence[SnapshotItemRow],
    ) -> bool:
        comparable_existing = (
            existing.output_fingerprint,
            existing.item_count,
            SnapshotWriter._semantic_envelope_json(existing.envelope_json),
        )
        comparable_proposed = (
            proposed.output_fingerprint,
            proposed.item_count,
            SnapshotWriter._semantic_envelope_json(proposed.envelope_json),
        )
        if comparable_existing != comparable_proposed:
            return False

        def item_payload(item: SnapshotItemRow) -> tuple:
            return (
                item.ticker,
                item.sort_rank,
                item.recommendation_jcs,
                item.recommendation_hash,
                item.rating_band,
                item.conviction_final,
                item.risk_gate,
                item.size_hint_tier,
            )

        return tuple(map(item_payload, existing_items)) == tuple(
            map(item_payload, proposed_items)
        )

    @staticmethod
    def _semantic_envelope_json(envelope_json: dict) -> str:
        if not isinstance(envelope_json, dict):
            raise SnapshotIdempotencyConflictError(
                "stored snapshot envelope is invalid"
            )
        envelope = envelope_json
        meta = envelope.get("meta")
        if not isinstance(meta, dict):
            raise SnapshotIdempotencyConflictError(
                "stored snapshot envelope meta is invalid"
            )
        semantic_meta = dict(meta)
        semantic_meta.pop("generation_ms", None)
        semantic_meta.pop("generated_by", None)
        semantic_envelope = dict(envelope)
        semantic_envelope["meta"] = semantic_meta
        try:
            return jcs_canonicalize(semantic_envelope)
        except (TypeError, ValueError) as error:
            raise SnapshotIdempotencyConflictError(
                "stored snapshot envelope is not canonicalizable"
            ) from error
