"""Multibagger source-fact writer."""

from .source_writer import (
    MultibaggerIdempotencyConflict,
    MultibaggerSourceWriter,
    MultibaggerWriteResult,
    build_storage_row,
    canonical_multibagger_fact_hash,
    canonical_multibagger_storage_fact_hash,
    multibagger_storage_fact_body,
)
from .canonical_json import canonicalize_json
from .text_hit_writer import (
    build_text_hit_storage_row,
    canonical_text_hit_fact_hash,
    TextHitIdempotencyConflict,
    TextHitStorageRow,
    TextHitWriter,
    TextHitWriteResult,
    text_hit_fact_body,
)

__all__ = [
    "MultibaggerIdempotencyConflict",
    "MultibaggerSourceWriter",
    "MultibaggerWriteResult",
    "build_storage_row",
    "canonical_multibagger_fact_hash",
    "canonical_multibagger_storage_fact_hash",
    "multibagger_storage_fact_body",
    "canonicalize_json",
    "build_text_hit_storage_row",
    "canonical_text_hit_fact_hash",
    "TextHitIdempotencyConflict",
    "TextHitStorageRow",
    "TextHitWriter",
    "TextHitWriteResult",
    "text_hit_fact_body",
]
