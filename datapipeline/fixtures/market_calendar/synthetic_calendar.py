"""Deterministic market-scoped calendars for the local Tab 5 replay proof.

This module is deliberately a fixture port, not an exchange calendar.  It has
no database or network dependency and refuses manifests that claim production
seeding is allowed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from types import MappingProxyType
from typing import Any, Mapping, Optional, Protocol, Sequence

SYNTHETIC_SOURCE = "synthetic-market-scoped-v1"
LOCAL_DISPOSABLE_PURPOSE = "local-disposable-e2e-only"
_MANIFEST_PATH = Path(__file__).with_name("tab5_six_month_calendar.json")
_SCOPES = ("cn_a", "us", "jp", "kr")
_UTC_TIME_RE = re.compile(r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$")


class CalendarFixtureError(ValueError):
    """The local-only calendar manifest or request is invalid."""


@dataclass(frozen=True)
class CalendarSession:
    market_scope: str
    trade_date: str
    session_close_utc: str
    source: str
    fixture_version: str


class MarketCalendarPort(Protocol):
    def sessions(
        self,
        market_scope: str,
        *,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> tuple[CalendarSession, ...]: ...

    def checkpoints(self, market_scope: str) -> tuple[CalendarSession, ...]: ...

    def fixture_hash(self, market_scope: str) -> str: ...


def _parse_iso_date(value: object, field: str) -> date:
    if not isinstance(value, str):
        raise CalendarFixtureError(f"{field} must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise CalendarFixtureError(f"{field} must be YYYY-MM-DD") from error
    if value != parsed.isoformat():
        raise CalendarFixtureError(f"{field} must be canonical YYYY-MM-DD")
    return parsed


def _canonical_json(value: object) -> str:
    """Canonical JSON for this string/bool/int/list/object manifest domain."""

    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        keys = list(value)
        if any(not isinstance(key, str) for key in keys):
            raise CalendarFixtureError("manifest JSON keys must be strings")
        return (
            "{"
            + ",".join(
                f"{_canonical_json(key)}:{_canonical_json(value[key])}"
                for key in sorted(keys, key=lambda item: item.encode("utf-16be"))
            )
            + "}"
        )
    raise CalendarFixtureError(
        f"unsupported manifest JSON type: {type(value).__name__}"
    )


def _freeze_json(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType(
            {key: _freeze_json(nested) for key, nested in value.items()}
        )
    if isinstance(value, list):
        return tuple(_freeze_json(nested) for nested in value)
    return value


def load_calendar_manifest(
    path: Path = _MANIFEST_PATH,
    *,
    purpose: str,
) -> Mapping[str, Any]:
    if purpose != LOCAL_DISPOSABLE_PURPOSE:
        raise CalendarFixtureError(
            "calendar fixture requires explicit local-disposable-e2e-only purpose"
        )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CalendarFixtureError("calendar manifest is unreadable") from error
    if not isinstance(raw, dict):
        raise CalendarFixtureError("calendar manifest must be an object")
    _validate_manifest(raw)
    return _freeze_json(raw)


def _validate_manifest(manifest: Mapping[str, Any]) -> None:
    if manifest.get("fixture_kind") != SYNTHETIC_SOURCE:
        raise CalendarFixtureError("fixture_kind must be synthetic-market-scoped-v1")
    if manifest.get("mode") != LOCAL_DISPOSABLE_PURPOSE:
        raise CalendarFixtureError("fixture mode must be local-disposable-e2e-only")
    if manifest.get("production_seed_allowed") is not False:
        raise CalendarFixtureError("synthetic calendar must forbid production seeding")
    disclaimer = manifest.get("disclaimer")
    if (
        not isinstance(disclaimer, str)
        or "Synthetic" not in disclaimer
        or "never seed production" not in disclaimer
    ):
        raise CalendarFixtureError("synthetic/non-production disclaimer is required")
    version = manifest.get("fixture_version")
    if not isinstance(version, str) or not version:
        raise CalendarFixtureError("fixture_version is required")

    window = manifest.get("window")
    if not isinstance(window, Mapping):
        raise CalendarFixtureError("window must be an object")
    start = _parse_iso_date(window.get("calendar_start"), "calendar_start")
    end = _parse_iso_date(window.get("calendar_end"), "calendar_end")
    if start > end or (end - start).days + 1 != window.get("inclusive_calendar_days"):
        raise CalendarFixtureError("calendar window/count mismatch")

    if tuple(manifest.get("market_scopes", ())) != _SCOPES:
        raise CalendarFixtureError("market scopes must be exact and ordered")
    if manifest.get("expected_open_sessions_per_scope") != 128:
        raise CalendarFixtureError("expected open sessions must equal 128")
    if manifest.get("expected_checkpoints_per_scope") != 27:
        raise CalendarFixtureError("expected checkpoints must equal 27")
    if (
        manifest.get("checkpoint_rule")
        != "first open session plus final open session of every ISO week, deduplicated"
    ):
        raise CalendarFixtureError("checkpoint rule is not canonical")
    closures = manifest.get("closures")
    close_rules = manifest.get("session_close_utc")
    if not isinstance(closures, Mapping) or not isinstance(close_rules, Mapping):
        raise CalendarFixtureError("closure and close-rule maps are required")
    if set(closures) != set(_SCOPES) or set(close_rules) != set(_SCOPES):
        raise CalendarFixtureError("closure/close-rule scopes must be exact")

    for scope in _SCOPES:
        scope_closures = closures[scope]
        if (
            not isinstance(scope_closures, (list, tuple))
            or len(scope_closures) != 2
            or len(set(scope_closures)) != len(scope_closures)
        ):
            raise CalendarFixtureError(f"{scope} must have two unique closures")
        for value in scope_closures:
            closed = _parse_iso_date(value, f"{scope} closure")
            if closed < start or closed > end or closed.weekday() >= 5:
                raise CalendarFixtureError(
                    f"{scope} closure must be a weekday inside the window"
                )
        _validate_close_rules(scope, close_rules[scope], start, end)


def _validate_close_rules(scope: str, rules: object, start: date, end: date) -> None:
    if not isinstance(rules, (list, tuple)) or not rules:
        raise CalendarFixtureError(f"{scope} close rules are required")
    previous_through: Optional[date] = None
    for index, rule in enumerate(rules):
        if not isinstance(rule, Mapping):
            raise CalendarFixtureError(f"{scope} close rule must be an object")
        rule_start = _parse_iso_date(rule.get("from"), f"{scope} close from")
        rule_end = _parse_iso_date(
            rule.get("through", end.isoformat()), f"{scope} close through"
        )
        close_time = rule.get("time")
        if not isinstance(close_time, str) or not _UTC_TIME_RE.fullmatch(close_time):
            raise CalendarFixtureError(f"{scope} close time must be UTC seconds")
        if rule_start > rule_end or rule_start < start or rule_end > end:
            raise CalendarFixtureError(f"{scope} close rule range is invalid")
        if index == 0 and rule_start != start:
            raise CalendarFixtureError(f"{scope} close rules must start at window")
        if previous_through is not None and rule_start != previous_through + timedelta(
            days=1
        ):
            raise CalendarFixtureError(f"{scope} close rules must be contiguous")
        previous_through = rule_end
    if previous_through != end:
        raise CalendarFixtureError(f"{scope} close rules must cover the full window")


def _close_time(scope: str, session_date: date, manifest: Mapping[str, Any]) -> str:
    for rule in manifest["session_close_utc"][scope]:
        rule_start = date.fromisoformat(rule["from"])
        rule_end = date.fromisoformat(
            rule.get("through", manifest["window"]["calendar_end"])
        )
        if rule_start <= session_date <= rule_end:
            return rule["time"]
    raise CalendarFixtureError(f"{scope} has no close rule for {session_date}")


def build_synthetic_calendars(
    manifest: Mapping[str, Any],
) -> Mapping[str, tuple[CalendarSession, ...]]:
    _validate_manifest(manifest)
    start = date.fromisoformat(manifest["window"]["calendar_start"])
    end = date.fromisoformat(manifest["window"]["calendar_end"])
    version = manifest["fixture_version"]
    expected = manifest["expected_open_sessions_per_scope"]
    calendars: dict[str, tuple[CalendarSession, ...]] = {}
    for scope in _SCOPES:
        closures = frozenset(manifest["closures"][scope])
        sessions = []
        cursor = start
        while cursor <= end:
            if cursor.weekday() < 5 and cursor.isoformat() not in closures:
                close_time = _close_time(scope, cursor, manifest)
                close = datetime.fromisoformat(
                    f"{cursor.isoformat()}T{close_time[:-1]}+00:00"
                )
                if close.tzinfo != timezone.utc:
                    raise CalendarFixtureError("session close must be UTC")
                sessions.append(
                    CalendarSession(
                        market_scope=scope,
                        trade_date=cursor.isoformat(),
                        session_close_utc=close.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        source=SYNTHETIC_SOURCE,
                        fixture_version=version,
                    )
                )
            cursor += timedelta(days=1)
        if len(sessions) != expected:
            raise CalendarFixtureError(
                f"{scope} session count mismatch: {len(sessions)} != {expected}"
            )
        calendars[scope] = tuple(sessions)
    return MappingProxyType(calendars)


def weekly_checkpoints(
    sessions: Sequence[CalendarSession],
) -> tuple[CalendarSession, ...]:
    if not sessions:
        return ()
    ordered = tuple(sorted(sessions, key=lambda item: item.trade_date))
    if len({item.market_scope for item in ordered}) != 1:
        raise CalendarFixtureError("checkpoint sessions must share one market scope")
    if len({item.trade_date for item in ordered}) != len(ordered):
        raise CalendarFixtureError("checkpoint sessions must have unique dates")
    weekly_last: dict[tuple[int, int], CalendarSession] = {}
    for session in ordered:
        parsed = date.fromisoformat(session.trade_date)
        iso = parsed.isocalendar()
        weekly_last[(iso.year, iso.week)] = session
    checkpoint_by_date = {ordered[0].trade_date: ordered[0]}
    checkpoint_by_date.update(
        {session.trade_date: session for session in weekly_last.values()}
    )
    return tuple(checkpoint_by_date[key] for key in sorted(checkpoint_by_date))


def canonical_calendar_hash(
    sessions: Sequence[CalendarSession],
    *,
    calendar_start: str,
    calendar_end: str,
) -> str:
    if not sessions:
        raise CalendarFixtureError("calendar hash requires sessions")
    start = _parse_iso_date(calendar_start, "calendar_start")
    end = _parse_iso_date(calendar_end, "calendar_end")
    scopes = {item.market_scope for item in sessions}
    versions = {item.fixture_version for item in sessions}
    sources = {item.source for item in sessions}
    dates = [item.trade_date for item in sessions]
    if len(scopes) != 1 or len(versions) != 1 or sources != {SYNTHETIC_SOURCE}:
        raise CalendarFixtureError(
            "calendar hash sessions must share scope/version/synthetic source"
        )
    if len(set(dates)) != len(dates):
        raise CalendarFixtureError("calendar hash sessions must have unique dates")
    records = tuple(
        {
            "session_close_utc": item.session_close_utc,
            "trade_date": item.trade_date,
        }
        for item in sessions
    )
    for item in sessions:
        session_date = _parse_iso_date(item.trade_date, "session trade_date")
        if session_date < start or session_date > end:
            raise CalendarFixtureError("calendar hash session is outside window")
        if not item.session_close_utc.startswith(item.trade_date + "T"):
            raise CalendarFixtureError("calendar close/date mirror mismatch")
        try:
            close = datetime.fromisoformat(
                item.session_close_utc.removesuffix("Z") + "+00:00"
            )
        except ValueError as error:
            raise CalendarFixtureError("calendar close must be UTC seconds") from error
        if (
            not item.session_close_utc.endswith("Z")
            or close.tzinfo != timezone.utc
            or close.microsecond != 0
            or item.session_close_utc != close.strftime("%Y-%m-%dT%H:%M:%SZ")
        ):
            raise CalendarFixtureError("calendar close must be canonical UTC seconds")
    preimage = {
        "fixture_kind": SYNTHETIC_SOURCE,
        "fixture_version": next(iter(versions)),
        "market_scope": next(iter(scopes)),
        "ordered_sessions": records,
        "window": {
            "calendar_end": end.isoformat(),
            "calendar_start": start.isoformat(),
        },
    }
    return hashlib.sha256(_canonical_json(preimage).encode("utf-8")).hexdigest()


class SyntheticCalendarPort:
    """Read-only fixture port for local/disposable replay tests."""

    def __init__(
        self,
        *,
        purpose: str,
        manifest_path: Path = _MANIFEST_PATH,
    ):
        self._manifest = load_calendar_manifest(manifest_path, purpose=purpose)
        self._calendars = build_synthetic_calendars(self._manifest)

    def sessions(
        self,
        market_scope: str,
        *,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> tuple[CalendarSession, ...]:
        if market_scope not in self._calendars:
            raise CalendarFixtureError("unsupported market_scope")
        start_date = _parse_iso_date(start, "start") if start is not None else None
        end_date = _parse_iso_date(end, "end") if end is not None else None
        if start_date and end_date and start_date > end_date:
            raise CalendarFixtureError("start must not exceed end")
        return tuple(
            session
            for session in self._calendars[market_scope]
            if (start_date is None or session.trade_date >= start_date.isoformat())
            and (end_date is None or session.trade_date <= end_date.isoformat())
        )

    def checkpoints(self, market_scope: str) -> tuple[CalendarSession, ...]:
        checkpoints = weekly_checkpoints(self.sessions(market_scope))
        expected = self._manifest["expected_checkpoints_per_scope"]
        if len(checkpoints) != expected:
            raise CalendarFixtureError(
                f"{market_scope} checkpoint count mismatch: "
                f"{len(checkpoints)} != {expected}"
            )
        return checkpoints

    def fixture_hash(self, market_scope: str) -> str:
        window = self._manifest["window"]
        return canonical_calendar_hash(
            self.sessions(market_scope),
            calendar_start=window["calendar_start"],
            calendar_end=window["calendar_end"],
        )
