# Service Resilience Session — Summary

**Date:** March 2026
**Branch:** `claude/improve-service-resilience-TO7re`
**Scope:** Improve reliability of the gateway under real-world conditions — transient network failures, device reboots, cascade failures, and HA dependency risks.

---

## What We Did

### 1. Chapel Setup Cascade Failure Fix
**Commit:** `caedd77` — *Fix chapel setup cascade failure and WattBox concurrency errors*

- Identified that chapel setup macros failed in a cascade when one device (typically MoIP or a projector) was slow to respond
- Added `on_fail: skip` to fragile sub-macro steps so a single device failure doesn't abort the entire setup
- Fixed WattBox concurrency errors where overlapping HA calls to the same PDU caused 500 errors

### 2. EcoFlow DC Entity Name Fix
**Commit:** `541f1eb` — *Fix EcoFlow DC entity names in macros (dc12v → dc_12v)*

- HA entity IDs for EcoFlow DC outputs use underscores (`dc_12v`), not the format we had (`dc12v`)
- Fixed all macro references

### 3. Decouple Shared Audio from X32 Boot Wait
**Commits:** `fab426d`, `188e8e1`

- Previously, amps/antennas/sub power-on waited for the X32 mixer to fully boot — unnecessary since they're independent devices
- Decoupled shared audio components so they power on in parallel with the X32 boot sequence
- Restored cold-boot detection: default scene only loads when the mixer was actually off (prevents overwriting a scene during a live stream in another room)

### 4. Retry-with-Reconnect Across All Device Modules
**Commit:** `5c9c693` — *Add retry-with-reconnect resilience across all device modules*

- **X32:** `command()` retries once with reconnect before going offline
- **OBS:** `call()` and `emit()` retry once with reconnect on connection errors (timeouts not retried)
- **Macro ha_service:** 3 attempts with exponential backoff (1s, 2s) instead of fixed 2s
- **Macro epson_power/epson_all:** retry once after 3s per projector
- **Macro ptz_preset:** retry once after 2s, timeout 3s→5s
- **Announcements:** WiiM playback retries once after 2s
- **Event automation:** calendar fetch retries 3× with exponential backoff (3s, 6s)

All retries are conservative (1–2 extra attempts) to avoid masking real failures.

### 5. Service Health Transition Toasts
**Commit:** `bb22463` — *Add service:status events for device health transitions*

- Gateway emits `service:status` Socket.IO events when X32, OBS, MoIP, or HA transitions between healthy/unhealthy
- Frontend shows warning toast when a service goes offline, info toast when it recovers
- Gives volunteers immediate visibility without navigating to the health page
- Startup state is silent (no flood of toasts on gateway boot)

### 6. Resilience UI Improvements
**Commit:** `e22754c` — *Add resilience improvements: retry UI, stale indicators, health retries, event automation retries*

- **Notification panel retry button:** failed macro notifications now have a retry button
- **Failed macro toast:** directs users to bell icon for retry
- **Stale indicator:** buttons get dashed border + reduced opacity when subsystem data is >2 min old
- **Unknown indicator:** buttons grayed out when state is null/never received
- **Health checks:** retry once after 2s before marking a service as down
- **Event automation:** up to 2 retries spaced 2 min apart on macro failure

### 7. HA False Offline Alerts Fix
**Commit:** `c955919` — *Fix HA false offline alerts, add retry + notifications to direct HA service calls*

- `poll_ha_states` now requires 3 consecutive failures before reporting HA offline (was 1)
- `ha_call_service` retries up to 3× with exponential backoff on 500 errors
- `ha_call_service` emits `ha:call_failed` Socket.IO event on final failure
- Frontend shows error toast + notification panel entry for direct HA call failures

### 8. WattBox Direct Telnet Module (Task #1 of 3)
**Commits:** `985b7f3`, `04c006b`

**Why:** Home Assistant's WattBox integration is the single biggest source of reliability issues — it loses connection, marks devices offline, queues commands, and adds 2–5 seconds of latency per outlet toggle. By talking directly to the WattBox PDUs via Telnet, we eliminate HA as a middleman for power control.

**What was built (`gateway/wattbox_module.py`, ~900 lines):**
- One persistent Telnet connection per PDU (9 PDUs, not per-outlet)
- Push listener threads for near-instant outlet state change broadcasts
- Keepalive with exponential backoff (60s normal, 300s cap)
- Watchdog auto-reboots PDU firmware on failure threshold (outlets keep power)
- Stable outlet IDs: `{pdu_key}.outlet_{N}` (e.g., `wb_008_av_audiorack2.outlet_3`)
- Friendly names pulled from WattBox via Telnet at connect time
- New `wattbox_power` macro step type for direct outlet control
- New `wattbox_check` condition type for direct state queries
- REST API: `/api/wattbox/devices`, `/api/wattbox/health`, PDU reboot endpoint
- HTTP fallback when Telnet module unavailable (backward compatible)
- 37 + 10 tests covering parsers, device state, watchdog, macro integration

**Macro migration:** All 40 `ha_service` steps targeting `switch.wb_*` entities converted to `wattbox_power` with stable outlet IDs. The 1 `ha_check` condition on a WattBox entity converted to `wattbox_check`.

---

## What's Left

### Task #2: WattBox Device Browser (Frontend)
**Status:** Complete
**Priority:** Medium
**Depends on:** Task #1 (complete)

Built a full WattBox Device Browser panel in the Settings page (`frontend/js/pages/settings.js`):
- Grid view of all 9 PDUs with per-outlet cards showing friendly names and on/off state
- Real-time outlet state via Socket.IO events (joins `wattbox` room)
- Manual outlet toggle buttons for troubleshooting
- PDU health indicators (connection status)
- Firmware reboot button per PDU with confirmation dialog
- Outlet rename support (sends `!OutletNameSet` via Telnet)
- Break-glass direct WattBox control panel (bypasses HA entirely)
- Integrated into Settings page Power tab, accessible via "Open WattBox Device Browser" button
- Dedicated CSS styles (`.wattbox-page`, `.wattbox-header`)
- Permission gated via `permissions.json` (`wattbox: true`)

### Task #3: Remove HA WattBox Integration
**Status:** Not started — **should wait for production validation of Task #1**
**Priority:** Low (after Task #1 is proven stable)
**Depends on:** Task #1 running reliably in production

Once the direct Telnet path is confirmed stable:
- Remove the WattBox integration from Home Assistant
- Remove the 3 remaining `source: "ha"` button state bindings that reference WattBox entities (these still work via HA polling and are harmless for now)
- Update health checks that monitor WattBox via HA
- Update any HA automations that reference WattBox entities
- Clean up `config.yaml` HA entity references for WattBox

**Why wait:** The HA integration currently serves as a fallback. If the Telnet module has issues in production, HA is still there. Once we're confident, we cut it over fully.

### Other Potential Follow-ups
- **Phase 5 (Secrets centralization):** Move remaining secrets from `config.yaml` to `.env` — not started, independent of this work
- **Phase 8 (Mac Mini migration):** Deploy to Mac Mini — not started, blocked on hardware setup
- **Production monitoring:** Watch the WattBox Telnet module logs for connection stability, watchdog triggers, and latency improvements vs. the old HA path

---

## Key Files Changed

| File | Lines | What |
|------|-------|------|
| `gateway/wattbox_module.py` | +909 | **New** — Direct Telnet to 9 WattBox PDUs |
| `gateway/tests/test_wattbox_module.py` | +386 | **New** — 37 tests for WattBox module |
| `gateway/macro_engine.py` | +311/-? | `wattbox_power` step, `wattbox_check` condition, verify pipeline |
| `gateway/tests/test_macro_engine.py` | +148 | 10 tests for wattbox macro integration |
| `gateway/macros.yaml` | ~420 changed | 40 steps migrated from `ha_service` → `wattbox_power` |
| `gateway/api_routes.py` | +145 | WattBox REST endpoints, HA retry logic |
| `gateway/config.yaml` | +44 | WattBox PDU definitions (9 devices) |
| `gateway/polling.py` | +67 | Stale-state tracking, service transition events |
| `gateway/obs_module.py` | +88 | Retry-with-reconnect |
| `gateway/x32_module.py` | +39 | Retry-with-reconnect |
| `gateway/event_automation.py` | +100 | Calendar fetch retries, macro failure retries |
| `gateway/health_module.py` | +11 | Retry before marking service down |
| `gateway/announcement_module.py` | +48 | WiiM playback retry |
| `frontend/js/app.js` | +23 | Service status toasts, stale indicators |
| `frontend/js/api/macro.js` | +46 | Retry button in notification panel |
| `frontend/js/api/notifications.js` | +24 | HA call failure notifications |
| `frontend/js/pages/settings.js` | +500~ | WattBox Device Browser panel, break-glass control, outlet rename |
| `frontend/css/styles.css` | +150~ | Stale/unknown indicators, WattBox Device Browser styles |
| `frontend/config/permissions.json` | +1 | `wattbox` permission flag |

**Total:** ~3,100+ lines added across 22 files.
