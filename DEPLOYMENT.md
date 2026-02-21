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

The system runs across **three repositories** and **five services**.

---

## 2. Architecture

```
                        +-----------------+
   Tablets / Browsers   |   HealthDash    |
          |             |   :20855        |
          v             +--------+--------+
   +------+------+              |
   | STP Gateway  |<- - polls - +
   |   :8080      |
   +--+---+---+---+
      |   |   |
      v   v   v
   +--++ ++-+ +--+
   |X32| |Mo| |OB|
   |:34| |IP| |S |
   |00 | |:5| |:4|
   +---+ |00| |45|
         |2 | |6 |
         +--+ +--+

   X32 Middleware  ------>  Behringer X32 Mixer (192.168.1.231)
   MoIP Middleware ------>  Binary MoIP Controller (10.100.20.11:23)
   OBS Middleware  ------>  OBS WebSocket (127.0.0.1:4455)
   STP Gateway     ------>  PTZ Cameras (192.168.1.201-210)
   STP Gateway     ------>  Epson Projectors (192.168.1.111-114)
   STP Gateway     ------>  Home Assistant (192.168.1.245:8123)
```

### Component Responsibilities

| Component | Repo | Port | Role |
|-----------|------|------|------|
| **STP Gateway** | `STP_tablets/gateway/` | 8080 | Unified API + static file server + WebSocket hub |
| **X32 Middleware** | `STP_scripts/x32-flask.py` | 3400 | Audio mixer proxy (OSC over UDP) |
| **MoIP Middleware** | `STP_scripts/moip-flask.py` | 5002 | Video matrix proxy (Telnet) |
| **OBS Middleware** | `STP_scripts/obs-flask.py` | 4456 | Streaming proxy (WebSocket) |
| **HealthDash** | `STP_healthdash/` | 20855 | System health monitoring dashboard |
| **Frontend** | `STP_tablets/frontend/` | (served by gateway) | Tablet web UI |

---

## 3. Prerequisites

### Software

| Requirement | Version | Notes |
|-------------|---------|-------|
| Python | 3.9+ | Tested with 3.11 |
| pip | latest | For package installation |
| Git | 2.x+ | Repository management |
| OBS Studio | 30+ | With WebSocket Server enabled (Settings > WebSocket Server) |
| ffprobe | latest | Only needed if HealthDash monitors RTSP camera streams |

### Hardware (on-network)

| Device | IP | Protocol |
|--------|-----|----------|
| Behringer X32 Mixer | 192.168.1.231 | OSC / UDP |
| Binary MoIP Controller | 10.100.20.11 | Telnet (:23) |
| 10 PTZ Cameras | 192.168.1.201-210 | HTTP CGI |
| 4 Epson Projectors | 192.168.1.111-114 | HTTP API |
| 7 WattBox PDUs | 192.168.1.61-67 | HTTP + Basic Auth |
| Home Assistant | 192.168.1.245:8123 | REST API |
| Insteon Hub | 192.168.1.193:25105 | HTTP |

### Network

- Server must be on the `192.168.1.x` subnet
- Firewall must allow inbound TCP on ports: **8080** (gateway), **20855** (healthdash)
- Outbound access to cameras, projectors, mixer, MoIP controller
- Optional: outbound HTTPS to Home Assistant Cloud URL

---

## 4. Repository Structure

### STP_tablets (Gateway + Frontend -- this repo)

```
STP_tablets/
├── gateway/
│   ├── gateway.py                  # Main gateway application (~1,800 lines)
│   ├── config.yaml                 # All configuration (IPs, keys, polling)
│   ├── macros.yaml                 # Named action sequences (20+ macros)
│   ├── requirements.txt            # Gateway-specific dependencies
│   └── logs/
│       └── stp-gateway.log
├── frontend/
│   ├── index.html                  # SPA entry point
│   ├── config/
│   │   ├── devices.json           # Hardware definitions, scenes, IR codes
│   │   ├── permissions.json       # Per-tablet page access matrix
│   │   └── settings.json         # App settings, endpoint URLs
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
│   │   │   ├── wattbox.js        # WattBox power API
│   │   │   ├── ptz.js            # PTZ camera API
│   │   │   ├── epson.js          # Epson projector API
│   │   │   ├── health.js         # Health polling API
│   │   │   └── macro.js          # Macro button API
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
│   │       └── settings.js       # Admin settings + audit log
│   └── assets/images/              # UI graphics
│       └── church-seal.svg        # Church logo
├── CLAUDE.md
└── DEPLOYMENT.md
```

### STP_scripts (Middleware -- separate repo)

```
STP_scripts/
├── moip-flask.py                   # MoIP video matrix middleware
├── x32-flask.py                    # X32 audio mixer middleware
├── obs-flask.py                    # OBS streaming middleware
└── requirements.txt                # Middleware dependencies
```

### STP_healthdash (Monitoring -- separate repo)

```
STP_healthdash/
├── app.py                          # Health monitoring app (~1,400 lines)
├── config.yaml                     # Service definitions + alert config
├── requirements.txt                # Dependencies
├── logs/
│   └── healthdash.log
├── static/
│   ├── app.js                     # Dashboard frontend JS
│   ├── styles.css                 # Dashboard styling
│   └── logo.png
└── templates/
    ├── base.html
    ├── dashboard.html
    └── login.html
```

---

## 5. Installation

### 5.1 Clone Repositories

```bash
# All repos should be siblings in the same parent directory
cd /path/to/projects

git clone <STP_tablets_url>
git clone <STP_scripts_url>
git clone <STP_healthdash_url>
```

The gateway serves the frontend from a sibling directory (`../frontend`). Verify this layout:

```
projects/
├── STP_tablets/           # gateway + frontend (this repo)
│   ├── gateway/
│   └── frontend/
├── STP_scripts/           # middleware proxies
└── STP_healthdash/        # monitoring dashboard
```

### 5.2 Install Middleware Dependencies

```bash
cd STP_scripts
pip install -r requirements.txt
```

This installs:
- `flask==3.0.3`
- `waitress==2.1.2`

### 5.3 Install Gateway Dependencies

```bash
cd STP_tablets/gateway
pip install -r requirements.txt
```

This installs:
- `flask==3.0.3`
- `flask-socketio==5.4.1`
- `eventlet==0.37.0`
- `requests==2.32.3`
- `pyyaml==6.0.2`

### 5.4 Install HealthDash Dependencies

```bash
cd STP_healthdash
pip install -r requirements.txt
```

This installs:
- `Flask==3.0.0`
- `requests==2.31.0`
- `PyYAML==6.0.1`
- `psutil==5.9.8`
- `waitress==2.1.2`

### 5.5 (Recommended) Use Virtual Environments

```bash
# For each service, create an isolated venv
cd STP_tablets/gateway
python -m venv .venv
source .venv/bin/activate    # Linux/macOS
# .venv\Scripts\activate     # Windows
pip install -r requirements.txt
```

---

## 6. Configuration Reference

### 6.1 Gateway Configuration (`gateway/config.yaml`)

```yaml
gateway:
  host: "0.0.0.0"             # Bind address (0.0.0.0 = all interfaces)
  port: 8080                   # HTTP + WebSocket port
  debug: false                 # Flask debug mode (never true in prod)
  static_dir: "../frontend"   # Path to frontend (relative to gateway/)

middleware:
  moip:
    url: "http://127.0.0.1:5002"
    api_key: "moip-key-234lkj234lkj2345;lkj234@53"
    timeout: 5                 # seconds
  x32:
    url: "http://127.0.0.1:3400"
    api_key: "x32-key-your-secret-key-here"
    timeout: 5
  obs:
    url: "http://127.0.0.1:4456"
    api_key: ""                # Empty = no auth
    timeout: 10

ptz_cameras:
  MainChurch_Rear:   { ip: "192.168.1.201", name: "Cam1921681201" }
  MainChurch_Altar:  { ip: "192.168.1.202", name: "Cam1921681202" }
  MainChurch_Right:  { ip: "192.168.1.203", name: "Cam1921681203" }
  MainChurch_Left:   { ip: "192.168.1.204", name: "Cam1921681204" }
  Chapel_Rear:       { ip: "192.168.1.205", name: "Cam1921681205" }
  Chapel_Side:       { ip: "192.168.1.206", name: "Cam1921681206" }
  BaptismRoom:       { ip: "192.168.1.207", name: "Cam1921681207" }
  SocialHall_Rear:   { ip: "192.168.1.208", name: "Cam1921681208" }
  SocialHall_Side:   { ip: "192.168.1.209", name: "Cam1921681209" }
  Gym:               { ip: "192.168.1.210", name: "Cam1921681210" }

projectors:
  epson1: { ip: "192.168.1.111", name: "PRJ_FrontLeft" }
  epson2: { ip: "192.168.1.112", name: "PRJ_FrontRight" }
  epson3: { ip: "192.168.1.113", name: "PRJ_RearLeft" }
  epson4: { ip: "192.168.1.114", name: "PRJ_RearRight" }

home_assistant:
  url: "https://your-ha-instance.ui.nabu.casa"
  token: "your-long-lived-access-token"
  timeout: 10

security:
  allowed_ips:                 # IP prefixes that skip auth
    - "192.168.1."
    - "10.100."
    - "10.10."
    - "172.16."
    - "127.0.0.1"
    - "47.150."
  settings_pin: "1234"        # PIN for settings page access

polling:                       # Background state poll intervals (seconds)
  moip: 10
  x32: 5
  obs: 3
  projectors: 30

database:
  path: "stp_gateway.db"      # SQLite audit log

logging:
  path: "logs/stp-gateway.log"
  level: "INFO"                # DEBUG, INFO, WARNING, ERROR
  max_bytes: 5242880           # 5 MB per log file
  backup_count: 5              # Keep 5 rotated log files
```

### 6.2 Middleware Configuration

The middleware scripts (`x32-flask.py`, `moip-flask.py`, `obs-flask.py`) use hardcoded
configuration or environment variables. Key values:

**X32 Middleware** (`x32-flask.py`):
```
X32_MIXER_IP=192.168.1.231     # Behringer X32 IP address
X32_PORT=3400                  # Flask listen port
X32_API_KEY=x32-key-...        # Must match gateway config
X32_PING_SECONDS=2.0           # Mixer heartbeat interval
X32_SNAPSHOT_SECONDS=6.0       # Full state capture interval
```

**MoIP Middleware** (`moip-flask.py`):
```
Hardcoded in file:
  MOIP_HOST = 10.100.20.11    # Binary MoIP controller
  MOIP_PORT = 23              # Telnet port
  API_KEY = moip-key-...      # Must match gateway config
  Flask port = 5002
```

**OBS Middleware** (`obs-flask.py`):
```
OBS_WS_URL=ws://127.0.0.1:4455   # OBS WebSocket URL
OBS_PORT=4456                     # Flask listen port
OBS_PING_SECONDS=3.0
OBS_SNAPSHOT_SECONDS=6.0
```

### 6.3 Frontend Configuration

**`frontend/config/settings.json`** -- App metadata, endpoint URLs, polling intervals

**`frontend/config/devices.json`** -- Hardware definitions:
- MoIP transmitters (28) and receivers (28)
- Pre-defined video routing scenes
- IR codes for display power control

**`frontend/config/permissions.json`** -- Per-tablet page visibility matrix:
- Tablet IDs: `Tablet_Mainchurch`, `Tablet_Chapel`, `Tablet_SocialHall`, etc.
- Each tablet gets a boolean map of which pages (home, main, chapel, ...) it can access

### 6.4 HealthDash Configuration (`STP_healthdash/config.yaml`)

See the full file in the repo. Key sections:

- **`app`** -- Port 20855, refresh interval, timeouts
- **`security`** -- Trusted IP prefixes, login password
- **`home_assistant`** -- URL + token for recovery actions
- **`alerts`** -- Webhook URL + default thresholds
- **`services`** -- List of ~30+ monitored services grouped by type

---

## 7. Service Startup

### 7.1 Required Startup Order

Services must start in this order because the gateway depends on the middleware:

```
Step 1:  X32 Middleware     (port 3400)
Step 2:  MoIP Middleware    (port 5002)
Step 3:  OBS Middleware     (port 4456)
Step 4:  STP Gateway        (port 8080)  -- depends on steps 1-3
Step 5:  HealthDash          (port 20855) -- monitors all above
```

### 7.2 Starting Each Service

**Terminal 1 -- X32 Middleware:**
```bash
cd /path/to/STP_scripts
python x32-flask.py
```

**Terminal 2 -- MoIP Middleware:**
```bash
cd /path/to/STP_scripts
python moip-flask.py
```

**Terminal 3 -- OBS Middleware:**
```bash
cd /path/to/STP_scripts
python obs-flask.py
```

**Terminal 4 -- STP Gateway:**
```bash
cd /path/to/STP_tablets/gateway
python gateway.py
```

Gateway CLI options:
```
--config PATH    Config file path (default: config.yaml)
--mock           Run without connecting to real devices
--host HOST      Override bind address
--port PORT      Override listen port
```

**Terminal 5 -- HealthDash:**
```bash
cd /path/to/STP_healthdash
python app.py
```

### 7.3 Verifying Services Are Running

```bash
# Gateway health check
curl http://127.0.0.1:8080/api/health
# Expected: {"healthy": true, "version": "...", "mock_mode": false}

# X32 middleware
curl http://127.0.0.1:3400/health
# Expected: {"healthy": true, "cur_scene": ..., "cur_scene_name": "..."}

# MoIP middleware
curl http://127.0.0.1:5002/status
# Expected: {"healthy": true, ...}

# OBS middleware
curl http://127.0.0.1:4456/health
# Expected: JSON with OBS status

# HealthDash
curl http://127.0.0.1:20855/api/summary
# Expected: {"down": 0, "warning": 0, "healthy": N}
```

### 7.4 Accessing the Frontend

Open a browser or tablet to:
```
http://<server-ip>:8080/
```

The gateway serves the `frontend/` directory as static files and provides
the Socket.IO client library at `/socket.io/socket.io.js`.

---

## 8. API Reference

### 8.1 Gateway API Endpoints

All endpoints are relative to `http://<server>:8080`.

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

The gateway runs Flask-SocketIO on the same port (8080).

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
  192.168.1.231    Behringer X32 Mixer

VIDEO MATRIX
  10.100.20.11     Binary MoIP Controller (Telnet :23)

PTZ CAMERAS
  192.168.1.201    MainChurch Rear
  192.168.1.202    MainChurch Altar
  192.168.1.203    MainChurch Right
  192.168.1.204    MainChurch Left
  192.168.1.205    Chapel Rear
  192.168.1.206    Chapel Side
  192.168.1.207    Baptism Room
  192.168.1.208    Social Hall Rear
  192.168.1.209    Social Hall Side
  192.168.1.210    Gym

EPSON PROJECTORS
  192.168.1.111    Front Left  (epson1)
  192.168.1.112    Front Right (epson2)
  192.168.1.113    Rear Left   (epson3)
  192.168.1.114    Rear Right  (epson4)

WATTBOX PDUs
  192.168.1.61     WattBox 1 (Audio Wall)
  192.168.1.62     WattBox 2 (Video Wall)
  192.168.1.63     WattBox 3 (Floor Rack 1)
  192.168.1.64     WattBox 4
  192.168.1.65     WattBox 5
  192.168.1.66     WattBox 6
  192.168.1.67     WattBox 7

AUTOMATION
  192.168.1.245    Home Assistant
  192.168.1.193    Insteon Hub

CAMERAS (RTSP via Camlytics)
  10.100.40.100    UniFi NVR (RTSPS streams)
```

### Port Map (localhost services)

```
 3400   X32 Flask Middleware
 4455   OBS WebSocket (OBS Studio native)
 4456   OBS Flask Middleware
 5002   MoIP Flask Middleware
 8080   STP Gateway (HTTP + Socket.IO)
 8123   Home Assistant (if local)
20855   HealthDash Monitor
```

### Trusted IP Prefixes

These prefixes bypass authentication:
```
192.168.1.*    Local network
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

## 11. Health Monitoring (HealthDash)

### Monitored Services

| Service | Type | Check Method | Interval |
|---------|------|-------------|----------|
| X32 Middleware | `http_json` | GET /health, check `healthy: true` | 120s |
| MoIP Middleware | `http_json` | GET /status, check `healthy: true` | 10s |
| OBS Middleware | `obs_rpc` | OBS RPC health check | 10s |
| STP Gateway | `http_json` | GET /api/health, check `healthy: true` | 10s |
| Home Assistant | `http` | GET /api/ with bearer token | 10s |
| Insteon | `http` | GET / (accept 200 or 401) | 10s |
| WattBox PDUs (7) | `composite` | HTTP to each PDU with basic auth | 300s |
| EcoFlow Batteries (8) | `composite` | HA entity state checks | 60s |
| Cameras (4 RTSP) | `composite` | ffprobe RTSP stream validation | 600s |
| Camlytics Cloud | `http` | HTTPS to cloud.camlytics.com | 600s |
| Projectors (4) | `composite` | HTTP to each projector | 60s |
| Control Tablets (6) | `heartbeat_group` | WebSocket heartbeat tracking | 30s |

### Health Levels

| Level | Color | Meaning |
|-------|-------|---------|
| Healthy | Green | Service online and responding normally |
| Warning | Yellow | Slow response or partial failure |
| Down | Red | Offline or completely failed |

### Alert System

When a service transitions to Warning or Down:
1. HealthDash fires a webhook to Home Assistant
2. HA can trigger automations (notifications, recovery scripts)
3. Cooldown prevents alert storms

### Recovery Actions

Some services support one-click recovery via Home Assistant scripts:
- **X32 Middleware** -- `script.restart_x32_middleware`
- **MoIP Middleware** -- `script.restart_moip_middleware`
- **OBS Middleware** -- `script.restart_obs_middleware`

### Accessing HealthDash

```
http://<server-ip>:20855/
```

Login required from non-trusted IPs. Password: configured in `config.yaml` under
`security.password`.

---

## 12. Production Deployment

### 12.1 Systemd Services (Linux)

Create service files for each component:

**`/etc/systemd/system/stp-x32.service`**
```ini
[Unit]
Description=STP X32 Audio Middleware
After=network.target

[Service]
Type=simple
User=stpaul
WorkingDirectory=/path/to/STP_scripts
ExecStart=/usr/bin/python3 x32-flask.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/stp-moip.service`**
```ini
[Unit]
Description=STP MoIP Video Middleware
After=network.target

[Service]
Type=simple
User=stpaul
WorkingDirectory=/path/to/STP_scripts
ExecStart=/usr/bin/python3 moip-flask.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/stp-obs.service`**
```ini
[Unit]
Description=STP OBS Streaming Middleware
After=network.target

[Service]
Type=simple
User=stpaul
WorkingDirectory=/path/to/STP_scripts
ExecStart=/usr/bin/python3 obs-flask.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/stp-gateway.service`**
```ini
[Unit]
Description=STP Gateway (Unified API + Frontend)
After=network.target stp-x32.service stp-moip.service stp-obs.service

[Service]
Type=simple
User=stpaul
WorkingDirectory=/path/to/STP_tablets/gateway
ExecStart=/usr/bin/python3 gateway.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/stp-healthdash.service`**
```ini
[Unit]
Description=STP HealthDash Monitor
After=network.target stp-gateway.service

[Service]
Type=simple
User=stpaul
WorkingDirectory=/path/to/STP_healthdash
ExecStart=/usr/bin/python3 app.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start all services:
```bash
sudo systemctl daemon-reload
sudo systemctl enable stp-x32 stp-moip stp-obs stp-gateway stp-healthdash
sudo systemctl start stp-x32 stp-moip stp-obs
sleep 3
sudo systemctl start stp-gateway
sleep 2
sudo systemctl start stp-healthdash
```

### 12.2 Windows Deployment

On Windows, use Task Scheduler or NSSM (Non-Sucking Service Manager) to run each
Python script as a Windows service. The startup order is the same.

### 12.3 Log Rotation

Logs are automatically rotated by the applications:
- Gateway: 5 MB per file, 5 backups (`gateway/logs/stp-gateway.log`)
- HealthDash: 5 MB per file, 5 backups (`STP_healthdash/logs/healthdash.log`)

### 12.4 Database Maintenance

The gateway uses SQLite for audit logging (`gateway/stp_gateway.db`). Over time this file
will grow. Periodically archive or truncate old entries:

```sql
-- Keep only last 30 days
DELETE FROM audit_log WHERE timestamp < datetime('now', '-30 days');
VACUUM;
```

### 12.5 Security Checklist

- [ ] Change `settings_pin` from default `"1234"` in gateway config
- [ ] Change `password` from default `"Companion4Us"` in healthdash config
- [ ] Change `secret_key` from default in healthdash config
- [ ] Review `allowed_ips` prefixes match your actual network
- [ ] Ensure Home Assistant token has appropriate scopes
- [ ] Run services behind a reverse proxy (nginx) with TLS for external access
- [ ] Never expose ports 3400, 4456, 5002 directly to the internet
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
2. Test gateway reachability: `curl http://<gateway-ip>:8080/api/health`
3. Check browser console (F12) for Socket.IO connection errors
4. Verify `localStorage.tabletId` is set correctly

### No real-time updates

1. Confirm Socket.IO is loading: check browser Network tab for `/socket.io/` requests
2. Verify middleware services are running on expected ports
3. Check gateway logs for polling errors
4. The status bar shows connection state: "Connected", "Reconnecting (N)...", or "Disconnected"

### Middleware service offline

```bash
# Check if the process is running
ps aux | grep "x32-flask\|moip-flask\|obs-flask"

# Test the specific service
curl http://127.0.0.1:3400/health    # X32
curl http://127.0.0.1:5002/status    # MoIP
curl http://127.0.0.1:4456/health    # OBS

# Restart via systemd
sudo systemctl restart stp-x32
```

### OBS not connecting

1. Verify OBS Studio is running with WebSocket Server enabled
2. Check OBS settings: Tools > WebSocket Server Settings
3. Default OBS WebSocket port is 4455 (the middleware listens on 4456)
4. If password-protected, set `OBS_WS_PASSWORD` environment variable

### Home Assistant integration failing

1. Verify the long-lived access token hasn't expired
2. Test manually: `curl -H "Authorization: Bearer <token>" http://192.168.1.245:8123/api/`
3. If using Cloud URL, verify internet connectivity
4. Check HA logs for webhook delivery issues

### HealthDash shows services as down

1. The HealthDash checks services independently -- a service showing "down"
   means HealthDash couldn't reach it directly
2. Verify the service URLs in `config.yaml` match actual running ports
3. Some services (WattBox, cameras) have long poll intervals (300-600s) --
   wait for the next check cycle
4. Use the "Check Now" button in the HealthDash UI to force an immediate check
5. For RTSP cameras: ensure `ffprobe` is installed and the path is correct

### Scene execution fails

1. Check gateway logs for MoIP proxy errors
2. Verify scene definitions in `frontend/config/devices.json`
3. Scene execution sends real-time progress via Socket.IO -- check browser console
4. The scene engine retries failed switches up to 3 times

---

## Quick Reference Card

```
GATEWAY:       http://<server>:8080/
HEALTHDASH:    http://<server>:20855/
SETTINGS PIN:  1234 (change in config)

START ORDER:   x32-flask -> moip-flask -> obs-flask -> gateway -> healthdash

MOCK MODE:     cd STP_tablets/gateway && python gateway.py --mock

LOGS:
  Gateway:     STP_tablets/gateway/logs/stp-gateway.log
  HealthDash:  STP_healthdash/logs/healthdash.log

CONFIG FILES:
  Gateway:     STP_tablets/gateway/config.yaml
  Frontend:    STP_tablets/frontend/config/{settings,devices,permissions}.json
  HealthDash:  STP_healthdash/config.yaml
```
