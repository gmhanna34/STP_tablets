#!/usr/bin/env python3
"""
STP Gateway — Unified backend for St. Paul Church AV Control Platform.

Proxies requests to existing middleware (moip-flask, x32-flask, obs-flask),
adds server-side PTZ camera and Epson projector control, Home Assistant proxy,
auth/permissions, audit logging, real-time state sync via Socket.IO,
macro execution engine, and scheduled automation.

Usage:
    python gateway.py                    # Normal mode (connects to real devices)
    python gateway.py --mock             # Mock mode (canned responses, no network)
    python gateway.py --config alt.yaml  # Custom config file
"""

from __future__ import annotations

import eventlet
eventlet.monkey_patch()

import argparse
import concurrent.futures
import copy
import json
import logging
import os
import shutil
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests as http_requests
import yaml
from dotenv import load_dotenv

load_dotenv()
from flask import Flask, Response, jsonify, redirect, request, send_file, send_from_directory, session, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room

# =============================================================================
# CONFIG
# =============================================================================

def load_config(path: str = "config.yaml") -> dict:
    with open(path, "r") as f:
        cfg = yaml.safe_load(f)
    _apply_env_overrides(cfg)
    return cfg


def _apply_env_overrides(cfg: dict):
    """Override config secrets from environment variables when set.

    Env vars take precedence over config.yaml so that secrets don't need
    to live in the committed config file."""
    def _env(key: str, fallback: str = "") -> str:
        return os.environ.get(key) or fallback

    mw = cfg.setdefault("middleware", {})
    # X32 no longer uses middleware proxy — handled directly by X32Module
    # MoIP no longer uses middleware proxy — handled directly by MoIPModule
    # OBS no longer uses middleware proxy — handled directly by OBSModule

    # OBS direct connection overrides
    obs_sec = cfg.setdefault("obs", {})
    obs_sec["ws_password"] = _env("OBS_WS_PASSWORD", obs_sec.get("ws_password", ""))

    # MoIP direct connection overrides
    moip_sec = cfg.setdefault("moip", {})
    moip_sec["username"] = _env("MOIP_USERNAME", moip_sec.get("username", ""))
    moip_sec["password"] = _env("MOIP_PASSWORD", moip_sec.get("password", ""))
    moip_sec["host_internal"] = _env("MOIP_HOST_INTERNAL", moip_sec.get("host_internal", "10.100.20.11"))
    moip_sec["host_external"] = _env("MOIP_HOST_EXTERNAL", moip_sec.get("host_external", "external.stpauloc.org"))
    moip_sec["ha_webhook_id"] = _env("MOIP_HA_WEBHOOK_ID", moip_sec.get("ha_webhook_id", ""))

    ha = cfg.setdefault("home_assistant", {})
    ha["url"] = _env("HA_URL", ha.get("url", ""))
    ha["token"] = _env("HA_TOKEN", ha.get("token", ""))

    # HealthDash module — inherit HA credentials and webhook from env
    hd = cfg.setdefault("healthdash", {})
    hd_ha = hd.setdefault("home_assistant", {})
    hd_ha["base_url"] = _env("HA_URL", hd_ha.get("base_url", "") or ha.get("url", ""))
    hd_ha["token"] = _env("HA_TOKEN", hd_ha.get("token", "") or ha.get("token", ""))
    hd_alerts = hd.setdefault("alerts", {})
    hd_alerts["ha_webhook_url"] = _env("HEALTHDASH_WEBHOOK_URL", hd_alerts.get("ha_webhook_url", ""))
    # Populate HA-backed service URLs (EcoFlow batteries + Home Assistant endpoint)
    ha_url = hd_ha.get("base_url", "")
    ha_token = hd_ha.get("token", "")
    for svc in hd.get("services", []):
        if svc.get("id") == "home_assistant" and not svc.get("url"):
            svc["url"] = f"{ha_url}/api/" if ha_url else ""
            svc["bearer_token"] = ha_token
        # EcoFlow services: populate HA entity URLs from env
        if svc.get("id", "").startswith("ecoflow_") and svc.get("type") == "http_json":
            if not svc.get("url") and ha_url:
                entity_map = {
                    "ecoflow_1": "switch.bat_chapeltv_1_ac_enabled",
                    "ecoflow_2": "switch.bat_chapeltv_1_dc_12v_enabled",
                    "ecoflow_3": "switch.bat_chapeltv_2_ac_enabled",
                    "ecoflow_4": "switch.bat_chapeltv_2_dc_12v_enabled",
                    "ecoflow_5": "switch.bat_mainchurchtv_1_ac_enabled",
                    "ecoflow_6": "switch.bat_mainchurchtv_1_dc_12v_enabled",
                    "ecoflow_7": "switch.bat_mainchurchtv_2_ac_enabled",
                    "ecoflow_8": "switch.bat_mainchurchtv_2_dc_12v_enabled",
                }
                entity = entity_map.get(svc["id"], "")
                if entity:
                    svc["url"] = f"{ha_url}/api/states/{entity}"
                    svc["bearer_token"] = ha_token
                    # Also set battery detail URL
                    battery_map = {
                        "ecoflow_1": "sensor.bat_chapeltv_1_main_battery_level",
                        "ecoflow_2": "sensor.bat_chapeltv_1_main_battery_level",
                        "ecoflow_3": "sensor.bat_chapeltv_2_main_battery_level",
                        "ecoflow_4": "sensor.bat_chapeltv_2_main_battery_level",
                        "ecoflow_5": "sensor.bat_mainchurchtv_1_main_battery_level",
                        "ecoflow_6": "sensor.bat_mainchurchtv_1_main_battery_level",
                        "ecoflow_7": "sensor.bat_mainchurchtv_2_main_battery_level",
                        "ecoflow_8": "sensor.bat_mainchurchtv_2_main_battery_level",
                    }
                    bat_entity = battery_map.get(svc["id"], "")
                    if bat_entity:
                        svc["detail_url_json_paths"] = {
                            "Battery Level": {
                                "url": f"{ha_url}/api/states/{bat_entity}",
                                "path": "state",
                            }
                        }
                        svc["warn_if_detail_equals"] = {"Battery Level": "unknown"}
        # WattBox services: populate password from env
        if svc.get("id", "").startswith("wattbox_") and svc.get("type") == "http":
            ba = svc.get("basic_auth")
            if ba and not ba.get("password"):
                ba["password"] = _env("WATTBOX_PASSWORD", "")

    wb = cfg.setdefault("wattbox", {})
    wb["username"] = _env("WATTBOX_USERNAME", wb.get("username", "admin"))
    wb["password"] = _env("WATTBOX_PASSWORD", wb.get("password", ""))

    sec = cfg.setdefault("security", {})
    sec["secret_key"] = _env("FLASK_SECRET_KEY", sec.get("secret_key", ""))
    sec["settings_pin"] = _env("SETTINGS_PIN", sec.get("settings_pin", ""))
    ra = sec.setdefault("remote_auth", {})
    ra["username"] = _env("REMOTE_AUTH_USER", ra.get("username", ""))
    ra["password"] = _env("REMOTE_AUTH_PASS", ra.get("password", ""))

    fk = cfg.setdefault("fully_kiosk", {})
    fk["password"] = _env("FULLY_KIOSK_PASSWORD", fk.get("password", ""))

    # Anthropic API key (chatbot)
    anth = cfg.setdefault("anthropic", {})
    anth["api_key"] = _env("ANTHROPIC_API_KEY", anth.get("api_key", ""))


# =============================================================================
# LOGGING
# =============================================================================

def setup_logging(cfg: dict) -> logging.Logger:
    log_cfg = cfg.get("logging", {})
    log_path = log_cfg.get("path", "logs/stp-gateway.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    logger = logging.getLogger("stp-gateway")
    logger.setLevel(getattr(logging, log_cfg.get("level", "INFO")))
    logger.propagate = False

    if logger.handlers:
        return logger

    fmt = logging.Formatter("%(asctime)s - %(levelname)s - %(name)s - %(message)s")

    fh = RotatingFileHandler(
        log_path,
        maxBytes=log_cfg.get("max_bytes", 5 * 1024 * 1024),
        backupCount=log_cfg.get("backup_count", 5),
        encoding="utf-8",
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)

    ch = logging.StreamHandler()
    ch.setLevel(logging.DEBUG)
    ch.setFormatter(fmt)

    logger.addHandler(fh)
    logger.addHandler(ch)

    return logger


# Silence Werkzeug
logging.getLogger("werkzeug").setLevel(logging.WARNING)

# =============================================================================
# DATABASE (SQLite audit log + sessions)
# =============================================================================

class Database:
    def __init__(self, path: str):
        self._path = path
        self._local = threading.local()
        self._init_schema()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(self._path, check_same_thread=False)
            self._local.conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn.execute("PRAGMA busy_timeout=5000")
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def _init_schema(self):
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT DEFAULT (datetime('now')),
                tablet_id TEXT,
                action TEXT,
                target TEXT,
                request_data TEXT,
                result TEXT,
                latency_ms REAL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                tablet_id TEXT PRIMARY KEY,
                display_name TEXT,
                last_seen TEXT DEFAULT (datetime('now')),
                socket_id TEXT,
                current_page TEXT
            );
            CREATE TABLE IF NOT EXISTS schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                macro_key TEXT NOT NULL,
                days TEXT DEFAULT '0,1,2,3,4,5,6',
                time_of_day TEXT DEFAULT '08:00',
                enabled INTEGER DEFAULT 1,
                last_run TEXT,
                created TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_audit_tablet ON audit_log(tablet_id);
        """)
        conn.commit()

    def log_action(self, tablet_id: str, action: str, target: str,
                   request_data: str = "", result: str = "", latency_ms: float = 0):
        try:
            conn = self._get_conn()
            conn.execute(
                "INSERT INTO audit_log (tablet_id, action, target, request_data, result, latency_ms) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (tablet_id, action, target, request_data, result, latency_ms),
            )
            conn.commit()
        except Exception:
            pass  # Never let audit logging crash a request

    def cleanup_old_logs(self, retention_days: int = 30):
        """Delete audit log entries older than retention_days."""
        try:
            conn = self._get_conn()
            conn.execute(
                "DELETE FROM audit_log WHERE timestamp < datetime('now', ?)",
                (f"-{retention_days} days",),
            )
            conn.commit()
        except Exception:
            pass

    def upsert_session(self, tablet_id: str, display_name: str = "",
                       socket_id: str = "", current_page: str = ""):
        conn = self._get_conn()
        conn.execute(
            "INSERT INTO sessions (tablet_id, display_name, last_seen, socket_id, current_page) "
            "VALUES (?, ?, datetime('now'), ?, ?) "
            "ON CONFLICT(tablet_id) DO UPDATE SET "
            "display_name=excluded.display_name, last_seen=datetime('now'), "
            "socket_id=excluded.socket_id, current_page=excluded.current_page",
            (tablet_id, display_name, socket_id, current_page),
        )
        conn.commit()

    def get_recent_logs(self, limit: int = 100) -> list:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_sessions(self) -> list:
        conn = self._get_conn()
        rows = conn.execute("SELECT * FROM sessions ORDER BY last_seen DESC").fetchall()
        return [dict(r) for r in rows]

    # --- Schedule CRUD ---

    def get_schedules(self) -> list:
        conn = self._get_conn()
        rows = conn.execute("SELECT * FROM schedules ORDER BY time_of_day").fetchall()
        return [dict(r) for r in rows]

    def create_schedule(self, name: str, macro_key: str, days: str, time_of_day: str) -> int:
        conn = self._get_conn()
        cur = conn.execute(
            "INSERT INTO schedules (name, macro_key, days, time_of_day) VALUES (?, ?, ?, ?)",
            (name, macro_key, days, time_of_day),
        )
        conn.commit()
        return cur.lastrowid

    def update_schedule(self, sched_id: int, **kwargs):
        conn = self._get_conn()
        allowed = {"name", "macro_key", "days", "time_of_day", "enabled", "last_run"}
        sets = []
        vals = []
        for k, v in kwargs.items():
            if k in allowed:
                sets.append(f"{k}=?")
                vals.append(v)
        if sets:
            vals.append(sched_id)
            conn.execute(f"UPDATE schedules SET {','.join(sets)} WHERE id=?", vals)
            conn.commit()

    def delete_schedule(self, sched_id: int):
        conn = self._get_conn()
        conn.execute("DELETE FROM schedules WHERE id=?", (sched_id,))
        conn.commit()


# =============================================================================
# STATE CACHE (shared mutable state for pollers + SocketIO broadcast)
# =============================================================================

class StateCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._state: Dict[str, Any] = {}

    def get(self, key: str) -> Any:
        with self._lock:
            return self._state.get(key)

    def set(self, key: str, value: Any) -> bool:
        """Set value. Returns True if value changed."""
        with self._lock:
            old = self._state.get(key)
            self._state[key] = value
            return old != value

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
            "cur_scene": "0",
            "cur_scene_name": "Sunday Liturgy",
            **{f"ch{i}name": f"Channel {i}" for i in range(1, 33)},
            **{f"ch{i}mutestatus": "unmuted" for i in range(1, 33)},
            **{f"ch{i}vol": "75" for i in range(1, 33)},
            **{f"aux{i}_name": f"Aux {i}" for i in range(1, 9)},
            **{f"aux{i}_mutestatus": "unmuted" for i in range(1, 9)},
            **{f"aux{i}vol": "80" for i in range(1, 9)},
            **{f"bus{i}_name": f"Bus {i}" for i in range(1, 17)},
            **{f"bus{i}_mutestatus": "unmuted" for i in range(1, 17)},
            **{f"bus{i}vol": "75" for i in range(1, 17)},
            **{f"dca{i}_name": f"DCA {i}" for i in range(1, 9)},
            **{f"dca{i}_mutestatus": "unmuted" for i in range(1, 9)},
            **{f"dca{i}vol": "100" for i in range(1, 9)},
            **{f"scene{i}name": f"Scene {i}" for i in range(26)},
        },
        "error": "",
    }

    OBS_VERSION = {
        "result": True,
        "requestResult": {
            "requestType": "GetVersion",
            "requestStatus": {"result": True, "code": 100},
            "responseData": {
                "obsVersion": "30.0.0",
                "obsWebSocketVersion": "5.3.0",
                "platform": "windows",
            },
        },
    }

    OBS_STREAM_STATUS = {
        "result": True,
        "requestResult": {
            "requestType": "GetStreamStatus",
            "requestStatus": {"result": True, "code": 100},
            "responseData": {"outputActive": True, "outputTimecode": "01:23:45"},
        },
    }

    OBS_SCENE = {
        "result": True,
        "requestResult": {
            "requestType": "GetCurrentProgramScene",
            "requestStatus": {"result": True, "code": 100},
            "responseData": {"currentProgramSceneName": "MainChurch_Altar"},
        },
    }


# =============================================================================
# GATEWAY APPLICATION
# =============================================================================

def create_app(cfg: dict, mock_mode: bool = False, config_path: str = "config.yaml") -> tuple:
    """Create and configure the Flask app + SocketIO instance."""

    gateway_cfg = cfg.get("gateway", {})
    # Resolve static_dir relative to this file's directory, not CWD,
    # so that "../frontend" works regardless of where the process is started.
    _gateway_dir = os.path.dirname(os.path.abspath(__file__))
    static_dir = os.path.normpath(
        os.path.join(_gateway_dir, gateway_cfg.get("static_dir", "../frontend"))
    )
    sec_cfg = cfg.get("security", {})

    app = Flask(__name__, static_folder=None)
    app.config["SECRET_KEY"] = sec_cfg.get("secret_key", os.urandom(24).hex())

    socketio = SocketIO(
        app,
        async_mode="eventlet",
        cors_allowed_origins="*",
        ping_timeout=60,      # 60s — generous for WiFi tablets with latency spikes
        ping_interval=15,     # 15s — frequent pings keep WiFi/NAT connections alive
    )

    logger = setup_logging(cfg)

    # Engine.IO / Socket.IO logging — WARNING only (INFO logs every packet,
    # which generates enormous output with multiple tablets connected).
    # Our own connect/disconnect/diag handlers already log what we need.
    import logging as _logging
    for _eio_name in ("engineio.server", "engineio.client", "socketio.server", "socketio.client"):
        _eio_lg = _logging.getLogger(_eio_name)
        _eio_lg.setLevel(_logging.WARNING)
        _eio_lg.propagate = False          # prevent triple-logging via root
        for h in logger.handlers:
            _eio_lg.addHandler(h)

    db = Database(cfg.get("database", {}).get("path", "stp_gateway.db"))
    state_cache = StateCache()

    mw_cfg = cfg.get("middleware", {})

    # X32 mixer — direct OSC/UDP via absorbed module (Phase 1 consolidation)
    from x32_module import X32Module
    x32 = None if mock_mode else X32Module(cfg.get("x32", {}), logger)

    # MoIP controller — direct Telnet via absorbed module (Phase 2 consolidation)
    from moip_module import MoIPModule
    moip = None if mock_mode else MoIPModule(
        cfg.get("moip", {}), logger, ha_cfg=cfg.get("home_assistant", {})
    )

    # OBS Studio — direct WebSocket via absorbed module (Phase 3 consolidation)
    from obs_module import OBSModule
    obs = None if mock_mode else OBSModule(cfg.get("obs", {}), logger)

    # Health monitoring — absorbed from STP_healthdash (Phase 4 consolidation)
    from health_module import HealthModule
    health = None if mock_mode else HealthModule(cfg, logger)

    # Occupancy analytics — absorbed from STP_Occupancy (Phase 6 consolidation)
    from occupancy_module import OccupancyModule
    occupancy = None if mock_mode else OccupancyModule(cfg, logger)

    allowed_ips = sec_cfg.get("allowed_ips", ["127.0.0.1"])
    settings_pin = sec_cfg.get("settings_pin", "1234")
    remote_auth = sec_cfg.get("remote_auth", {})

    # Camlytics runtime buffer state (resets to config defaults on restart)
    cam_cfg = cfg.get("camlytics", {})
    camlytics_buffers = {
        "communion": float(cam_cfg.get("communion_buffer_default", -5)),
        "occupancy": float(cam_cfg.get("occupancy_buffer_default", 20)),
        "enter": float(cam_cfg.get("enter_buffer_default", 0)),
    }
    camlytics_lock = threading.Lock()

    # Load permissions from frontend config
    permissions_path = os.path.join(static_dir, "config", "permissions.json")
    try:
        with open(permissions_path) as f:
            permissions_data = json.load(f)
    except Exception:
        logger.warning(f"Could not load permissions from {permissions_path}, using defaults")
        permissions_data = {"roles": {}, "locations": {}, "defaultRole": "full_access"}

    # Pre-compute known location slugs for catch-all route
    _known_location_slugs = set((permissions_data.get("locations") or {}).keys())

    # Load devices config from frontend config
    devices_path = os.path.join(static_dir, "config", "devices.json")
    try:
        logger.info(f"Loading devices from: {devices_path} (exists={os.path.isfile(devices_path)})")
        with open(devices_path) as f:
            devices_data = json.load(f)
        logger.info(f"Devices loaded OK: top-level keys={list(devices_data.keys())}, "
                     f"moip={'yes' if 'moip' in devices_data else 'NO'}")
    except Exception as e:
        logger.warning(f"Could not load devices from {devices_path}: {e}")
        devices_data = {}

    # Load settings from frontend config
    settings_path = os.path.join(static_dir, "config", "settings.json")
    try:
        with open(settings_path) as f:
            settings_data = json.load(f)
    except Exception:
        logger.warning(f"Could not load settings from {settings_path}")
        settings_data = {}

    # -------------------------------------------------------------------------
    # HELPERS
    # -------------------------------------------------------------------------

    def _tablet_id() -> str:
        return (
            request.headers.get("X-Tablet-ID")
            or request.args.get("tablet")
            or "Unknown"
        )

    def _tablet_role() -> str:
        """Get the tablet's current role from header, falling back to defaultRole."""
        role = request.headers.get("X-Tablet-Role", "")
        if role and role in (permissions_data.get("roles") or {}):
            return role
        return permissions_data.get("defaultRole", "full_access")

    def _ip_allowed(ip: str) -> bool:
        return any(ip.startswith(pfx) for pfx in allowed_ips)

    # Runtime verbose logging flag (toggled via Settings page)
    _verbose_logging = False

    def _proxy_request(service: str, path: str, method: str = "GET",
                       json_data: dict = None, timeout: float = 5,
                       tablet: str = None) -> tuple:
        """Proxy a request to a middleware service. Returns (response_dict, status_code)."""
        svc = mw_cfg.get(service, {})
        base_url = svc.get("url", "")
        api_key = svc.get("api_key", "")
        svc_timeout = svc.get("timeout", timeout)

        if not base_url:
            return {"error": f"Service {service} not configured"}, 503

        url = f"{base_url}{path}"
        headers = {}
        if api_key:
            headers["X-API-Key"] = api_key

        if not tablet:
            try:
                tablet = _tablet_id()
            except RuntimeError:
                tablet = "System"
        headers["X-Tablet-ID"] = tablet

        nonlocal _verbose_logging
        if _verbose_logging:
            logger.debug(f"[VERBOSE] proxy >> {method} {service}{path} "
                         f"body={json.dumps(json_data)[:200] if json_data else 'none'}")

        start = time.time()
        try:
            if method == "GET":
                resp = http_requests.get(url, headers=headers, timeout=svc_timeout)
            else:
                resp = http_requests.post(
                    url, headers=headers, json=json_data, timeout=svc_timeout
                )
            latency = (time.time() - start) * 1000
            result = resp.json()

            if _verbose_logging:
                logger.debug(f"[VERBOSE] proxy << {service}{path} "
                             f"status={resp.status_code} latency={latency:.0f}ms "
                             f"result={json.dumps(result)[:200]}")

            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          json.dumps(result)[:500], latency)

            return result, resp.status_code

        except http_requests.Timeout:
            logger.warning(f"proxy {service}{path} TIMEOUT after {svc_timeout}s")
            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          f"TIMEOUT after {svc_timeout}s", svc_timeout * 1000)
            return {"error": f"{service} timeout after {svc_timeout}s"}, 504
        except http_requests.ConnectionError:
            logger.warning(f"proxy {service}{path} CONNECTION ERROR")
            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          "CONNECTION_ERROR: unreachable", 0)
            return {"error": f"{service} unreachable"}, 503
        except Exception as e:
            logger.warning(f"proxy {service}{path} ERROR: {e}")
            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          f"ERROR: {e}", 0)
            return {"error": str(e)}, 500

    # -------------------------------------------------------------------------
    # SECURITY MIDDLEWARE (session-based, matches HealthDash pattern)
    # -------------------------------------------------------------------------

    session_timeout = int(sec_cfg.get("session_timeout_minutes", 480))

    def _session_is_authed() -> bool:
        exp = session.get("auth_exp")
        if not exp:
            return False
        if time.time() > float(exp):
            session.clear()
            return False
        return bool(session.get("authed"))

    def _is_authed() -> bool:
        return _ip_allowed(request.remote_addr or "") or _session_is_authed()

    @app.before_request
    def security_check():
        # Skip auth for SocketIO, login page, and its static assets
        if request.path.startswith("/socket.io"):
            return None
        if request.path in ("/login", "/logout"):
            return None

        if _is_authed():
            return None

        client_ip = request.remote_addr or ""

        # If remote_auth is configured, redirect browsers / return 401 for API
        if remote_auth.get("password"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Authentication required"}), 401
            logger.info(f"AUTH_REDIRECT ip={client_ip} path={request.path}")
            return redirect(url_for("login_page", next=request.path))

        logger.warning(f"BLOCKED ip={client_ip} path={request.path}")
        return jsonify({"error": "Unauthorized - Invalid IP"}), 403

    @app.after_request
    def log_response(resp):
        # Don't log static file requests, login page, or socket.io polling
        if request.path.startswith("/socket.io") or request.path == "/login":
            return resp
        if not request.path.startswith("/api/"):
            return resp
        client_ip = request.remote_addr or ""
        logger.info(
            f"[{_tablet_id()}] ip={client_ip} {request.method} {request.path} -> {resp.status_code}"
        )
        return resp

    # -------------------------------------------------------------------------
    # LOGIN / LOGOUT
    # -------------------------------------------------------------------------

    LOGIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — St. Paul Control Panel</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
  <style>
    :root {
      --sp-dark: #343B3D;
      --sp-light: #B4B0A5;
      --sp-bg: #f4f3f1;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--sp-bg);
      color: var(--sp-dark);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    nav {
      background: var(--sp-dark);
      color: #fff;
      padding: 12px 20px;
      font-size: 18px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    nav img { height: 28px; width: auto; border-radius: 50%; }
    .container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 10px;
      padding: 32px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .card h1 { font-size: 22px; margin-bottom: 8px; }
    .card .hint {
      font-size: 14px;
      color: #7b7f75;
      margin-bottom: 20px;
      line-height: 1.5;
    }
    .alert {
      background: #f8d7da;
      color: #842029;
      border: 1px solid #f5c2c7;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 10px 12px;
      font-size: 16px;
      border: 1px solid #d1cdc4;
      border-radius: 6px;
      background: #fff;
      color: var(--sp-dark);
      margin-bottom: 16px;
      font-family: inherit;
    }
    input:focus {
      outline: none;
      border-color: var(--sp-dark);
      box-shadow: 0 0 0 2px rgba(52,59,61,0.15);
    }
    button[type="submit"] {
      width: 100%;
      padding: 12px;
      font-size: 16px;
      font-weight: 600;
      background: var(--sp-dark);
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
    }
    button[type="submit"]:hover { filter: brightness(1.15); }
    .tip {
      font-size: 13px;
      color: #7b7f75;
      margin-top: 16px;
      line-height: 1.5;
    }
    .tip code {
      background: #eceae6;
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <nav>
    <img src="/assets/images/church-seal.svg" alt="" onerror="this.style.display='none'">
    <span>St. Paul Control Panel</span>
  </nav>
  <div class="container">
    <div class="card">
      <h1>Sign in</h1>
      <p class="hint">
        This network is not on the trusted IP whitelist.<br>
        Enter your credentials to continue.
      </p>
      {{ERROR}}
      <form method="post" autocomplete="on">
        <label for="username">Username</label>
        <input type="text" id="username" name="username"
               autocomplete="username" autocapitalize="none" required>
        <label for="password">Password</label>
        <input type="password" id="password" name="password"
               autocomplete="current-password" required>
        <button type="submit">Login</button>
      </form>
      <div class="tip">
        Tip: add your home IP prefix to <code>allowed_ips</code> in config.yaml
        for passwordless access.
      </div>
    </div>
  </div>
</body>
</html>"""

    @app.route("/login", methods=["GET", "POST"])
    def login_page():
        # Already authenticated — go straight to the app
        if _is_authed():
            return redirect(request.args.get("next") or "/")

        error_html = ""
        if request.method == "POST":
            pw = request.form.get("password", "")
            configured_pw = remote_auth.get("password", "")

            if pw and pw == configured_pw:
                session["authed"] = True
                session["auth_exp"] = time.time() + session_timeout * 60
                logger.info(f"LOGIN_OK ip={request.remote_addr}")
                return redirect(request.args.get("next") or "/")

            logger.warning(f"LOGIN_FAIL ip={request.remote_addr}")
            error_html = '<div class="alert">Invalid password</div>'

        return Response(
            LOGIN_HTML.replace("{{ERROR}}", error_html),
            content_type="text/html",
        )

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect("/login")

    # -------------------------------------------------------------------------
    # PERMISSION ENFORCEMENT
    # -------------------------------------------------------------------------

    def _check_permission(tablet_id: str, required_page: str) -> Optional[tuple]:
        """Returns an error response tuple if permission denied, None if OK.

        Uses the X-Tablet-Role header (new) or falls back to looking up
        the tablet_id as an old-style location key for backwards compat.
        """
        roles = permissions_data.get("roles", {})

        # New path: check X-Tablet-Role header
        role_key = request.headers.get("X-Tablet-Role", "")
        if role_key and role_key in roles:
            perms = roles[role_key].get("permissions", {})
            if perms.get(required_page) is False:
                return jsonify({"error": "Permission denied", "page": required_page}), 403
            return None

        # Backwards compat: old-style location key (e.g. Tablet_Mainchurch)
        old_locations = permissions_data.get("locations", {})
        # If the tablet_id matches an old-format key with a "permissions" sub-object
        loc = old_locations.get(tablet_id) if isinstance(old_locations.get(tablet_id, {}), dict) else None
        if loc and "permissions" in loc:
            perms = loc.get("permissions", {})
            if perms.get(required_page) is False:
                return jsonify({"error": "Permission denied", "page": required_page}), 403
            return None

        # Unknown tablet / no role header = allow (fail open)
        return None

    # -------------------------------------------------------------------------
    # STATIC FILE SERVING (the Claude/ frontend)
    # -------------------------------------------------------------------------

    @app.route("/")
    def serve_index():
        return send_from_directory(static_dir, "index.html")

    @app.route("/<path:filepath>")
    def serve_static(filepath):
        # Don't serve /api/ paths as static files
        if filepath.startswith("api/"):
            return jsonify({"error": "Not found"}), 404

        # First, try to serve the exact static file (JS, CSS, images, etc.)
        full = os.path.join(static_dir, filepath)
        if os.path.isfile(full):
            return send_from_directory(static_dir, filepath)

        # Location slug catch-all: serve index.html ONLY for bare location slugs
        # (e.g. /chapel, /av-room) — not for sub-paths like /chapel/js/app.js
        slug = filepath.strip("/").lower()
        if slug in _known_location_slugs:
            return send_from_directory(static_dir, "index.html")

        return jsonify({"error": "Not found"}), 404

    # -------------------------------------------------------------------------
    # HEALTH & CONFIG ENDPOINTS
    # -------------------------------------------------------------------------

    @app.route("/api/health")
    def api_health():
        poller_status = watchdog.status()
        any_stale = any(p.get("stale") for p in poller_status.values())
        any_open = any(
            p.get("circuit", {}).get("state") == "open"
            for p in poller_status.values()
        )

        # Test DB connectivity
        db_ok = True
        try:
            db._get_conn().execute("SELECT 1")
        except Exception:
            db_ok = False

        healthy = db_ok and not any_open
        status_code = 200 if healthy else 503
        return jsonify({
            "healthy": healthy,
            "degraded": any_stale and not any_open,
            "service": "stp-gateway",
            "version": settings_data.get("app", {}).get("version", "1.0.0"),
            "mock_mode": mock_mode,
            "db_ok": db_ok,
            "pollers": poller_status,
        }), status_code

    @app.route("/api/healthdash/summary")
    def api_healthdash_summary():
        """Return lightweight health summary (counts only) for tablet status bar."""
        if health is None:
            return jsonify({"counts": {"healthy": 0, "warning": 0, "down": 0}, "total": 0}), 200
        return jsonify(health.get_summary()), 200

    @app.route("/api/healthdash/status")
    def api_healthdash_status():
        """Return full service health results for the health dashboard page."""
        if health is None:
            return jsonify({"generated_at": "", "results": {}, "heartbeat": {}}), 200
        from datetime import datetime, timezone
        return jsonify({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "results": health.get_all_results(),
            "heartbeat": health.get_heartbeats(),
        }), 200

    @app.route("/api/healthdash/services")
    def api_healthdash_services():
        """Return service definitions for the health dashboard UI."""
        if health is None:
            return jsonify({"services": []}), 200
        return jsonify({"services": health.get_services_for_ui()}), 200

    @app.route("/api/healthdash/heartbeat", methods=["POST"])
    def api_healthdash_heartbeat():
        """Receive tablet heartbeats for health monitoring."""
        if health is None:
            return jsonify({"ok": True}), 200
        data = request.get_json(silent=True) or {}
        tablet_id = data.get("tablet_id", "")
        if tablet_id:
            health.record_heartbeat(tablet_id, data)
        return jsonify({"ok": True}), 200

    @app.route("/api/healthdash/logs/<service_id>")
    def api_healthdash_logs(service_id: str):
        """Fetch logs for a health-monitored service."""
        if health is None:
            return jsonify({"service_id": service_id, "name": "", "lines": 0, "log": "Health module not active"}), 200
        lines = request.args.get("lines", 200, type=int)
        return jsonify(health.get_service_logs(service_id, lines)), 200

    @app.route("/api/healthdash/recover/<service_id>", methods=["POST"])
    def api_healthdash_recover(service_id: str):
        """Trigger recovery action for a health-monitored service."""
        if health is None:
            return jsonify({"ok": False, "message": "Health module not active"}), 503
        tablet = _tablet_id()
        result = health.trigger_recovery(service_id)
        db.log_action(tablet, "healthdash:recover", service_id, "",
                      result.get("message", ""), 0)
        status_code = 200 if result.get("ok") else 500
        return jsonify(result), status_code

    @app.route("/api/healthdash/check_now", methods=["POST"])
    def api_healthdash_check_now():
        """Force immediate re-check of all health services."""
        if health is None:
            return jsonify({"ok": True}), 200
        health.force_check_now()
        return jsonify({"ok": True}), 200

    # -------------------------------------------------------------------------
    # OCCUPANCY API ENDPOINTS (Phase 6 consolidation)
    # -------------------------------------------------------------------------

    @app.route("/api/occupancy/data")
    def api_occupancy_data():
        """Return cached weekly summary, trends, pacing data."""
        if occupancy is None:
            return jsonify({"error": "Occupancy module not available (mock mode)"}), 503
        data = occupancy.get_data()
        if not data:
            return jsonify({"error": "Data not loaded yet. Try refreshing."}), 503
        if "error" in data:
            return jsonify({"error": data["error"]}), 404
        return jsonify(data)

    @app.route("/api/occupancy/refresh", methods=["POST"])
    def api_occupancy_refresh():
        """Manual refresh — re-scan CSV data directory."""
        if occupancy is None:
            return jsonify({"ok": True}), 200
        try:
            occupancy.refresh_data()
            return jsonify({"ok": True, "message": "Data refreshed successfully."})
        except Exception as e:
            return jsonify({"ok": False, "message": str(e)}), 500

    @app.route("/api/occupancy/config")
    def api_occupancy_config():
        """Return buffer schedule + communion/occupancy windows."""
        if occupancy is None:
            return jsonify({}), 200
        return jsonify(occupancy.get_config())

    @app.route("/api/config")
    def api_config():
        """Returns merged config for the frontend (devices, permissions, settings).
        API keys and secrets are stripped — this is safe to serve to browsers."""
        logger.info(f"[/api/config] devices_data keys={list(devices_data.keys())}, "
                     f"has moip={'moip' in devices_data}")
        obs_cfg = cfg.get("obs", {})
        safe_settings = {
            "app": settings_data.get("app", {}),
            "ptzCameras": {k: {"name": v.get("name", k), "ip": v.get("ip", "")} for k, v in cfg.get("ptz_cameras", {}).items()},
            "projectors": {k: {"displayName": v.get("name", k)} for k, v in cfg.get("projectors", {}).items()},
            "healthCheck": settings_data.get("healthCheck", {}),
            "obs": {"maxScenes": obs_cfg.get("max_scenes", 10)},
        }
        return jsonify({
            "settings": safe_settings,
            "devices": devices_data,
            "permissions": permissions_data,
        }), 200

    # -------------------------------------------------------------------------
    # SETTINGS ENDPOINTS
    # -------------------------------------------------------------------------

    @app.route("/api/settings/verbose-logging", methods=["GET"])
    def get_verbose_logging():
        """Return current verbose logging state."""
        return jsonify({"enabled": _verbose_logging}), 200

    @app.route("/api/settings/verbose-logging", methods=["POST"])
    def set_verbose_logging():
        """Toggle verbose logging at runtime."""
        nonlocal _verbose_logging
        data = request.get_json(silent=True) or {}
        _verbose_logging = bool(data.get("enabled", False))
        level_name = "DEBUG" if _verbose_logging else cfg.get("logging", {}).get("level", "INFO")
        logger.setLevel(getattr(logging, level_name))
        logger.info(f"Verbose logging {'ENABLED' if _verbose_logging else 'DISABLED'} by {_tablet_id()}")
        db.log_action(_tablet_id(), "settings:verbose_logging", "settings",
                      json.dumps({"enabled": _verbose_logging}), "OK", 0)
        return jsonify({"success": True, "enabled": _verbose_logging}), 200

    # -------------------------------------------------------------------------
    # CONFIG EDITOR ENDPOINTS
    # -------------------------------------------------------------------------

    # Which fields are editable from the UI (curated safe subset).
    # "*" means the entire sub-dict is editable (for dicts like ptz_cameras).
    _EDITABLE_SCHEMA = {
        "gateway": ["host", "port", "debug"],
        "obs": ["ws_url", "ping_seconds", "snapshot_seconds",
                "offline_after_seconds", "ping_fails_to_offline", "max_scenes"],
        "moip": ["host_internal", "port_internal", "host_external", "port_external"],
        "x32": ["mixer_ip", "mixer_type", "ping_seconds", "snapshot_seconds",
                "offline_after_seconds", "ping_fails_to_offline"],
        "ptz_cameras": "*",
        "projectors": "*",
        "camlytics": ["communion_url", "communion_buffer_default",
                      "occupancy_url_peak", "occupancy_url_live",
                      "occupancy_buffer_default"],
        "security": ["allowed_ips", "session_timeout_minutes"],
        "fully_kiosk": ["devices"],
    }

    # Map of env vars → config paths that they override.
    # Fields with an active env var override are shown as read-only.
    _ENV_OVERRIDES = {
        "OBS_WS_PASSWORD": ("obs", "ws_password"),
        "MOIP_USERNAME": ("moip", "username"),
        "MOIP_PASSWORD": ("moip", "password"),
        "MOIP_HOST_INTERNAL": ("moip", "host_internal"),
        "MOIP_HOST_EXTERNAL": ("moip", "host_external"),
        "MOIP_HA_WEBHOOK_ID": ("moip", "ha_webhook_id"),
        "HA_URL": ("home_assistant", "url"),
        "HA_TOKEN": ("home_assistant", "token"),
        "WATTBOX_USERNAME": ("wattbox", "username"),
        "WATTBOX_PASSWORD": ("wattbox", "password"),
        "FLASK_SECRET_KEY": ("security", "secret_key"),
        "SETTINGS_PIN": ("security", "settings_pin"),
        "REMOTE_AUTH_USER": ("security", "remote_auth.username"),
        "REMOTE_AUTH_PASS": ("security", "remote_auth.password"),
        "FULLY_KIOSK_PASSWORD": ("fully_kiosk", "password"),
        "ANTHROPIC_API_KEY": ("anthropic", "api_key"),
        "HEALTHDASH_WEBHOOK_URL": ("healthdash", "alerts.ha_webhook_url"),
    }

    def _get_env_overridden_fields() -> set:
        """Return set of 'section.field' paths that are actively overridden by env vars."""
        overridden = set()
        for env_var, (section, field) in _ENV_OVERRIDES.items():
            if os.environ.get(env_var):
                overridden.add(f"{section}.{field}")
        return overridden

    @app.route("/api/config/editable")
    def api_config_editable():
        """Return the curated editable config subset, with env-override metadata."""
        overridden = _get_env_overridden_fields()
        result = {}
        for section, fields in _EDITABLE_SCHEMA.items():
            section_data = cfg.get(section, {})
            if fields == "*":
                result[section] = {"_value": copy.deepcopy(section_data), "_fields": "*"}
            else:
                section_out = {}
                for field in fields:
                    section_out[field] = section_data.get(field)
                result[section] = {"_value": section_out, "_fields": fields}
            # Mark which fields are overridden by env vars
            env_flags = {}
            if fields == "*":
                for key in section_data:
                    if f"{section}.{key}" in overridden:
                        env_flags[key] = True
            else:
                for field in fields:
                    if f"{section}.{field}" in overridden:
                        env_flags[field] = True
            if env_flags:
                result[section]["_env"] = env_flags
        return jsonify(result), 200

    @app.route("/api/config/save", methods=["POST"])
    def api_config_save():
        """Save editable config changes to config.yaml (with backup)."""
        data = request.get_json(silent=True) or {}
        if not data:
            return jsonify({"success": False, "error": "No data provided"}), 400

        overridden = _get_env_overridden_fields()
        config_abs = os.path.abspath(config_path)

        try:
            # Read current config from disk
            with open(config_abs, "r") as f:
                disk_cfg = yaml.safe_load(f) or {}

            changes = []
            for section, payload in data.items():
                if section not in _EDITABLE_SCHEMA:
                    continue
                allowed = _EDITABLE_SCHEMA[section]
                disk_section = disk_cfg.setdefault(section, {})

                if allowed == "*":
                    # Replace the entire sub-dict (ptz_cameras, projectors)
                    if isinstance(payload, dict):
                        disk_cfg[section] = payload
                        cfg[section] = copy.deepcopy(payload)
                        changes.append(section)
                else:
                    if not isinstance(payload, dict):
                        continue
                    for field, value in payload.items():
                        if field not in allowed:
                            continue
                        if f"{section}.{field}" in overridden:
                            continue  # Skip env-overridden fields
                        old_val = disk_section.get(field)
                        if old_val != value:
                            disk_section[field] = value
                            # Also update in-memory cfg
                            cfg.setdefault(section, {})[field] = value
                            changes.append(f"{section}.{field}")

            if not changes:
                return jsonify({"success": True, "message": "No changes detected"}), 200

            # Backup before writing
            backup_path = config_abs + ".bak"
            shutil.copy2(config_abs, backup_path)

            # Write updated config
            with open(config_abs, "w") as f:
                yaml.safe_dump(disk_cfg, f, default_flow_style=False,
                               sort_keys=False, allow_unicode=True)

            logger.info(f"Config saved by {_tablet_id()}: {changes}")
            db.log_action(_tablet_id(), "config:save", "config",
                          json.dumps(changes), "OK", 0)

            return jsonify({"success": True, "changes": changes}), 200

        except Exception as e:
            logger.error(f"Config save failed: {e}")
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route("/api/gateway/restart", methods=["POST"])
    def api_gateway_restart():
        """Trigger a gateway restart via the build app's ops API."""
        tablet = _tablet_id()
        logger.info(f"Gateway restart requested by {tablet}")
        db.log_action(tablet, "gateway:restart", "gateway", "", "OK", 0)

        # Notify all connected clients
        socketio.emit("gateway:restarting", {
            "message": "Gateway is restarting...",
            "requested_by": tablet,
        })

        # Ask the build app (port 20856) to restart us properly
        def _do_restart():
            time.sleep(2)
            logger.info("Requesting restart from build app ops API")
            try:
                resp = http_requests.post(
                    "http://127.0.0.1:20856/ops/api/services/tablets_gateway/restart",
                    timeout=30,
                )
                logger.info(f"Build app restart response: {resp.status_code}")
            except Exception as e:
                logger.error(f"Failed to contact build app for restart: {e}")
                # Fallback: exit and hope a process manager restarts us
                logger.info("Falling back to os._exit(0)")
                os._exit(0)

        eventlet.spawn(_do_restart)
        return jsonify({"success": True, "message": "Restarting..."}), 200

    # -------------------------------------------------------------------------
    # AUTH ENDPOINTS
    # -------------------------------------------------------------------------

    @app.route("/api/auth/verify-pin", methods=["POST"])
    def verify_pin():
        data = request.get_json(silent=True) or {}
        pin = data.get("pin", "")
        if pin == settings_pin:
            return jsonify({"success": True}), 200
        return jsonify({"success": False, "error": "Invalid PIN"}), 401

    # HTTP heartbeat removed — heartbeats are handled via SocketIO only
    # (see on_heartbeat event handler below)

    # -------------------------------------------------------------------------
    # MOIP (direct Telnet — Phase 2 consolidation)
    # -------------------------------------------------------------------------

    @app.route("/api/moip/receivers")
    def moip_receivers():
        if mock_mode:
            return jsonify(MockBackend.MOIP_RECEIVERS), 200
        result, status = moip.get_receivers()
        return jsonify(result), status

    @app.route("/api/moip/health")
    def moip_health():
        if mock_mode:
            return jsonify({"healthy": True, "connected": True, "mode": "mock",
                            "last_command_seconds_ago": 0, "failure_streak": 0,
                            "failure_threshold": 50, "last_reboot_seconds_ago": None,
                            "reboot_cooldown_minutes": 15}), 200
        health = moip.get_status()
        return jsonify(health), (200 if health.get("healthy") else 503)

    @app.route("/api/moip/switch", methods=["POST"])
    def moip_switch():
        perm_err = _check_permission(_tablet_id(), "source")
        if perm_err:
            return perm_err
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        tx = data.get("transmitter", "")
        rx = data.get("receiver", "")
        result, status = moip.switch(str(tx), str(rx))
        # Broadcast full receiver state so button highlights update immediately
        if status < 400:
            try:
                fresh, fresh_status = moip.get_receivers()
                if fresh_status < 400 and fresh:
                    state_cache.set("moip", fresh)
                    socketio.emit("state:moip", fresh, room="moip")
            except Exception:
                pass
        return jsonify(result), status

    @app.route("/api/moip/ir", methods=["POST"])
    def moip_ir():
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        # Resolve IR code name to raw Pronto hex code from devices.json
        code = data.get("code", "")
        ir_codes = devices_data.get("moip", {}).get("irCodes", {})
        if code in ir_codes:
            code = ir_codes[code]
        else:
            logger.warning(f"IR code name '{code}' not found in devices.json irCodes")
        tx = data.get("tx", "")
        rx = data.get("rx", "")
        result, status = moip.send_ir(str(tx), str(rx), code)
        return jsonify(result), status

    @app.route("/api/moip/scene", methods=["POST"])
    def moip_scene():
        perm_err = _check_permission(_tablet_id(), "source")
        if perm_err:
            return perm_err
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        scene = data.get("scene", "")
        result, status = moip.activate_scene(str(scene))
        if status < 400:
            socketio.emit("state:moip", {"event": "scene", "data": data}, room="moip")
        return jsonify(result), status

    @app.route("/api/moip/osd", methods=["POST"])
    def moip_osd():
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        text = data.get("text")
        clear = data.get("clear", False)
        result, status = moip.send_osd(text=text, clear=bool(clear))
        return jsonify(result), status

    # -------------------------------------------------------------------------
    # X32 PROXY
    # -------------------------------------------------------------------------

    @app.route("/api/x32/status")
    def x32_status():
        if mock_mode:
            return jsonify(MockBackend.X32_STATUS), 200
        return jsonify(x32.get_status()), 200

    @app.route("/api/x32/health")
    def x32_health():
        if mock_mode:
            return jsonify({"healthy": True, "mixer_type": "X32", "mixer_ip": "mock",
                            "cur_scene": "0", "cur_scene_name": "Mock Scene",
                            "seconds_since_last_ok": 0, "error": ""}), 200
        health = x32.get_health()
        return jsonify(health), (200 if health.get("healthy") else 503)

    @app.route("/api/x32/scene/<int:num>")
    def x32_scene(num: int):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if mock_mode:
            return jsonify({"success": True, "scene": num, "mock": True}), 200
        result, status = x32.set_scene(num)
        if status < 400:
            socketio.emit("state:x32", {"event": "scene", "scene": num}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/mute/<int:ch>/<state>")
    def x32_mute(ch: int, state: str):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "channel": ch, "muted": state == "on", "mock": True}), 200
        result, status = x32.mute_channel(ch, state)
        if status < 400:
            socketio.emit("state:x32", {"event": "mute", "channel": ch, "state": state}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/aux/<int:ch>/mute/<state>")
    def x32_aux_mute(ch: int, state: str):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "aux": ch, "muted": state == "on", "mock": True}), 200
        result, status = x32.mute_aux(ch, state)
        if status < 400:
            socketio.emit("state:x32", {"event": "aux_mute", "aux": ch, "state": state}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/volume/<int:ch>/<direction>")
    def x32_volume(ch: int, direction: str):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if direction not in ("up", "down"):
            return jsonify({"error": "Direction must be 'up' or 'down'"}), 400
        if mock_mode:
            return jsonify({"success": True, "channel": ch, "direction": direction, "mock": True}), 200
        result, status = x32.volume_channel(ch, direction)
        if status < 400:
            socketio.emit("state:x32", {"event": "volume", "channel": ch, "direction": direction}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/bus/<int:ch>/mute/<state>")
    def x32_bus_mute(ch: int, state: str):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "bus": ch, "muted": state == "on", "mock": True}), 200
        result, status = x32.mute_bus(ch, state)
        if status < 400:
            socketio.emit("state:x32", {"event": "bus_mute", "bus": ch, "state": state}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/bus/<int:ch>/volume/<direction>")
    def x32_bus_volume(ch: int, direction: str):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if direction not in ("up", "down"):
            return jsonify({"error": "Direction must be 'up' or 'down'"}), 400
        if mock_mode:
            return jsonify({"success": True, "bus": ch, "direction": direction, "mock": True}), 200
        result, status = x32.volume_bus(ch, direction)
        if status < 400:
            socketio.emit("state:x32", {"event": "bus_volume", "bus": ch, "direction": direction}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/dca/<int:ch>/mute/<state>")
    def x32_dca_mute(ch: int, state: str):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "dca": ch, "muted": state == "on", "mock": True}), 200
        result, status = x32.mute_dca(ch, state)
        if status < 400:
            socketio.emit("state:x32", {"event": "dca_mute", "dca": ch, "state": state}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/dca/<int:ch>/volume/<direction>")
    def x32_dca_volume(ch: int, direction: str):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if direction not in ("up", "down"):
            return jsonify({"error": "Direction must be 'up' or 'down'"}), 400
        if mock_mode:
            return jsonify({"success": True, "dca": ch, "direction": direction, "mock": True}), 200
        result, status = x32.volume_dca(ch, direction)
        if status < 400:
            socketio.emit("state:x32", {"event": "dca_volume", "dca": ch, "direction": direction}, room="x32")
        return jsonify(result), status

    # -------------------------------------------------------------------------
    # OBS (direct WebSocket via OBSModule — Phase 3 consolidation)
    # -------------------------------------------------------------------------

    @app.route("/api/obs/status")
    def obs_status():
        if mock_mode:
            return jsonify({
                "healthy": True,
                "data": {
                    "streaming": True,
                    "recording": False,
                    "current_scene": "MainChurch_Altar",
                    "scenes": ["MainChurch_Altar", "MainChurch_Rear", "Chapel_Rear"],
                },
            }), 200
        result, status_code = obs.get_status()
        return jsonify(result), status_code

    @app.route("/api/obs/call/<request_type>", methods=["POST"])
    def obs_call(request_type: str):
        perm_err = _check_permission(_tablet_id(), "stream")
        if perm_err:
            return perm_err
        payload = request.get_json(silent=True)
        if mock_mode:
            mock_map = {
                "GetVersion": MockBackend.OBS_VERSION,
                "GetStreamStatus": MockBackend.OBS_STREAM_STATUS,
                "GetCurrentProgramScene": MockBackend.OBS_SCENE,
            }
            return jsonify(mock_map.get(request_type, {"result": True, "mock": True})), 200
        result, err = obs.call(request_type, payload)
        if err:
            return jsonify({"result": False, "comment": err}), 503
        return jsonify({"result": True, "requestResult": result}), 200

    @app.route("/api/obs/emit/<request_type>", methods=["POST"])
    def obs_emit(request_type: str):
        perm_err = _check_permission(_tablet_id(), "stream")
        if perm_err:
            return perm_err
        payload = request.get_json(silent=True)
        if mock_mode:
            return jsonify({"result": True, "mock": True}), 200
        err = obs.emit(request_type, payload)
        if err:
            return jsonify({"result": False, "comment": err}), 503
        socketio.emit("state:obs", {"event": request_type, "data": payload}, room="obs")
        return jsonify({"result": True}), 200

    # -------------------------------------------------------------------------
    # PTZ CAMERA CONTROL (server-side, replaces browser no-cors)
    # -------------------------------------------------------------------------

    @app.route("/api/ptz/<camera_key>/command", methods=["POST"])
    def ptz_command(camera_key: str):
        cameras = cfg.get("ptz_cameras", {})
        cam = cameras.get(camera_key)
        if not cam:
            return jsonify({"error": f"Unknown camera: {camera_key}"}), 404

        data = request.get_json(silent=True) or {}
        command = data.get("command", "")
        if not command:
            return jsonify({"error": "Missing 'command' field"}), 400

        if mock_mode:
            return jsonify({"success": True, "camera": camera_key, "command": command, "mock": True}), 200

        url = f"http://{cam['ip']}/cgi-bin/ptzctrl.cgi?ptzcmd&{command}"
        tablet = _tablet_id()
        start = time.time()

        try:
            resp = http_requests.get(url, timeout=3)
            latency = (time.time() - start) * 1000
            success = resp.status_code == 200

            db.log_action(tablet, "ptz:command", camera_key, command,
                          f"status={resp.status_code}", latency)

            return jsonify({
                "success": success,
                "camera": camera_key,
                "command": command,
                "status_code": resp.status_code,
                "latency_ms": round(latency, 1),
            }), 200

        except http_requests.Timeout:
            db.log_action(tablet, "ptz:command", camera_key, command, "timeout", 3000)
            return jsonify({"error": "Camera timeout", "camera": camera_key}), 504
        except http_requests.ConnectionError:
            db.log_action(tablet, "ptz:command", camera_key, command, "unreachable", 0)
            return jsonify({"error": "Camera unreachable", "camera": camera_key}), 503

    @app.route("/api/ptz/<camera_key>/preset/<int:preset_num>", methods=["POST"])
    def ptz_preset(camera_key: str, preset_num: int):
        """Shortcut for calling a preset."""
        cameras = cfg.get("ptz_cameras", {})
        cam = cameras.get(camera_key)
        if not cam:
            return jsonify({"error": f"Unknown camera: {camera_key}"}), 404

        if mock_mode:
            return jsonify({"success": True, "camera": camera_key, "preset": preset_num, "mock": True}), 200

        url = f"http://{cam['ip']}/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&{preset_num}"
        tablet = _tablet_id()
        start = time.time()

        try:
            resp = http_requests.get(url, timeout=3)
            latency = (time.time() - start) * 1000
            db.log_action(tablet, "ptz:preset", camera_key, str(preset_num),
                          f"status={resp.status_code}", latency)
            return jsonify({
                "success": resp.status_code == 200,
                "camera": camera_key,
                "preset": preset_num,
                "latency_ms": round(latency, 1),
            }), 200
        except Exception as e:
            return jsonify({"error": str(e), "camera": camera_key}), 503

    @app.route("/api/ptz/<camera_key>/snapshot")
    def ptz_snapshot(camera_key: str):
        """Proxy a JPEG snapshot from a PTZ camera."""
        cameras = cfg.get("ptz_cameras", {})
        cam = cameras.get(camera_key)
        if not cam:
            return jsonify({"error": f"Unknown camera: {camera_key}"}), 404

        if mock_mode:
            # Return a 1x1 transparent JPEG placeholder
            from io import BytesIO
            return send_file(BytesIO(b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01'
                                     b'\x00\x00\x01\x00\x01\x00\x00\xff\xd9'),
                             mimetype="image/jpeg")

        snapshot_path = cam.get("snapshot_path", "/snapshot.jpg")
        url = f"http://{cam['ip']}{snapshot_path}"
        try:
            resp = http_requests.get(url, timeout=3)
            if resp.status_code != 200:
                return "Camera returned non-200", 502
            ct = resp.headers.get("Content-Type", "image/jpeg")
            return Response(resp.content, content_type=ct,
                            headers={"Cache-Control": "no-store"})
        except http_requests.Timeout:
            return "Camera timeout", 504
        except http_requests.ConnectionError:
            return "Camera unreachable", 503

    # -------------------------------------------------------------------------
    # EPSON PROJECTOR CONTROL (server-side)
    # -------------------------------------------------------------------------

    @app.route("/api/projector/status")
    def projector_status():
        projectors = cfg.get("projectors", {})
        if mock_mode:
            return jsonify({
                k: {"name": v.get("name", k), "power": "on"}
                for k, v in projectors.items()
            }), 200

        statuses = {}
        for key, proj in projectors.items():
            try:
                resp = http_requests.get(
                    f"http://{proj['ip']}/api/v01/contentmgr/remote/power/",
                    timeout=3,
                )
                statuses[key] = {
                    "name": proj.get("name", key),
                    "power": "on" if resp.status_code == 200 else "unknown",
                    "reachable": True,
                }
            except Exception:
                statuses[key] = {
                    "name": proj.get("name", key),
                    "power": "unknown",
                    "reachable": False,
                }

        state_cache.set("projectors", statuses)
        return jsonify(statuses), 200

    @app.route("/api/projector/<projector_key>/power", methods=["POST"])
    def projector_power(projector_key: str):
        projectors = cfg.get("projectors", {})
        proj = projectors.get(projector_key)
        if not proj:
            return jsonify({"error": f"Unknown projector: {projector_key}"}), 404

        data = request.get_json(silent=True) or {}
        state = data.get("state", "")
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400

        if mock_mode:
            return jsonify({"success": True, "projector": projector_key, "state": state, "mock": True}), 200

        url = f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}"
        tablet = _tablet_id()
        start = time.time()

        try:
            resp = http_requests.get(url, timeout=5)
            latency = (time.time() - start) * 1000
            db.log_action(tablet, "projector:power", projector_key, state,
                          f"status={resp.status_code}", latency)
            socketio.emit("state:projectors", {
                "event": "power", "projector": projector_key, "state": state
            }, room="projectors")
            return jsonify({
                "success": resp.status_code == 200,
                "projector": projector_key,
                "state": state,
                "latency_ms": round(latency, 1),
            }), 200
        except http_requests.Timeout:
            return jsonify({"error": "Projector timeout", "projector": projector_key}), 504
        except http_requests.ConnectionError:
            return jsonify({"error": "Projector unreachable", "projector": projector_key}), 503

    @app.route("/api/projector/all/power", methods=["POST"])
    def projector_all_power():
        data = request.get_json(silent=True) or {}
        state = data.get("state", "")
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400

        projectors = cfg.get("projectors", {})
        results = {}

        for key, proj in projectors.items():
            if mock_mode:
                results[key] = {"success": True, "mock": True}
                continue
            url = f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}"
            try:
                resp = http_requests.get(url, timeout=5)
                results[key] = {"success": resp.status_code == 200}
            except Exception as e:
                results[key] = {"success": False, "error": str(e)}

        tablet = _tablet_id()
        db.log_action(tablet, "projector:all_power", "all", state, json.dumps(results)[:500], 0)
        socketio.emit("state:projectors", {"event": "all_power", "state": state}, room="projectors")
        return jsonify(results), 200

    # -------------------------------------------------------------------------
    # FULLY KIOSK BROWSER (screensaver control)
    # -------------------------------------------------------------------------

    @app.route("/api/fully/screensaver", methods=["POST"])
    def fully_screensaver():
        """Set the Fully Kiosk screensaver timeout on the requesting tablet.

        POST JSON: { "timeout": <seconds> }
        Targets 127.0.0.1 since the gateway runs on the tablet alongside Fully Kiosk.
        """
        fk = cfg.get("fully_kiosk", {})
        port = fk.get("port", 2323)
        password = fk.get("password", "")

        data = request.get_json(silent=True) or {}
        timeout = data.get("timeout")
        if timeout is None:
            return jsonify({"error": "Missing 'timeout' parameter"}), 400

        timeout = int(timeout)
        tablet = _tablet_id()

        if mock_mode:
            return jsonify({"success": True, "tablet": tablet, "timeout": timeout, "mock": True}), 200

        base_url = f"http://127.0.0.1:{port}/?password={password}"
        start = time.time()

        try:
            http_requests.get(
                f"{base_url}&cmd=setStringSetting&key=timeToScreensaverV2&value={timeout}",
                timeout=5,
            )
            # Also stop the screensaver if we're extending the timeout
            if timeout > fk.get("screensaver_default", 20):
                http_requests.get(f"{base_url}&cmd=stopScreensaver", timeout=5)

            latency = (time.time() - start) * 1000
            db.log_action(tablet, "fully:screensaver", "127.0.0.1", str(timeout),
                          f"timeout={timeout}s", latency)
            logger.info(f"Fully Kiosk screensaver set to {timeout}s [{tablet}]")
            return jsonify({
                "success": True,
                "tablet": tablet,
                "timeout": timeout,
                "latency_ms": round(latency, 1),
            }), 200
        except http_requests.Timeout:
            logger.warning(f"Fully Kiosk timeout [{tablet}]")
            return jsonify({"error": "Fully Kiosk timeout"}), 504
        except http_requests.ConnectionError:
            logger.warning(f"Fully Kiosk unreachable [{tablet}]")
            return jsonify({"error": "Fully Kiosk unreachable"}), 503

    # -------------------------------------------------------------------------
    # WATTBOX DIRECT CONTROL (break-glass, bypasses Home Assistant)
    # -------------------------------------------------------------------------

    @app.route("/api/wattbox/devices")
    def wattbox_devices():
        """List configured break-glass WattBox devices and their live outlet state."""
        wb_cfg = cfg.get("wattbox", {})
        devices = wb_cfg.get("devices", {})
        if not devices:
            return jsonify({"error": "No WattBox devices configured"}), 404

        result = {}
        for key, dev in devices.items():
            entry = {"label": dev["label"], "ip": dev["ip"], "outlet": dev["outlet"], "state": None}
            if not mock_mode:
                try:
                    resp = http_requests.get(
                        f"http://{dev['ip']}/control.cgi?outlet={dev['outlet']}&command=status",
                        auth=(wb_cfg.get("username", "admin"), wb_cfg.get("password", "")),
                        timeout=wb_cfg.get("timeout", 5),
                    )
                    # WattBox returns outlet state in the response body
                    body = resp.text.strip().lower()
                    entry["state"] = "on" if "1" in body or "on" in body else "off"
                except Exception:
                    entry["state"] = "unknown"
            else:
                entry["state"] = "on"
            result[key] = entry
        return jsonify(result), 200

    @app.route("/api/wattbox/<device_key>/power", methods=["POST"])
    def wattbox_power(device_key: str):
        """Turn a WattBox outlet on, off, or power-cycle it.

        POST JSON: { "action": "on" | "off" | "cycle" }
        """
        wb_cfg = cfg.get("wattbox", {})
        devices = wb_cfg.get("devices", {})
        dev = devices.get(device_key)
        if not dev:
            return jsonify({"error": f"Unknown device: {device_key}"}), 404

        data = request.get_json(silent=True) or {}
        action = data.get("action", "cycle")
        if action not in ("on", "off", "cycle"):
            return jsonify({"error": f"Invalid action: {action}"}), 400

        tablet = _tablet_id()
        # Map action → WattBox command codes (3=on, 4=off, 1=cycle/reboot)
        cmd_map = {"on": 3, "off": 4, "cycle": 1}
        command = cmd_map[action]

        if mock_mode:
            return jsonify({"success": True, "device": device_key, "action": action, "mock": True}), 200

        start = time.time()
        try:
            resp = http_requests.get(
                f"http://{dev['ip']}/control.cgi?outlet={dev['outlet']}&command={command}",
                auth=(wb_cfg.get("username", "admin"), wb_cfg.get("password", "")),
                timeout=wb_cfg.get("timeout", 5),
            )
            latency = (time.time() - start) * 1000
            db.log_action(tablet, f"wattbox:{action}", dev["ip"],
                          f"outlet={dev['outlet']} ({dev['label']})",
                          f"status={resp.status_code}", latency)
            logger.info(f"WattBox {action} → {dev['label']} (outlet {dev['outlet']} @ {dev['ip']}) [{tablet}]")
            return jsonify({
                "success": resp.status_code == 200,
                "device": device_key,
                "action": action,
                "latency_ms": round(latency, 1),
            }), 200
        except http_requests.Timeout:
            logger.warning(f"WattBox timeout: {dev['ip']} [{tablet}]")
            return jsonify({"error": f"WattBox at {dev['ip']} timed out"}), 504
        except http_requests.ConnectionError:
            logger.warning(f"WattBox unreachable: {dev['ip']} [{tablet}]")
            return jsonify({"error": f"WattBox at {dev['ip']} unreachable"}), 503

    # -------------------------------------------------------------------------
    # HOME ASSISTANT PROXY
    # -------------------------------------------------------------------------

    @app.route("/api/ha/states/<path:entity_id>")
    def ha_get_state(entity_id: str):
        ha_cfg = cfg.get("home_assistant", {})
        if mock_mode:
            return jsonify({"entity_id": entity_id, "state": "on", "mock": True}), 200

        url = f"{ha_cfg['url']}/api/states/{entity_id}"
        headers = {
            "Authorization": f"Bearer {ha_cfg['token']}",
            "Content-Type": "application/json",
        }
        try:
            resp = http_requests.get(url, headers=headers, timeout=ha_cfg.get("timeout", 10))
            return jsonify(resp.json()), resp.status_code
        except Exception as e:
            return jsonify({"error": str(e)}), 503

    @app.route("/api/ha/service/<domain>/<service>", methods=["POST"])
    def ha_call_service(domain: str, service: str):
        ha_cfg = cfg.get("home_assistant", {})
        data = request.get_json(silent=True) or {}

        if mock_mode:
            return jsonify({"success": True, "domain": domain, "service": service, "mock": True}), 200

        url = f"{ha_cfg['url']}/api/services/{domain}/{service}"
        headers = {
            "Authorization": f"Bearer {ha_cfg['token']}",
            "Content-Type": "application/json",
        }
        tablet = _tablet_id()
        start = time.time()

        try:
            resp = http_requests.post(url, headers=headers, json=data,
                                      timeout=ha_cfg.get("timeout", 10))
            latency = (time.time() - start) * 1000
            db.log_action(tablet, f"ha:{domain}/{service}", "home_assistant",
                          json.dumps(data)[:500], f"status={resp.status_code}", latency)
            return jsonify(resp.json() if resp.content else {"success": True}), resp.status_code
        except Exception as e:
            return jsonify({"error": str(e)}), 503

    def _fetch_all_ha_entities():
        """Fetch all entity states from Home Assistant in one bulk call."""
        ha_cfg = cfg.get("home_assistant", {})
        if not ha_cfg.get("url") or not ha_cfg.get("token"):
            return None, "Home Assistant not configured"
        resp = http_requests.get(
            f"{ha_cfg['url']}/api/states",
            headers={"Authorization": f"Bearer {ha_cfg['token']}"},
            timeout=ha_cfg.get("timeout", 10),
        )
        if resp.status_code != 200:
            return None, f"HA returned {resp.status_code}"
        return resp.json(), None

    # ---- HA device cache (cameras + locks, built at startup) ----------------

    _ha_device_cache = {"cameras": [], "locks": [], "ready": False}

    def _build_ha_device_cache():
        """Build the cameras and locks lists from a single HA states fetch."""
        if mock_mode:
            _ha_device_cache["ready"] = True
            return

        try:
            all_entities, err = _fetch_all_ha_entities()
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
        # Collect candidate entities by type, indexed by full entity state
        door_sensors = {}     # base_name -> state string
        rule_candidates = {}  # entity_id -> {name, state, options}
        dur_candidates = {}   # entity_id -> {name, state, attrs}
        entity_by_id = {}     # entity_id -> full entity object

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
            """Find the candidate whose name shares the longest common prefix."""
            # Try variants: full name, without _door suffix
            variants = [base_name]
            if base_name.endswith("_door"):
                variants.append(base_name[:-5])
            best_eid, best_len, best_cname_len = None, 0, float('inf')
            for eid, cname in candidates.items():
                for v in variants:
                    if v in cname:
                        # Prefer longest variant match; break ties by shortest
                        # candidate name (more specific match). This prevents
                        # e.g. "main_church_door" from matching
                        # "north_side_of_main_church_door_lock_rule" when a
                        # shorter, more specific candidate exists.
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

            # Get the rule entity's options so the frontend uses the exact strings
            rule_options = None
            if matched_rule and matched_rule in entity_by_id:
                rule_attrs = entity_by_id[matched_rule].get("attributes", {})
                rule_options = rule_attrs.get("options", [])

            # Get the duration entity's min/max/step
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

        _ha_device_cache["cameras"] = cameras
        _ha_device_cache["locks"] = locks
        _ha_device_cache["ready"] = True
        logger.info(f"HA device cache refreshed: {len(cameras)} cameras, {len(locks)} locks")

    @app.route("/api/ha/entities")
    def ha_entities():
        """Return HA entities grouped by domain.

        Query params:
            domain  – filter to a single domain (e.g. 'switch')
            q       – text search across entity_id / friendly_name
            summary – if '1' (default when no filters), return only domain
                      names + counts, no entity details.  When a domain or
                      search query is supplied the full entity list is returned
                      automatically.
        """
        if mock_mode:
            return jsonify({"total": 0, "domains": {}, "mock": True}), 200

        domain_filter = request.args.get("domain", "").strip()
        search = request.args.get("q", "").strip().lower()
        # Default to summary mode when no filters are applied
        summary_only = (not domain_filter and not search)

        try:
            all_entities, err = _fetch_all_ha_entities()
            if err:
                return jsonify({"error": err}), 503
        except Exception as e:
            return jsonify({"error": str(e)}), 503

        domains = {}
        for entity in all_entities:
            eid = entity.get("entity_id", "")
            domain = eid.split(".")[0] if "." in eid else "unknown"
            attrs = entity.get("attributes", {})
            friendly = attrs.get("friendly_name", "")

            if domain_filter and domain != domain_filter:
                continue
            if search and search not in eid.lower() and search not in friendly.lower():
                continue

            if domain not in domains:
                domains[domain] = {"count": 0, "entities": []}

            domains[domain]["count"] += 1

            if not summary_only:
                domains[domain]["entities"].append({
                    "entity_id": eid,
                    "state": entity.get("state", "unknown"),
                    "friendly_name": friendly,
                    "device_class": attrs.get("device_class", ""),
                    "attributes": attrs,
                    "last_changed": entity.get("last_changed", ""),
                })

        # Sort domains alphabetically, entities by entity_id within each domain
        sorted_domains = {}
        for d in sorted(domains.keys()):
            if not summary_only:
                domains[d]["entities"].sort(key=lambda e: e["entity_id"])
            else:
                domains[d].pop("entities", None)
            sorted_domains[d] = domains[d]

        total = sum(d["count"] for d in sorted_domains.values())
        return jsonify({"total": total, "domains": sorted_domains,
                        "summary": summary_only}), 200

    @app.route("/api/ha/entities/yaml")
    def ha_entities_yaml():
        """Return all HA entities as a downloadable YAML reference file."""
        if mock_mode:
            return "# Mock mode — no HA entities available\n", 200, {"Content-Type": "text/yaml"}

        try:
            all_entities, err = _fetch_all_ha_entities()
            if err:
                return f"# Error: {err}\n", 503, {"Content-Type": "text/yaml"}
        except Exception as e:
            return f"# Error: {e}\n", 503, {"Content-Type": "text/yaml"}

        # Group by domain
        domains = {}
        for entity in all_entities:
            eid = entity.get("entity_id", "")
            domain = eid.split(".")[0] if "." in eid else "unknown"
            attrs = entity.get("attributes", {})

            if domain not in domains:
                domains[domain] = []

            # Build a clean entry — include key attributes, skip bloat
            entry = {
                "entity_id": eid,
                "state": entity.get("state", "unknown"),
                "friendly_name": attrs.get("friendly_name", ""),
            }
            if attrs.get("device_class"):
                entry["device_class"] = attrs["device_class"]
            if attrs.get("unit_of_measurement"):
                entry["unit"] = attrs["unit_of_measurement"]

            # Include relevant attributes based on domain
            if domain == "climate":
                for key in ("current_temperature", "temperature", "hvac_modes",
                            "hvac_action", "fan_mode", "preset_mode"):
                    if key in attrs:
                        entry[key] = attrs[key]
            elif domain == "sensor":
                if attrs.get("state_class"):
                    entry["state_class"] = attrs["state_class"]
            elif domain in ("switch", "light", "fan"):
                pass  # state is enough
            elif domain == "media_player":
                for key in ("media_title", "source", "volume_level"):
                    if key in attrs:
                        entry[key] = attrs[key]

            domains[domain].append(entry)

        # Sort
        for d in domains:
            domains[d].sort(key=lambda e: e["entity_id"])

        from datetime import datetime
        total = sum(len(v) for v in domains.values())
        lines = [
            f"# Home Assistant Entity Reference",
            f"# Generated: {datetime.now().isoformat(timespec='seconds')}",
            f"# Total: {total} entities across {len(domains)} domains",
            f"#",
            f"# Usage in macros.yaml button configs:",
            f"#   state:  {{ source: ha, entity: \"switch.example\", on_value: \"on\", on_style: \"active\" }}",
            f"#   badge:  {{ source: ha, entity: \"sensor.example\", format: \"percent\" }}",
            f"#   badge:  {{ source: ha, entity: \"climate.example\", attribute: \"current_temperature\", format: \"temp\" }}",
            f"",
        ]

        output = "\n".join(lines) + "\n" + yaml.dump(
            dict(sorted(domains.items())),
            default_flow_style=False,
            allow_unicode=True,
            sort_keys=False,
            width=120,
        )

        return output, 200, {
            "Content-Type": "text/yaml; charset=utf-8",
            "Content-Disposition": "inline; filename=ha_entities.yaml",
        }

    # -------------------------------------------------------------------------
    # HA CAMERA PROXY (snapshot + MJPEG stream)
    # -------------------------------------------------------------------------

    @app.route("/api/ha/cameras")
    def ha_cameras():
        """Return cached camera entities (refreshed every 5 min)."""
        if mock_mode:
            return jsonify({"cameras": []}), 200
        if not _ha_device_cache["ready"]:
            return jsonify({"cameras": [], "warming": True}), 200
        return jsonify({"cameras": _ha_device_cache["cameras"]}), 200

    @app.route("/api/ha/camera/<path:entity_id>/snapshot")
    def ha_camera_snapshot(entity_id: str):
        """Proxy a JPEG snapshot from an HA camera entity."""
        ha_cfg = cfg.get("home_assistant", {})
        if not entity_id.startswith("camera."):
            entity_id = f"camera.{entity_id}"

        if mock_mode:
            from io import BytesIO
            return send_file(BytesIO(b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01'
                                     b'\x00\x00\x01\x00\x01\x00\x00\xff\xd9'),
                             mimetype="image/jpeg")

        url = f"{ha_cfg['url']}/api/camera_proxy/{entity_id}"
        headers = {"Authorization": f"Bearer {ha_cfg['token']}"}
        try:
            resp = http_requests.get(url, headers=headers, timeout=10)
            if resp.status_code != 200:
                return f"HA returned {resp.status_code}", resp.status_code
            ct = resp.headers.get("Content-Type", "image/jpeg")
            return Response(resp.content, content_type=ct,
                            headers={"Cache-Control": "no-store"})
        except http_requests.Timeout:
            return "HA camera timeout", 504
        except http_requests.ConnectionError:
            return "HA unreachable", 503

    @app.route("/api/ha/camera/<path:entity_id>/stream")
    def ha_camera_stream(entity_id: str):
        """Proxy an MJPEG stream from an HA camera entity."""
        ha_cfg = cfg.get("home_assistant", {})
        if not entity_id.startswith("camera."):
            entity_id = f"camera.{entity_id}"

        if mock_mode:
            return "MJPEG not available in mock mode", 503

        url = f"{ha_cfg['url']}/api/camera_proxy_stream/{entity_id}"
        headers = {"Authorization": f"Bearer {ha_cfg['token']}"}
        try:
            resp = http_requests.get(url, headers=headers, timeout=30, stream=True)
            if resp.status_code != 200:
                return f"HA returned {resp.status_code}", resp.status_code
            ct = resp.headers.get("Content-Type", "multipart/x-mixed-replace")
            return Response(resp.iter_content(chunk_size=8192),
                            content_type=ct,
                            headers={"Cache-Control": "no-store"})
        except http_requests.Timeout:
            return "HA stream timeout", 504
        except http_requests.ConnectionError:
            return "HA unreachable", 503

    # -------------------------------------------------------------------------
    # HA LOCK / ACCESS CONTROL PROXY
    # -------------------------------------------------------------------------

    @app.route("/api/ha/locks")
    def ha_locks():
        """Return cached lock entities (refreshed every 5 min)."""
        if mock_mode:
            return jsonify({"locks": []}), 200
        if not _ha_device_cache["ready"]:
            return jsonify({"locks": [], "warming": True}), 200
        return jsonify({"locks": _ha_device_cache["locks"]}), 200

    # -------------------------------------------------------------------------
    # AUDIT LOG ENDPOINT (admin only)
    # -------------------------------------------------------------------------

    @app.route("/api/audit/logs")
    def audit_logs():
        limit = request.args.get("limit", 100, type=int)
        return jsonify(db.get_recent_logs(limit)), 200

    @app.route("/api/audit/sessions")
    def audit_sessions():
        return jsonify(db.get_sessions()), 200

    # -------------------------------------------------------------------------
    # MACRO ENGINE
    # -------------------------------------------------------------------------

    # Load macros config
    macros_path = os.path.join(os.path.dirname(__file__), "macros.yaml")
    try:
        with open(macros_path, "r") as f:
            macros_cfg = yaml.safe_load(f) or {}
    except Exception as e:
        logger.warning(f"Could not load macros.yaml: {e}")
        macros_cfg = {}

    # YAML parses bare on:/off:/yes:/no: as boolean True/False keys.
    # Recursively convert them back to their intended string names.
    _BOOL_KEY_MAP = {True: "on", False: "off"}

    def _normalize_yaml_keys(obj):
        if isinstance(obj, dict):
            return {_BOOL_KEY_MAP.get(k, k) if isinstance(k, bool) else k: _normalize_yaml_keys(v)
                    for k, v in obj.items()}
        if isinstance(obj, list):
            return [_normalize_yaml_keys(i) for i in obj]
        return obj

    macros_cfg = _normalize_yaml_keys(macros_cfg)

    macro_defs = macros_cfg.get("macros", {})
    button_defs = macros_cfg.get("buttons", {})

    # Collect all HA entity IDs referenced by button state bindings
    ha_state_entities: set = set()
    for page_sections in button_defs.values():
        for section in page_sections:
            for item in section.get("items", []):
                st = item.get("state")
                if st and st.get("source") == "ha" and st.get("entity"):
                    ha_state_entities.add(st["entity"])
                # Also scan toggle state bindings
                toggle = item.get("toggle")
                if toggle:
                    tst = toggle.get("state")
                    if tst and tst.get("source") == "ha" and tst.get("entity"):
                        ha_state_entities.add(tst["entity"])
                # Also scan badge bindings
                badge = item.get("badge")
                if badge and badge.get("source") == "ha" and badge.get("entity"):
                    ha_state_entities.add(badge["entity"])
                # Also scan disabled_when bindings
                dw = item.get("disabled_when")
                if dw and dw.get("source") == "ha" and dw.get("entity"):
                    ha_state_entities.add(dw["entity"])
            # Section-level disabled_when
            sdw = section.get("disabled_when")
            if sdw and sdw.get("source") == "ha" and sdw.get("entity"):
                ha_state_entities.add(sdw["entity"])

    def _execute_macro(macro_key: str, tablet: str, depth: int = 0,
                       skip_steps: set = None, prefix: str = "") -> dict:
        """Execute a macro by key. Returns {success, steps_completed, steps_total, error}.
        skip_steps: set of dot-notation indices to skip (e.g., {"0", "1.2", "3"}).
        prefix: current nesting path (e.g., "0." for first nested macro).
        """
        if skip_steps is None:
            skip_steps = set()
        if depth > 5:
            return {"success": False, "error": "Max nesting depth (5) exceeded"}

        macro = macro_defs.get(macro_key)
        if not macro:
            return {"success": False, "error": f"Unknown macro: {macro_key}"}

        steps = macro.get("steps", [])
        label = macro.get("label", macro_key)

        if not steps:
            return {"success": True, "steps_completed": 0, "steps_total": 0}

        # Broadcast: macro starting
        socketio.emit("macro:progress", {
            "macro": macro_key,
            "label": label,
            "status": "started",
            "tablet": tablet,
            "steps_total": len(steps),
            "steps_completed": 0,
        })

        completed = 0
        overall_start = time.time()

        for i, step in enumerate(steps):
            step_path = f"{prefix}{i}"
            step_type = step.get("type", "")
            step_msg = step.get("message", "")
            on_fail = step.get("on_fail", "abort")

            # Check if this step should be skipped
            if step_path in skip_steps:
                logger.info(f"Macro {macro_key} step {i+1} skipped by user (path={step_path})")
                completed += 1
                continue

            # Broadcast: step starting
            socketio.emit("macro:progress", {
                "macro": macro_key,
                "label": label,
                "status": "in_progress",
                "tablet": tablet,
                "steps_total": len(steps),
                "steps_completed": completed,
                "current_step": step_msg or f"Step {i+1}: {step_type}",
            })

            # For nested macros, pass down the skip_steps with adjusted prefix
            if step_type == "macro":
                child_key = step.get("macro", "")
                child_prefix = f"{step_path}."
                result = _execute_macro(child_key, tablet, depth + 1,
                                        skip_steps=skip_steps, prefix=child_prefix)
            else:
                result = _execute_step(step, tablet, depth)

            if _verbose_logging:
                status_str = "OK" if result["success"] else f"FAIL: {result.get('error', '')}"
                logger.debug(f"[VERBOSE] Macro {macro_key} step {i+1}/{len(steps)} "
                             f"type={step_type} {status_str}")

            if result["success"]:
                completed += 1
            else:
                # Handle on_fail
                if on_fail == "skip":
                    logger.warning(f"Macro {macro_key} step {i+1} skipped: {result.get('error', '')}")
                    completed += 1
                    continue
                elif on_fail.startswith("retry:"):
                    retries = int(on_fail.split(":")[1])
                    retry_ok = False
                    for attempt in range(retries):
                        time.sleep(1)
                        result = _execute_step(step, tablet, depth)
                        if result["success"]:
                            retry_ok = True
                            break
                    if retry_ok:
                        completed += 1
                        continue
                    # All retries exhausted — fall through to abort
                    pass

                # Abort
                overall_ms = (time.time() - overall_start) * 1000
                step_error = result.get("error", "")
                error_msg = (f"{step_msg}: {step_error}" if step_msg and step_error
                             else step_error or step_msg or f"Step {i+1} ({step_type}) failed")

                socketio.emit("macro:progress", {
                    "macro": macro_key,
                    "label": label,
                    "status": "failed",
                    "tablet": tablet,
                    "steps_total": len(steps),
                    "steps_completed": completed,
                    "error": error_msg,
                })

                db.log_action(tablet, "macro:execute", macro_key,
                              json.dumps({"label": label, "steps": len(steps)}),
                              f"FAILED at step {i+1}: {error_msg}", overall_ms)

                return {
                    "success": False,
                    "macro": macro_key,
                    "label": label,
                    "steps_completed": completed,
                    "steps_total": len(steps),
                    "error": error_msg,
                    "latency_ms": round(overall_ms, 1),
                }

        # All steps completed
        overall_ms = (time.time() - overall_start) * 1000

        socketio.emit("macro:progress", {
            "macro": macro_key,
            "label": label,
            "status": "completed",
            "tablet": tablet,
            "steps_total": len(steps),
            "steps_completed": completed,
        })

        db.log_action(tablet, "macro:execute", macro_key,
                      json.dumps({"label": label, "steps": len(steps)}),
                      f"OK {completed}/{len(steps)} steps", overall_ms)

        # Force fresh MoIP state broadcast so button highlights update immediately
        try:
            if moip is not None:
                fresh, fresh_status = moip.get_receivers()
                if fresh_status < 400 and fresh:
                    state_cache.set("moip", fresh)
                    socketio.emit("state:moip", fresh, room="moip")
        except Exception:
            pass  # Background poller will catch up

        return {
            "success": True,
            "macro": macro_key,
            "label": label,
            "steps_completed": completed,
            "steps_total": len(steps),
            "latency_ms": round(overall_ms, 1),
        }

    def _execute_step(step: dict, tablet: str, depth: int) -> dict:
        """Execute a single macro step. Returns {success, error?}."""
        step_type = step.get("type", "")
        try:
            if step_type == "ha_check":
                return _step_ha_check(step)
            elif step_type == "ha_service":
                return _step_ha_service(step, tablet)
            elif step_type == "door_timed_unlock":
                return _step_door_timed_unlock(step, tablet)
            elif step_type == "moip_switch":
                return _step_moip_switch(step, tablet)
            elif step_type == "moip_ir":
                return _step_moip_ir(step, tablet)
            elif step_type == "epson_power":
                return _step_epson_power(step, tablet)
            elif step_type == "epson_all":
                return _step_epson_all(step, tablet)
            elif step_type == "x32_scene":
                return _step_x32_scene(step, tablet)
            elif step_type == "x32_mute":
                return _step_x32_mute(step, tablet)
            elif step_type == "x32_aux_mute":
                return _step_x32_aux_mute(step, tablet)
            elif step_type == "obs_emit":
                return _step_obs_emit(step, tablet)
            elif step_type == "ptz_preset":
                return _step_ptz_preset(step, tablet)
            elif step_type == "parallel":
                return _step_parallel(step, tablet, depth)
            elif step_type == "delay":
                secs = step.get("seconds", 1)
                time.sleep(secs)
                return {"success": True}
            elif step_type == "macro":
                child_key = step.get("macro", "")
                return _execute_macro(child_key, tablet, depth + 1)
            elif step_type == "condition":
                return _step_condition(step, tablet, depth)
            elif step_type == "notify":
                msg = step.get("message", "")
                socketio.emit("notification", {"message": msg})
                return {"success": True}
            else:
                return {"success": False, "error": f"Unknown step type: {step_type}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # --- Individual step type implementations ---

    def _step_ha_check(step: dict) -> dict:
        entity = step.get("entity", "")
        expect = step.get("expect", "")
        ha_cfg = cfg.get("home_assistant", {})
        if mock_mode:
            return {"success": True}
        try:
            resp = http_requests.get(
                f"{ha_cfg['url']}/api/states/{entity}",
                headers={"Authorization": f"Bearer {ha_cfg['token']}"},
                timeout=ha_cfg.get("timeout", 10),
            )
            data = resp.json()
            actual = data.get("state", "")
            if str(actual) == str(expect):
                return {"success": True}
            return {"success": False, "error": f"{entity} is '{actual}', expected '{expect}'"}
        except Exception as e:
            return {"success": False, "error": f"HA check failed: {e}"}

    def _step_ha_service(step: dict, tablet: str) -> dict:
        domain = step.get("domain", "")
        service = step.get("service", "")
        data = step.get("data", {})
        ha_cfg = cfg.get("home_assistant", {})
        if _verbose_logging:
            logger.debug(f"[VERBOSE] ha_service: {domain}/{service}, data={json.dumps(data)[:200]}")
        if mock_mode:
            return {"success": True}
        try:
            resp = http_requests.post(
                f"{ha_cfg['url']}/api/services/{domain}/{service}",
                headers={
                    "Authorization": f"Bearer {ha_cfg['token']}",
                    "Content-Type": "application/json",
                },
                json=data,
                timeout=ha_cfg.get("timeout", 10),
            )
            ok = resp.status_code < 400
            if _verbose_logging:
                logger.debug(f"[VERBOSE] ha_service result: {domain}/{service} status={resp.status_code}")
            if ok:
                db.log_action(tablet, f"macro:ha:{domain}/{service}", "home_assistant",
                              json.dumps(data)[:500], f"status={resp.status_code}", 0)
            else:
                resp_body = ""
                try:
                    resp_body = resp.text[:300]
                except Exception:
                    pass
                logger.warning(f"ha_service FAILED: {domain}/{service} status={resp.status_code} "
                               f"data={json.dumps(data)[:200]} response={resp_body}")
                db.log_action(tablet, f"macro:ha:{domain}/{service}", "home_assistant",
                              json.dumps(data)[:500], f"FAILED status={resp.status_code}: {resp_body[:200]}", 0)
            return {"success": ok, "error": "" if ok else f"HA {domain}/{service} returned {resp.status_code}"}
        except Exception as e:
            return {"success": False, "error": f"HA service failed: {e}"}

    def _step_door_timed_unlock(step: dict, tablet: str) -> dict:
        """Unlock a door for a given duration using the HA lock cache to resolve entities and options."""
        lock_entity = step.get("entity", "")
        minutes = step.get("minutes", 60)
        ha_cfg = cfg.get("home_assistant", {})

        if mock_mode:
            return {"success": True}

        # Find the lock in the HA device cache
        locks = _ha_device_cache.get("locks", [])
        lock = next((l for l in locks if l["entity_id"] == lock_entity), None)
        if not lock:
            return {"success": False, "error": f"Lock entity {lock_entity} not found in HA cache"}

        dur_entity = lock.get("duration_entity")
        rule_entity = lock.get("lock_rule_entity")
        rule_options = lock.get("lock_rule_options") or []

        if not dur_entity or not rule_entity:
            return {"success": False, "error": f"Lock {lock_entity} missing duration or rule entity"}

        # Resolve the "custom" option string dynamically (case-insensitive substring match)
        custom_option = next((opt for opt in rule_options if "custom" in opt.lower()), None)
        if not custom_option:
            return {"success": False, "error": f"No 'custom' option found in {rule_entity} options: {rule_options}"}

        dur_domain = dur_entity.split(".")[0]
        rule_domain = rule_entity.split(".")[0]
        errors = []

        # Step 1: Set the duration
        try:
            resp = http_requests.post(
                f"{ha_cfg['url']}/api/services/{dur_domain}/set_value",
                headers={"Authorization": f"Bearer {ha_cfg['token']}", "Content-Type": "application/json"},
                json={"entity_id": dur_entity, "value": minutes},
                timeout=ha_cfg.get("timeout", 10),
            )
            if resp.status_code >= 400:
                errors.append(f"set_value {dur_entity}={minutes} returned {resp.status_code}")
        except Exception as e:
            errors.append(f"set_value {dur_entity}: {e}")

        # Step 2: Trigger the custom rule option
        try:
            resp = http_requests.post(
                f"{ha_cfg['url']}/api/services/{rule_domain}/select_option",
                headers={"Authorization": f"Bearer {ha_cfg['token']}", "Content-Type": "application/json"},
                json={"entity_id": rule_entity, "option": custom_option},
                timeout=ha_cfg.get("timeout", 10),
            )
            if resp.status_code >= 400:
                errors.append(f"select_option {rule_entity}='{custom_option}' returned {resp.status_code}")
        except Exception as e:
            errors.append(f"select_option {rule_entity}: {e}")

        ok = len(errors) == 0
        friendly = lock.get("friendly_name", lock_entity)
        db.log_action(tablet, "macro:door_timed_unlock", friendly,
                      json.dumps({"entity": lock_entity, "minutes": minutes, "option": custom_option}),
                      "OK" if ok else f"FAILED: {'; '.join(errors)}", 0)

        if ok:
            logger.info(f"Door unlocked: {friendly} for {minutes}min (option='{custom_option}')")
            return {"success": True}
        return {"success": False, "error": "; ".join(errors)}

    def _step_moip_switch(step: dict, tablet: str) -> dict:
        tx = str(step.get("tx", ""))
        rx = str(step.get("rx", ""))
        if _verbose_logging:
            logger.debug(f"[VERBOSE] moip_switch: tx={tx}, rx={rx}, tablet={tablet}")
        if mock_mode:
            return {"success": True}
        start = time.time()
        result, status = moip.switch(tx, rx)
        latency = (time.time() - start) * 1000
        ok = status < 400
        if _verbose_logging:
            logger.debug(f"[VERBOSE] moip_switch result: tx={tx}->rx={rx} status={status}")
        db.log_action(tablet, "macro:moip_switch", f"TX{tx}->RX{rx}",
                      json.dumps({"tx": tx, "rx": rx}),
                      "OK" if ok else f"FAILED status={status}", latency)
        if ok:
            socketio.emit("state:moip", {"event": "switch", "data": {"transmitter": tx, "receiver": rx}}, room="moip")
        return {"success": ok, "error": "" if ok else f"MoIP switch failed: tx={tx}, rx={rx}, status={status}"}

    def _step_moip_ir(step: dict, tablet: str) -> dict:
        rx = str(step.get("receiver", ""))
        code_name = step.get("code", "")
        # Resolve IR code name to raw Pronto hex code from devices.json
        ir_codes = devices_data.get("moip", {}).get("irCodes", {})
        code = ir_codes.get(code_name, code_name)
        if code_name not in ir_codes:
            logger.warning(f"IR code name '{code_name}' not found in devices.json irCodes")
        if _verbose_logging:
            logger.debug(f"[VERBOSE] moip_ir: receiver={rx}, code_name={code_name}, tablet={tablet}")
        if mock_mode:
            return {"success": True}
        start = time.time()
        result, status = moip.send_ir("0", rx, code)
        latency = (time.time() - start) * 1000
        ok = status < 400
        if _verbose_logging:
            logger.debug(f"[VERBOSE] moip_ir result: receiver={rx}, code={code}, "
                         f"status={status}, response={json.dumps(result)[:200]}")
        db.log_action(tablet, "macro:moip_ir", f"RX{rx}:{code_name}",
                      json.dumps({"rx": rx, "code_name": code_name}),
                      "OK" if ok else f"FAILED status={status}", latency)
        if not ok:
            logger.warning(f"moip_ir FAILED: receiver={rx}, code={code}, status={status}")
        return {"success": ok, "error": "" if ok else f"IR failed: receiver={rx}, code={code}, status={status}"}

    def _step_epson_power(step: dict, tablet: str) -> dict:
        key = step.get("projector", "")
        state = step.get("state", "on")
        projectors = cfg.get("projectors", {})
        proj = projectors.get(key)
        if not proj:
            return {"success": False, "error": f"Unknown projector: {key}"}
        if mock_mode:
            return {"success": True}
        try:
            start = time.time()
            resp = http_requests.get(
                f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}", timeout=5)
            latency = (time.time() - start) * 1000
            ok = resp.status_code == 200
            socketio.emit("state:projectors", {"event": "power", "projector": key, "state": state}, room="projectors")
            db.log_action(tablet, "macro:epson_power", key,
                          json.dumps({"projector": key, "state": state}),
                          "OK" if ok else f"FAILED status={resp.status_code}", latency)
            if ok:
                return {"success": True}
            return {"success": False, "error": f"Projector {key} returned HTTP {resp.status_code}"}
        except Exception as e:
            db.log_action(tablet, "macro:epson_power", key,
                          json.dumps({"projector": key, "state": state}),
                          f"FAILED: {e}", 0)
            return {"success": False, "error": str(e)}

    def _step_epson_all(step: dict, tablet: str) -> dict:
        state = step.get("state", "on")
        projectors = cfg.get("projectors", {})
        if mock_mode:
            return {"success": True}
        for key, proj in projectors.items():
            try:
                http_requests.get(
                    f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}", timeout=5)
            except Exception:
                pass  # Best-effort for all projectors
        socketio.emit("state:projectors", {"event": "all_power", "state": state}, room="projectors")
        return {"success": True}

    def _step_x32_scene(step: dict, tablet: str) -> dict:
        num = step.get("scene", 0)
        if mock_mode:
            return {"success": True}
        start = time.time()
        result, status = x32.set_scene(num)
        latency = (time.time() - start) * 1000
        ok = status < 400
        error_detail = "" if not ok else ""
        if not ok:
            error_detail = result.get("error", "") if isinstance(result, dict) else str(result)
        db.log_action(tablet, "macro:x32_scene", f"scene_{num}",
                      json.dumps({"scene": num}),
                      "OK" if ok else f"FAILED: {error_detail}" if error_detail else "FAILED", latency)
        if ok:
            socketio.emit("state:x32", {"event": "scene", "scene": num}, room="x32")
            return {"success": True}
        return {"success": False, "error": error_detail or f"X32 scene {num} failed"}

    def _step_x32_mute(step: dict, tablet: str) -> dict:
        ch = step.get("channel", 1)
        state = step.get("state", "on")
        if mock_mode:
            return {"success": True}
        start = time.time()
        result, status = x32.mute_channel(ch, state)
        latency = (time.time() - start) * 1000
        ok = status < 400
        error_detail = "" if ok else (result.get("error", "") if isinstance(result, dict) else str(result))
        db.log_action(tablet, "macro:x32_mute", f"ch{ch}_{state}",
                      json.dumps({"channel": ch, "state": state}),
                      "OK" if ok else f"FAILED: {error_detail}" if error_detail else "FAILED", latency)
        if ok:
            socketio.emit("state:x32", {"event": "mute", "channel": ch, "state": state}, room="x32")
            return {"success": True}
        return {"success": False, "error": error_detail or f"X32 mute ch{ch} failed"}

    def _step_x32_aux_mute(step: dict, tablet: str) -> dict:
        ch = step.get("channel", 1)
        state = step.get("state", "on")
        if mock_mode:
            return {"success": True}
        start = time.time()
        result, status = x32.mute_aux(ch, state)
        latency = (time.time() - start) * 1000
        ok = status < 400
        error_detail = "" if ok else (result.get("error", "") if isinstance(result, dict) else str(result))
        db.log_action(tablet, "macro:x32_aux_mute", f"aux{ch}_{state}",
                      json.dumps({"channel": ch, "state": state}),
                      "OK" if ok else f"FAILED: {error_detail}" if error_detail else "FAILED", latency)
        if ok:
            socketio.emit("state:x32", {"event": "aux_mute", "aux": ch, "state": state}, room="x32")
            return {"success": True}
        return {"success": False, "error": error_detail or f"X32 aux{ch} mute failed"}

    def _step_obs_emit(step: dict, tablet: str) -> dict:
        action = step.get("action", "")
        payload = step.get("data")
        if mock_mode:
            return {"success": True}
        start = time.time()
        err = obs.emit(action, payload)
        latency = (time.time() - start) * 1000
        ok = err is None
        db.log_action(tablet, "macro:obs_emit", action,
                      json.dumps(payload)[:500] if payload else "",
                      "OK" if ok else f"FAILED: {err}", latency)
        if ok:
            socketio.emit("state:obs", {"event": action, "data": payload}, room="obs")
            return {"success": True}
        return {"success": False, "error": err or f"OBS {action} failed"}

    def _step_ptz_preset(step: dict, tablet: str) -> dict:
        cam_key = step.get("camera", "")
        preset = step.get("preset", 1)
        cameras = cfg.get("ptz_cameras", {})
        cam = cameras.get(cam_key)
        if not cam:
            return {"success": False, "error": f"Unknown camera: {cam_key}"}
        if mock_mode:
            return {"success": True}
        try:
            start = time.time()
            resp = http_requests.get(
                f"http://{cam['ip']}/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&{preset}", timeout=3)
            latency = (time.time() - start) * 1000
            ok = resp.status_code == 200
            db.log_action(tablet, "macro:ptz_preset", f"{cam_key}:preset_{preset}",
                          json.dumps({"camera": cam_key, "preset": preset}),
                          "OK" if ok else f"FAILED status={resp.status_code}", latency)
            if ok:
                return {"success": True}
            return {"success": False, "error": f"Camera {cam_key} preset {preset} failed (HTTP {resp.status_code})"}
        except Exception as e:
            db.log_action(tablet, "macro:ptz_preset", f"{cam_key}:preset_{preset}",
                          json.dumps({"camera": cam_key, "preset": preset}),
                          f"FAILED: {e}", 0)
            return {"success": False, "error": str(e)}

    def _step_parallel(step: dict, tablet: str, depth: int) -> dict:
        """Run sub-steps concurrently. Succeeds only if ALL sub-steps succeed.
        on_fail on each sub-step is respected individually.
        """
        sub_steps = step.get("steps", [])
        if not sub_steps:
            return {"success": True}

        on_fail = step.get("on_fail", "abort")

        def run_sub(sub_step):
            sub_type = sub_step.get("type", "")
            if sub_type == "macro":
                child_key = sub_step.get("macro", "")
                return _execute_macro(child_key, tablet, depth + 1)
            return _execute_step(sub_step, tablet, depth)

        errors = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(sub_steps)) as pool:
            futures = {pool.submit(run_sub, s): s for s in sub_steps}
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                if not result["success"]:
                    sub = futures[future]
                    sub_on_fail = sub.get("on_fail", on_fail)
                    if sub_on_fail == "skip":
                        logger.warning(f"Parallel sub-step skipped: {result.get('error', '')}")
                    else:
                        errors.append(result.get("error", "unknown error"))

        if errors:
            return {"success": False, "error": f"Parallel failures: {'; '.join(errors)}"}
        return {"success": True}

    def _step_condition(step: dict, tablet: str, depth: int) -> dict:
        check = step.get("if", {})
        then_steps = step.get("then", [])
        else_steps = step.get("else", [])

        check_result = _execute_step(check, tablet, depth)

        branch = then_steps if check_result["success"] else else_steps
        for sub_step in branch:
            result = _execute_step(sub_step, tablet, depth)
            if not result["success"]:
                return result
        return {"success": True}

    # -------------------------------------------------------------------------
    # MACRO API ENDPOINTS
    # -------------------------------------------------------------------------

    @app.route("/api/macros")
    def api_macros():
        """Return macro definitions and button layout, optionally filtered by page."""
        page = request.args.get("page", "")
        result = {
            "macros": {k: {"label": v.get("label", k), "icon": v.get("icon", ""),
                           "description": v.get("description", ""),
                           "confirm": v.get("confirm", ""),
                           "steps": len(v.get("steps", []))}
                       for k, v in macro_defs.items()},
        }
        if page:
            result["buttons"] = button_defs.get(page, [])
        else:
            result["buttons"] = button_defs
        return jsonify(result), 200

    @app.route("/api/macros/switches")
    def api_macros_switches():
        """Return all switch entity_ids used by a page's macros (recursive)."""
        page = request.args.get("page", "")
        if not page:
            return jsonify({"error": "page parameter required"}), 400

        sections = button_defs.get(page, [])
        if not sections:
            return jsonify({"switches": []}), 200

        # Collect all macro keys referenced by this page's buttons
        macro_keys = set()
        for section in sections:
            all_items = list(section.get("items", []))
            for tab in section.get("tabs", []):
                all_items.extend(tab.get("items", []))
            for item in all_items:
                action = item.get("action", {})
                if action.get("type") == "macro" and action.get("macro"):
                    macro_keys.add(action["macro"])
                toggle = item.get("toggle")
                if toggle:
                    for branch in ("on", "off"):
                        ba = (toggle.get(branch) or {}).get("action", {})
                        if ba.get("type") == "macro" and ba.get("macro"):
                            macro_keys.add(ba["macro"])

        # Recursively walk macro steps to find all switch.* entity_ids
        switch_ids = set()
        visited = set()

        def _walk_macro(key, depth=0):
            if depth > 5 or key in visited:
                return
            visited.add(key)
            macro = macro_defs.get(key)
            if not macro:
                return
            for step in macro.get("steps", []):
                stype = step.get("type", "")
                if stype == "ha_service":
                    eid = (step.get("data") or {}).get("entity_id", "")
                    if eid.startswith("switch."):
                        switch_ids.add(eid)
                elif stype == "ha_check":
                    eid = step.get("entity", "")
                    if eid.startswith("switch."):
                        switch_ids.add(eid)
                elif stype == "macro":
                    child = step.get("macro", "")
                    if child:
                        _walk_macro(child, depth + 1)
                elif stype == "condition":
                    for branch_key in ("then", "else"):
                        for sub in step.get(branch_key, []):
                            if sub.get("type") == "ha_service":
                                eid = (sub.get("data") or {}).get("entity_id", "")
                                if eid.startswith("switch."):
                                    switch_ids.add(eid)

        for mk in macro_keys:
            _walk_macro(mk)

        # Also collect switch entities from toggle state bindings on buttons
        for section in sections:
            for item in section.get("items", []):
                toggle = item.get("toggle")
                if toggle:
                    tst = toggle.get("state", {})
                    if tst.get("source") == "ha":
                        eid = tst.get("entity", "")
                        if eid.startswith("switch."):
                            switch_ids.add(eid)

        # Filter out TODO placeholders
        switch_ids = {s for s in switch_ids if "TODO" not in s.upper()}

        return jsonify({"switches": sorted(switch_ids)}), 200

    @app.route("/api/macro/execute", methods=["POST"])
    def api_macro_execute():
        """Execute a macro by key, optionally skipping selected steps."""
        data = request.get_json(silent=True) or {}
        macro_key = data.get("macro", "")
        skip_steps = set(data.get("skip_steps", []))
        tablet = _tablet_id()

        if not macro_key or macro_key not in macro_defs:
            return jsonify({"success": False, "error": f"Unknown macro: {macro_key}"}), 404

        logger.info(f"[{tablet}] Macro execute: {macro_key}"
                     + (f" (skipping {len(skip_steps)} steps)" if skip_steps else ""))

        result = _execute_macro(macro_key, tablet, skip_steps=skip_steps)

        status_code = 200 if result.get("success") else 500
        return jsonify(result), status_code

    @app.route("/api/macro/expand/<macro_key>")
    def api_macro_expand(macro_key: str):
        """Return the full step tree for a macro, recursively resolving nested macros."""
        if macro_key not in macro_defs:
            return jsonify({"error": f"Unknown macro: {macro_key}"}), 404

        def _expand(key: str, depth: int = 0) -> dict:
            if depth > 5:
                return {"macro": key, "label": key, "steps": [], "error": "Max depth exceeded"}
            macro = macro_defs.get(key, {})
            label = macro.get("label", key)
            steps = macro.get("steps", [])
            expanded = []
            for i, step in enumerate(steps):
                step_type = step.get("type", "")
                step_label = step.get("message", "") or _step_summary(step)
                entry = {
                    "index": i,
                    "type": step_type,
                    "label": step_label,
                }
                if step_type == "macro":
                    child_key = step.get("macro", "")
                    child = _expand(child_key, depth + 1)
                    entry["children"] = child.get("steps", [])
                    entry["child_macro"] = child_key
                    entry["child_label"] = child.get("label", child_key)
                expanded.append(entry)
            return {"macro": key, "label": label, "steps": expanded}

        def _step_summary(step: dict) -> str:
            """Generate a human-readable summary for a step."""
            t = step.get("type", "")
            if t == "ha_check":
                return f"Check {step.get('entity', '')} == {step.get('expect', '')}"
            elif t == "ha_service":
                return f"HA {step.get('domain', '')}.{step.get('service', '')} ({step.get('data', {}).get('entity_id', '')})"
            elif t == "door_timed_unlock":
                return f"Unlock {step.get('entity', '')} for {step.get('minutes', 60)} min"
            elif t == "moip_switch":
                return f"Switch TX {step.get('tx', '')} → RX {step.get('rx', '')}"
            elif t == "moip_ir":
                return f"IR {step.get('code', '')} → RX {step.get('receiver', '')}"
            elif t == "epson_power":
                return f"Projector {step.get('projector', '')} {step.get('state', '')}"
            elif t == "epson_all":
                return f"All projectors {step.get('state', '')}"
            elif t == "x32_scene":
                return f"X32 scene {step.get('scene', '')}"
            elif t == "x32_mute":
                return f"X32 mute ch{step.get('channel', '')} {step.get('state', '')}"
            elif t == "x32_aux_mute":
                return f"X32 aux{step.get('channel', '')} mute {step.get('state', '')}"
            elif t == "obs_emit":
                return f"OBS {step.get('request_type', '')}"
            elif t == "ptz_preset":
                return f"PTZ {step.get('camera', '')} preset {step.get('preset', '')}"
            elif t == "delay":
                return f"Wait {step.get('seconds', 0)}s"
            elif t == "notify":
                return f"Notify: {step.get('message', '')}"
            elif t == "condition":
                return f"Condition: check {step.get('check', {}).get('entity', '')}"
            return f"{t}"

        return jsonify(_expand(macro_key)), 200

    @app.route("/api/macro/state")
    def api_macro_state():
        """Return current HA entity states for all button state bindings."""
        ha_states = state_cache.get("ha") or {}
        # Also include other subsystem states
        return jsonify({
            "ha": ha_states,
            "obs": state_cache.get("obs"),
            "x32": state_cache.get("x32"),
            "projectors": state_cache.get("projectors"),
            "moip": state_cache.get("moip"),
            "camlytics": state_cache.get("camlytics"),
        }), 200

    # -------------------------------------------------------------------------
    # CAMLYTICS API ENDPOINTS
    # -------------------------------------------------------------------------

    @app.route("/api/camlytics/state")
    def api_camlytics_state():
        """Return current Camlytics counts and buffer values."""
        return jsonify(state_cache.get("camlytics") or {}), 200

    @app.route("/api/camlytics/buffer", methods=["POST"])
    def api_camlytics_buffer():
        """Update a Camlytics buffer value. Body: {"type": "communion"|"occupancy"|"enter", "value": 5}"""
        data = request.get_json(silent=True) or {}
        buf_type = data.get("type", "")
        buf_value = data.get("value")
        if buf_type not in ("communion", "occupancy", "enter") or buf_value is None:
            return jsonify({"error": "type and value required"}), 400
        try:
            buf_value = float(buf_value)
        except (ValueError, TypeError):
            return jsonify({"error": "value must be a number"}), 400
        with camlytics_lock:
            camlytics_buffers[buf_type] = buf_value
        tablet = _tablet_id()
        logger.info(f"[{tablet}] Camlytics buffer update: {buf_type} = {buf_value}%")
        return jsonify({"success": True, "buffer": buf_type, "value": buf_value}), 200

    # -------------------------------------------------------------------------
    # SCHEDULE API ENDPOINTS
    # -------------------------------------------------------------------------

    @app.route("/api/schedules")
    def api_schedules():
        return jsonify(db.get_schedules()), 200

    @app.route("/api/schedule", methods=["POST"])
    def api_schedule_create():
        data = request.get_json(silent=True) or {}
        name = data.get("name", "")
        macro_key = data.get("macro", "")
        days = data.get("days", "0,1,2,3,4,5,6")
        time_of_day = data.get("time", "08:00")

        if not name or not macro_key:
            return jsonify({"error": "name and macro are required"}), 400
        if macro_key not in macro_defs:
            return jsonify({"error": f"Unknown macro: {macro_key}"}), 404

        sched_id = db.create_schedule(name, macro_key, days, time_of_day)
        logger.info(f"Schedule created: {name} -> {macro_key} at {time_of_day} days={days}")
        return jsonify({"id": sched_id, "success": True}), 201

    @app.route("/api/schedule/<int:sched_id>", methods=["PUT"])
    def api_schedule_update(sched_id: int):
        data = request.get_json(silent=True) or {}
        update = {}
        if "name" in data:
            update["name"] = data["name"]
        if "macro" in data:
            if data["macro"] not in macro_defs:
                return jsonify({"error": f"Unknown macro: {data['macro']}"}), 404
            update["macro_key"] = data["macro"]
        if "days" in data:
            update["days"] = data["days"]
        if "time" in data:
            update["time_of_day"] = data["time"]
        if "enabled" in data:
            update["enabled"] = 1 if data["enabled"] else 0

        db.update_schedule(sched_id, **update)
        return jsonify({"success": True}), 200

    @app.route("/api/schedule/<int:sched_id>", methods=["DELETE"])
    def api_schedule_delete(sched_id: int):
        db.delete_schedule(sched_id)
        return jsonify({"success": True}), 200

    # -------------------------------------------------------------------------
    # CHATBOT API (Claude-powered volunteer help)
    # -------------------------------------------------------------------------

    def _build_chat_system_prompt() -> str:
        """Assemble the chatbot system prompt from macros, devices, and static knowledge."""
        parts = []
        parts.append(
            "You are the AV Help Assistant for St. Paul Coptic Orthodox Church. "
            "Volunteers use tablet-based controls to manage audio, video, streaming, "
            "projectors, cameras, and climate across several rooms. Answer questions "
            "clearly and concisely. Use simple, non-technical language. "
            "If you don't know the answer, say so and suggest asking the AV team lead."
        )

        # Page descriptions
        parts.append("\n## Pages\n"
            "- HOME: Dashboard with quick-access buttons for each room.\n"
            "- MAIN (Main Church): Video on/off (projectors + motorized screens + TVs), "
            "Audio on/off (X32 mixer + amplifiers), A/C thermostat, video source routing "
            "(podium laptops, announcements PC, Apple TV, Google Streamer, live stream), "
            "people counting (occupancy + communion). 'All Systems On' turns everything on. "
            "'All Systems Off' turns everything off.\n"
            "- CHAPEL: TVs on/off, Audio on/off, A/C thermostat, video source routing "
            "(podium laptop, Apple TV, Google Streamer). 'All Systems On' / 'All Systems Off'.\n"
            "- SOCIAL (Social Hall): Similar to Chapel — TVs, audio, A/C, source routing. "
            "'All Systems On' / 'All Systems Off'.\n"
            "- GYM: TV on/off, video source routing.\n"
            "- CONF RM (Conference Room): TV, video source routing.\n"
            "- STREAM (Live Stream): OBS scene switching (camera views), start/stop recording "
            "and streaming, PTZ camera presets and joystick control.\n"
            "- SOURCE: Advanced video matrix routing (MoIP), audio routing, and Alexa announcements.\n"
            "- SECURITY: Camera feeds, door lock/unlock controls.\n"
            "- SETTINGS: Power switches (SmartThings, WattBox), audio mixer (X32 scenes, "
            "channel mutes/faders), thermostats, TV controls, scheduled automations, "
            "audit logs, admin functions."
        )

        # Macros summary (labels + descriptions)
        macro_lines = []
        for key, m in macro_defs.items():
            label = m.get("label", key)
            desc = m.get("description", "")
            if desc:
                macro_lines.append(f"- {label}: {desc}")
        if macro_lines:
            parts.append("\n## Available Macros (buttons volunteers can press)\n"
                         + "\n".join(macro_lines[:80]))

        # Device summary
        moip = devices_data.get("moip", {})
        tx_list = moip.get("transmitters", [])
        rx_list = moip.get("receivers", [])
        if tx_list:
            tx_names = [d.get("name", f"TX{d.get('id','')}") for d in tx_list[:20]
                        if isinstance(d, dict)]
            parts.append(f"\n## Video Sources (Transmitters)\n{', '.join(tx_names)}")
        if rx_list:
            rx_names = [d.get("name", f"RX{d.get('id','')}") for d in rx_list[:25]
                        if isinstance(d, dict)]
            parts.append(f"\n## Displays (Receivers)\n{', '.join(rx_names)}")

        # Troubleshooting guide
        parts.append(
            "\n## Troubleshooting\n"
            "- **Projector not turning on**: Try the Video On button again. Check that "
            "the projector power outlet is on (Settings > Power > WattBox). Allow 60 seconds "
            "for warm-up.\n"
            "- **No audio / no sound**: Check that Audio is turned on. Go to Settings > Audio "
            "and check that the correct mixer scene is loaded and channels are not muted.\n"
            "- **Video not showing on screen**: Ensure the TV/projector is on, then check the "
            "video source buttons — the active source is highlighted in orange. Try re-selecting "
            "the source.\n"
            "- **Live stream offline**: Go to the STREAM page and check if OBS shows 'Connected'. "
            "If not, the streaming PC may need to be restarted.\n"
            "- **Thermostat not responding**: The HVAC system may take a few minutes to respond. "
            "Check Settings > Thermostats for the current status.\n"
            "- **Door won't unlock**: Ensure you are on the SECURITY page. Tap the door, "
            "then select a lock rule and duration.\n"
            "- **Button not working / stuck**: Try refreshing the app (Settings > Admin > Reload App). "
            "If still broken, check the health badges in the top status bar for offline services.\n"
            "- **Tablet screen is dark**: Tap the screen to wake it. The screensaver activates "
            "after a period of inactivity."
        )

        return "\n".join(parts)

    _chat_system_prompt = _build_chat_system_prompt()

    @app.route("/api/chat", methods=["POST"])
    def api_chat():
        data = request.get_json(silent=True) or {}
        message = data.get("message", "").strip()
        page = data.get("page", "")
        history = data.get("history", [])

        if not message:
            return jsonify({"error": "message required"}), 400

        api_key = cfg.get("anthropic", {}).get("api_key", "")
        if not api_key:
            return jsonify({"error": "Chatbot not configured. Ask an admin to add the API key."}), 503

        # Build conversation messages (keep last 10 exchanges)
        messages = []
        for h in history[-10:]:
            role = h.get("role", "")
            content = h.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})
        messages.append({"role": "user", "content": message})

        # Add page context
        page_context = f"\nThe volunteer is currently on the '{page}' page." if page else ""

        tablet = _tablet_id()
        start = time.time()
        try:
            resp = http_requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": cfg.get("anthropic", {}).get("model", "claude-haiku-4-5-20251001"),
                    "max_tokens": cfg.get("anthropic", {}).get("max_tokens", 1024),
                    "system": _chat_system_prompt + page_context,
                    "messages": messages,
                },
                timeout=30,
            )
            latency = (time.time() - start) * 1000
            result = resp.json()

            if resp.status_code >= 400:
                error_msg = result.get("error", {}).get("message", "API error")
                logger.warning(f"Chat API error: {resp.status_code} {error_msg}")
                db.log_action(tablet, "chat:message", page, message[:200],
                              f"FAILED: {error_msg}", latency)
                return jsonify({"error": "Chat service error. Please try again."}), 502

            reply = result.get("content", [{}])[0].get("text",
                    "Sorry, I couldn't generate a response.")
            db.log_action(tablet, "chat:message", page, message[:200], "OK", latency)
            return jsonify({"response": reply}), 200

        except http_requests.Timeout:
            logger.warning("Chat API timeout")
            db.log_action(tablet, "chat:message", page, message[:200], "TIMEOUT", 30000)
            return jsonify({"error": "Chat service timed out. Please try again."}), 504
        except Exception as e:
            logger.warning(f"Chat API error: {e}")
            db.log_action(tablet, "chat:message", page, message[:200], f"ERROR: {e}", 0)
            return jsonify({"error": "Chat service unavailable. Please try again."}), 503

    # -------------------------------------------------------------------------
    # SOCKET.IO EVENTS
    # -------------------------------------------------------------------------

    _sid_to_tablet: dict = {}   # sid → tablet name for disconnect logging

    _sid_connect_time: dict = {}  # sid → connect timestamp for uptime tracking

    @socketio.on("connect")
    def on_connect():
        import time as _time
        tablet = request.args.get("tablet", "Unknown")
        _sid_to_tablet[request.sid] = tablet
        _sid_connect_time[request.sid] = _time.time()
        logger.info(f"SocketIO connect: tablet={tablet} sid={request.sid}")
        db.upsert_session(tablet, socket_id=request.sid)

    @socketio.on("disconnect")
    def on_disconnect():
        import time as _time
        tablet = _sid_to_tablet.pop(request.sid, "Unknown")
        connected_at = _sid_connect_time.pop(request.sid, None)
        uptime = f"{_time.time() - connected_at:.1f}s" if connected_at else "?"
        logger.info(f"SocketIO disconnect: tablet={tablet} sid={request.sid} uptime={uptime}")

    @socketio.on("diag")
    def on_diag(data):
        """Receive diagnostic info from client (e.g., previous disconnect reason)."""
        tablet = _sid_to_tablet.get(request.sid, "Unknown")
        prev = data.get("prev_disconnect", "?")
        logger.info(f"SocketIO diag: tablet={tablet} sid={request.sid} prev_disconnect={prev}")

    @socketio.on("join")
    def on_join(data):
        room = data.get("room", "")
        if room in ("moip", "x32", "obs", "projectors", "ha", "macros", "camlytics", "health"):
            join_room(room)
            logger.debug(f"sid={request.sid} joined room={room}")
            # Push cached state immediately so reconnecting tablets
            # don't wait for the next state change to get data
            cached = state_cache.get(room)
            if cached is not None:
                emit(f"state:{room}", cached)

    @socketio.on("leave")
    def on_leave(data):
        room = data.get("room", "")
        leave_room(room)

    @socketio.on("heartbeat")
    def on_heartbeat(data):
        tablet = data.get("tablet", "Unknown")
        display_name = data.get("displayName", "")
        role = data.get("role", "")
        db.upsert_session(
            tablet,
            display_name=display_name,
            socket_id=request.sid,
            current_page=data.get("currentPage", ""),
        )
        emit("heartbeat_ack", {"ok": True})

        # Forward heartbeat to Health Module (in-process, no HTTP)
        _forward_heartbeat_to_health(tablet)

    def _forward_heartbeat_to_health(tablet_key: str):
        """Record a tablet heartbeat in the health module."""
        if health is None:
            return
        hd_cfg = cfg.get("healthdash", {})
        name_map = hd_cfg.get("tablet_names", {})
        friendly = name_map.get(tablet_key, tablet_key)
        health.record_heartbeat(friendly)

    # -------------------------------------------------------------------------
    # BACKGROUND STATE POLLERS
    # -------------------------------------------------------------------------

    watchdog = PollerWatchdog()

    def _start_pollers():
        # Start the X32 module's internal poller (owns mixer connection)
        if x32 is not None:
            x32.start()

        # Start the MoIP module's keepalive thread (owns Telnet connection)
        if moip is not None:
            moip.start()

        # Start the OBS module's WebSocket poller (owns OBS connection)
        if obs is not None:
            obs.start()

        # Start the Health module's checker loop (Phase 4 consolidation)
        if health is not None:
            health.start()

        # Start the Occupancy module's scheduler (Phase 6 consolidation)
        if occupancy is not None:
            occupancy.start()

        poll_cfg = cfg.get("polling", {})

        def poll_loop(name, interval, poll_fn):
            logger.info(f"Poller started: {name} (every {interval}s)")
            watchdog.register(name, interval)
            while True:
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

        def _poll_headers(service: str) -> dict:
            """Build headers for background poll requests (API key + gateway ID)."""
            h = {"X-Tablet-ID": "Gateway"}
            key = mw_cfg.get(service, {}).get("api_key", "")
            if key:
                h["X-API-Key"] = key
            return h

        def poll_x32():
            if mock_mode:
                return MockBackend.X32_STATUS
            try:
                status = x32.get_status()
                # Strip age_seconds — it changes every poll even when mixer
                # state hasn't, which defeats StateCache change detection and
                # causes ~10 KB broadcasts to every tablet every 5 s.
                if status:
                    status.pop("age_seconds", None)
                return status
            except Exception:
                return None

        def poll_moip():
            if mock_mode:
                return MockBackend.MOIP_RECEIVERS
            try:
                result, status = moip.get_receivers()
                return result if status < 400 else None
            except Exception:
                return None

        def poll_obs():
            if mock_mode:
                return {"streaming": True, "recording": False, "current_scene": "MainChurch_Altar"}
            try:
                return obs.get_snapshot()
            except Exception:
                return None

        def poll_projectors():
            projectors = cfg.get("projectors", {})
            if mock_mode:
                return {k: {"name": v.get("name", k), "power": "on"} for k, v in projectors.items()}
            statuses = {}
            for key, proj in projectors.items():
                try:
                    resp = http_requests.get(
                        f"http://{proj['ip']}/api/v01/contentmgr/remote/power/",
                        timeout=3,
                    )
                    statuses[key] = {"name": proj.get("name", key), "power": "on", "reachable": True}
                except Exception:
                    statuses[key] = {"name": proj.get("name", key), "power": "unknown", "reachable": False}
            return statuses

        def poll_ha_states():
            """Poll HA entity states for button state bindings (per-entity)."""
            if not ha_state_entities:
                return None
            ha_cfg = cfg.get("home_assistant", {})
            if mock_mode:
                return {e: {"state": "on", "attributes": {}} for e in ha_state_entities}
            states = {}
            for entity_id in ha_state_entities:
                try:
                    resp = http_requests.get(
                        f"{ha_cfg['url']}/api/states/{entity_id}",
                        headers={"Authorization": f"Bearer {ha_cfg['token']}"},
                        timeout=5,
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        states[entity_id] = {
                            "state": data.get("state", "unknown"),
                            "attributes": data.get("attributes", {}),
                        }
                    else:
                        states[entity_id] = {"state": "unavailable", "attributes": {}}
                except Exception:
                    states[entity_id] = {"state": "unavailable", "attributes": {}}
            return states

        def _get_camlytics_raw(url):
            """Fetch a raw counter value from a Camlytics cloud report URL.

            Handles three response formats:
            1. report.data.counter (simple counter)
            2. report.data.series[0].data (chart data — find peak in window)
            3. report.counter (fallback)
            """
            if not url:
                return 0
            try:
                resp = http_requests.get(url, timeout=2)
                body = resp.json()
                report = body.get("report", {}) if isinstance(body, dict) else {}
                data = report.get("data", {}) if isinstance(report, dict) else {}

                # Format 1: simple counter
                if isinstance(data, dict) and data.get("counter") is not None:
                    return int(data["counter"]) or 0

                # Format 2: chart series data — find peak within window
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

                # Format 3: fallback counter at report level
                if report.get("counter") is not None:
                    return int(report["counter"]) or 0
            except Exception:
                pass
            return 0

        def poll_camlytics():
            """Poll Camlytics cloud APIs for people counts, apply buffers."""
            if mock_mode:
                return {
                    "communion_raw": 0, "communion_adjusted": 0, "communion_buffer": -5,
                    "occupancy_raw": 0, "occupancy_adjusted": 0, "occupancy_live": 0, "occupancy_buffer": 20,
                    "enter_raw": 0, "enter_adjusted": 0, "enter_buffer": 0,
                }

            with camlytics_lock:
                buffers = dict(camlytics_buffers)

            # Communion
            comm_raw = _get_camlytics_raw(cam_cfg.get("communion_url", ""))
            comm_mult = 1 + (buffers["communion"] / 100)
            comm_adj = max(0, round(comm_raw * comm_mult))

            # Occupancy: take max of peak and live for the "high water mark"
            peak_val = _get_camlytics_raw(cam_cfg.get("occupancy_url_peak", ""))
            live_val = _get_camlytics_raw(cam_cfg.get("occupancy_url_live", ""))
            occ_raw = max(peak_val, live_val)
            occ_mult = 1 + (buffers["occupancy"] / 100)
            occ_adj = max(0, round(occ_raw * occ_mult))
            occ_live_adj = max(0, round(live_val * occ_mult))

            # Building entry
            enter_raw = _get_camlytics_raw(cam_cfg.get("enter_url", ""))
            enter_mult = 1 + (buffers["enter"] / 100)
            enter_adj = max(0, round(enter_raw * enter_mult))

            return {
                "communion_raw": comm_raw,
                "communion_adjusted": comm_adj,
                "communion_buffer": buffers["communion"],
                "occupancy_raw": occ_raw,
                "occupancy_adjusted": occ_adj,
                "occupancy_live": occ_live_adj,
                "occupancy_buffer": buffers["occupancy"],
                "enter_raw": enter_raw,
                "enter_adjusted": enter_adj,
                "enter_buffer": buffers["enter"],
            }

        pollers = [
            ("x32", poll_cfg.get("x32", 5), poll_x32),
            ("moip", poll_cfg.get("moip", 10), poll_moip),
            ("obs", poll_cfg.get("obs", 3), poll_obs),
            ("projectors", poll_cfg.get("projectors", 30), poll_projectors),
        ]

        if ha_state_entities:
            pollers.append(("ha", poll_cfg.get("ha", 15), poll_ha_states))

        # Camlytics poller (only if at least one URL is configured)
        if cam_cfg.get("communion_url") or cam_cfg.get("occupancy_url_peak") or cam_cfg.get("occupancy_url_live"):
            cam_interval = cam_cfg.get("poll_interval", 5)
            pollers.append(("camlytics", cam_interval, poll_camlytics))

        # HA device cache refresh (cameras + locks list, every 5 min)
        def _ha_cache_loop():
            logger.info("HA device cache: initial load...")
            _build_ha_device_cache()
            while True:
                time.sleep(300)
                _build_ha_device_cache()

        ha_cache_thread = threading.Thread(target=_ha_cache_loop, daemon=True)
        ha_cache_thread.start()

        for name, interval, fn in pollers:
            t = threading.Thread(target=poll_loop, args=(name, interval, fn), daemon=True)
            t.start()

        # --- Schedule runner ---
        _last_cleanup_date = ""

        def schedule_loop():
            nonlocal _last_cleanup_date
            logger.info("Schedule runner started (checks every 30s)")
            while True:
                try:
                    now = datetime.now()
                    current_day = str(now.weekday())  # 0=Mon, 6=Sun
                    current_hm = now.strftime("%H:%M")

                    # Daily audit log cleanup (run once at 03:00)
                    today_str = now.strftime("%Y-%m-%d")
                    if current_hm == "03:00" and _last_cleanup_date != today_str:
                        _last_cleanup_date = today_str
                        db.cleanup_old_logs(30)
                        logger.info("Audit log cleanup complete (>30 days deleted)")

                    for sched in db.get_schedules():
                        if not sched.get("enabled"):
                            continue
                        days = str(sched.get("days", ""))
                        sched_time = sched.get("time_of_day", "")
                        if current_day not in days.split(","):
                            continue
                        if current_hm != sched_time:
                            continue
                        # Check if already run this minute
                        last_run = sched.get("last_run", "")
                        run_key = now.strftime("%Y-%m-%d %H:%M")
                        if last_run == run_key:
                            continue

                        macro_key = sched.get("macro_key", "")
                        sched_name = sched.get("name", "")
                        logger.info(f"Schedule firing: {sched_name} -> {macro_key}")
                        db.update_schedule(sched["id"], last_run=run_key)
                        db.log_action(f"Schedule:{sched_name}", "schedule:fire", macro_key,
                                      json.dumps({"schedule_id": sched["id"], "name": sched_name,
                                                  "time": sched_time, "day": current_day}),
                                      "triggered", 0)

                        # Run macro in a separate thread to not block scheduler
                        threading.Thread(
                            target=_execute_macro,
                            args=(macro_key, f"Schedule:{sched_name}", 0),
                            daemon=True,
                        ).start()

                except Exception as e:
                    logger.warning(f"Schedule runner error: {e}")

                time.sleep(30)

        sched_thread = threading.Thread(target=schedule_loop, daemon=True)
        sched_thread.start()

    # Store references for use in main
    app._start_pollers = _start_pollers
    app._db = db
    app._state_cache = state_cache
    app._watchdog = watchdog

    return app, socketio


# =============================================================================
# MAIN
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="STP Gateway")
    parser.add_argument("--config", default="config.yaml", help="Path to config file")
    parser.add_argument("--mock", action="store_true", help="Run in mock mode (no real devices)")
    parser.add_argument("--host", help="Override host")
    parser.add_argument("--port", type=int, help="Override port")
    args = parser.parse_args()

    cfg = load_config(args.config)
    logger = setup_logging(cfg)

    gateway_cfg = cfg.get("gateway", {})
    host = args.host or gateway_cfg.get("host", "0.0.0.0")
    port = args.port or gateway_cfg.get("port", 8080)

    app, socketio = create_app(cfg, mock_mode=args.mock, config_path=args.config)

    logger.info("=" * 60)
    logger.info("STP Gateway starting")
    logger.info(f"  Host: {host}:{port}")
    logger.info(f"  Mock mode: {args.mock}")
    logger.info(f"  Config: {args.config}")
    logger.info(f"  Static dir: {cfg.get('gateway', {}).get('static_dir', 'N/A')}")
    x32_cfg = cfg.get("x32", {})
    moip_cfg = cfg.get("moip", {})
    obs_cfg = cfg.get("obs") or {}
    logger.info(f"  OBS (direct): {obs_cfg.get('ws_url', 'N/A')}")
    logger.info(f"  MoIP (direct): {moip_cfg.get('host_internal', 'N/A')}:{moip_cfg.get('port_internal', 23)}")
    logger.info(f"  X32 (direct): {x32_cfg.get('mixer_type', 'X32')} @ {x32_cfg.get('mixer_ip', 'N/A')}")
    logger.info(f"  PTZ cameras: {len(cfg.get('ptz_cameras', {}))}")
    logger.info(f"  Projectors: {len(cfg.get('projectors', {}))}")
    logger.info(f"  Health services: {len(cfg.get('healthdash', {}).get('services', []))}")

    # Count macros loaded
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(args.config)), "macros.yaml")) as f:
            _mc = yaml.safe_load(f) or {}
        macro_count = len(_mc.get("macros", {}))
        button_pages = len(_mc.get("buttons", {}))
    except Exception:
        macro_count = 0
        button_pages = 0
    logger.info(f"  Macros: {macro_count} defined, {button_pages} pages with buttons")
    # Log actual Engine.IO ping settings so we can verify they took effect
    eio = socketio.server.eio
    logger.info(f"  SocketIO: ping_interval={eio.ping_interval}s, ping_timeout={eio.ping_timeout}s")
    logger.info("=" * 60)

    # Start background pollers
    app._start_pollers()

    # Run with eventlet (supports WebSocket)
    socketio.run(app, host=host, port=port, debug=gateway_cfg.get("debug", False))


if __name__ == "__main__":
    main()
