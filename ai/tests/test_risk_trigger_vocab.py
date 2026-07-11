import pathlib
import re
import unittest

from ai.types import RISK_TRIGGER_CODES, RISK_TRIGGER_CODE_SEQUENCE_V0_3


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCORING_CONTRACT = ROOT / "contracts" / "scoring.md"


def _scoring_contract_codes():
    content = SCORING_CONTRACT.read_text(encoding="utf-8")
    match = re.search(r"RISK_GATE_TRIGGER_CODES_V0_3=([^\n]+)", content)
    if not match:
        raise AssertionError("RISK_GATE_TRIGGER_CODES_V0_3 line missing")
    return tuple(match.group(1).split(","))


class RiskTriggerVocabularyTests(unittest.TestCase):
    def test_ai_types_exactly_match_strategy_contract_order_and_count(self):
        contract_codes = _scoring_contract_codes()

        self.assertEqual(len(contract_codes), 22)
        self.assertEqual(len(set(contract_codes)), 22)
        self.assertEqual(RISK_TRIGGER_CODE_SEQUENCE_V0_3, contract_codes)
        self.assertEqual(RISK_TRIGGER_CODES, frozenset(contract_codes))

    def test_stale_alternate_names_are_absent(self):
        stale = {
            "SEC_HALT",
            "EARNINGS_BLACKOUT",
            "FDA_ADCOM",
            "SHORT_SQUEEZE_RISK",
            "LIQUIDITY_THIN",
            "INSIDER_LOCKUP",
            "DEBT_COVENANT",
            "REGULATORY_REVIEW",
            "KRX_TRADING_HALT",
        }

        self.assertTrue(stale.isdisjoint(RISK_TRIGGER_CODES))


if __name__ == "__main__":
    unittest.main()
