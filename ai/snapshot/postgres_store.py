"""Production PostgreSQL adapter for the recommendation snapshot ports.

The adapter binds only to the B1 ``ai_recommendation_snapshot`` and
``ai_recommendation_item`` tables.  Connection configuration is explicit:
``DATABASE_URL`` is the sole authority and libpq environment fallbacks are
rejected by ``from_env()``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
import os
from typing import Any, Optional
from urllib.parse import parse_qsl, unquote, urlsplit

from ai.snapshot.fingerprint import jcs_canonicalize
from ai.snapshot.store import (
    SnapshotItemRow,
    SnapshotRow,
    SnapshotTransaction,
)

SNAPSHOT_COLUMNS = (
    "snapshot_id",
    "as_of_utc",
    "trading_day",
    "profile",
    "market_scope",
    "contract_version",
    "profile_version",
    "pipeline_version",
    "model_version",
    "strategy_version",
    "rule_bundle_hash",
    "template_hash",
    "disclaimer_hash",
    "input_fingerprint",
    "output_fingerprint",
    "fingerprint_preimage_jcs",
    "idempotency_key",
    "item_count",
    "envelope_json",
)
ITEM_COLUMNS = (
    "item_id",
    "snapshot_id",
    "ticker",
    "sort_rank",
    "recommendation_json",
    "recommendation_jcs",
    "recommendation_hash",
    "rating_band",
    "conviction_final",
    "risk_gate_status",
    "size_hint_tier",
)
_SNAPSHOT_PROJECTION = ", ".join(SNAPSHOT_COLUMNS)
_ITEM_PROJECTION = ", ".join(ITEM_COLUMNS)

_SELECT_SNAPSHOT_BY_ID = f"""
SELECT {_SNAPSHOT_PROJECTION}
FROM ai_recommendation_snapshot
WHERE snapshot_id = %s::uuid
"""
_SELECT_SNAPSHOT_BY_IDEMPOTENCY = f"""
SELECT {_SNAPSHOT_PROJECTION}
FROM ai_recommendation_snapshot
WHERE idempotency_key = %s
"""
_SELECT_ITEMS = f"""
SELECT {_ITEM_PROJECTION}
FROM ai_recommendation_item
WHERE snapshot_id = %s::uuid
ORDER BY sort_rank ASC, item_id ASC
"""
_INSERT_SNAPSHOT = """
INSERT INTO ai_recommendation_snapshot (
  snapshot_id, as_of_utc, trading_day, profile, market_scope,
  contract_version, profile_version, pipeline_version, model_version,
  strategy_version, rule_bundle_hash, template_hash, disclaimer_hash,
  input_fingerprint, output_fingerprint, fingerprint_preimage_jcs,
  idempotency_key, item_count, envelope_json
) VALUES (
  %s::uuid, %s::timestamptz, %s::date, %s, %s,
  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
  %s::jsonb
)
"""
_INSERT_ITEM = """
INSERT INTO ai_recommendation_item (
  item_id, snapshot_id, ticker, sort_rank, recommendation_json,
  recommendation_jcs, recommendation_hash, rating_band, conviction_final,
  risk_gate_status, size_hint_tier
) VALUES (
  %s::uuid, %s::uuid, %s, %s, %s::jsonb,
  %s, %s, %s, %s::numeric, %s, %s
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
_ALLOWED_QUERY_PARAMETERS = frozenset({"host", "port", "sslmode"})
_SSL_MODES = frozenset(
    {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}
)


class SnapshotStoreConfigurationError(ValueError):
    """DATABASE_URL is missing, ambiguous, or unsafe."""


class SnapshotStoreDependencyError(RuntimeError):
    """The production psycopg3 dependency is unavailable."""


class SnapshotStoreConnectionError(RuntimeError):
    """The configured database cannot be opened without leaking its URL."""


def _contains_control(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _has_invalid_percent_escape(value: str) -> bool:
    index = 0
    while index < len(value):
        if value[index] != "%":
            index += 1
            continue
        if index + 2 >= len(value) or any(
            character not in "0123456789abcdefABCDEF"
            for character in value[index + 1 : index + 3]
        ):
            return True
        index += 3
    return False


def validate_database_url(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or _contains_control(value)
        or _has_invalid_percent_escape(value)
    ):
        raise SnapshotStoreConfigurationError(
            "DATABASE_URL must be a non-empty PostgreSQL URL"
        )
    try:
        parsed = urlsplit(value)
        authority_port = parsed.port
    except ValueError as error:
        raise SnapshotStoreConfigurationError("DATABASE_URL is invalid") from error
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise SnapshotStoreConfigurationError(
            "DATABASE_URL must use postgres or postgresql"
        )
    if parsed.fragment:
        raise SnapshotStoreConfigurationError("DATABASE_URL fragments are forbidden")
    username = unquote(parsed.username or "")
    database = unquote(parsed.path.removeprefix("/"))
    if (
        not username
        or _contains_control(username)
        or not database
        or "/" in database
        or _contains_control(database)
    ):
        raise SnapshotStoreConfigurationError(
            "DATABASE_URL must pin username and one database name"
        )

    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise SnapshotStoreConfigurationError(
            "DATABASE_URL query parameters must be unique"
        )
    unknown = sorted(set(keys) - _ALLOWED_QUERY_PARAMETERS)
    if unknown:
        raise SnapshotStoreConfigurationError(
            "DATABASE_URL contains unsupported query parameters"
        )
    query = dict(pairs)
    query_host = query.get("host")
    authority_host = parsed.hostname
    if authority_host and query_host:
        raise SnapshotStoreConfigurationError("DATABASE_URL must not define host twice")
    host = query_host or authority_host
    if not host or _contains_control(host):
        raise SnapshotStoreConfigurationError("DATABASE_URL must pin a host")
    if query_host and not query_host.startswith("/"):
        raise SnapshotStoreConfigurationError(
            "DATABASE_URL query host must be an absolute Unix-socket directory"
        )
    if authority_host and parsed.password is None:
        raise SnapshotStoreConfigurationError(
            "TCP DATABASE_URL must contain its password"
        )

    query_port = query.get("port")
    if authority_port is not None and query_port is not None:
        raise SnapshotStoreConfigurationError("DATABASE_URL must not define port twice")
    if query_port is not None:
        if not query_port.isascii() or not query_port.isdigit():
            raise SnapshotStoreConfigurationError(
                "DATABASE_URL port must contain ASCII digits"
            )
        port = int(query_port)
    elif authority_port is not None:
        port = authority_port
    else:
        port = 5432
    if port < 1 or port > 65535:
        raise SnapshotStoreConfigurationError("DATABASE_URL port is out of range")
    sslmode = query.get("sslmode")
    if sslmode is not None and sslmode not in _SSL_MODES:
        raise SnapshotStoreConfigurationError("DATABASE_URL sslmode is invalid")
    return value


def _default_connector(database_url: str):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise SnapshotStoreDependencyError(
            "psycopg3 is required for PostgresSnapshotStore"
        ) from error
    try:
        return psycopg.connect(
            database_url,
            row_factory=dict_row,
            connect_timeout=5,
            application_name="stocks-ai-snapshot-store",
            passfile="",
        )
    except Exception as error:
        raise SnapshotStoreConnectionError(
            "unable to connect using DATABASE_URL"
        ) from error


def _canonical_utc(value: object, field: str) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError(f"database returned invalid {field}")
    normalized = value.astimezone(timezone.utc)
    if normalized.microsecond != 0:
        raise RuntimeError(f"database returned sub-second {field}")
    return normalized.strftime("%Y-%m-%dT%H:%M:%SZ")


def _canonical_date(value: object, field: str) -> str:
    if not isinstance(value, date) or isinstance(value, datetime):
        raise RuntimeError(f"database returned invalid {field}")
    return value.isoformat()


def _require_json_object(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"database returned invalid {field}")
    return value


def _snapshot_from_row(row: Mapping[str, Any]) -> SnapshotRow:
    missing = set(SNAPSHOT_COLUMNS) - set(row)
    if missing:
        raise RuntimeError("database snapshot projection is incomplete")
    item_count = row["item_count"]
    if isinstance(item_count, bool) or not isinstance(item_count, int):
        raise RuntimeError("database returned invalid item_count")
    return SnapshotRow(
        snapshot_id=str(row["snapshot_id"]),
        as_of_utc=_canonical_utc(row["as_of_utc"], "as_of_utc"),
        trading_day=_canonical_date(row["trading_day"], "trading_day"),
        profile=str(row["profile"]),
        market_scope=str(row["market_scope"]),
        contract_version=str(row["contract_version"]),
        profile_version=str(row["profile_version"]),
        pipeline_version=str(row["pipeline_version"]),
        model_version=str(row["model_version"]),
        strategy_version=str(row["strategy_version"]),
        rule_bundle_hash=str(row["rule_bundle_hash"]),
        template_hash=str(row["template_hash"]),
        disclaimer_hash=str(row["disclaimer_hash"]),
        input_fingerprint=str(row["input_fingerprint"]),
        output_fingerprint=str(row["output_fingerprint"]),
        fingerprint_preimage_jcs=str(row["fingerprint_preimage_jcs"]),
        idempotency_key=str(row["idempotency_key"]),
        item_count=item_count,
        envelope_json=_require_json_object(row["envelope_json"], "envelope_json"),
    )


def _item_from_row(row: Mapping[str, Any]) -> SnapshotItemRow:
    missing = set(ITEM_COLUMNS) - set(row)
    if missing:
        raise RuntimeError("database item projection is incomplete")
    sort_rank = row["sort_rank"]
    conviction = row["conviction_final"]
    if isinstance(sort_rank, bool) or not isinstance(sort_rank, int):
        raise RuntimeError("database returned invalid sort_rank")
    if (
        isinstance(conviction, bool)
        or not isinstance(conviction, (int, float, Decimal))
        or not Decimal(str(conviction)).is_finite()
    ):
        raise RuntimeError("database returned invalid conviction_final")
    return SnapshotItemRow(
        item_id=str(row["item_id"]),
        snapshot_id=str(row["snapshot_id"]),
        ticker=str(row["ticker"]),
        sort_rank=sort_rank,
        recommendation_json=_require_json_object(
            row["recommendation_json"], "recommendation_json"
        ),
        recommendation_jcs=str(row["recommendation_jcs"]),
        recommendation_hash=str(row["recommendation_hash"]),
        rating_band=str(row["rating_band"]),
        conviction_final=float(conviction),
        risk_gate_status=str(row["risk_gate_status"]),
        size_hint_tier=str(row["size_hint_tier"]),
    )


def _advisory_key(idempotency_key: str) -> int:
    unsigned = int(idempotency_key[:16], 16)
    return unsigned if unsigned < 2**63 else unsigned - 2**64


class _PostgresSnapshotTransaction:
    def __init__(self, connection: Any):
        self._connection = connection

    def find_snapshot_by_idempotency_key(
        self, idempotency_key: str
    ) -> Optional[SnapshotRow]:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(%s)",
                (_advisory_key(idempotency_key),),
            )
            cursor.execute(_SELECT_SNAPSHOT_BY_IDEMPOTENCY, (idempotency_key,))
            row = cursor.fetchone()
        return _snapshot_from_row(row) if row is not None else None

    def get_items(self, snapshot_id: str) -> Sequence[SnapshotItemRow]:
        return _read_items(self._connection, snapshot_id)

    def insert_snapshot(self, snapshot: SnapshotRow) -> None:
        values = tuple(
            getattr(snapshot, field)
            for field in SNAPSHOT_COLUMNS
            if field != "envelope_json"
        ) + (jcs_canonicalize(snapshot.envelope_json),)
        with self._connection.cursor() as cursor:
            cursor.execute(_INSERT_SNAPSHOT, values)

    def insert_items(self, items: Sequence[SnapshotItemRow]) -> None:
        values = [
            (
                item.item_id,
                item.snapshot_id,
                item.ticker,
                item.sort_rank,
                jcs_canonicalize(item.recommendation_json),
                item.recommendation_jcs,
                item.recommendation_hash,
                item.rating_band,
                item.conviction_final,
                item.risk_gate_status,
                item.size_hint_tier,
            )
            for item in items
        ]
        if not values:
            return
        with self._connection.cursor() as cursor:
            cursor.executemany(_INSERT_ITEM, values)


def _read_items(connection: Any, snapshot_id: str) -> tuple[SnapshotItemRow, ...]:
    with connection.cursor() as cursor:
        cursor.execute(_SELECT_ITEMS, (snapshot_id,))
        rows = cursor.fetchall()
    return tuple(_item_from_row(row) for row in rows)


Connector = Callable[[str], Any]


class PostgresSnapshotStore:
    """Synchronous psycopg3 implementation of ``SnapshotStore``."""

    def __init__(
        self,
        database_url: str,
        *,
        connector: Optional[Connector] = None,
    ):
        self._database_url = validate_database_url(database_url)
        self._connector = connector or _default_connector

    @classmethod
    def from_env(
        cls,
        environ: Optional[Mapping[str, str]] = None,
        *,
        connector: Optional[Connector] = None,
    ) -> "PostgresSnapshotStore":
        source = os.environ if environ is None else environ
        shadowed = sorted(
            variable for variable in _FORBIDDEN_LIBPQ_ENV if source.get(variable)
        )
        if shadowed:
            raise SnapshotStoreConfigurationError(
                "libpq environment fallbacks are forbidden with DATABASE_URL"
            )
        return cls(source.get("DATABASE_URL", ""), connector=connector)

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

    @contextmanager
    def transaction(self) -> Iterator[SnapshotTransaction]:
        connection = self._connect()
        try:
            with connection.transaction():
                yield _PostgresSnapshotTransaction(connection)
        finally:
            connection.close()

    def get_snapshot(self, snapshot_id: str) -> Optional[SnapshotRow]:
        connection = self._connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(_SELECT_SNAPSHOT_BY_ID, (snapshot_id,))
                row = cursor.fetchone()
            return _snapshot_from_row(row) if row is not None else None
        finally:
            connection.close()

    def get_items(self, snapshot_id: str) -> Sequence[SnapshotItemRow]:
        connection = self._connect()
        try:
            return _read_items(connection, snapshot_id)
        finally:
            connection.close()

    def list_snapshots(
        self,
        *,
        profile: str,
        market_scope: str,
        trading_day: Optional[str] = None,
    ) -> Sequence[SnapshotRow]:
        query = f"""
SELECT {_SNAPSHOT_PROJECTION}
FROM ai_recommendation_snapshot
WHERE profile = %s AND market_scope = %s
"""
        parameters: tuple[object, ...] = (profile, market_scope)
        if trading_day is not None:
            query += " AND trading_day = %s::date"
            parameters += (trading_day,)
        query += " ORDER BY as_of_utc DESC, snapshot_id DESC"
        connection = self._connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(query, parameters)
                rows = cursor.fetchall()
            return tuple(_snapshot_from_row(row) for row in rows)
        finally:
            connection.close()
