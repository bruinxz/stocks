from __future__ import annotations

import datetime as dt
import hashlib
import math
import statistics
from dataclasses import asdict
from typing import Iterable, Mapping, Optional

from ai.replay.six_month.ports import (
    MarketCalendarPort,
    MembershipPort,
    PricePort,
    ScorePort,
    SurvivorshipEvidencePort,
    UniversePort,
)
from ai.replay.six_month.types import (
    CalendarSession,
    CostModel,
    HoldingCandidate,
    MarketCalendar,
    MarketScope,
    MembershipRecord,
    PriceRecord,
    ReplayBatch,
    ReplayMetrics,
    ReplayProfile,
    ReplayRun,
    ScoreRecord,
    SnapshotCandidate,
    SourceFact,
)
from ai.snapshot.fingerprint import jcs_canonicalize


WINDOW_START = "2026-01-10"
WINDOW_END = "2026-07-10"
EXPECTED_SESSIONS = 128
EXPECTED_CHECKPOINTS = 27
HOLDINGS_PER_CHECKPOINT = 3
METRIC_CONTRACT_VERSION = "1.0.0"
SYNTHETIC_DISCLAIMER = (
    "Synthetic deterministic test calendars; never represent official "
    "exchange calendars and never seed production."
)
PROFILE_MARKET_SCOPES = {
    "us_preferred": frozenset({"cn_a", "us"}),
    "multibagger": frozenset({"cn_a", "us"}),
    "japan_blue_chip": frozenset({"jp"}),
    "japan_multibagger": frozenset({"jp"}),
    "korea_semiconductor_chain": frozenset({"kr"}),
    "korea_multibagger": frozenset({"kr"}),
}
LEGAL_PAIRS = tuple(
    (profile, scope)
    for profile, scopes in PROFILE_MARKET_SCOPES.items()
    for scope in sorted(scopes)
)


class SixMonthReplayError(RuntimeError):
    pass


class ReplayPairError(SixMonthReplayError):
    pass


class ReplayInputError(SixMonthReplayError):
    pass


class SixMonthReplayEngine:
    """Evaluate deterministic synthetic PIT inputs without DB, HTTP, or network."""

    def __init__(
        self,
        *,
        calendar_port: MarketCalendarPort,
        universe_port: UniversePort,
        membership_port: MembershipPort,
        score_port: ScorePort,
        price_port: PricePort,
        survivorship_port: SurvivorshipEvidencePort,
        cost_model: CostModel = CostModel(),
    ):
        self._calendar_port = calendar_port
        self._universe_port = universe_port
        self._membership_port = membership_port
        self._score_port = score_port
        self._price_port = price_port
        self._survivorship_port = survivorship_port
        self._cost_model = cost_model
        self._validate_cost_model(cost_model)

    def run_all(self) -> ReplayBatch:
        runs = tuple(
            self.run(profile, scope) for profile, scope in LEGAL_PAIRS
        )
        return ReplayBatch(
            runs=runs,
            daily_evaluations=sum(
                run.evaluated_session_count for run in runs
            ),
            snapshot_count=sum(len(run.snapshots) for run in runs),
            holding_count=sum(
                len(snapshot.holdings)
                for run in runs
                for snapshot in run.snapshots
            ),
        )

    def run(
        self, profile: ReplayProfile, market_scope: MarketScope
    ) -> ReplayRun:
        self._validate_pair(profile, market_scope)
        calendar = self._calendar_port.load_calendar(market_scope)
        self._validate_calendar(calendar, market_scope)
        tickers = self._universe_port.tickers(market_scope)
        if (
            not isinstance(tickers, tuple)
            or len(tickers) != 4
            or len(set(tickers)) != 4
            or any(not isinstance(ticker, str) or not ticker for ticker in tickers)
        ):
            raise ReplayInputError("universe must contain four unique tickers")

        nav = self._cost_model.initial_nav
        running_peak = nav
        drawdown = 0.0
        daily_returns: list[float] = []
        current_weights: dict[str, float] = {}
        entry_prices: dict[str, float] = {}
        previous_prices: dict[str, float] = {}
        closed_positions = 0
        profitable_closed_positions = 0
        snapshots: list[SnapshotCandidate] = []
        observed_stale = False
        observed_delisted = False
        checkpoints = tuple(
            session for session in calendar.sessions if session.is_checkpoint
        )

        for session_index, session in enumerate(calendar.sessions):
            membership = self._membership_port.records(
                market_scope, session
            )
            scores = self._score_port.records(
                profile, market_scope, session
            )
            prices = self._price_port.records(market_scope, session)
            survivorship = self._survivorship_port.records(
                market_scope, session
            )
            membership_by_ticker = self._membership_map(
                membership, tickers, market_scope, session
            )
            scores_by_ticker = self._score_map(
                scores, tickers, profile, market_scope, session
            )
            prices_by_ticker = self._price_map(
                prices, tickers, market_scope, session
            )
            self._validate_survivorship(
                survivorship, market_scope, session
            )
            observed_stale = observed_stale or any(
                record.is_stale for record in prices
            )
            observed_delisted = observed_delisted or any(
                record.is_delisted_at_as_of for record in membership
            )

            previous_nav = nav
            if previous_prices:
                gross_return = sum(
                    weight
                    * (
                        prices_by_ticker[ticker].adjusted_close
                        / previous_prices[ticker]
                        - 1.0
                    )
                    for ticker, weight in current_weights.items()
                )
                nav *= 1.0 + gross_return

            if session.is_checkpoint:
                selected = self._select_holdings(
                    membership_by_ticker, scores_by_ticker
                )
                target_weights = {
                    ticker: 1.0 / HOLDINGS_PER_CHECKPOINT
                    for ticker in selected
                }
                turnover = sum(
                    abs(
                        target_weights.get(ticker, 0.0)
                        - current_weights.get(ticker, 0.0)
                    )
                    for ticker in set(target_weights) | set(current_weights)
                )
                cost_rate = turnover * (
                    self._cost_model.commission_bps_per_side
                    + self._cost_model.slippage_bps_per_side
                ) / 10_000.0
                nav *= 1.0 - cost_rate
                if not math.isfinite(nav) or nav <= 0:
                    raise ReplayInputError("net value must remain finite and positive")

                removed = set(current_weights) - set(target_weights)
                for ticker in removed:
                    closed_positions += 1
                    exit_return = self._closed_position_return(
                        entry_price=entry_prices[ticker],
                        exit_price=prices_by_ticker[
                            ticker
                        ].adjusted_close,
                        cost_model=self._cost_model,
                    )
                    if exit_return > 0:
                        profitable_closed_positions += 1
                    entry_prices.pop(ticker, None)
                for ticker in target_weights:
                    if ticker not in current_weights:
                        entry_prices[ticker] = prices_by_ticker[
                            ticker
                        ].adjusted_close
                current_weights = target_weights

            daily_net_return = nav / previous_nav - 1.0
            if not math.isfinite(daily_net_return):
                raise ReplayInputError("daily net return must be finite")
            daily_returns.append(daily_net_return)
            running_peak = max(running_peak, nav)
            drawdown = min(drawdown, nav / running_peak - 1.0)
            previous_prices = {
                ticker: record.adjusted_close
                for ticker, record in prices_by_ticker.items()
            }

            if session.is_checkpoint:
                snapshot = self._build_snapshot(
                    profile=profile,
                    market_scope=market_scope,
                    calendar=calendar,
                    session=session,
                    checkpoint_index=len(snapshots),
                    checkpoint_count=len(checkpoints),
                    session_count=session_index + 1,
                    nav=nav,
                    drawdown=drawdown,
                    daily_returns=daily_returns,
                    closed_positions=closed_positions,
                    profitable_closed_positions=profitable_closed_positions,
                    current_weights=current_weights,
                    entry_prices=entry_prices,
                    prices=prices_by_ticker,
                    membership=membership_by_ticker,
                    scores=scores_by_ticker,
                    survivorship=survivorship,
                )
                snapshots.append(snapshot)

        if not observed_stale:
            raise ReplayInputError("fixture must expose a stale-price episode")
        if not observed_delisted:
            raise ReplayInputError("fixture must retain a delisting episode")
        if len(snapshots) != EXPECTED_CHECKPOINTS:
            raise ReplayInputError("checkpoint count drift")
        return ReplayRun(
            strategy=profile,
            market_scope=market_scope,
            evaluated_session_count=len(calendar.sessions),
            snapshots=tuple(snapshots),
        )

    def _build_snapshot(
        self,
        *,
        profile: ReplayProfile,
        market_scope: MarketScope,
        calendar: MarketCalendar,
        session: CalendarSession,
        checkpoint_index: int,
        checkpoint_count: int,
        session_count: int,
        nav: float,
        drawdown: float,
        daily_returns: list[float],
        closed_positions: int,
        profitable_closed_positions: int,
        current_weights: Mapping[str, float],
        entry_prices: Mapping[str, float],
        prices: Mapping[str, PriceRecord],
        membership: Mapping[str, MembershipRecord],
        scores: Mapping[str, ScoreRecord],
        survivorship: tuple[SourceFact, ...],
    ) -> SnapshotCandidate:
        sharpe = self._sharpe(daily_returns)
        win_rate = (
            profitable_closed_positions / closed_positions
            if closed_positions
            else None
        )
        metrics = ReplayMetrics(
            metric_contract_version=METRIC_CONTRACT_VERSION,
            window_start=WINDOW_START,
            window_end=WINDOW_END,
            evaluated_session_count=session_count,
            checkpoint_index=checkpoint_index,
            checkpoint_count=checkpoint_count,
            initial_nav=self._cost_model.initial_nav,
            commission_bps_per_side=(
                self._cost_model.commission_bps_per_side
            ),
            slippage_bps_per_side=self._cost_model.slippage_bps_per_side,
            annualization_sessions=self._cost_model.annualization_sessions,
            net_value=nav,
            cumulative_return=nav / self._cost_model.initial_nav - 1.0,
            drawdown=drawdown,
            sharpe_ratio_6m=sharpe,
            win_rate_6m=win_rate,
        )
        ordered_tickers = tuple(
            sorted(
                current_weights,
                key=lambda ticker: (
                    -scores[ticker].score,
                    ticker,
                ),
            )
        )
        holdings = []
        for position_order, ticker in enumerate(ordered_tickers):
            price = prices[ticker]
            member = membership[ticker]
            holding_payload = {
                "ticker": ticker,
                "position_order": position_order,
                "market_scope": market_scope,
                "snapshot_as_of_utc": session.close_utc,
                "weight": current_weights[ticker],
                "entry_price": entry_prices[ticker],
                "current_price": price.adjusted_close,
                "return_since_entry": (
                    price.adjusted_close / entry_prices[ticker] - 1.0
                ),
                "is_stale": price.is_stale,
                "is_delisted_at_as_of": member.is_delisted_at_as_of,
                "available_at_utc": price.fact.available_at_utc,
                "price_fact_hash": price.fact.fact_hash,
                "membership_fact_hash": member.fact.fact_hash,
                "score_fact_hash": scores[ticker].fact.fact_hash,
            }
            holdings.append(
                HoldingCandidate(
                    ticker=ticker,
                    position_order=position_order,
                    market_scope=market_scope,
                    snapshot_as_of_utc=session.close_utc,
                    weight=current_weights[ticker],
                    entry_price=entry_prices[ticker],
                    current_price=price.adjusted_close,
                    return_since_entry=holding_payload[
                        "return_since_entry"
                    ],
                    is_stale=price.is_stale,
                    is_delisted_at_as_of=member.is_delisted_at_as_of,
                    source_kind=price.fact.source_kind,
                    source_document_id=price.fact.source_document_id,
                    source_version=price.fact.source_version,
                    available_at_utc=price.fact.available_at_utc,
                    lineage={
                        "membership_fact_hash": member.fact.fact_hash,
                        "price_fact_hash": price.fact.fact_hash,
                        "score_fact_hash": scores[ticker].fact.fact_hash,
                    },
                    fact_hash=self._hash(holding_payload),
                )
            )
        if abs(sum(holding.weight for holding in holdings) - 1.0) > 1e-9:
            raise ReplayInputError("holding weights must sum to one")
        lineage = {
            "calendar_fixture_hash": calendar.fixture_hash,
            "universe_hash": self._hash(sorted(membership)),
            "membership_hash": self._hash(
                [
                    membership[ticker].fact.fact_hash
                    for ticker in sorted(membership)
                ]
            ),
            "price_fact_hashes": [
                prices[ticker].fact.fact_hash for ticker in sorted(prices)
            ],
            "score_fact_hashes": [
                scores[ticker].fact.fact_hash for ticker in sorted(scores)
            ],
            "strategy_version": scores[ordered_tickers[0]].strategy_version,
            "cost_model_version": self._cost_model.version,
            "survivorship_evidence": {
                "fact_hashes": [fact.fact_hash for fact in survivorship],
                "retains_delisted": True,
                "source_version": survivorship[0].source_version,
            },
        }
        header_payload = {
            "strategy": profile,
            "market_scope": market_scope,
            "snapshot_day": session.trade_date,
            "as_of_utc": session.close_utc,
            "metrics": asdict(metrics),
            "lineage_closure": lineage,
            "is_survivorship_biased": False,
            "is_delisted_at_as_of": any(
                holding.is_delisted_at_as_of for holding in holdings
            ),
            "holding_hashes": [holding.fact_hash for holding in holdings],
        }
        return SnapshotCandidate(
            strategy=profile,
            market_scope=market_scope,
            snapshot_day=session.trade_date,
            as_of_utc=session.close_utc,
            metrics=metrics,
            holdings=tuple(holdings),
            lineage_closure=lineage,
            is_survivorship_biased=False,
            is_delisted_at_as_of=any(
                holding.is_delisted_at_as_of for holding in holdings
            ),
            source_versions={
                "calendar": "1.0.0",
                "cost_model": self._cost_model.version,
                "membership": membership[ordered_tickers[0]].fact.source_version,
                "prices": prices[ordered_tickers[0]].fact.source_version,
                "scores": scores[ordered_tickers[0]].fact.source_version,
                "survivorship": survivorship[0].source_version,
            },
            fact_hash=self._hash(header_payload),
        )

    @staticmethod
    def _select_holdings(
        membership: Mapping[str, MembershipRecord],
        scores: Mapping[str, ScoreRecord],
    ) -> tuple[str, ...]:
        eligible = [
            ticker
            for ticker, record in membership.items()
            if record.is_member_at_as_of
        ]
        if len(eligible) < HOLDINGS_PER_CHECKPOINT:
            raise ReplayInputError("fewer than three eligible members")
        return tuple(
            sorted(eligible, key=lambda ticker: (-scores[ticker].score, ticker))[
                :HOLDINGS_PER_CHECKPOINT
            ]
        )

    @staticmethod
    def _sharpe(returns: list[float]) -> Optional[float]:
        if len(returns) < 2:
            return None
        deviation = statistics.stdev(returns)
        if deviation == 0:
            return None
        return math.sqrt(252) * statistics.mean(returns) / deviation

    @staticmethod
    def _closed_position_return(
        *, entry_price: float, exit_price: float, cost_model: CostModel
    ) -> float:
        """Return net of both entry and exit commission plus slippage."""

        round_trip_cost_rate = 2 * (
            cost_model.commission_bps_per_side
            + cost_model.slippage_bps_per_side
        ) / 10_000.0
        return exit_price / entry_price - 1.0 - round_trip_cost_rate

    @classmethod
    def _membership_map(
        cls,
        records: tuple[MembershipRecord, ...],
        tickers: tuple[str, ...],
        scope: MarketScope,
        session: CalendarSession,
    ) -> dict[str, MembershipRecord]:
        result = cls._unique_records(records, tickers, "membership")
        for record in records:
            if (
                record.market_scope != scope
                or record.as_of_utc != session.close_utc
                or not isinstance(record.is_member_at_as_of, bool)
                or not isinstance(record.is_delisted_at_as_of, bool)
            ):
                raise ReplayInputError("membership pin mismatch")
            cls._validate_fact(record.fact, session.close_utc)
            cls._validate_fact_payload(
                record.fact,
                {
                    "kind": "membership",
                    "scope": scope,
                    "ticker": record.ticker,
                    "as_of": session.close_utc,
                    "member": record.is_member_at_as_of,
                    "delisted": record.is_delisted_at_as_of,
                },
            )
        cls._require_uniform_version(records, "membership")
        return result

    @classmethod
    def _score_map(
        cls,
        records: tuple[ScoreRecord, ...],
        tickers: tuple[str, ...],
        profile: ReplayProfile,
        scope: MarketScope,
        session: CalendarSession,
    ) -> dict[str, ScoreRecord]:
        result = cls._unique_records(records, tickers, "score")
        for record in records:
            if (
                record.profile != profile
                or record.market_scope != scope
                or record.as_of_utc != session.close_utc
                or not isinstance(record.strategy_version, str)
                or not record.strategy_version
                or isinstance(record.score, bool)
                or not isinstance(record.score, (int, float))
                or not math.isfinite(record.score)
            ):
                raise ReplayInputError("score pin/domain mismatch")
            cls._validate_fact(record.fact, session.close_utc)
            cls._validate_fact_payload(
                record.fact,
                {
                    "kind": "score",
                    "profile": profile,
                    "scope": scope,
                    "ticker": record.ticker,
                    "as_of": session.close_utc,
                    "score": record.score,
                },
            )
        cls._require_uniform_version(records, "score")
        return result

    @classmethod
    def _price_map(
        cls,
        records: tuple[PriceRecord, ...],
        tickers: tuple[str, ...],
        scope: MarketScope,
        session: CalendarSession,
    ) -> dict[str, PriceRecord]:
        result = cls._unique_records(records, tickers, "price")
        for record in records:
            if (
                record.market_scope != scope
                or record.as_of_utc != session.close_utc
                or isinstance(record.adjusted_close, bool)
                or not isinstance(record.adjusted_close, (int, float))
                or not math.isfinite(record.adjusted_close)
                or record.adjusted_close <= 0
                or not isinstance(record.is_stale, bool)
            ):
                raise ReplayInputError("price pin/domain mismatch")
            cls._validate_fact(record.fact, session.close_utc)
            cls._validate_fact_payload(
                record.fact,
                {
                    "kind": "price",
                    "scope": scope,
                    "ticker": record.ticker,
                    "as_of": session.close_utc,
                    "price": record.adjusted_close,
                    "stale": record.is_stale,
                },
            )
        cls._require_uniform_version(records, "price")
        return result

    @classmethod
    def _validate_survivorship(
        cls,
        facts: tuple[SourceFact, ...],
        scope: MarketScope,
        session: CalendarSession,
    ) -> None:
        if not facts:
            raise ReplayInputError("survivorship evidence is required")
        for fact in facts:
            cls._validate_fact(fact, session.close_utc)
            cls._validate_fact_payload(
                fact,
                {
                    "kind": "survivorship",
                    "market_scope": scope,
                    "as_of": session.close_utc,
                    "retains_delisted": True,
                },
            )
        if len({fact.source_version for fact in facts}) != 1:
            raise ReplayInputError(
                "survivorship source_version must be uniform"
            )

    @staticmethod
    def _unique_records(records, tickers, label):
        if not isinstance(records, tuple):
            raise ReplayInputError(f"{label} records must be a tuple")
        mapping = {record.ticker: record for record in records}
        if len(mapping) != len(records) or set(mapping) != set(tickers):
            raise ReplayInputError(f"{label} records must cover universe exactly")
        return mapping

    @staticmethod
    def _require_uniform_version(records, label: str) -> None:
        if len({record.fact.source_version for record in records}) != 1:
            raise ReplayInputError(
                f"{label} source_version must be uniform"
            )

    @staticmethod
    def _validate_fact_payload(
        fact: SourceFact, expected: Mapping[str, object]
    ) -> None:
        if not isinstance(fact.payload, Mapping):
            raise ReplayInputError("source fact payload must be an object")
        mismatches = [
            field
            for field, value in expected.items()
            if fact.payload.get(field) != value
        ]
        if mismatches:
            raise ReplayInputError(
                "source fact typed payload mismatch: "
                + ", ".join(mismatches)
            )

    @classmethod
    def _validate_fact(cls, fact: SourceFact, cutoff: str) -> None:
        if (
            not isinstance(fact.source_kind, str)
            or not fact.source_kind
            or not isinstance(fact.source_document_id, str)
            or not fact.source_document_id
            or not isinstance(fact.source_version, str)
            or not fact.source_version
        ):
            raise ReplayInputError("source fact identity/version is required")
        effective = cls._parse_utc(fact.effective_at_utc)
        available = cls._parse_utc(fact.available_at_utc)
        close = cls._parse_utc(cutoff)
        if not effective <= available <= close:
            raise ReplayInputError("source fact violates PIT cutoff")
        if fact.fact_hash != cls._hash(fact.payload):
            raise ReplayInputError("source fact hash mismatch")

    @staticmethod
    def _validate_calendar(
        calendar: MarketCalendar, scope: MarketScope
    ) -> None:
        if (
            calendar.market_scope != scope
            or calendar.window_start != WINDOW_START
            or calendar.window_end != WINDOW_END
            or calendar.synthetic is not True
            or calendar.disclaimer != SYNTHETIC_DISCLAIMER
            or not isinstance(calendar.fixture_hash, str)
            or len(calendar.fixture_hash) != 64
            or any(
                character not in "0123456789abcdef"
                for character in calendar.fixture_hash
            )
        ):
            raise ReplayInputError("calendar header mismatch")
        if len(calendar.sessions) != EXPECTED_SESSIONS:
            raise ReplayInputError("calendar session count mismatch")
        if sum(session.is_checkpoint for session in calendar.sessions) != (
            EXPECTED_CHECKPOINTS
        ):
            raise ReplayInputError("calendar checkpoint count mismatch")
        if not calendar.sessions[0].is_checkpoint:
            raise ReplayInputError("first session must be a checkpoint")
        dates = [session.trade_date for session in calendar.sessions]
        closes = [session.close_utc for session in calendar.sessions]
        if dates != sorted(dates) or closes != sorted(closes):
            raise ReplayInputError("calendar sessions must be ordered")
        for session in calendar.sessions:
            if session.market_scope != scope:
                raise ReplayInputError("calendar session scope mismatch")
            SixMonthReplayEngine._parse_date(session.trade_date)
            SixMonthReplayEngine._parse_utc(session.close_utc)

    @staticmethod
    def _validate_pair(profile, scope) -> None:
        if (
            profile not in PROFILE_MARKET_SCOPES
            or scope not in PROFILE_MARKET_SCOPES[profile]
        ):
            raise ReplayPairError("profile and market_scope are incompatible")

    @staticmethod
    def _validate_cost_model(cost: CostModel) -> None:
        if (
            cost.initial_nav != 1.0
            or cost.commission_bps_per_side != 5
            or cost.slippage_bps_per_side != 5
            or cost.risk_free_annual != 0.0
            or cost.annualization_sessions != 252
            or not isinstance(cost.version, str)
            or not cost.version
        ):
            raise ReplayInputError("cost model does not match frozen plan")

    @staticmethod
    def _parse_utc(value: str) -> dt.datetime:
        if not isinstance(value, str) or not value.endswith("Z"):
            raise ReplayInputError("timestamp must be ISO8601 UTC")
        try:
            parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError as error:
            raise ReplayInputError("timestamp must be ISO8601 UTC") from error
        if parsed.microsecond != 0 or value != parsed.strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ):
            raise ReplayInputError("timestamp must be UTC seconds")
        return parsed

    @staticmethod
    def _parse_date(value: str) -> dt.date:
        try:
            parsed = dt.date.fromisoformat(value)
        except (TypeError, ValueError) as error:
            raise ReplayInputError("trade_date must be YYYY-MM-DD") from error
        if value != parsed.isoformat():
            raise ReplayInputError("trade_date must be canonical")
        return parsed

    @staticmethod
    def _hash(value: object) -> str:
        return hashlib.sha256(
            jcs_canonicalize(value).encode("utf-8")
        ).hexdigest()
