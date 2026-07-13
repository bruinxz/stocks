import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import unittest

from ai.snapshot.fingerprint import jcs_canonicalize
from strategy.materialization.multibagger_candidate import (
    CandidateIdempotencyConflict,
    CandidateMaterializationError,
    ClassificationDecision,
    LatestCatalyst,
    MaterializationInput,
    StrategyDecision,
    TextHitFact,
    UniverseFact,
    candidate_from_row,
    candidate_to_row,
    materialize_candidate,
    write_or_verify_candidate,
)


NOW = datetime(2026, 7, 10, 8, 0, 0, tzinfo=timezone.utc)
ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "materialization" / "fixtures"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def sha(value):
    import hashlib

    return hashlib.sha256(jcs_canonicalize(value).encode("utf-8")).hexdigest()


def universe_fact(**overrides):
    captured = fixture("jpx_security_sample.json")["rows"][0]
    values = {
        "market_scope": "jp",
        "provider_market_label": "JP",
        "exchange": "tse",
        "ticker": captured["local_code"],
        "record_kind": "LIFECYCLE",
        "universe_source_kind": "jpx-listed-company-monthly",
        "source_document_id": "jpx-listed-company:20260630:1301",
        "source_version": "20260630:v1",
        "effective_at_utc": NOW - timedelta(days=10),
        "available_at_utc": NOW - timedelta(days=9),
        "as_of_utc": NOW,
        "features": {
            "section": captured["section"],
            "sector_33_code": captured["sector_33_code"],
            "size_code": captured["size_code"],
        },
        "evidence_refs": ("jpx-listed-company:20260630:1301",),
        "text_hit_kinds": (),
        "fundamental_snapshot": {"name": captured["name_local"]},
        "filter_pass_bitmap": 3,
        "market_cap_cny_100m": None,
        "fact_hash": "0" * 64,
    }
    has_hash_override = "fact_hash" in overrides
    values.update(overrides)
    draft = UniverseFact(**values)
    from strategy.materialization.multibagger_candidate import _universe_body

    if not has_hash_override:
        object.__setattr__(draft, "fact_hash", sha(_universe_body(draft)))
    return draft


def text_hit(**overrides):
    values = {
        "market_scope": "jp",
        "ticker": "1301",
        "source_kind": "jpx-listed-company-monthly",
        "source_document_id": "jpx-listed-company:20260630:1301",
        "document_fact_hash": "d" * 64,
        "taxonomy_version": "optional-terms@1.0.0",
        "term_id": "capacity_expansion",
        "hit_kind": "OPTIONALITY",
        "language": "ja",
        "field": "BODY",
        "start_offset": 10,
        "end_offset": 20,
        "context_hash": "e" * 64,
        "effective_at_utc": NOW - timedelta(days=10),
        "available_at_utc": NOW - timedelta(days=9),
    }
    values.update(overrides)
    return TextHitFact(**values)


def score():
    dims = {
        "quality": (90, 0.10),
        "growth": (86, 0.25),
        "valuation": (75, 0.10),
        "moat": (80, 0.15),
        "trend": (88, 0.25),
        "risk": (82, 0.15),
    }
    body = {
        "ticker": "1301",
        "as_of": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "market_scope": "jp",
        **{
            name: {
                "score": value,
                "band": "A" if value >= 85 else "B",
                "evidence": ["captured source fact"],
                "inputs": {"captured": True},
            }
            for name, (value, _) in dims.items()
        },
        "weights": {name: weight for name, (_, weight) in dims.items()},
        "weights_profile": "japan_multibagger",
        "total": 84.3,
        "rating": "B",
        "computed_at": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_versions": {
            "quality_engine": "quality@1.0.0",
            "growth_engine": "growth@1.0.0",
            "valuation_engine": "valuation@1.0.0",
            "moat_engine": "moat@1.0.0",
            "trend_engine": "trend@1.0.0",
            "risk_engine": "risk@1.0.0",
        },
    }
    body["snapshot_hash"] = sha(body)
    body["scoring_id"] = "33333333-3333-4333-8333-333333333333"
    return body


def decision(**overrides):
    score_value = score()
    ref = {
        "scoring_id": score_value["scoring_id"],
        "snapshot_hash": score_value["snapshot_hash"],
    }
    values = {
        "score": score_value,
        "conviction": {
            "ticker": "1301",
            "as_of": score_value["as_of"],
            "base": 84.3,
            "score_ref": ref,
            "adjustments": [],
            "final": 84.3,
            "level": "HIGH",
        },
        "risk_gate": {
            "ticker": "1301",
            "evaluated_at": score_value["as_of"],
            "gate": "GREEN",
            "triggers": [],
            "ok_to_enter": True,
        },
        "entry_plan": {
            "ticker": "1301",
            "generated_at": score_value["as_of"],
            "entry": {"low": 4450, "high": 4550, "currency": "JPY"},
            "stop": {"value": 4100, "currency": "JPY"},
            "targets": [{"value": 5200, "currency": "JPY"}],
            "size_hint": {
                "tier": "TIER_3",
                "pct": 3,
                "disclaimer_key": "size_hint_advisory",
                "rationale": "conviction 84.3",
            },
            "time_horizon": "POSITION",
            "invalidation": "close below 4100",
            "conviction_ref": 84.3,
            "score_ref": ref,
        },
        "strategy_version": "japan-multibagger@1.0.0",
    }
    values.update(overrides)
    return StrategyDecision(**values)


class Policy:
    def __init__(self, stage="early", conclusion="MULTIBAGGER_2X"):
        self.stage = stage
        self.conclusion = conclusion

    def classify(self, sources, text_hits, strategy_decision):
        return ClassificationDecision(
            stage=self.stage,
            conclusion=self.conclusion,
            policy_version="stage-policy@1.0.0",
            reason_codes=("CAPTURED_SOURCE", "OPTIONALITY_HIT"),
        )


class Store:
    def __init__(self):
        self.rows = {}

    def write_or_verify(self, candidate):
        existing = self.rows.get(candidate.identity)
        if existing is None:
            self.rows[candidate.identity] = candidate
            return candidate
        if existing != candidate:
            raise CandidateIdempotencyConflict("immutable candidate conflict")
        return existing


def request(**overrides):
    catalyst_body = {
        "kind": "product",
        "title": "captured fixture",
        "occurred_at": (NOW - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_ref": "fixture:jpx-security:1301",
    }
    values = {
        "market_scope": "jp",
        "exchange": "tse",
        "ticker": "1301",
        "as_of_utc": NOW,
        "sources": (universe_fact(),),
        "text_hits": (text_hit(),),
        "decision": decision(),
        "latest_catalyst": LatestCatalyst(
            kind=catalyst_body["kind"],
            title=catalyst_body["title"],
            occurred_at=NOW - timedelta(hours=1),
            source_ref=catalyst_body["source_ref"],
            fact_hash=sha(catalyst_body),
        ),
    }
    values.update(overrides)
    return MaterializationInput(**values)


class MaterializerTests(unittest.TestCase):
    def test_captured_fixture_provenance_is_non_production(self):
        for name in ("jpx_security_sample.json", "kind_disclosure_sample.json"):
            value = fixture(name)
            self.assertEqual(value["fixture_mode"], "self-use-non-commercial-test-only")
            self.assertFalse(value["production_seed_allowed"])
            self.assertEqual(len(value["rows"]), 1)
            self.assertEqual(value["fixture_content_sha256"], sha(value["rows"]))

    def test_materialization_is_deterministic_and_source_closed(self):
        first = materialize_candidate(request(), Policy())
        second = materialize_candidate(copy.deepcopy(request()), Policy())
        self.assertEqual(first, second)
        self.assertEqual(first.rating, "B")
        self.assertEqual(first.stage, "early")
        self.assertEqual(first.conclusion, "MULTIBAGGER_2X")
        self.assertEqual(first.source_fact_hashes, tuple(sorted(first.source_fact_hashes)))
        self.assertEqual(len(first.source_fact_hashes), 3)
        self.assertEqual(len(first.fact_hash), 64)
        self.assertEqual(candidate_from_row(candidate_to_row(first)), first)

    def test_store_insert_replay_and_conflict(self):
        store = Store()
        candidate = materialize_candidate(request(), Policy())
        self.assertEqual(write_or_verify_candidate(store, candidate), candidate)
        self.assertEqual(write_or_verify_candidate(store, candidate), candidate)
        changed = materialize_candidate(request(), Policy(stage="growth"))
        with self.assertRaises(CandidateIdempotencyConflict):
            write_or_verify_candidate(store, changed)

    def test_no_lookahead_identity_hash_and_profile_fail_closed(self):
        cases = (
            request(sources=(universe_fact(available_at_utc=NOW + timedelta(seconds=1)),)),
            request(sources=(universe_fact(ticker="9999"),)),
            request(sources=(universe_fact(fact_hash="f" * 64),)),
            request(text_hits=(text_hit(available_at_utc=NOW + timedelta(seconds=1)),)),
            request(text_hits=(text_hit(start_offset=True),)),
            request(decision=decision(score={**score(), "weights_profile": "multibagger"})),
        )
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(CandidateMaterializationError):
                    materialize_candidate(value, Policy())

    def test_policy_and_strategy_authority_fail_closed(self):
        no_entry = decision(entry_plan=None)
        closed_gate = decision(
            risk_gate={
                "ticker": "1301",
                "evaluated_at": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "gate": "RED",
                "triggers": [
                    {
                        "code": "TSE_HALT",
                        "severity": "block",
                        "detail": "halt",
                    }
                ],
                "ok_to_enter": False,
            },
            entry_plan=None,
        )
        for strategy_decision in (no_entry, closed_gate):
            with self.assertRaises(CandidateMaterializationError):
                materialize_candidate(
                    request(decision=strategy_decision),
                    Policy(conclusion="MULTIBAGGER_2X"),
                )
            skipped = materialize_candidate(
                request(decision=strategy_decision), Policy(conclusion="SKIP")
            )
            self.assertEqual(skipped.conclusion, "SKIP")
        with self.assertRaises(CandidateMaterializationError):
            materialize_candidate(request(), Policy(stage="legacy"))
        with self.assertRaises(CandidateMaterializationError):
            materialize_candidate(request(), Policy(conclusion="UNKNOWN"))

    def test_nonfinite_strategy_values_and_catalyst_fail_closed(self):
        mutations = []
        for field, value in (
            ("total", float("nan")),
            ("total", float("inf")),
        ):
            score_value = score()
            score_value[field] = value
            mutations.append(request(decision=decision(score=score_value)))
        score_value = score()
        score_value["quality"]["score"] = float("nan")
        mutations.append(request(decision=decision(score=score_value)))
        score_value = score()
        score_value["weights"]["quality"] = float("inf")
        mutations.append(request(decision=decision(score=score_value)))
        conviction = dict(decision().conviction)
        conviction["final"] = float("nan")
        mutations.append(request(decision=decision(conviction=conviction)))

        for value in mutations:
            with self.subTest(value=value):
                with self.assertRaises(CandidateMaterializationError):
                    materialize_candidate(value, Policy())

        catalyst = request().latest_catalyst
        with self.assertRaises(CandidateMaterializationError):
            materialize_candidate(
                request(
                    latest_catalyst=LatestCatalyst(
                        kind="unclassified",
                        title=catalyst.title,
                        occurred_at=catalyst.occurred_at,
                        source_ref=catalyst.source_ref,
                        fact_hash=catalyst.fact_hash,
                    )
                ),
                Policy(),
            )
        with self.assertRaises(CandidateMaterializationError):
            materialize_candidate(
                request(
                    latest_catalyst=LatestCatalyst(
                        kind=catalyst.kind,
                        title=catalyst.title,
                        occurred_at=catalyst.occurred_at,
                        source_ref=catalyst.source_ref,
                        fact_hash="f" * 64,
                    )
                ),
                Policy(),
            )

    def test_physical_row_authenticates_classification_provenance(self):
        candidate = materialize_candidate(request(), Policy())
        row = dict(candidate_to_row(candidate))
        self.assertEqual(candidate_from_row(row), candidate)
        for field, value in (
            ("classification_policy_version", "tampered"),
            ("classification_reason_codes", ["TAMPERED"]),
        ):
            corrupted = dict(row)
            corrupted[field] = value
            with self.subTest(field=field):
                with self.assertRaises(CandidateMaterializationError):
                    candidate_from_row(corrupted)
        unsorted = dict(row)
        unsorted["classification_reason_codes"] = ["Z", "A"]
        with self.assertRaisesRegex(
            CandidateMaterializationError, "sorted and unique"
        ):
            candidate_from_row(unsorted)


if __name__ == "__main__":
    unittest.main()
