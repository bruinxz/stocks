"""Integration proof for the landed T5-B candidate contract.

This module imports T5-B directly after PR #246 lands on main. Until then,
reviewers may run it against that immutable worktree by extending the package
paths in the same process; the test itself intentionally has no copied replay
fixtures.
"""

from __future__ import annotations

from dataclasses import replace
import unittest

from ai.replay.six_month import (
    authenticate_snapshot_candidate,
    canonical_holding_candidate_hash,
    canonical_snapshot_candidate_hash,
)
from ai.replay.six_month.engine import LEGAL_PAIRS, ReplayInputError
from ai.snapshot.fingerprint import JCSCanonicalizationError
from ai.tests.test_six_month_replay import _engine, _landed_calendar

from datapipeline.storage.backtest_pit import (
    PitSnapshotWriter,
    convert_snapshot_candidate,
)
from datapipeline.tests.storage.backtest_pit.test_writer import FakePool


class ActualT5bCandidateIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_actual_candidates_write_rerun_and_readback(self) -> None:
        batch = _engine(calendar=_landed_calendar()).run_all()
        self.assertEqual(
            (batch.daily_evaluations, batch.snapshot_count, batch.holding_count),
            (1024, 216, 648),
        )
        self.assertEqual(
            {(run.strategy, run.market_scope) for run in batch.runs},
            set(LEGAL_PAIRS),
        )

        converted = [
            (candidate, *convert_snapshot_candidate(candidate))
            for run in batch.runs
            for candidate in run.snapshots
        ]
        self.assertEqual(len(converted), 216)
        self.assertEqual(sum(len(holdings) for _, _, holdings in converted), 648)

        pool = FakePool()
        writer = PitSnapshotWriter(pool)
        for candidate, snapshot, holdings in converted:
            self.assertEqual(
                snapshot.lineage_closure["t5b_candidate_fact_hash"],
                candidate.fact_hash,
            )
            self.assertEqual(
                snapshot.lineage_closure["t5b_holding_candidate_fact_hashes"],
                [item.fact_hash for item in candidate.holdings],
            )
            self.assertTrue((await writer.write_or_verify(snapshot, holdings)).inserted)

        self.assertEqual(len(pool.connection.snapshots), 216)
        self.assertEqual(
            sum(len(items) for items in pool.connection.holdings.values()), 648
        )

        for _, snapshot, holdings in converted:
            replay = await writer.write_or_verify(snapshot, holdings)
            self.assertFalse(replay.inserted)
            self.assertEqual(
                await writer.readback(
                    strategy=snapshot.strategy,
                    market_scope=snapshot.market_scope,
                    as_of_utc=snapshot.as_of_utc,
                ),
                replay,
            )

    async def test_public_authenticator_rejects_semantic_reseal_attack(self) -> None:
        source = (
            _engine(calendar=_landed_calendar()).run("us_preferred", "us").snapshots[0]
        )
        original = source.holdings[0]
        changed = replace(original, source_kind=original.source_kind + "-changed")
        changed = replace(
            changed,
            fact_hash=canonical_holding_candidate_hash(changed),
        )
        resealed = replace(
            source,
            holdings=(changed, *source.holdings[1:]),
            fact_hash="",
        )
        resealed = replace(
            resealed,
            fact_hash=canonical_snapshot_candidate_hash(resealed),
        )
        with self.assertRaisesRegex(
            ReplayInputError, "holding price source identity mismatch"
        ):
            authenticate_snapshot_candidate(resealed)
        with self.assertRaisesRegex(
            ReplayInputError, "holding price source identity mismatch"
        ):
            convert_snapshot_candidate(resealed)

    async def test_reserved_storage_lineage_keys_are_unreachable_upstream(
        self,
    ) -> None:
        source = (
            _engine(calendar=_landed_calendar()).run("us_preferred", "us").snapshots[0]
        )
        for key in ("t5b_candidate_fact_hash", "t5b_candidate_raw_values"):
            with self.subTest(key=key):
                changed = replace(
                    source.holdings[0],
                    lineage={**source.holdings[0].lineage, key: "a" * 64},
                )
                with self.assertRaisesRegex(
                    ReplayInputError, "holding lineage keys must be exact"
                ):
                    convert_snapshot_candidate(
                        replace(
                            source,
                            holdings=(changed, *source.holdings[1:]),
                        )
                    )
        for key in (
            "t5b_candidate_fact_hash",
            "t5b_holding_candidate_fact_hashes",
        ):
            with self.subTest(key=key):
                changed = replace(
                    source,
                    lineage_closure={**source.lineage_closure, key: "a" * 64},
                )
                with self.assertRaisesRegex(
                    ReplayInputError, "fact_hash is not authentic"
                ):
                    convert_snapshot_candidate(changed)

    async def test_nonfinite_and_unstorable_storage_numbers_fail_closed(
        self,
    ) -> None:
        source = (
            _engine(calendar=_landed_calendar()).run("us_preferred", "us").snapshots[0]
        )
        for field in ("weight", "entry_price", "current_price", "return_since_entry"):
            for value in (float("nan"), float("inf"), float("-inf")):
                with self.subTest(field=field, value=value):
                    changed = replace(source.holdings[0], **{field: value})
                    with self.assertRaisesRegex(
                        JCSCanonicalizationError, "non-finite JSON number"
                    ):
                        convert_snapshot_candidate(
                            replace(
                                source,
                                holdings=(changed, *source.holdings[1:]),
                            )
                        )

            changed = replace(source.holdings[0], **{field: 1e100})
            changed = replace(
                changed,
                fact_hash=canonical_holding_candidate_hash(changed),
            )
            resealed = replace(
                source,
                holdings=(changed, *source.holdings[1:]),
                fact_hash="",
            )
            resealed = replace(
                resealed,
                fact_hash=canonical_snapshot_candidate_hash(resealed),
            )
            with self.subTest(field=field, value="1e100"):
                with self.assertRaisesRegex(ValueError, "cannot be stored at scale 10"):
                    convert_snapshot_candidate(resealed)


if __name__ == "__main__":
    unittest.main()
