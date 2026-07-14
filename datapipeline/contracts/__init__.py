"""Frozen cross-source record protocols for the DataPipeline layer."""

from .market_records import FxObservation, MultibaggerSourceRecord
from .jpkr_official_records import JpKrDailyKlineRecord, JpKrSecurityRecord
from .capture_provenance import (
    CAPTURE_SCHEMA_VERSION,
    CaptureProvenanceError,
    build_capture_wrapper,
    capture_source_version,
    validate_capture_wrapper,
)
from .source_envelopes import (
    JpKrDisclosureRecord,
    JpKrFilingEnvelope,
    JpKrFinancialRecord,
    ScanDocument,
    TextHit,
    TextHitEnvelope,
)

__all__ = [
    "FxObservation",
    "CAPTURE_SCHEMA_VERSION",
    "CaptureProvenanceError",
    "JpKrDisclosureRecord",
    "JpKrDailyKlineRecord",
    "JpKrFilingEnvelope",
    "JpKrFinancialRecord",
    "JpKrSecurityRecord",
    "MultibaggerSourceRecord",
    "ScanDocument",
    "TextHit",
    "TextHitEnvelope",
    "build_capture_wrapper",
    "capture_source_version",
    "validate_capture_wrapper",
]
