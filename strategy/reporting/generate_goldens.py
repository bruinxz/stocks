"""Regenerate the exact checked-in Tab 6/7 wire DTO goldens."""

import json
from pathlib import Path

from strategy.reporting.tab67_projection import (
    project_daily_report,
    project_report_history,
)


FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _write_json(path: Path, value) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    source = json.loads(
        (FIXTURES / "recommendation_list_us_v031.json").read_text(
            encoding="utf-8"
        )
    )
    _write_json(
        FIXTURES / "daily_report_us_v031.golden.json",
        project_daily_report(source),
    )
    _write_json(
        FIXTURES / "report_history_us_v031.golden.json",
        project_report_history([source]),
    )


if __name__ == "__main__":
    main()
