"""
Tool 4: get_owner_portfolio
Instant lookup from pre-computed static JSON.
No API call — runs after Tool 3 returns owner name.
Contains portfolio stats for top 100 Worst Landlord Watchlist entries.
"""

import json
from pathlib import Path

PORTFOLIO_PATH = Path(__file__).parent.parent / "data" / "portfolio.json"

_portfolio: dict | None = None


def _load_portfolio() -> dict:
    global _portfolio
    if _portfolio is None:
        if PORTFOLIO_PATH.exists():
            _portfolio = json.loads(PORTFOLIO_PATH.read_text())
        else:
            _portfolio = {}
    return _portfolio


def _normalize(name: str) -> str:
    if not name:
        return ""
    return name.upper().strip().rstrip(".,").replace("  ", " ")


def get_owner_portfolio(owner_name: str, corporate_name: str = "") -> dict:
    """
    Look up pre-computed portfolio stats for a landlord.
    This is a synchronous function — it's an instant dict lookup.

    Args:
        owner_name: Individual owner name from Tool 3
        corporate_name: Corporate entity name from Tool 3

    Returns:
        {
            "found": true,
            "matched_name": "Koscal 59 LLC",
            "total_buildings": 29,
            "total_open_violations": 2300,
            "worst_buildings": [
                { "address": "1520 Sedgwick Ave, Bronx", "open_violations": 47 },
                ...
            ]
        }
        or { "found": false }
    """
    portfolio = _load_portfolio()

    candidates = [
        _normalize(owner_name),
        _normalize(corporate_name),
    ]

    for candidate in candidates:
        if not candidate:
            continue

        # Exact match
        if candidate in portfolio:
            entry = portfolio[candidate]
            return {
                "found": True,
                "matched_name": candidate,
                **entry,
            }

        # Substring match (handles partial names)
        for key, entry in portfolio.items():
            if candidate in key or key in candidate:
                return {
                    "found": True,
                    "matched_name": key,
                    **entry,
                }

    return {"found": False}
