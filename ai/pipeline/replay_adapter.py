"""Authenticated replay inputs adapted into the real recommendation pipeline."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import re
from typing import Any
from urllib.parse import quote

from ai.pipeline.runner import (
    PipelineConfig,
    PipelineRunner,
    PipelineSourceInputs,
)
from ai.replay.runtime import typed_score_fact_hash, validate_source_score_features
from ai.replay.service import (
    ReplayPipelineError,
    ReplayService,
    ReplaySourceError,
)
from ai.replay.types import ReplayInputs, ReplayPins, ReplayResult
from ai.rules.engine import RuleEngine
from ai.snapshot.fingerprint import compute_input_fingerprint
from ai.snapshot.postgres_store import PostgresSnapshotStore
from ai.snapshot.writer import SnapshotWriteResult, SnapshotWriter


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
    disclaimer: Mapping[str, Any]

    def validated_disclaimer(self) -> dict[str, Any]:
        if not isinstance(self.model_version, str) or not _SEMVER_RE.fullmatch(
            self.model_version
        ):
            raise ReplayPipelineError("model_version must be SemVer")
        if not isinstance(self.template_hash, str) or not _SHA256_RE.fullmatch(
            self.template_hash
        ):
            raise ReplayPipelineError("template_hash must be lowercase SHA-256")
        if not isinstance(self.disclaimer, Mapping):
            raise ReplayPipelineError("disclaimer must be an object")
        required = {
            "version",
            "short_text",
            "full_text",
            "language",
            "effective_at",
            "hash",
        }
        if set(self.disclaimer) != required:
            raise ReplayPipelineError("disclaimer keys are not exact")
        full_text = self.disclaimer.get("full_text")
        digest = self.disclaimer.get("hash")
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
            if not isinstance(self.disclaimer.get(field), str) or not self.disclaimer[
                field
            ]:
                raise ReplayPipelineError(f"disclaimer.{field} is required")
        return copy.deepcopy(dict(self.disclaimer))


class _CapturingSnapshotWriter:
    def __init__(self, writer: SnapshotWriter) -> None:
        self._writer = writer
        self.result: SnapshotWriteResult | None = None

    def write(self, ctx, recommendation_list: dict) -> SnapshotWriteResult:
        self.result = self._writer.write(ctx, recommendation_list)
        return self.result


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
        disclaimer = self._policy.validated_disclaimer()
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
                source.content_hash for source in inputs.ordered()
            ),
        )
        writer = _CapturingSnapshotWriter(
            SnapshotWriter(self._snapshot_store)
        )
        envelope = PipelineRunner(
            config,
            snapshot_writer=writer,
        ).run(pins.as_of, source_inputs=source_inputs)
        if writer.result is None:
            raise ReplayPipelineError("pipeline did not persist a snapshot")
        persisted = self._snapshot_store.get_snapshot(writer.result.snapshot_id)
        if persisted is None:
            raise ReplayPipelineError("persisted snapshot cannot be read back")
        if (
            persisted.output_fingerprint != envelope.get("output_fingerprint")
            or persisted.input_fingerprint != pins.input_fingerprint
            or persisted.profile != pins.profile
            or persisted.market_scope != pins.market_scope
            or persisted.as_of_utc != pins.as_of
        ):
            raise ReplayPipelineError("persisted snapshot does not match replay pins")
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
        computed = compute_input_fingerprint(
            [source.content_hash for source in inputs.ordered()]
        )
        if computed != pins.input_fingerprint:
            raise ReplaySourceError(
                "source content hashes do not match replay input_fingerprint"
            )

    @staticmethod
    def _map_inputs(
        pins: ReplayPins, inputs: ReplayInputs
    ) -> PipelineSourceInputs:
        signals = tuple(
            copy.deepcopy(dict(record))
            for record in inputs.signals.records
        )
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
        if len(universe) != len(set(universe)):
            raise ReplaySourceError("universe ticker is duplicated")

        scores: dict[str, dict[str, Any]] = {}
        evidence_refs: dict[str, list[dict[str, Any]]] = {}
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
            ):
                raise ReplaySourceError("score record replay pins mismatch")
            available_at = _parse_utc(record["available_at_utc"])
            if available_at > pins.as_of:
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
                available_at_utc=_parse_utc_datetime(
                    record["available_at_utc"]
                ),
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

        for record in inputs.evidence.records:
            ticker, evidence = _evidence_ref(record)
            if ticker not in universe:
                raise ReplaySourceError("evidence ticker is outside universe")
            evidence_refs.setdefault(ticker, []).append(evidence)

        return PipelineSourceInputs(
            signals=signals,
            universe=tuple(universe),
            scores=scores,
            evidence_refs={
                ticker: tuple(refs)
                for ticker, refs in evidence_refs.items()
            },
        )


def _evidence_ref(record: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    if set(record) != {"kind", "identity", "envelope"}:
        raise ReplaySourceError("evidence record keys are not exact")
    envelope = record.get("envelope")
    if not isinstance(envelope, Mapping):
        raise ReplaySourceError("evidence envelope must be an object")
    if record.get("kind") == "filing":
        disclosure = envelope.get("disclosure")
        if not isinstance(disclosure, Mapping):
            raise ReplaySourceError("filing evidence is invalid")
        ticker = disclosure.get("ticker")
        source_kind = disclosure.get("source_kind")
        document_id = disclosure.get("source_document_id")
        available_at = disclosure.get("available_at_utc")
        fact_hash = disclosure.get("fact_hash")
        headline = disclosure.get("event_headline_local")
        uri = _disclosure_uri(source_kind, document_id)
        kind = "DISCLOSURE"
        short_text = headline
    elif record.get("kind") == "text_hit":
        document = envelope.get("document")
        hit = envelope.get("hit")
        if not isinstance(document, Mapping) or not isinstance(hit, Mapping):
            raise ReplaySourceError("text-hit evidence is invalid")
        ticker = document.get("ticker")
        source_kind = document.get("source_kind")
        document_id = document.get("document_id")
        available_at = document.get("available_at_utc")
        fact_hash = document.get("document_fact_hash")
        short_text = document.get("title") or hit.get("term_id")
        uri = (
            f"news://{_uri_part(source_kind)}/{_uri_part(document_id)}"
        )
        kind = "NEWS"
    else:
        raise ReplaySourceError("evidence kind is unsupported")
    if (
        not isinstance(ticker, str)
        or not ticker
        or not isinstance(available_at, str)
        or not _SHA256_RE.fullmatch(fact_hash or "")
    ):
        raise ReplaySourceError("evidence identity is invalid")
    _parse_utc(available_at)
    evidence = {
        "kind": kind,
        "source_uri": uri,
        "as_of": available_at,
        "hash": fact_hash,
    }
    if isinstance(short_text, str) and short_text:
        evidence["short_text"] = short_text[:200]
    return ticker, evidence


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


def _parse_utc(value: object) -> str:
    parsed = _parse_utc_datetime(value)
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_utc_datetime(value: object):
    from datetime import datetime, timezone

    if not isinstance(value, str) or not value.endswith("Z"):
        raise ReplaySourceError("source available_at must be UTC seconds")
    try:
        parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise ReplaySourceError("source available_at must be UTC seconds") from error
    if (
        parsed.tzinfo != timezone.utc
        or parsed.microsecond != 0
        or value != parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
    ):
        raise ReplaySourceError("source available_at must be UTC seconds")
    return parsed
