"""
Tool 3: get_building_owner
Queries HPD Registration (tesw-yqqr) and Registration Contacts (feu5-w2e2).
Returns owner name, corporate entity, managing agent, and watchlist status.
Runs in parallel with Tool 2 (both start after Tool 1 returns BBL + address).
"""

import json
import httpx
from pathlib import Path

from backend.normalizer import parse_address

REGISTRATION_ENDPOINT = "https://data.cityofnewyork.us/resource/tesw-yqqr.json"
CONTACTS_ENDPOINT = "https://data.cityofnewyork.us/resource/feu5-w2e2.json"
DEMO_CACHE_PATH = Path(__file__).parent.parent / "data" / "demo_cache.json"
WATCHLIST_PATH = Path(__file__).parent.parent / "data" / "watchlist.json"
REQUEST_TIMEOUT = 3.0

_demo_cache: dict | None = None
_watchlist: list | None = None

OWNER_ALIASES = {
    "A&E REAL ESTATE": "A & E REAL ESTATE HOLDINGS LLC",
    "A & E REAL ESTATE": "A & E REAL ESTATE HOLDINGS LLC",
    "A&E REAL ESTATE HOLDINGS": "A & E REAL ESTATE HOLDINGS LLC",
    "PINNACLE GROUP": "PINNACLE GROUP NYC LLC",
    "PINNACLE CITY LIVING": "PINNACLE GROUP NYC LLC",
    "BEDFORD MYRTLE HDFC": "BEDFORD MYRTLE HDFC",
    "MOSHE PILLER": "MOSHE PILLER",
    "M PILLER": "MOSHE PILLER",
    "JOEL WEINER": "JOEL WEINER",
    "J WEINER": "JOEL WEINER",
    "STEVEN KESSNER": "STEVEN KESSNER",
    "S KESSNER": "STEVEN KESSNER",
    "MEIR MIZRAHI": "MEIR MIZRAHI",
    "KOSCAL": "KOSCAL 59 LLC",
    "KOSCAL 59": "KOSCAL 59 LLC",
}


def _load_demo_cache() -> dict:
    global _demo_cache
    if _demo_cache is None:
        if DEMO_CACHE_PATH.exists():
            _demo_cache = json.loads(DEMO_CACHE_PATH.read_text())
        else:
            _demo_cache = {}
    return _demo_cache


def _load_watchlist() -> list:
    global _watchlist
    if _watchlist is None:
        if WATCHLIST_PATH.exists():
            _watchlist = json.loads(WATCHLIST_PATH.read_text())
        else:
            _watchlist = []
    return _watchlist


def _normalize_owner_name(name: str) -> str:
    name = name.upper().strip()
    for suffix in [" LLC", " LP", " INC", " CORP", " CO", ".", ","]:
        if name.endswith(suffix):
            name = name[:-len(suffix)].strip()
    return name


def _check_watchlist(owner_name: str, corp_name: str) -> dict | None:
    watchlist = _load_watchlist()
    candidates = [n for n in [owner_name, corp_name] if n]

    for candidate in candidates:
        normalized = _normalize_owner_name(candidate)

        for entry in watchlist:
            wl_name = _normalize_owner_name(entry.get("name", ""))
            if normalized == wl_name or normalized in wl_name or wl_name in normalized:
                return entry

        canonical = OWNER_ALIASES.get(normalized)
        if canonical:
            for entry in watchlist:
                if _normalize_owner_name(entry.get("name", "")) == _normalize_owner_name(canonical):
                    return entry

    return None


async def get_building_owner(address: str) -> dict:
    """
    Fetch owner information for a building.

    Args:
        address: Full address with borough, e.g. "1520 Sedgwick Avenue, Bronx"
    """
    parsed = parse_address(address)
    housenumber = parsed["housenumber"]
    streetname = parsed["streetname"]
    boroid = parsed["boroid"]

    cache = _load_demo_cache()
    cache_key = f"owner:{housenumber}:{streetname}:{boroid}".upper()
    if cache_key in cache:
        return cache[cache_key]

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            reg_params = {
                "housenumber": housenumber,
                "streetname": streetname,
                "boroid": boroid,
                "$limit": 5,
                "$select": "registrationid,buildingid",
                "$order": "registrationid DESC",
            }
            reg_resp = await client.get(REGISTRATION_ENDPOINT, params=reg_params)
            reg_resp.raise_for_status()
            registrations = reg_resp.json()

            if not registrations:
                return {
                    "individual_owner": None,
                    "corporate_owner": None,
                    "managing_agent": None,
                    "registration_id": None,
                    "watchlist": None,
                    "error": "No registration found for this address",
                }

            registration_id = registrations[0]["registrationid"]

            contacts_params = {
                "registrationid": registration_id,
                "$where": "type in('CorporateOwner','IndividualOwner','Agent')",
                "$limit": 20,
            }
            contacts_resp = await client.get(CONTACTS_ENDPOINT, params=contacts_params)
            contacts_resp.raise_for_status()
            contacts = contacts_resp.json()

    except (httpx.TimeoutException, httpx.HTTPError) as e:
        return {"error": f"API unavailable: {e}"}

    individual_owner = None
    corporate_owner = None
    managing_agent = None

    for contact in contacts:
        ctype = contact.get("type", "")
        if ctype == "IndividualOwner":
            fname = contact.get("firstname", "")
            lname = contact.get("lastname", "")
            individual_owner = f"{fname} {lname}".strip()
        elif ctype == "CorporateOwner":
            corporate_owner = contact.get("corporationname", "")
        elif ctype == "Agent":
            fname = contact.get("firstname", "")
            lname = contact.get("lastname", "")
            corp = contact.get("corporationname", "")
            managing_agent = corp or f"{fname} {lname}".strip()

    watchlist_entry = _check_watchlist(
        individual_owner or "", corporate_owner or ""
    )

    return {
        "individual_owner": individual_owner,
        "corporate_owner": corporate_owner,
        "managing_agent": managing_agent,
        "registration_id": registration_id,
        "watchlist": watchlist_entry,
        "error": None,
    }
