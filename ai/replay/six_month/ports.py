from __future__ import annotations

from typing import Protocol

from datapipeline.fixtures.market_calendar import SyntheticCalendarPort
from ai.replay.six_month.types import (
    CalendarSession,
    MarketCalendar,
    MarketScope,
    MembershipRecord,
    PriceRecord,
    ReplayProfile,
    ScoreRecord,
    SourceFact,
)


class MarketCalendarPort(Protocol):
    def load_calendar(self, market_scope: MarketScope) -> MarketCalendar:
        ...


class UniversePort(Protocol):
    def tickers(self, market_scope: MarketScope) -> tuple[str, ...]:
        ...


class MembershipPort(Protocol):
    def records(
        self, market_scope: MarketScope, session: CalendarSession
    ) -> tuple[MembershipRecord, ...]:
        ...


class ScorePort(Protocol):
    def records(
        self,
        profile: ReplayProfile,
        market_scope: MarketScope,
        session: CalendarSession,
    ) -> tuple[ScoreRecord, ...]:
        ...


class PricePort(Protocol):
    def records(
        self, market_scope: MarketScope, session: CalendarSession
    ) -> tuple[PriceRecord, ...]:
        ...


class SurvivorshipEvidencePort(Protocol):
    def records(
        self, market_scope: MarketScope, session: CalendarSession
    ) -> tuple[SourceFact, ...]:
        ...


class SyntheticFixtureCalendarAdapter:
    """Adapt the landed T5-A read-only calendar to the T5-B engine port."""

    def __init__(self, port: SyntheticCalendarPort):
        self._port = port

    def load_calendar(self, market_scope: MarketScope) -> MarketCalendar:
        sessions = self._port.sessions(
            market_scope, start="2026-01-10", end="2026-07-10"
        )
        source_versions = {session.fixture_version for session in sessions}
        if len(source_versions) != 1:
            raise ValueError("calendar sessions must share one fixture version")
        checkpoint_days = {
            session.trade_date
            for session in self._port.checkpoints(market_scope)
        }
        return MarketCalendar(
            market_scope=market_scope,
            window_start="2026-01-10",
            window_end="2026-07-10",
            source_version=next(iter(source_versions)),
            fixture_hash=self._port.fixture_hash(market_scope),
            synthetic=True,
            disclaimer=(
                "Synthetic deterministic test calendars; never represent "
                "official exchange calendars and never seed production."
            ),
            sessions=tuple(
                CalendarSession(
                    market_scope=market_scope,
                    trade_date=session.trade_date,
                    close_utc=session.session_close_utc,
                    is_checkpoint=session.trade_date in checkpoint_days,
                )
                for session in sessions
            ),
        )
