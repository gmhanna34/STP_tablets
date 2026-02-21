# STP Church AV Control System

## What This Is

A church AV control system that provides tablet-based control of audio, video, streaming, cameras, projectors, and power. This repo (`STP_tablets`) contains the gateway backend and the frontend tablet UI. The middleware proxies remain in `STP_scripts` and the health dashboard in `STP_healthdash`.

## Repository Structure

```
STP_tablets/              → Gateway + Frontend (this repo)
├── gateway/              → Flask backend (REST API + WebSocket hub)
│   ├── gateway.py
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

STP_scripts/              → Middleware proxies (separate repo)
├── x32-flask.py
├── moip-flask.py
└── obs-flask.py

STP_healthdash/           → Monitoring dashboard (separate repo)
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
└──────────┬───────────────┘
           │
     ┌─────┼─────┬──────────┬───────────┐
     ▼     ▼     ▼          ▼           ▼
  ┌──────┐ ┌──────┐ ┌──────┐ ┌───────┐ ┌───────┐
  │ X32  │ │ MoIP │ │ OBS  │ │  PTZ  │ │ Epson │
  │:3400 │ │:5002 │ │:4456 │ │direct │ │direct │
  └──┬───┘ └──┬───┘ └──┬───┘ └───┬───┘ └───┬───┘
     │        │        │         │          │
  OSC/UDP   Telnet  WebSocket  HTTP/CGI   HTTP/CGI
     ▼        ▼        ▼         ▼          ▼
  Behringer  Binary   OBS      10 PTZ     4 Epson
  X32 Mixer  MoIP     Studio   Cameras    Projectors
  .1.231     Matrix   :4455
             10.100.
             20.11:23

  Home Assistant @ 192.168.1.245:8123 (power, WattBox, EcoFlow)

┌──────────────────────────────┐
│   HealthDash (:20855)        │  Monitors everything above
│   STP_healthdash/app.py      │
├──────────────────────────────┤
│ • 30+ service health checks  │
│ • Alert webhooks to HA       │
│ • Recovery action triggers   │
│ • Server-Sent Events for UI  │
└──────────────────────────────┘
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
- **js/pages/*.js** — 10 page controllers (home, main, chapel, social, gym, confroom, stream, source, security, settings)
- **js/api/*.js** — API modules (obs, x32, moip, wattbox, ptz, epson, health, macro)
- **css/styles.css** — Dark theme, touch-optimized, Material Design Icons

### Backend (`gateway/`)
- **gateway.py** — Central gateway (~1,800 lines), Flask + SocketIO
- **config.yaml** — All secrets, device IPs, middleware URLs, polling intervals
- **macros.yaml** — 20+ named action sequences with step types: `ha_check`, `ha_service`, `moip_switch`, `epson_power`, `delay`, `condition`
- **requirements.txt** — flask, flask-socketio, eventlet, requests, pyyaml

### Middleware (`STP_scripts/` — separate repo)
- **x32-flask.py** — Audio mixer proxy (HTTP → OSC/UDP), port 3400
- **moip-flask.py** — Video matrix proxy (HTTP → Telnet), port 5002
- **obs-flask.py** — Streaming proxy (HTTP → OBS WebSocket), port 4456
- Each has: background polling, ping/snapshot health, IP allowlist, API key auth, rotating logs

### Health Dashboard (`STP_healthdash/` — separate repo)
- **app.py** — Flask monitoring app (~1,400 lines)
- **config.yaml** — 30+ service definitions, alert thresholds, polling intervals
- **templates/dashboard.html** — Real-time status tiles
- **static/app.js** — SSE-based live updates

## Data Flow

1. **User** taps button on tablet (e.g., "Chapel TVs On")
2. **Frontend** sends REST request or Socket.IO event to gateway
3. **Gateway** executes macro steps from `macros.yaml` (HA checks → device commands → delays → notifications)
4. **Middleware** translates HTTP to native protocol (OSC, Telnet, WebSocket)
5. **Device** receives command
6. **Gateway** polls state, broadcasts updates via Socket.IO to all tablets
7. **HealthDash** independently polls all services, fires alerts on failure

## Network

| Subnet | Purpose |
|--------|---------|
| 192.168.1.0/24 | Main LAN (server, tablets, most devices) |
| 10.100.0.0/16 | VPN / MoIP network |
| 10.100.20.11:23 | MoIP controller (Telnet) |
| 47.150.* | Church WAN (allowed) |

## Startup Order

```
1. x32-flask.py        (port 3400)   — STP_scripts repo
2. moip-flask.py       (port 5002)   — STP_scripts repo
3. obs-flask.py        (port 4456)   — STP_scripts repo
4. gateway.py          (port 8080)   ← this repo (depends on 1-3)
5. healthdash app.py   (port 20855)  — STP_healthdash repo
```

## Deployment Target

- **Server:** Mac Mini (macOS), all services run locally
- **Tablets:** iPads in kiosk mode on LAN
- See `DEPLOYMENT.md` for full setup instructions

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

## Tech Stack

- **Frontend:** Vanilla JS, Socket.IO client, Material Design Icons, CSS Grid
- **Backend:** Python 3, Flask, Flask-SocketIO, Eventlet
- **Middleware:** Flask + Waitress (each a standalone .py file, in STP_scripts)
- **Database:** SQLite (audit log only)
- **Monitoring:** Flask + SSE, webhook alerts to Home Assistant

## Conventions

- All Python services use rotating file logs (5 MB, 5 backups)
- Middleware pattern: background polling thread + cached state + REST endpoints
- Two-stage health: cheap PING + heavy SNAPSHOT
- Config in YAML files (not env vars)
- Frontend uses hash-based routing (`#/page-name`)
- No build tools — vanilla HTML/CSS/JS served directly

## What's Been Built

- Full tablet UI with 10 pages and per-tablet permissions
- Gateway with REST + WebSocket API for all device types
- Three middleware proxies (X32 audio, MoIP video, OBS streaming)
- Macro execution engine with scheduling support
- Scene engine for video routing presets
- Audit logging to SQLite
- Health dashboard monitoring 30+ services with alerting
- PTZ camera control (10 cameras, server-side to avoid CORS)
- Epson projector control (4 projectors)
- Home Assistant integration (power, WattBox, EcoFlow batteries)
