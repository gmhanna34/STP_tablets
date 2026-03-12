# STP AV Control System — Migration Guide (Windows PC)

> **Purpose:** Step-by-step instructions to install, configure, and run the entire St. Paul AV Control System on a **fresh Windows PC**. This covers every service: middleware proxies (X32, MoIP, OBS), the STP Gateway, the tablet frontend, HealthDash monitoring, OBS Studio, The Home Remote (THR), and Camlytics occupancy counting.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Prerequisites & Required Downloads](#2-prerequisites--required-downloads)
3. [Network Configuration](#3-network-configuration)
4. [Install Git & Clone Repositories](#4-install-git--clone-repositories)
5. [Install Python & Create Virtual Environments](#5-install-python--create-virtual-environments)
6. [Install Middleware Dependencies](#6-install-middleware-dependencies)
7. [Install Gateway Dependencies](#7-install-gateway-dependencies)
8. [Install HealthDash Dependencies](#8-install-healthdash-dependencies)
9. [Configure Environment Variables & Secrets](#9-configure-environment-variables--secrets)
10. [Configure the Gateway](#10-configure-the-gateway)
11. [Install & Configure OBS Studio](#11-install--configure-obs-studio)
12. [Install & Configure The Home Remote (THR)](#12-install--configure-the-home-remote-thr)
13. [Install & Configure Camlytics](#13-install--configure-camlytics)
14. [Start All Services](#14-start-all-services)
15. [Automate Startup with NSSM or Task Scheduler](#15-automate-startup-with-nssm-or-task-scheduler)
16. [Verify Everything Works](#16-verify-everything-works)
17. [Configure Tablets](#17-configure-tablets)
18. [Security Checklist](#18-security-checklist)
19. [Backup & Maintenance](#19-backup--maintenance)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. System Overview

The system consists of **5 Python services**, **1 desktop app (OBS)**, **1 legacy tablet app (THR)**, and **1 analytics platform (Camlytics)**:

| Component | Port | Description |
|-----------|------|-------------|
| X32 Middleware | 3400 | Audio mixer proxy (OSC/UDP to Behringer X32) |
| MoIP Middleware | 5002 | Video matrix proxy (Telnet to Binary MoIP controller) |
| OBS Middleware | 4456 | Streaming proxy (WebSocket to OBS Studio) |
| STP Gateway | 20858 | Unified API + WebSocket hub + static file server |
| HealthDash | 20855 | System health monitoring dashboard |
| OBS Studio | 4455 | Live streaming/recording software (WebSocket server) |
| The Home Remote | — | Legacy tablet control app (Android/iOS) |
| Camlytics | — | People counting / occupancy analytics |

### Architecture

```
Tablets / Browsers ──► STP Gateway (:20858)
                          │
                ┌─────────┼─────────┐
                ▼         ▼         ▼
          X32 Proxy  MoIP Proxy  OBS Proxy
           :3400      :5002       :4456
              │         │           │
              ▼         ▼           ▼
          X32 Mixer  MoIP Ctrl  OBS Studio
         .1.231    10.100.20.11  :4455

Gateway also talks directly to:
  • 10 PTZ Cameras (10.100.60.201-210)
  • 4 Epson Projectors (10.100.60.233-236)
  • Home Assistant (10.100.60.245:8123)
  • 7 WattBox PDUs (10.100.60.61-67)
  • Camlytics Cloud API

HealthDash (:20855) monitors all of the above.
```

---

## 2. Prerequisites & Required Downloads

### Software to Download

| Software | Version | Download |
|----------|---------|----------|
| Python | 3.11+ | https://www.python.org/downloads/windows/ |
| Git for Windows | Latest | https://git-scm.com/download/win |
| OBS Studio | 30+ | https://obsproject.com/download |
| NSSM (service manager) | Latest | https://nssm.cc/download |
| The Home Remote | Latest | https://thehomeremote.com/ |
| Camlytics | Latest | https://camlytics.com/ |
| ffprobe (ffmpeg) | Latest | https://ffmpeg.org/download.html |
| A text editor | — | VS Code, Notepad++, etc. |

### Hardware Requirements

- Windows 10/11 (64-bit)
- Minimum 8 GB RAM (16 GB recommended for OBS streaming)
- SSD recommended for responsive service startup
- Network adapter on the `10.100.60.x` subnet
- Secondary NIC or VLAN access to `10.100.x.x` subnet (for MoIP)

---

## 3. Network Configuration

The server **must** be on the church network with access to all device subnets.

### Static IP Configuration

1. Open **Settings > Network & Internet > Ethernet > Edit IP assignment**
2. Set a static IP in the `10.100.60.x` range (e.g., `10.100.60.10`)
3. Subnet mask: `255.255.255.0`
4. Gateway: `10.100.60.1`
5. DNS: `10.100.60.1` (or your preferred DNS)

### Firewall Rules

Open **Windows Defender Firewall > Advanced Settings** and create inbound rules:

```
Port 3400  (TCP) — X32 Middleware
Port 4455  (TCP) — OBS WebSocket (if remote access needed)
Port 4456  (TCP) — OBS Middleware
Port 5002  (TCP) — MoIP Middleware
Port 8080  (TCP) — Legacy (if needed)
Port 20855 (TCP) — HealthDash
Port 20858 (TCP) — STP Gateway
```

Or via PowerShell (run as Administrator):
```powershell
New-NetFirewallRule -DisplayName "STP X32 Middleware" -Direction Inbound -Protocol TCP -LocalPort 3400 -Action Allow
New-NetFirewallRule -DisplayName "STP MoIP Middleware" -Direction Inbound -Protocol TCP -LocalPort 5002 -Action Allow
New-NetFirewallRule -DisplayName "STP OBS Middleware" -Direction Inbound -Protocol TCP -LocalPort 4456 -Action Allow
New-NetFirewallRule -DisplayName "STP Gateway" -Direction Inbound -Protocol TCP -LocalPort 20858 -Action Allow
New-NetFirewallRule -DisplayName "STP HealthDash" -Direction Inbound -Protocol TCP -LocalPort 20855 -Action Allow
New-NetFirewallRule -DisplayName "OBS WebSocket" -Direction Inbound -Protocol TCP -LocalPort 4455 -Action Allow
```

### Required Network Routes

Ensure the PC can reach:

| Destination | Purpose |
|-------------|---------|
| 10.100.60.201-210 | PTZ Cameras |
| 10.100.60.233-236 | Epson Projectors |
| 10.100.60.231 | Behringer X32 Mixer |
| 10.100.60.61-67 | WattBox PDUs |
| 10.100.60.245:8123 | Home Assistant |
| 10.100.60.193:25105 | Insteon Hub |
| 10.100.20.11:23 | MoIP Controller (may require routing/VLAN) |
| cloud.camlytics.com | Camlytics Cloud |

---

## 4. Install Git & Clone Repositories

### Install Git

1. Download and run the Git for Windows installer
2. Accept all defaults (or customize as desired)
3. Open **Git Bash** or **Command Prompt** and verify:

```cmd
git --version
```

### Clone All Repositories

Open Command Prompt or PowerShell and run:

```cmd
mkdir C:\STP
cd C:\STP

git clone <your-STP_tablets-repo-url> STP_tablets
git clone <your-STP_scripts-repo-url> STP_scripts
git clone <your-STP_healthdash-repo-url> STP_healthdash
git clone <your-STP_THRFiles_Current-repo-url> STP_THRFiles_Current
```

Your directory structure should look like:

```
C:\STP\
├── STP_tablets\          # Gateway + Frontend
│   ├── gateway\
│   └── frontend\
├── STP_scripts\          # Middleware proxies
│   ├── x32-flask.py
│   ├── moip-flask.py
│   ├── obs-flask.py
│   └── requirements.txt
├── STP_healthdash\       # Health monitoring
│   ├── app.py
│   ├── config.yaml
│   └── requirements.txt
└── STP_THRFiles_Current\ # THR project files
    └── Main Project v26-012_Mainchurch.hrp
```

---

## 5. Install Python & Create Virtual Environments

### Install Python

1. Download Python 3.11+ from python.org
2. **IMPORTANT:** Check **"Add Python to PATH"** during installation
3. Also check **"Install pip"**
4. Verify installation:

```cmd
python --version
pip --version
```

### Create Virtual Environments

Create separate virtual environments for each service group to avoid dependency conflicts:

```cmd
:: Middleware venv
cd C:\STP\STP_scripts
python -m venv .venv
.venv\Scripts\activate
pip install --upgrade pip
deactivate

:: Gateway venv
cd C:\STP\STP_tablets\gateway
python -m venv .venv
.venv\Scripts\activate
pip install --upgrade pip
deactivate

:: HealthDash venv
cd C:\STP\STP_healthdash
python -m venv .venv
.venv\Scripts\activate
pip install --upgrade pip
deactivate
```

---

## 6. Install Middleware Dependencies

```cmd
cd C:\STP\STP_scripts
.venv\Scripts\activate
pip install -r requirements.txt
deactivate
```

Expected packages:
- `flask==3.0.3`
- `waitress==2.1.2`

---

## 7. Install Gateway Dependencies

```cmd
cd C:\STP\STP_tablets\gateway
.venv\Scripts\activate
pip install -r requirements.txt
deactivate
```

Expected packages:
- `flask==3.0.3`
- `flask-socketio==5.4.1`
- `python-socketio>=5.11,<6`
- `python-engineio>=4.9,<5`
- `eventlet==0.37.0`
- `requests==2.32.3`
- `pyyaml==6.0.2`
- `python-dotenv==1.0.1`

---

## 8. Install HealthDash Dependencies

```cmd
cd C:\STP\STP_healthdash
.venv\Scripts\activate
pip install -r requirements.txt
deactivate
```

Expected packages:
- `Flask==3.0.0`
- `requests==2.31.0`
- `PyYAML==6.0.1`
- `psutil==5.9.8`
- `waitress==2.1.2`

---

## 9. Configure Environment Variables & Secrets

### Create the `.env` file

The gateway uses `python-dotenv` to load secrets from a `.env` file. Copy the example and fill in real values:

```cmd
cd C:\STP\STP_tablets\gateway
copy .env.example .env
```

Edit `C:\STP\STP_tablets\gateway\.env` with your actual credentials:

```env
# STP Gateway Secrets — keep out of version control

MOIP_API_KEY=moip-key-your-actual-key-here
X32_API_KEY=x32-key-your-actual-key-here
HA_URL=https://your-ha-instance.ui.nabu.casa
HA_TOKEN=your-long-lived-home-assistant-access-token
WATTBOX_PASSWORD=your-wattbox-password
FLASK_SECRET_KEY=generate-a-long-random-string-here
SETTINGS_PIN=your-settings-pin
REMOTE_AUTH_USER=your-admin-username
REMOTE_AUTH_PASS=your-admin-password
FULLY_KIOSK_PASSWORD=your-fully-kiosk-password
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

> **How to generate a Flask secret key:**
> ```cmd
> python -c "import secrets; print(secrets.token_hex(32))"
> ```

> **How to get a Home Assistant long-lived access token:**
> 1. Go to your HA instance > Profile (bottom-left)
> 2. Scroll to "Long-Lived Access Tokens"
> 3. Click "Create Token", name it "STP Gateway", copy the token

---

## 10. Configure the Gateway

### Edit `config.yaml`

The main configuration file is at `C:\STP\STP_tablets\gateway\config.yaml`. Key settings to verify/update:

```yaml
gateway:
  host: "0.0.0.0"
  port: 20858
  static_dir: "../frontend"    # Relative path to frontend directory

middleware:
  moip:
    url: "http://127.0.0.1:5002"
  x32:
    url: "http://127.0.0.1:3400"
  obs:
    url: "http://127.0.0.1:4456"

# Verify these IPs match your actual device addresses:
ptz_cameras:
  MainChurch_Rear:    { ip: "10.100.60.201", name: "Cam1921681201" }
  MainChurch_Altar:   { ip: "10.100.60.202", name: "Cam1921681202" }
  # ... (verify all 10 cameras)

projectors:
  epson1: { ip: "10.100.60.233", name: "PRJ_FrontLeft" }
  epson2: { ip: "10.100.60.234", name: "PRJ_FrontRight" }
  epson3: { ip: "10.100.60.236", name: "PRJ_RearLeft" }
  epson4: { ip: "10.100.60.235", name: "PRJ_RearRight" }

security:
  allowed_ips:
    - "10.100.60."
    - "10.100."
    - "10.10."
    - "172.16."
    - "127.0.0.1"
    - "47.150."
```

### Edit `macros.yaml`

The macro configuration file at `C:\STP\STP_tablets\gateway\macros.yaml` defines all automation sequences. Review and verify:
- IR codes match your TV models
- MoIP receiver numbers match your physical wiring
- Home Assistant entity IDs are correct
- WattBox outlet assignments are accurate

### Edit Frontend Config

**`C:\STP\STP_tablets\frontend\config\settings.json`** — Verify the HealthDash URL:
```json
{
  "healthCheck": {
    "url": "external.stpauloc.org:20855"
  }
}
```

**`C:\STP\STP_tablets\frontend\config\devices.json`** — Verify MoIP transmitter/receiver IDs and scene definitions.

**`C:\STP\STP_tablets\frontend\config\permissions.json`** — Verify tablet locations and role assignments.

### Configure Middleware Scripts

The middleware scripts in `STP_scripts/` have hardcoded values. Verify these in each file:

**`x32-flask.py`:**
- `X32_MIXER_IP` = `10.100.60.231`
- API key must match the gateway's `.env` `X32_API_KEY`
- Listen port: `3400`

**`moip-flask.py`:**
- `MOIP_HOST` = `10.100.20.11`
- `MOIP_PORT` = `23`
- API key must match the gateway's `.env` `MOIP_API_KEY`
- Listen port: `5002`

**`obs-flask.py`:**
- OBS WebSocket URL: `ws://127.0.0.1:4455`
- Listen port: `4456`

### Configure HealthDash

Edit `C:\STP\STP_healthdash\config.yaml`:
- Verify all service URLs and ports
- Set the dashboard password
- Set the Home Assistant URL and token (for recovery actions)
- Verify alert webhook URL

---

## 11. Install & Configure OBS Studio

1. **Download and install** OBS Studio from https://obsproject.com/download
2. **Launch OBS Studio**
3. **Enable WebSocket Server:**
   - Go to **Tools > WebSocket Server Settings**
   - Check **"Enable WebSocket Server"**
   - Port: **4455** (default)
   - If you set a password, set `OBS_WS_PASSWORD` environment variable for the OBS middleware
4. **Import your scenes and profiles** from the old machine:
   - Copy the OBS profile folder from the old machine:
     - Old location: `%APPDATA%\obs-studio\`
   - Contains: `basic/profiles/`, `basic/scenes/`, `plugin_config/`
5. **Configure streaming settings** (stream key, encoder, bitrate, etc.)
6. **Set OBS to start automatically:**
   - Create a shortcut in `shell:startup` (press `Win+R`, type `shell:startup`)

---

## 12. Install & Configure The Home Remote (THR)

The Home Remote (THR) is the **legacy** tablet control app. It runs on Android/iOS tablets and uses `.hrp` project files.

### On the Server

1. The THR project files are in `C:\STP\STP_THRFiles_Current\`:
   - `Main Project v26-012_Mainchurch.hrp` (latest version)
2. THR Designer (Windows app) is used to edit and publish project files
3. Download THR Designer from https://thehomeremote.com/

### On Each Tablet

1. Install **The Home Remote** app from Google Play / App Store
2. Import the `.hrp` project file
3. Configure the tablet name in THR settings to match its location:
   - `Tablet_Mainchurch`
   - `Tablet_Chapel`
   - `Tablet_SocialHall`
   - `Tablet_ConferenceRoom`
   - `Tablet_Gym`
   - `Tablet_Lobby`
   - `Tablet_Office`

### THR Integrations Configured in the Project

The `.hrp` file includes connections to:
- Home Assistant
- Insteon Hub
- IP Cameras
- Custom plugins (MoIP, OBS, X32, PTZ, WattBox, Epson, Camlytics, HealthCheck, ContextAware, FullyKioskManager)

> **Note:** The new web-based frontend (`STP_tablets/frontend/`) is the modern replacement for THR. Both can run simultaneously during transition.

---

## 13. Install & Configure Camlytics

Camlytics provides people counting and occupancy analytics via camera feeds.

### Install Camlytics

1. Download from https://camlytics.com/
2. Install on the server PC
3. Configure camera feeds (RTSP streams from UniFi NVR at `10.100.40.100`)
4. Set up counting zones and analytics rules

### Camlytics Cloud Integration

The gateway pulls data from Camlytics Cloud API. These URLs are configured in `config.yaml`:

```yaml
camlytics:
  communion_url: "https://cloud.camlytics.com/feed/report/<your-report-id>"
  occupancy_url_peak: "https://cloud.camlytics.com/feed/report/<your-report-id>"
  occupancy_url_live: "https://cloud.camlytics.com/feed/report/<your-report-id>"
  enter_url: "https://cloud.camlytics.com/feed/report/<your-report-id>"
```

> Verify these report IDs are correct for your Camlytics Cloud account.

### Install ffprobe (for RTSP camera health checks)

1. Download ffmpeg from https://ffmpeg.org/download.html (get the "full" build)
2. Extract to `C:\ffmpeg\`
3. Add `C:\ffmpeg\bin\` to the system PATH:
   - **Settings > System > About > Advanced System Settings > Environment Variables**
   - Edit `Path` under System Variables, add `C:\ffmpeg\bin`
4. Verify: `ffprobe -version`

---

## 14. Start All Services

Services must start in this specific order because of dependencies:

### Manual Startup (for testing)

Open **5 separate Command Prompt windows**:

**Window 1 — X32 Middleware:**
```cmd
cd C:\STP\STP_scripts
.venv\Scripts\activate
python x32-flask.py
```

**Window 2 — MoIP Middleware:**
```cmd
cd C:\STP\STP_scripts
.venv\Scripts\activate
python moip-flask.py
```

**Window 3 — OBS Middleware:**
```cmd
cd C:\STP\STP_scripts
.venv\Scripts\activate
python obs-flask.py
```

**Window 4 — STP Gateway** (wait a few seconds after middleware starts):
```cmd
cd C:\STP\STP_tablets\gateway
.venv\Scripts\activate
python gateway.py
```

Gateway CLI options:
```
python gateway.py              # Normal mode
python gateway.py --mock       # Mock mode (no real devices)
python gateway.py --config alt.yaml  # Custom config
```

**Window 5 — HealthDash:**
```cmd
cd C:\STP\STP_healthdash
.venv\Scripts\activate
python app.py
```

### Startup Batch Script

Create `C:\STP\start-all.bat`:

```bat
@echo off
echo ============================================
echo  Starting STP AV Control System
echo ============================================

echo [1/5] Starting X32 Middleware...
start "STP-X32" cmd /k "cd /d C:\STP\STP_scripts && .venv\Scripts\activate && python x32-flask.py"

echo [2/5] Starting MoIP Middleware...
start "STP-MoIP" cmd /k "cd /d C:\STP\STP_scripts && .venv\Scripts\activate && python moip-flask.py"

echo [3/5] Starting OBS Middleware...
start "STP-OBS" cmd /k "cd /d C:\STP\STP_scripts && .venv\Scripts\activate && python obs-flask.py"

echo Waiting for middleware to initialize...
timeout /t 5 /nobreak > nul

echo [4/5] Starting STP Gateway...
start "STP-Gateway" cmd /k "cd /d C:\STP\STP_tablets\gateway && .venv\Scripts\activate && python gateway.py"

echo Waiting for gateway to initialize...
timeout /t 3 /nobreak > nul

echo [5/5] Starting HealthDash...
start "STP-HealthDash" cmd /k "cd /d C:\STP\STP_healthdash && .venv\Scripts\activate && python app.py"

echo.
echo ============================================
echo  All services started!
echo  Gateway:    http://localhost:20858/
echo  HealthDash: http://localhost:20855/
echo ============================================
pause
```

### Stop All Script

Create `C:\STP\stop-all.bat`:

```bat
@echo off
echo Stopping all STP services...
taskkill /FI "WINDOWTITLE eq STP-X32*" /F 2>nul
taskkill /FI "WINDOWTITLE eq STP-MoIP*" /F 2>nul
taskkill /FI "WINDOWTITLE eq STP-OBS*" /F 2>nul
taskkill /FI "WINDOWTITLE eq STP-Gateway*" /F 2>nul
taskkill /FI "WINDOWTITLE eq STP-HealthDash*" /F 2>nul
echo All services stopped.
pause
```

---

## 15. Automate Startup with NSSM or Task Scheduler

### Option A: NSSM (Recommended)

NSSM (Non-Sucking Service Manager) lets you run Python scripts as Windows services with auto-restart.

1. **Download NSSM** from https://nssm.cc/download
2. Extract `nssm.exe` to `C:\STP\nssm\`

**Install each service (run as Administrator):**

```cmd
:: X32 Middleware
C:\STP\nssm\nssm.exe install STP-X32 "C:\STP\STP_scripts\.venv\Scripts\python.exe" "x32-flask.py"
C:\STP\nssm\nssm.exe set STP-X32 AppDirectory "C:\STP\STP_scripts"
C:\STP\nssm\nssm.exe set STP-X32 Description "STP X32 Audio Middleware"
C:\STP\nssm\nssm.exe set STP-X32 Start SERVICE_AUTO_START
C:\STP\nssm\nssm.exe set STP-X32 AppRestartDelay 10000

:: MoIP Middleware
C:\STP\nssm\nssm.exe install STP-MoIP "C:\STP\STP_scripts\.venv\Scripts\python.exe" "moip-flask.py"
C:\STP\nssm\nssm.exe set STP-MoIP AppDirectory "C:\STP\STP_scripts"
C:\STP\nssm\nssm.exe set STP-MoIP Description "STP MoIP Video Middleware"
C:\STP\nssm\nssm.exe set STP-MoIP Start SERVICE_AUTO_START
C:\STP\nssm\nssm.exe set STP-MoIP AppRestartDelay 10000

:: OBS Middleware
C:\STP\nssm\nssm.exe install STP-OBS "C:\STP\STP_scripts\.venv\Scripts\python.exe" "obs-flask.py"
C:\STP\nssm\nssm.exe set STP-OBS AppDirectory "C:\STP\STP_scripts"
C:\STP\nssm\nssm.exe set STP-OBS Description "STP OBS Streaming Middleware"
C:\STP\nssm\nssm.exe set STP-OBS Start SERVICE_AUTO_START
C:\STP\nssm\nssm.exe set STP-OBS AppRestartDelay 10000

:: STP Gateway (depends on middleware)
C:\STP\nssm\nssm.exe install STP-Gateway "C:\STP\STP_tablets\gateway\.venv\Scripts\python.exe" "gateway.py"
C:\STP\nssm\nssm.exe set STP-Gateway AppDirectory "C:\STP\STP_tablets\gateway"
C:\STP\nssm\nssm.exe set STP-Gateway Description "STP Gateway (Unified API + Frontend)"
C:\STP\nssm\nssm.exe set STP-Gateway Start SERVICE_AUTO_START
C:\STP\nssm\nssm.exe set STP-Gateway DependOnService STP-X32 STP-MoIP STP-OBS
C:\STP\nssm\nssm.exe set STP-Gateway AppRestartDelay 10000

:: HealthDash
C:\STP\nssm\nssm.exe install STP-HealthDash "C:\STP\STP_healthdash\.venv\Scripts\python.exe" "app.py"
C:\STP\nssm\nssm.exe set STP-HealthDash AppDirectory "C:\STP\STP_healthdash"
C:\STP\nssm\nssm.exe set STP-HealthDash Description "STP HealthDash Monitor"
C:\STP\nssm\nssm.exe set STP-HealthDash Start SERVICE_AUTO_START
C:\STP\nssm\nssm.exe set STP-HealthDash DependOnService STP-Gateway
C:\STP\nssm\nssm.exe set STP-HealthDash AppRestartDelay 10000
```

**Manage services:**
```cmd
:: Start all
net start STP-X32
net start STP-MoIP
net start STP-OBS
net start STP-Gateway
net start STP-HealthDash

:: Stop all
net stop STP-HealthDash
net stop STP-Gateway
net stop STP-OBS
net stop STP-MoIP
net stop STP-X32

:: Check status
sc query STP-Gateway
```

### Option B: Task Scheduler

1. Open **Task Scheduler** (`taskschd.msc`)
2. Create a new task for each service:
   - **General:** Run whether user is logged on or not, run with highest privileges
   - **Trigger:** At startup
   - **Action:** Start a program
     - Program: `C:\STP\STP_scripts\.venv\Scripts\python.exe`
     - Arguments: `x32-flask.py`
     - Start in: `C:\STP\STP_scripts`
   - **Settings:** Restart on failure every 1 minute, restart up to 999 times
3. Add a startup delay for gateway (5 seconds) and HealthDash (8 seconds)

---

## 16. Verify Everything Works

### Test Each Service

Open a browser or use `curl` from Command Prompt:

```cmd
:: X32 Middleware
curl http://127.0.0.1:3400/health

:: MoIP Middleware
curl http://127.0.0.1:5002/status

:: OBS Middleware
curl http://127.0.0.1:4456/health

:: STP Gateway
curl http://127.0.0.1:20858/api/health

:: HealthDash
curl http://127.0.0.1:20855/api/summary
```

### Test the Frontend

Open a browser and navigate to:
```
http://localhost:20858/
```

You should see the St. Paul Control Panel with the home dashboard.

### Test HealthDash

Open a browser and navigate to:
```
http://localhost:20855/
```

You should see the health monitoring dashboard showing all service statuses.

### Test from a Tablet

From an iPad or Android tablet on the same network:
```
http://10.100.60.XX:20858/
```
(Replace `XX` with your server's IP)

---

## 17. Configure Tablets

### New Web UI Tablets

For tablets using the new web-based frontend:

1. Open `http://<server-ip>:20858/` in the tablet browser
2. On first visit, the app will prompt to select a location
3. Select the appropriate location (Chapel, Social Hall, A/V Room, etc.)
4. The location is saved to `localStorage` and determines which pages/controls are visible

**Location → Role Mapping:**

| Location | Role | Pages Visible |
|----------|------|---------------|
| A/V Room | Full Access | All pages |
| Chapel | Chapel | Home, Chapel, Stream, Source, Settings |
| Social Hall | Social Hall | Home, Social, Stream, Source, Settings |
| Conference Room | Conference Room | Home, ConfRoom, Source, Settings |
| Gym | Gym | Home, Gym, Source, Settings |
| Lobby | Lobby | Home, Source, Settings |
| Office | Offices | Home, ConfRoom, Source, Security, Settings |

### Fully Kiosk Browser (Android Tablets)

For tablets in kiosk mode:

1. Install **Fully Kiosk Browser** from the Play Store
2. Configure it to load `http://<server-ip>:20858/`
3. Enable kiosk mode (prevents users from exiting the app)
4. Set the Fully Kiosk admin password to match your `.env` `FULLY_KIOSK_PASSWORD`
5. The gateway communicates with Fully Kiosk on port `2323` for screensaver control

---

## 18. Security Checklist

Before going live, verify:

- [ ] Changed `SETTINGS_PIN` from default `1234`
- [ ] Changed `FLASK_SECRET_KEY` to a random string
- [ ] Changed `REMOTE_AUTH_USER` and `REMOTE_AUTH_PASS` from defaults
- [ ] Changed HealthDash password from default `Companion4Us`
- [ ] Changed WattBox password from default `WBAdmin1`
- [ ] Verified `allowed_ips` in `config.yaml` matches your actual network
- [ ] Home Assistant long-lived access token is valid
- [ ] `.env` file is NOT committed to git (check `.gitignore`)
- [ ] Ports 3400, 4456, 5002 are NOT exposed to the internet
- [ ] Only ports 20858 and 20855 are accessible from the LAN
- [ ] OBS WebSocket password is set (if accessible beyond localhost)
- [ ] Middleware API keys match between middleware scripts and gateway config
- [ ] Windows Firewall is configured correctly
- [ ] Windows auto-login is configured (so services start even after a reboot)

---

## 19. Backup & Maintenance

### What to Back Up

| Item | Location | Frequency |
|------|----------|-----------|
| Gateway config | `C:\STP\STP_tablets\gateway\config.yaml` | After any change |
| Gateway secrets | `C:\STP\STP_tablets\gateway\.env` | After any change |
| Macros | `C:\STP\STP_tablets\gateway\macros.yaml` | After any change |
| Frontend config | `C:\STP\STP_tablets\frontend\config\` | After any change |
| HealthDash config | `C:\STP\STP_healthdash\config.yaml` | After any change |
| Audit database | `C:\STP\STP_tablets\gateway\stp_gateway.db` | Weekly |
| OBS profiles | `%APPDATA%\obs-studio\` | After scene changes |
| THR project files | `C:\STP\STP_THRFiles_Current\` | After updates |
| Middleware scripts | `C:\STP\STP_scripts\` | After code changes |

### Database Maintenance

The gateway audit log grows over time. Periodically clean it:

```cmd
cd C:\STP\STP_tablets\gateway
.venv\Scripts\activate
python -c "import sqlite3; conn = sqlite3.connect('stp_gateway.db'); conn.execute(\"DELETE FROM audit_log WHERE timestamp < datetime('now', '-30 days')\"); conn.execute('VACUUM'); conn.close(); print('Done')"
```

### Log Files

Logs auto-rotate (5 MB, 5 backups):
- Gateway: `C:\STP\STP_tablets\gateway\logs\stp-gateway.log`
- HealthDash: `C:\STP\STP_healthdash\logs\healthdash.log`

### Updating Code

```cmd
cd C:\STP\STP_tablets
git pull origin main

cd C:\STP\STP_scripts
git pull origin main

cd C:\STP\STP_healthdash
git pull origin main
```

Then restart the affected services.

---

## 20. Troubleshooting

### Service won't start

```cmd
:: Check if port is already in use
netstat -ano | findstr :20858
netstat -ano | findstr :3400

:: Validate YAML config
cd C:\STP\STP_tablets\gateway
.venv\Scripts\activate
python -c "import yaml; yaml.safe_load(open('config.yaml')); print('Config OK')"

:: Run gateway in mock mode to test without devices
python gateway.py --mock
```

### Can't reach devices

```cmd
:: Test network connectivity
ping 10.100.60.231        :: X32 Mixer
ping 10.100.60.201        :: First PTZ camera
ping 10.100.60.233        :: First projector
ping 10.100.60.245        :: Home Assistant

:: Test MoIP network (may need VPN/VLAN)
ping 10.100.20.11
```

### Tablets can't connect

1. Verify the tablet is on the `10.100.60.x` network
2. Test from the tablet browser: `http://<server-ip>:20858/api/health`
3. Check Windows Firewall isn't blocking the port
4. Check the gateway logs for connection errors

### OBS middleware can't connect to OBS

1. Verify OBS Studio is running
2. Verify WebSocket Server is enabled in OBS: **Tools > WebSocket Server Settings**
3. Check the OBS WebSocket port matches (default: 4455)
4. If password-protected, set the `OBS_WS_PASSWORD` environment variable

### HealthDash shows services as down

1. Services may still be initializing — wait for the next poll cycle
2. Check the service URLs in HealthDash's `config.yaml`
3. Use the "Check Now" button in the HealthDash UI
4. For RTSP cameras: ensure `ffprobe` is installed and in PATH

### Common Windows Issues

- **Python not found:** Ensure Python is in your PATH. Reinstall with "Add to PATH" checked.
- **Permission denied:** Run Command Prompt as Administrator for service management.
- **DLL errors:** Ensure Visual C++ Redistributable is installed (required by some Python packages).
- **Port conflicts:** Check for other services using the same ports with `netstat -ano | findstr :<port>`.

---

## Quick Reference Card

```
GATEWAY:        http://<server>:20858/
HEALTHDASH:     http://<server>:20855/
SETTINGS PIN:   (set in .env)

START ORDER:    x32-flask → moip-flask → obs-flask → gateway → healthdash

MOCK MODE:      cd C:\STP\STP_tablets\gateway && .venv\Scripts\activate && python gateway.py --mock

LOGS:
  Gateway:      C:\STP\STP_tablets\gateway\logs\stp-gateway.log
  HealthDash:   C:\STP\STP_healthdash\logs\healthdash.log

CONFIG FILES:
  Gateway:      C:\STP\STP_tablets\gateway\config.yaml
  Secrets:      C:\STP\STP_tablets\gateway\.env
  Macros:       C:\STP\STP_tablets\gateway\macros.yaml
  Frontend:     C:\STP\STP_tablets\frontend\config\{settings,devices,permissions}.json
  HealthDash:   C:\STP\STP_healthdash\config.yaml

REPOS:
  STP_tablets         Gateway + Frontend
  STP_scripts         Middleware (X32, MoIP, OBS)
  STP_healthdash      Health Monitoring
  STP_THRFiles_Current  Legacy THR Project Files
```
