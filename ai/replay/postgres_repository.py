"""Fail-closed PostgreSQL reader for immutable typed replay captures."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import os
from typing import Any, Optional

from ai.replay.service import ReplayService, ReplaySourceError
from ai.replay.runtime import TypedSourceSnapshot
from ai.replay.typed_capture import (
    CAPTURE_COLUMNS,
    filing_envelope_from_json,
    hydrate_typed_capture,
    text_hit_envelope_from_json,
    typed_financial_fact_hash,
    typed_scan_document_fact_hash,
    typed_score_record_from_json,
    typed_source_capture_hash,
    typed_text_context_hash,
)
from ai.replay.types import ReplayPins
from ai.snapshot.postgres_store import validate_database_url


_CAPTURE_PROJECTION = ", ".join(CAPTURE_COLUMNS)

SELECT_CAPTURE = f"""
SELECT {_CAPTURE_PROJECTION}
FROM ai_replay_typed_source_capture
WHERE trading_day = %s::date
  AND as_of_utc = %s::timestamptz
  AND profile = %s
  AND market_scope = %s
  AND profile_version = %s
  AND contract_version = %s
  AND input_fingerprint = %s
  AND strategy_version = %s
  AND pipeline_version = %s
  AND available_at_utc <= %s::timestamptz
ORDER BY capture_id ASC
"""

_FORBIDDEN_LIBPQ_ENV = (
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
)


class TypedSourceRepositoryConfigurationError(ValueError):
    """The repository connection boundary is missing or ambiguous."""


class TypedSourceRepositoryDependencyError(RuntimeError):
    """The required psycopg3 runtime is unavailable."""


class TypedSourceRepositoryReadError(RuntimeError):
    """The capture could not be read without leaking connection details."""


def _default_connector(database_url: str):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise TypedSourceRepositoryDependencyError(
            "psycopg3 is required for PostgresTypedSourceRepository"
        ) from error
    try:
        return psycopg.connect(
            database_url,
            row_factory=dict_row,
            connect_timeout=5,
            application_name="stocks-ai-typed-replay-source",
            passfile="",
        )
    except Exception as error:
        raise TypedSourceRepositoryReadError(
            "unable to connect using DATABASE_URL"
        ) from error


Connector = Callable[[str], Any]


class PostgresTypedSourceRepository:
    """Load one exact immutable capture in one read-only DB transaction."""

    def __init__(
        self,
        database_url: str,
        *,
        connector: Optional[Connector] = None,
    ) -> None:
        try:
            self._database_url = validate_database_url(database_url)
        except ValueError as error:
            raise TypedSourceRepositoryConfigurationError(
                "DATABASE_URL is invalid for typed replay sources"
            ) from error
        self._connector = connector or _default_connector

    @classmethod
    def from_env(
        cls,
        environ: Optional[Mapping[str, str]] = None,
        *,
        connector: Optional[Connector] = None,
    ) -> "PostgresTypedSourceRepository":
        source = os.environ if environ is None else environ
        if any(source.get(variable) for variable in _FORBIDDEN_LIBPQ_ENV):
            raise TypedSourceRepositoryConfigurationError(
                "libpq environment fallbacks are forbidden with DATABASE_URL"
            )
        return cls(source.get("DATABASE_URL", ""), connector=connector)

    def load(self, pins: ReplayPins) -> TypedSourceSnapshot:
        # Invalid/custom profile-scope pairs must fail before any connection.
        ReplayService._validate_pins(pins)
        connection = self._connect()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
                    )
                    cursor.execute(SELECT_CAPTURE, _pin_parameters(pins))
                    rows = cursor.fetchall()
        except ReplaySourceError:
            raise
        except Exception as error:
            raise TypedSourceRepositoryReadError(
                "unable to load typed replay source capture"
            ) from error
        finally:
            connection.close()

        if len(rows) != 1:
            if not rows:
                raise ReplaySourceError("typed source capture not found")
            raise ReplaySourceError("typed source capture identity is duplicated")
        return hydrate_typed_capture(rows[0], pins).prepared.snapshot

    def _connect(self):
        try:
            return self._connector(self._database_url)
        except (
            TypedSourceRepositoryConfigurationError,
            TypedSourceRepositoryDependencyError,
            TypedSourceRepositoryReadError,
        ):
            raise
        except Exception as error:
            raise TypedSourceRepositoryReadError(
                "unable to connect using DATABASE_URL"
            ) from error


def _pin_parameters(pins: ReplayPins) -> tuple[str, ...]:
    return (
        pins.trading_day,
        pins.as_of,
        pins.profile,
        pins.market_scope,
        pins.profile_version,
        pins.contract_version,
        pins.input_fingerprint,
        pins.strategy_version,
        pins.pipeline_version,
        pins.as_of,
    )


def _snapshot_from_capture(
    row: Mapping[str, Any], pins: ReplayPins
) -> TypedSourceSnapshot:
    """Compatibility shim; hydration authority lives in typed_capture."""

    return hydrate_typed_capture(row, pins).prepared.snapshot
