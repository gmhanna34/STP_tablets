# STP AV Control System — Migration Guide (macOS / Mac Mini)

> **Purpose:** Step-by-step instructions to install, configure, and run the entire St. Paul AV Control System on a **fresh Mac** (Mac Mini, MacBook, iMac, etc.). This covers every service: middleware proxies (X32, MoIP, OBS), the STP Gateway, the tablet frontend, HealthDash monitoring, OBS Studio, The Home Remote (THR), and Camlytics occupancy counting.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Prerequisites & Required Downloads](#2-prerequisites--required-downloads)
3. [Network Configuration](#3-network-configuration)
4. [Install Developer Tools & Homebrew](#4-install-developer-tools--homebrew)
5. [Install Git & Clone Repositories](#5-install-git--clone-repositories)
6. [Install Python & Create Virtual Environments](#6-install-python--create-virtual-environments)
7. [Install Middleware Dependencies](#7-install-middleware-dependencies)
8. [Install Gateway Dependencies](#8-install-gateway-dependencies)
9. [Install HealthDash Dependencies](#9-install-healthdash-dependencies)
10. [Configure Environment Variables & Secrets](#10-configure-environment-variables--secrets)
11. [Configure the Gateway](#11-configure-the-gateway)
12. [Install & Configure OBS Studio](#12-install--configure-obs-studio)
13. [Install & Configure The Home Remote (THR)](#13-install--configure-the-home-remote-thr)
14. [Install & Configure Camlytics](#14-install--configure-camlytics)
15. [Start All Services](#15-start-all-services)
16. [Automate Startup with launchd](#16-automate-startup-with-launchd)
17. [Verify Everything Works](#17-verify-everything-works)
18. [Configure Tablets](#18-configure-tablets)
19. [Security Checklist](#19-security-checklist)
20. [Backup & Maintenance](#20-backup--maintenance)
21. [Troubleshooting](#21-troubleshooting)
22. [Mac-Specific Considerations](#22-mac-specific-considerations)

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
  • 10 PTZ Cameras (192.168.1.201-210)
  • 4 Epson Projectors (192.168.1.233-236)
  • Home Assistant (192.168.1.245:8123)
  • 7 WattBox PDUs (192.168.1.61-67)
  • Camlytics Cloud API

HealthDash (:20855) monitors all of the above.
```

---

## 2. Prerequisites & Required Downloads

### Software to Install

| Software | Version | Install Method |
|----------|---------|----------------|
| Xcode Command Line Tools | Latest | `xcode-select --install` |
| Homebrew | Latest | https://brew.sh |
| Python | 3.11+ | `brew install python@3.11` |
| Git | Latest | Comes with Xcode CLT (or `brew install git`) |
| OBS Studio | 30+ | `brew install --cask obs` |
| ffprobe (ffmpeg) | Latest | `brew install ffmpeg` |
| A text editor | — | VS Code (`brew install --cask visual-studio-code`) |

### Hardware Requirements

- macOS 13 Ventura or later (Apple Silicon or Intel)
- Minimum 8 GB RAM (16 GB recommended for OBS streaming)
- SSD (standard on all modern Macs)
- Ethernet adapter recommended for reliable network (USB-C to Ethernet for Mac Mini)
- Network access to `192.168.1.x` subnet
- Secondary NIC or VLAN access to `10.100.x.x` subnet (for MoIP)

---

## 3. Network Configuration

The Mac **must** be on the church network with access to all device subnets.

### Static IP Configuration

1. Open **System Settings > Network > Ethernet** (or Wi-Fi)
2. Click **Details...**
3. Select **TCP/IP** tab
4. Change "Configure IPv4" to **Manually**
5. Set:
   - IP Address: `192.168.1.10` (or your chosen address)
   - Subnet Mask: `255.255.255.0`
   - Router: `192.168.1.1`
6. Select **DNS** tab, add: `192.168.1.1`
7. Click **OK**

### macOS Firewall Configuration

By default, macOS blocks incoming connections. You need to allow the Python services:

**Option A: Disable firewall (simplest for dedicated server):**
1. **System Settings > Network > Firewall**
2. Toggle OFF

**Option B: Allow specific apps (more secure):**
1. **System Settings > Network > Firewall > Options**
2. Add Python and each service executable to the allowed list
3. Or, when prompted on first launch, click "Allow"

**Option C: Use `pf` firewall rules (advanced):**
```bash
# Add to /etc/pf.conf (requires sudo)
pass in on en0 proto tcp from any to any port { 3400, 4455, 4456, 5002, 20855, 20858 }
```

### Required Network Routes

Ensure the Mac can reach:

| Destination | Purpose |
|-------------|---------|
| 192.168.1.201-210 | PTZ Cameras |
| 192.168.1.233-236 | Epson Projectors |
| 192.168.1.231 | Behringer X32 Mixer |
| 192.168.1.61-67 | WattBox PDUs |
| 192.168.1.245:8123 | Home Assistant |
| 192.168.1.193:25105 | Insteon Hub |
| 10.100.20.11:23 | MoIP Controller (may require routing/VLAN) |
| cloud.camlytics.com | Camlytics Cloud |

Test connectivity:
```bash
ping 192.168.1.231
ping 192.168.1.201
ping 10.100.20.11
```

---

## 4. Install Developer Tools & Homebrew

### Xcode Command Line Tools

Open Terminal and run:
```bash
xcode-select --install
```

Click "Install" in the dialog that appears. This provides `git`, `make`, compilers, and other essentials.

### Homebrew

Install Homebrew (the macOS package manager):
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**For Apple Silicon Macs (M1/M2/M3/M4)**, add Homebrew to your PATH:
```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Verify:
```bash
brew --version
```

---

## 5. Install Git & Clone Repositories

### Verify Git

Git comes with Xcode CLT. Verify:
```bash
git --version
```

### Clone All Repositories

```bash
mkdir -p ~/STP
cd ~/STP

git clone <your-STP_tablets-repo-url> STP_tablets
git clone <your-STP_scripts-repo-url> STP_scripts
git clone <your-STP_healthdash-repo-url> STP_healthdash
git clone <your-STP_THRFiles_Current-repo-url> STP_THRFiles_Current
```

Your directory structure should look like:

```
~/STP/
├── STP_tablets/          # Gateway + Frontend
│   ├── gateway/
│   └── frontend/
├── STP_scripts/          # Middleware proxies
│   ├── x32-flask.py
│   ├── moip-flask.py
│   ├── obs-flask.py
│   └── requirements.txt
├── STP_healthdash/       # Health monitoring
│   ├── app.py
│   ├── config.yaml
│   └── requirements.txt
└── STP_THRFiles_Current/ # THR project files
    └── Main Project v26-012_Mainchurch.hrp
```

---

## 6. Install Python & Create Virtual Environments

### Install Python via Homebrew

macOS comes with a system Python, but you should install a managed version:

```bash
brew install python@3.11
```

Verify:
```bash
python3 --version
pip3 --version
```

> **Note:** On macOS, always use `python3` and `pip3` (not `python` and `pip`).

### Create Virtual Environments

Create separate virtual environments for each service group:

```bash
# Middleware venv
cd ~/STP/STP_scripts
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
deactivate

# Gateway venv
cd ~/STP/STP_tablets/gateway
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
deactivate

# Git pre-commit hook — not tracked by git, must be installed after each fresh clone.
# A tracked copy is kept at hooks/pre-commit for easy setup.
# The hook auto-increments the version in frontend/config/settings.json (format: YY-NNN)
# on every commit.
cp ~/STP/STP_tablets/hooks/pre-commit ~/STP/STP_tablets/.git/hooks/pre-commit
chmod +x ~/STP/STP_tablets/.git/hooks/pre-commit

# HealthDash venv
cd ~/STP/STP_healthdash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
deactivate
```

---

## 7. Install Middleware Dependencies

```bash
cd ~/STP/STP_scripts
source .venv/bin/activate
pip install -r requirements.txt
deactivate
```

Expected packages:
- `flask==3.0.3`
- `waitress==2.1.2`

---

## 8. Install Gateway Dependencies

```bash
cd ~/STP/STP_tablets/gateway
source .venv/bin/activate
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

## 9. Install HealthDash Dependencies

```bash
cd ~/STP/STP_healthdash
source .venv/bin/activate
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

## 10. Configure Environment Variables & Secrets

### Create the `.env` file

The gateway uses `python-dotenv` to load secrets. Copy the example and fill in real values:

```bash
cd ~/STP/STP_tablets/gateway
cp .env.example .env
```

Edit `~/STP/STP_tablets/gateway/.env` with your actual credentials:

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
> ```bash
> python3 -c "import secrets; print(secrets.token_hex(32))"
> ```

> **How to get a Home Assistant long-lived access token:**
> 1. Go to your HA instance > Profile (bottom-left)
> 2. Scroll to "Long-Lived Access Tokens"
> 3. Click "Create Token", name it "STP Gateway", copy the token

---

## 11. Configure the Gateway

### Edit `config.yaml`

The main configuration file is at `~/STP/STP_tablets/gateway/config.yaml`. Key settings to verify/update:

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
  MainChurch_Rear:    { ip: "192.168.1.201", name: "Cam1921681201" }
  MainChurch_Altar:   { ip: "192.168.1.202", name: "Cam1921681202" }
  # ... (verify all 10+ cameras)

projectors:
  epson1: { ip: "192.168.1.233", name: "PRJ_FrontLeft" }
  epson2: { ip: "192.168.1.234", name: "PRJ_FrontRight" }
  epson3: { ip: "192.168.1.236", name: "PRJ_RearLeft" }
  epson4: { ip: "192.168.1.235", name: "PRJ_RearRight" }

security:
  allowed_ips:
    - "192.168.1."
    - "10.100."
    - "10.10."
    - "172.16."
    - "127.0.0.1"
    - "47.150."
```

### Edit `macros.yaml`

The macro configuration at `~/STP/STP_tablets/gateway/macros.yaml` defines all automation sequences. Review and verify:
- IR codes match your TV models
- MoIP receiver numbers match your physical wiring
- Home Assistant entity IDs are correct
- WattBox outlet assignments are accurate

### Edit Frontend Config

**`~/STP/STP_tablets/frontend/config/settings.json`** — Verify the HealthDash URL:
```json
{
  "healthCheck": {
    "url": "external.stpauloc.org:20855"
  }
}
```

**`~/STP/STP_tablets/frontend/config/devices.json`** — Verify MoIP transmitter/receiver IDs and scene definitions.

**`~/STP/STP_tablets/frontend/config/permissions.json`** — Verify tablet locations and role assignments.

### Configure Middleware Scripts

The middleware scripts in `STP_scripts/` have hardcoded values. Verify these in each file:

**`x32-flask.py`:**
- `X32_MIXER_IP` = `192.168.1.231`
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

Edit `~/STP/STP_healthdash/config.yaml`:
- Verify all service URLs and ports
- Set the dashboard password
- Set the Home Assistant URL and token (for recovery actions)
- Verify alert webhook URL

---

## 12. Install & Configure OBS Studio

### Install OBS

```bash
brew install --cask obs
```

Or download from https://obsproject.com/download (choose macOS).

### Configure OBS

1. **Launch OBS Studio** from Applications
2. **Enable WebSocket Server:**
   - Go to **Tools > WebSocket Server Settings**
   - Check **"Enable WebSocket Server"**
   - Port: **4455** (default)
   - If you set a password, set `OBS_WS_PASSWORD` environment variable for the OBS middleware
3. **Import your scenes and profiles** from the old machine:
   - Copy the OBS profile folder from the old machine:
     - macOS location: `~/Library/Application Support/obs-studio/`
   - Contains: `basic/profiles/`, `basic/scenes/`, `plugin_config/`
4. **Configure streaming settings** (stream key, encoder, bitrate, etc.)

### Auto-start OBS on Login

1. **System Settings > General > Login Items**
2. Click **+** and add **OBS Studio** from `/Applications/`
3. OBS will launch automatically when you log in

> **Important:** OBS requires a GUI session (it can't run headless). If the Mac is set to auto-login, OBS will start with the desktop session. If the Mac is a headless server, you'll need a virtual display driver (see [Mac-Specific Considerations](#22-mac-specific-considerations)).

---

## 13. Install & Configure The Home Remote (THR)

The Home Remote (THR) is the **legacy** tablet control app. It runs on Android/iOS tablets and uses `.hrp` project files.

### On the Server (Mac)

1. The THR project files are in `~/STP/STP_THRFiles_Current/`:
   - `Main Project v26-012_Mainchurch.hrp` (latest version)
2. **THR Designer is Windows-only** — if you need to edit `.hrp` files on Mac:
   - Use a Windows VM (Parallels, VMware Fusion, or UTM)
   - Or use Boot Camp (Intel Macs only)
   - Or edit on a separate Windows machine
3. The `.hrp` file is a self-contained project — no server-side component needed on the Mac

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

> **Note:** The new web-based frontend (`STP_tablets/frontend/`) is the modern replacement for THR. Both can run simultaneously during transition.

---

## 14. Install & Configure Camlytics

### Camlytics on macOS

Camlytics is **primarily a Windows application**. On macOS, you have these options:

**Option A: Use Camlytics Cloud only (Recommended)**
- The gateway already pulls data from Camlytics Cloud API
- No local Camlytics installation needed if analytics are processed in the cloud
- The existing report URLs in `config.yaml` will continue to work

**Option B: Run Camlytics in a Windows VM**
- Use Parallels Desktop, VMware Fusion, or UTM to run Windows
- Install Camlytics in the VM
- Configure camera feeds (RTSP streams from UniFi NVR)

**Option C: Alternative people-counting software**
- Some alternatives run natively on macOS (e.g., Frigate NVR in Docker)

### Camlytics Cloud Integration (No Installation Required)

The gateway pulls data from Camlytics Cloud API. These URLs are configured in `config.yaml`:

```yaml
camlytics:
  communion_url: "https://cloud.camlytics.com/feed/report/<your-report-id>"
  occupancy_url_peak: "https://cloud.camlytics.com/feed/report/<your-report-id>"
  occupancy_url_live: "https://cloud.camlytics.com/feed/report/<your-report-id>"
  enter_url: "https://cloud.camlytics.com/feed/report/<your-report-id>"
```

### Install ffprobe (for RTSP camera health checks)

```bash
brew install ffmpeg
```

Verify:
```bash
ffprobe -version
```

---

## 15. Start All Services

Services must start in this specific order because of dependencies.

### Manual Startup (for testing)

Open **5 separate Terminal windows** (or use Terminal tabs with `Cmd+T`):

**Tab 1 — X32 Middleware:**
```bash
cd ~/STP/STP_scripts
source .venv/bin/activate
python3 x32-flask.py
```

**Tab 2 — MoIP Middleware:**
```bash
cd ~/STP/STP_scripts
source .venv/bin/activate
python3 moip-flask.py
```

**Tab 3 — OBS Middleware:**
```bash
cd ~/STP/STP_scripts
source .venv/bin/activate
python3 obs-flask.py
```

**Tab 4 — STP Gateway** (wait a few seconds after middleware starts):
```bash
cd ~/STP/STP_tablets/gateway
source .venv/bin/activate
python3 gateway.py
```

Gateway CLI options:
```
python3 gateway.py              # Normal mode
python3 gateway.py --mock       # Mock mode (no real devices)
python3 gateway.py --config alt.yaml  # Custom config
```

**Tab 5 — HealthDash:**
```bash
cd ~/STP/STP_healthdash
source .venv/bin/activate
python3 app.py
```

### Startup Shell Script

Create `~/STP/start-all.sh`:

```bash
#!/bin/bash
# ============================================
#  STP AV Control System — Start All Services
# ============================================

STP_DIR="$HOME/STP"
LOG_DIR="$STP_DIR/logs"
mkdir -p "$LOG_DIR"

echo "============================================"
echo " Starting STP AV Control System"
echo "============================================"

echo "[1/5] Starting X32 Middleware..."
cd "$STP_DIR/STP_scripts"
source .venv/bin/activate
nohup python3 x32-flask.py > "$LOG_DIR/x32-startup.log" 2>&1 &
echo "  PID: $!"
deactivate

echo "[2/5] Starting MoIP Middleware..."
cd "$STP_DIR/STP_scripts"
source .venv/bin/activate
nohup python3 moip-flask.py > "$LOG_DIR/moip-startup.log" 2>&1 &
echo "  PID: $!"
deactivate

echo "[3/5] Starting OBS Middleware..."
cd "$STP_DIR/STP_scripts"
source .venv/bin/activate
nohup python3 obs-flask.py > "$LOG_DIR/obs-startup.log" 2>&1 &
echo "  PID: $!"
deactivate

echo "Waiting for middleware to initialize..."
sleep 5

echo "[4/5] Starting STP Gateway..."
cd "$STP_DIR/STP_tablets/gateway"
source .venv/bin/activate
nohup python3 gateway.py > "$LOG_DIR/gateway-startup.log" 2>&1 &
echo "  PID: $!"
deactivate

echo "Waiting for gateway to initialize..."
sleep 3

echo "[5/5] Starting HealthDash..."
cd "$STP_DIR/STP_healthdash"
source .venv/bin/activate
nohup python3 app.py > "$LOG_DIR/healthdash-startup.log" 2>&1 &
echo "  PID: $!"
deactivate

echo ""
echo "============================================"
echo " All services started!"
echo " Gateway:    http://localhost:20858/"
echo " HealthDash: http://localhost:20855/"
echo "============================================"
```

Make it executable:
```bash
chmod +x ~/STP/start-all.sh
```

### Stop All Script

Create `~/STP/stop-all.sh`:

```bash
#!/bin/bash
# ============================================
#  STP AV Control System — Stop All Services
# ============================================

echo "Stopping all STP services..."

# Find and kill Python processes for our scripts
pkill -f "x32-flask.py" 2>/dev/null && echo "  Stopped X32 Middleware" || echo "  X32 Middleware not running"
pkill -f "moip-flask.py" 2>/dev/null && echo "  Stopped MoIP Middleware" || echo "  MoIP Middleware not running"
pkill -f "obs-flask.py" 2>/dev/null && echo "  Stopped OBS Middleware" || echo "  OBS Middleware not running"
pkill -f "gateway.py" 2>/dev/null && echo "  Stopped STP Gateway" || echo "  STP Gateway not running"
pkill -f "STP_healthdash.*app.py" 2>/dev/null && echo "  Stopped HealthDash" || echo "  HealthDash not running"

echo "All services stopped."
```

Make it executable:
```bash
chmod +x ~/STP/stop-all.sh
```

---

## 16. Automate Startup with launchd

macOS uses `launchd` (not systemd) for service management. Create plist files for each service.

### Create launchd Service Files

**`~/Library/LaunchAgents/com.stpaul.x32-middleware.plist`**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.stpaul.x32-middleware</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/STP/STP_scripts/.venv/bin/python3</string>
        <string>x32-flask.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/STP/STP_scripts</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/x32-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/x32-launchd-err.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

**`~/Library/LaunchAgents/com.stpaul.moip-middleware.plist`**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.stpaul.moip-middleware</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/STP/STP_scripts/.venv/bin/python3</string>
        <string>moip-flask.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/STP/STP_scripts</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/moip-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/moip-launchd-err.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

**`~/Library/LaunchAgents/com.stpaul.obs-middleware.plist`**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.stpaul.obs-middleware</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/STP/STP_scripts/.venv/bin/python3</string>
        <string>obs-flask.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/STP/STP_scripts</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/obs-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/obs-launchd-err.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

**`~/Library/LaunchAgents/com.stpaul.gateway.plist`**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.stpaul.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/STP/STP_tablets/gateway/.venv/bin/python3</string>
        <string>gateway.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/STP/STP_tablets/gateway</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/gateway-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/gateway-launchd-err.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

**`~/Library/LaunchAgents/com.stpaul.healthdash.plist`**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.stpaul.healthdash</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/STP/STP_healthdash/.venv/bin/python3</string>
        <string>app.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/STP/STP_healthdash</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/healthdash-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/STP/logs/healthdash-launchd-err.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

> **IMPORTANT:** Replace `YOUR_USERNAME` with your actual macOS username in ALL plist files. Find it with: `whoami`

### Setup Script for launchd

Create `~/STP/setup-launchd.sh` to automate the setup:

```bash
#!/bin/bash
# ============================================
#  Setup launchd services for STP
# ============================================

USERNAME=$(whoami)
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/STP/logs"

mkdir -p "$LOG_DIR"

echo "Setting up launchd services for user: $USERNAME"

# Fix username in all plist files
for plist in "$PLIST_DIR"/com.stpaul.*.plist; do
    if [ -f "$plist" ]; then
        sed -i '' "s/YOUR_USERNAME/$USERNAME/g" "$plist"
        echo "  Updated: $(basename $plist)"
    fi
done

echo ""
echo "Loading services..."

# Load in dependency order
launchctl load "$PLIST_DIR/com.stpaul.x32-middleware.plist"
echo "  Loaded X32 Middleware"

launchctl load "$PLIST_DIR/com.stpaul.moip-middleware.plist"
echo "  Loaded MoIP Middleware"

launchctl load "$PLIST_DIR/com.stpaul.obs-middleware.plist"
echo "  Loaded OBS Middleware"

sleep 5
echo "  (waited for middleware init)"

launchctl load "$PLIST_DIR/com.stpaul.gateway.plist"
echo "  Loaded STP Gateway"

sleep 3
echo "  (waited for gateway init)"

launchctl load "$PLIST_DIR/com.stpaul.healthdash.plist"
echo "  Loaded HealthDash"

echo ""
echo "All services loaded. They will auto-start on login."
echo "Check status: launchctl list | grep stpaul"
```

```bash
chmod +x ~/STP/setup-launchd.sh
```

### Managing launchd Services

```bash
# Check if services are running
launchctl list | grep stpaul

# Stop a service
launchctl unload ~/Library/LaunchAgents/com.stpaul.gateway.plist

# Start a service
launchctl load ~/Library/LaunchAgents/com.stpaul.gateway.plist

# Restart a service (unload then load)
launchctl unload ~/Library/LaunchAgents/com.stpaul.gateway.plist
launchctl load ~/Library/LaunchAgents/com.stpaul.gateway.plist

# Stop all STP services
for plist in ~/Library/LaunchAgents/com.stpaul.*.plist; do
    launchctl unload "$plist" 2>/dev/null
done

# Start all STP services
for plist in ~/Library/LaunchAgents/com.stpaul.*.plist; do
    launchctl load "$plist" 2>/dev/null
done
```

---

## 17. Verify Everything Works

### Test Each Service

Open Terminal and run:

```bash
# X32 Middleware
curl http://127.0.0.1:3400/health

# MoIP Middleware
curl http://127.0.0.1:5002/status

# OBS Middleware
curl http://127.0.0.1:4456/health

# STP Gateway
curl http://127.0.0.1:20858/api/health

# HealthDash
curl http://127.0.0.1:20855/api/summary
```

### Test the Frontend

Open Safari or Chrome and navigate to:
```
http://localhost:20858/
```

You should see the St. Paul Control Panel with the home dashboard.

### Test HealthDash

```
http://localhost:20855/
```

### Test from a Tablet

From an iPad or Android tablet on the same network:
```
http://192.168.1.XX:20858/
```
(Replace `XX` with your Mac's IP)

---

## 18. Configure Tablets

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
3. Enable kiosk mode
4. Set the Fully Kiosk admin password to match your `.env` `FULLY_KIOSK_PASSWORD`
5. The gateway communicates with Fully Kiosk on port `2323` for screensaver control

---

## 19. Security Checklist

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
- [ ] macOS firewall is configured correctly
- [ ] macOS auto-login is configured (for unattended operation)
- [ ] FileVault is enabled (disk encryption)
- [ ] macOS is set to never sleep: **System Settings > Energy Saver > Prevent automatic sleeping**

---

## 20. Backup & Maintenance

### What to Back Up

| Item | Location | Frequency |
|------|----------|-----------|
| Gateway config | `~/STP/STP_tablets/gateway/config.yaml` | After any change |
| Gateway secrets | `~/STP/STP_tablets/gateway/.env` | After any change |
| Macros | `~/STP/STP_tablets/gateway/macros.yaml` | After any change |
| Frontend config | `~/STP/STP_tablets/frontend/config/` | After any change |
| HealthDash config | `~/STP/STP_healthdash/config.yaml` | After any change |
| Audit database | `~/STP/STP_tablets/gateway/stp_gateway.db` | Weekly |
| OBS profiles | `~/Library/Application Support/obs-studio/` | After scene changes |
| THR project files | `~/STP/STP_THRFiles_Current/` | After updates |
| launchd plists | `~/Library/LaunchAgents/com.stpaul.*.plist` | After changes |

### Time Machine Backup

macOS Time Machine will automatically back up everything. Ensure:
1. An external drive or network storage is connected
2. **System Settings > General > Time Machine** is configured
3. The `~/STP/` directory is NOT excluded

### Database Maintenance

The gateway audit log grows over time. Periodically clean it:

```bash
cd ~/STP/STP_tablets/gateway
source .venv/bin/activate
python3 -c "
import sqlite3
conn = sqlite3.connect('stp_gateway.db')
conn.execute(\"DELETE FROM audit_log WHERE timestamp < datetime('now', '-30 days')\")
conn.execute('VACUUM')
conn.close()
print('Done — old audit entries purged')
"
deactivate
```

### Log Files

Logs auto-rotate (5 MB, 5 backups):
- Gateway: `~/STP/STP_tablets/gateway/logs/stp-gateway.log`
- HealthDash: `~/STP/STP_healthdash/logs/healthdash.log`
- launchd logs: `~/STP/logs/*.log`

### Updating Code

```bash
cd ~/STP/STP_tablets && git pull origin main
cd ~/STP/STP_scripts && git pull origin main
cd ~/STP/STP_healthdash && git pull origin main
```

Then restart the affected services:
```bash
# Example: restart gateway
launchctl unload ~/Library/LaunchAgents/com.stpaul.gateway.plist
launchctl load ~/Library/LaunchAgents/com.stpaul.gateway.plist
```

---

## 21. Troubleshooting

### Service won't start

```bash
# Check if port is already in use
lsof -i :20858
lsof -i :3400

# Validate YAML config
cd ~/STP/STP_tablets/gateway
source .venv/bin/activate
python3 -c "import yaml; yaml.safe_load(open('config.yaml')); print('Config OK')"

# Run gateway in mock mode to test without devices
python3 gateway.py --mock

# Check launchd logs
cat ~/STP/logs/gateway-launchd-err.log
```

### Can't reach devices

```bash
# Test network connectivity
ping 192.168.1.231        # X32 Mixer
ping 192.168.1.201        # First PTZ camera
ping 192.168.1.233        # First projector
ping 192.168.1.245        # Home Assistant

# Test MoIP network (may need VPN/VLAN)
ping 10.100.20.11

# Check routing table
netstat -rn
```

### Tablets can't connect

1. Verify the tablet is on the `192.168.1.x` network
2. Test from the tablet browser: `http://<mac-ip>:20858/api/health`
3. Check macOS firewall isn't blocking the port
4. Check the gateway logs for connection errors

### OBS middleware can't connect to OBS

1. Verify OBS Studio is running
2. Verify WebSocket Server is enabled: **Tools > WebSocket Server Settings**
3. Check port 4455 is correct
4. If password-protected, set `OBS_WS_PASSWORD`

### launchd service keeps restarting

```bash
# Check the error log
cat ~/STP/logs/<service>-launchd-err.log

# Check launchd status (exit code)
launchctl list | grep stpaul

# Common causes:
# - Wrong Python path in plist (check with: which python3)
# - Missing .venv (recreate it)
# - Bad config file (validate YAML)
# - Port already in use
```

### Python/pip issues on macOS

```bash
# If "python3" not found after brew install:
brew link python@3.11

# If pip packages fail to install:
pip3 install --upgrade pip setuptools wheel

# If eventlet has issues on Apple Silicon:
CFLAGS="-I$(brew --prefix)/include" pip3 install eventlet
```

### Permission denied errors

```bash
# Fix file permissions
chmod -R u+rw ~/STP/

# Fix plist permissions
chmod 644 ~/Library/LaunchAgents/com.stpaul.*.plist
```

---

## 22. Mac-Specific Considerations

### Prevent Sleep (Critical for Server)

The Mac must never sleep or it will stop serving requests:

1. **System Settings > Energy Saver** (or Battery > Options on MacBooks):
   - Set "Turn display off after" to a reasonable time (display can sleep)
   - Uncheck "Put hard disks to sleep when possible"
   - Check **"Prevent automatic sleeping when the display is off"**
   - Check **"Wake for network access"**
2. Or via Terminal:
   ```bash
   # Prevent sleep entirely (Mac Mini / desktop)
   sudo pmset -a sleep 0
   sudo pmset -a disablesleep 1

   # Allow wake on network (Wake-on-LAN)
   sudo pmset -a womp 1
   ```

### Auto-Login (Unattended Operation)

For a dedicated server Mac that should start services after a power outage:

1. **System Settings > Users & Groups > Automatic Login**
2. Select the user account
3. This requires disabling FileVault (trade-off: convenience vs. security)

Alternative: Enable SSH and manage remotely:
```bash
# Enable Remote Login (SSH)
sudo systemsetup -setremotelogin on
```

### Headless Mac Mini (No Display Connected)

If the Mac Mini runs without a monitor:

1. **Screen Sharing** (built-in VNC): **System Settings > General > Sharing > Screen Sharing**
2. **SSH Access**: **System Settings > General > Sharing > Remote Login**
3. For OBS to work headless, you may need a **dummy HDMI plug** (HDMI display emulator dongle) to keep the GPU active
4. Access OBS remotely via VNC/Screen Sharing

### macOS Updates

Configure updates carefully for a production server:

1. **System Settings > General > Software Update > Automatic Updates**
2. Uncheck **"Install macOS updates"** (do these manually during maintenance)
3. Keep **"Install Security Responses and system files"** checked
4. Schedule update reboots during non-service hours

### Homebrew Maintenance

Periodically update Homebrew and installed packages:

```bash
brew update
brew upgrade
brew cleanup
```

> **Warning:** Only do this during a maintenance window. Python upgrades may require recreating virtual environments.

---

## Quick Reference Card

```
GATEWAY:        http://<server>:20858/
HEALTHDASH:     http://<server>:20855/
SETTINGS PIN:   (set in .env)

START ORDER:    x32-flask → moip-flask → obs-flask → gateway → healthdash

MOCK MODE:      cd ~/STP/STP_tablets/gateway && source .venv/bin/activate && python3 gateway.py --mock

START ALL:      ~/STP/start-all.sh
STOP ALL:       ~/STP/stop-all.sh

LOGS:
  Gateway:      ~/STP/STP_tablets/gateway/logs/stp-gateway.log
  HealthDash:   ~/STP/STP_healthdash/logs/healthdash.log
  launchd:      ~/STP/logs/*.log

CONFIG FILES:
  Gateway:      ~/STP/STP_tablets/gateway/config.yaml
  Secrets:      ~/STP/STP_tablets/gateway/.env
  Macros:       ~/STP/STP_tablets/gateway/macros.yaml
  Frontend:     ~/STP/STP_tablets/frontend/config/{settings,devices,permissions}.json
  HealthDash:   ~/STP/STP_healthdash/config.yaml
  launchd:      ~/Library/LaunchAgents/com.stpaul.*.plist

REPOS:
  STP_tablets           Gateway + Frontend
  STP_scripts           Middleware (X32, MoIP, OBS)
  STP_healthdash        Health Monitoring
  STP_THRFiles_Current  Legacy THR Project Files

OBS PROFILES:   ~/Library/Application Support/obs-studio/

SERVICE MANAGEMENT:
  launchctl list | grep stpaul                     # Check status
  launchctl unload ~/Library/LaunchAgents/com.stpaul.gateway.plist   # Stop
  launchctl load ~/Library/LaunchAgents/com.stpaul.gateway.plist     # Start
```
