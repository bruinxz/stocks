from __future__ import annotations

import datetime as dt
import hashlib
import math
import statistics
from dataclasses import asdict, replace
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
CALENDAR_SOURCE_VERSION = "1.0.0"
COST_MODEL_VERSION = "synthetic-cost-v1"
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
HOLDING_LINEAGE_KEYS = frozenset(
    ("membership_fact_hash", "price_fact_hash", "score_fact_hash")
)
SNAPSHOT_SOURCE_VERSION_KEYS = frozenset(
    ("calendar", "cost_model", "membership", "prices", "scores", "survivorship")
)
SOURCE_IDENTITY_CLOSURE_KEYS = frozenset(
    ("membership", "prices", "scores", "survivorship")
)
SOURCE_IDENTITY_EXPECTED_COUNTS = {
    "membership": 4,
    "prices": 4,
    "scores": 4,
    "survivorship": 1,
}
SOURCE_IDENTITY_KEYS = frozenset(
    (
        "available_at_utc",
        "effective_at_utc",
        "fact_hash",
        "source_document_id",
        "source_kind",
        "source_version",
    )
)
HEX = frozenset("0123456789abcdef")


class SixMonthReplayError(RuntimeError):
    pass


class ReplayPairError(SixMonthReplayError):
    pass


class ReplayInputError(SixMonthReplayError):
    pass


def _require_exact_string_map(
    value: object, expected: frozenset[str], field: str
) -> Mapping[str, str]:
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ReplayInputError(f"{field} keys must be exact")
    if any(
        not isinstance(item, str) or not item or item.isspace()
        for item in value.values()
    ):
        raise ReplayInputError(f"{field} values must be non-empty strings")
    return value


def _source_identity(fact: SourceFact) -> Mapping[str, str]:
    return {
        "available_at_utc": fact.available_at_utc,
        "effective_at_utc": fact.effective_at_utc,
        "fact_hash": fact.fact_hash,
        "source_document_id": fact.source_document_id,
        "source_kind": fact.source_kind,
        "source_version": fact.source_version,
    }


def _require_sha256(value: object, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in HEX for character in value)
    ):
        raise ReplayInputError(f"{field} must be lowercase SHA-256")
    return value


def _require_source_identities(
    value: object, field: str
) -> tuple[Mapping[str, str], ...]:
    if not isinstance(value, (list, tuple)) or not value:
        raise ReplayInputError(f"{field} must be a non-empty array")
    result = []
    hashes = []
    for index, identity in enumerate(value):
        checked = _require_exact_string_map(
            identity, SOURCE_IDENTITY_KEYS, f"{field}[{index}]"
        )
        SixMonthReplayEngine._parse_utc(checked["effective_at_utc"])
        SixMonthReplayEngine._parse_utc(checked["available_at_utc"])
        if (
            SixMonthReplayEngine._parse_utc(checked["effective_at_utc"])
            > SixMonthReplayEngine._parse_utc(checked["available_at_utc"])
        ):
            raise ReplayInputError(f"{field} source time order is invalid")
        hashes.append(_require_sha256(checked["fact_hash"], f"{field} fact_hash"))
        result.append(checked)
    if len(set(hashes)) != len(hashes):
        raise ReplayInputError(f"{field} fact hashes must be unique")
    if hashes != sorted(hashes):
        raise ReplayInputError(f"{field} identities must be fact-hash ordered")
    return tuple(result)


def _holding_payload(holding: HoldingCandidate) -> Mapping[str, object]:
    lineage = _require_exact_string_map(
        holding.lineage, HOLDING_LINEAGE_KEYS, "holding lineage"
    )
    for key, value in lineage.items():
        _require_sha256(value, f"holding lineage {key}")
    for value in (
        holding.source_kind,
        holding.source_document_id,
        holding.source_version,
        holding.available_at_utc,
    ):
        if not isinstance(value, str) or not value or value.isspace():
            raise ReplayInputError("holding source identity/version is required")
    return {
        "available_at_utc": holding.available_at_utc,
        "current_price": holding.current_price,
        "entry_price": holding.entry_price,
        "is_delisted_at_as_of": holding.is_delisted_at_as_of,
        "is_stale": holding.is_stale,
        "lineage": dict(lineage),
        "market_scope": holding.market_scope,
        "position_order": holding.position_order,
        "return_since_entry": holding.return_since_entry,
        "snapshot_as_of_utc": holding.snapshot_as_of_utc,
        "source_document_id": holding.source_document_id,
        "source_kind": holding.source_kind,
        "source_version": holding.source_version,
        "ticker": holding.ticker,
        "weight": holding.weight,
    }


def canonical_holding_candidate_hash(holding: HoldingCandidate) -> str:
    return SixMonthReplayEngine._hash(_holding_payload(holding))


def _snapshot_payload(snapshot: SnapshotCandidate) -> Mapping[str, object]:
    source_versions = _require_exact_string_map(
        snapshot.source_versions,
        SNAPSHOT_SOURCE_VERSION_KEYS,
        "snapshot source_versions",
    )
    lineage_versions = _require_exact_string_map(
        snapshot.lineage_closure.get("source_versions"),
        SNAPSHOT_SOURCE_VERSION_KEYS,
        "lineage source_versions",
    )
    if dict(source_versions) != dict(lineage_versions):
        raise ReplayInputError(
            "snapshot source_versions must equal lineage source_versions"
        )
    if source_versions["cost_model"] != snapshot.lineage_closure.get(
        "cost_model_version"
    ):
        raise ReplayInputError("cost model source version mismatch")
    if source_versions["calendar"] != snapshot.lineage_closure.get(
        "calendar_source_version"
    ):
        raise ReplayInputError("calendar source version mismatch")
    if source_versions["calendar"] != CALENDAR_SOURCE_VERSION:
        raise ReplayInputError("calendar source version is not authoritative")
    if source_versions["cost_model"] != COST_MODEL_VERSION:
        raise ReplayInputError("cost model source version is not authoritative")
    survivorship = snapshot.lineage_closure.get("survivorship_evidence")
    if (
        not isinstance(survivorship, Mapping)
        or source_versions["survivorship"] != survivorship.get("source_version")
    ):
        raise ReplayInputError("survivorship source version mismatch")
    return {
        "as_of_utc": snapshot.as_of_utc,
        "holding_hashes": [holding.fact_hash for holding in snapshot.holdings],
        "is_delisted_at_as_of": snapshot.is_delisted_at_as_of,
        "is_survivorship_biased": snapshot.is_survivorship_biased,
        "lineage_closure": dict(snapshot.lineage_closure),
        "market_scope": snapshot.market_scope,
        "metrics": asdict(snapshot.metrics),
        "snapshot_day": snapshot.snapshot_day,
        "source_versions": dict(source_versions),
        "strategy": snapshot.strategy,
    }


def _validate_snapshot_source_closure(snapshot: SnapshotCandidate) -> None:
    source_versions = _require_exact_string_map(
        snapshot.source_versions,
        SNAPSHOT_SOURCE_VERSION_KEYS,
        "snapshot source_versions",
    )
    closure = snapshot.lineage_closure.get("source_identity_closure")
    if not isinstance(closure, Mapping) or set(closure) != SOURCE_IDENTITY_CLOSURE_KEYS:
        raise ReplayInputError("source identity closure keys must be exact")
    identities = {
        key: _require_source_identities(
            closure[key], f"source identity closure {key}"
        )
        for key in sorted(SOURCE_IDENTITY_CLOSURE_KEYS)
    }
    for key, expected_count in SOURCE_IDENTITY_EXPECTED_COUNTS.items():
        if len(identities[key]) != expected_count:
            raise ReplayInputError(f"{key} source closure count mismatch")
    all_hashes = [
        identity["fact_hash"]
        for key in sorted(identities)
        for identity in identities[key]
    ]
    if len(set(all_hashes)) != len(all_hashes):
        raise ReplayInputError("source closure fact hashes must be globally unique")
    as_of = SixMonthReplayEngine._parse_utc(snapshot.as_of_utc)
    if any(
        SixMonthReplayEngine._parse_utc(identity["available_at_utc"]) > as_of
        for key in identities
        for identity in identities[key]
    ):
        raise ReplayInputError("source identity exceeds snapshot PIT cutoff")
    for key in SOURCE_IDENTITY_CLOSURE_KEYS:
        versions = {identity["source_version"] for identity in identities[key]}
        if versions != {source_versions[key]}:
            raise ReplayInputError(f"{key} source version closure mismatch")

    membership_hashes = [
        identity["fact_hash"] for identity in identities["membership"]
    ]
    price_hashes = [identity["fact_hash"] for identity in identities["prices"]]
    score_hashes = [identity["fact_hash"] for identity in identities["scores"]]
    survivorship_hashes = [
        identity["fact_hash"] for identity in identities["survivorship"]
    ]
    ticker_sources = snapshot.lineage_closure.get("ticker_source_fact_hashes")
    if (
        not isinstance(ticker_sources, Mapping)
        or len(ticker_sources) != 4
        or any(
            not isinstance(ticker, str) or not ticker or ticker.isspace()
            for ticker in ticker_sources
        )
    ):
        raise ReplayInputError("ticker source fact map is invalid")
    ticker_sources = {
        ticker: _require_exact_string_map(
            value, HOLDING_LINEAGE_KEYS, f"ticker source facts {ticker}"
        )
        for ticker, value in ticker_sources.items()
    }
    for ticker, value in ticker_sources.items():
        for key, fact_hash in value.items():
            _require_sha256(fact_hash, f"ticker source facts {ticker}.{key}")
    if SixMonthReplayEngine._hash(sorted(ticker_sources)) != (
        snapshot.lineage_closure.get("universe_hash")
    ):
        raise ReplayInputError("ticker source map and universe hash mismatch")
    if {
        value["membership_fact_hash"] for value in ticker_sources.values()
    } != set(membership_hashes):
        raise ReplayInputError("ticker membership closure mismatch")
    if {
        value["price_fact_hash"] for value in ticker_sources.values()
    } != set(price_hashes):
        raise ReplayInputError("ticker price closure mismatch")
    if {
        value["score_fact_hash"] for value in ticker_sources.values()
    } != set(score_hashes):
        raise ReplayInputError("ticker score closure mismatch")
    if membership_hashes != snapshot.lineage_closure.get(
        "membership_fact_hashes"
    ):
        raise ReplayInputError("membership fact hash mirror mismatch")
    if SixMonthReplayEngine._hash(membership_hashes) != snapshot.lineage_closure.get(
        "membership_hash"
    ):
        raise ReplayInputError("membership aggregate hash mismatch")
    if price_hashes != snapshot.lineage_closure.get("price_fact_hashes"):
        raise ReplayInputError("price fact hash mirror mismatch")
    if score_hashes != snapshot.lineage_closure.get("score_fact_hashes"):
        raise ReplayInputError("score fact hash mirror mismatch")
    survivorship = snapshot.lineage_closure.get("survivorship_evidence")
    if (
        not isinstance(survivorship, Mapping)
        or survivorship_hashes != survivorship.get("fact_hashes")
    ):
        raise ReplayInputError("survivorship fact hash mirror mismatch")

    membership_by_hash = {
        identity["fact_hash"]: identity for identity in identities["membership"]
    }
    price_by_hash = {
        identity["fact_hash"]: identity for identity in identities["prices"]
    }
    score_by_hash = {
        identity["fact_hash"]: identity for identity in identities["scores"]
    }
    held_membership_hashes = set()
    held_price_hashes = set()
    held_score_hashes = set()
    for holding in snapshot.holdings:
        lineage = _require_exact_string_map(
            holding.lineage, HOLDING_LINEAGE_KEYS, "holding lineage"
        )
        if holding.ticker not in ticker_sources or dict(lineage) != dict(
            ticker_sources[holding.ticker]
        ):
            raise ReplayInputError("holding ticker source relation mismatch")
        membership_hash = lineage["membership_fact_hash"]
        price_hash = lineage["price_fact_hash"]
        score_hash = lineage["score_fact_hash"]
        if membership_hash not in membership_by_hash:
            raise ReplayInputError("holding membership fact is outside closure")
        if price_hash not in price_by_hash:
            raise ReplayInputError("holding price fact is outside closure")
        if score_hash not in score_by_hash:
            raise ReplayInputError("holding score fact is outside closure")
        price_identity = price_by_hash[price_hash]
        if (
            holding.source_kind != price_identity["source_kind"]
            or holding.source_document_id != price_identity["source_document_id"]
            or holding.source_version != price_identity["source_version"]
            or holding.available_at_utc != price_identity["available_at_utc"]
        ):
            raise ReplayInputError("holding price source identity mismatch")
        held_membership_hashes.add(membership_hash)
        held_price_hashes.add(price_hash)
        held_score_hashes.add(score_hash)
    if (
        held_membership_hashes - set(membership_hashes)
        or held_price_hashes - set(price_hashes)
        or held_score_hashes - set(score_hashes)
    ):
        raise ReplayInputError("holding source closure mismatch")


def canonical_snapshot_candidate_hash(snapshot: SnapshotCandidate) -> str:
    return SixMonthReplayEngine._hash(_snapshot_payload(snapshot))


def authenticate_snapshot_candidate(snapshot: SnapshotCandidate) -> None:
    _validate_snapshot_source_closure(snapshot)
    for holding in snapshot.holdings:
        if holding.fact_hash != canonical_holding_candidate_hash(holding):
            raise ReplayInputError("holding fact_hash is not authentic")
    if snapshot.fact_hash != canonical_snapshot_candidate_hash(snapshot):
        raise ReplayInputError("snapshot fact_hash is not authentic")


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
            holding_lineage = {
                "membership_fact_hash": member.fact.fact_hash,
                "price_fact_hash": price.fact.fact_hash,
                "score_fact_hash": scores[ticker].fact.fact_hash,
            }
            holding = HoldingCandidate(
                ticker=ticker,
                position_order=position_order,
                market_scope=market_scope,
                snapshot_as_of_utc=session.close_utc,
                weight=current_weights[ticker],
                entry_price=entry_prices[ticker],
                current_price=price.adjusted_close,
                return_since_entry=(
                    price.adjusted_close / entry_prices[ticker] - 1.0
                ),
                is_stale=price.is_stale,
                is_delisted_at_as_of=member.is_delisted_at_as_of,
                source_kind=price.fact.source_kind,
                source_document_id=price.fact.source_document_id,
                source_version=price.fact.source_version,
                available_at_utc=price.fact.available_at_utc,
                lineage=holding_lineage,
                fact_hash="",
            )
            holdings.append(
                replace(
                    holding,
                    fact_hash=canonical_holding_candidate_hash(holding),
                )
            )
        if abs(sum(holding.weight for holding in holdings) - 1.0) > 1e-9:
            raise ReplayInputError("holding weights must sum to one")
        source_versions = {
            "calendar": calendar.source_version,
            "cost_model": self._cost_model.version,
            "membership": membership[ordered_tickers[0]].fact.source_version,
            "prices": prices[ordered_tickers[0]].fact.source_version,
            "scores": scores[ordered_tickers[0]].fact.source_version,
            "survivorship": survivorship[0].source_version,
        }
        _require_exact_string_map(
            source_versions,
            SNAPSHOT_SOURCE_VERSION_KEYS,
            "snapshot source_versions",
        )
        membership_identities = sorted(
            (
                _source_identity(membership[ticker].fact)
                for ticker in membership
            ),
            key=lambda identity: identity["fact_hash"],
        )
        price_identities = sorted(
            (_source_identity(prices[ticker].fact) for ticker in prices),
            key=lambda identity: identity["fact_hash"],
        )
        score_identities = sorted(
            (_source_identity(scores[ticker].fact) for ticker in scores),
            key=lambda identity: identity["fact_hash"],
        )
        survivorship_identities = sorted(
            (_source_identity(fact) for fact in survivorship),
            key=lambda identity: identity["fact_hash"],
        )
        lineage = {
            "calendar_fixture_hash": calendar.fixture_hash,
            "calendar_source_version": calendar.source_version,
            "universe_hash": self._hash(sorted(membership)),
            "membership_hash": self._hash(
                [identity["fact_hash"] for identity in membership_identities]
            ),
            "membership_fact_hashes": [
                identity["fact_hash"] for identity in membership_identities
            ],
            "price_fact_hashes": [
                identity["fact_hash"] for identity in price_identities
            ],
            "score_fact_hashes": [
                identity["fact_hash"] for identity in score_identities
            ],
            "strategy_version": scores[ordered_tickers[0]].strategy_version,
            "cost_model_version": self._cost_model.version,
            "source_versions": source_versions,
            "source_identity_closure": {
                "membership": membership_identities,
                "prices": price_identities,
                "scores": score_identities,
                "survivorship": survivorship_identities,
            },
            "ticker_source_fact_hashes": {
                ticker: {
                    "membership_fact_hash": membership[ticker].fact.fact_hash,
                    "price_fact_hash": prices[ticker].fact.fact_hash,
                    "score_fact_hash": scores[ticker].fact.fact_hash,
                }
                for ticker in sorted(membership)
            },
            "survivorship_evidence": {
                "fact_hashes": [
                    identity["fact_hash"] for identity in survivorship_identities
                ],
                "retains_delisted": True,
                "source_version": survivorship[0].source_version,
            },
        }
        snapshot = SnapshotCandidate(
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
            source_versions=source_versions,
            fact_hash="",
        )
        snapshot = replace(
            snapshot,
            fact_hash=canonical_snapshot_candidate_hash(snapshot),
        )
        authenticate_snapshot_candidate(snapshot)
        return snapshot

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
            or calendar.source_version != CALENDAR_SOURCE_VERSION
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
            or cost.version != COST_MODEL_VERSION
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
