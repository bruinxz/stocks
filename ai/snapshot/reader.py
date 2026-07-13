from __future__ import annotations

import hashlib
import json
import uuid
from typing import Optional, Sequence

from ai.snapshot.fingerprint import (
    canonicalize_output_fingerprint_preimage,
    compute_output_fingerprint,
    jcs_canonicalize,
)
from ai.snapshot.store import SnapshotItemRow, SnapshotRow, SnapshotStore
from ai.snapshot.store import (
    PROFILE_MARKET_SCOPES,
    snapshot_envelope_mirror_errors,
    snapshot_row_integrity_errors,
)


class SnapshotReadError(RuntimeError):
    pass


class SnapshotNotFoundError(SnapshotReadError):
    pass


class SnapshotCorruptError(SnapshotReadError):
    pass


class SnapshotReader:
    """Read and integrity-check recommendation snapshots through an injected port."""

    def __init__(self, store: SnapshotStore):
        self._store = store

    def read_snapshot(self, snapshot_id: str) -> dict:
        snapshot = self._store.get_snapshot(snapshot_id)
        if snapshot is None:
            raise SnapshotNotFoundError(f"snapshot not found: {snapshot_id}")
        return self._hydrate(snapshot, self._store.get_items(snapshot_id))

    def read_latest(self, profile: str, market_scope: str) -> Optional[dict]:
        self._validate_profile_scope(profile, market_scope)
        snapshots = self._store.list_snapshots(
            profile=profile, market_scope=market_scope
        )
        if not snapshots:
            return None
        latest = max(
            snapshots, key=lambda row: (row.as_of_utc, row.snapshot_id)
        )
        return self._hydrate(latest, self._store.get_items(latest.snapshot_id))

    def read_by_date(
        self, trading_day: str, profile: str, market_scope: str
    ) -> list[dict]:
        self._validate_profile_scope(profile, market_scope)
        snapshots = self._store.list_snapshots(
            profile=profile,
            market_scope=market_scope,
            trading_day=trading_day,
        )
        ordered = sorted(
            snapshots,
            key=lambda row: (row.as_of_utc, row.snapshot_id),
            reverse=True,
        )
        return [
            self._hydrate(row, self._store.get_items(row.snapshot_id))
            for row in ordered
        ]

    def diff(self, snapshot_id_a: str, snapshot_id_b: str) -> dict:
        snap_a = self.read_snapshot(snapshot_id_a)
        snap_b = self.read_snapshot(snapshot_id_b)

        items_a = {
            entry["recommendation"]["ticker"]: jcs_canonicalize(
                entry["recommendation"]
            )
            for entry in snap_a["items"]
        }
        items_b = {
            entry["recommendation"]["ticker"]: jcs_canonicalize(
                entry["recommendation"]
            )
            for entry in snap_b["items"]
        }
        tickers_a = set(items_a)
        tickers_b = set(items_b)
        common = tickers_a & tickers_b

        return {
            "snapshot_id_a": snapshot_id_a,
            "snapshot_id_b": snapshot_id_b,
            "added": sorted(tickers_b - tickers_a),
            "removed": sorted(tickers_a - tickers_b),
            "changed": sorted(
                ticker for ticker in common if items_a[ticker] != items_b[ticker]
            ),
            "common": sorted(common),
            "fingerprint_match": (
                snap_a["output_fingerprint"] == snap_b["output_fingerprint"]
            ),
        }

    @classmethod
    def _hydrate(
        cls, snapshot: SnapshotRow, items: Sequence[SnapshotItemRow]
    ) -> dict:
        integrity_errors = snapshot_row_integrity_errors(snapshot)
        envelope_errors = snapshot_envelope_mirror_errors(snapshot)
        if integrity_errors or envelope_errors:
            raise SnapshotCorruptError(
                "snapshot scalar integrity mismatch: "
                + ", ".join((*integrity_errors, *envelope_errors))
            )
        if not isinstance(snapshot.envelope_json, dict):
            raise SnapshotCorruptError("invalid snapshot envelope JSON")
        try:
            envelope = json.loads(jcs_canonicalize(snapshot.envelope_json))
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise SnapshotCorruptError("invalid snapshot envelope JSON") from error
        if envelope.get("snapshot_id") != snapshot.snapshot_id:
            raise SnapshotCorruptError("snapshot envelope identity mismatch")
        if envelope.get("profile") != snapshot.profile or envelope.get(
            "market_scope"
        ) != snapshot.market_scope:
            raise SnapshotCorruptError("snapshot envelope profile/scope mismatch")
        if envelope.get("output_fingerprint") != snapshot.output_fingerprint:
            raise SnapshotCorruptError("snapshot output fingerprint mismatch")
        if envelope.get("as_of") != snapshot.as_of_utc:
            raise SnapshotCorruptError("snapshot envelope as_of mismatch")
        try:
            fingerprint_preimage_jcs = (
                canonicalize_output_fingerprint_preimage(envelope)
            )
        except (TypeError, ValueError) as error:
            raise SnapshotCorruptError(
                "snapshot fingerprint preimage invalid"
            ) from error
        if fingerprint_preimage_jcs != snapshot.fingerprint_preimage_jcs:
            raise SnapshotCorruptError(
                "snapshot fingerprint preimage mismatch"
            )
        if hashlib.sha256(
            fingerprint_preimage_jcs.encode("utf-8")
        ).hexdigest() != snapshot.output_fingerprint:
            raise SnapshotCorruptError(
                "snapshot fingerprint preimage hash mismatch"
            )
        envelope_items = envelope.get("items")
        if not isinstance(envelope_items, list):
            raise SnapshotCorruptError("snapshot envelope items missing")

        meta = envelope.get("meta")
        if not isinstance(meta, dict):
            raise SnapshotCorruptError("snapshot envelope meta missing")
        row_meta = {
            "contract_version": snapshot.contract_version,
            "profile_version": snapshot.profile_version,
            "pipeline_version": snapshot.pipeline_version,
            "strategy_version": snapshot.strategy_version,
            "input_fingerprint": snapshot.input_fingerprint,
        }
        if any(meta.get(key) != value for key, value in row_meta.items()):
            raise SnapshotCorruptError("snapshot envelope meta mismatch")

        disclaimer = envelope.get("disclaimer")
        if not isinstance(disclaimer, dict):
            raise SnapshotCorruptError("snapshot disclaimer missing")
        full_text = disclaimer.get("full_text")
        if not isinstance(full_text, str):
            raise SnapshotCorruptError("snapshot disclaimer full_text missing")
        computed_disclaimer_hash = hashlib.sha256(
            full_text.encode("utf-8")
        ).hexdigest()
        if (
            disclaimer.get("hash") != snapshot.disclaimer_hash
            or computed_disclaimer_hash != snapshot.disclaimer_hash
        ):
            raise SnapshotCorruptError("snapshot disclaimer hash mismatch")

        if len(items) != snapshot.item_count:
            raise SnapshotCorruptError("snapshot item count mismatch")
        ordered_items = sorted(items, key=lambda item: item.sort_rank)
        if [item.sort_rank for item in ordered_items] != list(
            range(snapshot.item_count)
        ):
            raise SnapshotCorruptError("snapshot item ranks must be contiguous")

        hydrated_items = []
        tickers: set[str] = set()
        item_ids: set[str] = set()
        for item in ordered_items:
            if item.snapshot_id != snapshot.snapshot_id:
                raise SnapshotCorruptError("item snapshot identity mismatch")
            try:
                parsed_item_id = uuid.UUID(item.item_id)
            except (AttributeError, TypeError, ValueError) as error:
                raise SnapshotCorruptError("item_id is not UUIDv4") from error
            if (
                parsed_item_id.version != 4
                or str(parsed_item_id) != item.item_id
                or item.item_id in item_ids
            ):
                raise SnapshotCorruptError("item_id is not unique canonical UUIDv4")
            item_ids.add(item.item_id)
            recommendation = item.recommendation_json
            if (
                not isinstance(recommendation, dict)
                or jcs_canonicalize(recommendation) != item.recommendation_jcs
            ):
                raise SnapshotCorruptError("recommendation is not canonical JCS")
            recommendation_hash = hashlib.sha256(
                item.recommendation_jcs.encode("utf-8")
            ).hexdigest()
            if recommendation_hash != item.recommendation_hash:
                raise SnapshotCorruptError("recommendation hash mismatch")
            if recommendation.get("ticker") != item.ticker:
                raise SnapshotCorruptError("recommendation ticker mismatch")
            if recommendation.get("id") != item.item_id:
                raise SnapshotCorruptError("recommendation item identity mismatch")
            if item.ticker in tickers:
                raise SnapshotCorruptError("duplicate recommendation ticker")
            tickers.add(item.ticker)
            if recommendation.get("snapshot_id") != snapshot.snapshot_id:
                raise SnapshotCorruptError("recommendation snapshot_id mismatch")
            if recommendation.get("score", {}).get("rating") != item.rating_band:
                raise SnapshotCorruptError("recommendation rating mirror mismatch")
            if recommendation.get("conviction", {}).get(
                "final"
            ) != item.conviction_final:
                raise SnapshotCorruptError("recommendation conviction mismatch")
            if (
                recommendation.get("risk_gate", {}).get("gate")
                != item.risk_gate_status
            ):
                raise SnapshotCorruptError("recommendation risk gate mismatch")
            size_hint = recommendation.get("entry_plan", {}).get("size_hint", {})
            if size_hint.get("tier") != item.size_hint_tier:
                raise SnapshotCorruptError("recommendation size hint mismatch")
            hydrated_items.append(
                {
                    "recommendation": recommendation,
                    "rating_band": item.rating_band,
                }
            )

        if jcs_canonicalize(envelope_items) != jcs_canonicalize(hydrated_items):
            raise SnapshotCorruptError("snapshot envelope/item row mismatch")
        envelope["items"] = hydrated_items
        try:
            computed_output_fingerprint = compute_output_fingerprint(envelope)
        except (TypeError, ValueError) as error:
            raise SnapshotCorruptError(
                "snapshot items are not JCS serializable"
            ) from error
        if computed_output_fingerprint != snapshot.output_fingerprint:
            raise SnapshotCorruptError("snapshot item fingerprint mismatch")
        return envelope

    @staticmethod
    def _validate_profile_scope(profile: str, market_scope: str) -> None:
        if (
            profile not in PROFILE_MARKET_SCOPES
            or market_scope not in PROFILE_MARKET_SCOPES[profile]
        ):
            raise SnapshotReadError(
                f"incompatible profile/market_scope: {profile}/{market_scope}"
            )
