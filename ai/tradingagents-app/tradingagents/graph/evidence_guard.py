import re
from typing import Dict, Tuple


_COMPANY_MISMATCH_PATTERNS = (
    re.compile(r"(?:代码|股票|标的).{0,16}(?:匹配异常|关联异常|误关联|不匹配)"),
    re.compile(r"新闻标注.{0,12}(?:异常|错误)"),
    re.compile(r"实际为.{0,40}(?:公告|公司).{0,40}(?:关联至|归入|匹配到)"),
)


def guard_company_news(report: str, ticker: str) -> Tuple[str, Dict[str, str]]:
    """Reject an analyst report that admits its company/ticker attribution is wrong."""
    text = str(report or "").strip()
    if not text:
        return (
            f"No verified company-specific news was available for {ticker}.",
            {"status": "unavailable", "reason": "empty_news_report"},
        )

    for pattern in _COMPANY_MISMATCH_PATTERNS:
        if pattern.search(text):
            return (
                f"No verified company-specific news was available for {ticker}. "
                "A candidate report was rejected because it explicitly disclosed a "
                "ticker/company attribution mismatch. Do not use or repeat its events.",
                {
                    "status": "rejected",
                    "reason": "explicit_company_attribution_mismatch",
                },
            )

    return text, {"status": "accepted", "reason": "no_explicit_mismatch"}
