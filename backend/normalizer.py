"""
Street name normalizer for NYC HPD SODA API queries.
The SODA API uses specific street name formats that don't always match
what a user speaks or types. This module bridges that gap.
"""

import re

# Directional expansions
DIRECTIONALS = {
    r"\bN\.?\b": "NORTH",
    r"\bS\.?\b": "SOUTH",
    r"\bE\.?\b": "EAST",
    r"\bW\.?\b": "WEST",
}

# Street suffix normalizations (spoken → SODA format)
SUFFIX_MAP = {
    "AVENUE": "AVE",
    "BOULEVARD": "BLVD",
    "COURT": "CT",
    "DRIVE": "DR",
    "EXPRESSWAY": "EXPY",
    "HIGHWAY": "HWY",
    "LANE": "LN",
    "PARKWAY": "PKWY",
    "PLACE": "PL",
    "ROAD": "RD",
    "SQUARE": "SQ",
    "STREET": "ST",
    "TERRACE": "TER",
    "TRAIL": "TRL",
    "WAY": "WAY",
}

# Borough name → SODA boroid
BOROUGH_MAP = {
    "MANHATTAN": "1",
    "NEW YORK": "1",
    "NY": "1",
    "BRONX": "2",
    "THE BRONX": "2",
    "BROOKLYN": "3",
    "KINGS": "3",
    "QUEENS": "4",
    "STATEN ISLAND": "5",
    "RICHMOND": "5",
}

# Hardcoded normalizations for known demo addresses and edge cases
KNOWN_ADDRESSES = {
    "1520 SEDGWICK AVE": ("1520", "SEDGWICK AVE"),
    "1520 SEDGWICK AVENUE": ("1520", "SEDGWICK AVE"),
    "515 PARK AVE": ("515", "PARK AVE"),
    "515 PARK AVENUE": ("515", "PARK AVE"),
}


def normalize_borough(raw: str) -> tuple[str, str]:
    """
    Returns (borough_name, boroid) from a raw borough string.
    Raises ValueError if unrecognized.
    """
    upper = raw.upper().strip()
    for key, boroid in BOROUGH_MAP.items():
        if key in upper:
            # Return the canonical HPD borough name
            canonical = {
                "1": "MANHATTAN",
                "2": "BRONX",
                "3": "BROOKLYN",
                "4": "QUEENS",
                "5": "STATEN ISLAND",
            }[boroid]
            return canonical, boroid
    raise ValueError(f"Unrecognized borough: {raw!r}")


def normalize_street(raw: str) -> str:
    """
    Normalize a street name to match HPD SODA API format.
    E.g. "Sedgwick Avenue" → "SEDGWICK AVE"
         "West 125th Street" → "WEST 125TH ST"
    """
    s = raw.upper().strip()

    # Remove leading house number if accidentally included
    s = re.sub(r"^\d+\s+", "", s)

    # Expand directionals
    for pattern, replacement in DIRECTIONALS.items():
        s = re.sub(pattern, replacement, s)

    # Normalize suffixes — match whole word at end of string
    tokens = s.split()
    if tokens:
        last = tokens[-1].rstrip(".")
        if last in SUFFIX_MAP:
            tokens[-1] = SUFFIX_MAP[last]
        elif last in SUFFIX_MAP.values():
            pass  # already normalized
    s = " ".join(tokens)

    return s.strip()


def parse_address(full_address: str) -> dict:
    """
    Parse a full address string into components for SODA API queries.

    Input:  "1520 Sedgwick Avenue, Bronx"
    Output: {
        "housenumber": "1520",
        "streetname": "SEDGWICK AVE",
        "borough": "BRONX",
        "boroid": "2",
    }
    """
    # Split on comma to separate address from borough
    parts = [p.strip() for p in full_address.split(",")]

    if len(parts) < 2:
        raise ValueError(
            f"Address must include borough, e.g. '1520 Sedgwick Ave, Bronx'. Got: {full_address!r}"
        )

    address_part = parts[0].upper().strip()
    borough_part = ",".join(parts[1:]).strip()

    # Check known addresses first
    if address_part in KNOWN_ADDRESSES:
        housenumber, streetname = KNOWN_ADDRESSES[address_part]
    else:
        # Extract house number (leading digits)
        match = re.match(r"^(\d+[\w-]*)\s+(.+)$", address_part)
        if not match:
            raise ValueError(f"Could not parse house number from: {address_part!r}")
        housenumber = match.group(1)
        streetname = normalize_street(match.group(2))

    borough, boroid = normalize_borough(borough_part)

    return {
        "housenumber": housenumber,
        "streetname": streetname,
        "borough": borough,
        "boroid": boroid,
    }


def build_bbl(boroid: str, block: str, lot: str) -> str:
    """
    Construct a 10-digit BBL string from borough, block, lot.
    Format: 1-digit borough + 5-digit block + 4-digit lot
    """
    return f"{boroid}{block.zfill(5)}{lot.zfill(4)}"


if __name__ == "__main__":
    # Quick smoke test
    tests = [
        "1520 Sedgwick Avenue, Bronx",
        "515 Park Avenue, Manhattan",
        "1520 Sedgwick Ave, The Bronx",
        "100 Gold Street, Brooklyn",
        "42-10 Main Street, Queens",
    ]
    for addr in tests:
        try:
            result = parse_address(addr)
            print(f"✓ {addr}")
            print(f"  → {result}")
        except ValueError as e:
            print(f"✗ {addr}: {e}")
