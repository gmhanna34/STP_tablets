# St. Paul AV Control System -- Deployment & Operations Guide

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Repository Structure](#4-repository-structure)
5. [Installation](#5-installation)
6. [Configuration Reference](#6-configuration-reference)
7. [Service Startup](#7-service-startup)
8. [API Reference](#8-api-reference)
9. [Network & IP Address Map](#9-network--ip-address-map)
10. [Frontend Pages & Permissions](#10-frontend-pages--permissions)
11. [Health Monitoring (HealthDash)](#11-health-monitoring-healthdash)
12. [Production Deployment](#12-production-deployment)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. System Overview

A unified AV control platform for **St. Paul American Coptic Orthodox Church** that manages:

- **Audio** -- Behringer X32 mixer (32 channels + 8 aux buses)
- **Video** -- Binary MoIP matrix (28 TX / 28 RX)
- **Streaming** -- OBS WebSocket (stream + record)
- **Cameras** -- 10 PTZ cameras (pan/tilt/zoom/presets)
- **Projectors** -- 4 Epson projectors (power on/off)
- **Power** -- 7 WattBox PDUs, 8 EcoFlow batteries
- **Automation** -- Home Assistant integration
- **Monitoring** -- HealthDash service dashboard

The system runs as a **single consolidated gateway** from one repository (`STP_tablets`).

---

## 2. Architecture

```
Tablets / Browsers ──► STP Gateway (:20858)
                          │
              ┌───────────┼───────────┬──────────┬───────────┐
              ▼           ▼           ▼          ▼           ▼
         X32 Module  MoIP Module  OBS Module  PTZ Direct  Epson Direct
         (built-in)  (built-in)   (built-in)
              │           │           │          │           │
              ▼           ▼           ▼          ▼           ▼
         X32 Mixer   MoIP Ctrl   OBS Studio  10 Cameras  4 Projectors
        .60.231     10.100.20.11   :4455     .60.201-210 .60.233-236

Gateway also talks directly to:
  • Home Assistant (10.100.60.245:8123) — power, WattBox, EcoFlow
  • Camlytics Cloud API — occupancy analytics
  • WiiM speakers — TTS announcements

Built-in services:
  • Health monitoring (30+ checks, alerts, recovery)
  • Occupancy analytics (CSV parsing, Chart.js dashboard)
  • TTS announcements (edge-tts generation, WiiM playback)
  • Event automation (calendar-driven setup/teardown macros)
  • User management (bcrypt auth, roles)
```

### Component Responsibilities

| Component | Location | Port | Role |
|-----------|----------|------|------|
| **STP Gateway** | `STP_tablets/gateway/` | 20858 | Unified API + static file server + WebSocket hub + all protocol modules |
| **Frontend** | `STP_tablets/frontend/` | (served by gateway) | Tablet web UI |

> **Note:** All middleware (X32, MoIP, OBS) and HealthDash have been absorbed into the gateway. The standalone scripts in `STP_scripts/` and `STP_healthdash/` are archived as rollback options only.

---

## 3. Prerequisites

### Software

| Requirement | Version | Notes |
|-------------|---------|-------|
| Python | 3.11+ | Tested with 3.11 and 3.13 |
| pip | latest | For package installation |
| Git | 2.x+ | Repository management |
| OBS Studio | 30+ | With WebSocket Server enabled (on same or remote machine) |
| ffprobe | latest | Only needed for RTSP camera health checks |

### Hardware (on-network)

| Device | IP | Protocol |
|--------|-----|----------|
| Behringer X32 Mixer | 10.100.60.231 | OSC / UDP |
| Binary MoIP Controller | 10.100.20.11 | Telnet (:23) |
| 10 PTZ Cameras | 10.100.60.201-210 | HTTP CGI |
| 4 Epson Projectors | 10.100.60.233-236 | HTTP API |
| 7 WattBox PDUs | 10.100.60.61-67 | HTTP + Basic Auth |
| Home Assistant | 10.100.60.245:8123 | REST API |
| Insteon Hub | 10.100.60.193:25105 | HTTP |

### Network

- Server must be on the `10.100.60.x` subnet
- Firewall must allow inbound TCP on port: **20858** (gateway)
- Outbound access to cameras, projectors, mixer, MoIP controller
- Optional: outbound HTTPS to Home Assistant Cloud URL and Camlytics Cloud

---

## 4. Repository Structure

### STP_tablets (Gateway + Frontend -- this repo)

```
STP_tablets/
├── gateway/
│   ├── gateway.py                  # Entry point shim (→ gateway_app.py)
│   ├── gateway_app.py              # Flask/SocketIO setup, startup (~600 lines)
│   ├── api_routes.py               # REST endpoint handlers (~3,500 lines)
│   ├── auth.py                     # IP allowlist, PIN, sessions, permissions
│   ├── macro_engine.py             # Macro parsing, execution (~1,270 lines)
│   ├── polling.py                  # Background pollers, state cache, watchdog
│   ├── scheduler.py                # Cron-like schedule execution
│   ├── database.py                 # SQLite audit log, schedule DB
│   ├── socket_handlers.py          # SocketIO events, rooms, heartbeat
│   ├── x32_module.py               # Direct X32 mixer OSC/UDP
│   ├── moip_module.py              # Direct MoIP controller Telnet
│   ├── obs_module.py               # Direct OBS Studio WebSocket
│   ├── health_module.py            # Built-in health monitoring (~1,360 lines)
│   ├── occupancy_module.py         # Occupancy analytics (CSV + pandas)
│   ├── announcement_module.py      # TTS announcements (edge-tts + WiiM)
│   ├── event_automation.py         # Calendar-driven event automation
│   ├── user_module.py              # User account management (bcrypt)
│   ├── config.yaml                 # Device IPs, polling intervals, health checks
│   ├── macros.yaml                 # Named action sequences (20+ macros)
│   ├── announcements.yaml          # TTS announcement definitions
│   ├── users.yaml                  # User account database
│   ├── .env                        # Secrets (not committed, see .env.example)
│   ├── .env.example                # Template for secrets
│   ├── requirements.txt            # All Python dependencies
│   ├── tests/                      # 12 test files (~3,000 lines)
│   └── logs/
│       └── stp-gateway.log
├── frontend/
│   ├── index.html                  # SPA entry point
│   ├── config/
│   │   ├── devices.json           # Hardware definitions, scenes, IR codes
│   │   ├── permissions.json       # Per-tablet page access matrix
│   │   └── settings.json         # App metadata, version (YY-NNN format)
│   ├── css/
│   │   └── styles.css             # Dark tablet theme + responsive
│   ├── js/
│   │   ├── app.js                 # App controller, Socket.IO, toast, confirm
│   │   ├── auth.js                # PIN auth, permission checks
│   │   ├── router.js              # SPA page routing
│   │   ├── api/                   # API service modules
│   │   │   ├── obs.js            # OBS streaming API
│   │   │   ├── x32.js            # X32 audio API
│   │   │   ├── moip.js           # MoIP video API
│   │   │   ├── ptz.js            # PTZ camera API
│   │   │   ├── epson.js          # Epson projector API
│   │   │   ├── health.js         # Health polling API
│   │   │   ├── macro.js          # Macro button API
│   │   │   └── notifications.js  # Notification system
│   │   └── pages/                 # Page view controllers
│   │       ├── home.js           # Dashboard landing page
│   │       ├── main.js           # Main church controls
│   │       ├── chapel.js         # Chapel controls
│   │       ├── social.js         # Social hall controls
│   │       ├── gym.js            # Gym controls
│   │       ├── confroom.js       # Conference room controls
│   │       ├── stream.js         # Live stream + camera controls
│   │       ├── source.js         # Video source matrix
│   │       ├── security.js       # Security cameras
│   │       ├── health.js         # Health monitoring dashboard
│   │       ├── occupancy.js      # Occupancy analytics
│   │       └── settings.js       # Admin settings + audit log
│   └── assets/images/              # UI graphics
│       └── church-seal.svg        # Church logo
├── hooks/
│   └── pre-commit                  # Runs tests + auto-increments version
├── CLAUDE.md
└── DEPLOYMENT.md
```

> **Note:** The `STP_scripts/`, `STP_healthdash/`, and `STP_Occupancy/` repos are archived. All functionality has been absorbed into the gateway. They remain available as rollback options only.

---

## 5. Installation

### 5.1 Clone Repository

```bash
cd /path/to/projects
git clone <STP_tablets_url>
```

The gateway serves the frontend from a sibling directory (`../frontend`). Verify this layout:

```
STP_tablets/
├── gateway/
└── frontend/
```

### 5.2 Create Virtual Environment & Install Dependencies

```bash
cd STP_tablets/gateway
python -m venv .venv
source .venv/bin/activate    # Linux/macOS
# .venv\Scripts\activate     # Windows
pip install -r requirements.txt
```

This installs:
- `flask==3.0.3`
- `flask-socketio==5.4.1`
- `python-socketio>=5.11,<6`
- `python-engineio>=4.9,<5`
- `eventlet==0.37.0`
- `requests==2.32.3`
- `pyyaml==6.0.2`
- `python-dotenv==1.0.1`
- `xair-api>=2.4.0` (X32 mixer OSC/UDP)
- `websocket-client>=1.6.0` (OBS WebSocket)
- `pandas>=2.0` (occupancy analytics)
- `bcrypt>=4.0` (user authentication)
- `edge-tts>=7.0` (TTS announcements)
- `pytest>=8.0` / `pytest-cov>=5.0` (testing)

### 5.3 Configure Secrets

```bash
cd STP_tablets/gateway
cp .env.example .env
# Edit .env with your actual credentials
```

See `.env.example` for the full list of required secrets (HA token, WattBox password, OBS password, MoIP credentials, etc.).

### 5.4 Install Pre-commit Hook

```bash
cp hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

The hook runs the full test suite and auto-increments the version in `frontend/config/settings.json` before each commit.

---

## 6. Configuration Reference

### 6.1 Gateway Configuration (`gateway/config.yaml`)

`config.yaml` contains **non-sensitive** configuration only. All secrets are in `.env`.

```yaml
gateway:
  host: "0.0.0.0"             # Bind address (0.0.0.0 = all interfaces)
  port: 20858                  # HTTP + WebSocket port
  debug: false                 # Flask debug mode (never true in prod)
  static_dir: "../frontend"   # Path to frontend (relative to gateway/)

# middleware: null             # Middleware section removed (all absorbed)

ptz_cameras:
  MainChurch_Rear:   { ip: "10.100.60.201", name: "Cam1921681201" }
  MainChurch_Altar:  { ip: "10.100.60.202", name: "Cam1921681202" }
  MainChurch_Right:  { ip: "10.100.60.203", name: "Cam1921681203" }
  MainChurch_Left:   { ip: "10.100.60.204", name: "Cam1921681204" }
  Chapel_Rear:       { ip: "10.100.60.205", name: "Cam1921681205" }
  Chapel_Side:       { ip: "10.100.60.206", name: "Cam1921681206" }
  BaptismRoom:       { ip: "10.100.60.207", name: "Cam1921681207" }
  SocialHall_Rear:   { ip: "10.100.60.208", name: "Cam1921681208" }
  SocialHall_Side:   { ip: "10.100.60.209", name: "Cam1921681209" }
  Gym:               { ip: "10.100.60.210", name: "Cam1921681210" }

projectors:
  epson1: { ip: "10.100.60.233", name: "PRJ_FrontLeft" }
  epson2: { ip: "10.100.60.234", name: "PRJ_FrontRight" }
  epson3: { ip: "10.100.60.236", name: "PRJ_RearLeft" }
  epson4: { ip: "10.100.60.235", name: "PRJ_RearRight" }

home_assistant:
  # URL and token loaded from .env (HA_URL, HA_TOKEN)
  timeout: 10

security:
  allowed_ips:                 # IP prefixes that skip auth
    - "10.100.60."
    - "10.100."
    - "10.10."
    - "172.16."
    - "127.0.0.1"
    - "47.150."
  # settings_pin loaded from .env (SETTINGS_PIN)

polling:                       # Background state poll intervals (seconds)
  moip: 10
  x32: 5
  obs: 3
  projectors: 30

database:
  path: "stp_gateway.db"      # SQLite audit log + schedules

logging:
  path: "logs/stp-gateway.log"
  level: "INFO"                # DEBUG, INFO, WARNING, ERROR
  max_bytes: 5242880           # 5 MB per log file
  backup_count: 5              # Keep 5 rotated log files

# healthdash:                  # Health check service definitions (30+ services)
# x32:                         # X32 mixer connection settings
# moip:                        # MoIP controller connection settings
# obs:                         # OBS WebSocket connection settings
```

### 6.2 Secrets (`.env`)

All secrets are stored in `gateway/.env` (loaded by python-dotenv). See `.env.example` for the template:

```
HA_URL=                        # Home Assistant URL
HA_TOKEN=                      # Home Assistant long-lived access token
WATTBOX_USERNAME=              # WattBox PDU credentials
WATTBOX_PASSWORD=
OBS_WS_PASSWORD=               # OBS WebSocket password (if set)
MOIP_USERNAME=                 # MoIP controller credentials
MOIP_PASSWORD=
MOIP_HA_WEBHOOK_ID=            # HA webhook for MoIP watchdog
FULLY_KIOSK_PASSWORD=          # Fully Kiosk Browser admin password
FLASK_SECRET_KEY=              # Flask session secret
SETTINGS_PIN=                  # PIN for settings page access
SECURE_PIN=                    # PIN for secure operations
REMOTE_AUTH_USER=              # Remote auth credentials
REMOTE_AUTH_PASS=
HEALTHDASH_WEBHOOK_URL=        # Alert webhook URL
ANTHROPIC_API_KEY=             # AI chatbot (optional)
```

### 6.3 Frontend Configuration

**`frontend/config/settings.json`** -- App metadata, version (auto-incremented YY-NNN format by pre-commit hook)

**`frontend/config/devices.json`** -- Hardware definitions:
- MoIP transmitters (28) and receivers (28)
- Pre-defined video routing scenes
- IR codes for display power control

**`frontend/config/permissions.json`** -- Per-tablet page visibility matrix:
- Tablet IDs: `Tablet_Mainchurch`, `Tablet_Chapel`, `Tablet_SocialHall`, etc.
- Each tablet gets a boolean map of which pages (home, main, chapel, ...) it can access

### 6.4 Health Monitoring Configuration

Health check definitions are in `gateway/config.yaml` under the `healthdash:` section. Key sub-sections:

- **`services`** -- List of ~30+ monitored services with check types (http, http_json, tcp, process, obs_rpc, ffprobe_rtsp, composite, heartbeat_group)
- **`alerts`** -- Webhook URL + default thresholds
- Health monitoring is built into the gateway -- no separate service needed

---

## 7. Service Startup

### 7.1 Starting the Gateway

Only one service needs to be started -- the consolidated gateway handles everything:

```bash
cd /path/to/STP_tablets/gateway
source .venv/bin/activate
python gateway.py
```

Gateway CLI options:
```
--config PATH    Config file path (default: config.yaml)
--mock           Run without connecting to real devices
--host HOST      Override bind address
--port PORT      Override listen port
```

### 7.2 Verifying the Gateway Is Running

```bash
# Gateway health check
curl http://127.0.0.1:20858/api/health
# Expected: {"healthy": true, "version": "...", "mock_mode": false}
```

### 7.3 Accessing the Frontend

Open a browser or tablet to:
```
http://<server-ip>:20858/
```

The gateway serves the `frontend/` directory as static files and provides
the Socket.IO client library at `/socket.io/socket.io.js`.

---

## 8. API Reference

### 8.1 Gateway API Endpoints

All endpoints are relative to `http://<server>:20858`.

#### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Gateway health + version |
| GET | `/api/config` | Merged safe config for browser |

#### Authentication

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/verify-pin` | `{"pin": "1234"}` | Verify settings PIN |

#### Video (MoIP)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/api/moip/receivers` | -- | List all receiver states |
| POST | `/api/moip/switch` | `{"tx": 1, "rx": 2}` | Switch video source |
| POST | `/api/moip/scene` | `{"scene": "MainChurch_LeftPodium"}` | Apply scene mapping |
| POST | `/api/moip/ir` | `{"rx": 1, "code": "pwr_on"}` | Send IR command |
| POST | `/api/moip/osd` | `{"rx": 1, "text": "Hello"}` | Display OSD text |

#### Audio (X32)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/x32/status` | Full mixer state |
| POST | `/api/x32/scene/<num>` | Load scene by number |
| POST | `/api/x32/mute/<ch>/<on\|off>` | Mute/unmute channel |
| POST | `/api/x32/aux/<ch>/mute/<on\|off>` | Mute/unmute aux bus |
| POST | `/api/x32/volume/<ch>/<up\|down>` | Adjust channel volume |

#### Streaming (OBS)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/obs/status` | Stream/record status + scenes |
| POST | `/api/obs/call/<type>` | OBS RPC call (e.g., GetSceneList) |
| POST | `/api/obs/emit/<type>` | OBS action (e.g., StartStream) |

#### Cameras (PTZ)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/ptz/<camera>/command` | `{"action": "left"}` | Pan/tilt/zoom |
| POST | `/api/ptz/<camera>/preset/<num>` | -- | Recall preset |

Camera keys: `MainChurch_Rear`, `MainChurch_Altar`, `MainChurch_Right`,
`MainChurch_Left`, `Chapel_Rear`, `Chapel_Side`, `BaptismRoom`,
`SocialHall_Rear`, `SocialHall_Side`, `Gym`

PTZ actions: `up`, `down`, `left`, `right`, `ptzstop`, `zoomin`, `zoomout`, `zoomstop`, `home`

#### Projectors (Epson)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/api/projector/status` | -- | All projector states |
| POST | `/api/projector/<key>/power` | `{"state": "on"}` | Single projector |
| POST | `/api/projector/all/power` | `{"state": "off"}` | All projectors |

Projector keys: `epson1`, `epson2`, `epson3`, `epson4`

#### Home Assistant

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/ha/states/<entity_id>` | Get entity state |
| POST | `/api/ha/service/<domain>/<service>` | Call HA service |

#### Scene Engine

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/api/scene/list` | -- | List available scenes |
| POST | `/api/scene/execute` | `{"scene": "MainChurch_LeftPodium"}` | Execute with retry |

Scene execution is server-side with retry logic and real-time Socket.IO progress events.

#### Audit Log

| Method | Endpoint | Query Params | Description |
|--------|----------|--------------|-------------|
| GET | `/api/audit/logs` | `?limit=50&offset=0` | Audit log entries |
| GET | `/api/audit/sessions` | -- | Active tablet sessions |

### 8.2 Socket.IO Events

The gateway runs Flask-SocketIO on the same port (20858).

#### Client -> Server

| Event | Payload | Description |
|-------|---------|-------------|
| `join` | `{"room": "moip"}` | Subscribe to state updates |
| `leave` | `{"room": "moip"}` | Unsubscribe |
| `heartbeat` | `{"tablet": "...", "displayName": "...", "currentPage": "..."}` | Keep-alive |

Rooms: `moip`, `x32`, `obs`, `projectors`, `ha`

#### Server -> Client

| Event | Payload | Description |
|-------|---------|-------------|
| `state:x32` | X32 state object | Audio mixer state changed |
| `state:moip` | MoIP state object | Video matrix state changed |
| `state:obs` | OBS state object | Streaming state changed |
| `state:projectors` | Projector states | Projector status changed |
| `scene:progress` | `{label, status, steps_completed, steps_total, error}` | Scene execution progress |
| `notification` | `{message}` | Cross-tablet notification |

#### Auto-Reconnect Behavior

The frontend Socket.IO client is configured with:
- Initial delay: 1 second
- Max delay: 30 seconds (exponential backoff)
- Unlimited retry attempts
- Status bar shows reconnection count
- Toast notification on successful reconnect

---

## 9. Network & IP Address Map

### Device IP Assignments

```
AUDIO
  10.100.60.231    Behringer X32 Mixer

VIDEO MATRIX
  10.100.20.11     Binary MoIP Controller (Telnet :23)

PTZ CAMERAS
  10.100.60.201    MainChurch Rear
  10.100.60.202    MainChurch Altar
  10.100.60.203    MainChurch Right
  10.100.60.204    MainChurch Left
  10.100.60.205    Chapel Rear
  10.100.60.206    Chapel Side
  10.100.60.207    Baptism Room
  10.100.60.208    Social Hall Rear
  10.100.60.209    Social Hall Side
  10.100.60.210    Gym

EPSON PROJECTORS
  10.100.60.233    Front Left  (epson1)
  10.100.60.234    Front Right (epson2)
  10.100.60.236    Rear Left   (epson3)
  10.100.60.235    Rear Right  (epson4)

WATTBOX PDUs
  10.100.60.61     WattBox 1 (Audio Wall)
  10.100.60.62     WattBox 2 (Video Wall)
  10.100.60.63     WattBox 3 (Floor Rack 1)
  10.100.60.64     WattBox 4
  10.100.60.65     WattBox 5
  10.100.60.66     WattBox 6
  10.100.60.67     WattBox 7

AUTOMATION
  10.100.60.245    Home Assistant
  10.100.60.193    Insteon Hub

CAMERAS (RTSP via Camlytics)
  10.100.40.100    UniFi NVR (RTSPS streams)
```

### Port Map (localhost services)

```
 4455   OBS WebSocket (OBS Studio native — may be on remote Windows PC)
 8123   Home Assistant (if local)
20858   STP Gateway (HTTP + Socket.IO + all built-in modules)
```

> **Note:** Ports 3400 (X32 middleware), 4456 (OBS middleware), 5002 (MoIP middleware), and 20855 (HealthDash) are no longer used. All functionality is built into the gateway on port 20858.

### Trusted IP Prefixes

These prefixes bypass authentication:
```
10.100.60.*    Local network
10.100.*       VPN / internal
10.10.*        Guest / secondary
172.16.*       Docker / reserved
127.0.0.1      Localhost
47.150.*       Church WAN
```

---

## 10. Frontend Pages & Permissions

### Available Pages

| Page | URL Hash | Description |
|------|----------|-------------|
| Home | `#home` | Dashboard with system overview |
| Main Church | `#main` | Video, audio, A/C, source controls for main sanctuary |
| Chapel | `#chapel` | Chapel-specific AV controls |
| Social Hall | `#social` | Social hall AV controls |
| Gym | `#gym` | Gym AV controls |
| Conference Room | `#confroom` | Conference room controls |
| Stream | `#stream` | OBS scenes, stream/record, PTZ camera controls |
| Source | `#source` | Full video source routing matrix |
| Security | `#security` | Security camera feeds |
| Health | `#health` | Service health monitoring dashboard |
| Occupancy | `#occupancy` | Occupancy analytics (Chart.js charts, KPI cards) |
| Settings | `#settings` | Admin settings, audit log (PIN protected) |

### Tablet Permission Matrix

Defined in `frontend/config/permissions.json`:

| Tablet | home | main | chapel | social | gym | confroom | stream | source | security | settings |
|--------|------|------|--------|--------|-----|----------|--------|--------|----------|----------|
| Mainchurch | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Chapel | Y | - | Y | - | - | - | Y | Y | - | Y |
| SocialHall | Y | - | - | Y | - | - | Y | Y | - | Y |
| Gym | Y | - | - | - | Y | - | - | Y | - | Y |
| ConferenceRoom | Y | - | - | - | - | Y | - | Y | - | Y |
| Lobby | Y | - | - | - | - | - | - | Y | - | - |
| Office | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |

### Tablet Identification

Each tablet sets its identity via `localStorage`:
```javascript
localStorage.setItem('tabletId', 'Tablet_Mainchurch');
```

This determines:
- Which nav items are visible
- Which API actions are permitted
- How the tablet appears in HealthDash monitoring

### Destructive Operation Confirmations

The following actions require a confirmation dialog before executing:

- **Video System OFF** -- Turns off all projectors + screens
- **All Projectors OFF** -- Powers down all 4 Epson projectors
- **Audio System OFF** -- Cuts power to audio rack via WattBox
- **Stop Live Stream** -- Ends broadcast for all viewers

---

## 11. Health Monitoring (Built-in)

Health monitoring is built into the gateway (absorbed from the standalone HealthDash app in Phase 4). Access it at `#health` in the frontend.

### Monitored Services

| Service | Type | Check Method | Interval |
|---------|------|-------------|----------|
| Home Assistant | `http` | GET /api/ with bearer token | 10s |
| Insteon | `http` | GET / (accept 200 or 401) | 10s |
| WattBox PDUs (7) | `composite` | HTTP to each PDU with basic auth | 300s |
| EcoFlow Batteries (8) | `composite` | HA entity state checks | 60s |
| Cameras (4 RTSP) | `composite` | ffprobe RTSP stream validation | 600s |
| Camlytics Cloud | `http` | HTTPS to cloud.camlytics.com | 600s |
| Projectors (4) | `composite` | HTTP to each projector | 60s |
| Control Tablets (6) | `heartbeat_group` | WebSocket heartbeat tracking | 30s |

9 check types supported: `http`, `http_json`, `tcp`, `process`, `process_and_tcp`, `obs_rpc`, `ffprobe_rtsp`, `composite`, `heartbeat_group`.

### Health Levels

| Level | Color | Meaning |
|-------|-------|---------|
| Healthy | Green | Service online and responding normally |
| Warning | Yellow | Slow response or partial failure |
| Down | Red | Offline or completely failed |

### Alert System

When a service transitions to Warning or Down:
1. The health module fires a webhook to Home Assistant
2. HA can trigger automations (notifications, recovery scripts)
3. Cooldown prevents alert storms

### Accessing Health Dashboard

Navigate to `#health` in the tablet UI, or use the API:
```bash
curl http://<server-ip>:20858/api/health/summary
```

---

## 12. Production Deployment

### 12.1 Systemd Service (Linux)

Only one service file is needed:

**`/etc/systemd/system/stp-gateway.service`**
```ini
[Unit]
Description=STP Gateway (Consolidated AV Control)
After=network.target

[Service]
Type=simple
User=stpaul
WorkingDirectory=/path/to/STP_tablets/gateway
ExecStart=/path/to/STP_tablets/gateway/.venv/bin/python3 gateway.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable stp-gateway
sudo systemctl start stp-gateway
```

### 12.2 Windows Deployment

On Windows, use Task Scheduler or NSSM (Non-Sucking Service Manager) to run
`gateway.py` as a Windows service. See `MIGRATION_GUIDE_PC.md` for details.

### 12.3 Log Rotation

Logs are automatically rotated by the gateway:
- 5 MB per file, 5 backups (`gateway/logs/stp-gateway.log`)

### 12.4 Database Maintenance

The gateway uses SQLite for audit logging and schedules (`gateway/stp_gateway.db`). Over time
this file will grow. Periodically archive or truncate old entries:

```sql
-- Keep only last 30 days
DELETE FROM audit_log WHERE timestamp < datetime('now', '-30 days');
VACUUM;
```

### 12.5 Security Checklist

- [ ] Set `SETTINGS_PIN` in `.env` (change from default `1234`)
- [ ] Set `FLASK_SECRET_KEY` in `.env` to a random string
- [ ] Set `REMOTE_AUTH_USER` and `REMOTE_AUTH_PASS` in `.env`
- [ ] Review `allowed_ips` prefixes in `config.yaml` match your actual network
- [ ] Ensure Home Assistant token has appropriate scopes
- [ ] Ensure `.env` file is NOT committed to git (check `.gitignore`)
- [ ] Run the gateway behind a reverse proxy (nginx) with TLS for external access
- [ ] WattBox default credentials (`admin/WBAdmin1`) should be changed on devices

---

## 13. Troubleshooting

### Gateway won't start

```bash
# Check if config file exists and is valid YAML
cd STP_tablets/gateway
python -c "import yaml; yaml.safe_load(open('config.yaml'))"

# Run in mock mode to test without devices
python gateway.py --mock

# Check logs
tail -f logs/stp-gateway.log
```

### Tablets can't connect

1. Verify the tablet is on a trusted IP prefix
2. Test gateway reachability: `curl http://<gateway-ip>:20858/api/health`
3. Check browser console (F12) for Socket.IO connection errors
4. Verify `localStorage.tabletId` is set correctly

### No real-time updates

1. Confirm Socket.IO is loading: check browser Network tab for `/socket.io/` requests
2. Check gateway logs for polling errors
3. The status bar shows connection state: "Connected", "Reconnecting (N)...", or "Disconnected"

### OBS not connecting

1. Verify OBS Studio is running with WebSocket Server enabled
2. Check OBS settings: Tools > WebSocket Server Settings
3. Default OBS WebSocket port is 4455
4. If password-protected, set `OBS_WS_PASSWORD` in the gateway's `.env` file

### Home Assistant integration failing

1. Verify the long-lived access token hasn't expired
2. Test manually: `curl -H "Authorization: Bearer <token>" http://10.100.60.245:8123/api/`
3. If using Cloud URL, verify internet connectivity
4. Check HA logs for webhook delivery issues

### Health dashboard shows services as down

1. The health module checks services independently -- a service showing "down"
   means the gateway couldn't reach it directly
2. Verify the service URLs/IPs in `config.yaml` under `healthdash:` section
3. Some services (WattBox, cameras) have long poll intervals (300-600s) --
   wait for the next check cycle
4. For RTSP cameras: ensure `ffprobe` is installed and the path is correct

### Scene execution fails

1. Check gateway logs for MoIP proxy errors
2. Verify scene definitions in `frontend/config/devices.json`
3. Scene execution sends real-time progress via Socket.IO -- check browser console
4. The scene engine retries failed switches up to 3 times

---

## Quick Reference Card

```
GATEWAY:       http://<server>:20858/
HEALTH PAGE:   http://<server>:20858/#health
SETTINGS PIN:  (set in .env)

START:         cd STP_tablets/gateway && source .venv/bin/activate && python gateway.py
MOCK MODE:     cd STP_tablets/gateway && source .venv/bin/activate && python gateway.py --mock

LOGS:
  Gateway:     STP_tablets/gateway/logs/stp-gateway.log

CONFIG FILES:
  Gateway:     STP_tablets/gateway/config.yaml
  Secrets:     STP_tablets/gateway/.env
  Macros:      STP_tablets/gateway/macros.yaml
  Frontend:    STP_tablets/frontend/config/{settings,devices,permissions}.json

TESTS:         cd STP_tablets/gateway && pytest tests/
```
