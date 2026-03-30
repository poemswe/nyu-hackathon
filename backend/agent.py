"""
SlumlordWatch Field Intelligence Agent
Powered by Gemini Live via Google ADK

HOURS 1-2: Run with `adk web` — voice in/out working, no tools yet.
HOURS 3-4: Add 4 tools, confirm full briefing with real data.

Usage:
    cd slumlordwatch/backend
    adk web
"""

import json
from google.adk.agents import Agent
from google.adk.tools import FunctionTool

# --- Import tools ---
from backend.tools.violations import get_building_violations
from backend.tools.complaints import get_building_complaints
from backend.tools.owner import get_building_owner
from backend.tools.portfolio import get_owner_portfolio
from backend.normalizer import parse_address

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a field intelligence agent for NYC housing inspectors.

YOUR JOB IN TWO MOMENTS:

MOMENT 1 — THE BRIEFING
When an inspector gives you a building address, immediately call your tools to assemble an intelligence briefing. Speak it clearly in under 45 seconds (about 150 words). Structure it exactly:
1. Open violations — total count, Class C (immediately hazardous) first, then B, then A — name specific violation types and affected units
2. Complaint history — total in last 12 months, top category, whether trending up or down
3. Owner identity — individual name and/or corporate entity
4. Portfolio — if the owner has data, state total buildings and total violations across their portfolio
5. Watchlist status — if they appear on the Worst Landlord Watchlist, state their rank
6. False certifications — if any violations were recently "certified as fixed," flag them explicitly for re-verification

Be direct. Cite numbers. Use escalating severity (building-level → portfolio-level → flags).
End with: "Ready when you are for the visual inspection."

If a building has ZERO violations and complaints (like a luxury building), pause and note the contrast: "Zero open violations. Zero complaints in the past year. Compare that to what you're about to see elsewhere."

MOMENT 2 — THE EYES
When the inspector activates the camera, analyze what you see frame by frame. Identify conditions and propose violation classifications — but ALWAYS frame them as suggestions:
- "This looks like it could be a Class C active leak — does that match what you're seeing?"
- "I'm seeing what appears to be mold or mildew — that would typically be Class B. Do you agree?"
- "The paint condition here may be peeling — if this building was built before 1978, that's a Class C. Do you know the build year?"

After the inspector confirms each violation, draft the violation narrative through conversation. When they ask, read back the complete draft.

TOOL ORCHESTRATION:
- Call get_building_violations FIRST (it returns the BBL you need)
- Then call get_building_complaints AND get_building_owner IN PARALLEL (both can start as soon as Tool 1 returns)
- Then call get_owner_portfolio after get_building_owner returns the owner name (it's instant)

RULES:
- Only report numbers and data that your tools actually return. Never fabricate violation counts, complaint numbers, or owner names.
- If a tool fails or returns an error, say so briefly and continue with what you have.
- If asked for your data source, say it comes from NYC's official HPD housing database.
"""

# ---------------------------------------------------------------------------
# Tool wrappers — ADK requires synchronous or async callables
# ---------------------------------------------------------------------------

async def _tool_get_building_violations(address: str) -> str:
    """
    Get open HPD violations for a building.
    Call this FIRST when given an address. Returns violation counts by class and the BBL.

    Args:
        address: Full address with borough, e.g. "1520 Sedgwick Avenue, Bronx"
    """
    result = await get_building_violations(address)
    return json.dumps(result)


async def _tool_get_building_complaints(bbl: str) -> str:
    """
    Get HPD complaint history for a building using its BBL.
    Call this AFTER get_building_violations returns the BBL. Run in parallel with get_building_owner.

    Args:
        bbl: 10-digit BBL string from get_building_violations result
    """
    result = await get_building_complaints(bbl)
    return json.dumps(result)


async def _tool_get_building_owner(address: str) -> str:
    """
    Get registered owner and managing agent for a building.
    Call this AFTER get_building_violations. Run in parallel with get_building_complaints.

    Args:
        address: Full address with borough, e.g. "1520 Sedgwick Avenue, Bronx"
    """
    result = await get_building_owner(address)
    return json.dumps(result)


def _tool_get_owner_portfolio(owner_name: str, corporate_name: str = "") -> str:
    """
    Look up pre-computed portfolio statistics for a landlord.
    Call this AFTER get_building_owner returns the owner/corporate name.
    This is an instant lookup — no API call needed.

    Args:
        owner_name: Individual owner name (may be empty string if not found)
        corporate_name: Corporate entity name (may be empty string if not found)
    """
    result = get_owner_portfolio(owner_name, corporate_name)
    return json.dumps(result)


# ---------------------------------------------------------------------------
# ADK Agent definition
# ---------------------------------------------------------------------------

root_agent = Agent(
    name="slumlordwatch",
    model="gemini-live-2.5-flash-native-audio",
    description="NYC HPD field intelligence agent for housing inspectors. Delivers spoken building briefings and classifies violations from camera.",
    instruction=SYSTEM_PROMPT,
    tools=[
        FunctionTool(_tool_get_building_violations),
        FunctionTool(_tool_get_building_complaints),
        FunctionTool(_tool_get_building_owner),
        FunctionTool(_tool_get_owner_portfolio),
    ],
)

# ---------------------------------------------------------------------------
# For direct testing without adk web (optional)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("SlumlordWatch agent loaded.")
    print("Run with: adk web")
    print("")
    print("Or test address parsing:")
    for addr in ["1520 Sedgwick Avenue, Bronx", "515 Park Avenue, Manhattan"]:
        try:
            parsed = parse_address(addr)
            print(f"  {addr} → {parsed}")
        except Exception as e:
            print(f"  {addr} → ERROR: {e}")
