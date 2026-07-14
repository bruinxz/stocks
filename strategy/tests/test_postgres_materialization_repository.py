from dataclasses import asdict
from datetime import timezone
import unittest

from ai.snapshot.postgres_store import SnapshotStoreConnectionError
from strategy.materialization import (
    MaterializationSourceError,
    PostgresMaterializationRepository,
)
from strategy.tests.test_multibagger_candidate_materializer import (
    NOW,
    text_hit,
    universe_fact,
)


class Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.current = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, sql, params=None):
        self.connection.calls.append((sql, params))
        if self.connection.failure is not None:
            raise self.connection.failure
        if sql.startswith("SET TRANSACTION"):
            self.current = []
        elif "FROM multibagger_universe" in sql:
            self.current = self.connection.universe_rows
        elif "FROM multibagger_text_hit" in sql:
            self.current = self.connection.text_rows
        else:
            raise AssertionError("unexpected SQL")

    def fetchall(self):
        return self.current


class Transaction:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class Connection:
    def __init__(self, universe_rows, text_rows, versions, failure=None):
        self.universe_rows = universe_rows
        self.text_rows = text_rows
        self.versions = versions
        self.failure = failure
        self.calls = []
        self.closed = False

    def transaction(self):
        return Transaction()

    def cursor(self):
        return Cursor(self)

    def close(self):
        self.closed = True


def source_rows():
    source = universe_fact()
    hit = text_hit()
    source_row = asdict(source)
    source_row["evidence_refs"] = list(source.evidence_refs)
    source_row["text_hit_kinds"] = list(source.text_hit_kinds)
    hit_row = asdict(hit)
    return source, hit, source_row, hit_row


class PostgresMaterializationRepositoryTests(unittest.TestCase):
    def test_loads_authenticated_pit_sources_without_lossy_defaults(self):
        source, hit, source_row, hit_row = source_rows()
        connection = Connection(
            [source_row],
            [hit_row],
            [{"source_version": source.source_version}],
        )
        repository = PostgresMaterializationRepository(
            "postgresql://user:password@localhost/test",
            connector=lambda _url: connection,
        )

        sources, hits = repository.load(
            market_scope="jp", exchange="tse", ticker="1301", as_of_utc=NOW
        )

        self.assertEqual(sources, (source,))
        self.assertEqual(hits, (hit,))
        self.assertTrue(connection.closed)
        self.assertIn("REPEATABLE READ READ ONLY", connection.calls[0][0])
        universe_params = connection.calls[1][1]
        self.assertEqual(universe_params[:3], ("jp", "tse", "1301"))
        self.assertEqual(universe_params[3:], (NOW, NOW, NOW))
        self.assertEqual(connection.calls[2][1], ("jp", "1301", NOW, NOW))
        self.assertEqual(sources[0].available_at_utc.tzinfo, timezone.utc)

    def test_missing_universe_fails_closed(self):
        _source, _hit, _source_row, _hit_row = source_rows()
        missing = Connection([], [], [])
        repository = PostgresMaterializationRepository(
            "postgresql://user:password@localhost/test",
            connector=lambda _url: missing,
        )
        with self.assertRaisesRegex(
            MaterializationSourceError, "no PIT-visible universe"
        ):
            repository.load(
                market_scope="jp", exchange="tse", ticker="1301", as_of_utc=NOW
            )
        self.assertTrue(missing.closed)

    def test_database_failure_is_redacted_and_connection_is_closed(self):
        secret = "postgresql://user:do-not-leak@localhost/test"
        connection = Connection([], [], [], failure=RuntimeError(secret))
        repository = PostgresMaterializationRepository(
            secret, connector=lambda _url: connection
        )
        with self.assertRaises(SnapshotStoreConnectionError) as raised:
            repository.load(
                market_scope="jp", exchange="tse", ticker="1301", as_of_utc=NOW
            )
        self.assertNotIn("do-not-leak", str(raised.exception))
        self.assertTrue(connection.closed)


if __name__ == "__main__":
    unittest.main()
