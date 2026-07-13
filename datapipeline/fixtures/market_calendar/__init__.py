"""Synthetic market-scoped calendar fixture and injected replay port."""

from .synthetic_calendar import (
    LOCAL_DISPOSABLE_PURPOSE,
    SYNTHETIC_SOURCE,
    CalendarFixtureError,
    CalendarSession,
    SyntheticCalendarPort,
    build_synthetic_calendars,
    canonical_calendar_hash,
    load_calendar_manifest,
    weekly_checkpoints,
)

__all__ = [
    "SYNTHETIC_SOURCE",
    "LOCAL_DISPOSABLE_PURPOSE",
    "CalendarFixtureError",
    "CalendarSession",
    "SyntheticCalendarPort",
    "build_synthetic_calendars",
    "canonical_calendar_hash",
    "load_calendar_manifest",
    "weekly_checkpoints",
]
