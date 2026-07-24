#!/usr/bin/env python3
"""Evaluate research-ranking candidates without auto-promoting unmaterialized parameters.

The evaluator uses monthly point-in-time factor cross-sections, next-session entry,
rolling train/test windows, realistic turnover costs, and a doubled-cost stress run.
It may persist a standalone ResearchIntegrityAudit only when the winning candidate
matches the explicitly declared materialized candidate. A newly discovered parameter
set therefore cannot silently unlock paper trading before its PIT snapshots are rebuilt.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
from typing import Sequence
from urllib.parse import quote


RESEARCH_QUALIFICATION_CONTRACT_VERSION = "research-paper-v1"
DEFAULT_COST_RATE = 0.001
DOUBLE_COST_RATE = DEFAULT_COST_RATE * 2
TRAIN_PERIODS = 12
TEST_PERIODS = 3
MIN_TEST_WINDOWS = 4
MIN_OOS_TRADING_DAYS = 252
MIN_UNIVERSE_SIZE = 500
MIN_ANNUAL_RETURN_PCT = 10.0
MAX_DRAWDOWN_PCT = 20.0
MAX_OVERFIT_SCORE = 0.3


@dataclass(frozen=True)
class Candidate:
    key: str
    top_n: int
    weights: tuple[float, float, float, float, float, float]


@dataclass(frozen=True)
class SecurityReturn:
    ticker: str
    factors: tuple[float, float, float, float, float, float]
    forward_return: float


@dataclass(frozen=True)
class Period:
    signal_day: date
    entry_day: date
    exit_day: date
    trading_days: int
    benchmark_return: float
    rows: tuple[SecurityReturn, ...]


@dataclass(frozen=True)
class Simulation:
    period_returns: tuple[float, ...]
    total_return: float
    annual_return: float
    sharpe: float
    max_drawdown: float
    win_rate: float
    average_turnover: float
    trading_days: int


CANDIDATES: tuple[Candidate, ...] = (
    Candidate("materialized_six_factor_top3", 3, (0.20, 0.20, 0.15, 0.20, 0.15, 0.10)),
    Candidate("diversified_six_factor_top10", 10, (0.20, 0.20, 0.15, 0.20, 0.15, 0.10)),
    Candidate("diversified_six_factor_top20", 20, (0.20, 0.20, 0.15, 0.20, 0.15, 0.10)),
    Candidate("defensive_value_top20", 20, (0.20, 0.05, 0.30, 0.00, 0.05, 0.40)),
    Candidate("quality_value_low_vol_top20", 20, (0.25, 0.10, 0.25, 0.00, 0.10, 0.30)),
)


PERIOD_ROWS_SQL = """
WITH factor_matrix AS (
  SELECT fs.stock_code,
    AVG(fs.percentile) FILTER (
      WHERE factor_name IN ('quality', 'quality_high') AND raw_value IS NOT NULL
    ) AS quality,
    AVG(fs.percentile) FILTER (
      WHERE factor_name IN ('growth', 'earnings_surprise', 'analyst_consensus')
        AND raw_value IS NOT NULL
    ) AS growth,
    AVG(fs.percentile) FILTER (
      WHERE factor_name = 'value' AND raw_value IS NOT NULL
    ) AS valuation,
    AVG(fs.percentile) FILTER (
      WHERE factor_name IN ('momentum', 'money_flow', 'northbound')
        AND raw_value IS NOT NULL
    ) AS momentum,
    AVG(fs.percentile) FILTER (
      WHERE factor_name IN ('gradual_breakout', 'industry_momentum')
        AND raw_value IS NOT NULL
    ) AS trend,
    AVG(fs.percentile) FILTER (
      WHERE factor_name IN ('low_vol', 'liquidity') AND raw_value IS NOT NULL
    ) AS risk
  FROM factor_scores fs
  WHERE fs.trade_date = %(signal_day)s::date
    AND (
      fs.available_at_utc
        <= (%(signal_day)s::date::text || 'T15:00:00Z')::timestamptz
      OR (
        fs.source = 'historical_pit_replay@1.0.0'
        AND fs.pit_replay_as_of_utc IS NOT NULL
        AND fs.pit_replay_as_of_utc
          <= (%(signal_day)s::date::text || 'T15:00:00Z')::timestamptz
      )
    )
  GROUP BY fs.stock_code
)
SELECT RIGHT(stock.symbol, 6) AS ticker,
       matrix.quality, matrix.growth, matrix.valuation,
       matrix.momentum, matrix.trend, matrix.risk,
       exit_bar.close::numeric / entry_bar.close::numeric - 1 AS forward_return
  FROM factor_matrix matrix
  JOIN stocks stock
    ON RIGHT(stock.symbol, 6) = matrix.stock_code AND stock.type = 'stock'
  JOIN daily_bars signal_bar
    ON signal_bar.stock_id = stock.id
   AND signal_bar.time::date = %(signal_day)s::date
   AND signal_bar.is_trading_day = TRUE
   AND signal_bar.is_suspended = FALSE
   AND signal_bar.close > 0
  JOIN daily_bars entry_bar
    ON entry_bar.stock_id = stock.id
   AND entry_bar.time::date = %(entry_day)s::date
   AND entry_bar.is_trading_day = TRUE
   AND entry_bar.is_suspended = FALSE
   AND entry_bar.close > 0
  JOIN daily_bars exit_bar
    ON exit_bar.stock_id = stock.id
   AND exit_bar.time::date = %(exit_day)s::date
   AND exit_bar.is_trading_day = TRUE
   AND exit_bar.is_suspended = FALSE
   AND exit_bar.close > 0
 WHERE stock.listing_date <= %(signal_day)s::date
   AND (stock.delisting_date IS NULL OR stock.delisting_date > %(signal_day)s::date)
   AND stock.name NOT ILIKE '%%ST%%'
   AND matrix.quality IS NOT NULL
   AND matrix.growth IS NOT NULL
   AND matrix.valuation IS NOT NULL
   AND matrix.momentum IS NOT NULL
   AND matrix.trend IS NOT NULL
   AND matrix.risk IS NOT NULL
"""


def _load_env(path: Path) -> dict[str, str]:
    values = dict(os.environ)
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key, value = stripped.split("=", 1)
                values.setdefault(key, value.strip().strip('"').strip("'"))
    values.setdefault("DB_HOST", "localhost")
    values.setdefault("DB_PORT", "5432")
    values.setdefault("DB_NAME", "stock_backtest")
    values.setdefault("DB_USER", "postgres")
    values.setdefault("DB_PASSWORD", "postgres")
    return values


def _database_url(values: dict[str, str]) -> str:
    return (
        "postgresql://"
        + quote(values["DB_USER"], safe="")
        + ":"
        + quote(values["DB_PASSWORD"], safe="")
        + "@"
        + values["DB_HOST"]
        + ":"
        + values["DB_PORT"]
        + "/"
        + quote(values["DB_NAME"], safe="")
        + "?sslmode=disable"
    )


def candidate_score(row: SecurityReturn, candidate: Candidate) -> float:
    return sum(value * weight for value, weight in zip(row.factors, candidate.weights))


def select_candidate_rows(period: Period, candidate: Candidate) -> tuple[SecurityReturn, ...]:
    return tuple(
        sorted(
            period.rows,
            key=lambda row: (-candidate_score(row, candidate), row.ticker),
        )[: candidate.top_n]
    )


def simulate(
    periods: Sequence[Period], candidate: Candidate, cost_rate: float = DEFAULT_COST_RATE
) -> Simulation:
    nav = 1.0
    peak = 1.0
    returns: list[float] = []
    turnovers: list[float] = []
    previous_post_return_weights: dict[str, float] = {}
    trading_days = 0

    for period in periods:
        selected = select_candidate_rows(period, candidate)
        if len(selected) < candidate.top_n:
            raise ValueError(
                f"{period.signal_day}: candidate {candidate.key} has only {len(selected)} rows"
            )
        target = {row.ticker: 1.0 / candidate.top_n for row in selected}
        turnover = sum(
            abs(target.get(ticker, 0.0) - previous_post_return_weights.get(ticker, 0.0))
            for ticker in set(target) | set(previous_post_return_weights)
        )
        gross_return = statistics.fmean(row.forward_return for row in selected)
        net_factor = (1.0 - turnover * cost_rate) * (1.0 + gross_return)
        if not math.isfinite(net_factor) or net_factor <= 0:
            raise ValueError(f"{period.signal_day}: invalid net factor {net_factor}")
        period_return = net_factor - 1.0
        returns.append(period_return)
        turnovers.append(turnover)
        nav *= net_factor
        peak = max(peak, nav)
        trading_days += period.trading_days

        gross_factor = sum((1.0 / candidate.top_n) * (1.0 + row.forward_return) for row in selected)
        previous_post_return_weights = {
            row.ticker: (1.0 / candidate.top_n) * (1.0 + row.forward_return) / gross_factor
            for row in selected
        }

    total_return = nav - 1.0
    annual_return = nav ** (252.0 / max(1, trading_days)) - 1.0
    stddev = statistics.pstdev(returns) if len(returns) > 1 else 0.0
    sharpe = statistics.fmean(returns) / stddev * math.sqrt(12.0) if stddev > 0 else 0.0
    running = 1.0
    running_peak = 1.0
    max_drawdown = 0.0
    for value in returns:
        running *= 1.0 + value
        running_peak = max(running_peak, running)
        max_drawdown = max(max_drawdown, 1.0 - running / running_peak)
    return Simulation(
        period_returns=tuple(returns),
        total_return=total_return,
        annual_return=annual_return,
        sharpe=sharpe,
        max_drawdown=max_drawdown,
        win_rate=sum(value > 0 for value in returns) / max(1, len(returns)),
        average_turnover=statistics.fmean(turnovers) if turnovers else 0.0,
        trading_days=trading_days,
    )


def candidate_objective(result: Simulation) -> tuple[float, float, float]:
    return result.sharpe, result.annual_return, -result.max_drawdown


def walk_forward(
    periods: Sequence[Period], candidates: Sequence[Candidate] = CANDIDATES
) -> dict[str, object]:
    windows: list[dict[str, object]] = []
    oos_periods: list[tuple[Period, Candidate]] = []
    cursor = TRAIN_PERIODS
    while cursor + TEST_PERIODS <= len(periods):
        train = periods[cursor - TRAIN_PERIODS : cursor]
        test = periods[cursor : cursor + TEST_PERIODS]
        train_results = {candidate.key: simulate(train, candidate) for candidate in candidates}
        selected = max(candidates, key=lambda candidate: candidate_objective(train_results[candidate.key]))
        test_result = simulate(test, selected)
        windows.append(
            {
                "window_index": len(windows),
                "train_start": train[0].entry_day.isoformat(),
                "train_end": train[-1].exit_day.isoformat(),
                "test_start": test[0].entry_day.isoformat(),
                "test_end": test[-1].exit_day.isoformat(),
                "selected_candidate": selected.key,
                "train_sharpe": train_results[selected.key].sharpe,
                "train_annual_return_pct": train_results[selected.key].annual_return * 100.0,
                "test_sharpe": test_result.sharpe,
                "test_total_return_pct": test_result.total_return * 100.0,
            }
        )
        oos_periods.extend((period, selected) for period in test)
        cursor += TEST_PERIODS

    if not windows:
        return {
            "windows": [],
            "oos": None,
            "double_cost": None,
            "overfit_score": None,
            "_oos_periods": [],
        }

    def simulate_selected(cost_rate: float) -> Simulation:
        nav = 1.0
        total_days = 0
        combined_returns: list[float] = []
        turnovers: list[float] = []
        previous_post_return_weights: dict[str, float] = {}
        for period, candidate in oos_periods:
            selected = select_candidate_rows(period, candidate)
            target = {row.ticker: 1.0 / candidate.top_n for row in selected}
            turnover = sum(
                abs(target.get(ticker, 0.0) - previous_post_return_weights.get(ticker, 0.0))
                for ticker in set(target) | set(previous_post_return_weights)
            )
            gross_return = statistics.fmean(row.forward_return for row in selected)
            net_factor = (1.0 - turnover * cost_rate) * (1.0 + gross_return)
            if not math.isfinite(net_factor) or net_factor <= 0:
                raise ValueError(f"{period.signal_day}: invalid OOS net factor {net_factor}")
            combined_returns.append(net_factor - 1.0)
            turnovers.append(turnover)
            nav *= net_factor
            total_days += period.trading_days
            gross_factor = sum(
                (1.0 / candidate.top_n) * (1.0 + row.forward_return) for row in selected
            )
            previous_post_return_weights = {
                row.ticker: (1.0 / candidate.top_n) * (1.0 + row.forward_return) / gross_factor
                for row in selected
            }

        stddev = statistics.pstdev(combined_returns) if len(combined_returns) > 1 else 0.0
        running = peak = 1.0
        drawdown = 0.0
        for value in combined_returns:
            running *= 1.0 + value
            peak = max(peak, running)
            drawdown = max(drawdown, 1.0 - running / peak)
        return Simulation(
            period_returns=tuple(combined_returns),
            total_return=nav - 1.0,
            annual_return=nav ** (252.0 / max(1, total_days)) - 1.0,
            sharpe=(statistics.fmean(combined_returns) / stddev * math.sqrt(12.0))
            if stddev > 0
            else 0.0,
            max_drawdown=drawdown,
            win_rate=sum(value > 0 for value in combined_returns) / len(combined_returns),
            average_turnover=statistics.fmean(turnovers) if turnovers else 0.0,
            trading_days=total_days,
        )

    oos = simulate_selected(DEFAULT_COST_RATE)
    double_cost = simulate_selected(DOUBLE_COST_RATE)
    mean_train_sharpe = statistics.fmean(float(window["train_sharpe"]) for window in windows)
    overfit_score = max(0.0, mean_train_sharpe - oos.sharpe) / max(1.0, abs(mean_train_sharpe))
    return {
        "windows": windows,
        "oos": oos,
        "double_cost": double_cost,
        "overfit_score": overfit_score,
        "_oos_periods": [period for period, _candidate in oos_periods],
    }


def qualification_verdict(input: dict[str, object]) -> tuple[str, list[str]]:
    blockers: list[str] = []
    windows = list(input.get("windows") or [])
    oos = input.get("oos")
    double_cost = input.get("double_cost")
    overfit_score = input.get("overfit_score")
    benchmark_annual_return = float(input.get("benchmark_annual_return") or 0.0)
    materialized_candidate = str(input.get("materialized_candidate") or "")
    selected_candidates = {str(window["selected_candidate"]) for window in windows}

    if len(windows) < MIN_TEST_WINDOWS:
        blockers.append(f"walk_forward_windows={len(windows)}<{MIN_TEST_WINDOWS}")
    elif (
        sum(float(window["test_total_return_pct"]) > 0 for window in windows) / len(windows)
        < 0.60
    ):
        blockers.append("walk_forward_positive_window_ratio_below_60pct")
    if not isinstance(oos, Simulation) or oos.trading_days < MIN_OOS_TRADING_DAYS:
        blockers.append("oos_trading_days_insufficient")
    if isinstance(oos, Simulation):
        if oos.annual_return * 100.0 < MIN_ANNUAL_RETURN_PCT:
            blockers.append("after_cost_annual_return_below_10pct")
        if oos.annual_return <= benchmark_annual_return:
            blockers.append("benchmark_excess_not_positive")
        if oos.max_drawdown * 100.0 > MAX_DRAWDOWN_PCT:
            blockers.append("max_drawdown_above_20pct")
        if oos.sharpe <= 0:
            blockers.append("oos_sharpe_not_positive")
    if not isinstance(double_cost, Simulation) or double_cost.total_return <= 0:
        blockers.append("double_cost_total_return_not_positive")
    if overfit_score is None or float(overfit_score) > MAX_OVERFIT_SCORE:
        blockers.append("overfit_score_above_0_3")
    if selected_candidates != {materialized_candidate}:
        blockers.append("selected_candidate_not_materialized")

    if not windows or not isinstance(oos, Simulation):
        return "INSUFFICIENT", blockers
    return ("PASS" if not blockers else "FAIL"), blockers


def _monthly_period_definitions(connection, start: date, end: date) -> list[tuple[date, date, date, int]]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH sessions AS (
              SELECT time::date AS trading_day
                FROM daily_bars
               WHERE time::date BETWEEN %s AND %s
                 AND is_trading_day = TRUE
               GROUP BY time::date
              HAVING COUNT(*) >= 100
            ), factor_days AS (
              SELECT fs.trade_date,
                     COUNT(DISTINCT fs.factor_name) FILTER (
                       WHERE fs.factor_name IN (
                         'quality', 'growth', 'value', 'momentum', 'gradual_breakout', 'low_vol'
                       ) AND fs.raw_value IS NOT NULL
                     ) AS dimension_count
                FROM factor_scores fs
               WHERE fs.trade_date BETWEEN %s AND %s
               GROUP BY fs.trade_date
            ), monthly_signal AS (
              SELECT DATE_TRUNC('month', trade_date)::date AS month_start,
                     MAX(trade_date) AS signal_day
                FROM factor_days
               WHERE dimension_count = 6
               GROUP BY DATE_TRUNC('month', trade_date)::date
            ), entries AS (
              SELECT signal.month_start, signal.signal_day,
                     (SELECT MIN(session.trading_day) FROM sessions session
                       WHERE session.trading_day > signal.signal_day) AS entry_day
                FROM monthly_signal signal
            ), periods AS (
              SELECT signal_day, entry_day,
                     LEAD(entry_day) OVER (ORDER BY entry_day) AS exit_day
                FROM entries
               WHERE entry_day IS NOT NULL
            )
            SELECT signal_day, entry_day, exit_day,
                   (SELECT COUNT(*) FROM sessions session
                     WHERE session.trading_day > entry_day AND session.trading_day <= exit_day)::int
                     AS trading_days
              FROM periods
             WHERE exit_day IS NOT NULL
             ORDER BY entry_day
            """,
            (start, end, start, end),
        )
        return [
            (
                row["signal_day"],
                row["entry_day"],
                row["exit_day"],
                int(row["trading_days"]),
            )
            for row in cursor.fetchall()
        ]


def _read_periods(database_url: str, start: date, end: date) -> tuple[list[Period], str | None]:
    import psycopg
    from psycopg.rows import dict_row

    periods: list[Period] = []
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        definitions = _monthly_period_definitions(connection, start, end)
        with connection.cursor() as cursor:
            for signal_day, entry_day, exit_day, trading_days in definitions:
                cursor.execute(
                    PERIOD_ROWS_SQL,
                    {
                        "signal_day": signal_day,
                        "entry_day": entry_day,
                        "exit_day": exit_day,
                    },
                )
                rows = tuple(
                    SecurityReturn(
                        ticker=str(row["ticker"]),
                        factors=tuple(float(row[key]) for key in (
                            "quality", "growth", "valuation", "momentum", "trend", "risk"
                        )),
                        forward_return=float(row["forward_return"]),
                    )
                    for row in cursor.fetchall()
                )
                cursor.execute(
                    """
                    SELECT exit_bar.close::numeric / entry_bar.close::numeric - 1 AS return
                      FROM stocks stock
                      JOIN daily_bars entry_bar
                        ON entry_bar.stock_id = stock.id AND entry_bar.time::date = %s
                      JOIN daily_bars exit_bar
                        ON exit_bar.stock_id = stock.id AND exit_bar.time::date = %s
                     WHERE stock.symbol = 'sh.000300' AND stock.type = 'index'
                    """,
                    (entry_day, exit_day),
                )
                benchmark = cursor.fetchone()
                if len(rows) >= MIN_UNIVERSE_SIZE and benchmark and benchmark["return"] is not None:
                    periods.append(
                        Period(
                            signal_day,
                            entry_day,
                            exit_day,
                            trading_days,
                            float(benchmark["return"]),
                            rows,
                        )
                    )
            cursor.execute(
                """
                SELECT STRING_AGG(fact_hash, '' ORDER BY snapshot_day) AS material
                  FROM backtest_pit_snapshot
                 WHERE strategy = 'us_preferred'
                   AND market_scope = 'cn_a'
                   AND is_survivorship_biased = FALSE
                   AND source_versions->>'calendar' LIKE 'production-daily-bars-calendar@%'
                   AND source_versions->>'membership' = 'stock-master-listing-history@1.0.0'
                   AND source_versions->>'prices' = 'daily-bars-close-execution@2.0.0'
                   AND source_versions->>'ranking' = 'six-factor-prior-session@2.0.0'
                   AND source_versions->>'cost_model' = 'commission5-slippage5@1.0.0'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM jsonb_each_text(source_versions) source
                      WHERE LOWER(source.value) ~ '(fixture|synthetic|mock|seed)'
                   )
                """
            )
            evidence = cursor.fetchone()
    material = evidence["material"] if evidence else None
    evidence_hash = hashlib.sha256(material.encode()).hexdigest() if material else None
    return periods, evidence_hash


def _benchmark_annual_return(periods: Sequence[Period]) -> float:
    nav = math.prod(1.0 + period.benchmark_return for period in periods)
    days = sum(period.trading_days for period in periods)
    return nav ** (252.0 / max(1, days)) - 1.0


def _persist_audit(database_url: str, payload: dict[str, object]) -> int:
    import psycopg

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO research_integrity_audits (
                  backtest_id, source, strategy_key, observed_sharpe, oos_sharpe,
                  num_trials, sample_length, verdict, summary_message, metadata, created_at
                ) VALUES (
                  NULL, 'standalone', %(strategy_key)s, %(observed_sharpe)s,
                  %(oos_sharpe)s, %(num_trials)s, %(sample_length)s, %(verdict)s,
                  %(summary_message)s, %(metadata)s::jsonb, NOW()
                ) RETURNING id
                """,
                payload,
            )
            audit_id = int(cursor.fetchone()[0])
        connection.commit()
    return audit_id


def _simulation_json(value: Simulation | None) -> dict[str, object] | None:
    if value is None:
        return None
    return {
        "total_return_pct": value.total_return * 100.0,
        "annual_return_pct": value.annual_return * 100.0,
        "sharpe": value.sharpe,
        "max_drawdown_pct": value.max_drawdown * 100.0,
        "win_rate": value.win_rate,
        "average_turnover": value.average_turnover,
        "trading_days": value.trading_days,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--window-start", type=date.fromisoformat)
    parser.add_argument("--window-end", type=date.fromisoformat)
    parser.add_argument(
        "--materialized-candidate", default="materialized_six_factor_top3"
    )
    parser.add_argument("--write-audit", action="store_true")
    args = parser.parse_args()
    values = _load_env(args.env_file)
    database_url = _database_url(values)
    window_end = args.window_end or datetime.now(timezone.utc).date()
    window_start = args.window_start or window_end - timedelta(days=1100)
    periods, evidence_hash = _read_periods(database_url, window_start, window_end)
    result = walk_forward(periods)
    oos = result.get("oos") if isinstance(result.get("oos"), Simulation) else None
    double_cost = (
        result.get("double_cost")
        if isinstance(result.get("double_cost"), Simulation)
        else None
    )
    oos_periods = list(result.get("_oos_periods") or [])
    benchmark_annual_return = _benchmark_annual_return(oos_periods) if oos_periods else 0.0
    verdict, blockers = qualification_verdict(
        {
            **result,
            "benchmark_annual_return": benchmark_annual_return,
            "materialized_candidate": args.materialized_candidate,
        }
    )
    windows = list(result.get("windows") or [])
    positive_window_ratio = (
        sum(float(window["test_total_return_pct"]) > 0 for window in windows) / len(windows)
        if windows
        else 0.0
    )
    walk_forward_verdict = (
        "PASS"
        if len(windows) >= MIN_TEST_WINDOWS
        and positive_window_ratio >= 0.60
        and oos is not None
        and oos.sharpe > 0
        else "INSUFFICIENT"
    )
    qualification = {
        "qualification_contract_version": RESEARCH_QUALIFICATION_CONTRACT_VERSION,
        "point_in_time_ready": bool(evidence_hash and periods),
        "oos_trading_days": oos.trading_days if oos else 0,
        "after_cost_annual_return_pct": oos.annual_return * 100.0 if oos else None,
        "benchmark_excess_return_pct": (
            (oos.annual_return - benchmark_annual_return) * 100.0 if oos else None
        ),
        "max_drawdown_pct": oos.max_drawdown * 100.0 if oos else None,
        "walk_forward_verdict": walk_forward_verdict,
        "walk_forward_positive_window_ratio": positive_window_ratio,
        "overfit_score": result.get("overfit_score"),
        "double_cost_total_return_pct": double_cost.total_return * 100.0 if double_cost else None,
        "evidence_hash": evidence_hash,
        "materialized_candidate": args.materialized_candidate,
        "blockers": blockers,
    }
    output = {
        "scenario": "evaluate_research_strategy_candidates",
        "strategy_key": "us_preferred",
        "verdict": verdict,
        "period_count": len(periods),
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "candidate_count": len(CANDIDATES),
        "walk_forward_windows": result.get("windows"),
        "oos": _simulation_json(oos),
        "double_cost": _simulation_json(double_cost),
        "benchmark_annual_return_pct": benchmark_annual_return * 100.0,
        "qualification": qualification,
        "audit_id": None,
    }
    if args.write_audit:
        output["audit_id"] = _persist_audit(
            database_url,
            {
                "strategy_key": "us_preferred",
                "observed_sharpe": oos.sharpe if oos else None,
                "oos_sharpe": oos.sharpe if oos else None,
                "num_trials": len(CANDIDATES),
                "sample_length": oos.trading_days if oos else 0,
                "verdict": verdict,
                "summary_message": (
                    "研究策略资格通过。"
                    if verdict == "PASS"
                    else "研究策略资格未通过：" + ", ".join(blockers)
                ),
                "metadata": json.dumps(
                    {
                        "qualification": qualification,
                        "walk_forward_windows": result.get("windows"),
                        "oos": output["oos"],
                        "double_cost": output["double_cost"],
                    },
                    sort_keys=True,
                ),
            },
        )
    print(json.dumps(output, ensure_ascii=False, sort_keys=True, default=str))
    return 0 if verdict == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
