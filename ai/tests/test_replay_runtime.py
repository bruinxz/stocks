from __future__ import annotations

import hashlib
import os
import stat
import tempfile
import unittest
import uuid
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from ai.replay.file_store import (
    AtomicFileReplayJobStore,
    ReplayJobStoreConfigurationError,
    ReplayJobStoreCorruptError,
)
from ai.replay.runtime import (
    ReplayWorker,
    TypedReplaySources,
    TypedScoreRecord,
    TypedSourceSnapshot,
    build_typed_replay_runtime,
    typed_score_fact_hash,
    validate_source_score_features,
)
from ai.replay.service import ReplayConflictError, ReplayService
from ai.replay.types import ReplayJob, ReplayPins, ReplayResult
from datapipeline.contracts import (
    JpKrDisclosureRecord,
    JpKrFilingEnvelope,
    JpKrFinancialRecord,
    ScanDocument,
    TextHit,
    TextHitEnvelope,
)


NOW = datetime(2026, 7, 10, 6, 30, tzinfo=timezone.utc)
NOW_TEXT = "2026-07-10T06:30:00Z"
JOB_ID = uuid.UUID("12345678-1234-4234-8234-567812345678")
SNAPSHOT_ID = "22345678-1234-4234-8234-567812345678"
TEST_TMP_ROOT = Path(__file__).resolve().parents[2]


def _temporary_directory():
    return tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT)


def _filing(*, available=NOW, market_scope="jp"):
    source_kind = "jpx-edinet" if market_scope == "jp" else "dart"
    exchange = "tse" if market_scope == "jp" else "krx"
    ticker = "7203" if market_scope == "jp" else "005930"
    currency = "JPY" if market_scope == "jp" else "KRW"
    document_id = "EDINET-1" if market_scope == "jp" else "DART-1"
    disclosure = JpKrDisclosureRecord(
        market_scope=market_scope,
        exchange=exchange,
        ticker=ticker,
        disclosure_kind="ANNUAL_REPORT",
        event_headline_local="annual report",
        event_body_url=None,
        event_time_utc=available,
        available_at_utc=available,
        source_kind=source_kind,
        source_document_id=document_id,
        source_version="filing-v1",
        fact_hash="a" * 64,
        source_payload={},
    )
    financial = JpKrFinancialRecord(
        market_scope=market_scope,
        exchange=exchange,
        ticker=ticker,
        fiscal_period_kind="ANNUAL",
        fiscal_period_start=date(2025, 1, 1),
        fiscal_period_end=available.date(),
        fiscal_quarter=None,
        currency=currency,
        is_consolidated=True,
        revenue=Decimal("1000"),
        eps=Decimal("10"),
        net_income=Decimal("100"),
        total_assets=Decimal("5000"),
        total_equity=Decimal("2500"),
        total_liabilities=Decimal("2500"),
        operating_cash_flow=Decimal("120"),
        research_and_development=Decimal("25"),
        segment_facts=(),
        taxonomy_version="taxonomy-v1" if market_scope == "jp" else None,
        parser_version="parser-v1",
        account_mapping_version="mapping-v1" if market_scope == "kr" else None,
        concept_provenance={},
        parse_warnings=(),
        source_payload={},
        source_kind=source_kind,
        source_document_id=document_id,
        source_version="financial-v1",
        effective_at_utc=available,
        available_at_utc=available,
        fact_hash="b" * 64,
    )
    return JpKrFilingEnvelope(disclosure, (financial,))


def _text_hit(*, available=NOW, market_scope="jp"):
    ticker = "7203" if market_scope == "jp" else "005930"
    market = "JP" if market_scope == "jp" else "KR"
    language = "ja" if market_scope == "jp" else "ko"
    document = ScanDocument(
        document_id="text-1",
        ticker=ticker,
        market=market,
        market_scope=market_scope,
        language=language,
        title="capacity expansion",
        body="capacity expansion plan",
        published_at_utc=available,
        available_at_utc=available,
        source_kind="official-disclosure",
        source_version="capture-v1",
        source_url=None,
        document_fact_hash="c" * 64,
    )
    hit = TextHit(
        term_id="capacity",
        hit_kind="EARLY_NEWS",
        document_id=document.document_id,
        ticker=ticker,
        language=language,
        field="TITLE",
        start_offset=0,
        end_offset=8,
        context_hash="d" * 64,
        taxonomy_version="text-taxonomy-v1",
    )
    return TextHitEnvelope(document, hit)


def _features(profile="japan_blue_chip", market_scope="jp"):
    return {
        "score": {
            "rating": "A",
            "total": 90.0,
            "profile": profile,
            "market_scope": market_scope,
            "dims": [{"key": "Q", "score": 90.0, "band": "A", "weight": 1.0}],
        },
        "conviction": {
            "base": 80.0,
            "adjustments": [],
            "final": 80.0,
            "level": "HIGH",
        },
        "risk_gate": {
            "gate": "GREEN",
            "ok_to_enter": True,
            "triggers": [],
        },
        "entry_plan": {
            "size_hint": {
                "tier": "TIER_3",
                "pct": 3.0,
                "disclaimer_key": "size_hint_advisory",
            },
            "stop_distance_pct": 4.0,
        },
    }


def _score(
    *, profile="japan_blue_chip", market_scope="jp", available=NOW
):
    features = _features(profile, market_scope)
    values = {
        "ticker": "7203" if market_scope == "jp" else "005930",
        "profile": profile,
        "market_scope": market_scope,
        "as_of": NOW_TEXT,
        "available_at_utc": available,
        "source_version": "score-v1",
        "features": features,
    }
    return TypedScoreRecord(
        **values,
        fact_hash=typed_score_fact_hash(**values),
    )


class Repository:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.calls = 0

    def load(self, _pins):
        self.calls += 1
        return self.snapshot


class ChangingRepository:
    def __init__(self, first, second):
        self.snapshots = (first, second)
        self.calls = 0

    def load(self, _pins):
        snapshot = self.snapshots[self.calls % 2]
        self.calls += 1
        return snapshot


def _snapshot(*, filings=None, hits=None, scores=None):
    return TypedSourceSnapshot(
        filings=filings if filings is not None else (_filing(),),
        text_hits=hits if hits is not None else (_text_hit(),),
        scores=scores if scores is not None else (_score(),),
        source_versions={
            "signals": "signals-v1",
            "universe": "universe-v1",
            "scores": "scores-v1",
            "evidence": "evidence-v1",
        },
    )


def _pins(source):
    base = ReplayPins(
        trading_day="2026-07-10",
        as_of=NOW_TEXT,
        profile="japan_blue_chip",
        market_scope="jp",
        profile_version="1.0.0",
        contract_version="0.3.1",
        input_fingerprint="0" * 64,
        strategy_version="1.0.0",
        pipeline_version="1.0.0",
    )
    return replace(base, input_fingerprint=source.input_fingerprint(base))


def _job(pins, *, job_id=str(JOB_ID)):
    return ReplayJob(
        job_id=job_id,
        idempotency_key=ReplayService._idempotency_key(pins),
        pins=pins,
        status="queued",
        created_at=NOW_TEXT,
        updated_at=NOW_TEXT,
    )


class Pipeline:
    def __init__(self):
        self.calls = []

    def run(self, pins, inputs):
        self.calls.append((pins, inputs))
        return ReplayResult(SNAPSHOT_ID, "f" * 64)


class ReplayRuntimeTests(unittest.TestCase):
    def test_typed_adapters_are_deterministic_and_authenticated(self):
        repository = Repository(_snapshot())
        sources = TypedReplaySources(repository)
        pins = _pins(sources)
        calls_after_pin_derivation = repository.calls

        first = sources.source_slices(pins)
        second = sources.source_slices(pins)

        self.assertEqual(first, second)
        self.assertEqual(tuple(item.kind for item in first), (
            "signals", "universe", "scores", "evidence"
        ))
        self.assertEqual(first[1].records, (
            {"ticker": "7203", "market_scope": "jp"},
        ))
        self.assertEqual(first[2].records[0]["fact_hash"], _score().fact_hash)
        self.assertEqual(sources.input_fingerprint(pins), pins.input_fingerprint)
        self.assertTrue(first[3].records)
        self.assertEqual(repository.calls - calls_after_pin_derivation, 3)

        repository.calls = 0
        pipeline = Pipeline()
        with _temporary_directory() as directory:
            service, worker, _ = build_typed_replay_runtime(
                repository=repository,
                pipeline=pipeline,
                job_store=AtomicFileReplayJobStore(
                    Path(directory) / "jobs.json"
                ),
                uuid_factory=lambda: JOB_ID,
                clock=lambda: NOW_TEXT,
            )
            worker.run_job(service.submit(pins).job_id)
        self.assertEqual(repository.calls, 1)

    def test_empty_valid_lists_are_authenticated(self):
        repository = Repository(_snapshot(scores=()))
        sources = TypedReplaySources(repository)
        pins = _pins(sources)
        slices = sources.source_slices(pins)

        self.assertEqual(slices[2].records, ())
        self.assertEqual(sources.input_fingerprint(pins), pins.input_fingerprint)

    def test_no_lookahead_scope_and_score_hash_fail_closed(self):
        future = NOW + timedelta(seconds=1)
        cases = [
            _snapshot(filings=(_filing(available=future),)),
            _snapshot(hits=(_text_hit(market_scope="kr"),)),
            _snapshot(scores=(replace(_score(), fact_hash="0" * 64),)),
            _snapshot(scores=(replace(_score(), available_at_utc=future),)),
        ]
        for snapshot in cases:
            with self.subTest(snapshot=snapshot):
                sources = TypedReplaySources(Repository(snapshot))
                pins = ReplayPins(
                    trading_day="2026-07-10",
                    as_of=NOW_TEXT,
                    profile="japan_blue_chip",
                    market_scope="jp",
                    profile_version="1.0.0",
                    contract_version="0.3.1",
                    input_fingerprint="0" * 64,
                    strategy_version="1.0.0",
                    pipeline_version="1.0.0",
                )
                with self.assertRaises(Exception):
                    sources.load_evidence(pins)

    def test_one_replay_uses_one_repository_capture(self):
        changed = replace(
            _score(),
            source_version="score-v2",
        )
        changed = replace(
            changed,
            fact_hash=typed_score_fact_hash(
                ticker=changed.ticker,
                profile=changed.profile,
                market_scope=changed.market_scope,
                as_of=changed.as_of,
                available_at_utc=changed.available_at_utc,
                source_version=changed.source_version,
                features=changed.features,
            ),
        )
        repository = ChangingRepository(
            _snapshot(),
            _snapshot(scores=(changed,)),
        )
        sources = TypedReplaySources(repository)
        pins = _pins(TypedReplaySources(Repository(_snapshot())))
        with _temporary_directory() as directory:
            service, worker, _ = build_typed_replay_runtime(
                repository=repository,
                pipeline=Pipeline(),
                job_store=AtomicFileReplayJobStore(
                    Path(directory) / "jobs.json"
                ),
                uuid_factory=lambda: JOB_ID,
                clock=lambda: NOW_TEXT,
            )
            completed = worker.run_job(service.submit(pins).job_id)

        self.assertEqual(completed.status, "completed")
        self.assertEqual(repository.calls, 1)

    def test_duplicate_typed_identities_fail_closed(self):
        filing = _filing()
        hit = _text_hit()
        score = _score()
        cases = (
            _snapshot(filings=(filing, filing)),
            _snapshot(hits=(hit, hit)),
            _snapshot(scores=(score, score)),
        )
        for snapshot in cases:
            sources = TypedReplaySources(Repository(snapshot))
            pins = ReplayPins(
                trading_day="2026-07-10",
                as_of=NOW_TEXT,
                profile="japan_blue_chip",
                market_scope="jp",
                profile_version="1.0.0",
                contract_version="0.3.1",
                input_fingerprint="0" * 64,
                strategy_version="1.0.0",
                pipeline_version="1.0.0",
            )
            with self.subTest(snapshot=snapshot):
                with self.assertRaises(Exception):
                    sources.load_signals(pins)

    def test_score_contract_fails_closed_before_pipeline(self):
        mutations = [
            {"score": {"rating": "Z"}},
            {"conviction": {"final": 81.0}},
            {"risk_gate": {"gate": "RED", "ok_to_enter": True}},
            {"entry_plan": {"size_hint": {"tier": "TIER_3", "pct": 5.0}}},
            {"entry_plan": {"stop_distance_pct": True}},
        ]
        for mutation in mutations:
            features = _features()
            section, values = next(iter(mutation.items()))
            features[section].update(values)
            record = _score()
            raw = {
                "ticker": record.ticker,
                "profile": record.profile,
                "market_scope": record.market_scope,
                "as_of": record.as_of,
                "available_at_utc": record.available_at_utc,
                "source_version": record.source_version,
                "features": features,
            }
            with self.subTest(mutation=mutation):
                with self.assertRaises(Exception):
                    typed_score_fact_hash(**raw)
        with self.assertRaises(Exception):
            typed_score_fact_hash(
                ticker="7203",
                profile="japan_blue_chip",
                market_scope="jp",
                as_of=NOW_TEXT,
                available_at_utc=NOW,
                source_version="score-v1",
                features={
                    **_features(),
                    "score": {
                        **_features()["score"],
                        "total": float("nan"),
                    },
                },
            )

    def test_source_score_schema_rejects_unknown_missing_and_nested_shape(self):
        valid = _features()
        self.assertEqual(
            validate_source_score_features(
                valid,
                profile="japan_blue_chip",
                market_scope="jp",
            ),
            valid,
        )
        corrupt = []
        unknown_root = _features()
        unknown_root["recommendation"] = {}
        corrupt.append(unknown_root)
        missing_score = _features()
        del missing_score["score"]["dims"]
        corrupt.append(missing_score)
        unknown_dimension = _features()
        unknown_dimension["score"]["dims"][0]["evidence"] = []
        corrupt.append(unknown_dimension)
        bad_adjustment = _features()
        bad_adjustment["conviction"]["adjustments"] = [
            {"delta": 1.0, "reason": "valid", "unknown": True}
        ]
        bad_adjustment["conviction"]["final"] = 81.0
        corrupt.append(bad_adjustment)
        bad_trigger = _features()
        bad_trigger["risk_gate"] = {
            "gate": "YELLOW",
            "ok_to_enter": False,
            "triggers": [
                {
                    "code": "EDINET_DELAY",
                    "severity": "warn",
                    "detail": "late",
                    "extra": True,
                }
            ],
        }
        corrupt.append(bad_trigger)
        bool_dimension = _features()
        bool_dimension["score"]["dims"][0]["score"] = True
        corrupt.append(bool_dimension)
        nonfinite_nested = _features()
        nonfinite_nested["score"]["dims"][0]["weight"] = float("inf")
        corrupt.append(nonfinite_nested)
        rating_mismatch = _features()
        rating_mismatch["score"]["total"] = 0.0
        corrupt.append(rating_mismatch)
        dimension_band_mismatch = _features()
        dimension_band_mismatch["score"]["dims"][0]["band"] = "F"
        corrupt.append(dimension_band_mismatch)
        conviction_level_mismatch = _features()
        conviction_level_mismatch["conviction"]["level"] = "LOW"
        corrupt.append(conviction_level_mismatch)
        for features in corrupt:
            with self.subTest(features=features):
                with self.assertRaises(Exception):
                    validate_source_score_features(
                        features,
                        profile="japan_blue_chip",
                        market_scope="jp",
                    )

    def test_score_hash_binds_exact_validated_source_object(self):
        record = _score()
        tampered = _features()
        tampered["conviction"]["final"] = 81.0
        with self.assertRaises(Exception):
            typed_score_fact_hash(
                ticker=record.ticker,
                profile=record.profile,
                market_scope=record.market_scope,
                as_of=record.as_of,
                available_at_utc=record.available_at_utc,
                source_version=record.source_version,
                features=tampered,
            )

    def test_atomic_durable_store_idempotency_and_cas(self):
        with _temporary_directory() as directory:
            path = Path(directory) / "jobs.json"
            store = AtomicFileReplayJobStore(path)
            sources = TypedReplaySources(Repository(_snapshot()))
            pins = _pins(sources)
            job = _job(pins)

            first, created = store.create_or_get(job)
            second, created_again = store.create_or_get(job)
            running = job.running(NOW_TEXT)
            transitioned = store.transition(job.job_id, "queued", running)

            self.assertTrue(created)
            self.assertFalse(created_again)
            self.assertEqual(first, second)
            self.assertEqual(transitioned, running)
            self.assertEqual(AtomicFileReplayJobStore(path).get(job.job_id), running)
            with self.assertRaises(ReplayConflictError):
                store.transition(job.job_id, "queued", running)

            path.write_text('{"version":1,"jobs":[],"keys":{}}')
            with self.assertRaises(ReplayJobStoreCorruptError):
                store.get(job.job_id)

    def test_store_rejects_corrupt_identity_and_key_indexes(self):
        with _temporary_directory() as directory:
            path = Path(directory) / "jobs.json"
            store = AtomicFileReplayJobStore(path)
            sources = TypedReplaySources(Repository(_snapshot()))
            pins = _pins(sources)
            job = _job(pins)
            store.create_or_get(job)
            original = path.read_text()
            for mutation in (
                original.replace(job.job_id, SNAPSHOT_ID, 1),
                original.replace(
                    f'"{job.idempotency_key}":"{job.job_id}"',
                    f'"{"0" + job.idempotency_key[1:]}":"{job.job_id}"',
                    1,
                ),
                original.replace(
                    '"keys":{',
                    '"keys":{},"ignored":{},"spare":{',
                    1,
                ),
            ):
                path.write_text(mutation)
                with self.assertRaises(ReplayJobStoreCorruptError):
                    store.get(job.job_id)
            path.write_text(original)
            self.assertEqual(store.get(job.job_id), job)

    def test_store_strict_json_exact_state_and_file_policy(self):
        corrupt_documents = (
            '{"version":1,"version":1,"jobs":{},"keys":{}}',
            '{"version":NaN,"jobs":{},"keys":{}}',
            '{"version":1,"jobs":{},"keys":{},"extra":true}',
        )
        with _temporary_directory() as directory:
            root = Path(directory)
            for index, content in enumerate(corrupt_documents):
                path = root / f"corrupt-{index}.json"
                path.write_text(content)
                os.chmod(path, 0o600)
                store = AtomicFileReplayJobStore(path)
                with self.assertRaises(ReplayJobStoreCorruptError):
                    store.get(str(JOB_ID))

            permissive = root / "permissive.json"
            permissive.write_text('{"version":1,"jobs":{},"keys":{}}')
            os.chmod(permissive, 0o644)
            with self.assertRaises(ReplayJobStoreConfigurationError):
                AtomicFileReplayJobStore(permissive)

            target = root / "target.json"
            target.write_text('{"version":1,"jobs":{},"keys":{}}')
            os.chmod(target, 0o600)
            symlink = root / "symlink.json"
            symlink.symlink_to(target)
            with self.assertRaises(ReplayJobStoreConfigurationError):
                AtomicFileReplayJobStore(symlink)

            safe = root / "safe.json"
            AtomicFileReplayJobStore(safe)
            self.assertEqual(
                stat.S_IMODE(safe.stat().st_mode),
                0o600,
            )
            self.assertEqual(
                stat.S_IMODE(
                    safe.with_name(safe.name + ".lock").stat().st_mode
                ),
                0o600,
            )

    def test_store_path_is_explicit_and_does_not_create_parent(self):
        with _temporary_directory() as directory:
            path = Path(directory) / "missing" / "jobs.json"
            with self.assertRaises(ReplayJobStoreConfigurationError):
                AtomicFileReplayJobStore(path)
            with self.assertRaises(ReplayJobStoreConfigurationError):
                AtomicFileReplayJobStore(Path("relative.json"))

    def test_store_rejects_unsafe_parent_namespace_before_files(self):
        with _temporary_directory() as directory:
            root = Path(directory)
            for mode in (0o770, 0o777):
                unsafe = root / f"unsafe-{mode:o}"
                unsafe.mkdir(mode=mode)
                os.chmod(unsafe, mode)
                with self.assertRaises(ReplayJobStoreConfigurationError):
                    AtomicFileReplayJobStore(unsafe / "jobs.json")
                self.assertEqual(list(unsafe.iterdir()), [])

            real = root / "real"
            real.mkdir(mode=0o700)
            redirected = root / "redirected"
            redirected.symlink_to(real, target_is_directory=True)
            with self.assertRaises(ReplayJobStoreConfigurationError):
                AtomicFileReplayJobStore(redirected / "jobs.json")
            self.assertEqual(list(real.iterdir()), [])

            owned = root / "owned"
            owned.mkdir(mode=0o700)
            real_geteuid = os.geteuid()
            with patch(
                "ai.replay.file_store.os.geteuid",
                return_value=real_geteuid + 1,
            ):
                with self.assertRaises(ReplayJobStoreConfigurationError):
                    AtomicFileReplayJobStore(owned / "jobs.json")
            self.assertEqual(list(owned.iterdir()), [])

    def test_store_rejects_wrong_owner_state_and_lock(self):
        real_geteuid = os.geteuid()
        fake_uid = real_geteuid + 1
        with _temporary_directory() as directory:
            root = Path(directory)
            state = root / "jobs.json"
            state.write_text('{"version":1,"jobs":{},"keys":{}}')
            os.chmod(state, 0o600)
            real_stat = os.stat

            def wrong_state(path, *args, **kwargs):
                result = real_stat(path, *args, **kwargs)
                if path == "jobs.json":
                    values = list(result)
                    values[4] = fake_uid
                    return os.stat_result(values)
                return result

            with patch(
                "ai.replay.file_store.os.stat",
                side_effect=wrong_state,
            ):
                with self.assertRaises(ReplayJobStoreConfigurationError):
                    AtomicFileReplayJobStore(state)

            state.unlink()
            lock = root / "jobs.json.lock"
            lock.write_text("")
            os.chmod(lock, 0o600)

            def wrong_lock(path, *args, **kwargs):
                result = real_stat(path, *args, **kwargs)
                if path == "jobs.json.lock":
                    values = list(result)
                    values[4] = fake_uid
                    return os.stat_result(values)
                return result

            with patch(
                "ai.replay.file_store.os.stat",
                side_effect=wrong_lock,
            ):
                with self.assertRaises(ReplayJobStoreConfigurationError):
                    AtomicFileReplayJobStore(root / "jobs.json")

    def test_open_store_survives_parent_name_retarget_via_dirfd(self):
        with _temporary_directory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir(mode=0o700)
            store = AtomicFileReplayJobStore(runtime / "jobs.json")
            pins = _pins(TypedReplaySources(Repository(_snapshot())))
            first = _job(pins)
            store.create_or_get(first)

            original = root / "runtime-original"
            runtime.rename(original)
            replacement = root / "runtime"
            replacement.mkdir(mode=0o700)
            second = _job(
                replace(pins, trading_day="2026-07-11"),
                job_id="32345678-1234-4234-8234-567812345678",
            )
            store.create_or_get(second)

            self.assertIn(second.job_id, (original / "jobs.json").read_text())
            self.assertEqual(list(replacement.iterdir()), [])
            store.close()

    def test_store_rejects_invalid_proposals_before_disk_write(self):
        with _temporary_directory() as directory:
            path = Path(directory) / "jobs.json"
            store = AtomicFileReplayJobStore(path)
            before = path.read_text()
            pins = _pins(TypedReplaySources(Repository(_snapshot())))
            invalid = replace(
                _job(pins),
                idempotency_key="0" * 64,
            )
            with self.assertRaises(ReplayConflictError):
                store.create_or_get(invalid)
            self.assertEqual(path.read_text(), before)

            valid = _job(pins)
            store.create_or_get(valid)
            persisted = path.read_text()
            invalid_transition = replace(
                valid.running(NOW_TEXT),
                pins=replace(pins, profile="custom"),
            )
            with self.assertRaises(ReplayConflictError):
                store.transition(
                    valid.job_id, "queued", invalid_transition
                )
            self.assertEqual(path.read_text(), persisted)

    def test_corrupt_semantic_job_errors_are_normalized(self):
        with _temporary_directory() as directory:
            path = Path(directory) / "jobs.json"
            store = AtomicFileReplayJobStore(path)
            pins = _pins(TypedReplaySources(Repository(_snapshot())))
            job = _job(pins)
            store.create_or_get(job)
            path.write_text(
                path.read_text().replace(
                    '"profile":"japan_blue_chip"',
                    '"profile":"custom"',
                )
            )
            with self.assertRaises(ReplayJobStoreCorruptError) as raised:
                store.get(job.job_id)
            self.assertNotIn(str(path), str(raised.exception))

    def test_worker_completes_and_retry_is_deterministic(self):
        with _temporary_directory() as directory:
            repository = Repository(_snapshot())
            sources = TypedReplaySources(repository)
            pins = _pins(sources)
            pipeline = Pipeline()
            service, worker, _ = build_typed_replay_runtime(
                repository=repository,
                pipeline=pipeline,
                job_store=AtomicFileReplayJobStore(
                    Path(directory) / "jobs.json"
                ),
                uuid_factory=lambda: JOB_ID,
                clock=lambda: NOW_TEXT,
            )
            queued = service.submit(pins)
            repeated = service.submit(pins)
            completed = worker.run_job(queued.job_id)
            terminal_retry = worker.run_job(queued.job_id)

            self.assertEqual(queued, repeated)
            self.assertEqual(completed.status, "completed")
            self.assertEqual(completed.snapshot_id, SNAPSHOT_ID)
            self.assertEqual(terminal_retry, completed)
            self.assertEqual(len(pipeline.calls), 1)

    def test_worker_batch_is_bounded_and_rejects_duplicates(self):
        service = object.__new__(ReplayService)
        worker = ReplayWorker(service)
        for job_ids, limit in (
            (("a",), 0),
            (("a",), 101),
            (("a", "a"), 1),
        ):
            with self.subTest(job_ids=job_ids, limit=limit):
                with self.assertRaises(ValueError):
                    worker.run_batch(job_ids, limit=limit)

    def test_all_six_profiles_construct_typed_slices(self):
        pairs = (
            ("us_preferred", "us"),
            ("multibagger", "cn_a"),
            ("japan_blue_chip", "jp"),
            ("japan_multibagger", "jp"),
            ("korea_semiconductor_chain", "kr"),
            ("korea_multibagger", "kr"),
        )
        for profile, scope in pairs:
            with self.subTest(profile=profile, scope=scope):
                record = _score(profile=profile, market_scope=scope)
                sources = TypedReplaySources(
                    Repository(
                        _snapshot(
                            filings=(),
                            hits=(),
                            scores=(record,),
                        )
                    )
                )
                base = ReplayPins(
                    trading_day="2026-07-10",
                    as_of=NOW_TEXT,
                    profile=profile,
                    market_scope=scope,
                    profile_version="1.0.0",
                    contract_version="0.3.1",
                    input_fingerprint="0" * 64,
                    strategy_version="1.0.0",
                    pipeline_version="1.0.0",
                )
                slices = sources.source_slices(base)
                self.assertEqual(slices[1].records[0]["ticker"], record.ticker)


if __name__ == "__main__":
    unittest.main()
