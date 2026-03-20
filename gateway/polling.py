"""Background pollers, state cache, circuit breaker, and watchdog."""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Dict, Optional

import requests as http_requests

logger = logging.getLogger("stp-gateway")


# =============================================================================
# MOCK BACKENDS (for offline development)
# =============================================================================

class MockBackend:
    """Returns canned responses for all subsystems when --mock is used."""

    MOIP_RECEIVERS = {
        str(i): {"receiver_id": str(i), "transmitter_id": str(1), "connected": True}
        for i in range(1, 29)
    }

    X32_STATUS = {
        "healthy": True,
        "data": {
            "channels": {str(i): {"muted": False, "fader_db": -10.0} for i in range(1, 33)},
            "buses": {str(i): {"muted": False, "fader_db": -10.0} for i in range(1, 17)},
            "dcas": {str(i): {"muted": False, "fader_db": 0.0} for i in range(1, 9)},
            "cur_scene": "1",
            "cur_scene_name": "Mock Scene",
        },
    }

    OBS_VERSION = {"obsVersion": "30.0.0", "obsWebSocketVersion": "5.0.0"}
    OBS_STREAM_STATUS = {"outputActive": True, "outputTimecode": "00:30:00.000"}
    OBS_SCENE = {"currentProgramSceneName": "MainChurch_Altar"}


# =============================================================================
# STATE CACHE (shared mutable state for pollers + SocketIO broadcast)
# =============================================================================

class StateCache:
    # Fields that change every poll cycle but don't represent actionable
    # state changes.  Stripped before comparing old vs new to avoid
    # broadcasting identical payloads to every tablet.
    VOLATILE_KEYS = frozenset({
        "age_seconds",       # X32 — seconds since last snapshot
        "stream_timecode",   # OBS — HH:MM:SS.mmm while streaming
        "record_timecode",   # OBS — HH:MM:SS.mmm while recording
        "stream_bytes",      # OBS — bytes sent (increments every cycle)
    })

    def __init__(self):
        self._lock = threading.Lock()
        self._state: Dict[str, Any] = {}

    def get(self, key: str) -> Any:
        with self._lock:
            return self._state.get(key)

    @staticmethod
    def _strip_volatile(value: Any) -> Any:
        """Return a copy with volatile keys removed (for comparison only)."""
        if isinstance(value, dict):
            return {k: v for k, v in value.items()
                    if k not in StateCache.VOLATILE_KEYS}
        return value

    def set(self, key: str, value: Any) -> bool:
        """Set value. Returns True if non-volatile fields changed."""
        with self._lock:
            old = self._state.get(key)
            self._state[key] = value
            return self._strip_volatile(old) != self._strip_volatile(value)

    def get_all(self) -> dict:
        with self._lock:
            return dict(self._state)


# =============================================================================
# CIRCUIT BREAKER (per-service failure tracking with backoff)
# =============================================================================

class CircuitBreaker:
    """Simple circuit breaker: after `threshold` consecutive failures,
    open the circuit for `recovery_timeout` seconds before allowing a
    single half-open probe."""

    def __init__(self, threshold: int = 5, recovery_timeout: int = 30):
        self._threshold = threshold
        self._recovery_timeout = recovery_timeout
        self._fail_count = 0
        self._last_failure: float = 0
        self._state = "closed"           # closed | open | half-open
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        with self._lock:
            if self._state == "open":
                if time.time() - self._last_failure >= self._recovery_timeout:
                    self._state = "half-open"
            return self._state

    def record_success(self):
        with self._lock:
            self._fail_count = 0
            self._state = "closed"

    def record_failure(self):
        with self._lock:
            self._fail_count += 1
            self._last_failure = time.time()
            if self._fail_count >= self._threshold:
                self._state = "open"

    def allow_request(self) -> bool:
        s = self.state
        return s in ("closed", "half-open")

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self._state,
                "fail_count": self._fail_count,
                "threshold": self._threshold,
            }


# =============================================================================
# POLLER WATCHDOG (tracks last heartbeat per poller thread)
# =============================================================================

class PollerWatchdog:
    def __init__(self):
        self._lock = threading.Lock()
        self._heartbeats: Dict[str, float] = {}
        self._intervals: Dict[str, float] = {}
        self._breakers: Dict[str, CircuitBreaker] = {}

    def register(self, name: str, interval: float):
        with self._lock:
            self._heartbeats[name] = time.time()
            self._intervals[name] = interval
            self._breakers[name] = CircuitBreaker(threshold=5, recovery_timeout=interval * 6)

    def heartbeat(self, name: str):
        with self._lock:
            self._heartbeats[name] = time.time()

    def breaker(self, name: str) -> Optional[CircuitBreaker]:
        with self._lock:
            return self._breakers.get(name)

    def status(self) -> dict:
        now = time.time()
        result = {}
        with self._lock:
            for name, last in self._heartbeats.items():
                interval = self._intervals.get(name, 10)
                age = now - last
                stale = age > interval * 3
                cb = self._breakers.get(name)
                result[name] = {
                    "last_heartbeat_age_s": round(age, 1),
                    "stale": stale,
                    "circuit": cb.status() if cb else None,
                }
        return result


# =============================================================================
# HA device cache builder
# =============================================================================

def build_ha_device_cache(ctx):
    """Build the cameras and locks lists from a single HA states fetch."""
    from macro_engine import fetch_all_ha_entities

    if ctx.mock_mode:
        with ctx.ha_cache_lock:
            ctx.ha_device_cache["ready"] = True
        return

    try:
        all_entities, err = fetch_all_ha_entities(ctx)
        if err:
            logger.warning(f"HA device cache refresh failed: {err}")
            return
    except Exception as e:
        logger.warning(f"HA device cache refresh error: {e}")
        return

    # --- cameras ---
    cameras = []
    for entity in all_entities:
        eid = entity.get("entity_id", "")
        if not eid.startswith("camera."):
            continue
        attrs = entity.get("attributes", {})
        cameras.append({
            "entity_id": eid,
            "friendly_name": attrs.get("friendly_name", eid),
            "state": entity.get("state", "unknown"),
            "brand": attrs.get("brand", ""),
            "model_name": attrs.get("model_name", ""),
            "frontend_stream_type": attrs.get("frontend_stream_type", ""),
            "supported_features": attrs.get("supported_features", 0),
        })
    cameras.sort(key=lambda c: c["friendly_name"])

    # --- locks ---
    door_sensors = {}
    rule_candidates = {}
    dur_candidates = {}
    entity_by_id = {}

    for entity in all_entities:
        eid = entity.get("entity_id", "")
        attrs = entity.get("attributes", {})
        entity_by_id[eid] = entity

        if eid.startswith("binary_sensor.") and attrs.get("device_class") == "door":
            base = eid.replace("binary_sensor.", "").replace("_position", "").replace("_dps", "")
            door_sensors[base] = entity.get("state", "unknown")
        elif (eid.startswith("select.") or eid.startswith("input_select.")):
            name = eid.split(".", 1)[1]
            if "lock_rule" in name or "locking_rule" in name:
                rule_candidates[eid] = name
        elif (eid.startswith("number.") or eid.startswith("input_number.")):
            name = eid.split(".", 1)[1]
            if any(kw in name for kw in ("interval", "duration", "custom", "unlock_time")):
                dur_candidates[eid] = name

    def _find_best_match(base_name, candidates):
        variants = [base_name]
        if base_name.endswith("_door"):
            variants.append(base_name[:-5])
        best_eid, best_len, best_cname_len = None, 0, float('inf')
        for eid, cname in candidates.items():
            for v in variants:
                if v in cname:
                    if len(v) > best_len or (len(v) == best_len and len(cname) < best_cname_len):
                        best_eid, best_len, best_cname_len = eid, len(v), len(cname)
        return best_eid

    locks = []
    for entity in all_entities:
        eid = entity.get("entity_id", "")
        if not eid.startswith("lock."):
            continue
        attrs = entity.get("attributes", {})
        base_name = eid.replace("lock.", "")

        matched_rule = _find_best_match(base_name, rule_candidates)
        matched_dur = _find_best_match(base_name, dur_candidates)

        rule_options = None
        if matched_rule and matched_rule in entity_by_id:
            rule_attrs = entity_by_id[matched_rule].get("attributes", {})
            rule_options = rule_attrs.get("options", [])

        dur_attrs_out = None
        if matched_dur and matched_dur in entity_by_id:
            da = entity_by_id[matched_dur].get("attributes", {})
            dur_attrs_out = {
                "min": da.get("min", 1),
                "max": da.get("max", 60),
                "step": da.get("step", 1),
                "current": entity_by_id[matched_dur].get("state", "10"),
            }

        locks.append({
            "entity_id": eid,
            "friendly_name": attrs.get("friendly_name", eid),
            "state": entity.get("state", "unknown"),
            "supported_features": attrs.get("supported_features", 0),
            "changed_by": attrs.get("changed_by", ""),
            "door_open": door_sensors.get(base_name, None),
            "lock_rule_entity": matched_rule,
            "lock_rule_options": rule_options,
            "duration_entity": matched_dur,
            "duration_attrs": dur_attrs_out,
        })
    locks.sort(key=lambda l: l["friendly_name"])

    with ctx.ha_cache_lock:
        ctx.ha_device_cache["cameras"] = cameras
        ctx.ha_device_cache["locks"] = locks
        ctx.ha_device_cache["ready"] = True
    logger.info(f"HA device cache refreshed: {len(cameras)} cameras, {len(locks)} locks")


# =============================================================================
# Start all background pollers
# =============================================================================

def start_pollers(ctx):
    """Start all background polling threads."""
    from macro_engine import fetch_ha_button_states

    socketio = ctx.socketio
    cfg = ctx.cfg
    mock_mode = ctx.mock_mode
    state_cache = ctx.state_cache
    watchdog = ctx.watchdog
    mw_cfg = cfg.get("middleware", {})
    cam_cfg = cfg.get("camlytics", {})

    # Start module pollers
    if ctx.x32 is not None:
        ctx.x32.start()
    if ctx.moip is not None:
        ctx.moip.start()
    if ctx.obs is not None:
        ctx.obs.start()
    if ctx.health is not None:
        ctx.health.start()
    if ctx.occupancy is not None:
        ctx.occupancy.start()

    poll_cfg = cfg.get("polling", {})

    def poll_loop(name, interval, poll_fn):
        logger.info(f"Poller started: {name} (every {interval}s)")
        watchdog.register(name, interval)
        crash_count = 0
        while True:
            try:
                cb = watchdog.breaker(name)
                if cb and not cb.allow_request():
                    logger.debug(f"Poller {name}: circuit open, skipping poll")
                    time.sleep(interval)
                    continue
                try:
                    data = poll_fn()
                    watchdog.heartbeat(name)
                    if cb:
                        if data is not None:
                            cb.record_success()
                        else:
                            cb.record_failure()
                    if data is not None and state_cache.set(name, data):
                        socketio.emit(f"state:{name}", data, room=name)
                except Exception as e:
                    logger.warning(f"Poller {name} error: {e}")
                    if cb:
                        cb.record_failure()
                time.sleep(interval)
            except Exception as e:
                # Top-level catch: thread would die without this
                crash_count += 1
                logger.error(f"Poller {name} CRASHED (#{crash_count}): {e}", exc_info=True)
                try:
                    socketio.emit("poller_died", {"poller": name, "error": str(e), "crash_count": crash_count})
                except Exception:
                    pass
                # Back off before restarting: 5s, 10s, 20s, capped at 60s
                backoff = min(5 * (2 ** (crash_count - 1)), 60)
                time.sleep(backoff)

    # Fail-streak counters for poller logging
    _poll_fail_streaks = {}

    def _poll_log_fail(name, e):
        streak = _poll_fail_streaks.get(name, 0) + 1
        _poll_fail_streaks[name] = streak
        if streak == 1 or streak % 5 == 0:
            logger.warning(f"{name} poll failed (streak {streak}): {e}")
        else:
            logger.debug(f"{name} poll failed (streak {streak}): {e}")

    def _poll_log_ok(name):
        if _poll_fail_streaks.get(name, 0) > 0:
            logger.info(f"{name} poll recovered after {_poll_fail_streaks[name]} failures")
            _poll_fail_streaks[name] = 0

    # ---- Service health transition tracking ----
    # Tracks the *device* healthy state (not the poll function).
    # Emits service:status events on transitions so tablets can show toasts.
    _service_health: Dict[str, Optional[bool]] = {}  # None = unknown (startup)
    _ha_fail_streak = 0  # consecutive HA poll failures before marking offline
    _HA_FAILS_TO_OFFLINE = 3
    _SERVICE_LABELS = {
        "x32": "Audio Mixer (X32)",
        "obs": "OBS Studio",
        "moip": "Video Matrix (MoIP)",
        "ha": "Home Assistant",
    }

    def _report_service_health(name: str, healthy: bool):
        """Track service health and emit Socket.IO event on transitions."""
        prev = _service_health.get(name)
        _service_health[name] = healthy

        # No event on first poll (startup) or if state unchanged
        if prev is None or prev == healthy:
            return

        label = _SERVICE_LABELS.get(name, name)
        if healthy:
            logger.info(f"Service RECOVERED: {label}")
            socketio.emit("service:status", {
                "service": name,
                "label": label,
                "healthy": True,
                "message": f"{label} reconnected",
            })
        else:
            logger.warning(f"Service DOWN: {label}")
            socketio.emit("service:status", {
                "service": name,
                "label": label,
                "healthy": False,
                "message": f"{label} is offline",
            })

    def poll_x32():
        if mock_mode:
            return MockBackend.X32_STATUS
        try:
            status = ctx.x32.get_status()
            if status:
                status.pop("age_seconds", None)
            _poll_log_ok("X32")
            _report_service_health("x32", bool(status and status.get("healthy")))
            return status
        except Exception as e:
            _poll_log_fail("X32", e)
            _report_service_health("x32", False)
            return None

    def poll_moip():
        if mock_mode:
            return MockBackend.MOIP_RECEIVERS
        try:
            result, status = ctx.moip.get_receivers()
            if status < 400:
                _poll_log_ok("MoIP")
                _report_service_health("moip", True)
                return result
            _report_service_health("moip", False)
            return None
        except Exception as e:
            _poll_log_fail("MoIP", e)
            _report_service_health("moip", False)
            return None

    def poll_obs():
        if mock_mode:
            return {"streaming": True, "recording": False, "current_scene": "MainChurch_Altar"}
        try:
            snap = ctx.obs.get_snapshot()
            _poll_log_ok("OBS")
            _report_service_health("obs", snap is not None)
            return snap
        except Exception as e:
            _poll_log_fail("OBS", e)
            _report_service_health("obs", False)
            return None

    def poll_projectors():
        projectors = cfg.get("projectors", {})
        if mock_mode:
            return {k: {"name": v.get("name", k), "power": "on"} for k, v in projectors.items()}
        statuses = {}
        for key, proj in projectors.items():
            try:
                proj_timeout = cfg.get("timeouts", {}).get("projectors", 5)
                resp = http_requests.get(
                    f"http://{proj['ip']}/api/v01/contentmgr/remote/power/",
                    timeout=proj_timeout,
                )
                statuses[key] = {"name": proj.get("name", key), "power": "on", "reachable": True}
            except Exception as e:
                logger.debug(f"Projector {key} poll failed: {e}")
                statuses[key] = {"name": proj.get("name", key), "power": "unknown", "reachable": False}
        return statuses

    def poll_ha_states():
        nonlocal _ha_fail_streak
        result = fetch_ha_button_states(ctx)
        # Detect HA health with fail-streak gating to avoid false "offline" on transient errors
        if result:
            all_unavailable = all(
                v.get("state") == "unavailable" for v in result.values()
            )
            if all_unavailable:
                _ha_fail_streak += 1
                if _ha_fail_streak >= _HA_FAILS_TO_OFFLINE:
                    _report_service_health("ha", False)
            else:
                _ha_fail_streak = 0
                _report_service_health("ha", True)
        else:
            _ha_fail_streak += 1
            if _ha_fail_streak >= _HA_FAILS_TO_OFFLINE:
                _report_service_health("ha", False)
        return result

    def _get_camlytics_raw(url):
        if not url:
            return 0
        try:
            resp = http_requests.get(url, timeout=cfg.get("timeouts", {}).get("camlytics", 2))
            body = resp.json()
            report = body.get("report", {}) if isinstance(body, dict) else {}
            data = report.get("data", {}) if isinstance(report, dict) else {}
            if isinstance(data, dict) and data.get("counter") is not None:
                return int(data["counter"]) or 0
            if isinstance(data, dict) and "series" in data:
                series = data["series"]
                if series and isinstance(series, list) and series[0].get("data"):
                    chart_points = series[0]["data"]
                    window_hours = float(cam_cfg.get("peak_window_hours", 2))
                    intervals = round(window_hours * 4)
                    start = max(0, len(chart_points) - intervals)
                    peak = 0
                    for point in chart_points[start:]:
                        v = int(point.get("value", 0)) if isinstance(point, dict) else 0
                        if v > peak:
                            peak = v
                    return peak
            if report.get("counter") is not None:
                return int(report["counter"]) or 0
        except Exception as e:
            logger.debug(f"Camlytics parse failed for {url}: {e}")
        return 0

    def poll_camlytics():
        if mock_mode:
            return {
                "communion_raw": 0, "communion_adjusted": 0, "communion_buffer": -5,
                "occupancy_raw": 0, "occupancy_adjusted": 0, "occupancy_live": 0, "occupancy_buffer": 20,
                "enter_raw": 0, "enter_adjusted": 0, "enter_buffer": 0,
            }
        with ctx.camlytics_lock:
            buffers = dict(ctx.camlytics_buffers)
        comm_raw = _get_camlytics_raw(cam_cfg.get("communion_url", ""))
        comm_mult = 1 + (buffers["communion"] / 100)
        comm_adj = max(0, round(comm_raw * comm_mult))
        peak_val = _get_camlytics_raw(cam_cfg.get("occupancy_url_peak", ""))
        live_val = _get_camlytics_raw(cam_cfg.get("occupancy_url_live", ""))
        occ_raw = max(peak_val, live_val)
        occ_mult = 1 + (buffers["occupancy"] / 100)
        occ_adj = max(0, round(occ_raw * occ_mult))
        occ_live_adj = max(0, round(live_val * occ_mult))
        enter_raw = _get_camlytics_raw(cam_cfg.get("enter_url", ""))
        enter_mult = 1 + (buffers["enter"] / 100)
        enter_adj = max(0, round(enter_raw * enter_mult))
        return {
            "communion_raw": comm_raw, "communion_adjusted": comm_adj, "communion_buffer": buffers["communion"],
            "occupancy_raw": occ_raw, "occupancy_adjusted": occ_adj, "occupancy_live": occ_live_adj, "occupancy_buffer": buffers["occupancy"],
            "enter_raw": enter_raw, "enter_adjusted": enter_adj, "enter_buffer": buffers["enter"],
        }

    ha_state_entities = ctx.ha_state_entities
    pollers = [
        ("x32", poll_cfg.get("x32", 5), poll_x32),
        ("moip", poll_cfg.get("moip", 10), poll_moip),
        ("obs", poll_cfg.get("obs", 3), poll_obs),
        ("projectors", poll_cfg.get("projectors", 30), poll_projectors),
    ]

    if ha_state_entities:
        pollers.append(("ha", poll_cfg.get("ha", 15), poll_ha_states))

    if cam_cfg.get("communion_url") or cam_cfg.get("occupancy_url_peak") or cam_cfg.get("occupancy_url_live"):
        cam_interval = cam_cfg.get("poll_interval", 5)
        pollers.append(("camlytics", cam_interval, poll_camlytics))

    # HA device cache refresh (cameras + locks, every 5 min)
    def _ha_cache_loop():
        logger.info("HA device cache: initial load...")
        build_ha_device_cache(ctx)
        crash_count = 0
        while True:
            try:
                time.sleep(300)
                build_ha_device_cache(ctx)
                crash_count = 0
            except Exception as e:
                crash_count += 1
                logger.error(f"HA cache loop CRASHED (#{crash_count}): {e}", exc_info=True)
                backoff = min(5 * (2 ** (crash_count - 1)), 60)
                time.sleep(backoff)

    ha_cache_thread = threading.Thread(target=_ha_cache_loop, daemon=True)
    ha_cache_thread.start()

    for name, interval, fn in pollers:
        t = threading.Thread(target=poll_loop, args=(name, interval, fn), daemon=True)
        t.start()
