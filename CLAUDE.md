# STP Church AV Control System

## What This Is

A church AV control system that provides tablet-based control of audio, video, streaming, cameras, projectors, and power. This repo (`STP_tablets`) contains the gateway backend (including built-in health monitoring) and the frontend tablet UI. The middleware proxies remain in `STP_scripts` as rollback options.

## Repository Structure

```
STP_tablets/              → Gateway + Frontend (this repo)
├── gateway/              → Flask backend (REST API + WebSocket hub)
│   ├── gateway.py
│   ├── x32_module.py    ← Phase 1: direct X32 mixer OSC/UDP
│   ├── moip_module.py   ← Phase 2: direct MoIP controller Telnet
│   ├── obs_module.py    ← Phase 3: direct OBS Studio WebSocket
│   ├── health_module.py ← Phase 4: built-in health monitoring
│   ├── occupancy_module.py ← Phase 6: occupancy analytics (CSV + download)
│   ├── config.yaml
│   ├── macros.yaml
│   └── requirements.txt
├── frontend/             → Tablet UI (served as static files by gateway)
│   ├── index.html
│   ├── css/
│   ├── js/
│   ├── config/
│   └── assets/
├── CLAUDE.md
└── DEPLOYMENT.md

STP_scripts/              → Middleware proxies (archived, rollback only)
├── x32-flask.py
├── moip-flask.py
└── obs-flask.py

STP_healthdash/           → Monitoring dashboard (archived, absorbed in Phase 4)

STP_Occupancy/            → Occupancy dashboard (archived, absorbed in Phase 6)
```

## Architecture

```
Tablets/Browsers (kiosk mode, 192.168.1.0/24)
       │
       ▼
┌──────────────────────────┐
│   STP Gateway (:8080)    │  Flask + Flask-SocketIO
│   gateway/gateway.py     │
├──────────────────────────┤
│ • REST API for all devices│
│ • Socket.IO state sync   │
│ • Macro execution engine │
│ • Audit logging (SQLite) │
│ • Auth (IP allowlist+PIN)│
│ • Health monitoring      │
│ • Occupancy analytics    │
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
  .1.231     Matrix   :4455
             10.100.
             20.11:23

  Home Assistant @ 192.168.1.245:8123 (power, WattBox, EcoFlow)

  Health Module (built-in) — 30+ service checks, alerts, recovery
  Occupancy Module (built-in) — CSV analytics, daily download, Chart.js dashboard
```

## Key Files

### Frontend (`frontend/`)
- **index.html** — Single-page app entry point
- **config/settings.json** — Endpoints, version, timeouts
- **config/devices.json** — MoIP transmitters (28), receivers (28), video scenes
- **config/permissions.json** — Per-tablet permission matrix (7 tablets)
- **js/app.js** — Main controller, Socket.IO connection
- **js/auth.js** — PIN auth + session management
- **js/router.js** — Hash-based SPA routing
- **js/pages/*.js** — 12 page controllers (home, main, chapel, social, gym, confroom, stream, source, security, health, occupancy, settings)
- **js/api/*.js** — API modules (obs, x32, moip, wattbox, ptz, epson, health, macro)
- **css/styles.css** — Dark theme, touch-optimized, Material Design Icons

### Backend (`gateway/`)
- **gateway.py** — Central gateway (~1,800 lines), Flask + SocketIO
- **config.yaml** — All secrets, device IPs, middleware URLs, polling intervals
- **macros.yaml** — 20+ named action sequences with step types: `ha_check`, `ha_service`, `moip_switch`, `epson_power`, `delay`, `condition`
- **occupancy_module.py** — Occupancy analytics (CSV parsing, daily download, pandas)
- **requirements.txt** — flask, flask-socketio, eventlet, requests, pyyaml, pandas

### Middleware (`STP_scripts/` — separate repo)
- **x32-flask.py** — ~~Audio mixer proxy (HTTP → OSC/UDP), port 3400~~ **DEPRECATED** — absorbed into `gateway/x32_module.py` (Phase 1)
- **moip-flask.py** — ~~Video matrix proxy (HTTP → Telnet), port 5002~~ **DEPRECATED** — absorbed into `gateway/moip_module.py` (Phase 2)
- **obs-flask.py** — ~~Streaming proxy (HTTP → OBS WebSocket), port 4456~~ **DEPRECATED** — absorbed into `gateway/obs_module.py` (Phase 3)
- Each has: background polling, ping/snapshot health, IP allowlist, API key auth, rotating logs

### Health Dashboard (`STP_healthdash/` — archived, absorbed in Phase 4)
- ~~**app.py** — Flask monitoring app (~1,400 lines)~~ **DEPRECATED** — absorbed into `gateway/health_module.py` (Phase 4)
- ~~**config.yaml** — 30+ service definitions~~ **DEPRECATED** — merged into `gateway/config.yaml` under `healthdash:` section
- The standalone `STP_healthdash/app.py` remains as a rollback option

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
| 192.168.1.0/24 | Main LAN (server, tablets, most devices) |
| 10.100.0.0/16 | VPN / MoIP network |
| 10.100.20.11:23 | MoIP controller (Telnet) |
| 47.150.* | Church WAN (allowed) |

## Startup Order

```
1. gateway.py          (port 20858)  ← this repo (X32 + MoIP + OBS + Health built-in)
```

> **Note:** `x32-flask.py` (port 3400), `moip-flask.py` (port 5002), `obs-flask.py` (port 4456), and `STP_healthdash/app.py` (port 20855) are no longer needed — the gateway handles everything directly. The standalone scripts are kept as rollback options.

## Deployment Target

- **Server:** Currently Windows PC; migrating to Mac Mini after consolidation (see Consolidation Plan below)
- **OBS + Camlytics:** Remain on existing Windows PC (GPU/display dependent)
- **Tablets:** iPads and Android tablets in kiosk mode on LAN
- See `DEPLOYMENT.md` for full operations guide
- See `MIGRATION_GUIDE_PC.md` and `MIGRATION_GUIDE_MAC.md` for fresh-install setup (pre-consolidation)

## Credentials (dev/test)

- Settings PIN: `1234` (in gateway config.yaml)
- HealthDash password: `Companion4Us`
- API keys: hardcoded in config files per middleware
- Auth: IP allowlist for trusted subnets, PIN for settings page only

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
- **Middleware:** All middleware absorbed into gateway (X32 Phase 1, MoIP Phase 2, OBS Phase 3)
- **X32 Protocol:** xair-api (python-osc) for direct OSC/UDP communication
- **MoIP Protocol:** Raw TCP sockets for direct Telnet communication with Binary MoIP controller (migrated from telnetlib for Python 3.13 compatibility)
- **Database:** SQLite (audit log only)
- **Monitoring:** Built-in health module (30+ checks), webhook alerts to Home Assistant

## Conventions

- All Python services use rotating file logs (5 MB, 5 backups)
- Middleware pattern: background polling thread + cached state + REST endpoints
- Two-stage health: cheap PING + heavy SNAPSHOT
- Config in YAML files (not env vars)
- Frontend uses hash-based routing (`#/page-name`)
- No build tools — vanilla HTML/CSS/JS served directly

## What's Been Built

- Full tablet UI with 12 pages and per-tablet permissions
- Gateway with REST + WebSocket API for all device types
- Three middleware proxies (X32 audio, MoIP video, OBS streaming)
- Macro execution engine with scheduling support
- Scene engine for video routing presets
- Audit logging to SQLite
- Built-in health monitoring of 30+ services with alerting (absorbed from STP_healthdash)
- Occupancy analytics dashboard with Chart.js charts, KPI cards, pacing drill-down (absorbed from STP_Occupancy)
- Automated CSV download from Camlytics cloud (absorbed from STP_scripts scheduled tasks)
- PTZ camera control (10 cameras, server-side to avoid CORS)
- Epson projector control (4 projectors)
- Home Assistant integration (power, WattBox, EcoFlow batteries)

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
| 7 | Sunset The Home Remote (THR) — remove `STP_THRFiles_Current` dependency | Not started |
| 8 | Migrate consolidated gateway to Mac Mini | Not started |

### Key Decisions

- **Each phase is one session.** Absorb one service at a time, test, verify, commit before moving on.
- **Consolidation happens on Windows first.** Everything gets tested on the current machine before migrating.
- **OBS Studio + Camlytics stay on Windows.** They need GPU/display access. The gateway's OBS proxy will point to the Windows machine's IP instead of localhost after migration.
- **THR is being sunset.** The web frontend replaces it. No new THR development.
- **Target end state:** One Python process (gateway) serving everything — REST API, WebSocket hub, static frontend, health monitoring, all protocol translation (OSC, Telnet, OBS WebSocket), occupancy data.

### What Changes Per Phase

**Phase 1 (X32) — COMPLETE:** Moved OSC/UDP protocol logic from `x32-flask.py` into `gateway/x32_module.py`. The gateway now communicates directly with the X32 mixer at 192.168.1.231 using the `xair_api` library (python-osc). Port 3400 is no longer required. New capabilities: bus mute/volume (1-16) and DCA mute/volume (1-8) are now implemented (were missing from the old middleware). The standalone `x32-flask.py` remains in STP_scripts as a rollback option.

**Phase 2 (MoIP) — COMPLETE:** Moved Telnet protocol logic from `moip-flask.py` into `gateway/moip_module.py`. The gateway now communicates directly with the MoIP controller at 10.100.20.11:23 via persistent Telnet connection with internal/external IP fallback. Port 5002 is no longer required. Includes keepalive thread with exponential backoff and HA watchdog for automatic controller restart after prolonged failure. Credentials moved to `.env` (MOIP_USERNAME, MOIP_PASSWORD). The standalone `moip-flask.py` remains in STP_scripts as a rollback option.

**Phase 3 (OBS) — COMPLETE:** Moved OBS WebSocket client logic from `obs-flask.py` into `gateway/obs_module.py`. The gateway now connects directly to OBS Studio at ws://127.0.0.1:4455 using `websocket-client` (sync) with manual OBS WebSocket v5 protocol handling. Port 4456 is no longer required. Uses synchronous WebSocket to avoid eventlet/asyncio cross-thread conflicts. Includes background poller with PING/SNAPSHOT two-stage health checks and fail-streak gating. The standalone `obs-flask.py` remains in STP_scripts as a rollback option.

**Phase 4 (HealthDash) — COMPLETE:** Moved all health monitoring logic from `STP_healthdash/app.py` into `gateway/health_module.py`. The gateway now runs 30+ health checks internally with 9 check types (http, http_json, tcp, process, process_and_tcp, obs_rpc, ffprobe_rtsp, composite, heartbeat_group). Port 20855 is no longer required. All service definitions merged into `gateway/config.yaml` under `healthdash:` section. Added `#health` page to frontend with severity summary tiles, service cards, composite member expansion, log viewer, and recovery actions. Tablet heartbeat forwarding is now in-process (no HTTP hop). HA credentials inherited from gateway's HA_URL/HA_TOKEN env vars. The standalone `STP_healthdash/app.py` remains as a rollback option.

**Phase 5 (Secrets):** Make `.env` the single source of truth for all secrets. `config.yaml` keeps only non-sensitive config (IPs, polling intervals, device names). Remove all hardcoded keys/passwords from config files.

**Phase 6 (Occupancy) — COMPLETE:** Moved CSV-based occupancy analytics from `STP_Occupancy/app.py` into `gateway/occupancy_module.py`. The gateway now scans Camlytics CSV exports (BuildingOccupancy/ and CommunionCounts/ sub-folders), parses weekly trends, communion counts, occupancy pacing, and participation ratios using pandas. CSV downloads from Camlytics cloud (previously handled by Windows Scheduled Task scripts in `STP_scripts/`) are now run by the module's internal daily scheduler. Added `#occupancy` page to frontend with Chart.js charts (occupancy trend, communion trend, comparison bar chart, pacing drill-down), KPI summary cards, week-over-week table, and buffer configuration display. Page is accessed via "View Weekly Analytics" button in the people counting panel (no nav bar button). Port 20857 is no longer required. New dependency: `pandas>=2.0`. The standalone `STP_Occupancy/app.py` remains as a rollback option.

**Phase 7 (THR Sunset):** Remove THR dependency from operational workflow. Archive `STP_THRFiles_Current`. Remove THR-specific HealthDash checks.

**Phase 8 (Mac Migration):** Clone repo to Mac Mini, create venv, copy `.env`, update OBS WebSocket URL to point to Windows machine, configure launchd, test.

### Post-Consolidation Architecture

```
MAC MINI (new)                         WINDOWS PC (existing)
─────────────────────────              ─────────────────────
STP Gateway :20858                     OBS Studio :4455
 ├─ REST API + Socket.IO               Camlytics (analytics)
 ├─ Static frontend
 ├─ X32 module ──── OSC/UDP ──────►  Behringer X32 (.1.231)
 ├─ MoIP module ─── Telnet ──────►   Binary MoIP (10.100.20.11)
 ├─ OBS module ──── WebSocket ───►   OBS Studio (Windows IP:4455)
 ├─ PTZ module ──── HTTP/CGI ────►   10 cameras (.1.201-.210)
 ├─ Epson module ── HTTP ────────►   4 projectors (.1.233-.236)
 ├─ HA module ───── REST ────────►   Home Assistant (.1.245)
 ├─ Health monitor (built-in)
 ├─ Occupancy module (Camlytics Cloud API)
 ├─ Macro engine
 └─ Audit log (SQLite)
```

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

- **`MIGRATION_GUIDE_PC.md`** — Windows PC setup (NSSM services, PowerShell firewall, .bat scripts)
- **`MIGRATION_GUIDE_MAC.md`** — macOS setup (launchd plists, Homebrew, shell scripts)

> **Note:** These guides reflect the **current** multi-service architecture (5 separate Python processes across 3 repos). They will need to be updated after the consolidation plan above is complete, at which point the setup simplifies to a single Python process from a single repo.
