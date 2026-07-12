"""Typed DTO declarations for the pure CatDesk Tab 6/7 projections.

Recommendation entries intentionally remain opaque dictionaries here: B5
preserves the validated v0.3.1 RecommendationList item without translating it
into another competing schema.
"""

from typing import Dict, List, Optional, TypedDict


class DisclaimerDto(TypedDict):
    version: str
    short_text: str
    full_text: str
    language: str
    effective_at: str
    hash: str


class ReportMetaDto(TypedDict):
    contract_version: str
    profile_version: str
    input_fingerprint: str
    strategy_version: str
    pipeline_version: str
    generated_by: str
    generation_ms: int


class RatingCountsDto(TypedDict):
    A: int
    B: int
    C: int
    D: int
    F: int


class ReportSummaryDto(TypedDict):
    item_count: int
    high_conviction_count: int
    rating_counts: RatingCountsDto


class ReportSectionDto(TypedDict, total=False):
    kind: str
    section_id: str
    title: str
    item_count: int
    high_conviction_count: int
    rating_counts: RatingCountsDto
    ticker: str
    rating_band: str
    evidence_ids: List[str]


class DailyReportDto(TypedDict):
    projection_version: str
    report_id: str
    trading_day: str
    profile: str
    market_scope: str
    source_snapshot_id: str
    source_as_of: str
    source_output_fingerprint: str
    source_fingerprint_preimage_jcs: str
    disclaimer: DisclaimerDto
    meta: ReportMetaDto
    summary: ReportSummaryDto
    entries: List[dict]
    sections: List[ReportSectionDto]
    markdown: str


class HistoryFiltersDto(TypedDict):
    query: str
    profile: Optional[str]
    market_scope: Optional[str]
    from_day: Optional[str]
    to_day: Optional[str]


class HistoryEntryDto(TypedDict):
    report_id: str
    trading_day: str
    profile: str
    market_scope: str
    source_snapshot_id: str
    source_as_of: str
    source_output_fingerprint: str
    source_fingerprint_preimage_jcs: str
    input_fingerprint: str
    contract_version: str
    profile_version: str
    strategy_version: str
    pipeline_version: str
    disclaimer_version: str
    item_count: int
    high_conviction_count: int
    rating_counts: RatingCountsDto
    content_preview: str


class ReportHistoryDto(TypedDict):
    projection_version: str
    filters: HistoryFiltersDto
    entries: List[HistoryEntryDto]
    total: int
