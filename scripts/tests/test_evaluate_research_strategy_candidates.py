import importlib.util
from datetime import date, timedelta
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts/ops/evaluate_research_strategy_candidates.py"
SPEC = importlib.util.spec_from_file_location("research_candidate_eval", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def synthetic_period(index: int, *, negative: bool = False):
    start = date(2024, 1, 2) + timedelta(days=index * 30)
    rows = []
    for rank in range(30):
        quality = 1.0 - rank / 30.0
        forward_return = (-0.03 if rank < 3 else -0.005) if negative else (
            0.03 if rank < 3 else 0.004
        )
        rows.append(
            MODULE.SecurityReturn(
                ticker=f"{rank:06d}",
                factors=(quality, 0.5, 0.5, 0.5, 0.5, 0.5),
                forward_return=forward_return,
            )
        )
    return MODULE.Period(
        signal_day=start,
        entry_day=start + timedelta(days=1),
        exit_day=start + timedelta(days=29),
        trading_days=21,
        benchmark_return=0.002,
        rows=tuple(rows),
    )


class ResearchCandidateEvaluationTest(unittest.TestCase):
    def setUp(self):
        self.materialized = MODULE.Candidate(
            "materialized", 3, (1.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        )
        self.diluted = MODULE.Candidate(
            "diluted", 20, (1.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        )

    def test_turnover_cost_reduces_return(self):
        periods = [synthetic_period(index) for index in range(3)]
        base = MODULE.simulate(periods, self.materialized, 0.0)
        stressed = MODULE.simulate(periods, self.materialized, 0.002)
        self.assertGreater(base.total_return, stressed.total_return)
        self.assertGreater(stressed.total_return, 0)

    def test_walk_forward_can_pass_only_materialized_winner(self):
        periods = [synthetic_period(index) for index in range(27)]
        result = MODULE.walk_forward(periods, (self.materialized, self.diluted))
        verdict, blockers = MODULE.qualification_verdict(
            {
                **result,
                "benchmark_annual_return": 0.03,
                "materialized_candidate": "materialized",
            }
        )
        self.assertEqual(verdict, "PASS")
        self.assertEqual(blockers, [])
        self.assertTrue(
            all(window["selected_candidate"] == "materialized" for window in result["windows"])
        )

    def test_unmaterialized_winner_never_auto_promotes(self):
        periods = [synthetic_period(index) for index in range(27)]
        result = MODULE.walk_forward(periods, (self.materialized, self.diluted))
        verdict, blockers = MODULE.qualification_verdict(
            {
                **result,
                "benchmark_annual_return": 0.03,
                "materialized_candidate": "different_profile",
            }
        )
        self.assertEqual(verdict, "FAIL")
        self.assertIn("selected_candidate_not_materialized", blockers)

    def test_losing_oos_data_is_rejected(self):
        periods = [synthetic_period(index, negative=True) for index in range(27)]
        result = MODULE.walk_forward(periods, (self.materialized, self.diluted))
        verdict, blockers = MODULE.qualification_verdict(
            {
                **result,
                "benchmark_annual_return": 0.0,
                "materialized_candidate": "materialized",
            }
        )
        self.assertEqual(verdict, "FAIL")
        self.assertIn("after_cost_annual_return_below_10pct", blockers)
        self.assertIn("oos_sharpe_not_positive", blockers)


if __name__ == "__main__":
    unittest.main()
