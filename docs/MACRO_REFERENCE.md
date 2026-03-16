# STP AV Control System -- Macro & Button Reference

> **Audience:** AV operators and volunteers. This guide explains what every button does on the tablet control panels, organized by room/page.

---

## Table of Contents

1. [How Macros Work](#how-macros-work)
2. [Main Church](#main-church)
3. [Chapel](#chapel)
4. [Social Hall](#social-hall)
5. [Gym](#gym)
6. [Conference Room](#conference-room)
7. [Streaming / OBS](#streaming--obs)
8. [Announcements (TTS)](#announcements-tts)
9. [Special Macros](#special-macros)
10. [Video Source Quick Reference](#video-source-quick-reference)

---

## How Macros Work

When you tap a button on the tablet, it runs a **macro** -- a sequence of automated steps. Each macro can:

- Turn devices on/off via power switches (WattBox outlets, EcoFlow batteries)
- Send IR commands to TVs (power on/off, change input)
- Route video sources through the MoIP matrix
- Load audio mixer scenes on the X32
- Control projectors, cameras, and streaming
- Play TTS announcements through speakers
- Unlock doors for a set duration

**What you'll see:** Many buttons show a progress overlay as steps execute. Multi-step macros typically take 10-60 seconds. If a step fails, the macro either retries, skips that step, or stops and shows an error.

**Confirmation dialogs:** Buttons that turn things OFF or perform major actions will ask "Are you sure?" before proceeding.

**State indicators:**
- **Green/highlighted** = device is ON or active
- **Orange** = currently selected video source
- **Gray** = device is OFF or inactive
- **Battery badge** = shows battery % for battery-powered displays

---

## Main Church

### Quick Actions (Top of Page)

| Button | What It Does | Time |
|--------|-------------|------|
| **All Systems On** | Full AV startup: lowers screens, powers on projectors, turns on audio system, sets Apple TV source, starts live stream scene, moves camera to preset, unlocks exterior doors for 5 hours, sets A/C to cool at 69F | ~60s |
| **All Systems Off** | Full AV shutdown: raises screens, powers off projectors and portables, turns off audio, turns off A/C | ~30s |

### Video Section

| Button | What It Does |
|--------|-------------|
| **On / Down** | Lowers motorized projection screens and shelf, powers on all 4 projectors (with stagger delays), turns on cry room TV, enables shared video components (MoIP controller, ATEM, webcam), sets Apple TV as default source |
| **Off / Up** | Raises screens and shelf, powers off all projectors, turns off cry room TV and portables, disables video virtual switches |

### Audio Section

| Button | What It Does |
|--------|-------------|
| **On** | Powers on X32 mixer (loads default scene if cold-booted), turns on antennas, PA amp, main audio sub, Social Hall & PA amp, wireless mics, lapel mic, Main Church amps. Sets audio routing (TX 13 to RX 24) |
| **Off** | Powers off main amp, wireless mics, lapel mic |

### A/C Section

| Button | What It Does |
|--------|-------------|
| **Thermostat** | Opens thermostat control for Main Church HVAC. Badge shows current temperature |

### Video Sources

These buttons change what appears on ALL Main Church displays (projectors, cry room TV, portables):

| Button | Source Device | TX # | What It Shows |
|--------|-------------|------|---------------|
| **Left Podium** | Left podium laptop HDMI | TX 22 | Presenter's laptop (left podium) |
| **Right Podium** | Right podium laptop HDMI | TX 23 | Presenter's laptop (right podium) |
| **Announcements** | Announcements PC | TX 9 | Rotating announcements / slides |
| **LOGO** | Logo display | TX 16 | Church logo (idle screen) |
| **Live Stream** | Live stream output | TX 8 | What viewers see on YouTube |
| **Apple TV (No Page #s)** | Apple TV direct | TX 24 | Hymnal/liturgy app -- clean feed |
| **Apple TV (Page #s)** | Apple TV via ATEM | TX 27 | Hymnal/liturgy app -- with page number overlay |
| **Google Streamer** | Google Chromecast | TX 25 | Cast content from phone/laptop |

### People Counts

| Button | What It Shows |
|--------|--------------|
| **Occupancy** | Opens occupancy analytics panel (Camlytics building count data) |
| **Communion** | Opens occupancy analytics panel (communion count data) |

### Advanced Settings (expand panel)

| Tab | Contents |
|-----|----------|
| **Power** | Individual WattBox outlet and EcoFlow battery controls |
| **TV Controls** | Individual projector on/off (Front Left, Front Right, Rear Left, Rear Right), portables on/off, AppleTV restart, Baptism Camera View |
| **Video Source** | Advanced MoIP routing controls |
| **People Count** | Detailed occupancy analytics |
| **Baptism / Wedding** | Baptism Camera View -- routes baptism room camera to Main Church displays |
| **Macros** | End of Liturgy (switches to announcements, turns on Social Hall TVs, loads mixer scene 5, runs Sunday School countdown), Unlock Exterior Doors (unlocks 3 doors for 4 hours) |

---

## Chapel

### Quick Actions

| Button | What It Does | Time |
|--------|-------------|------|
| **All Systems On** | Powers on Chapel TVs, turns on audio, sets Apple TV source, starts live stream scene, moves camera to preset, unlocks exterior doors for 3 hours, sets A/C to cool at 69F | ~45s |
| **All Systems Off** | Powers off TVs, audio, and A/C | ~20s |

### Video Section

| Button | What It Does |
|--------|-------------|
| **TVs On** | Sends IR power-on to Chapel Vizio TV and floating RCA TV, enables HDMI transmitter, IR controller, and battery power supplies, repeats IR power-on twice for reliability, sets Vizio to HDMI 1. Badge shows battery level |
| **TVs Off** | Sends IR power-off to both TVs (repeated 4x for Vizio reliability) |

### Audio Section

| Button | What It Does |
|--------|-------------|
| **Audio On** | Runs shared audio startup (mixer, amps, antennas, sub, routing), then turns on Chapel microphones and Chapel amplifier, sends IR to screens |
| **Audio Off** | Powers off Chapel amp and mics |

### Video Sources

| Button | Source | TX # |
|--------|--------|------|
| **Hall Laptop** | Social Hall laptop | TX 1 |
| **Apple TV** | Chapel Apple TV | TX 14 |
| **Windows Display** | Windows display adapter | TX 15 |
| **Announcements** | Announcements PC | TX 9 |
| **Google Streamer** | Google Chromecast | TX 25 |
| **Live Stream** | Live stream output | TX 8 |

> **Note:** Video source buttons are disabled when Chapel TVs are off (battery power not detected).

---

## Social Hall

### Quick Actions

| Button | What It Does | Time |
|--------|-------------|------|
| **All Systems On** | Powers on all 8 video wall panels, turns on audio, starts live stream scene, moves camera to preset, sets A/C to cool at 69F | ~45s |
| **All Systems Off** | Powers off video wall, audio, and A/C | ~20s |

### Video Section

| Button | What It Does |
|--------|-------------|
| **On** | Powers on all 8 Social Hall display panels via IR + Samsung API (3 rounds of power-on for reliability), sets all to HDMI 1, enables shared video components (MoIP, ATEM) |
| **Off** | Powers off all 8 panels via Samsung API + IR power-off |

### Audio Section

| Button | What It Does |
|--------|-------------|
| **On** | Runs shared audio startup, then turns on 2 Social Hall microphone receivers, wireless mics, and Social Hall amp |
| **Off** | Powers off Social Hall mics and wireless mics |

### Video Sources

| Button | Source | TX # |
|--------|--------|------|
| **Apple TV** | Social Hall Apple TV | TX 6 |
| **Live Stream** | Live stream output | TX 8 |
| **Announcements** | Announcements PC | TX 9 |
| **LOGO** | Church logo | TX 16 |
| **Camera** | Social Hall camera | TX 2 |
| **Laptop** | Laptop input | TX 1 |
| **Windows Display** | Windows display adapter | TX 15 |
| **Google Streamer** | Google Chromecast | TX 25 |
| **VBS** | VBS / Laptop (same as Laptop, also routes to Chapel portable) | TX 1 |

---

## Gym

### Video & Audio

| Button | What It Does |
|--------|-------------|
| **Video On / Off** | Powers gym TV on/off |
| **Audio On / Off** | Powers gym audio on/off |

### Video Sources

| Button | Source | TX # |
|--------|--------|------|
| **Live Stream** | Live stream output | TX 8 |
| **Announcements** | Announcements PC | TX 9 |
| **LOGO** | Church logo | TX 16 |

---

## Conference Room

### TV Controls (Left and Right TVs are independent)

| Button | What It Does |
|--------|-------------|
| **Left TV On** | IR power-on + Samsung API, sets default MoIP source, switches to HDMI 1 (repeated for reliability) |
| **Left TV Off** | Samsung API turn-off + 3x IR power-off |
| **Right TV On** | Same as Left TV On but for the right display |
| **Right TV Off** | Same as Left TV Off but for the right display |

### Video Conference

| Button | What It Does |
|--------|-------------|
| **On** | Powers on 2 Owl cameras, routes laptop to both TVs, sets both to HDMI 1 |
| **Off** | Powers off both Owl cameras |

### Video Sources (per TV)

Each TV has its own independent source selection:

| Button | Source | TX # |
|--------|--------|------|
| **Laptop** | Conference room laptop | TX 5 |
| **Live Stream** | Live stream output | TX 8 |
| **Announcements** | Announcements PC | TX 9 |
| **Slides** | Left podium slides | TX 22 |
| **Windows Display** | Windows display adapter | TX 15 |
| **Apple TV** | Apple TV (direct HDMI 2, not MoIP) | -- |
| **Google Streamer** | Google Chromecast | TX 25 |

---

## Streaming / OBS

These macros configure the audio mixer and video routing for different OBS streaming scenarios:

| Button | What It Does |
|--------|-------------|
| **Stream: Main Church Scene** | Sets audio routing (TX 13 to RX 24) + loads X32 scene 1 (Main Church worship) |
| **Stream: Chapel Scene** | Sets audio routing + loads X32 scene 2 (Chapel) |
| **Stream: Social Hall Scene** | Sets audio routing + loads X32 scene 5 (Social Hall) |
| **Stream: Other Scene** | Sets audio routing only (no scene change -- for Baptism/Gym scenes) |
| **Reset Live Stream** | Sends resetLiveStream command to OBS via Advanced Scene Switcher plugin |

---

## Announcements (TTS)

The system can play text-to-speech announcements through WiiM speakers using the edge-tts engine.

### Presets (single announcements)

| Preset | What It Says |
|--------|-------------|
| **Church Closing** | "The church will be closing in 5 minutes, please make your way to the exits..." |
| **Adult Class Starting** | "The adult class is starting now, please make your way to the Social Hall." |
| **Sunday School Starting** | "Sunday school is starting now. Kids should be in their classes now." |
| **Meeting Starting** | "The meeting is starting now." |
| **Emergency** | "Attention. Please calmly proceed to the nearest exit and gather in the parking lot. This is not a drill." |
| **Test** | "This is a test message. This is only a test." |

### Sequences (multi-step timed announcements)

| Sequence | What It Does | Total Duration |
|----------|-------------|----------------|
| **Sunday School Countdown** | Announces at 20 min, 10 min, 5 min, and 0 min before Sunday School | ~20 min |
| **Closing Countdown** | Announces at 30 min, 15 min, and 5 min before building close | ~30 min |

### Custom Announcements

On the Source Routing page > Announcements tab > Custom sub-tab, you can type any text and have it spoken through the speakers with a selectable voice.

---

## Special Macros

### End of Liturgy

Available on the Main Church page under Advanced Settings > Macros tab.

**What it does (in order):**
1. Switches Main Church displays to Announcements source
2. Turns on Social Hall video wall
3. Switches Social Hall to Announcements source
4. Loads X32 mixer scene 5 (Social Hall audio)
5. Unmutes aux channels 3 and 4
6. Starts the Sunday School Countdown announcement sequence (20-minute countdown)

**Requires confirmation** and shows step-by-step progress.

### Unlock Exterior Doors

Available on the Main Church page under Advanced Settings > Macros tab.

**What it does:** Unlocks all 3 exterior doors (Main Church entrance, Lobby, Rear) for 4 hours using timed lock commands.

---

## Video Source Quick Reference

Quick lookup for which transmitter (TX) sends which content:

| TX # | Source Name | Description |
|------|-----------|-------------|
| 1 | Laptop | Shared laptop input (Social Hall / VBS) |
| 2 | SH Center Camera | Social Hall center camera |
| 5 | Conference Room | Conference room laptop |
| 6 | SH Apple TV | Social Hall Apple TV |
| 8 | Live Stream View | What YouTube viewers see |
| 9 | Announcements | Rotating announcements PC |
| 13 | Audio Rack | Audio routing (to RX 24) |
| 14 | Chapel Apple TV | Chapel Apple TV |
| 15 | Windows Display | Windows display adapter |
| 16 | LOGO | Church logo / idle screen |
| 21 | Baptism Camera | Baptism room camera |
| 22 | Left Podium | Left podium laptop HDMI |
| 23 | Right Podium | Right podium laptop HDMI |
| 24 | Main Apple TV | Main Church Apple TV (direct, no overlay) |
| 25 | Google Streamer | Google Chromecast |
| 27 | ATEM Output | Apple TV with page number overlay |

> **Tip:** The "Source Routing" page gives you full control over any TX-to-RX mapping if the preset buttons don't cover your needs.
