"""Authenticated replay inputs adapted into the real recommendation pipeline."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import re
from typing import Any
from urllib.parse import quote
import uuid

from ai.pipeline.runner import (
    PipelineConfig,
    PipelineRunner,
    PipelineSourceInputs,
)
from ai.replay.runtime import typed_score_fact_hash, validate_source_score_features
from ai.replay.fingerprint import (
    compute_replay_input_fingerprint,
    replay_input_manifest_hashes,
)
from ai.replay.postgres_repository import (
    filing_envelope_from_json,
    text_hit_envelope_from_json,
)
from ai.replay.service import (
    ReplayPipelineError,
    ReplayService,
    ReplaySourceError,
)
from ai.replay.types import ReplayInputs, ReplayPins, ReplayResult
from ai.rules.engine import RuleEngine
from ai.snapshot.fingerprint import jcs_canonicalize
from ai.snapshot.postgres_store import PostgresSnapshotStore
from ai.snapshot.reader import SnapshotReader
from ai.snapshot.writer import SnapshotWriter
from ai.types import PROFILE_DEFAULT_OUTPUT_LANGUAGE


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


@dataclass(frozen=True)
class ReplayPipelinePolicy:
    """Non-source pipeline assets pinned by the deployment."""

    model_version: str
    template_hash: str
    disclaimers: Mapping[str, Mapping[str, Any]]

    def validated_disclaimer(self, profile: str) -> dict[str, Any]:
        if not isinstance(self.model_version, str) or not _SEMVER_RE.fullmatch(
            self.model_version
        ):
            raise ReplayPipelineError("model_version must be SemVer")
        if not isinstance(self.template_hash, str) or not _SHA256_RE.fullmatch(
            self.template_hash
        ):
            raise ReplayPipelineError("template_hash must be lowercase SHA-256")
        if not isinstance(self.disclaimers, Mapping):
            raise ReplayPipelineError("disclaimers must be an object")
        required_languages = set(PROFILE_DEFAULT_OUTPUT_LANGUAGE.values())
        if set(self.disclaimers) != required_languages:
            raise ReplayPipelineError("disclaimer locale keys are not exact")
        language = PROFILE_DEFAULT_OUTPUT_LANGUAGE.get(profile)
        if language is None:
            raise ReplayPipelineError("profile has no default output language")
        disclaimer = self.disclaimers.get(language)
        if not isinstance(disclaimer, Mapping):
            raise ReplayPipelineError("disclaimer must be an object")
        required = {
            "version",
            "short_text",
            "full_text",
            "language",
            "effective_at",
            "hash",
        }
        if set(disclaimer) != required:
            raise ReplayPipelineError("disclaimer keys are not exact")
        full_text = disclaimer.get("full_text")
        digest = disclaimer.get("hash")
        if (
            not isinstance(full_text, str)
            or not full_text
            or not isinstance(digest, str)
            or not _SHA256_RE.fullmatch(digest)
            or hashlib.sha256(full_text.encode("utf-8")).hexdigest() != digest
        ):
            raise ReplayPipelineError("disclaimer hash is not authentic")
        for field in (
            "version",
            "short_text",
            "language",
            "effective_at",
        ):
            if not isinstance(disclaimer.get(field), str) or not disclaimer[field]:
                raise ReplayPipelineError(f"disclaimer.{field} is required")
        if disclaimer["language"] != language:
            raise ReplayPipelineError("disclaimer language does not match locale key")
        return copy.deepcopy(dict(disclaimer))


class _PersistedSnapshotVerifier:
    """Read back and authenticate persistence before PipelineRunner publishes."""

    def __init__(self, store: PostgresSnapshotStore, pins: ReplayPins) -> None:
        self._store = store
        self._pins = pins
        self.persisted = None
        self.verified_envelope = None

    def __call__(self, _ctx, attempted: dict, write_result):
        if write_result is None:
            raise ReplayPipelineError("pipeline did not persist a snapshot")
        persisted = self._store.get_snapshot(write_result.snapshot_id)
        if persisted is None:
            raise ReplayPipelineError("persisted snapshot cannot be read back")
        items = self._store.get_items(persisted.snapshot_id)
        try:
            verified_envelope = SnapshotReader._hydrate(persisted, items)
        except Exception as error:
            raise ReplayPipelineError(
                "persisted snapshot integrity is invalid"
            ) from error
        if (
            persisted.output_fingerprint
            != attempted.get("output_fingerprint")
            or persisted.input_fingerprint != self._pins.input_fingerprint
            or persisted.profile != self._pins.profile
            or persisted.market_scope != self._pins.market_scope
            or persisted.as_of_utc != self._pins.as_of
            or persisted.trading_day != self._pins.trading_day
            or persisted.profile_version != self._pins.profile_version
            or persisted.contract_version != self._pins.contract_version
            or persisted.strategy_version != self._pins.strategy_version
            or persisted.pipeline_version != self._pins.pipeline_version
        ):
            raise ReplayPipelineError(
                "persisted snapshot does not match replay pins"
            )
        self.persisted = persisted
        self.verified_envelope = verified_envelope
        # An idempotent retry must publish/return the exact existing envelope,
        # not a newly attempted envelope with different telemetry.
        return copy.deepcopy(verified_envelope)


class PipelineReplayAdapter:
    """Map four authenticated slices to ``PipelineRunner`` and PostgreSQL."""

    def __init__(
        self,
        *,
        snapshot_store: PostgresSnapshotStore,
        policy: ReplayPipelinePolicy,
    ) -> None:
        if not isinstance(snapshot_store, PostgresSnapshotStore):
            raise TypeError(
                "PipelineReplayAdapter requires an explicit PostgresSnapshotStore"
            )
        if not isinstance(policy, ReplayPipelinePolicy):
            raise TypeError("policy must be ReplayPipelinePolicy")
        self._snapshot_store = snapshot_store
        self._policy = policy

    def run(self, pins: ReplayPins, inputs: ReplayInputs) -> ReplayResult:
        # Validate every pin and source byte before creating PipelineRunner or
        # opening the snapshot store.  Direct callers cannot bypass the same
        # guards normally applied by ReplayService.
        ReplayService._validate_pins(pins)
        self._validate_inputs(pins, inputs)
        source_inputs = self._map_inputs(pins, inputs)
        disclaimer = self._policy.validated_disclaimer(pins.profile)
        rule_bundle_hash = RuleEngine(
            self._policy.model_version
        ).bundle_hash
        config = PipelineConfig(
            profile=pins.profile,
            market_scope=pins.market_scope,
            trading_day=pins.trading_day,
            pipeline_version=pins.pipeline_version,
            model_version=self._policy.model_version,
            strategy_version=pins.strategy_version,
            rule_bundle_hash=rule_bundle_hash,
            template_hash=self._policy.template_hash,
            disclaimer_hash=disclaimer["hash"],
            contract_version=pins.contract_version,
            profile_version=pins.profile_version,
            disclaimer=disclaimer,
            input_hashes=tuple(
                replay_input_manifest_hashes(inputs)
            ),
        )
        verifier = _PersistedSnapshotVerifier(self._snapshot_store, pins)
        replay_key = ReplayService._idempotency_key(pins)
        envelope = PipelineRunner(
            config,
            snapshot_writer=SnapshotWriter(self._snapshot_store),
            post_persist_verifier=verifier,
        ).run(
            pins.as_of,
            source_inputs=source_inputs,
            snapshot_id=_stable_uuid4("snapshot", replay_key),
        )
        persisted = verifier.persisted
        if persisted is None or envelope != verifier.verified_envelope:
            raise ReplayPipelineError(
                "pipeline did not return the verified persisted snapshot"
            )
        return ReplayResult(
            snapshot_id=persisted.snapshot_id,
            output_fingerprint=persisted.output_fingerprint,
        )

    @staticmethod
    def _validate_inputs(pins: ReplayPins, inputs: ReplayInputs) -> None:
        if not isinstance(inputs, ReplayInputs):
            raise ReplaySourceError("pipeline replay inputs have wrong type")
        for expected, source in zip(
            ("signals", "universe", "scores", "evidence"),
            inputs.ordered(),
        ):
            ReplayService._validate_source_slice(expected, pins, source)
        computed = compute_replay_input_fingerprint(inputs)
        if computed != pins.input_fingerprint:
            raise ReplaySourceError(
                "source content hashes do not match replay input_fingerprint"
            )

    @staticmethod
    def _map_inputs(
        pins: ReplayPins, inputs: ReplayInputs
    ) -> PipelineSourceInputs:
        cutoff = _parse_replay_utc_seconds(pins.as_of)
        evidence_refs, expected_signals, evidence_tickers = (
            _validate_evidence_records(pins, inputs.evidence.records)
        )
        signals = tuple(
            copy.deepcopy(dict(record))
            for record in inputs.signals.records
        )
        _validate_signal_records(pins, signals, expected_signals)
        universe = []
        for record in inputs.universe.records:
            if (
                set(record) != {"ticker", "market_scope"}
                or record.get("market_scope") != pins.market_scope
                or not isinstance(record.get("ticker"), str)
                or not record["ticker"]
            ):
                raise ReplaySourceError("universe record is invalid")
            universe.append(record["ticker"])
        if universe != sorted(set(universe)):
            raise ReplaySourceError("universe ticker identity/order is invalid")

        scores: dict[str, dict[str, Any]] = {}
        for record in inputs.scores.records:
            required = {
                "ticker",
                "profile",
                "market_scope",
                "as_of",
                "available_at_utc",
                "source_version",
                "features",
                "fact_hash",
            }
            if set(record) != required:
                raise ReplaySourceError("score record keys are not exact")
            ticker = record["ticker"]
            if (
                not isinstance(ticker, str)
                or not ticker
                or ticker in scores
                or ticker not in universe
                or record["profile"] != pins.profile
                or record["market_scope"] != pins.market_scope
                or record["as_of"] != pins.as_of
                or not isinstance(record["source_version"], str)
                or not record["source_version"]
            ):
                raise ReplaySourceError("score record replay pins mismatch")
            available_at = _parse_source_utc(record["available_at_utc"])
            if available_at > cutoff:
                raise ReplaySourceError("score record violates replay PIT cutoff")
            features = validate_source_score_features(
                record["features"],
                profile=pins.profile,
                market_scope=pins.market_scope,
            )
            expected_hash = typed_score_fact_hash(
                ticker=ticker,
                profile=pins.profile,
                market_scope=pins.market_scope,
                as_of=pins.as_of,
                available_at_utc=available_at,
                source_version=record["source_version"],
                features=features,
            )
            if record["fact_hash"] != expected_hash:
                raise ReplaySourceError("score record fact_hash is not authentic")
            scores[ticker] = features
            evidence_refs.setdefault(ticker, []).append(
                {
                    "kind": "SCORE_INPUT",
                    "source_uri": (
                        "ai-model://strategy-score@"
                        f"{quote(record['source_version'], safe='.-_')}/"
                        f"{record['fact_hash']}"
                    ),
                    "as_of": record["available_at_utc"],
                    "hash": record["fact_hash"],
                    "short_text": "Strategy score snapshot",
                }
            )

        expected_universe = set(scores) | evidence_tickers
        if set(universe) != expected_universe:
            raise ReplaySourceError(
                "universe does not match authenticated source identities"
            )

        replay_key = ReplayService._idempotency_key(pins)

        return PipelineSourceInputs(
            signals=signals,
            universe=tuple(universe),
            scores=scores,
            evidence_refs={
                ticker: tuple(refs)
                for ticker, refs in evidence_refs.items()
            },
            recommendation_ids={
                ticker: _stable_uuid4("recommendation", replay_key, ticker)
                for ticker in universe
            },
        )


def _validate_evidence_records(pins, records):
    cutoff = _parse_replay_utc_seconds(pins.as_of)
    refs: dict[str, list[dict[str, Any]]] = {}
    expected_signals = []
    tickers = set()
    identities = set()
    for record in records:
        if set(record) != {"kind", "identity", "envelope"}:
            raise ReplaySourceError("evidence record keys are not exact")
        envelope_json = record.get("envelope")
        if not isinstance(envelope_json, Mapping):
            raise ReplaySourceError("evidence envelope must be an object")
        if record.get("kind") == "filing":
            envelope = filing_envelope_from_json(envelope_json)
            disclosure = envelope.disclosure
            if disclosure.market_scope != pins.market_scope:
                raise ReplaySourceError("filing evidence market_scope mismatch")
            try:
                envelope.require_available_by(cutoff)
            except ValueError as error:
                raise ReplaySourceError(
                    "filing evidence violates replay PIT cutoff"
                ) from error
            identity = tuple(disclosure.identity)
            if record.get("identity") != list(identity):
                raise ReplaySourceError("filing evidence identity mismatch")
            ticker = disclosure.ticker
            expected_signals.append(_filing_signal(envelope))
            evidence = {
                "kind": "DISCLOSURE",
                "source_uri": _disclosure_uri(
                    disclosure.source_kind,
                    disclosure.source_document_id,
                ),
                "as_of": _utc_text(disclosure.available_at_utc),
                "hash": disclosure.fact_hash,
                "short_text": disclosure.event_headline_local[:200],
            }
        elif record.get("kind") == "text_hit":
            envelope = text_hit_envelope_from_json(envelope_json)
            document = envelope.document
            if document.market_scope != pins.market_scope:
                raise ReplaySourceError("text-hit evidence market_scope mismatch")
            try:
                envelope.require_available_by(cutoff)
            except ValueError as error:
                raise ReplaySourceError(
                    "text-hit evidence violates replay PIT cutoff"
                ) from error
            identity = tuple(envelope.identity)
            if record.get("identity") != list(identity):
                raise ReplaySourceError("text-hit evidence identity mismatch")
            ticker = document.ticker
            expected_signals.append(_text_hit_signal(envelope))
            evidence = {
                "kind": "NEWS",
                "source_uri": (
                    f"news://{_uri_part(document.source_kind)}/"
                    f"{_uri_part(document.document_id)}"
                ),
                "as_of": _utc_text(document.available_at_utc),
                "hash": document.document_fact_hash,
                "short_text": (document.title or envelope.hit.term_id)[:200],
            }
        else:
            raise ReplaySourceError("evidence kind is unsupported")
        typed_identity = (record["kind"], *identity)
        if typed_identity in identities:
            raise ReplaySourceError("evidence identity is duplicated")
        identities.add(typed_identity)
        tickers.add(ticker)
        refs.setdefault(ticker, []).append(evidence)
    return refs, tuple(expected_signals), tickers


def _validate_signal_records(pins, signals, expected_signals) -> None:
    cutoff = _parse_replay_utc_seconds(pins.as_of)
    for record in signals:
        kind = record.get("kind")
        required = (
            {
                "kind",
                "ticker",
                "market_scope",
                "source_kind",
                "source_document_id",
                "source_version",
                "available_at_utc",
                "fact_hash",
                "disclosure_kind",
                "headline",
            }
            if kind == "filing"
            else {
                "kind",
                "ticker",
                "market_scope",
                "source_kind",
                "source_document_id",
                "source_version",
                "available_at_utc",
                "fact_hash",
                "term_id",
                "hit_kind",
                "field",
                "start_offset",
                "end_offset",
                "context_hash",
            }
            if kind == "text_hit"
            else set()
        )
        if not required or set(record) != required:
            raise ReplaySourceError("signal record keys/kind are invalid")
        available_at = _parse_source_utc(record["available_at_utc"])
        if (
            record.get("market_scope") != pins.market_scope
            or available_at > cutoff
            or not isinstance(record.get("ticker"), str)
            or not record["ticker"]
            or not isinstance(record.get("source_version"), str)
            or not record["source_version"]
            or not _SHA256_RE.fullmatch(record.get("fact_hash") or "")
        ):
            raise ReplaySourceError("signal record identity/PIT is invalid")
    actual = sorted(jcs_canonicalize(dict(item)) for item in signals)
    expected = sorted(
        jcs_canonicalize(dict(item)) for item in expected_signals
    )
    if actual != expected:
        raise ReplaySourceError(
            "signals do not match authenticated evidence facts"
        )


def _filing_signal(envelope) -> dict[str, Any]:
    disclosure = envelope.disclosure
    return {
        "kind": "filing",
        "ticker": disclosure.ticker,
        "market_scope": disclosure.market_scope,
        "source_kind": disclosure.source_kind,
        "source_document_id": disclosure.source_document_id,
        "source_version": disclosure.source_version,
        "available_at_utc": _utc_text(disclosure.available_at_utc),
        "fact_hash": disclosure.fact_hash,
        "disclosure_kind": disclosure.disclosure_kind,
        "headline": disclosure.event_headline_local,
    }


def _text_hit_signal(envelope) -> dict[str, Any]:
    return {
        "kind": "text_hit",
        "ticker": envelope.document.ticker,
        "market_scope": envelope.document.market_scope,
        "source_kind": envelope.document.source_kind,
        "source_document_id": envelope.document.document_id,
        "source_version": envelope.document.source_version,
        "available_at_utc": _utc_text(envelope.document.available_at_utc),
        "fact_hash": envelope.document.document_fact_hash,
        "term_id": envelope.hit.term_id,
        "hit_kind": envelope.hit.hit_kind,
        "field": envelope.hit.field,
        "start_offset": envelope.hit.start_offset,
        "end_offset": envelope.hit.end_offset,
        "context_hash": envelope.hit.context_hash,
    }


def _stable_uuid4(*material: str) -> str:
    digest = bytearray(
        hashlib.sha256(jcs_canonicalize(list(material)).encode("utf-8")).digest()[:16]
    )
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _disclosure_uri(source_kind: object, document_id: object) -> str:
    document = _uri_part(document_id)
    if source_kind == "jpx-edinet":
        return f"jpx-edinet://{document}"
    if source_kind == "dart":
        return f"dart://{document}"
    if source_kind == "kind":
        return f"krx://KIND/{document}"
    return f"news://{_uri_part(source_kind)}/{document}"


def _uri_part(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ReplaySourceError("evidence URI identity is invalid")
    return quote(value, safe=".-_")


def _utc_text(value) -> str:
    from datetime import timezone

    if value.tzinfo is None or value.utcoffset() != timezone.utc.utcoffset(value):
        raise ReplaySourceError("source available_at must be UTC")
    return value.isoformat().replace("+00:00", "Z")


def _parse_replay_utc_seconds(value: object):
    from datetime import datetime, timezone

    if not isinstance(value, str) or not value.endswith("Z"):
        raise ReplaySourceError("replay as_of must be UTC seconds")
    try:
        parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise ReplaySourceError("replay as_of must be UTC seconds") from error
    if (
        parsed.tzinfo != timezone.utc
        or parsed.microsecond != 0
        or value != parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
    ):
        raise ReplaySourceError("replay as_of must be UTC seconds")
    return parsed


def _parse_source_utc(value: object):
    from datetime import datetime, timezone

    if not isinstance(value, str) or not value.endswith("Z"):
        raise ReplaySourceError("source available_at must be canonical UTC")
    try:
        parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise ReplaySourceError("source available_at must be canonical UTC") from error
    if parsed.tzinfo != timezone.utc:
        raise ReplaySourceError("source available_at must be canonical UTC")
    timespec = "microseconds" if parsed.microsecond else "seconds"
    canonical = parsed.isoformat(timespec=timespec).replace("+00:00", "Z")
    if value != canonical:
        raise ReplaySourceError("source available_at must be canonical UTC")
    return parsed
