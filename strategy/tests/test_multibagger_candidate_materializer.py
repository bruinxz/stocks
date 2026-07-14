import copy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import unittest

from ai.snapshot.fingerprint import jcs_canonicalize
from datapipeline.storage.multibagger import (
    build_storage_row,
    build_text_hit_storage_row,
    canonical_multibagger_fact_hash,
    canonical_multibagger_storage_fact_hash,
    canonical_text_hit_fact_hash,
)
from datapipeline.contracts import (
    CaptureProvenanceError,
    MultibaggerSourceRecord,
    ScanDocument,
    TextHit,
    TextHitEnvelope,
    build_capture_wrapper,
    capture_source_version,
    validate_capture_wrapper,
)
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


NOW = datetime(2026, 7, 14, 0, 0, 0, tzinfo=timezone.utc)
ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "materialization" / "fixtures"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def sha(value):
    import hashlib

    return hashlib.sha256(jcs_canonicalize(value).encode("utf-8")).hexdigest()


def universe_fact(**overrides):
    wrapper = fixture("jpx_security_sample.json")
    captured = validate_capture_wrapper(
        wrapper, expected_source_kind="jpx-listed-company-monthly"
    )["rows"][0]
    record = MultibaggerSourceRecord(
        market="JP",
        market_scope="jp",
        exchange="tse",
        ticker=captured["local_code"],
        record_kind="LIFECYCLE",
        source_kind="jpx-listed-company-monthly",
        source_document_id="jpx-listed-company:20260630:1301",
        source_version=capture_source_version(wrapper),
        effective_at_utc=datetime.strptime(
            captured["effective_day"], "%Y%m%d"
        ).replace(tzinfo=timezone.utc),
        available_at_utc=datetime.fromisoformat(
            wrapper["captured_at_utc"].replace("Z", "+00:00")
        ),
        as_of_utc=NOW,
        features={
            "section": captured["section"],
            "sector_33_code": captured["sector_33_code"],
            "size_code": captured["size_code"],
        },
        evidence_refs=("jpx-listed-company:20260630:1301",),
        fact_hash="0" * 64,
    )
    record = replace(record, fact_hash=canonical_multibagger_fact_hash(record))
    storage = build_storage_row(record)
    body = storage.canonical_body
    values = {
        **body,
        "evidence_refs": tuple(body["evidence_refs"]),
        "text_hit_kinds": tuple(body["text_hit_kinds"]),
        "features": dict(body["features"]),
        "fundamental_snapshot": dict(body["fundamental_snapshot"]),
        "effective_at_utc": record.effective_at_utc,
        "available_at_utc": record.available_at_utc,
        "as_of_utc": record.as_of_utc,
        "fact_hash": record.fact_hash,
    }
    has_hash_override = "fact_hash" in overrides
    values.update(overrides)
    draft = UniverseFact(**values)
    if not has_hash_override:
        hash_values = dict(values)
        hash_values.pop("fact_hash")
        hash_values["features"] = dict(draft.features)
        hash_values["evidence_refs"] = list(draft.evidence_refs)
        hash_values["text_hit_kinds"] = list(draft.text_hit_kinds)
        hash_values["fundamental_snapshot"] = dict(draft.fundamental_snapshot)
        object.__setattr__(
            draft,
            "fact_hash",
            canonical_multibagger_storage_fact_hash(**hash_values),
        )
    return draft


def text_hit(**overrides):
    wrapper_name = overrides.pop("wrapper_name", "jpx_security_sample.json")
    wrapper = fixture(wrapper_name)
    effective_at = (
        datetime(2026, 7, 10, 11, 1, 0, tzinfo=timezone.utc)
        if wrapper["source_kind"] == "kind"
        else datetime(2026, 6, 30, 0, 0, 0, tzinfo=timezone.utc)
    )
    available_at = datetime.fromisoformat(
        wrapper["captured_at_utc"].replace("Z", "+00:00")
    )
    document = ScanDocument(
        document_id="jpx-listed-company:20260630:1301",
        ticker="1301",
        market="JP",
        market_scope="jp",
        language="ja",
        title="captured source title with capacity expansion",
        body="captured source body with capacity expansion evidence",
        published_at_utc=effective_at,
        available_at_utc=available_at,
        source_kind="jpx-listed-company-monthly",
        source_version=capture_source_version(wrapper),
        source_url=None,
        document_fact_hash="d" * 64,
    )
    envelope = TextHitEnvelope(
        document,
        TextHit(
            term_id="capacity_expansion",
            hit_kind="OPTIONALITY",
            document_id=document.document_id,
            ticker=document.ticker,
            language=document.language,
            field="BODY",
            start_offset=10,
            end_offset=20,
            context_hash="e" * 64,
            taxonomy_version="optional-terms@1.0.0",
        ),
    )
    storage = build_text_hit_storage_row(envelope)
    values = {
        **storage.__dict__,
    }
    has_hash_override = "hit_fact_hash" in overrides
    values.update(overrides)
    draft = TextHitFact(**values)
    if not has_hash_override:
        hash_values = dict(values)
        hash_values.pop("hit_fact_hash")
        object.__setattr__(
            draft,
            "hit_fact_hash",
            canonical_text_hit_fact_hash(**hash_values),
        )
    return draft


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
        "available_at_utc": (NOW - timedelta(minutes=30)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ),
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
            available_at_utc=NOW - timedelta(minutes=30),
            source_ref=catalyst_body["source_ref"],
            fact_hash=sha(catalyst_body),
        ),
    }
    values.update(overrides)
    return MaterializationInput(**values)


class MaterializerTests(unittest.TestCase):
    def test_captured_fixture_provenance_is_non_production(self):
        fixtures = {
            "jpx_security_sample.json": "jpx-listed-company-monthly",
            "kind_disclosure_sample.json": "kind",
        }
        for name, source_kind in fixtures.items():
            value = fixture(name)
            payload = validate_capture_wrapper(
                value, expected_source_kind=source_kind
            )
            self.assertFalse(value["fixture_mode"])
            self.assertFalse(value["production_seed_allowed"])
            self.assertEqual(len(payload["rows"]), 3)
            self.assertTrue(capture_source_version(value).startswith("1.0.0:"))

    def test_capture_wrapper_every_field_and_source_hash_closure_fail_closed(self):
        wrapper = fixture("jpx_security_sample.json")
        mutations = {
            "capture_instance": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "capture_schema_version": "9.9.9",
            "captured_at_utc": "1999-01-01T00:00:00Z",
            "captured_response_sha256": "f" * 64,
            "declared_live_row_count": 999,
            "fixture_mode": True,
            "payload_sha256": "f" * 64,
            "production_seed_allowed": True,
            "source_kind": "kind",
            "source_url": "https://example.invalid/source",
            "terms_url": "https://example.invalid/terms",
            "wrapper_sha256": "f" * 64,
        }
        baseline_fact = universe_fact()
        baseline_hit = text_hit()
        baseline_candidate = materialize_candidate(request(), Policy())
        for field, value in mutations.items():
            tampered = copy.deepcopy(wrapper)
            tampered[field] = value
            with self.subTest(field=field):
                with self.assertRaises(CaptureProvenanceError):
                    validate_capture_wrapper(
                        tampered,
                        expected_source_kind="jpx-listed-company-monthly",
                    )
        tampered = copy.deepcopy(wrapper)
        tampered["payload"]["rows"][0]["name_local"] = "tampered"
        with self.assertRaises(CaptureProvenanceError):
            validate_capture_wrapper(
                tampered, expected_source_kind="jpx-listed-company-monthly"
            )

        valid_rebuilds = []
        for field, value in (
            ("capture_instance", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            ("captured_at_utc", "2026-07-02T04:20:57Z"),
            ("captured_response_sha256", "f" * 64),
            ("declared_live_row_count", 4438),
        ):
            arguments = {
                "source_kind": wrapper["source_kind"],
                "source_url": wrapper["source_url"],
                "terms_url": wrapper["terms_url"],
                "capture_instance": wrapper["capture_instance"],
                "captured_at_utc": wrapper["captured_at_utc"],
                "captured_response_sha256": wrapper["captured_response_sha256"],
                "declared_live_row_count": wrapper["declared_live_row_count"],
                "payload": wrapper["payload"],
            }
            arguments[field] = value
            valid_rebuilds.append(build_capture_wrapper(**arguments))
        changed_payload = copy.deepcopy(wrapper["payload"])
        changed_payload["rows"][0]["name_local"] = "changed-but-valid"
        valid_rebuilds.append(
            build_capture_wrapper(
                source_kind=wrapper["source_kind"],
                source_url=wrapper["source_url"],
                terms_url=wrapper["terms_url"],
                capture_instance=wrapper["capture_instance"],
                captured_at_utc=wrapper["captured_at_utc"],
                captured_response_sha256=wrapper["captured_response_sha256"],
                declared_live_row_count=wrapper["declared_live_row_count"],
                payload=changed_payload,
            )
        )
        for rebuilt in valid_rebuilds:
            self.assertNotEqual(
                capture_source_version(rebuilt),
                capture_source_version(wrapper),
            )
        changed_source = universe_fact(source_version="1.0.0:changed")
        self.assertNotEqual(changed_source.fact_hash, baseline_fact.fact_hash)
        changed_hit = text_hit(source_version="1.0.0:changed")
        self.assertNotEqual(changed_hit.hit_fact_hash, baseline_hit.hit_fact_hash)
        changed_candidate = materialize_candidate(
            request(sources=(changed_source,), text_hits=(changed_hit,)),
            Policy(),
        )
        self.assertNotEqual(
            changed_candidate.fact_hash,
            baseline_candidate.fact_hash,
        )

    def test_materialization_is_deterministic_and_source_closed(self):
        first = materialize_candidate(request(), Policy())
        second = materialize_candidate(copy.deepcopy(request()), Policy())
        self.assertEqual(first, second)
        self.assertEqual(first.rating, "B")
        self.assertEqual(first.stage, "early")
        self.assertEqual(first.conclusion, "MULTIBAGGER_2X")
        self.assertEqual(first.source_fact_hashes, tuple(sorted(first.source_fact_hashes)))
        self.assertEqual(len(first.source_fact_hashes), 5)
        self.assertIn(request().latest_catalyst.fact_hash, first.source_fact_hashes)
        self.assertEqual(len(first.fact_hash), 64)
        self.assertEqual(candidate_from_row(candidate_to_row(first)), first)

    def test_captured_jpx_and_kind_wrappers_close_source_hashes(self):
        jpx_wrapper = fixture("jpx_security_sample.json")
        kind_wrapper = fixture("kind_disclosure_sample.json")
        kind_payload = validate_capture_wrapper(
            kind_wrapper, expected_source_kind="kind"
        )
        jpx = universe_fact()
        kind = text_hit(
            source_kind="kind",
            source_document_id=kind_payload["rows"][0]["receipt_no"],
            source_version=capture_source_version(kind_wrapper),
            document_fact_hash=sha(
                {
                    "capture_instance": kind_wrapper["capture_instance"],
                    "payload_sha256": kind_wrapper["payload_sha256"],
                    "receipt_no": kind_payload["rows"][0]["receipt_no"],
                    "wrapper_sha256": kind_wrapper["wrapper_sha256"],
                }
            ),
            wrapper_name="kind_disclosure_sample.json",
        )
        candidate = materialize_candidate(
            request(sources=(jpx,), text_hits=(kind,)), Policy()
        )
        self.assertIn(jpx.fact_hash, candidate.source_fact_hashes)
        self.assertIn(kind.document_fact_hash, candidate.source_fact_hashes)
        self.assertIn(kind.context_hash, candidate.source_fact_hashes)
        self.assertIn(kind.hit_fact_hash, candidate.source_fact_hashes)
        self.assertEqual(jpx.source_version, capture_source_version(jpx_wrapper))
        self.assertEqual(kind.source_version, capture_source_version(kind_wrapper))

    def test_store_insert_replay_and_conflict(self):
        store = Store()
        candidate = materialize_candidate(request(), Policy())
        self.assertEqual(write_or_verify_candidate(store, candidate), candidate)
        self.assertEqual(write_or_verify_candidate(store, candidate), candidate)
        changed = materialize_candidate(request(), Policy(stage="growth"))
        with self.assertRaises(CandidateIdempotencyConflict):
            write_or_verify_candidate(store, changed)

    def test_no_lookahead_identity_hash_and_profile_fail_closed(self):
        future_score = score()
        future_score["computed_at"] = "2099-01-01T00:00:00Z"
        score_body = dict(future_score)
        score_body.pop("snapshot_hash")
        score_body.pop("scoring_id")
        future_score["snapshot_hash"] = sha(score_body)
        future_decision = decision(score=future_score)
        future_ref = {
            "scoring_id": future_score["scoring_id"],
            "snapshot_hash": future_score["snapshot_hash"],
        }
        future_conviction = dict(future_decision.conviction)
        future_conviction["score_ref"] = future_ref
        future_entry = dict(future_decision.entry_plan)
        future_entry["score_ref"] = future_ref
        future_risk = dict(decision().risk_gate)
        future_risk["evaluated_at"] = "2099-01-01T00:00:00Z"
        generated_future = dict(decision().entry_plan)
        generated_future["generated_at"] = "2099-01-01T00:00:00Z"
        catalyst = request().latest_catalyst
        future_catalyst_body = {
            "kind": catalyst.kind,
            "title": catalyst.title,
            "occurred_at": catalyst.occurred_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "available_at_utc": "2099-01-01T00:00:00Z",
            "source_ref": catalyst.source_ref,
        }
        future_catalyst = LatestCatalyst(
            kind=catalyst.kind,
            title=catalyst.title,
            occurred_at=catalyst.occurred_at,
            available_at_utc=datetime(2099, 1, 1, tzinfo=timezone.utc),
            source_ref=catalyst.source_ref,
            fact_hash=sha(future_catalyst_body),
        )
        cases = (
            request(sources=(universe_fact(available_at_utc=NOW + timedelta(seconds=1)),)),
            request(sources=(universe_fact(effective_at_utc=NOW + timedelta(seconds=1)),)),
            request(sources=(universe_fact(ticker="9999"),)),
            request(sources=(universe_fact(fact_hash="f" * 64),)),
            request(text_hits=(text_hit(available_at_utc=NOW + timedelta(seconds=1)),)),
            request(text_hits=(text_hit(effective_at_utc=NOW + timedelta(seconds=1)),)),
            request(text_hits=(text_hit(start_offset=True),)),
            request(latest_catalyst=future_catalyst),
            request(decision=decision(score={**score(), "weights_profile": "multibagger"})),
            request(
                decision=decision(
                    score=future_score,
                    conviction=future_conviction,
                    entry_plan=future_entry,
                )
            ),
            request(decision=decision(risk_gate=future_risk)),
            request(decision=decision(entry_plan=generated_future)),
        )
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(CandidateMaterializationError):
                    materialize_candidate(value, Policy())

    def test_candidate_availability_includes_strategy_decision_time(self):
        strategy_time = NOW - timedelta(minutes=15)
        score_value = score()
        score_value["computed_at"] = strategy_time.strftime("%Y-%m-%dT%H:%M:%SZ")
        score_body = dict(score_value)
        score_body.pop("snapshot_hash")
        score_body.pop("scoring_id")
        score_value["snapshot_hash"] = sha(score_body)
        ref = {
            "scoring_id": score_value["scoring_id"],
            "snapshot_hash": score_value["snapshot_hash"],
        }
        conviction = dict(decision().conviction)
        conviction["score_ref"] = ref
        risk_gate = dict(decision().risk_gate)
        risk_gate["evaluated_at"] = strategy_time.strftime("%Y-%m-%dT%H:%M:%SZ")
        entry_plan = dict(decision().entry_plan)
        entry_plan["score_ref"] = ref
        entry_plan["generated_at"] = strategy_time.strftime("%Y-%m-%dT%H:%M:%SZ")
        candidate = materialize_candidate(
            request(
                decision=decision(
                    score=score_value,
                    conviction=conviction,
                    risk_gate=risk_gate,
                    entry_plan=entry_plan,
                )
            ),
            Policy(),
        )
        self.assertEqual(
            candidate.available_at_utc,
            strategy_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        )

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
                        available_at_utc=catalyst.available_at_utc,
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
                        available_at_utc=catalyst.available_at_utc,
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
