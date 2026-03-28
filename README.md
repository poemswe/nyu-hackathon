# Sightline — Field Intelligence Agent for NYC Housing Enforcement

> "The data was always public. We just made it impossible to hide in plain sight."

Built for the Google Cloud x Gemini Hackathon · March 2026

---

## The Problem

Every day, HPD inspectors walk into buildings with a clipboard and a single complaint. What they don't have is context.

The landlord has a portfolio management system, lawyers, and shell companies. The inspector has a clipboard.

- **784,000+** inspections per year across 110,000 buildings — with a team of ~350 inspectors
- That's roughly **9 buildings every single working day** per inspector
- A NY State Comptroller audit found one Brooklyn building that filed **175 complaints over 2 years** and received **zero completed inspections**
- Hazardous (Class B) and immediately hazardous (Class C) violations grew **32% year-over-year** in FY2024
- The worst conditions are overwhelmingly concentrated in low-income Black and Latino neighborhoods in the South Bronx, Brownsville, and East New York

The system has all the data to prove it. It just never connects the dots.

---

## The Solution

Sightline is a voice + vision agent powered by **Gemini Live API** and **Google ADK**.

An inspector speaks a building address while walking to the building. The agent assembles a spoken intelligence brief in under 45 seconds:

- Full violation history by class (A/B/C)
- Ownership chain across all LLCs
- Complaint patterns and 12-month trend
- Portfolio size across all landlord buildings
- Worst Landlord Watchlist status
- Recently "certified as fixed" violations to re-verify on-site

They point their phone at the building — the agent classifies conditions in real time, proposes violation classes, and drafts the violation report through natural conversation.

**No forms. No dashboards. No friction.**

---

## Why the Inspector, Not the Tenant

Most civic technology puts the burden on the victim. We flip that.

Our user is the person who already has institutional power. Inspectors already go into buildings — we just make each visit exponentially more informed.

The inequality isn't just in the building conditions — it's in the **information asymmetry** between a well-lawyered landlord with a portfolio management system and an overworked inspector with a clipboard.

Knowing a landlord has 800 violations across 30 buildings is the threshold that activates HPD's **Alternative Enforcement Program (AEP)** — the city's most powerful enforcement tool. Our agent surfaces that flag automatically, in the field, in real time.

The tenant never has to touch it. They just get to live somewhere safer.

---

## Three Capabilities

### 1. Voice Brief — before the inspector walks in
Inspector speaks an address → agent calls tools in sequence → speaks a structured brief:
> *"1520 Sedgwick Avenue, Bronx. 47 open violations — 14 Class C immediately hazardous, including lead paint and no heat. The registered owner is Koscal 59 LLC, operating 29 buildings with 2,300 combined violations. Number 3 on the 2025 Worst Landlord Watchlist. 3 violations certified as fixed last month — you may want to verify those on-site. Ready when you are for the visual inspection."*

### 2. Vision Logging — on the ground
Inspector activates camera → Gemini Live receives frames at 1 FPS → agent identifies conditions and proposes violation classifications:
- Water damage / active leak → suggested Class C
- Mold / mildew → suggested Class B
- Peeling paint (pre-1978 building) → suggested Class C
- Pest evidence → suggested Class B

All classifications are framed as suggestions requiring inspector confirmation.

### 3. Auto-Draft Report — no paperwork
Agent assembles the violation report through voice conversation. Inspector confirms by voice. What used to take hours of cross-referencing happens in a 2-minute conversation on the sidewalk.

---

## Architecture

```
Browser (Mobile PWA)          Python Backend (Cloud Run)       Gemini Live API
┌──────────────────┐          ┌──────────────────────┐         ┌─────────────┐
│ 4-state UI        │  WS      │ FastAPI               │  WS     │             │
│ Idle → Listening  │◄────────►│ ADK Agent             │◄───────►│  Gemini     │
│ Briefing → Vision │          │ LiveRequestQueue       │         │  Live       │
└──────────────────┘          └──────────┬────────────┘         └─────────────┘
                                         │ HTTP (SODA API)
                                         ▼
                              ┌──────────────────────┐
                              │ NYC Open Data         │
                              │ HPD Violations        │
                              │ HPD Complaints        │
                              │ HPD Registration      │
                              │ Watchlist JSON (local)│
                              └──────────────────────┘
```

**Key decisions:**
- **Cloud Run** for the backend — holds WebSocket connections for the full Live API session duration
- **ADK `run_live`** with `LiveRequestQueue` — handles streaming, tool execution, and reconnection
- **No database** — cache-first with local JSON for demo reliability, live SODA API queries otherwise
- **PWA on Firebase Hosting** — judges open a URL on their phone, no install required
- **Model:** `gemini-2.0-flash-live-001` via Gemini API

---

## Data Sources

| Dataset | API | Notes |
|---|---|---|
| HPD Violations | `data.cityofnewyork.us/resource/wvxf-dwi5.json` | Open violations by class, false cert detection |
| HPD Complaints | `data.cityofnewyork.us/resource/ygpa-z7cr.json` | 12-month trend, category breakdown |
| HPD Registration | `data.cityofnewyork.us/resource/tesw-yqqr.json` | Owner identity, managing agent |
| Registration Contacts | `data.cityofnewyork.us/resource/feu5-w2e2.json` | Corporate + individual owner lookup |
| Worst Landlord Watchlist | Local JSON | Pre-built, checked into repo |
| Portfolio Stats | Local JSON | Pre-computed for top watchlist landlords |

All sources are public NYC Open Data — no auth required.

---

## Why This Is Agentic — Not a Wrapper

- Reasons autonomously across multiple fragmented public datasets
- Identifies LLC shell company patterns no single database query would surface
- Decides what's relevant, what's a red flag, what needs escalation
- Acts — drafting violation reports, surfacing cross-building risk, flagging AEP triggers
- All through live voice and vision, in real time, on the street

---

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/poemswe/nyu-hackathon.git
cd nyu-hackathon

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set your Gemini API key
export GOOGLE_API_KEY=your_key_here         # macOS/Linux
$env:GOOGLE_API_KEY = "your_key_here"       # Windows PowerShell

export GOOGLE_GENAI_USE_VERTEXAI=False
$env:GOOGLE_GENAI_USE_VERTEXAI = "False"    # Windows

# 4. Run the backend
uvicorn backend.server:app --reload --port 8080

# 5. Open in browser
# http://localhost:8080
```

---

## Demo Addresses

| Address | What happens |
|---|---|
| 1520 Sedgwick Ave, Bronx | 47 violations, Koscal 59 LLC, #3 on Watchlist — full briefing |
| 515 Park Ave, Manhattan | Zero violations, zero complaints — the silence lands |

---

## Phase 2

Same agentic system, tenant-facing side. A tenant asks: *"I reported mold 3 weeks ago. What's the status?"* The agent pulls inspection date, violations issued, correction deadline — in plain language, any language, mobile-first.

Both ends of the enforcement chain. The loop finally closed.

---

## Team

Built at the Google Cloud x Gemini Hackathon · March 2026

| Name | 
|---|
| [Poe Mynt Swe] |
| [Sarah Machado] |
| [Fatema Ortega] |
| [Chirag Dhiwar] |
| [Lavinia Lin] |

---

## Branch Notes

Active development branch: `bugfix-demo`
- Fixed audio playback blocked by tool-call turn completions
- Fixed briefing CTA view not showing after agent finishes speaking
- Fixed vision back button resetting UI to idle state
- Fixed model name for Gemini API (non-Vertex) auth path
