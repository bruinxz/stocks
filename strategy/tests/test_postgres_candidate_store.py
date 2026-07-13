import copy
import unittest

from strategy.materialization import (
    CandidateIdempotencyConflict,
    PostgresCandidateStore,
    candidate_to_row,
)
from ai.snapshot.postgres_store import (
    SnapshotStoreConfigurationError,
    SnapshotStoreConnectionError,
)
from strategy.tests.test_multibagger_candidate_materializer import Policy, request
from strategy.materialization import materialize_candidate


class Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.current = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, sql, params):
        if "pg_advisory" in sql:
            self.current = None
        elif sql.lstrip().startswith("SELECT"):
            self.current = copy.deepcopy(self.connection.row)
        elif sql.lstrip().startswith("INSERT"):
            candidate = self.connection.proposed
            self.connection.row = candidate_to_row(candidate)
            if self.connection.tamper_insert:
                self.connection.row["classification_policy_version"] = "tampered"
            self.current = None

    def fetchone(self):
        return self.current


class Transaction:
    def __init__(self, connection):
        self.connection = connection
        self.before = None

    def __enter__(self):
        self.before = copy.deepcopy(self.connection.row)

    def __exit__(self, exc_type, *_):
        if exc_type:
            self.connection.row = self.before


class Connection:
    def __init__(self, proposed=None, tamper_insert=False):
        self.proposed = proposed
        self.tamper_insert = tamper_insert
        self.row = None
        self.closed = False

    def transaction(self):
        return Transaction(self)

    def cursor(self):
        return Cursor(self)

    def close(self):
        self.closed = True


class CandidateStoreTests(unittest.TestCase):
    def test_insert_readback_replay_and_conflict(self):
        candidate = materialize_candidate(request(), Policy())
        connection = Connection(candidate)
        store = PostgresCandidateStore(
            "postgresql://user:password@localhost/test",
            connector=lambda _url: connection,
        )
        self.assertEqual(store.write_or_verify(candidate), candidate)
        self.assertTrue(connection.closed)
        connection.closed = False
        self.assertEqual(store.write_or_verify(candidate), candidate)
        changed = materialize_candidate(request(), Policy(stage="growth"))
        with self.assertRaises(CandidateIdempotencyConflict):
            store.write_or_verify(changed)

    def test_readback_tamper_rolls_back_and_rejects(self):
        candidate = materialize_candidate(request(), Policy())
        connection = Connection(candidate)
        connection.row = dict(candidate_to_row(candidate))
        connection.row["classification_policy_version"] = "tampered"
        before = copy.deepcopy(connection.row)
        store = PostgresCandidateStore(
            "postgresql://user:password@localhost/test",
            connector=lambda _url: connection,
        )
        with self.assertRaises(Exception):
            store.write_or_verify(candidate)
        self.assertEqual(connection.row, before)

    def test_insert_readback_mismatch_rolls_back(self):
        candidate = materialize_candidate(request(), Policy())
        connection = Connection(candidate, tamper_insert=True)
        store = PostgresCandidateStore(
            "postgresql://user:password@localhost/test",
            connector=lambda _url: connection,
        )
        with self.assertRaises(Exception):
            store.write_or_verify(candidate)
        self.assertIsNone(connection.row)
        self.assertTrue(connection.closed)

    def test_configuration_and_connection_failures_are_redacted(self):
        connector_calls = []
        with self.assertRaises(SnapshotStoreConfigurationError):
            PostgresCandidateStore(
                "not-postgresql://secret-value",
                connector=lambda value: connector_calls.append(value),
            )
        self.assertEqual(connector_calls, [])

        secret_url = "postgresql://user:do-not-leak@localhost/test"

        def fail(_url):
            raise RuntimeError(secret_url)

        store = PostgresCandidateStore(secret_url, connector=fail)
        with self.assertRaises(SnapshotStoreConnectionError) as raised:
            store.write_or_verify(materialize_candidate(request(), Policy()))
        self.assertNotIn("do-not-leak", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
