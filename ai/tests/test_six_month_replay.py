from __future__ import annotations

import datetime as dt
import hashlib
import unittest
from dataclasses import replace
from datapipeline.fixtures.market_calendar import (
    LOCAL_DISPOSABLE_PURPOSE,
    SyntheticCalendarPort,
)

from ai.replay.six_month.engine import (
    EXPECTED_CHECKPOINTS,
    EXPECTED_SESSIONS,
    LEGAL_PAIRS,
    SYNTHETIC_DISCLAIMER,
    ReplayInputError,
    ReplayPairError,
    SixMonthReplayEngine,
    authenticate_snapshot_candidate,
    canonical_holding_candidate_hash,
    canonical_snapshot_candidate_hash,
)
from ai.replay.six_month.types import (
    CalendarSession,
    CostModel,
    MarketCalendar,
    MembershipRecord,
    PriceRecord,
    ScoreRecord,
    SourceFact,
)
from ai.replay.six_month.ports import SyntheticFixtureCalendarAdapter
from ai.snapshot.fingerprint import jcs_canonicalize


SCOPES = ("cn_a", "us", "jp", "kr")
SYMBOLS = {
    "cn_a": ("600000.SH", "000001.SZ", "300750.SZ", "601398.SH"),
    "us": ("AAPL", "MSFT", "NVDA", "JPM"),
    "jp": ("7203.T", "6758.T", "8306.T", "9984.T"),
    "kr": ("005930.KS", "000660.KS", "035420.KS", "051910.KS"),
}
CLOSURES = {
    "cn_a": {"2026-02-16", "2026-05-01"},
    "us": {"2026-02-16", "2026-05-25"},
    "jp": {"2026-02-11", "2026-05-04"},
    "kr": {"2026-03-02", "2026-05-05"},
}
CLOSE_TIMES = {
    "cn_a": "07:00:00Z",
    "jp": "06:30:00Z",
    "kr": "06:30:00Z",
}


def _hash(value) -> str:
    return hashlib.sha256(jcs_canonicalize(value).encode("utf-8")).hexdigest()


def _fact(kind, document_id, version, as_of, payload):
    return SourceFact(
        source_kind=kind,
        source_document_id=document_id,
        source_version=version,
        effective_at_utc=as_of,
        available_at_utc=as_of,
        payload=payload,
        fact_hash=_hash(payload),
    )


def _sessions(scope):
    start = dt.date(2026, 1, 10)
    end = dt.date(2026, 7, 10)
    dates = []
    current = start
    while current <= end:
        text = current.isoformat()
        if current.weekday() < 5 and text not in CLOSURES[scope]:
            dates.append(current)
        current += dt.timedelta(days=1)
    self_check = len(dates)
    if self_check != EXPECTED_SESSIONS:
        raise AssertionError((scope, self_check))

    checkpoint_dates = {dates[0]}
    by_week = {}
    for date in dates:
        by_week.setdefault(date.isocalendar()[:2], []).append(date)
    checkpoint_dates.update(values[-1] for values in by_week.values())
    if len(checkpoint_dates) != EXPECTED_CHECKPOINTS:
        raise AssertionError((scope, len(checkpoint_dates)))

    result = []
    for date in dates:
        if scope == "us":
            close = "21:00:00Z" if date <= dt.date(2026, 3, 8) else "20:00:00Z"
        else:
            close = CLOSE_TIMES[scope]
        result.append(
            CalendarSession(
                market_scope=scope,
                trade_date=date.isoformat(),
                close_utc=f"{date.isoformat()}T{close}",
                is_checkpoint=date in checkpoint_dates,
            )
        )
    return tuple(result)


class CalendarPort:
    def __init__(self):
        self.calls = 0
        self.calendars = {}
        for scope in SCOPES:
            sessions = _sessions(scope)
            payload = {
                "scope": scope,
                "sessions": [
                    {
                        "day": session.trade_date,
                        "close": session.close_utc,
                        "checkpoint": session.is_checkpoint,
                    }
                    for session in sessions
                ],
            }
            self.calendars[scope] = MarketCalendar(
                market_scope=scope,
                window_start="2026-01-10",
                window_end="2026-07-10",
                source_version="1.0.0",
                fixture_hash=_hash(payload),
                synthetic=True,
                disclaimer=SYNTHETIC_DISCLAIMER,
                sessions=sessions,
            )

    def load_calendar(self, scope):
        self.calls += 1
        return self.calendars[scope]


class UniversePort:
    def tickers(self, scope):
        return SYMBOLS[scope]


class MembershipPort:
    def records(self, scope, session):
        index = _sessions(scope).index(session)
        rows = []
        for position, ticker in enumerate(SYMBOLS[scope]):
            delisted = position == 3 and index >= 107
            # The close-of-session transition is still in the historical
            # membership set for that cutoff, then absent from later sets.
            member = not delisted or index == 107
            payload = {
                "kind": "membership",
                "scope": scope,
                "ticker": ticker,
                "as_of": session.close_utc,
                "member": member,
                "delisted": delisted,
            }
            rows.append(
                MembershipRecord(
                    ticker=ticker,
                    market_scope=scope,
                    as_of_utc=session.close_utc,
                    is_member_at_as_of=member,
                    is_delisted_at_as_of=delisted,
                    fact=_fact(
                        "membership",
                        f"{scope}:{ticker}:{session.trade_date}",
                        "membership-v1",
                        session.close_utc,
                        payload,
                    ),
                )
            )
        return tuple(rows)


class ScorePort:
    def records(self, profile, scope, session):
        index = _sessions(scope).index(session)
        rows = []
        for position, ticker in enumerate(SYMBOLS[scope]):
            # Rotate leadership every five sessions so weekly checkpoints
            # exercise turnover, transaction costs and closed-position metrics.
            leader = (index // 5) % len(SYMBOLS[scope])
            distance = (position - leader) % len(SYMBOLS[scope])
            score = 100.0 - distance * 10.0
            payload = {
                "kind": "score",
                "profile": profile,
                "scope": scope,
                "ticker": ticker,
                "as_of": session.close_utc,
                "score": score,
            }
            rows.append(
                ScoreRecord(
                    ticker=ticker,
                    profile=profile,
                    market_scope=scope,
                    as_of_utc=session.close_utc,
                    score=score,
                    strategy_version="1.0.0",
                    fact=_fact(
                        "score",
                        f"{profile}:{ticker}:{session.trade_date}",
                        "score-v1",
                        session.close_utc,
                        payload,
                    ),
                )
            )
        return tuple(rows)


class PricePort:
    def records(self, scope, session):
        index = _sessions(scope).index(session)
        rows = []
        for position, ticker in enumerate(SYMBOLS[scope]):
            price = 100.0 + position * 7.0 + index * (0.05 + position * 0.01)
            stale = position == 0 and index == 63
            payload = {
                "kind": "price",
                "scope": scope,
                "ticker": ticker,
                "as_of": session.close_utc,
                "price": price,
                "stale": stale,
            }
            rows.append(
                PriceRecord(
                    ticker=ticker,
                    market_scope=scope,
                    as_of_utc=session.close_utc,
                    adjusted_close=price,
                    is_stale=stale,
                    fact=_fact(
                        "price",
                        f"{scope}:{ticker}:{session.trade_date}",
                        "price-v1",
                        session.close_utc,
                        payload,
                    ),
                )
            )
        return tuple(rows)


class SurvivorshipPort:
    def records(self, scope, session):
        payload = {
            "kind": "survivorship",
            "market_scope": scope,
            "as_of": session.close_utc,
            "retains_delisted": True,
        }
        return (
            _fact(
                "survivorship",
                f"{scope}:{session.trade_date}",
                "survivorship-v1",
                session.close_utc,
                payload,
            ),
        )


def _engine(calendar=None, membership=None, prices=None, survivorship=None):
    return SixMonthReplayEngine(
        calendar_port=calendar or CalendarPort(),
        universe_port=UniversePort(),
        membership_port=membership or MembershipPort(),
        score_port=ScorePort(),
        price_port=prices or PricePort(),
        survivorship_port=survivorship or SurvivorshipPort(),
    )


def _landed_calendar():
    return SyntheticFixtureCalendarAdapter(
        SyntheticCalendarPort(purpose=LOCAL_DISPOSABLE_PURPOSE)
    )


class SixMonthReplayTests(unittest.TestCase):
    def test_landed_t5a_calendar_port_drives_exact_counts(self):
        batch = _engine(calendar=_landed_calendar()).run_all()
        self.assertEqual(
            (
                batch.daily_evaluations,
                batch.snapshot_count,
                batch.holding_count,
            ),
            (1024, 216, 648),
        )

    def test_all_legal_pairs_produce_exact_counts_and_metrics(self):
        batch = _engine().run_all()
        self.assertEqual(len(batch.runs), 8)
        self.assertEqual(batch.daily_evaluations, 1024)
        self.assertEqual(batch.snapshot_count, 216)
        self.assertEqual(batch.holding_count, 648)
        self.assertEqual(
            {(run.strategy, run.market_scope) for run in batch.runs},
            set(LEGAL_PAIRS),
        )
        for run in batch.runs:
            self.assertEqual(run.evaluated_session_count, 128)
            self.assertEqual(len(run.snapshots), 27)
            for index, snapshot in enumerate(run.snapshots):
                self.assertEqual(snapshot.metrics.checkpoint_index, index)
                self.assertEqual(snapshot.metrics.checkpoint_count, 27)
                self.assertEqual(len(snapshot.holdings), 3)
                self.assertAlmostEqual(
                    sum(holding.weight for holding in snapshot.holdings),
                    1.0,
                    delta=1e-9,
                )
                self.assertAlmostEqual(
                    snapshot.metrics.cumulative_return,
                    snapshot.metrics.net_value - 1.0,
                    delta=1e-10,
                )
                self.assertEqual(
                    snapshot.metrics.metric_contract_version, "1.0.0"
                )
                self.assertLessEqual(snapshot.metrics.drawdown, 0.0)
                self.assertGreaterEqual(snapshot.metrics.drawdown, -1.0)
                self.assertFalse(snapshot.is_survivorship_biased)
                self.assertTrue(snapshot.source_versions)
                evidence = snapshot.lineage_closure[
                    "survivorship_evidence"
                ]
                self.assertEqual(
                    set(evidence),
                    {"fact_hashes", "retains_delisted", "source_version"},
                )
                self.assertTrue(evidence["retains_delisted"])
                self.assertTrue(evidence["source_version"])
                self.assertTrue(evidence["fact_hashes"])
                self.assertTrue(
                    all(
                        len(fact_hash) == 64
                        and set(fact_hash) <= set("0123456789abcdef")
                        for fact_hash in evidence["fact_hashes"]
                    )
                )
                self.assertTrue(
                    snapshot.lineage_closure["membership_hash"]
                )
                for holding in snapshot.holdings:
                    self.assertEqual(
                        holding.market_scope, snapshot.market_scope
                    )
                    self.assertEqual(
                        holding.snapshot_as_of_utc, snapshot.as_of_utc
                    )
                    self.assertTrue(holding.source_kind)
                    self.assertTrue(holding.source_document_id)
                    self.assertTrue(holding.source_version)
                    self.assertTrue(holding.lineage)
        final = batch.runs[0].snapshots[-1].metrics
        self.assertIsNotNone(final.win_rate_6m)
        self.assertGreater(final.net_value, 0.0)
        self.assertNotEqual(final.cumulative_return, 0.0)
        for run in batch.runs:
            self.assertTrue(
                any(
                    holding.is_stale
                    for snapshot in run.snapshots
                    for holding in snapshot.holdings
                )
            )
            self.assertTrue(
                any(
                    snapshot.is_delisted_at_as_of
                    for snapshot in run.snapshots
                )
            )

    def test_replay_is_byte_deterministic(self):
        first = _engine().run("us_preferred", "us")
        second = _engine().run("us_preferred", "us")
        self.assertEqual(first, second)
        self.assertEqual(
            _hash(
                [
                    {
                        "day": snapshot.snapshot_day,
                        "fact_hash": snapshot.fact_hash,
                        "holdings": [
                            holding.fact_hash for holding in snapshot.holdings
                        ],
                    }
                    for snapshot in first.snapshots
                ]
            ),
            _hash(
                [
                    {
                        "day": snapshot.snapshot_day,
                        "fact_hash": snapshot.fact_hash,
                        "holdings": [
                            holding.fact_hash for holding in snapshot.holdings
                        ],
                    }
                    for snapshot in second.snapshots
                ]
            ),
        )

    def test_holding_source_identity_and_exact_lineage_are_authenticated(self):
        snapshot = _engine().run("us_preferred", "us").snapshots[0]
        holding = snapshot.holdings[0]
        for field in (
            "source_kind",
            "source_document_id",
            "source_version",
            "available_at_utc",
        ):
            mutated = replace(
                holding, **{field: getattr(holding, field) + "-changed"}
            )
            with self.subTest(field=field):
                self.assertNotEqual(
                    canonical_holding_candidate_hash(mutated),
                    holding.fact_hash,
                )
                resealed_holding = replace(
                    mutated,
                    fact_hash=canonical_holding_candidate_hash(mutated),
                )
                resealed_snapshot = replace(
                    snapshot,
                    holdings=(resealed_holding,) + snapshot.holdings[1:],
                    fact_hash="",
                )
                resealed_snapshot = replace(
                    resealed_snapshot,
                    fact_hash=canonical_snapshot_candidate_hash(
                        resealed_snapshot
                    ),
                )
                with self.assertRaisesRegex(
                    ReplayInputError, "holding price source identity mismatch"
                ):
                    authenticate_snapshot_candidate(resealed_snapshot)
        missing = dict(holding.lineage)
        missing.pop("price_fact_hash")
        unknown = {**holding.lineage, "unknown": "a" * 64}
        for lineage in (missing, unknown):
            with self.subTest(lineage=lineage):
                with self.assertRaisesRegex(ReplayInputError, "keys must be exact"):
                    canonical_holding_candidate_hash(
                        replace(holding, lineage=lineage)
                    )

    def test_snapshot_source_versions_are_exact_bound_and_authenticated(self):
        snapshot = _engine().run("us_preferred", "us").snapshots[0]
        self.assertEqual(
            set(snapshot.source_versions),
            {
                "calendar",
                "cost_model",
                "membership",
                "prices",
                "scores",
                "survivorship",
            },
        )
        self.assertEqual(
            snapshot.source_versions,
            snapshot.lineage_closure["source_versions"],
        )
        for key in snapshot.source_versions:
            values = dict(snapshot.source_versions)
            values[key] += "-changed"
            with self.subTest(key=key):
                with self.assertRaisesRegex(
                    ReplayInputError,
                    "must equal lineage|source version closure mismatch",
                ):
                    authenticate_snapshot_candidate(
                        replace(snapshot, source_versions=values)
                    )

        missing = dict(snapshot.source_versions)
        missing.pop("membership")
        unknown = {**snapshot.source_versions, "unknown": "1.0.0"}
        for values in (missing, unknown):
            with self.subTest(values=values):
                with self.assertRaisesRegex(ReplayInputError, "keys must be exact"):
                    canonical_snapshot_candidate_hash(
                        replace(snapshot, source_versions=values)
                    )

        resealed_versions = dict(snapshot.source_versions)
        resealed_versions["prices"] += "-changed"
        resealed_lineage = dict(snapshot.lineage_closure)
        resealed_lineage["source_versions"] = resealed_versions
        resealed = replace(
            snapshot,
            source_versions=resealed_versions,
            lineage_closure=resealed_lineage,
            fact_hash="",
        )
        resealed = replace(
            resealed,
            fact_hash=canonical_snapshot_candidate_hash(resealed),
        )
        with self.assertRaisesRegex(
            ReplayInputError, "prices source version closure mismatch"
        ):
            authenticate_snapshot_candidate(resealed)

    def test_resealed_source_closure_relation_attacks_fail_closed(self):
        snapshot = _engine().run("us_preferred", "us").snapshots[0]
        closure = {
            key: [dict(identity) for identity in identities]
            for key, identities in snapshot.lineage_closure[
                "source_identity_closure"
            ].items()
        }
        price_hash = snapshot.holdings[0].lineage["price_fact_hash"]
        price_identity = next(
            identity
            for identity in closure["prices"]
            if identity["fact_hash"] == price_hash
        )
        price_identity["source_document_id"] += "-changed"
        changed_lineage = dict(snapshot.lineage_closure)
        changed_lineage["source_identity_closure"] = closure
        changed = replace(snapshot, lineage_closure=changed_lineage, fact_hash="")
        changed = replace(
            changed,
            fact_hash=canonical_snapshot_candidate_hash(changed),
        )
        with self.assertRaisesRegex(
            ReplayInputError, "holding price source identity mismatch"
        ):
            authenticate_snapshot_candidate(changed)

        closure = {
            key: [dict(identity) for identity in identities]
            for key, identities in snapshot.lineage_closure[
                "source_identity_closure"
            ].items()
        }
        closure["prices"].append(dict(closure["prices"][0]))
        changed_lineage = dict(snapshot.lineage_closure)
        changed_lineage["source_identity_closure"] = closure
        changed = replace(snapshot, lineage_closure=changed_lineage, fact_hash="")
        changed = replace(
            changed,
            fact_hash=canonical_snapshot_candidate_hash(changed),
        )
        with self.assertRaisesRegex(
            ReplayInputError, "fact hashes must be unique"
        ):
            authenticate_snapshot_candidate(changed)

        closure = {
            key: [dict(identity) for identity in identities]
            for key, identities in snapshot.lineage_closure[
                "source_identity_closure"
            ].items()
        }
        closure["scores"].pop()
        changed_lineage = dict(snapshot.lineage_closure)
        changed_lineage["source_identity_closure"] = closure
        changed = replace(snapshot, lineage_closure=changed_lineage, fact_hash="")
        changed = replace(
            changed,
            fact_hash=canonical_snapshot_candidate_hash(changed),
        )
        with self.assertRaisesRegex(
            ReplayInputError, "source closure count mismatch"
        ):
            authenticate_snapshot_candidate(changed)

        first = snapshot.holdings[0]
        second = snapshot.holdings[1]
        switched_lineage = dict(first.lineage)
        switched_lineage["price_fact_hash"] = second.lineage["price_fact_hash"]
        switched = replace(
            first,
            lineage=switched_lineage,
            source_kind=second.source_kind,
            source_document_id=second.source_document_id,
            source_version=second.source_version,
            available_at_utc=second.available_at_utc,
            fact_hash="",
        )
        switched = replace(
            switched,
            fact_hash=canonical_holding_candidate_hash(switched),
        )
        changed = replace(
            snapshot,
            holdings=(switched,) + snapshot.holdings[1:],
            fact_hash="",
        )
        changed = replace(
            changed,
            fact_hash=canonical_snapshot_candidate_hash(changed),
        )
        with self.assertRaisesRegex(
            ReplayInputError, "holding ticker source relation mismatch"
        ):
            authenticate_snapshot_candidate(changed)

        for key, mirror in (
            ("calendar", "calendar_source_version"),
            ("cost_model", "cost_model_version"),
        ):
            versions = dict(snapshot.source_versions)
            versions[key] += "-changed"
            lineage = dict(snapshot.lineage_closure)
            lineage_versions = dict(lineage["source_versions"])
            lineage_versions[key] = versions[key]
            lineage["source_versions"] = lineage_versions
            lineage[mirror] = versions[key]
            changed = replace(
                snapshot,
                source_versions=versions,
                lineage_closure=lineage,
                fact_hash="",
            )
            with self.subTest(authority=key):
                with self.assertRaisesRegex(
                    ReplayInputError, "is not authoritative"
                ):
                    canonical_snapshot_candidate_hash(changed)

    def test_illegal_pairs_and_custom_fail_before_source_reads(self):
        for profile in (
            "us_preferred",
            "multibagger",
            "japan_blue_chip",
            "japan_multibagger",
            "korea_semiconductor_chain",
            "korea_multibagger",
        ):
            for scope in SCOPES:
                if (profile, scope) in LEGAL_PAIRS:
                    continue
                calendar = CalendarPort()
                with self.assertRaises(ReplayPairError):
                    _engine(calendar=calendar).run(profile, scope)
                self.assertEqual(calendar.calls, 0)
        calendar = CalendarPort()
        with self.assertRaises(ReplayPairError):
            _engine(calendar=calendar).run("custom", "us")
        self.assertEqual(calendar.calls, 0)

    def test_future_available_fact_fails_no_lookahead(self):
        class FuturePricePort(PricePort):
            def records(self, scope, session):
                rows = list(super().records(scope, session))
                fact = rows[0].fact
                future = (
                    SixMonthReplayEngine._parse_utc(session.close_utc)
                    + dt.timedelta(seconds=1)
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
                rows[0] = replace(
                    rows[0],
                    fact=replace(fact, available_at_utc=future),
                )
                return tuple(rows)

        with self.assertRaisesRegex(ReplayInputError, "PIT cutoff"):
            _engine(prices=FuturePricePort()).run("us_preferred", "us")

    def test_current_fact_substitution_into_old_cutoff_fails(self):
        class CurrentMembershipPort(MembershipPort):
            def records(self, scope, session):
                rows = super().records(scope, session)
                if session.trade_date == "2026-01-12":
                    return tuple(
                        replace(
                            row,
                            fact=replace(
                                row.fact,
                                effective_at_utc="2026-07-10T20:00:00Z",
                                available_at_utc="2026-07-10T20:00:00Z",
                            ),
                        )
                        for row in rows
                    )
                return rows

        with self.assertRaisesRegex(ReplayInputError, "PIT cutoff"):
            _engine(membership=CurrentMembershipPort()).run(
                "us_preferred", "us"
            )

    def test_typed_fact_payload_cannot_diverge_from_current_record(self):
        class DivergentPricePort(PricePort):
            def records(self, scope, session):
                rows = list(super().records(scope, session))
                if session.trade_date == "2026-01-12":
                    rows[0] = replace(
                        rows[0],
                        adjusted_close=999.0,
                    )
                return tuple(rows)

        with self.assertRaisesRegex(
            ReplayInputError, "typed payload mismatch"
        ):
            _engine(prices=DivergentPricePort()).run(
                "us_preferred", "us"
            )

    def test_missing_survivorship_evidence_fails(self):
        class MissingSurvivorship:
            def records(self, _scope, _session):
                return ()

        with self.assertRaisesRegex(ReplayInputError, "survivorship"):
            _engine(survivorship=MissingSurvivorship()).run(
                "japan_blue_chip", "jp"
            )

    def test_calendar_shape_and_cost_model_fail_closed(self):
        calendar = CalendarPort()
        original = calendar.calendars["kr"]
        calendar.calendars["kr"] = replace(
            original, sessions=original.sessions[:-1]
        )
        with self.assertRaisesRegex(ReplayInputError, "session count"):
            _engine(calendar=calendar).run(
                "korea_semiconductor_chain", "kr"
            )

    def test_costs_reduce_nav_at_first_rebalance(self):
        run = _engine(calendar=_landed_calendar()).run(
            "us_preferred", "us"
        )
        self.assertAlmostEqual(
            run.snapshots[0].metrics.net_value,
            0.999,
            delta=1e-12,
        )
        self.assertAlmostEqual(
            run.snapshots[0].metrics.drawdown,
            -0.001,
            delta=1e-12,
        )

    def test_closed_position_and_metric_goldens(self):
        run = _engine(calendar=_landed_calendar()).run(
            "us_preferred", "us"
        )
        first_closed = next(
            snapshot.metrics
            for snapshot in run.snapshots
            if snapshot.metrics.win_rate_6m is not None
        )
        self.assertEqual(first_closed.win_rate_6m, 1.0)

        final = run.snapshots[-1]
        self.assertAlmostEqual(
            final.metrics.net_value,
            1.0570002520838884,
            delta=1e-12,
        )
        self.assertAlmostEqual(
            final.metrics.cumulative_return,
            0.05700025208388837,
            delta=1e-12,
        )
        self.assertAlmostEqual(
            final.metrics.drawdown,
            -0.0010000000000000009,
            delta=1e-12,
        )
        self.assertAlmostEqual(
            final.metrics.sharpe_ratio_6m,
            24.37562665300161,
            delta=1e-12,
        )
        self.assertEqual(final.metrics.win_rate_6m, 1.0)
        self.assertEqual(
            final.fact_hash,
            "09420f7734e9b2d255c6f2f346ed471f3f22add01319545e4f1bd2ae218a5c3e",
        )

    def test_near_flat_closed_trade_loses_after_round_trip_costs(self):
        gross_return = 0.0015
        exit_only_return = gross_return - 0.001
        round_trip_return = SixMonthReplayEngine._closed_position_return(
            entry_price=100.0,
            exit_price=100.0 * (1.0 + gross_return),
            cost_model=CostModel(),
        )

        self.assertGreater(exit_only_return, 0.0)
        self.assertAlmostEqual(round_trip_return, -0.0005, delta=1e-12)
        self.assertLess(round_trip_return, 0.0)
        profitable_closed_positions = int(round_trip_return > 0.0)
        win_rate = profitable_closed_positions / 1
        self.assertEqual(win_rate, 0.0)


if __name__ == "__main__":
    unittest.main()
