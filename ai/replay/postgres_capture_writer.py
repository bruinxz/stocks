"""Production PostgreSQL writer for canonical typed replay captures."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import hashlib
import os
from typing import Any, Optional
import uuid

from ai.replay.service import ReplaySourceError
from ai.replay.typed_capture import (
    CAPTURE_COLUMNS,
    PreparedTypedCapture,
    TypedCaptureReceipt,
    TypedCaptureRequest,
    hydrate_typed_capture,
    prepare_typed_capture,
)
from ai.replay.types import ReplayPins
from ai.snapshot.fingerprint import jcs_canonicalize
from ai.snapshot.postgres_store import validate_database_url


NATURAL_IDENTITY_COLUMNS = (
    "trading_day",
    "as_of_utc",
    "profile",
    "market_scope",
    "profile_version",
    "contract_version",
    "input_fingerprint",
    "strategy_version",
    "pipeline_version",
)
_CAPTURE_PROJECTION = ", ".join(CAPTURE_COLUMNS)

LOCK_CAPTURE = "SELECT pg_advisory_xact_lock(%s)"
SELECT_CAPTURE_BY_IDENTITY = f"""
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
"""
INSERT_CAPTURE = """
INSERT INTO ai_replay_typed_source_capture (
  capture_id, trading_day, as_of_utc, profile, market_scope,
  profile_version, contract_version, input_fingerprint, strategy_version,
  pipeline_version, available_at_utc, source_versions, filings_json,
  text_hits_json, scores_json, capture_hash
) VALUES (
  %s::uuid, %s::date, %s::timestamptz, %s, %s,
  %s, %s, %s, %s, %s, %s::timestamptz, %s::jsonb, %s::jsonb,
  %s::jsonb, %s::jsonb, %s
)
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


class TypedCaptureWriterConfigurationError(ValueError):
    """DATABASE_URL or writer identity generation is invalid."""


class TypedCaptureWriterDependencyError(RuntimeError):
    """The required psycopg3 runtime is unavailable."""


class TypedCaptureWriteError(RuntimeError):
    """The capture could not be written without leaking database details."""


class TypedCaptureConflictError(TypedCaptureWriteError):
    """The natural identity already names different immutable content."""


def _default_connector(database_url: str):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise TypedCaptureWriterDependencyError(
            "psycopg3 is required for PostgresTypedCaptureWriter"
        ) from error
    try:
        return psycopg.connect(
            database_url,
            row_factory=dict_row,
            connect_timeout=5,
            application_name="stocks-ai-typed-capture-writer",
            passfile="",
        )
    except Exception as error:
        raise TypedCaptureWriteError("unable to connect using DATABASE_URL") from error


Connector = Callable[[str], Any]


class PostgresTypedCaptureWriter:
    """Insert or verify one immutable capture under its natural identity."""

    def __init__(
        self,
        database_url: str,
        *,
        connector: Optional[Connector] = None,
        uuid4_factory: Callable[[], uuid.UUID] = uuid.uuid4,
    ) -> None:
        try:
            self._database_url = validate_database_url(database_url)
        except ValueError as error:
            raise TypedCaptureWriterConfigurationError(
                "DATABASE_URL is invalid for typed capture writes"
            ) from error
        if not callable(uuid4_factory):
            raise TypedCaptureWriterConfigurationError("uuid4_factory must be callable")
        self._connector = connector or _default_connector
        self._uuid4_factory = uuid4_factory

    @classmethod
    def from_env(
        cls,
        environ: Optional[Mapping[str, str]] = None,
        *,
        connector: Optional[Connector] = None,
        uuid4_factory: Callable[[], uuid.UUID] = uuid.uuid4,
    ) -> "PostgresTypedCaptureWriter":
        source = os.environ if environ is None else environ
        if any(source.get(variable) for variable in _FORBIDDEN_LIBPQ_ENV):
            raise TypedCaptureWriterConfigurationError(
                "libpq environment fallbacks are forbidden with DATABASE_URL"
            )
        return cls(
            source.get("DATABASE_URL", ""),
            connector=connector,
            uuid4_factory=uuid4_factory,
        )

    def write(self, request: TypedCaptureRequest) -> TypedCaptureReceipt:
        # All source, hash, PIT, profile-scope, duplicate, and schema checks are
        # deliberately complete before identity generation or connection I/O.
        prepared = prepare_typed_capture(request)
        capture_id = self._new_capture_id()
        proposed_row = prepared.row(capture_id)
        connection = self._connect()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(
                        LOCK_CAPTURE,
                        (_advisory_key(prepared.pins),),
                    )
                    existing = _select_one(cursor, prepared.pins)
                    if existing is not None:
                        hydrated = _verify_existing(existing, prepared)
                        return _receipt(
                            hydrated.capture_id,
                            hydrated.prepared,
                            created=False,
                        )

                    cursor.execute(
                        INSERT_CAPTURE,
                        _insert_parameters(proposed_row),
                    )
                    readback = _select_one(cursor, prepared.pins)
                    if readback is None:
                        raise TypedCaptureWriteError(
                            "typed capture insert disappeared during readback"
                        )
                    hydrated = _verify_existing(readback, prepared)
                    if hydrated.capture_id != capture_id:
                        raise TypedCaptureWriteError(
                            "typed capture readback substituted capture_id"
                        )
                    receipt = _receipt(
                        hydrated.capture_id,
                        hydrated.prepared,
                        created=True,
                    )
        except (ReplaySourceError, TypedCaptureConflictError):
            raise
        except TypedCaptureWriteError:
            raise
        except Exception as error:
            raise TypedCaptureWriteError(
                "unable to persist typed source capture"
            ) from error
        finally:
            connection.close()
        return receipt

    def _new_capture_id(self) -> str:
        try:
            generated = self._uuid4_factory()
        except Exception as error:
            raise TypedCaptureWriterConfigurationError(
                "uuid4_factory failed"
            ) from error
        if not isinstance(generated, uuid.UUID) or generated.version != 4:
            raise TypedCaptureWriterConfigurationError(
                "uuid4_factory must return UUIDv4"
            )
        return str(generated)

    def _connect(self):
        try:
            return self._connector(self._database_url)
        except (
            TypedCaptureWriterConfigurationError,
            TypedCaptureWriterDependencyError,
            TypedCaptureWriteError,
        ):
            raise
        except Exception as error:
            raise TypedCaptureWriteError(
                "unable to connect using DATABASE_URL"
            ) from error


def _select_one(cursor: Any, pins: ReplayPins):
    cursor.execute(SELECT_CAPTURE_BY_IDENTITY, _identity_parameters(pins))
    return cursor.fetchone()


def _identity_parameters(pins: ReplayPins) -> tuple[str, ...]:
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
    )


def _insert_parameters(row: Mapping[str, Any]) -> tuple[Any, ...]:
    values = []
    for column in CAPTURE_COLUMNS:
        value = row[column]
        if column in {
            "source_versions",
            "filings_json",
            "text_hits_json",
            "scores_json",
        }:
            value = jcs_canonicalize(value)
        values.append(value)
    return tuple(values)


def _verify_existing(row: Mapping[str, Any], proposed: PreparedTypedCapture):
    try:
        hydrated = hydrate_typed_capture(row, proposed.pins)
    except ReplaySourceError as error:
        raise TypedCaptureConflictError("existing typed capture is invalid") from error
    if hydrated.prepared != proposed:
        raise TypedCaptureConflictError(
            "existing typed capture differs from proposed content"
        )
    return hydrated


def _advisory_key(pins: ReplayPins) -> int:
    material = {
        column: value
        for column, value in zip(
            NATURAL_IDENTITY_COLUMNS,
            _identity_parameters(pins),
        )
    }
    digest = hashlib.sha256(jcs_canonicalize(material).encode("utf-8")).digest()
    unsigned = int.from_bytes(digest[:8], "big")
    return unsigned if unsigned < 2**63 else unsigned - 2**64


def _receipt(
    capture_id: str,
    prepared: PreparedTypedCapture,
    *,
    created: bool,
) -> TypedCaptureReceipt:
    return TypedCaptureReceipt(
        capture_id=capture_id,
        pins=prepared.pins,
        available_at_utc=prepared.available_at_utc,
        capture_hash=prepared.capture_hash,
        created=created,
    )
