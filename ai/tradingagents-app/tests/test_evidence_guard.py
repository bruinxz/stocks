import unittest
import json
import tempfile
from pathlib import Path

from tradingagents.graph.evidence_guard import guard_company_news
from tradingagents.graph.trading_graph import TradingAgentsGraph


class CompanyNewsEvidenceGuardTest(unittest.TestCase):
    def test_rejects_explicit_cross_company_attribution(self):
        report, audit = guard_company_news(
            "新闻标注存在代码匹配异常，实际为华联控股公告但关联至sh.600519。"
            "公司拟收购海外锂矿。",
            "sh.600519",
        )
        self.assertEqual("rejected", audit["status"])
        self.assertIn("ticker/company attribution mismatch", report)
        self.assertNotIn("锂矿", report)

    def test_preserves_verified_report_without_mismatch_marker(self):
        source = "贵州茅台（600519.SH）于2026-07-17公告调整飞天茅台价格。"
        report, audit = guard_company_news(source, "sh.600519")
        self.assertEqual("accepted", audit["status"])
        self.assertEqual(source, report)

    def test_empty_report_is_explicitly_unavailable(self):
        report, audit = guard_company_news("", "sh.600519")
        self.assertEqual("unavailable", audit["status"])
        self.assertIn("No verified company-specific news", report)

    def test_full_state_log_returns_an_auditable_path(self):
        graph = TradingAgentsGraph.__new__(TradingAgentsGraph)
        graph.log_states_dict = {}
        graph.ticker = "sh.600519"
        graph.evidence_audit = {
            "company_news": {
                "status": "rejected",
                "reason": "explicit_company_attribution_mismatch",
            }
        }
        state = {
            "company_of_interest": "sh.600519",
            "trade_date": "2026-07-24",
            "market_report": "market",
            "sentiment_report": "sentiment",
            "news_report": "No verified company-specific news",
            "fundamentals_report": "fundamentals",
            "investment_debate_state": {
                "bull_history": "",
                "bear_history": "",
                "history": "",
                "current_response": "",
                "judge_decision": "HOLD",
            },
            "trader_investment_plan": "HOLD",
            "risk_debate_state": {
                "aggressive_history": "",
                "conservative_history": "",
                "neutral_history": "",
                "history": "",
                "judge_decision": "HOLD",
            },
            "investment_plan": "HOLD",
            "final_trade_decision": "HOLD",
        }
        with tempfile.TemporaryDirectory() as tmp:
            graph.config = {"results_dir": tmp}
            log_path = graph._log_state("2026-07-24", state)
            archived = json.loads(Path(log_path).read_text(encoding="utf-8"))
        self.assertEqual("rejected", archived["evidence_audit"]["company_news"]["status"])
        self.assertEqual("No verified company-specific news", archived["news_report"])


if __name__ == "__main__":
    unittest.main()
