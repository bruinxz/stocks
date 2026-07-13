"""Deterministic CatDesk report projections."""

from strategy.reporting.tab67_projection import (
    parse_utc_seconds,
    ProjectionContractError,
    project_daily_report,
    project_report_history,
    require_finite_number,
    validate_conviction,
    validate_entry_plan,
    validate_score_snapshot,
)
from strategy.reporting.types import DailyReportDto, ReportHistoryDto

__all__ = [
    "ProjectionContractError",
    "DailyReportDto",
    "ReportHistoryDto",
    "project_daily_report",
    "project_report_history",
    "parse_utc_seconds",
    "require_finite_number",
    "validate_score_snapshot",
    "validate_conviction",
    "validate_entry_plan",
]
