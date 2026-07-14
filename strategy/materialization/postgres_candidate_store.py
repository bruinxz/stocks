"""Injected psycopg3 CandidateStore for multibagger candidate snapshots."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Optional

from ai.snapshot.fingerprint import jcs_canonicalize
from ai.snapshot.postgres_store import (
    SnapshotStoreConfigurationError,
    SnapshotStoreConnectionError,
    SnapshotStoreDependencyError,
    validate_database_url,
)
from strategy.materialization.multibagger_candidate import (
    CandidateIdempotencyConflict,
    CandidateSnapshot,
    candidate_from_row,
    candidate_to_row,
)


SELECT_SQL = """
SELECT
  market_scope, exchange, ticker,
  to_char(as_of_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS as_of_utc,
  to_char(available_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    AS available_at_utc,
  stage, conclusion, score, rating, conviction, risk_gate, entry_plan,
  latest_catalyst, source_fact_hashes, strategy_version,
  classification_policy_version, classification_reason_codes, fact_hash
FROM multibagger_candidate_snapshot
WHERE market_scope = %s
  AND exchange = %s
  AND ticker = %s
  AND as_of_utc = %s::timestamptz
  AND strategy_version = %s
"""
INSERT_SQL = """
INSERT INTO multibagger_candidate_snapshot (
  market_scope, exchange, ticker, as_of_utc, available_at_utc,
  stage, conclusion, score, rating, conviction, risk_gate, entry_plan,
  latest_catalyst, source_fact_hashes, strategy_version,
  classification_policy_version, classification_reason_codes, fact_hash
) VALUES (
  %s, %s, %s, %s::timestamptz, %s::timestamptz,
  %s, %s, %s::jsonb, %s, %s::jsonb, %s::jsonb, %s::jsonb,
  %s::jsonb, %s::jsonb, %s, %s, %s::jsonb, %s
)
"""


def _default_connector(database_url: str):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise SnapshotStoreDependencyError("psycopg3 is required") from error
    try:
        return psycopg.connect(
            database_url,
            row_factory=dict_row,
            connect_timeout=5,
            application_name="stocks-multibagger-candidate-store",
            passfile="",
        )
    except Exception as error:
        raise SnapshotStoreConnectionError(
            "unable to connect using DATABASE_URL"
        ) from error


def _lock_key(identity: tuple[str, ...]) -> int:
    import hashlib

    value = int.from_bytes(
        hashlib.sha256("\0".join(identity).encode()).digest()[:8], "big"
    )
    return value if value < 2**63 else value - 2**64


class PostgresCandidateStore:
    def __init__(
        self, database_url: str, *, connector: Optional[Callable[[str], Any]] = None
    ):
        self._database_url = validate_database_url(database_url)
        self._connector = connector or _default_connector

    def _connect(self):
        try:
            return self._connector(self._database_url)
        except (
            SnapshotStoreConfigurationError,
            SnapshotStoreDependencyError,
            SnapshotStoreConnectionError,
        ):
            raise
        except Exception as error:
            raise SnapshotStoreConnectionError(
                "unable to connect using DATABASE_URL"
            ) from error

    def write_or_verify(self, candidate: CandidateSnapshot) -> CandidateSnapshot:
        row = candidate_to_row(candidate)
        authenticated = candidate_from_row(row)
        if authenticated != candidate:
            raise CandidateIdempotencyConflict(
                "candidate does not match its authenticated physical row"
            )
        candidate = authenticated
        row = candidate_to_row(candidate)
        identity = candidate.identity
        connection = self._connect()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_xact_lock(%s)", (_lock_key(identity),))
                    cursor.execute(SELECT_SQL, identity)
                    existing = cursor.fetchone()
                    if existing is not None:
                        hydrated = candidate_from_row(existing)
                        if hydrated != candidate:
                            raise CandidateIdempotencyConflict(
                                "candidate identity has different immutable content"
                            )
                        return hydrated
                    cursor.execute(
                        INSERT_SQL,
                        (
                            row["market_scope"],
                            row["exchange"],
                            row["ticker"],
                            row["as_of_utc"],
                            row["available_at_utc"],
                            row["stage"],
                            row["conclusion"],
                            jcs_canonicalize(row["score"]),
                            row["rating"],
                            jcs_canonicalize(row["conviction"]),
                            jcs_canonicalize(row["risk_gate"]),
                            None
                            if row["entry_plan"] is None
                            else jcs_canonicalize(row["entry_plan"]),
                            None
                            if row["latest_catalyst"] is None
                            else jcs_canonicalize(row["latest_catalyst"]),
                            jcs_canonicalize(row["source_fact_hashes"]),
                            row["strategy_version"],
                            row["classification_policy_version"],
                            jcs_canonicalize(row["classification_reason_codes"]),
                            row["fact_hash"],
                        ),
                    )
                    cursor.execute(SELECT_SQL, identity)
                    inserted = cursor.fetchone()
                    if inserted is None:
                        raise RuntimeError("candidate disappeared after insert")
                    hydrated = candidate_from_row(inserted)
                    if hydrated != candidate:
                        raise CandidateIdempotencyConflict(
                            "inserted candidate readback differs"
                        )
                    return hydrated
        finally:
            connection.close()
