import copy
import hashlib
import json
from pathlib import Path
import unittest

from strategy.reporting.tab67_projection import (
    PROFILE_ORDER,
    ProjectionContractError,
    project_daily_report,
    project_report_history,
)
from ai.snapshot.fingerprint import compute_output_fingerprint


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "reporting" / "fixtures"


def load_fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def canonical_sha(value):
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def reseal(source):
    source["output_fingerprint"] = compute_output_fingerprint(source["items"])
    return source


class Tab67ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.source = load_fixture("recommendation_list_us_v031.json")

    def test_daily_report_matches_golden_except_byte_aligned_entries(self):
        report = project_daily_report(self.source)
        golden = load_fixture("daily_report_us_v031.golden.json")
        golden["entries"] = copy.deepcopy(self.source["items"])
        golden["markdown"] = report["markdown"]
        self.assertEqual(report, golden)
        self.assertEqual(report["entries"], self.source["items"])

    def test_markdown_is_deterministic_and_contains_evidence_disclaimer_pins(self):
        first = project_daily_report(self.source)
        second = project_daily_report(copy.deepcopy(self.source))
        self.assertEqual(first["markdown"], second["markdown"])
        self.assertIn("[E1](sec-edgar://", first["markdown"])
        self.assertIn("Disclaimer version: 1.0.0", first["markdown"])
        self.assertIn(self.source["output_fingerprint"], first["markdown"])
        self.assertIn(self.source["meta"]["input_fingerprint"], first["markdown"])
        self.assertEqual(
            hashlib.sha256(first["markdown"].encode("utf-8")).hexdigest(),
            "f9cee969ff72ef780e9a2aa894710b7f46ac40bc84301f1e1d2239170e339d87",
        )
        self.assertEqual(
            canonical_sha(first),
            "d279ec29b72bf5c5241a99f9d7bc5b2dd15de55095f3fc0cb314c48c4e49851a",
        )

    def test_empty_list_is_a_valid_report(self):
        source = copy.deepcopy(self.source)
        source["items"] = []
        reseal(source)
        report = project_daily_report(source)
        self.assertEqual(report["summary"]["item_count"], 0)
        self.assertEqual(report["entries"], [])
        self.assertIn("本期无通过风险门禁的推荐", report["markdown"])

    def test_history_deduplicates_identity_by_latest_as_of(self):
        older = copy.deepcopy(self.source)
        older["snapshot_id"] = "44444444-4444-4444-8444-444444444444"
        older["as_of"] = "2026-07-12T08:30:00Z"
        older["items"] = []
        reseal(older)
        history = project_report_history([older, self.source])
        self.assertEqual(history["total"], 1)
        self.assertEqual(
            history["entries"][0]["source_snapshot_id"],
            self.source["snapshot_id"],
        )

    def test_history_order_filters_search_and_date_bounds(self):
        prior = copy.deepcopy(self.source)
        prior["snapshot_id"] = "55555555-5555-4555-8555-555555555555"
        prior["as_of"] = "2026-07-11T09:30:00Z"
        prior["items"][0]["recommendation"]["snapshot_id"] = prior["snapshot_id"]
        prior["items"][0]["recommendation"]["as_of"] = prior["as_of"]
        reseal(prior)

        history = project_report_history([prior, self.source])
        self.assertEqual(
            [entry["trading_day"] for entry in history["entries"]],
            ["2026-07-12", "2026-07-11"],
        )
        searched = project_report_history(
            [prior, self.source],
            query="quality and conviction",
            profile="us_preferred",
            market_scope="us",
            from_day="2026-07-12",
            to_day="2026-07-12",
        )
        self.assertEqual(searched["total"], 1)
        self.assertEqual(searched["entries"][0]["trading_day"], "2026-07-12")
        self.assertEqual(
            canonical_sha(project_report_history([self.source])),
            "e155c9620cf2ed92d489e0ee862139ab2ed03aa14f35cbb7a431f5363e142071",
        )

    def test_history_profile_order_is_canonical_for_same_day(self):
        sources = []
        allowed_scope = {
            "us_preferred": "us",
            "multibagger": "us",
            "japan_blue_chip": "jp",
            "korea_semiconductor_chain": "kr",
            "japan_multibagger": "jp",
            "korea_multibagger": "kr",
        }
        for index, profile in enumerate(reversed(PROFILE_ORDER), 1):
            source = copy.deepcopy(self.source)
            source["snapshot_id"] = "{:08d}-1111-4111-8111-111111111111".format(
                index
            )
            source["profile"] = profile
            source["market_scope"] = allowed_scope[profile]
            source["items"] = []
            source["disclaimer"]["language"] = (
                "ja-JP"
                if source["market_scope"] == "jp"
                else "ko-KR"
                if source["market_scope"] == "kr"
                else "en-US"
            )
            reseal(source)
            sources.append(source)
        history = project_report_history(sources)
        self.assertEqual(
            [entry["profile"] for entry in history["entries"]],
            list(PROFILE_ORDER),
        )

    def test_unknown_fields_and_custom_fail_closed(self):
        unknown = copy.deepcopy(self.source)
        unknown["legacy_profile"] = "us"
        with self.assertRaises(ProjectionContractError):
            project_daily_report(unknown)
        custom = copy.deepcopy(self.source)
        custom["profile"] = "custom"
        custom["items"] = []
        with self.assertRaises(ProjectionContractError):
            project_daily_report(custom)

    def test_pin_scope_language_rating_and_disclaimer_mismatches_fail_closed(self):
        mutations = []
        wrong_pin = copy.deepcopy(self.source)
        wrong_pin["meta"]["contract_version"] = "0.3.0"
        mutations.append(wrong_pin)
        wrong_scope = copy.deepcopy(self.source)
        wrong_scope["items"][0]["recommendation"]["score"]["market_scope"] = "cn_a"
        reseal(wrong_scope)
        mutations.append(wrong_scope)
        wrong_language = copy.deepcopy(self.source)
        wrong_language["items"][0]["recommendation"]["explanation"][
            "language"
        ] = "ja-JP"
        reseal(wrong_language)
        mutations.append(wrong_language)
        wrong_rating = copy.deepcopy(self.source)
        wrong_rating["items"][0]["rating_band"] = "B"
        reseal(wrong_rating)
        mutations.append(wrong_rating)
        wrong_disclaimer = copy.deepcopy(self.source)
        wrong_disclaimer["disclaimer"]["full_text"] += " changed"
        mutations.append(wrong_disclaimer)
        for source in mutations:
            with self.subTest(source=source):
                with self.assertRaises(ProjectionContractError):
                    project_daily_report(source)

    def test_invalid_hash_semver_uuid_and_item_order_fail_closed(self):
        invalid_hash = copy.deepcopy(self.source)
        invalid_hash["output_fingerprint"] = "D" * 64
        invalid_semver = copy.deepcopy(self.source)
        invalid_semver["meta"]["profile_version"] = "v1"
        invalid_uuid = copy.deepcopy(self.source)
        invalid_uuid["snapshot_id"] = "not-a-uuid"
        invalid_order = copy.deepcopy(self.source)
        second = copy.deepcopy(invalid_order["items"][0])
        second["recommendation"]["id"] = "77777777-7777-4777-8777-777777777777"
        second["recommendation"]["ticker"] = "MSFT"
        second["recommendation"]["conviction"]["final"] = 95
        invalid_order["items"].append(second)
        reseal(invalid_order)
        for source in (invalid_hash, invalid_semver, invalid_uuid, invalid_order):
            with self.subTest(source=source):
                with self.assertRaises(ProjectionContractError):
                    project_daily_report(source)

    def test_research_fail_open_regressions_are_rejected(self):
        mutations = []

        forged_fingerprint = copy.deepcopy(self.source)
        forged_fingerprint["output_fingerprint"] = "f" * 64
        mutations.append(forged_fingerprint)

        conviction_mismatch = copy.deepcopy(self.source)
        conviction_mismatch["items"][0]["recommendation"]["conviction"][
            "final"
        ] = 89
        reseal(conviction_mismatch)
        mutations.append(conviction_mismatch)

        size_pct_mismatch = copy.deepcopy(self.source)
        size_pct_mismatch["items"][0]["recommendation"]["entry_plan"][
            "size_hint"
        ]["pct"] = 5
        reseal(size_pct_mismatch)
        mutations.append(size_pct_mismatch)

        disclaimer_key_mismatch = copy.deepcopy(self.source)
        disclaimer_key_mismatch["items"][0]["recommendation"]["entry_plan"][
            "size_hint"
        ]["disclaimer_key"] = "legacy"
        reseal(disclaimer_key_mismatch)
        mutations.append(disclaimer_key_mismatch)

        l1_mismatch = copy.deepcopy(self.source)
        l1_mismatch["items"][0]["recommendation"]["weights"][
            "contributions"
        ][0]["weight"] = 0.5
        reseal(l1_mismatch)
        mutations.append(l1_mismatch)

        noncanonical_uri = copy.deepcopy(self.source)
        noncanonical_uri["items"][0]["recommendation"]["evidence_refs"][0][
            "source_uri"
        ] = "javascript:alert(1)"
        reseal(noncanonical_uri)
        mutations.append(noncanonical_uri)

        stale_trigger = copy.deepcopy(self.source)
        stale_trigger["items"][0]["recommendation"]["risk_gate"] = {
            "ticker": "AAPL",
            "evaluated_at": "2026-07-12T09:29:59Z",
            "gate": "GREEN",
            "triggers": [
                {
                    "code": "SEC_HALT",
                    "severity": "info",
                    "detail": "stale code",
                }
            ],
            "ok_to_enter": True,
        }
        reseal(stale_trigger)
        mutations.append(stale_trigger)

        for source in mutations:
            with self.subTest(source=source):
                with self.assertRaises(ProjectionContractError):
                    project_daily_report(source)

    def test_risk_trigger_severity_market_and_gate_are_rejected(self):
        wrong_severity = copy.deepcopy(self.source)
        wrong_severity["items"][0]["recommendation"]["risk_gate"] = {
            "ticker": "AAPL",
            "evaluated_at": "2026-07-12T09:29:59Z",
            "gate": "GREEN",
            "triggers": [
                {
                    "code": "EARNINGS_T-2",
                    "severity": "info",
                    "detail": "wrong severity",
                }
            ],
            "ok_to_enter": True,
        }
        reseal(wrong_severity)
        wrong_market = copy.deepcopy(self.source)
        wrong_market["items"][0]["recommendation"]["risk_gate"] = {
            "ticker": "AAPL",
            "evaluated_at": "2026-07-12T09:29:59Z",
            "gate": "GREEN",
            "triggers": [
                {
                    "code": "ST_TAG",
                    "severity": "block",
                    "detail": "wrong market",
                }
            ],
            "ok_to_enter": True,
        }
        reseal(wrong_market)
        wrong_gate = copy.deepcopy(self.source)
        wrong_gate["items"][0]["recommendation"]["risk_gate"] = {
            "ticker": "AAPL",
            "evaluated_at": "2026-07-12T09:29:59Z",
            "gate": "GREEN",
            "triggers": [
                {
                    "code": "EARNINGS_T-2",
                    "severity": "warn",
                    "detail": "gate should be yellow",
                }
            ],
            "ok_to_enter": True,
        }
        reseal(wrong_gate)
        for source in (wrong_severity, wrong_market, wrong_gate):
            with self.subTest(source=source):
                with self.assertRaises(ProjectionContractError):
                    project_daily_report(source)

    def test_projection_does_not_mutate_source(self):
        before = copy.deepcopy(self.source)
        report = project_daily_report(self.source)
        report["entries"][0]["recommendation"]["ticker"] = "MUTATED"
        self.assertEqual(self.source, before)

    def test_missing_evidence_marker_and_duplicate_ticker_fail_closed(self):
        missing = copy.deepcopy(self.source)
        missing["items"][0]["recommendation"]["explanation"]["body"] += " [E2]"
        reseal(missing)
        with self.assertRaises(ProjectionContractError):
            project_daily_report(missing)

        duplicate = copy.deepcopy(self.source)
        duplicate["items"].append(copy.deepcopy(duplicate["items"][0]))
        duplicate["items"][1]["recommendation"][
            "id"
        ] = "66666666-6666-4666-8666-666666666666"
        reseal(duplicate)
        with self.assertRaises(ProjectionContractError):
            project_daily_report(duplicate)

    def test_invalid_history_filters_fail_closed(self):
        invalid_calls = (
            {"profile": "custom"},
            {"market_scope": "global"},
            {"profile": "japan_blue_chip", "market_scope": "us"},
            {"from_day": "2026-07-13", "to_day": "2026-07-12"},
            {"from_day": "2026-02-30"},
        )
        for kwargs in invalid_calls:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ProjectionContractError):
                    project_report_history([self.source], **kwargs)


if __name__ == "__main__":
    unittest.main()
