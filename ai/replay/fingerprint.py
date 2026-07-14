"""Replay input fingerprint over four named source slices."""

from __future__ import annotations

import hashlib

from ai.replay.types import ReplayInputs
from ai.snapshot.fingerprint import (
    JCSCanonicalizationError,
    compute_input_fingerprint,
    jcs_canonicalize,
)


REPLAY_SOURCE_KINDS = ("signals", "universe", "scores", "evidence")


def replay_input_manifest_hashes(inputs: ReplayInputs) -> tuple[str, ...]:
    """Bind each frozen records hash to its semantic slice name.

    Two legitimate empty slices have the same ``sha256(JCS(records))``.  The
    generic input fingerprint intentionally rejects duplicate manifest hashes,
    so replay derives one hash per named slice without changing SourceSlice's
    frozen content-hash formula.
    """

    if not isinstance(inputs, ReplayInputs):
        raise JCSCanonicalizationError("replay inputs have wrong type")
    manifest_hashes = []
    for expected_kind, source in zip(REPLAY_SOURCE_KINDS, inputs.ordered()):
        if source.kind != expected_kind:
            raise JCSCanonicalizationError("replay source kind/order mismatch")
        material = {
            "content_hash": source.content_hash,
            "kind": expected_kind,
        }
        manifest_hashes.append(
            hashlib.sha256(jcs_canonicalize(material).encode("utf-8")).hexdigest()
        )
    return tuple(manifest_hashes)


def compute_replay_input_fingerprint(inputs: ReplayInputs) -> str:
    return compute_input_fingerprint(replay_input_manifest_hashes(inputs))
