"""catalyst_kind 9-enum classifier.

Sprint 1: rule-based (8-K item mapping + keyword heuristic).
"""
from __future__ import annotations

_ITEM_MAP = {
    '1.01': 'ma_activity',
    '1.02': 'ma_activity',
    '2.01': 'ma_activity',
    '2.02': 'earnings',
    '2.05': 'regulator',
    '2.06': 'product',
    '4.01': 'regulator',
    '4.02': 'regulator',
    '5.01': 'leadership',
    '5.02': 'leadership',
    '7.01': 'regulator',
    '8.01': 'unclassified',
}

_KEYWORD_MAP = {
    'earnings': ['earnings', 'quarterly results', 'revenue', 'EPS', 'profit', 'loss'],
    'upgrade_downgrade': ['upgrade', 'downgrade', 'rating', 'price target', 'analyst'],
    'ma_activity': ['merger', 'acquisition', 'takeover', 'buyout', 'tender offer'],
    'sector_move': ['sector', 'industry', 'ETF', 'index rebalance'],
    'regulator': ['FDA', 'DOJ', 'SEC', 'FTC', 'approval', 'investigation', 'subpoena'],
    'geo_macro': ['tariff', 'trade war', 'interest rate', 'fed', 'election', 'sanction'],
    'product': ['launch', 'recall', 'patent', 'drug', 'pipeline', 'approval'],
    'leadership': ['CEO', 'CFO', 'director', 'executive', 'activist', 'board'],
}


def classify_8k_item(item_number: str) -> str:
    return _ITEM_MAP.get(item_number.strip(), 'unclassified')


def classify_headline(headline: str) -> str:
    headline_lower = headline.lower()
    best_kind = 'unclassified'
    best_score = 0
    for kind, keywords in _KEYWORD_MAP.items():
        score = sum(1 for kw in keywords if kw.lower() in headline_lower)
        if score > best_score:
            best_score = score
            best_kind = kind
    return best_kind
