"""Fail-closed CLI for point-in-time multibagger candidate materialization."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import pwd
import re
import sys
from typing import Any, Mapping, Optional, Sequence
from urllib.parse import parse_qsl, unquote, urlsplit

from ai.snapshot.fingerprint import jcs_canonicalize
from strategy.materialization import (
    ClassificationDecision,
    LatestCatalyst,
    MaterializationInput,
    PostgresCandidateStore,
    PostgresMaterializationRepository,
    StrategyDecision,
    candidate_to_row,
    materialize_candidate,
)


MAX_INPUT_BYTES = 1024 * 1024
REQUEST_KEYS = frozenset(
    {
        "market_scope",
        "exchange",
        "ticker",
        "as_of_utc",
        "decision",
        "classification",
        "latest_catalyst",
    }
)


class CliInputError(ValueError):
    pass


def _pairs(pairs: Sequence[tuple[str, Any]]) -> Mapping[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise CliInputError("duplicate JSON key")
        result[key] = value
    return result


def _parse_json(raw: bytes) -> Mapping[str, Any]:
    if not raw or len(raw) > MAX_INPUT_BYTES:
        raise CliInputError("input size is invalid")
    try:
        text = raw.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_pairs,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                CliInputError("non-finite JSON number")
            ),
        )
    except (UnicodeError, json.JSONDecodeError) as error:
        raise CliInputError("input is not strict JSON") from error
    if not isinstance(value, Mapping) or frozenset(value) != REQUEST_KEYS:
        raise CliInputError("request keys are not exact")
    return value


def _object(value: object, keys: frozenset[str], field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or frozenset(value) != keys:
        raise CliInputError(f"{field} keys are not exact")
    return value


def _string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise CliInputError(f"{field} must be a non-empty string")
    return value


def _utc(value: object, field: str) -> datetime:
    text = _string(value, field)
    if not text.endswith("Z"):
        raise CliInputError(f"{field} must use UTC Z")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise CliInputError(f"{field} must be ISO8601") from error
    if parsed.utcoffset() != timezone.utc.utcoffset(parsed) or parsed.microsecond:
        raise CliInputError(f"{field} must use whole UTC seconds")
    return parsed


class _Policy:
    def __init__(self, decision: ClassificationDecision) -> None:
        self._decision = decision

    def classify(self, _sources, _hits, _decision) -> ClassificationDecision:
        return self._decision


def _request(value: Mapping[str, Any], repository: PostgresMaterializationRepository):
    market_scope = _string(value["market_scope"], "market_scope")
    exchange = _string(value["exchange"], "exchange")
    ticker = _string(value["ticker"], "ticker")
    as_of = _utc(value["as_of_utc"], "as_of_utc")
    decision_raw = _object(
        value["decision"],
        frozenset(
            {
                "score",
                "conviction",
                "risk_gate",
                "entry_plan",
                "strategy_version",
            }
        ),
        "decision",
    )
    for field in ("score", "conviction", "risk_gate"):
        if not isinstance(decision_raw[field], Mapping):
            raise CliInputError(f"decision.{field} must be an object")
    entry_plan = decision_raw["entry_plan"]
    if entry_plan is not None and not isinstance(entry_plan, Mapping):
        raise CliInputError("decision.entry_plan must be object or null")
    decision = StrategyDecision(
        score=dict(decision_raw["score"]),
        conviction=dict(decision_raw["conviction"]),
        risk_gate=dict(decision_raw["risk_gate"]),
        entry_plan=None if entry_plan is None else dict(entry_plan),
        strategy_version=_string(
            decision_raw["strategy_version"], "decision.strategy_version"
        ),
    )
    classification_raw = _object(
        value["classification"],
        frozenset({"stage", "conclusion", "policy_version", "reason_codes"}),
        "classification",
    )
    reason_codes = classification_raw["reason_codes"]
    if not isinstance(reason_codes, list) or any(
        not isinstance(item, str) or not item for item in reason_codes
    ):
        raise CliInputError("classification.reason_codes must be a string array")
    classification = ClassificationDecision(
        stage=_string(classification_raw["stage"], "classification.stage"),
        conclusion=_string(
            classification_raw["conclusion"], "classification.conclusion"
        ),
        policy_version=_string(
            classification_raw["policy_version"], "classification.policy_version"
        ),
        reason_codes=tuple(reason_codes),
    )
    catalyst_raw = value["latest_catalyst"]
    catalyst = None
    if catalyst_raw is not None:
        catalyst_raw = _object(
            catalyst_raw,
            frozenset(
                {
                    "kind",
                    "title",
                    "occurred_at",
                    "available_at_utc",
                    "source_ref",
                    "fact_hash",
                }
            ),
            "latest_catalyst",
        )
        catalyst = LatestCatalyst(
            kind=_string(catalyst_raw["kind"], "latest_catalyst.kind"),
            title=_string(catalyst_raw["title"], "latest_catalyst.title"),
            occurred_at=_utc(
                catalyst_raw["occurred_at"], "latest_catalyst.occurred_at"
            ),
            available_at_utc=_utc(
                catalyst_raw["available_at_utc"],
                "latest_catalyst.available_at_utc",
            ),
            source_ref=_string(
                catalyst_raw["source_ref"], "latest_catalyst.source_ref"
            ),
            fact_hash=_string(
                catalyst_raw["fact_hash"], "latest_catalyst.fact_hash"
            ),
        )
    sources, hits = repository.load(
        market_scope=market_scope,
        exchange=exchange,
        ticker=ticker,
        as_of_utc=as_of,
    )
    return (
        MaterializationInput(
            market_scope=market_scope,
            exchange=exchange,
            ticker=ticker,
            as_of_utc=as_of,
            sources=sources,
            text_hits=hits,
            decision=decision,
            latest_catalyst=catalyst,
        ),
        _Policy(classification),
    )


def _require_disposable(database_url: str) -> None:
    parsed = urlsplit(database_url)
    database = unquote(parsed.path.removeprefix("/"))
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    host = unquote(query.get("host", ""))
    username = unquote(parsed.username or "")
    current_username = pwd.getpwuid(os.getuid()).pw_name
    expected_database = re.compile(
        rf"^stocks_tab4_{os.getuid()}_[0-9a-f]{{24}}$"
    )
    if (
        os.environ.get("TAB4_CANDIDATE_DISPOSABLE_WRITE") != "1"
        or expected_database.fullmatch(database) is None
        or username != current_username
        or parsed.password is not None
        or parsed.hostname is not None
        or query.get("port", "5432") != "5432"
        or not host.startswith("/")
        or not Path(host).is_dir()
        or not Path(host, ".s.PGSQL.5432").is_socket()
    ):
        raise CliInputError("writes require an explicit disposable local database")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--write-disposable", action="store_true")
    args = parser.parse_args(argv)
    try:
        database_url = _string(os.environ.get("TAB4_DATABASE_URL"), "TAB4_DATABASE_URL")
        payload = _parse_json(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1))
        repository = PostgresMaterializationRepository(database_url)
        request, policy = _request(payload, repository)
        candidate = materialize_candidate(request, policy)
        if args.write_disposable:
            _require_disposable(database_url)
            candidate = PostgresCandidateStore(database_url).write_or_verify(candidate)
        sys.stdout.write(jcs_canonicalize(candidate_to_row(candidate)) + "\n")
        return 0
    except Exception:
        sys.stderr.write("multibagger materialization failed\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
