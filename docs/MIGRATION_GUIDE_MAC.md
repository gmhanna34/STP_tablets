# STP AV Control System — Migration Guide (macOS / Mac Mini)

> **Purpose:** Step-by-step instructions to install, configure, and run the St. Paul AV Control System on a **fresh Mac** (Mac Mini, MacBook, iMac, etc.). The system runs as a single consolidated gateway process from one repository (`STP_tablets`). OBS Studio and Camlytics remain on the existing Windows PC.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Prerequisites & Required Downloads](#2-prerequisites--required-downloads)
3. [Network Configuration](#3-network-configuration)
4. [Install Developer Tools & Homebrew](#4-install-developer-tools--homebrew)
5. [Install Git & Clone Repository](#5-install-git--clone-repository)
6. [Install Python & Create Virtual Environment](#6-install-python--create-virtual-environment)
7. [Install Gateway Dependencies](#7-install-gateway-dependencies)
8. [Configure Environment Variables & Secrets](#8-configure-environment-variables--secrets)
9. [Configure the Gateway](#9-configure-the-gateway)
10. [Start the Gateway](#10-start-the-gateway)
11. [Automate Startup with launchd](#11-automate-startup-with-launchd)
12. [Verify Everything Works](#12-verify-everything-works)
13. [Configure Tablets](#13-configure-tablets)
14. [Security Checklist](#14-security-checklist)
15. [Backup & Maintenance](#15-backup--maintenance)
16. [Troubleshooting](#16-troubleshooting)
17. [Mac-Specific Considerations](#17-mac-specific-considerations)

---

## 1. System Overview

The system runs as a **single consolidated gateway process** from one repository:

| Component | Port | Description |
|-----------|------|-------------|
| STP Gateway | 20858 | Unified API + WebSocket hub + all protocol modules + health monitoring + static file server |

All middleware (X32, MoIP, OBS) and HealthDash have been absorbed into the gateway. OBS Studio and Camlytics remain on the existing Windows PC.

### Architecture

```
MAC MINI (new)                         WINDOWS PC (existing)
─────────────────────────              ─────────────────────
STP Gateway :20858                     OBS Studio :4455
 ├─ REST API + Socket.IO               Camlytics (analytics)
 ├─ Static frontend
 ├─ X32 module ──── OSC/UDP ──────►  Behringer X32 (.60.231)
 ├─ MoIP module ─── Telnet ──────►   Binary MoIP (10.100.20.11)
 ├─ OBS module ──── WebSocket ───►   OBS Studio (Windows IP:4455)
 ├─ PTZ module ──── HTTP/CGI ────►   10 cameras (.60.201-.210)
 ├─ Epson module ── HTTP ────────►   4 projectors (.60.233-.236)
 ├─ HA module ───── REST ────────►   Home Assistant (.60.245)
 ├─ Health monitor (built-in, 30+ checks)
 ├─ Occupancy module (Camlytics Cloud API)
 ├─ Announcement module (TTS via edge-tts + WiiM)
 ├─ Event automation (calendar-driven macros)
 ├─ Macro engine
 └─ Audit log (SQLite)
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
| ffprobe (ffmpeg) | Latest | `brew install ffmpeg` (for RTSP health checks) |
| A text editor | — | VS Code (`brew install --cask visual-studio-code`) |

> **Note:** OBS Studio and Camlytics stay on the existing Windows PC (they need GPU/display access). The gateway's OBS module connects to the Windows machine's IP remotely.

### Hardware Requirements

- macOS 13 Ventura or later (Apple Silicon or Intel)
- Minimum 8 GB RAM (16 GB recommended for OBS streaming)
- SSD (standard on all modern Macs)
- Ethernet adapter recommended for reliable network (USB-C to Ethernet for Mac Mini)
- Network access to `10.100.60.x` subnet
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
   - IP Address: `10.100.60.10` (or your chosen address)
   - Subnet Mask: `255.255.255.0`
   - Router: `10.100.60.1`
6. Select **DNS** tab, add: `10.100.60.1`
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
pass in on en0 proto tcp from any to any port { 20858 }
```

### Required Network Routes

Ensure the Mac can reach:

| Destination | Purpose |
|-------------|---------|
| 10.100.60.201-210 | PTZ Cameras |
| 10.100.60.233-236 | Epson Projectors (epson1-4) |
| 10.100.60.231 | Behringer X32 Mixer |
| 10.100.60.61-67 | WattBox PDUs |
| 10.100.60.245:8123 | Home Assistant |
| 10.100.60.193:25105 | Insteon Hub |
| 10.100.20.11:23 | MoIP Controller (may require routing/VLAN) |
| cloud.camlytics.com | Camlytics Cloud |

Test connectivity:
```bash
ping 10.100.60.231
ping 10.100.60.201
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

## 5. Install Git & Clone Repository

### Verify Git

Git comes with Xcode CLT. Verify:
```bash
git --version
```

### Clone the Repository

Only one repo is needed -- everything is consolidated:

```bash
mkdir -p ~/STP
cd ~/STP

git clone <your-STP_tablets-repo-url> STP_tablets
```

Your directory structure should look like:

```
~/STP/
└── STP_tablets/          # Gateway + Frontend (everything)
    ├── gateway/          # Python backend (17 modules)
    ├── frontend/         # Tablet web UI
    └── hooks/            # Git hooks (pre-commit)
```

---

## 6. Install Python & Create Virtual Environment

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

### Create Virtual Environment

```bash
cd ~/STP/STP_tablets/gateway
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
deactivate
```

### Install Pre-commit Hook

The pre-commit hook runs the test suite and auto-increments the version before each commit. A tracked copy is kept at `hooks/pre-commit`:

```bash
cp ~/STP/STP_tablets/hooks/pre-commit ~/STP/STP_tablets/.git/hooks/pre-commit
chmod +x ~/STP/STP_tablets/.git/hooks/pre-commit
```

---

## 7. Install Gateway Dependencies

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
- `xair-api>=2.4.0` (X32 mixer OSC/UDP)
- `websocket-client>=1.6.0` (OBS WebSocket)
- `pandas>=2.0` (occupancy analytics)
- `bcrypt>=4.0` (user authentication)
- `edge-tts>=7.0` (TTS announcements)
- `pytest>=8.0` / `pytest-cov>=5.0` (testing)

---

## 8. Configure Environment Variables & Secrets

### Create the `.env` file

The gateway uses `python-dotenv` to load secrets. Copy the example and fill in real values:

```bash
cd ~/STP/STP_tablets/gateway
cp .env.example .env
```

Edit `~/STP/STP_tablets/gateway/.env` with your actual credentials:

```env
# STP Gateway Secrets — keep out of version control

# Home Assistant
HA_URL=https://your-ha-instance.ui.nabu.casa
HA_TOKEN=your-long-lived-home-assistant-access-token

# WattBox PDU
WATTBOX_USERNAME=admin
WATTBOX_PASSWORD=your-wattbox-password

# OBS Studio
OBS_WS_PASSWORD=your-obs-websocket-password

# MoIP Video Matrix
MOIP_USERNAME=your-moip-username
MOIP_PASSWORD=your-moip-password
MOIP_HA_WEBHOOK_ID=your-webhook-id

# Fully Kiosk Browser
FULLY_KIOSK_PASSWORD=your-fully-kiosk-password

# Security
FLASK_SECRET_KEY=generate-a-long-random-string-here
SETTINGS_PIN=your-settings-pin
SECURE_PIN=your-secure-pin
REMOTE_AUTH_USER=your-admin-username
REMOTE_AUTH_PASS=your-admin-password

# Health Dashboard Alerts
HEALTHDASH_WEBHOOK_URL=your-webhook-url

# AI Chatbot (optional)
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

## 9. Configure the Gateway

### Edit `config.yaml`

The main configuration file is at `~/STP/STP_tablets/gateway/config.yaml`. Key settings to verify/update:

```yaml
gateway:
  host: "0.0.0.0"
  port: 20858
  static_dir: "../frontend"    # Relative path to frontend directory

# middleware: null              # No middleware section needed (all absorbed)

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

**Important for Mac migration:** Update the OBS WebSocket URL in config.yaml to point to the Windows PC's IP instead of `127.0.0.1`:
```yaml
obs:
  ws_url: "ws://<windows-pc-ip>:4455"
```

### Edit `macros.yaml`

The macro configuration at `~/STP/STP_tablets/gateway/macros.yaml` defines all automation sequences. Review and verify:
- IR codes match your TV models
- MoIP receiver numbers match your physical wiring
- Home Assistant entity IDs are correct
- WattBox outlet assignments are accurate

### Edit Frontend Config

**`~/STP/STP_tablets/frontend/config/devices.json`** — Verify MoIP transmitter/receiver IDs and scene definitions.

**`~/STP/STP_tablets/frontend/config/permissions.json`** — Verify tablet locations and role assignments.

---

## 10. Start the Gateway

Only one service needs to start -- the consolidated gateway handles everything.

### Manual Startup (for testing)

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

### Startup Shell Script

Create `~/STP/start-gateway.sh`:

```bash
#!/bin/bash
# ============================================
#  STP AV Control System — Start Gateway
# ============================================

STP_DIR="$HOME/STP"
LOG_DIR="$STP_DIR/logs"
mkdir -p "$LOG_DIR"

echo "Starting STP Gateway..."
cd "$STP_DIR/STP_tablets/gateway"
source .venv/bin/activate
nohup python3 gateway.py > "$LOG_DIR/gateway-startup.log" 2>&1 &
echo "  PID: $!"
deactivate

echo ""
echo "============================================"
echo " Gateway started!"
echo " URL: http://localhost:20858/"
echo "============================================"
```

Make it executable:
```bash
chmod +x ~/STP/start-gateway.sh
```

### Stop Script

Create `~/STP/stop-gateway.sh`:

```bash
#!/bin/bash
echo "Stopping STP Gateway..."
pkill -f "gateway.py" 2>/dev/null && echo "  Stopped" || echo "  Not running"
```

Make it executable:
```bash
chmod +x ~/STP/stop-gateway.sh
```

---

## 11. Automate Startup with launchd

macOS uses `launchd` (not systemd) for service management. Only one plist file is needed.

### Create launchd Service File

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
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/YOUR_USERNAME/STP/STP_tablets/gateway/.venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
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

> **IMPORTANT:** Replace `YOUR_USERNAME` with your actual macOS username (appears 6 times). Find it with: `whoami`
>
> **Why `EnvironmentVariables`?** launchd starts services with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). Without this block, the gateway can't find `ffprobe` (Homebrew) for RTSP camera health checks or `edge-tts` (venv) for TTS announcements. Both degrade gracefully (ffprobe falls back to TCP, edge-tts returns an error) but won't function fully.

### Setup Script

Create `~/STP/setup-launchd.sh`:

```bash
#!/bin/bash
# ============================================
#  Setup launchd service for STP Gateway
# ============================================

USERNAME=$(whoami)
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/STP/logs"

mkdir -p "$LOG_DIR"

echo "Setting up launchd service for user: $USERNAME"

# Fix username in plist file
PLIST="$PLIST_DIR/com.stpaul.gateway.plist"
if [ -f "$PLIST" ]; then
    sed -i '' "s/YOUR_USERNAME/$USERNAME/g" "$PLIST"
    echo "  Updated: $(basename $PLIST)"
fi

echo "Loading service..."
launchctl load "$PLIST"
echo "  Loaded STP Gateway"

echo ""
echo "Gateway loaded. It will auto-start on login."
echo "Check status: launchctl list | grep stpaul"
```

```bash
chmod +x ~/STP/setup-launchd.sh
```

### Managing the launchd Service

```bash
# Check if service is running
launchctl list | grep stpaul

# Stop the gateway
launchctl unload ~/Library/LaunchAgents/com.stpaul.gateway.plist

# Start the gateway
launchctl load ~/Library/LaunchAgents/com.stpaul.gateway.plist

# Restart (unload then load)
launchctl unload ~/Library/LaunchAgents/com.stpaul.gateway.plist
launchctl load ~/Library/LaunchAgents/com.stpaul.gateway.plist
```

---

## 12. Verify Everything Works

### Test the Gateway

Open Terminal and run:

```bash
curl http://127.0.0.1:20858/api/health
# Expected: {"healthy": true, "version": "...", "mock_mode": false}
```

### Test the Frontend

Open Safari or Chrome and navigate to:
```
http://localhost:20858/
```

You should see the St. Paul Control Panel with the home dashboard.

### Test Health Monitoring

Navigate to `http://localhost:20858/#health` in the browser to see the health dashboard.

### Test from a Tablet

From an iPad or Android tablet on the same network:
```
http://10.100.60.XX:20858/
```
(Replace `XX` with your Mac's IP)

---

## 13. Configure Tablets

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

## 14. Security Checklist

Before going live, verify:

- [ ] Set `SETTINGS_PIN` in `.env` (change from default `1234`)
- [ ] Set `FLASK_SECRET_KEY` in `.env` to a random string
- [ ] Set `REMOTE_AUTH_USER` and `REMOTE_AUTH_PASS` in `.env`
- [ ] Changed WattBox password from default `WBAdmin1`
- [ ] Verified `allowed_ips` in `config.yaml` matches your actual network
- [ ] Home Assistant long-lived access token is valid
- [ ] `.env` file is NOT committed to git (check `.gitignore`)
- [ ] Only port 20858 is accessible from the LAN
- [ ] OBS WebSocket password is set (if accessible beyond localhost)
- [ ] macOS firewall is configured correctly
- [ ] macOS auto-login is configured (for unattended operation)
- [ ] FileVault is enabled (disk encryption)
- [ ] macOS is set to never sleep: **System Settings > Energy Saver > Prevent automatic sleeping**

---

## 15. Backup & Maintenance

### What to Back Up

| Item | Location | Frequency |
|------|----------|-----------|
| Gateway config | `~/STP/STP_tablets/gateway/config.yaml` | After any change |
| Gateway secrets | `~/STP/STP_tablets/gateway/.env` | After any change |
| Macros | `~/STP/STP_tablets/gateway/macros.yaml` | After any change |
| Announcements | `~/STP/STP_tablets/gateway/announcements.yaml` | After any change |
| Users | `~/STP/STP_tablets/gateway/users.yaml` | After any change |
| Frontend config | `~/STP/STP_tablets/frontend/config/` | After any change |
| Audit database | `~/STP/STP_tablets/gateway/stp_gateway.db` | Weekly |
| launchd plist | `~/Library/LaunchAgents/com.stpaul.gateway.plist` | After changes |

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
- launchd logs: `~/STP/logs/*.log`

### Updating Code

```bash
cd ~/STP/STP_tablets && git pull origin main
```

Then restart the gateway:
```bash
launchctl unload ~/Library/LaunchAgents/com.stpaul.gateway.plist
launchctl load ~/Library/LaunchAgents/com.stpaul.gateway.plist
```

---

## 16. Troubleshooting

### Gateway won't start

```bash
# Check if port is already in use
lsof -i :20858

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
ping 10.100.60.231        # X32 Mixer
ping 10.100.60.201        # First PTZ camera
ping 10.100.60.233        # First projector
ping 10.100.60.245        # Home Assistant

# Test MoIP network (may need VPN/VLAN)
ping 10.100.20.11

# Check routing table
netstat -rn
```

### Tablets can't connect

1. Verify the tablet is on the `10.100.60.x` network
2. Test from the tablet browser: `http://<mac-ip>:20858/api/health`
3. Check macOS firewall isn't blocking the port
4. Check the gateway logs for connection errors

### OBS module can't connect to OBS

1. Verify OBS Studio is running on the Windows PC
2. Verify WebSocket Server is enabled: **Tools > WebSocket Server Settings**
3. Check the OBS WebSocket URL in `config.yaml` points to the Windows PC's IP (not `127.0.0.1`)
4. If password-protected, set `OBS_WS_PASSWORD` in `.env`

### launchd service keeps restarting

```bash
# Check the error log
cat ~/STP/logs/gateway-launchd-err.log

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
chmod 644 ~/Library/LaunchAgents/com.stpaul.gateway.plist
```

---

## 17. Mac-Specific Considerations

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

> **Note:** OBS Studio runs on the Windows PC, not the Mac. The gateway connects to it remotely via WebSocket.

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
HEALTH PAGE:    http://<server>:20858/#health
SETTINGS PIN:   (set in .env)

START:          cd ~/STP/STP_tablets/gateway && source .venv/bin/activate && python3 gateway.py
MOCK MODE:      cd ~/STP/STP_tablets/gateway && source .venv/bin/activate && python3 gateway.py --mock

START SCRIPT:   ~/STP/start-gateway.sh
STOP SCRIPT:    ~/STP/stop-gateway.sh

LOGS:
  Gateway:      ~/STP/STP_tablets/gateway/logs/stp-gateway.log
  launchd:      ~/STP/logs/gateway-launchd.log

CONFIG FILES:
  Gateway:      ~/STP/STP_tablets/gateway/config.yaml
  Secrets:      ~/STP/STP_tablets/gateway/.env
  Macros:       ~/STP/STP_tablets/gateway/macros.yaml
  Announcements:~/STP/STP_tablets/gateway/announcements.yaml
  Users:        ~/STP/STP_tablets/gateway/users.yaml
  Frontend:     ~/STP/STP_tablets/frontend/config/{settings,devices,permissions}.json
  launchd:      ~/Library/LaunchAgents/com.stpaul.gateway.plist

REPO:           STP_tablets (single repo — everything consolidated)

TESTS:          cd ~/STP/STP_tablets/gateway && pytest tests/

SERVICE MANAGEMENT:
  launchctl list | grep stpaul                     # Check status
  launchctl unload ~/Library/LaunchAgents/com.stpaul.gateway.plist   # Stop
  launchctl load ~/Library/LaunchAgents/com.stpaul.gateway.plist     # Start
```
