# STP AV Control System -- Page-by-Page Guide

> **Audience:** AV operators and volunteers. This guide walks through every page of the tablet control panel, explaining what you see and how to use it.
>
> **Screenshot placeholders:** Sections marked with `[SCREENSHOT: ...]` are where you should insert actual screenshots from the running system.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Home Page](#1-home-page)
3. [Main Church Page](#2-main-church-page)
4. [Chapel Page](#3-chapel-page)
5. [Social Hall Page](#4-social-hall-page)
6. [Gym Page](#5-gym-page)
7. [Conference Room Page](#6-conference-room-page)
8. [Live Stream Page](#7-live-stream-page)
9. [Source Routing Page](#8-source-routing-page)
10. [Security Page](#9-security-page)
11. [Health Page](#10-health-page)
12. [Occupancy Page](#11-occupancy-page)
13. [Settings Page](#12-settings-page)
14. [Common Tasks (How-To)](#common-tasks)
15. [Tablet Permissions](#tablet-permissions)
16. [Troubleshooting for Operators](#troubleshooting-for-operators)

---

## Getting Started

### First-Time Setup

1. Open the browser on the tablet and navigate to `http://<server-ip>:20858/`
2. On first visit, the app will ask you to **select your location** (Chapel, Social Hall, A/V Room, etc.)
3. The location determines which pages and controls are visible to you
4. Your selection is saved automatically -- you won't be asked again unless you reset it

### Navigation

- **Tablet (landscape):** Navigation bar across the top with page icons
- **Mobile/portrait:** Hamburger menu (three lines) in the top-left corner
- The **status bar** in the top-right shows:
  - Connection status (green dot = connected, red = disconnected)
  - Current time
  - System health summary

### Understanding Button States

- **Gray** = device is off or inactive
- **Green / highlighted** = device is on
- **Orange** = currently selected video source
- **Red** = recording or streaming is live
- **Battery badge** = shows battery percentage for battery-powered displays
- **Temperature badge** = shows current room temperature on thermostat buttons

[SCREENSHOT: Navigation bar with status indicators]

---

## 1. Home Page

**URL:** `#home`

The Home page is your landing screen after opening the app.

### What You See

- **Welcome message** with your tablet's location name
- **St. Paul logo**
- **AV Help Assistant** button -- tap to open the chat panel and ask questions about the system
- **Restart App** button -- reloads the tablet app (useful if the app becomes unresponsive)

### When to Use

- Starting point after the app loads
- Access the AI help assistant for quick answers
- Restart the app if something looks wrong

[SCREENSHOT: Home page]

---

## 2. Main Church Page

**URL:** `#main`

Controls the main sanctuary AV system -- projectors, audio, climate, and video routing.

### Layout Overview

[SCREENSHOT: Main Church page -- full view]

### Top Section: Quick Actions

Two large buttons at the top:

- **All Systems On** (green) -- runs the complete AV startup sequence (~60 seconds):
  - Lowers projection screens
  - Powers on all 4 projectors
  - Turns on the full audio system
  - Sets Apple TV as the default video source
  - Starts the live stream scene
  - Moves the camera to its default preset
  - Unlocks exterior doors for 5 hours
  - Sets A/C to cool at 69F

- **All Systems Off** (red) -- runs the complete AV shutdown (~30 seconds):
  - Raises screens
  - Powers off projectors and portable displays
  - Turns off audio
  - Turns off A/C

Both buttons show a **step-by-step progress overlay** as they execute.

[SCREENSHOT: Progress overlay during All Systems On]

### Video Section

| Button | Action |
|--------|--------|
| **On / Down** | Turns on video system (screens down, projectors on, cry room TV on) |
| **Off / Up** | Turns off video system (screens up, projectors off, cry room and portables off) |

The "On / Down" button glows green when the video system is active (screens are down).

### Audio Section

| Button | Action |
|--------|--------|
| **On** | Turns on the complete audio system (mixer, amps, mics) |
| **Off** | Turns off audio |

Shows the current **mixer scene name** as a pill badge (e.g., "Worship Service").

### A/C Section

- **Thermostat** button with current temperature badge
- Tap to open the thermostat control (set temperature, fan mode, heat/cool)

### Video Sources

These buttons change what appears on ALL Main Church displays simultaneously. The **active source is highlighted in orange**.

| Button | What Shows on Screen |
|--------|---------------------|
| **Left Podium** | Presenter's laptop from the left podium |
| **Right Podium** | Presenter's laptop from the right podium |
| **Announcements** | Rotating announcement slides |
| **Live Stream** | What YouTube viewers see |
| **Apple TV (No Page #s)** | Hymnal/liturgy app -- clean feed |
| **Apple TV (Page #s)** | Hymnal/liturgy app with page number overlay |
| **Google Streamer** | Cast content from phone/laptop |

[SCREENSHOT: Video source buttons with one highlighted]

### People Counts

- **Occupancy** -- tap to see building occupancy analytics
- **Communion** -- tap to see communion count analytics

### Advanced Settings

Tap "Advanced Settings" at the bottom to expand additional controls:

- **Power tab:** Individual WattBox outlet controls
- **TV Controls tab:** Per-projector on/off, AppleTV restart
- **Video Source tab:** Advanced MoIP routing
- **Baptism / Wedding tab:** Route the baptism room camera to displays
- **Macros tab:** End of Liturgy sequence, Unlock Exterior Doors

---

## 3. Chapel Page

**URL:** `#chapel`

Controls the Chapel TVs, audio, climate, and video routing.

[SCREENSHOT: Chapel page]

### Top Section: Quick Actions

- **All Systems On** (green) -- TVs on, audio on, Apple TV source, live stream scene, camera preset, door unlock, A/C
- **All Systems Off** (red) -- TVs off, audio off, A/C off

### Video Section

- **TVs On** -- powers on Chapel Vizio TV and floating TV (IR commands sent multiple times for reliability). Shows **battery level badge**
- **TVs Off** -- powers off both TVs

### Audio Section

- **Audio On** -- turns on shared audio system + Chapel mics and amp
- **Audio Off** -- turns off Chapel amp and mics

### Video Sources

Buttons are **disabled** when Chapel TVs are off (grayed out).

| Button | Source |
|--------|--------|
| Hall Laptop | Social Hall laptop |
| Apple TV | Chapel Apple TV |
| Windows Display | Windows display adapter |
| Announcements | Announcement slides |
| Google Streamer | Chromecast |
| Live Stream | YouTube live output |

---

## 4. Social Hall Page

**URL:** `#social`

Controls the 8-panel Social Hall video wall, audio, and climate.

[SCREENSHOT: Social Hall page]

### Layout

Same pattern as other room pages:
- **All Systems On / Off** at top
- **Video On / Off** -- controls all 8 display panels (IR + Samsung API, multiple rounds for reliability)
- **Audio On / Off** -- shared audio + Social Hall mics and amp
- **A/C** thermostat
- **8 video source buttons** (Apple TV, Live Stream, Announcements, LOGO, Camera, Laptop, Windows Display, Google Streamer, VBS)

---

## 5. Gym Page

**URL:** `#gym`

Simple controls for the gym TV and audio.

[SCREENSHOT: Gym page]

- **Video On / Off**
- **Audio On / Off**
- **Video Sources:** Live Stream, Announcements

---

## 6. Conference Room Page

**URL:** `#confroom`

Controls two independent TVs, video conferencing, and climate.

[SCREENSHOT: Conference Room page]

### Unique Feature: Two Independent TVs

The left and right TVs can show **different sources** simultaneously. Each has its own on/off and source selection.

### Video Conference

- **On** -- powers on Owl cameras, routes laptop to both TVs
- **Off** -- powers off cameras

### Video Sources

Each TV has 7 source options. The **Apple TV** option switches to direct HDMI 2 (not routed through the MoIP matrix).

---

## 7. Live Stream Page

**URL:** `#stream`

Manages OBS Studio for live streaming and recording, plus camera control.

[SCREENSHOT: Live Stream page -- full view]

### Status Bar (Top)

Always visible status indicators:
- **Connection:** green dot = OBS connected, red = disconnected
- **Stream:** "Off" or pulsing red "LIVE" when streaming
- **Record:** "Off" or pulsing red "Recording"
- **Current Scene:** name of the active OBS scene

### Scenes Panel (Left Side)

Grid of scene buttons -- one per OBS scene. The **active scene is highlighted in orange**.

When you tap a scene:
1. OBS switches to that scene
2. The associated audio/video routing macro runs (e.g., loads the correct X32 mixer scene)

[SCREENSHOT: Scene buttons with one active]

### Active Camera Panel (Right Side)

Shows a **live snapshot** of the camera associated with the current OBS scene.

- **Preset buttons** appear below: Full View (P1), Podium View (P2)
- **Tap the camera image** to open the full PTZ (pan/tilt/zoom) control panel

### PTZ Camera Controls

When you tap the camera image, a control panel opens:

```
        [  Up  ]
[Left]  [Home]  [Right]
        [ Down ]

[Zoom In]  [Zoom Out]

[P1] [P2] [P3]
```

- **Pan/Tilt:** Press and hold to move, release to stop
- **Zoom:** Press and hold to zoom in/out
- **Home:** Returns camera to home position
- **P1/P2/P3:** Jump to saved preset positions

[SCREENSHOT: PTZ control panel]

### Stream & Record Controls

| Button | Action |
|--------|--------|
| **Start Stream** | Begins YouTube live stream |
| **Stop Stream** | Ends stream (confirmation required, 3-min reset scheduled) |
| **Start Record** | Begins local recording |
| **Stop Record** | Ends recording |

### Additional Controls

- **Slides On / Off** -- toggles hymnal page number overlay on stream
- **Live Stream Feed Preview** -- opens a modal to preview what viewers see
- **Advanced Settings** -- Shure mic input, ATEM re-enable, Reset Stream

---

## 8. Source Routing Page

**URL:** `#source`

Advanced video and audio routing, announcements, and system testing.

[SCREENSHOT: Source Routing page tabs]

### Video Tab (Default)

Shows a grid of all **MoIP receivers** (displays) with their current source. You can:
1. Click any receiver row
2. Select a new source from the dropdown
3. The video source switches immediately

Use this when the preset source buttons on room pages don't cover what you need.

### Audio Tab

- **Quick Actions:** Mute All, Unmute All, Reload Scene, Mute Music
- **Mixer Scenes:** Load saved X32 presets by name
- **Advanced link:** Opens the Settings page audio tab for full mixer control

### Announcements Tab

Three sub-tabs:

1. **Presets** -- tap to play pre-defined announcements (Church Closing, Sunday School Starting, etc.)
2. **Sequences** -- start multi-step announcement countdowns (Sunday School Countdown, Closing Countdown)
3. **Custom** -- type any text, choose a voice, and have it spoken through the speakers

[SCREENSHOT: Announcements tab with presets]

### Test Tab

System diagnostic utilities (primarily for technical staff).

---

## 9. Security Page

**URL:** `#security`

PTZ camera control, security camera feeds, and door lock management.

[SCREENSHOT: Security page]

### PTZ Cameras Tab

Grid of 10 PTZ camera cards with live snapshots. Tap any camera to open the full PTZ control panel (same as on the Stream page).

### Security Cameras Tab

Live feeds from fixed security cameras (via Home Assistant). Snapshots refresh every 5-10 seconds.

### Access Control Tab

- Shows door lock status (locked/unlocked)
- Checkboxes to select multiple doors
- **Lock / Unlock** buttons for batch control
- Status refreshes every 10 seconds

---

## 10. Health Page

**URL:** `#health`

Monitors 30+ backend services and devices. Shows which components are healthy, warning, or down.

[SCREENSHOT: Health page with service cards]

### Summary Tiles (Top)

Three color-coded tiles showing counts:
- **Red:** services that are DOWN
- **Yellow:** services with WARNINGS
- **Green:** HEALTHY services

### Service Cards

Each monitored service has a card showing:
- Status dot (green/yellow/red)
- Service name
- Status message (e.g., "OK", "Connection timeout")

**Click a card** to expand and see details (latency, last OK time, sub-components).

**Log button** -- view the last 200 lines of that service's log.

**Restart button** -- trigger a recovery action (if available for that service).

### Behavior

- Cards auto-expand when a service goes down
- Cards auto-collapse when a service recovers
- The page polls for updates every 5 seconds

---

## 11. Occupancy Page

**URL:** `#occupancy`

Building occupancy and communion count analytics from Camlytics camera data.

[SCREENSHOT: Occupancy page with charts]

### KPI Cards (Top Row)

Five summary cards:
- Last service communion count
- Building peak occupancy
- Participation ratio (communion / occupancy %)
- Average communion per service
- Average peak occupancy

### Charts

1. **Building Occupancy Trend** -- line chart showing peak occupancy over time
2. **Communion Count Trend** -- line chart showing communion counts over time
3. **Comparison Bar Chart** -- side-by-side bars comparing occupancy vs. communion
4. **Pacing Drill-Down** -- shows which 15-minute intervals had the most activity (toggleable between Communion and Occupancy modes)

### Week-over-Week Table

Full table of all recorded services with:
- Service date
- Peak occupancy
- Total communion
- Participation percentage
- Visual ratio bar

---

## 12. Settings Page

**URL:** `#settings`

Administrative controls, audio mixer, thermostats, scheduling, and system configuration.

[SCREENSHOT: Settings page tabs]

### Tabs

| Tab | Purpose |
|-----|---------|
| **Power** | WattBox outlet control, EcoFlow battery management, emergency direct power control |
| **Audio** | Full X32 mixer control -- faders, mutes, scenes, bus routing |
| **Thermostats** | All HVAC thermostats with temperature, fan mode, heat/cool selection |
| **TVs** | IR remote controls for individual TVs/projectors (power, input, volume) |
| **Schedule** | Calendar event automation, cron-style scheduled macros |
| **Logs** | Audit log viewer with filters and CSV export |
| **Config** | Read-only view of gateway configuration |
| **Users** | User and tablet management |
| **Admin** | System info, diagnostics, backup/restore |

### Audio Tab Details

The audio tab provides **full mixer control**:

- **Quick Actions:** Mute All, Unmute All, Reload Scene, Mute Music
- **Scene Buttons:** Load any saved X32 mixer scene
- **Channel Strips:** For each of the 32 input channels:
  - Fader (volume slider)
  - Mute button (red when muted)
  - Channel name
- **Aux Inputs** (33-40), **Mix Buses** (1-16), and **DCA Groups** (1-8)

[SCREENSHOT: Audio mixer faders]

### Schedule Tab Details

Two types of automation:

1. **Calendar Events** -- automatically runs setup/teardown macros based on church calendar events
2. **Cron Schedules** -- time-based triggers (e.g., "run Chapel setup at 8:00 AM every Sunday")

---

## Common Tasks

### Sunday Morning Setup

1. Go to the **Main Church** page
2. Tap **All Systems On** (green button)
3. Wait for the progress overlay to complete (~60 seconds)
4. Verify: projectors are on, screens are down, audio badge shows "Worship Service"

### Starting a Live Stream

1. Go to the **Live Stream** page
2. Verify the correct **scene** is selected (highlighted in orange)
3. Tap **Start Stream**
4. The status bar should show "LIVE" in pulsing red
5. Check the camera angle -- tap the camera image to adjust if needed

### Switching Video Sources

1. Go to the room page (Main Church, Chapel, Social Hall, etc.)
2. Tap the desired source button in the **Video Sources** section
3. The active source will highlight in orange
4. All displays in that room will switch to the new source

### Playing an Announcement

1. Go to the **Source Routing** page
2. Tap the **Announcements** tab
3. Choose from Presets (single message), Sequences (timed countdown), or Custom (type your own)
4. Tap the announcement button to play it

### Adjusting Room Temperature

1. Go to the room page
2. Tap the **Thermostat** button (shows current temp badge)
3. Adjust the set point, fan mode, or heat/cool mode in the popup

### End of Service Shutdown

1. Go to the room page
2. Tap **All Systems Off** (red button)
3. Confirm when prompted
4. Wait for shutdown to complete

### Checking System Health

1. Go to the **Health** page (if accessible to your tablet)
2. Look at the summary tiles -- ideally everything is green
3. If something is red, tap the card to see details
4. Use the **Restart** button if available for that service

---

## Tablet Permissions

Not all tablets can access all pages. This is controlled by the tablet's location setting:

| Location | Pages Available |
|----------|----------------|
| **A/V Room** (Full Access) | All pages |
| **Chapel** | Home, Chapel, Stream, Source, Settings |
| **Social Hall** | Home, Social, Stream, Source, Settings |
| **Conference Room** | Home, ConfRoom, Source, Settings |
| **Gym** | Home, Gym, Source, Settings |
| **Lobby** | Home, Source, Settings |
| **Office** | Home, ConfRoom, Source, Security, Settings |

The Health and Occupancy pages are accessible from the Main Church page to Full Access tablets.

---

## Troubleshooting for Operators

### The tablet says "Disconnected"

- Check the red dot in the status bar -- it will show "Reconnecting (N)..."
- The app automatically reconnects. Wait 10-30 seconds
- If it doesn't recover, tap **Restart App** on the Home page
- If the issue persists, check that the server is running (contact IT)

### A button doesn't do anything

- Check for a **confirmation dialog** -- some buttons require you to tap "Yes"
- Check if the button is **grayed out** (disabled). For Chapel, TVs must be on before sources work
- Try the action again -- some IR commands need 2-3 attempts
- Check the **progress overlay** -- the macro may still be running

### Projector won't turn on

- Try the individual projector button in Advanced Settings > TV Controls
- If one projector is stuck, try power-cycling it in Advanced Settings > Power
- Projectors take 30-60 seconds to warm up after receiving the power-on command

### TV shows wrong input / no signal

- Tap the correct video source button (it should highlight in orange)
- If the TV shows "No Signal", go to Advanced Settings > TV Controls and manually set the HDMI input
- For the Chapel, make sure TVs are powered on (check battery badge)

### Audio isn't working

- Check the Audio button -- is it green (on)?
- Go to Settings > Audio tab and check if channels are muted (red = muted)
- Check the mixer scene -- the correct scene should be loaded for your room
- Try "Reload Scene" in Settings > Audio to reset the mixer

### Live stream won't start

- Check the Stream page status bar -- is OBS connected?
- If it shows "Disconnected", OBS Studio may not be running on the server
- Try the **Reset Stream** button in Advanced Settings
- Contact IT if OBS remains disconnected

### Toast says "Macro failed" or a step was skipped

- Some steps may fail gracefully (e.g., a TV doesn't respond to IR) -- this is normal
- The macro continues past non-critical failures
- If a critical step fails, the macro stops and shows an error
- Try running the macro again, or use individual controls as a fallback
