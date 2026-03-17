# STP Church AV Control System

## What This Is

A church AV control system that provides tablet-based control of audio, video, streaming, cameras, projectors, and power. This repo (`STP_tablets`) is the single active repo containing the gateway backend (all protocols built-in), health monitoring, occupancy analytics, and the frontend tablet UI. All other repos (`STP_scripts`, `STP_healthdash`, `STP_Occupancy`, `STP_THRFiles_Current`) are archived.

## Repository Structure

```
STP_tablets/              → Gateway + Frontend (this repo)
├── gateway/              → Flask backend (REST API + WebSocket hub)
│   ├── gateway.py        ← Entry point (shim → gateway_app.py)
│   ├── gateway_app.py    ← Flask/SocketIO setup, GatewayContext, startup
│   ├── api_routes.py     ← REST endpoint handlers (~3,500 lines)
│   ├── auth.py           ← IP allowlist, PIN auth, sessions, permissions
│   ├── macro_engine.py   ← Macro parsing, execution, step types
│   ├── polling.py        ← Background pollers, state cache, watchdog
│   ├── scheduler.py      ← Cron-like schedule execution
│   ├── database.py       ← SQLite audit log, schedule DB
│   ├── socket_handlers.py← SocketIO events, rooms, heartbeat
│   ├── x32_module.py     ← Phase 1: direct X32 mixer OSC/UDP
│   ├── moip_module.py    ← Phase 2: direct MoIP controller Telnet
│   ├── obs_module.py     ← Phase 3: direct OBS Studio WebSocket
│   ├── health_module.py  ← Phase 4: built-in health monitoring
│   ├── occupancy_module.py ← Phase 6: occupancy analytics (CSV + download)
│   ├── announcement_module.py ← TTS announcements via edge-tts + WiiM
│   ├── event_automation.py ← Calendar-driven event automation
│   ├── user_module.py    ← User account management (bcrypt)
│   ├── config.yaml
│   ├── macros.yaml
│   ├── announcements.yaml ← TTS announcement definitions
│   ├── users.yaml         ← User account database
│   ├── requirements.txt
│   └── tests/             ← 12 test files (~3,000 lines), run by pre-commit hook
├── frontend/             → Tablet UI (served as static files by gateway)
│   ├── index.html
│   ├── css/
│   ├── js/
│   ├── config/
│   └── assets/
├── hooks/                → Git hooks (copy to .git/hooks/ after clone)
│   └── pre-commit        ← Runs tests + auto-increments version (YY-NNN)
├── docs/                 → All documentation
│   ├── DEPLOYMENT.md     ← Operations guide
│   ├── MIGRATION_GUIDE_MAC.md ← macOS setup
│   ├── MIGRATION_GUIDE_PC.md  ← Windows setup
│   ├── MACRO_REFERENCE.md     ← All macros & buttons explained
│   ├── PAGE_GUIDE.md          ← Page-by-page UI walkthrough
│   └── ...
└── CLAUDE.md             ← AI assistant project context (stays at root)

STP_scripts/              → Middleware proxies (archived, rollback only)
STP_healthdash/           → Monitoring dashboard (archived, absorbed in Phase 4)
STP_Occupancy/            → Occupancy dashboard (archived, absorbed in Phase 6)
```

## Architecture

```
Tablets/Browsers (kiosk mode, 10.100.60.0/24)
       │
       ▼
┌──────────────────────────┐
│  STP Gateway (:20858)    │  Flask + Flask-SocketIO
│  gateway/gateway.py      │
├──────────────────────────┤
│ • REST API for all devices│
│ • Socket.IO state sync   │
│ • Macro execution engine │
│ • Audit logging (SQLite) │
│ • Auth (IP allowlist+PIN)│
│ • Health monitoring      │
│ • Occupancy analytics    │
│ • TTS announcements      │
│ • Event automation       │
│ • User management        │
└──────────┬───────────────┘
           │
     ┌─────┼─────┬──────────┬───────────┐
     ▼     ▼     ▼          ▼           ▼
  ┌────────┐ ┌──────┐ ┌──────┐ ┌───────┐ ┌───────┐
  │ X32    │ │ MoIP │ │ OBS  │ │  PTZ  │ │ Epson │
  │(built- │ │(built│ │(built│ │direct │ │direct │
  │ in)    │ │ in)  │ │ in)  │ └───┬───┘ └───┬───┘
  └──┬─────┘ └──┬───┘ └──┬───┘     │          │
  OSC/UDP   Telnet  WebSocket  HTTP/CGI   HTTP/CGI
     ▼        ▼        ▼         ▼          ▼
  Behringer  Binary   OBS      10 PTZ     4 Epson
  X32 Mixer  MoIP     Studio   Cameras    Projectors
  .60.231    Matrix   :4455
             10.100.
             20.11:23

  Home Assistant @ 10.100.60.245:8123 (power, WattBox, EcoFlow)

  Health Module (built-in) — 30+ service checks, alerts, recovery
  Occupancy Module (built-in) — CSV analytics, daily download, Chart.js dashboard
  Announcement Module (built-in) — TTS generation via edge-tts, WiiM playback
  Event Automation (built-in) — Calendar-driven setup/teardown macros
```

## Key Files

### Frontend (`frontend/`)
- **index.html** — Single-page app entry point
- **config/settings.json** — App metadata, version (auto-incremented YY-NNN format), timeouts
- **config/devices.json** — MoIP transmitters (28), receivers (28), video scenes
- **config/permissions.json** — Per-tablet permission matrix (7 tablets)
- **js/app.js** — Main controller, Socket.IO connection
- **js/auth.js** — PIN auth + session management
- **js/router.js** — Hash-based SPA routing
- **js/pages/*.js** — 12 page controllers (home, main, chapel, social, gym, confroom, stream, source, security, health, occupancy, settings)
- **js/api/*.js** — API modules (obs, x32, moip, ptz, epson, health, macro, notifications)
- **css/styles.css** — Dark theme, touch-optimized, Material Design Icons

### Backend (`gateway/`)

The gateway has been modularized into 17 Python modules (~11,000 lines total):

**Core:**
- **gateway.py** — Entry point shim (29 lines), delegates to `gateway_app.py`
- **gateway_app.py** — Flask/SocketIO setup, GatewayContext, startup (~600 lines)
- **api_routes.py** — REST endpoint handlers (~3,500 lines)
- **socket_handlers.py** — SocketIO events, rooms, heartbeat (~230 lines)

**Device protocol modules:**
- **x32_module.py** — Direct X32 mixer OSC/UDP via xair-api (~880 lines)
- **moip_module.py** — Direct MoIP controller Telnet (~640 lines)
- **obs_module.py** — Direct OBS Studio WebSocket v5 (~430 lines)

**Built-in services:**
- **health_module.py** — 30+ health checks, 9 check types, alerts (~1,360 lines)
- **occupancy_module.py** — CSV analytics, daily download, pandas (~450 lines)
- **announcement_module.py** — TTS generation via edge-tts, WiiM playback (~490 lines)
- **event_automation.py** — Calendar-driven event automation (~590 lines)
- **user_module.py** — User account management with bcrypt (~180 lines)

**Infrastructure:**
- **auth.py** — IP allowlist, PIN auth, sessions, permissions (~540 lines)
- **macro_engine.py** — Macro parsing, execution, step types (~1,270 lines)
- **polling.py** — Background pollers, state cache, watchdog (~540 lines)
- **scheduler.py** — Cron-like schedule execution (~90 lines)
- **database.py** — SQLite audit log, schedule DB (~240 lines)

**Configuration:**
- **config.yaml** — Device IPs, polling intervals, health check definitions
- **macros.yaml** — Named action sequences (step types: `ha_check`, `ha_service`, `moip_switch`, `epson_power`, `delay`, `condition`)
- **announcements.yaml** — TTS announcement definitions
- **users.yaml** — User account database
- **.env** — Secrets (loaded via python-dotenv, see `.env.example`)
- **requirements.txt** — flask, flask-socketio, eventlet, requests, pyyaml, pandas, xair-api, websocket-client, bcrypt, edge-tts, pytest

**Tests:**
- **tests/** — 12 test files (~3,000 lines), run automatically by the pre-commit hook before each commit

### Archived Repos (rollback only)
- **STP_scripts/** — Middleware proxies (X32, MoIP, OBS) — absorbed in Phases 1-3
- **STP_healthdash/** — Health monitoring — absorbed in Phase 4
- **STP_Occupancy/** — Occupancy analytics — absorbed in Phase 6
- **STP_THRFiles_Current/** — The Home Remote — sunset in Phase 7

## Data Flow

1. **User** taps button on tablet (e.g., "Chapel TVs On")
2. **Frontend** sends REST request or Socket.IO event to gateway
3. **Gateway** executes macro steps from `macros.yaml` (HA checks → device commands → delays → notifications)
4. **Gateway modules** translate to native protocol (OSC, Telnet, WebSocket)
5. **Device** receives command
6. **Gateway** polls state, broadcasts updates via Socket.IO to all tablets
7. **Health module** (built-in) polls all services, fires alerts on failure

## Network

| Subnet | Purpose |
|--------|---------|
| 10.100.60.0/24 | Main LAN (server, tablets, most devices) |
| 10.100.0.0/16 | VPN / MoIP network |
| 10.100.20.11:23 | MoIP controller (Telnet) |
| 47.150.* | Church WAN (allowed) |

## Startup Order

```
1. gateway.py          (port 20858)  ← this repo (everything built-in)
```

> **Note:** All standalone services have been absorbed. `x32-flask.py` (port 3400), `moip-flask.py` (port 5002), `obs-flask.py` (port 4456), and `STP_healthdash/app.py` (port 20855) are no longer needed. The standalone scripts remain in their archived repos as rollback options.

## Deployment Target

- **Server:** Currently Windows PC; migrating to Mac Mini (see Consolidation Plan / Phase 8 below)
- **OBS + Camlytics:** Remain on existing Windows PC (GPU/display dependent)
- **Tablets:** iPads and Android tablets in kiosk mode on LAN
- See `docs/DEPLOYMENT.md` for full operations guide
- See `docs/MIGRATION_GUIDE_PC.md` and `docs/MIGRATION_GUIDE_MAC.md` for fresh-install setup

## Credentials (dev/test)

- Settings PIN: `1234` (in `.env` as `SETTINGS_PIN`)
- Auth: IP allowlist for trusted subnets, PIN for settings page only
- All secrets stored in `gateway/.env` (see `.env.example` for full list)

## Polling Intervals

| Service | Interval |
|---------|----------|
| X32 audio state | 5s |
| MoIP video state | 10s |
| OBS stream state | 3s |
| Projectors | 30s |
| WattBox PDUs | 300s (5 min) |
| Cameras | 600s (10 min) |
| Health checks | 15s |

## Tech Stack

- **Frontend:** Vanilla JS, Socket.IO client, Chart.js (CDN), Material Design Icons, CSS Grid
- **Backend:** Python 3, Flask, Flask-SocketIO, Eventlet, pandas
- **X32 Protocol:** xair-api (python-osc) for direct OSC/UDP communication
- **MoIP Protocol:** Raw TCP sockets for direct Telnet communication with Binary MoIP controller (migrated from telnetlib for Python 3.13 compatibility)
- **OBS Protocol:** websocket-client (sync) with manual OBS WebSocket v5 protocol handling
- **TTS:** edge-tts for text-to-speech generation, WiiM speakers for playback
- **User Auth:** bcrypt for password hashing, users.yaml for account storage
- **Database:** SQLite (audit log + schedules)
- **Monitoring:** Built-in health module (30+ checks), webhook alerts to Home Assistant
- **Testing:** pytest (~3,000 lines of tests), enforced by pre-commit hook
- **Secrets:** python-dotenv loading from `.env` file

## Conventions

- All Python services use rotating file logs (5 MB, 5 backups)
- Background polling threads + cached state + REST endpoints
- Two-stage health: cheap PING + heavy SNAPSHOT
- Config in YAML files for non-sensitive settings; secrets in `.env`
- Frontend uses hash-based routing (`#/page-name`)
- No build tools — vanilla HTML/CSS/JS served directly
- Pre-commit hook runs full test suite + auto-increments version (format: YY-NNN)
- Version tracked in `frontend/config/settings.json`

## What's Been Built

- Full tablet UI with 12 pages and per-tablet permissions
- Consolidated gateway with REST + WebSocket API for all device types (single process)
- Direct X32 mixer control via OSC/UDP (absorbed from middleware)
- Direct MoIP video matrix control via Telnet (absorbed from middleware)
- Direct OBS Studio control via WebSocket v5 (absorbed from middleware)
- Macro execution engine with scheduling support
- Scene engine for video routing presets
- Audit logging to SQLite
- Built-in health monitoring of 30+ services with alerting (absorbed from STP_healthdash)
- Occupancy analytics dashboard with Chart.js charts, KPI cards, pacing drill-down (absorbed from STP_Occupancy)
- Automated CSV download from Camlytics cloud (absorbed from STP_scripts scheduled tasks)
- PTZ camera control (10 cameras, server-side to avoid CORS)
- Epson projector control (4 projectors)
- Home Assistant integration (power, WattBox, EcoFlow batteries)
- TTS announcement system (edge-tts generation, WiiM speaker playback)
- Calendar-driven event automation (setup/teardown macros for church services)
- User account management with bcrypt password hashing
- Comprehensive test suite (12 files, ~3,000 lines) with pre-commit enforcement

---

## Consolidation Plan

**Goal:** Collapse all standalone services into a single gateway process, then migrate from Windows to Mac Mini. OBS Studio and Camlytics remain on the existing Windows machine.

### Phase Overview

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Absorb X32 middleware (`x32-flask.py`) into gateway | **Complete** |
| 2 | Absorb MoIP middleware (`moip-flask.py`) into gateway | **Complete** |
| 3 | Absorb OBS middleware (`obs-flask.py`) into gateway | **Complete** |
| 4 | Absorb HealthDash (`STP_healthdash/app.py`) into gateway as a module + frontend page | **Complete** |
| 5 | Centralize all secrets into `.env` — remove duplication from config.yaml and middleware | Not started |
| 6 | Absorb occupancy app (`STP_Occupancy/` repo) into gateway | **Complete** |
| 7 | Sunset The Home Remote (THR) — remove `STP_THRFiles_Current` dependency | **Complete** |
| 8 | Migrate consolidated gateway to Mac Mini | Not started |

### Key Decisions

- **Each phase is one session.** Absorb one service at a time, test, verify, commit before moving on.
- **Consolidation happens on Windows first.** Everything gets tested on the current machine before migrating.
- **OBS Studio + Camlytics stay on Windows.** They need GPU/display access. The OBS module auto-discovers whether OBS is local or remote at startup (see DR section below).
- **THR is being sunset.** The web frontend replaces it. No new THR development.
- **Windows PC kept as DR standby.** Both machines run identical code and config. Port forwarding at the router controls which machine tablets reach (see DR section below).
- **Target end state:** One Python process (gateway) serving everything — REST API, WebSocket hub, static frontend, health monitoring, all protocol translation (OSC, Telnet, OBS WebSocket), occupancy data.

### What Changes Per Phase

**Phase 1 (X32) — COMPLETE:** Moved OSC/UDP protocol logic from `x32-flask.py` into `gateway/x32_module.py`. The gateway now communicates directly with the X32 mixer at 10.100.60.231 using the `xair_api` library (python-osc). Port 3400 is no longer required. New capabilities: bus mute/volume (1-16) and DCA mute/volume (1-8) are now implemented (were missing from the old middleware). The standalone `x32-flask.py` remains in STP_scripts as a rollback option.

**Phase 2 (MoIP) — COMPLETE:** Moved Telnet protocol logic from `moip-flask.py` into `gateway/moip_module.py`. The gateway now communicates directly with the MoIP controller at 10.100.20.11:23 via persistent Telnet connection with internal/external IP fallback. Port 5002 is no longer required. Includes keepalive thread with exponential backoff and HA watchdog for automatic controller restart after prolonged failure. Credentials moved to `.env` (MOIP_USERNAME, MOIP_PASSWORD). The standalone `moip-flask.py` remains in STP_scripts as a rollback option.

**Phase 3 (OBS) — COMPLETE:** Moved OBS WebSocket client logic from `obs-flask.py` into `gateway/obs_module.py`. The gateway now connects directly to OBS Studio at ws://127.0.0.1:4455 using `websocket-client` (sync) with manual OBS WebSocket v5 protocol handling. Port 4456 is no longer required. Uses synchronous WebSocket to avoid eventlet/asyncio cross-thread conflicts. Includes background poller with PING/SNAPSHOT two-stage health checks and fail-streak gating. The standalone `obs-flask.py` remains in STP_scripts as a rollback option.

**Phase 4 (HealthDash) — COMPLETE:** Moved all health monitoring logic from `STP_healthdash/app.py` into `gateway/health_module.py`. The gateway now runs 30+ health checks internally with 9 check types (http, http_json, tcp, process, process_and_tcp, obs_rpc, ffprobe_rtsp, composite, heartbeat_group). Port 20855 is no longer required. All service definitions merged into `gateway/config.yaml` under `healthdash:` section. Added `#health` page to frontend with severity summary tiles, service cards, composite member expansion, log viewer, and recovery actions. Tablet heartbeat forwarding is now in-process (no HTTP hop). HA credentials inherited from gateway's HA_URL/HA_TOKEN env vars. The standalone `STP_healthdash/app.py` remains as a rollback option.

**Phase 5 (Secrets):** Make `.env` the single source of truth for all secrets. `config.yaml` keeps only non-sensitive config (IPs, polling intervals, device names). Remove all hardcoded keys/passwords from config files.

**Phase 6 (Occupancy) — COMPLETE:** Moved CSV-based occupancy analytics from `STP_Occupancy/app.py` into `gateway/occupancy_module.py`. The gateway now scans Camlytics CSV exports (BuildingOccupancy/ and CommunionCounts/ sub-folders), parses weekly trends, communion counts, occupancy pacing, and participation ratios using pandas. CSV downloads from Camlytics cloud (previously handled by Windows Scheduled Task scripts in `STP_scripts/`) are now run by the module's internal daily scheduler. Added `#occupancy` page to frontend with Chart.js charts (occupancy trend, communion trend, comparison bar chart, pacing drill-down), KPI summary cards, week-over-week table, and buffer configuration display. Page is accessed via "View Weekly Analytics" button in the people counting panel (no nav bar button). Port 20857 is no longer required. New dependency: `pandas>=2.0`. The standalone `STP_Occupancy/app.py` remains as a rollback option.

**Phase 7 (THR Sunset) — COMPLETE:** The Home Remote (THR) app has been fully sunset. The web-based tablet frontend replaces all THR functionality. `STP_THRFiles_Current` and `STP_scripts` repos archived with deprecation READMEs documenting what was absorbed and rollback procedures. No `obs_rpc` (THR bridge) health checks were active in the gateway config. THR-referencing comments in `macros.yaml` retained as design-decision documentation (explaining retry patterns). The Chrome crash recovery and network adapter fix scripts in `STP_scripts` remain useful as standalone Windows Scheduled Tasks.

**Phase 8 (Mac Migration):** Clone repo to Mac Mini, create venv, copy `.env` (identical to Windows — no edits needed), configure launchd, test. The OBS module auto-discovers local vs. remote OBS at startup, so both machines share the same config. The git pre-commit hook (runs gateway tests before each commit) is tracked at `hooks/pre-commit` — copy it to `.git/hooks/pre-commit` after cloning (see `MIGRATION_GUIDE_MAC.md`).

### Post-Consolidation Architecture

```
Tablets ──► Router port forward :20858 ──► MAC MINI (primary) or WINDOWS PC (DR)

MAC MINI (.60.TBD) — primary           WINDOWS PC (.60.185) — DR standby
─────────────────────────               ──────────────────────────────────
STP Gateway :20858                      STP Gateway :20858 (cold standby)
 ├─ REST API + Socket.IO                OBS Studio :4455
 ├─ Static frontend                     Camlytics (analytics)
 ├─ X32 module ──── OSC/UDP ──────►  Behringer X32 (.60.231)
 ├─ MoIP module ─── Telnet ──────►   Binary MoIP (10.100.20.11)
 ├─ OBS module ──── WebSocket ───►   OBS Studio (.60.185:4455)  ← auto-discovered
 ├─ PTZ module ──── HTTP/CGI ────►   10 cameras (.60.201-.210)
 ├─ Epson module ── HTTP ────────►   4 projectors (.60.233-.236)
 ├─ HA module ───── REST ────────►   Home Assistant (.60.245)
 ├─ Health monitor (built-in)
 ├─ Occupancy module (Camlytics Cloud API)
 ├─ Macro engine
 └─ Audit log (SQLite)
```

### Disaster Recovery (DR)

The Windows PC serves as a cold standby for the gateway. Both machines run identical code and configuration — no per-machine config differences.

**Why it works with zero config differences:**
- All device IPs (X32, MoIP, cameras, projectors, HA) are on the LAN, reachable from either machine
- The OBS module auto-discovers OBS at startup: probes `ws_url_local` (localhost:4455) first, falls back to `ws_url_remote` (.60.185:4455). On the Windows PC, local probe succeeds (OBS runs there); on the Mac Mini, it fails and uses the remote address. One-time check, ~1 second.
- `.env` and `config.yaml` are identical on both machines
- SQLite audit log is local and non-critical (recent logs lost on failover, not functionality)

**Tablet routing via port forwarding:**
- Tablets connect to a single URL/port (e.g., `http://stp-gateway:20858/`) — they never reference a specific server IP
- The router has **two port forwarding rules** for port 20858:
  - Rule 1: Forward to Mac Mini IP → **Enabled** (normal operation)
  - Rule 2: Forward to Windows PC IP (.60.185) → **Disabled** (DR standby)
- Failover: disable Rule 1, enable Rule 2. No tablet changes needed.

**Keeping the standby ready:**
1. Keep the repo cloned and up to date (`git pull` periodically or via scheduled task)
2. Keep the Python venv intact with dependencies installed
3. `.env` is already identical — no edits needed

**Failover procedure:**
1. On the router: disable Mac Mini port forward, enable Windows PC port forward
2. On the Windows PC: `cd STP_tablets/gateway && .venv\Scripts\activate && python gateway.py`
3. Tablets reconnect automatically (Socket.IO has built-in retry with exponential backoff)

### Post-Consolidation Repos

After consolidation, only **one repo** is actively maintained:

| Repo | Status |
|------|--------|
| `STP_tablets` | **Active** — contains everything (gateway + frontend) |
| `STP_scripts` | **Archived** — middleware absorbed into gateway |
| `STP_healthdash` | **Archived** — monitoring absorbed into gateway |
| `STP_occupancy` | **Archived** — occupancy absorbed into gateway |
| `STP_THRFiles_Current` | **Archived** — THR sunset |

---

## Migration Guides

Two comprehensive migration guides exist for setting up the system on a fresh machine:

- **`docs/MIGRATION_GUIDE_PC.md`** — Windows PC setup (NSSM services, PowerShell firewall, .bat scripts)
- **`docs/MIGRATION_GUIDE_MAC.md`** — macOS setup (launchd plists, Homebrew, shell scripts)

> **Note:** These guides reflect the **consolidated** single-gateway architecture. Only one Python process from one repo (`STP_tablets`) needs to be deployed. OBS Studio and Camlytics remain on the Windows PC.
