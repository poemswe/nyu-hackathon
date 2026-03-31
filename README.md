# Sightline — Field Intelligence for NYC Housing Inspectors

Built for the Google Cloud x Gemini Hackathon, March 2026

---

## The Problem

Every day, HPD inspectors walk into buildings with a clipboard and a single complaint. The landlord has a portfolio management system, lawyers, and shell companies. The inspector has a clipboard.

- **784,000+** inspections per year across 110,000 buildings, handled by ~350 inspectors
- A NY State Comptroller audit found one Brooklyn building that filed **175 complaints over 2 years** and received **zero completed inspections**
- Hazardous (Class B) and immediately hazardous (Class C) violations grew **32% year-over-year** in FY2024
- The worst conditions concentrate in low-income Black and Latino neighborhoods in the South Bronx, Brownsville, and East New York

The data to prove all of this is public. Nobody connects the dots.

---

## The Solution

Sightline is a voice + vision agent powered by **Gemini Live API** (`gemini-live-2.5-flash-native-audio`) and **Google ADK**.

An inspector speaks a building address while walking to a site. The agent assembles a spoken intelligence brief in under 45 seconds:

- Open violations by class (A/B/C), with specific conditions and affected units
- Complaint patterns over the past 12 months, trending up or down
- Registered owner and corporate entity, traced through LLC registrations
- Total portfolio size across all landlord buildings
- Worst Landlord Watchlist status and rank
- Recently "certified as fixed" violations flagged for on-site re-verification

Then the inspector points their phone at the building. The agent classifies conditions from camera frames in real time, proposes violation classes through conversation, and drafts the violation report by voice.

No forms. No dashboards. No typing.

---

## Why the Inspector, Not the Tenant

Most civic tech puts the burden on the victim. Sightline targets the person who already has institutional power. Inspectors already enter buildings; we make each visit radically more informed.

A landlord with 800 violations across 30 buildings triggers HPD's **Alternative Enforcement Program (AEP)**, the city's most powerful enforcement tool. Sightline surfaces that flag automatically, in the field, in real time.

The tenant never touches the app. They just get to live somewhere safer.

---

## Three Capabilities

### 1. Voice Brief

Inspector speaks an address. The agent calls four tools in sequence and speaks a structured brief:

> *"1520 Sedgwick Avenue, Bronx. 47 open violations -- 14 Class C immediately hazardous, including lead paint and no heat. The registered owner is Koscal 59 LLC, operating 29 buildings with 2,300 combined violations. Number 3 on the 2025 Worst Landlord Watchlist. 3 violations certified as fixed last month -- you may want to verify those on-site. Ready when you are for the visual inspection."*

### 2. Vision Logging

Inspector activates the camera. Gemini Live receives frames at ~1 FPS and identifies conditions:

- Water damage / active leak -- suggested Class C
- Mold / mildew -- suggested Class B
- Peeling paint (pre-1978 building) -- suggested Class C
- Pest evidence -- suggested Class B

All classifications are framed as suggestions requiring inspector confirmation.

### 3. Auto-Draft Report

The agent accumulates observations through voice conversation during the visual inspection. On exit, it presents a structured violation draft grouped by model turn. What used to take hours of cross-referencing happens in a 2-minute conversation on the sidewalk.

---

## Architecture

```
Browser (Mobile PWA)          Python Backend (Cloud Run)       Gemini Live API
+-----------------+           +---------------------+          +-----------+
| 4-state UI      |   WS     | FastAPI              |   WS    |           |
| Idle > Listen   |<-------->| ADK Agent            |<------->| Gemini    |
| Brief > Vision  |          | LiveRequestQueue     |         | Live      |
+-----------------+          +----------+-----------+          +-----------+
                                        | HTTP (SODA API)
                                        v
                             +---------------------+
                             | NYC Open Data        |
                             | HPD Violations       |
                             | HPD Complaints       |
                             | HPD Registration     |
                             | Watchlist JSON       |
                             +---------------------+
```

**Key decisions:**

- **Cloud Run** hosts both the backend and the PWA static files. WebSocket connections persist for the full Live API session.
- **ADK `run_live`** with `LiveRequestQueue` handles bidirectional streaming, tool execution, and audio transcription.
- **No database.** Local JSON cache for demo reliability; live SODA API queries for everything else.
- **Zero-gain oscillator** on the AudioContext keeps mobile Chrome from suspending audio playback between speech segments.
- **Model:** `gemini-live-2.5-flash-native-audio` via Vertex AI

---

## Data Sources

| Dataset | Endpoint | Purpose |
|---|---|---|
| HPD Violations | `wvxf-dwi5` | Open violations by class, false cert detection |
| HPD Complaints | `ygpa-z7cr` | 12-month trend, category breakdown by BBL |
| HPD Registration | `tesw-yqqr` | Building registration, owner identity |
| Registration Contacts | `feu5-w2e2` | Corporate + individual owner + managing agent |
| Worst Landlord Watchlist | Local JSON | Pre-built from public advocate data |
| Portfolio Stats | Local JSON | Pre-computed for top watchlist landlords |

All queries hit `data.cityofnewyork.us/resource/{id}.json` (SODA API). No auth required.

---

## Setup

```bash
git clone https://github.com/poemswe/nyu-hackathon.git
cd nyu-hackathon

pip install -r requirements.txt

# Option A: Vertex AI (used in production)
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=us-central1
export GOOGLE_GENAI_USE_VERTEXAI=True

# Option B: Gemini API key
export GOOGLE_API_KEY=your_key_here
export GOOGLE_GENAI_USE_VERTEXAI=False

uvicorn backend.server:app --reload --port 8080
# Open http://localhost:8080
```

### Deploy to Cloud Run

```bash
gcloud run deploy slumlordwatch \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --timeout 300
```

---

## Project Structure

```
backend/
  agent.py          # ADK agent definition, system prompt, tool wrappers
  server.py         # FastAPI + WebSocket bridge (browser <-> Gemini Live)
  normalizer.py     # Address parsing, street name normalization for SODA API
  tools/
    violations.py   # HPD violations by address (Tool 1, returns BBL)
    complaints.py   # HPD complaints by BBL (Tool 2, parallel)
    owner.py        # Registration + contacts lookup (Tool 3, parallel)
    portfolio.py    # Pre-computed portfolio stats (Tool 4, instant)
  data/
    watchlist.json  # Worst Landlord Watchlist
    portfolio.json  # Portfolio statistics for top landlords
    demo_cache.json # Cached responses for demo addresses

frontend/
  index.html        # 4-state PWA: idle, listening, briefing, vision
  app.js            # WebSocket client, audio pipeline, state machine
  style.css         # Mobile-first dark UI
```

---

## Team

Built at the Google Cloud x Gemini Hackathon, March 2026

| Name | Role |
|---|---|
| Poe Myint Swe | Engineering (architecture, backend, frontend, infra) |
| Sarah Machado | Product lead, presentation, concept |
| Fatema Ortega | Concept and research |
| Chirag Dhiwar | Engineering (contributor) |
