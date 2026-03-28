"""
Tool 1: get_building_violations
Queries HPD Violations dataset (wvxf-dwi5) for a given address.
Returns open violation counts by class (A/B/C), descriptions, and
recently-certified-as-fixed violations (false cert candidates).
Also constructs the BBL for downstream tools.
"""

import json
import httpx
from datetime import datetime, timedelta
from pathlib import Path

from backend.normalizer import parse_address, build_bbl

VIOLATIONS_ENDPOINT = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json"
DEMO_CACHE_PATH = Path(__file__).parent.parent / "data" / "demo_cache.json"
REQUEST_TIMEOUT = 3.0  # seconds — hard cutoff for demo reliability

_demo_cache: dict | None = None


def _load_demo_cache() -> dict:
    global _demo_cache
    if _demo_cache is None:
        if DEMO_CACHE_PATH.exists():
            _demo_cache = json.loads(DEMO_CACHE_PATH.read_text())
        else:
            _demo_cache = {}
    return _demo_cache


def _cache_key(housenumber: str, streetname: str, borough: str) -> str:
    return f"violations:{housenumber}:{streetname}:{borough}".upper()


async def get_building_violations(address: str) -> dict:
    """
    Fetch open HPD violations for a building address.

    Args:
        address: Full address with borough, e.g. "1520 Sedgwick Avenue, Bronx"

    Returns:
        {
            "bbl": "2024430001",
            "address": { housenumber, streetname, borough, boroid },
            "open_violations": {
                "total": 47,
                "class_a": 11,
                "class_b": 22,
                "class_c": 14,
                "details": [ { class, novdescription, inspectiondate, unittype, ... } ]
            },
            "false_certs": [
                { "novdescription": "...", "certifieddate": "...", "unit": "..." }
            ],
            "error": null  # or error message string
        }
    """
    try:
        parsed = parse_address(address)
    except ValueError as e:
        return {"error": str(e), "bbl": None}

    housenumber = parsed["housenumber"]
    streetname = parsed["streetname"]
    borough = parsed["borough"]
    boroid = parsed["boroid"]

    # Check demo cache first
    cache = _load_demo_cache()
    cache_key = _cache_key(housenumber, streetname, borough)
    if cache_key in cache:
        return cache[cache_key]

    # --- Live API call ---
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            # Open violations
            open_params = {
                "housenumber": housenumber,
                "streetname": streetname,
                "boro": borough,
                "violationstatus": "Open",
                "$limit": 500,
                "$select": "boroid,block,lot,class,novdescription,inspectiondate,unittype,apt",
            }
            resp = await client.get(VIOLATIONS_ENDPOINT, params=open_params)
            resp.raise_for_status()
            violations = resp.json()

            # False cert query — certified in last 90 days
            ninety_days_ago = (datetime.now() - timedelta(days=90)).strftime(
                "%Y-%m-%dT00:00:00"
            )
            cert_params = {
                "housenumber": housenumber,
                "streetname": streetname,
                "boro": borough,
                "$where": f"currentstatus='CERTIFICATION CLOSEOUT' AND currentstatusdate > '{ninety_days_ago}'",
                "$limit": 20,
                "$select": "novdescription,currentstatusdate,apt,class",
            }
            cert_resp = await client.get(VIOLATIONS_ENDPOINT, params=cert_params)
            cert_resp.raise_for_status()
            certs = cert_resp.json()

    except (httpx.TimeoutException, httpx.HTTPError) as e:
        return {
            "error": f"API unavailable: {e}",
            "bbl": None,
            "address": parsed,
        }

    # Construct BBL from first result (all rows share block/lot)
    bbl = None
    if violations:
        first = violations[0]
        bbl = build_bbl(
            first.get("boroid", boroid),
            first.get("block", "00000"),
            first.get("lot", "0000"),
        )

    # Bucket by class
    class_a = [v for v in violations if v.get("class") == "A"]
    class_b = [v for v in violations if v.get("class") == "B"]
    class_c = [v for v in violations if v.get("class") == "C"]

    result = {
        "bbl": bbl,
        "address": parsed,
        "open_violations": {
            "total": len(violations),
            "class_a": len(class_a),
            "class_b": len(class_b),
            "class_c": len(class_c),
            "details": violations[:10],  # top 10 for briefing
        },
        "false_certs": [
            {
                "novdescription": c.get("novdescription", ""),
                "certifieddate": c.get("currentstatusdate", ""),
                "unit": c.get("apt", ""),
                "class": c.get("class", ""),
            }
            for c in certs[:5]
        ],
        "error": None,
    }

    return result
