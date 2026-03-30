"""
Tool 2: get_building_complaints
Queries HPD Complaints dataset (ygpa-z7cr) using BBL.
Returns complaint trends, category breakdown, and recency analysis.
Depends on Tool 1 (needs BBL).
"""

import json
import httpx
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

COMPLAINTS_ENDPOINT = "https://data.cityofnewyork.us/resource/ygpa-z7cr.json"
DEMO_CACHE_PATH = Path(__file__).parent.parent / "data" / "demo_cache.json"
REQUEST_TIMEOUT = 3.0

_demo_cache: dict | None = None


def _load_demo_cache() -> dict:
    global _demo_cache
    if _demo_cache is None:
        if DEMO_CACHE_PATH.exists():
            _demo_cache = json.loads(DEMO_CACHE_PATH.read_text())
        else:
            _demo_cache = {}
    return _demo_cache


async def get_building_complaints(bbl: str) -> dict:
    """
    Fetch HPD complaints for a building by BBL.

    Args:
        bbl: 10-digit BBL string, e.g. "2024430001"

    Returns:
        {
            "total_12mo": 23,
            "categories": { "HEAT/HOT WATER": 14, "UNSANITARY CONDITION": 6, ... },
            "trend": { "last_3mo": 8, "prior_9mo": 15, "trending_up": true },
            "recent": [ { "type", "status", "received_date" } ],
            "error": null
        }
    """
    if not bbl:
        return {"error": "No BBL provided — Tool 1 must run first", "total_12mo": 0}

    # Demo cache
    cache = _load_demo_cache()
    cache_key = f"COMPLAINTS:{bbl}"
    if cache_key in cache:
        return cache[cache_key]

    twelve_months_ago = (datetime.now() - timedelta(days=365)).strftime(
        "%Y-%m-%dT00:00:00"
    )
    three_months_ago = (datetime.now() - timedelta(days=90)).strftime(
        "%Y-%m-%dT00:00:00"
    )

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            params = {
                "bbl": bbl,
                "$where": f"received_date > '{twelve_months_ago}'",
                "$limit": 500,
                "$select": "major_category,complaint_status,received_date,type",
                "$order": "received_date DESC",
            }
            resp = await client.get(COMPLAINTS_ENDPOINT, params=params)
            resp.raise_for_status()
            complaints = resp.json()

    except (httpx.TimeoutException, httpx.HTTPError) as e:
        return {"error": f"API unavailable: {e}", "total_12mo": 0}

    if not complaints:
        return {
            "total_12mo": 0,
            "categories": {},
            "trend": {"last_3mo": 0, "prior_9mo": 0, "trending_up": False},
            "recent": [],
            "error": None,
        }

    # Category breakdown
    cats = Counter(c.get("major_category", "OTHER") for c in complaints)

    # Trend: last 3mo vs prior 9mo
    last_3mo = sum(
        1 for c in complaints
        if c.get("received_date", "") >= three_months_ago
    )
    prior_9mo = len(complaints) - last_3mo
    # Annualize: 3mo rate vs 9mo rate
    trending_up = (last_3mo / 3) > (prior_9mo / 9) if prior_9mo > 0 else last_3mo > 0

    return {
        "total_12mo": len(complaints),
        "categories": dict(cats.most_common(5)),
        "trend": {
            "last_3mo": last_3mo,
            "prior_9mo": prior_9mo,
            "trending_up": trending_up,
        },
        "recent": [
            {
                "type": c.get("type", ""),
                "major_category": c.get("major_category", ""),
                "status": c.get("complaint_status", ""),
                "received_date": c.get("received_date", "")[:10],
            }
            for c in complaints[:5]
        ],
        "error": None,
    }
