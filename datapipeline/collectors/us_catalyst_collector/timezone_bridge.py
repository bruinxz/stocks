"""US ET to CN Asia/Shanghai trading day alignment.

US market close (ET 16:00 = UTC 20:00/21:00 DST) events
map to next CN trading day (Asia/Shanghai 09:30 open).
"""
from __future__ import annotations

from datetime import date, timedelta


def us_et_to_cn_trading_day(us_trading_day: date) -> date:
    """Map US trading day to next CN trading day (Asia/Shanghai).

    Sprint 1: simple next-business-day heuristic (skip weekends).
    Sprint 2: integrate with trading_calendar table for holiday awareness.
    """
    cn_day = us_trading_day + timedelta(days=1)
    while cn_day.weekday() >= 5:
        cn_day += timedelta(days=1)
    return cn_day
