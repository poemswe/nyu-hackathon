#!/usr/bin/env python3
"""
build_cache.py — Pre-cache API responses for demo addresses.
Run this BEFORE the hackathon to populate demo_cache.json with live data.
This ensures demo reliability even if the NYC Open Data API is slow.

Usage:
    cd sightline
    python scripts/build_cache.py
"""

import asyncio
import json
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.tools.violations import get_building_violations
from backend.tools.complaints import get_building_complaints
from backend.tools.owner import get_building_owner
from backend.normalizer import parse_address

CACHE_PATH = Path(__file__).parent.parent / "backend" / "data" / "demo_cache.json"

DEMO_ADDRESSES = [
    "1520 Sedgwick Avenue, Bronx",
    "515 Park Avenue, Manhattan",
    # Add a third address here if desired
    # "100 Gold Street, Brooklyn",
]


async def fetch_all_for_address(address: str) -> dict:
    """Fetch all tool data for one address and return cache entries."""
    print(f"\n  Fetching: {address}")
    entries = {}

    # Tool 1: Violations
    print("    → violations...", end=" ", flush=True)
    viol = await get_building_violations(address)
    if viol.get("error"):
        print(f"ERROR: {viol['error']}")
    else:
        print(f"OK ({viol['open_violations']['total']} open)")
        parsed = viol["address"]
        cache_key = f"VIOLATIONS:{parsed['housenumber']}:{parsed['streetname']}:{parsed['borough']}"
        entries[cache_key] = viol

        bbl = viol.get("bbl")

        # Tool 2: Complaints (needs BBL)
        if bbl:
            print("    → complaints...", end=" ", flush=True)
            compl = await get_building_complaints(bbl)
            if compl.get("error"):
                print(f"ERROR: {compl['error']}")
            else:
                print(f"OK ({compl['total_12mo']} complaints)")
                entries[f"complaints:{bbl}"] = compl

        # Tool 3: Owner (needs parsed address)
        print("    → owner...", end=" ", flush=True)
        owner = await get_building_owner(address)
        if owner.get("error") and not owner.get("corporate_owner"):
            print(f"ERROR: {owner['error']}")
        else:
            corp = owner.get("corporate_owner") or owner.get("individual_owner") or "Unknown"
            print(f"OK ({corp})")
            owner_key = f"OWNER:{parsed['housenumber']}:{parsed['streetname']}:{parsed['boroid']}"
            entries[owner_key] = owner

    return entries


async def main():
    print("Sightline — Demo Cache Builder")
    print("=" * 40)

    # Load existing cache to merge into
    existing = {}
    if CACHE_PATH.exists():
        existing = json.loads(CACHE_PATH.read_text())
        print(f"Loaded existing cache: {len(existing)} entries")

    all_entries = dict(existing)

    for address in DEMO_ADDRESSES:
        new_entries = await fetch_all_for_address(address)
        all_entries.update(new_entries)
        print(f"  Added {len(new_entries)} cache entries for {address}")

    CACHE_PATH.write_text(json.dumps(all_entries, indent=2))
    print(f"\n✓ Cache written: {CACHE_PATH}")
    print(f"  Total entries: {len(all_entries)}")


if __name__ == "__main__":
    asyncio.run(main())
