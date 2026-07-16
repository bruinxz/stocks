from dataclasses import asdict
from io import BytesIO, StringIO
import hashlib
import json
import os
import pwd
import unittest
from unittest.mock import patch

from ai.snapshot.fingerprint import jcs_canonicalize
from strategy.materialization import candidate_from_row
from strategy.materialization import cli
from strategy.tests.test_multibagger_candidate_materializer import request


class Input:
    def __init__(self, raw):
        self.buffer = BytesIO(raw)


class Repository:
    def __init__(self, materialization):
        self.materialization = materialization
        self.calls = []

    def load(self, **kwargs):
        self.calls.append(kwargs)
        return self.materialization.sources, self.materialization.text_hits


class Store:
    def __init__(self):
        self.calls = []

    def write_or_verify(self, candidate):
        self.calls.append(candidate)
        return candidate


def payload():
    value = request()
    catalyst = asdict(value.latest_catalyst)
    catalyst["occurred_at"] = value.latest_catalyst.occurred_at.isoformat().replace(
        "+00:00", "Z"
    )
    catalyst["available_at_utc"] = (
        value.latest_catalyst.available_at_utc.isoformat().replace("+00:00", "Z")
    )
    return {
        "market_scope": value.market_scope,
        "exchange": value.exchange,
        "ticker": value.ticker,
        "as_of_utc": value.as_of_utc.isoformat().replace("+00:00", "Z"),
        "decision": {
            "score": dict(value.decision.score),
            "conviction": dict(value.decision.conviction),
            "risk_gate": dict(value.decision.risk_gate),
            "entry_plan": dict(value.decision.entry_plan),
            "strategy_version": value.decision.strategy_version,
        },
        "classification": {
            "stage": "early",
            "conclusion": "MULTIBAGGER_2X",
            "policy_version": "stage-policy@1.0.0",
            "reason_codes": ["CAPTURED_SOURCE", "OPTIONALITY_HIT"],
        },
        "latest_catalyst": catalyst,
    }


def invoke(raw, argv, environment, repository, store=None):
    stdout = StringIO()
    stderr = StringIO()
    patches = [
        patch.object(cli.sys, "stdin", Input(raw)),
        patch.object(cli.sys, "stdout", stdout),
        patch.object(cli.sys, "stderr", stderr),
        patch.object(cli, "PostgresMaterializationRepository", return_value=repository),
        patch.dict(os.environ, environment, clear=True),
    ]
    if store is not None:
        patches.append(patch.object(cli, "PostgresCandidateStore", return_value=store))
    for active in patches:
        active.start()
    try:
        code = cli.main(argv)
    finally:
        for active in reversed(patches):
            active.stop()
    return code, stdout.getvalue(), stderr.getvalue()


class MaterializationCliTests(unittest.TestCase):
    def test_default_is_dry_run_and_emits_authenticated_candidate(self):
        materialization = request()
        repository = Repository(materialization)
        raw = json.dumps(payload(), ensure_ascii=False).encode("utf-8")
        code, stdout, stderr = invoke(
            raw,
            [],
            {"TAB4_DATABASE_URL": "postgresql://user:password@localhost/test"},
            repository,
        )

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        candidate = candidate_from_row(json.loads(stdout))
        self.assertEqual(candidate.ticker, "1301")
        self.assertEqual(len(repository.calls), 1)

    def test_unloaded_catalyst_source_ref_cannot_be_resealed_by_cli(self):
        materialization = request()
        repository = Repository(materialization)
        value = payload()
        catalyst = value["latest_catalyst"]
        catalyst["source_ref"] = "unloaded:document:1301"
        projection = dict(catalyst)
        projection.pop("fact_hash")
        catalyst["fact_hash"] = hashlib.sha256(
            jcs_canonicalize(projection).encode("utf-8")
        ).hexdigest()

        code, stdout, stderr = invoke(
            json.dumps(value).encode("utf-8"),
            [],
            {"TAB4_DATABASE_URL": "postgresql://user:password@localhost/test"},
            repository,
        )

        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(stderr, "multibagger materialization failed\n")
        self.assertEqual(len(repository.calls), 1)

    def test_disposable_write_requires_all_guards_and_is_idempotent_entrypoint(self):
        materialization = request()
        repository = Repository(materialization)
        store = Store()
        raw = json.dumps(payload()).encode("utf-8")
        username = pwd.getpwuid(os.getuid()).pw_name
        environment = {
            "TAB4_DATABASE_URL": (
                f"postgresql://{username}@/stocks_tab4_{os.getuid()}_"
                "0123456789abcdef01234567?host=/tmp&port=5432"
            ),
            "TAB4_CANDIDATE_DISPOSABLE_WRITE": "1",
        }
        with (
            patch.object(cli.Path, "is_dir", return_value=True),
            patch.object(cli.Path, "is_socket", return_value=True),
        ):
            code, stdout, stderr = invoke(
                raw, ["--write-disposable"], environment, repository, store
            )

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(candidate_from_row(json.loads(stdout)), store.calls[0])

        code, stdout, stderr = invoke(
            raw,
            ["--write-disposable"],
            {"TAB4_DATABASE_URL": environment["TAB4_DATABASE_URL"]},
            repository,
            store,
        )
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(stderr, "multibagger materialization failed\n")

        code, stdout, stderr = invoke(
            raw,
            ["--write-disposable"],
            {
                "TAB4_DATABASE_URL": f"postgresql://{username}@/stocks_tab4_prod?host=/tmp",
                "TAB4_CANDIDATE_DISPOSABLE_WRITE": "1",
            },
            repository,
            store,
        )
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(stderr, "multibagger materialization failed\n")

    def test_disposable_write_guard_accepts_a_non_default_unix_socket_port(self):
        username = pwd.getpwuid(os.getuid()).pw_name
        database_url = (
            f"postgresql://{username}@/stocks_tab4_{os.getuid()}_"
            "0123456789abcdef01234567?host=/private/socket&port=55432"
        )
        environment = {"TAB4_CANDIDATE_DISPOSABLE_WRITE": "1"}
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(cli.Path, "is_dir", return_value=True),
            patch.object(cli.Path, "is_socket", return_value=True) as is_socket,
        ):
            cli._require_disposable(database_url)

        self.assertEqual(
            is_socket.call_args.args[0],
            cli.Path("/private/socket/.s.PGSQL.55432"),
        )

    def test_strict_json_and_generic_errors_do_not_leak(self):
        repository = Repository(request())
        for raw in (
            b'{"market_scope":"jp","market_scope":"us"}',
            b'{"value":NaN}',
            b'{}',
        ):
            code, stdout, stderr = invoke(
                raw,
                [],
                {"TAB4_DATABASE_URL": "postgresql://user:secret@localhost/test"},
                repository,
            )
            self.assertEqual((code, stdout), (2, ""))
            self.assertEqual(stderr, "multibagger materialization failed\n")
            self.assertNotIn("secret", stderr)


if __name__ == "__main__":
    unittest.main()
