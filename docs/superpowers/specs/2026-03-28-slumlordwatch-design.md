# SlumlordWatch: Design Spec

**Gemini Live Field Intelligence Agent for NYC Housing Enforcement**

## Problem

HPD housing inspectors arrive at buildings with a single complaint and no context. The landlord has a portfolio management system, lawyers, and shell companies. The inspector has a clipboard. This information asymmetry is the business model that enables slumlords — concentrated in low-income Black and Latino neighborhoods — to operate with impunity.

HPD's current tool (RTFF) handles workflow and data capture but does not cross-reference violation history, ownership portfolios, complaint patterns, or watchlist status. No existing product fills this gap.

## Solution

A voice + vision agent powered by Gemini Live and ADK. An inspector speaks a building address. The agent assembles a spoken intelligence briefing in under 15 seconds: full violation history, complaint patterns, owner identity, portfolio size across all their buildings, and Worst Landlord Watchlist status. The inspector then points their phone camera at building conditions — the agent classifies what it sees, maps conditions to violation classes, and drafts the violation report through conversation.

No forms. No typing. No text box.

## User

NYC HPD housing inspector performing field visits. Secondary user (future): tenant-facing mode showing the same intelligence from the other side of the power asymmetry.

## Two-Moment Interaction

### Moment 1: The Briefing

Inspector speaks an address while walking to the building. Agent calls tools in a dependency-aware sequence (Tool 1 first, then Tools 2+3 in parallel, then Tool 4 if available), synthesizes results, and speaks a structured brief:

1. Open violation count by class (A/B/C) with descriptions
2. Complaint history — top categories, trend, recency
3. Owner name, corporate entity, managing agent
4. Owner's full portfolio — total buildings, total violations, worst properties
5. Worst Landlord Watchlist rank (if applicable)
6. Recently certified-as-fixed violations to re-verify on-site

Target duration: under 45 seconds spoken (~150 words).

### Moment 2: The Eyes

Inspector activates camera. Gemini Live receives frames at 1 FPS. Agent identifies visible conditions, proposes violation classifications:

- Water damage / active leak → suggested Class C
- Mold / mildew → suggested Class B
- Peeling paint → suggested Class C if building is pre-1978 (agent checks `yearbuilt` from PLUTO or asks inspector), otherwise Class B
- Cracked plaster / walls → suggested Class B
- Pest evidence → suggested Class B
- Broken window / door → suggested Class B

All vision-based classifications are suggestions requiring inspector confirmation. The agent explicitly frames them as proposed: "This looks like it could be a Class C active leak — does that match what you're seeing?" Agent drafts violation narrative through voice conversation. Inspector confirms, edits, or adds observations. Agent reads back the complete draft on request.

## Architecture

```
Browser (Mobile PWA)          Python Backend (Cloud Run)        Google Cloud
┌──────────────────┐          ┌──────────────────────┐          ┌──────────────┐
│ getUserMedia      │ WS      │ FastAPI               │ WS      │ Gemini Live  │
│ (mic + camera)    │────────>│ ADK Agent             │────────>│ API          │
│ Web Audio API     │<────────│ (4 tools + vision)    │<────────│              │
│ Transcript overlay│         │ Watchlist JSON         │         └──────────────┘
└──────────────────┘          └──────────┬───────────┘
                                         │ HTTP
                                         ▼
                              ┌──────────────────────┐
                              │ NYC Open Data         │
                              │ (SODA API, no auth)   │
                              └──────────────────────┘
```

### Key decisions

- **Server-to-server** WebSocket pattern. API key stays server-side. ADK handles tool execution automatically.
- **Cloud Run** for the backend. Cloud Functions cannot hold WebSocket connections for the duration of a Live API session (up to 10 minutes).
- **PWA on Firebase Hosting.** Judges open a URL on their phone. No install.
- **No database.** No Firestore, no auth, no user accounts. Best-effort live queries with cache-first for demo addresses. Local JSON files checked into the repo (watchlist, portfolio stats, cached API responses) provide demo reliability without any external database or cache service.
- **ADK over raw Gemini API.** ADK auto-executes tools during streaming sessions and handles reconnection. Raw Live API requires manual tool response handling.
- **Start with `adk web`** for development. Build custom frontend only if time permits.

## ADK Agent

```
Name: SlumlordWatch Field Intelligence Agent
Model: gemini-2.5-flash
Voice: Kore
```

### System prompt

> You are a field intelligence agent for NYC housing inspectors. When given a building address, assemble a spoken briefing by calling your tools. Be direct, cite numbers, flag red flags. After the briefing, analyze building conditions through the camera and propose violation classifications — always frame visual assessments as suggestions requiring inspector confirmation ("This looks like it could be..."). For tool-sourced data (violations, complaints, ownership), report exactly what the tools return. Never fabricate numbers or violation records.

### Tool 1: get_building_violations

- **Input:** address (street number + street name), borough
- **API:** HPD Violations `https://data.cityofnewyork.us/resource/wvxf-dwi5.json`
- **Query:** `?housenumber={num}&streetname={street}&boro={borough}&violationstatus=Open`
- **Returns:** Count by class (A/B/C), open violations with descriptions and dates. Constructs BBL for downstream tools.
- **BBL construction:** The violations dataset has separate `boroid`, `block`, `lot` fields — no `bbl` field. Construct as: `bbl = f"{boroid}{block.zfill(5)}{lot.zfill(4)}"` (1-digit borough + 5-digit block + 4-digit lot = 10-digit string).
- **False cert query:** Separate query for recently certified violations: `$where=currentstatus='CERTIFICATION CLOSEOUT' AND currentstatusdate > '{90_days_ago}'`. Date must be ISO 8601 floating timestamp (e.g., `2026-01-01T00:00:00`). This catches violations the landlord claims were fixed.

### Tool 2: get_building_complaints

- **Input:** BBL (constructed by Tool 1)
- **Depends on:** Tool 1 (needs BBL)
- **API:** HPD Complaints `https://data.cityofnewyork.us/resource/ygpa-z7cr.json`
- **Query:** `?bbl={bbl}&$where=received_date > '{12_months_ago}'` (date as ISO 8601 floating timestamp, e.g., `2025-03-28T00:00:00`)
- **Returns:** Total complaints last 12 months, breakdown by `major_category`, 3-month vs 12-month trend, most recent complaints.

### Tool 3: get_building_owner

- **Input:** address (street number + street name, borough) — does NOT depend on Tool 1
- **APIs:**
  - Registration: `https://data.cityofnewyork.us/resource/tesw-yqqr.json`
  - Contacts: `https://data.cityofnewyork.us/resource/feu5-w2e2.json`
- **Query:** Query Registration by `housenumber` + `streetname` + `boroid` to get `registrationid`. Then two queries on Contacts: one for `type=CorporateOwner` (uses `corporationname` field), one for `type=IndividualOwner` (uses `firstname` + `lastname` fields). Or combine: `$where=type in('CorporateOwner','IndividualOwner')`.
- **Returns:** Owner name, corporate name, managing agent. Cross-references against Worst Landlord Watchlist using exact-match plus a curated alias table (e.g., "A&E REAL ESTATE" → "A & E REAL ESTATE HOLDINGS LLC"). Returns watchlist rank if matched.

### Tool 4: get_owner_portfolio

- **Input:** Owner name or corporate name (from Tool 3)
- **Implementation:** Pre-computed static JSON checked into repo. Contains portfolio stats for the top 100 Worst Landlord Watchlist landlords: total buildings, total open violations, top 3 worst buildings. Built from a one-time batch query before the hackathon.
- **Returns:** Total buildings owned, total open violations across portfolio, top 3 worst buildings by violation count.
- **Why pre-computed:** Live portfolio aggregation requires N+1 API calls (one per building) which breaks the 15-second briefing target. For 3 demo landlords, pre-computed data is reliable and fast. Live aggregation is a post-hackathon feature.

### Tool orchestration

```
Tool 1 (violations — needs address only)
    ↓ provides BBL
    ├── Tool 2 (complaints — needs BBL from Tool 1)  ── parallel
    └── Tool 3 (owner — needs address only)           ── parallel
              ↓ provides owner name
              Tool 4 (portfolio — static JSON lookup, optional)
```

Tool 1 runs first (extracts BBL). Then Tools 2 and 3 run in parallel (Tool 2 uses BBL, Tool 3 uses the original address). Tool 4 runs after Tool 3 returns the owner name — it's a local JSON lookup so it's instant. ADK manages the execution loop and feeds results to Gemini for synthesis.

## Briefing Format (Example)

> "1520 Sedgwick Avenue, Bronx.
>
> This building has 47 open violations. 14 are Class C immediately hazardous, including lead-based paint in units 3B and 5A, and no heat reported across multiple floors. 22 are Class B hazardous, mostly plumbing and pest-related. 11 are Class A non-hazardous.
>
> In the last 12 months, tenants filed 23 complaints. Heat and hot water is the top category at 14, followed by rats and roaches at 6. Complaints have been increasing — 8 in the last 3 months alone.
>
> The registered owner is Koscal 59 LLC. That entity also owns 29 other buildings with a combined 2,300 open violations. This landlord is number 3 on the 2025 Worst Landlord Watchlist.
>
> 3 violations were certified as corrected last month — mold in 4B, lead paint in 2A, and a broken window in 6C. Given the pattern, you may want to verify those on-site.
>
> Ready when you are for the visual inspection."

Design principles: numbers first, escalating severity (building → portfolio → flags), under 45 seconds, ends with a handoff to vision mode.

## Frontend (PWA)

Four states, minimal UI. The voice is the interface.

**Idle:** Dark background, large mic button, "Tap to speak an address."

**Listening:** Mic button pulses. Live transcript at bottom. Camera not active.

**Briefing:** Agent speaking indicator. Key data as text overlay (violation count, owner, watchlist status). Text persists after agent finishes.

**Vision:** Full-screen camera view. Agent transcript overlay at bottom. Badge showing drafted violation count.

No address input field, no navigation, no menu, no settings. HTML + vanilla JS + CSS. `navigator.mediaDevices.getUserMedia()` for mic and camera. WebSocket to backend. Firebase Hosting. PWA manifest for home screen install.

## Data Sources

| Dataset | ID | Endpoint | Join Key |
|---|---|---|---|
| HPD Violations | `wvxf-dwi5` | `data.cityofnewyork.us/resource/wvxf-dwi5.json` | boroid+block+lot (construct BBL), registrationid |
| HPD Complaints | `ygpa-z7cr` | `data.cityofnewyork.us/resource/ygpa-z7cr.json` | BBL |
| HPD Registration | `tesw-yqqr` | `data.cityofnewyork.us/resource/tesw-yqqr.json` | registrationid |
| Registration Contacts | `feu5-w2e2` | `data.cityofnewyork.us/resource/feu5-w2e2.json` | registrationid |
| Worst Landlord Watchlist | static JSON | Pre-built, checked into repo | Exact match + alias table |
| Portfolio Stats | static JSON | Pre-computed batch query, checked into repo | Owner name from Watchlist |

BBL (Borough-Block-Lot) is the universal join key. Normalize to 10-digit string: `f"{boroid}{block.zfill(5)}{lot.zfill(4)}"`. HPD Violations uses separate fields (no `bbl` column); HPD Complaints has a `bbl` field; PLUTO stores it as a float.

## Build Plan (10 Hours)

| Hours | Work | Milestone |
|---|---|---|
| 1-2 | ADK agent definition + `adk web` voice in/out working (no FastAPI yet) | Say "hello," hear response |
| 3-4 | Implement 4 tools, load Watchlist + Portfolio JSON, build demo address cache | Speak address, hear full briefing with real data |
| 5 | Camera streaming + vision classification | Point at photo, agent classifies and drafts violation |
| 6-7 | PWA frontend (4 states), deploy to Firebase | Full flow works on phone |
| 8 | End-to-end testing, prompt tuning, cached fallbacks | Reliable demo with 3-4 addresses |
| 9-10 | Demo prep: select addresses, prepare photos, record fallback video, rehearse | Ready to present |

### Go/no-go checkpoints

| After hour | Must have | Fallback |
|---|---|---|
| 2 | Voice in/out | This is the foundation — debug until it works |
| 4 | 2+ tools returning real data | Hardcode responses for demo addresses |
| 5 | Vision classifying conditions | Drop vision, briefing alone is strong enough |
| 7 | Frontend on phone | Use `adk web` as demo UI |

### Cut order (if behind schedule)

1. Custom frontend → use `adk web`
2. Tool 4 (portfolio) → hardcode one example
3. Vision mode → briefing-only demo
4. Never cut: the spoken briefing with real data

## Demo Script (3 Minutes)

**Setup (30s):** Open app on phone. "HPD inspectors walk into buildings with a clipboard and a single complaint. We gave them an investigator."

**Briefing (60s):** Speak "Brief me on 1520 Sedgwick Avenue, Bronx." Agent delivers the full briefing. Room hears the portfolio reveal.

**Comparison (30s):** Speak "Brief me on 515 Park Avenue, Manhattan." Agent: zero violations, zero complaints. Let the silence land. That's the inequality moment.

**Vision (45s):** Point camera at prepared photos on tablet (mold, water damage, peeling paint). Agent classifies, drafts violations through conversation.

**Close (15s):** "That took two minutes. Without this, it takes hours — if it happens at all."

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Gemini Live WebSocket drops | Pre-recorded fallback video |
| NYC Open Data API slow/down | Local JSON cache for demo addresses checked into repo. Tools check cache first, fall back to live API with 3-second timeout. |
| Gemini hallucinates numbers | System prompt: only report tool data. Structured JSON responses. |
| Camera misclassifies | Use obvious prepared photos for demo |
| Address parsing fails | Hardcode normalizer for demo addresses |
| Noisy demo room | Presenter uses earbuds with mic |

## Competitive Landscape

No direct competitor exists. Closest players:
- **Gryps:** AI data analysis for NYC DOB supervisors (not HPD, not field use)
- **Tolemi:** Data integration for DOB permitting (not HPD inspectors)
- **JustFix / Who Owns What:** Tenant-facing ownership transparency (not inspector-facing)
- **HPD RTFF:** HPD's own app — workflow/data capture only, no AI, no cross-referencing
- **Fulcrum Audio:** Voice field data collection — general purpose, not housing code

The voice-first field inspection pattern is validated (Fulcrum, SnapInspect, InspectorAI). Nobody has applied it to housing code enforcement.

## Future (Pitch Deck Only)

- Tenant-facing mode: same intelligence, other side of the power asymmetry
- LLC entity resolution via ACRIS property records
- Integration with RTFF for direct violation submission
- AEP building auto-flagging for proactive enforcement
- Certification audit mode: systematically re-inspect flagged false certifications
