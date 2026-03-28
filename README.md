# SlumlordWatch

**Gemini Live Field Intelligence Agent for NYC Housing Enforcement**

---

## Roadmap

### Hour 1–2 · Foundation: ADK agent + voice in/out (`adk web`)
**Milestone: Say "hello," hear response**

- [ ] Install dependencies (`pip install google-adk`)
- [ ] Write `agent.py` — ADK agent definition, system prompt, voice config (Kore)
- [ ] Run `adk web` — confirm mic input → Gemini response → audio output
- [ ] No tools yet, no FastAPI yet — just the voice loop

### Hour 3–4 · Tools + Data: Full briefing with real data
**Milestone: Speak address, hear full briefing**

- [ ] Implement Tool 1: `get_building_violations` (HPD SODA API, BBL construction, false-cert query)
- [ ] Implement Tool 2: `get_building_complaints` (BBL input, 12-month window, trend calc)
- [ ] Implement Tool 3: `get_building_owner` (Registration + Contacts, alias table)
- [ ] Implement Tool 4: `get_owner_portfolio` (static JSON lookup)
- [ ] Load `watchlist.json` and `portfolio.json` into repo
- [ ] Build `demo_cache.json` — pre-cached API responses for 3 demo addresses
- [ ] Wire tools into ADK agent, confirm parallel execution (Tools 2+3)
- [ ] Test full briefing for 1520 Sedgwick Ave, Bronx

### Hour 5 · Vision: Camera streaming + violation classification
**Milestone: Point at photo, agent classifies and drafts violation**

- [ ] Add camera frame capture to the session (1 FPS)
- [ ] Test vision classifications: water damage, mold, peeling paint, pest, broken window
- [ ] Confirm violation class suggestions and "does that match what you're seeing?" framing

### Hour 6–7 · PWA Frontend (build early, not last)
**Milestone: Full flow works on phone, deployed to Firebase**

- [ ] Build PWA shell with 4 states: Idle / Listening / Briefing / Vision
- [ ] Build FastAPI backend with WebSocket session manager
- [ ] Connect PWA → FastAPI → ADK → Gemini Live
- [ ] Add camera analysis overlay (pulsing "analyzing..." badge)
- [ ] Address normalizer (street name cleaner for SODA API)
- [ ] Deploy to Firebase Hosting + Cloud Run

### Hour 8 · Hardening
**Milestone: Reliable demo with 3–4 addresses**

- [ ] End-to-end test all demo addresses
- [ ] Prompt tuning: tighten briefing to <45 seconds
- [ ] Cache fallback verification (simulate API timeout)
- [ ] WebSocket reconnection test

### Hour 9–10 · Demo prep
**Milestone: Ready to present**

- [ ] Select 3 demo addresses (1520 Sedgwick, 515 Park, one more)
- [ ] Print / display violation photos for vision demo
- [ ] Record fallback video (in case live demo fails)
- [ ] Rehearse 3-minute script

---

## Go/No-Go Checkpoints

| After hour | Must have | Fallback |
|---|---|---|
| 2 | Voice in/out via `adk web` | Debug until working — this is the foundation |
| 4 | 2+ tools with real data | Hardcode responses for demo addresses |
| 5 | Vision classifying conditions | Drop vision — briefing alone is strong |
| 7 | Frontend on phone | Use `adk web` as demo UI |

## Cut Order (if behind)

1. Custom frontend → use `adk web`
2. Tool 4 (portfolio) → hardcode one example
3. Vision mode → briefing-only demo
4. **Never cut:** spoken briefing with real data

---

## Project Structure

```
slumlordwatch/
├── backend/
│   ├── agent.py              # ADK agent definition (hours 1-2)
│   ├── tools/
│   │   ├── violations.py     # Tool 1
│   │   ├── complaints.py     # Tool 2
│   │   ├── owner.py          # Tool 3
│   │   └── portfolio.py      # Tool 4
│   ├── normalizer.py         # Street name cleaner
│   ├── server.py             # FastAPI + WebSocket bridge (hours 6-7)
│   └── data/
│       ├── watchlist.json
│       ├── portfolio.json
│       └── demo_cache.json
├── frontend/
│   ├── index.html            # PWA shell
│   ├── app.js                # 4-state UI logic
│   ├── style.css             # UI styles
│   └── manifest.json         # PWA manifest
├── scripts/
│   └── build_cache.py        # Pre-cache demo addresses
├── firebase.json
├── .firebaserc
├── requirements.txt
└── README.md
```

---

## Setup

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set your Gemini API key
export GOOGLE_API_KEY=your_key_here

# 3. Hours 1-2: Run with adk web (no FastAPI)
cd backend
adk web

# 4. Hours 6+: Run full stack
uvicorn backend.server:app --reload --port 8080
```

---

## Demo Addresses

| Address | Why |
|---|---|
| 1520 Sedgwick Ave, Bronx | High violations, watchlist landlord, powerful briefing |
| 515 Park Ave, Manhattan | Zero violations — the silence lands hard |
| TBD (add a 3rd) | Backup / variety |
