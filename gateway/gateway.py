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
import copy
import json
import logging
import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests as http_requests
import yaml
from flask import Flask, Response, jsonify, redirect, request, send_file, send_from_directory, session, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room

# =============================================================================
# CONFIG
# =============================================================================

def load_config(path: str = "config.yaml") -> dict:
    with open(path, "r") as f:
        return yaml.safe_load(f)


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
        conn = self._get_conn()
        conn.execute(
            "INSERT INTO audit_log (tablet_id, action, target, request_data, result, latency_ms) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (tablet_id, action, target, request_data, result, latency_ms),
        )
        conn.commit()

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

def create_app(cfg: dict, mock_mode: bool = False) -> tuple:
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

    socketio = SocketIO(app, async_mode="eventlet", cors_allowed_origins="*")

    logger = setup_logging(cfg)
    db = Database(cfg.get("database", {}).get("path", "stp_gateway.db"))
    state_cache = StateCache()

    mw_cfg = cfg.get("middleware", {})
    allowed_ips = sec_cfg.get("allowed_ips", ["127.0.0.1"])
    settings_pin = sec_cfg.get("settings_pin", "1234")
    remote_auth = sec_cfg.get("remote_auth", {})

    # Load permissions from frontend config
    permissions_path = os.path.join(static_dir, "config", "permissions.json")
    try:
        with open(permissions_path) as f:
            permissions_data = json.load(f)
    except Exception:
        logger.warning(f"Could not load permissions from {permissions_path}, using defaults")
        permissions_data = {"locations": {}, "defaultLocation": "Tablet_Mainchurch"}

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

    def _ip_allowed(ip: str) -> bool:
        return any(ip.startswith(pfx) for pfx in allowed_ips)

    def _proxy_request(service: str, path: str, method: str = "GET",
                       json_data: dict = None, timeout: float = 5) -> tuple:
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

        tablet = _tablet_id()
        headers["X-Tablet-ID"] = tablet

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

            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          json.dumps(result)[:500], latency)

            return result, resp.status_code

        except http_requests.Timeout:
            return {"error": f"{service} timeout after {svc_timeout}s"}, 504
        except http_requests.ConnectionError:
            return {"error": f"{service} unreachable"}, 503
        except Exception as e:
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
        """Returns an error response tuple if permission denied, None if OK."""
        loc = permissions_data.get("locations", {}).get(tablet_id)
        if not loc:
            return None  # Unknown tablet = allow (fail open, same as current behavior)
        perms = loc.get("permissions", {})
        if perms.get(required_page) is False:
            return jsonify({"error": "Permission denied", "page": required_page}), 403
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
        full = os.path.join(static_dir, filepath)
        if os.path.isfile(full):
            return send_from_directory(static_dir, filepath)
        return jsonify({"error": "Not found"}), 404

    # -------------------------------------------------------------------------
    # HEALTH & CONFIG ENDPOINTS
    # -------------------------------------------------------------------------

    @app.route("/api/health")
    def api_health():
        return jsonify({
            "healthy": True,
            "service": "stp-gateway",
            "version": settings_data.get("app", {}).get("version", "1.0.0"),
            "mock_mode": mock_mode,
        }), 200

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
    # MOIP PROXY
    # -------------------------------------------------------------------------

    @app.route("/api/moip/receivers")
    def moip_receivers():
        if mock_mode:
            return jsonify(MockBackend.MOIP_RECEIVERS), 200
        result, status = _proxy_request("moip", "/receivers")
        return jsonify(result), status

    @app.route("/api/moip/switch", methods=["POST"])
    def moip_switch():
        perm_err = _check_permission(_tablet_id(), "source")
        if perm_err:
            return perm_err
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        result, status = _proxy_request("moip", "/switch", "POST", data)
        # Broadcast state change
        socketio.emit("state:moip", {"event": "switch", "data": data}, room="moip")
        return jsonify(result), status

    @app.route("/api/moip/ir", methods=["POST"])
    def moip_ir():
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        result, status = _proxy_request("moip", "/ir", "POST", data)
        return jsonify(result), status

    @app.route("/api/moip/scene", methods=["POST"])
    def moip_scene():
        perm_err = _check_permission(_tablet_id(), "source")
        if perm_err:
            return perm_err
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        result, status = _proxy_request("moip", "/scene", "POST", data)
        socketio.emit("state:moip", {"event": "scene", "data": data}, room="moip")
        return jsonify(result), status

    @app.route("/api/moip/osd", methods=["POST"])
    def moip_osd():
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        result, status = _proxy_request("moip", "/osd", "POST", data)
        return jsonify(result), status

    # -------------------------------------------------------------------------
    # X32 PROXY
    # -------------------------------------------------------------------------

    @app.route("/api/x32/status")
    def x32_status():
        if mock_mode:
            return jsonify(MockBackend.X32_STATUS), 200
        result, status = _proxy_request("x32", "/status")
        return jsonify(result), status

    @app.route("/api/x32/scene/<int:num>")
    def x32_scene(num: int):
        perm_err = _check_permission(_tablet_id(), "main")
        if perm_err:
            return perm_err
        if mock_mode:
            return jsonify({"success": True, "scene": num, "mock": True}), 200
        result, status = _proxy_request("x32", f"/scene{num}")
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
        result, status = _proxy_request("x32", f"/mute{ch}{state}")
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
        result, status = _proxy_request("x32", f"/aux{ch}_mute_{state}")
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
        result, status = _proxy_request("x32", f"/ch{ch}vol{direction}")
        socketio.emit("state:x32", {"event": "volume", "channel": ch, "direction": direction}, room="x32")
        return jsonify(result), status

    # -------------------------------------------------------------------------
    # OBS PROXY
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
        result, status = _proxy_request("obs", "/status")
        return jsonify(result), status

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
        result, status = _proxy_request("obs", f"/call/{request_type}", "POST", payload)
        return jsonify(result), status

    @app.route("/api/obs/emit/<request_type>", methods=["POST"])
    def obs_emit(request_type: str):
        perm_err = _check_permission(_tablet_id(), "stream")
        if perm_err:
            return perm_err
        payload = request.get_json(silent=True)
        if mock_mode:
            return jsonify({"result": True, "mock": True}), 200
        result, status = _proxy_request("obs", f"/emit/{request_type}", "POST", payload)
        socketio.emit("state:obs", {"event": request_type, "data": payload}, room="obs")
        return jsonify(result), status

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

        snapshot_path = cam.get("snapshot_path", "/cgi-bin/snapshot.cgi")
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

    @app.route("/api/ha/entities")
    def ha_entities():
        """Return all HA entities grouped by domain."""
        if mock_mode:
            return jsonify({"total": 0, "domains": {}, "mock": True}), 200

        domain_filter = request.args.get("domain", "").strip()
        search = request.args.get("q", "").strip().lower()

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

            domains[domain]["entities"].append({
                "entity_id": eid,
                "state": entity.get("state", "unknown"),
                "friendly_name": friendly,
                "device_class": attrs.get("device_class", ""),
                "attributes": attrs,
                "last_changed": entity.get("last_changed", ""),
            })
            domains[domain]["count"] += 1

        # Sort domains alphabetically, entities by entity_id within each domain
        sorted_domains = {}
        for d in sorted(domains.keys()):
            domains[d]["entities"].sort(key=lambda e: e["entity_id"])
            sorted_domains[d] = domains[d]

        total = sum(d["count"] for d in sorted_domains.values())
        return jsonify({"total": total, "domains": sorted_domains}), 200

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
        """Return all camera entities from HA with friendly names and state."""
        ha_cfg = cfg.get("home_assistant", {})
        if mock_mode:
            return jsonify({"cameras": []}), 200
        try:
            all_entities, err = _fetch_all_ha_entities()
            if err:
                return jsonify({"error": err}), 503
        except Exception as e:
            return jsonify({"error": str(e)}), 503

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
        return jsonify({"cameras": cameras}), 200

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
                error_msg = step_msg or result.get("error", f"Step {i+1} ({step_type}) failed")

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
            elif step_type == "obs_emit":
                return _step_obs_emit(step, tablet)
            elif step_type == "ptz_preset":
                return _step_ptz_preset(step, tablet)
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
            if ok:
                db.log_action(tablet, f"macro:ha:{domain}/{service}", "home_assistant",
                              json.dumps(data)[:500], f"status={resp.status_code}", 0)
            return {"success": ok, "error": "" if ok else f"HA service returned {resp.status_code}"}
        except Exception as e:
            return {"success": False, "error": f"HA service failed: {e}"}

    def _step_moip_switch(step: dict, tablet: str) -> dict:
        tx = str(step.get("tx", ""))
        rx = str(step.get("rx", ""))
        if mock_mode:
            return {"success": True}
        result, status = _proxy_request("moip", "/switch", "POST",
                                         {"transmitter": tx, "receiver": rx}, timeout=3)
        ok = status < 400
        if ok:
            socketio.emit("state:moip", {"event": "switch", "data": {"transmitter": tx, "receiver": rx}}, room="moip")
        return {"success": ok, "error": "" if ok else f"MoIP switch failed: status={status}"}

    def _step_moip_ir(step: dict, tablet: str) -> dict:
        rx = str(step.get("receiver", ""))
        code = step.get("code", "")
        if mock_mode:
            return {"success": True}
        result, status = _proxy_request("moip", "/ir", "POST",
                                         {"tx": "0", "rx": rx, "code": code}, timeout=3)
        return {"success": status < 400, "error": "" if status < 400 else f"IR failed: status={status}"}

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
            resp = http_requests.get(
                f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}", timeout=5)
            socketio.emit("state:projectors", {"event": "power", "projector": key, "state": state}, room="projectors")
            return {"success": resp.status_code == 200}
        except Exception as e:
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
        result, status = _proxy_request("x32", f"/scene{num}")
        if status < 400:
            socketio.emit("state:x32", {"event": "scene", "scene": num}, room="x32")
        return {"success": status < 400, "error": "" if status < 400 else f"X32 scene failed"}

    def _step_x32_mute(step: dict, tablet: str) -> dict:
        ch = step.get("channel", 1)
        state = step.get("state", "on")
        if mock_mode:
            return {"success": True}
        result, status = _proxy_request("x32", f"/mute{ch}{state}")
        if status < 400:
            socketio.emit("state:x32", {"event": "mute", "channel": ch, "state": state}, room="x32")
        return {"success": status < 400}

    def _step_obs_emit(step: dict, tablet: str) -> dict:
        action = step.get("action", "")
        payload = step.get("data")
        if mock_mode:
            return {"success": True}
        result, status = _proxy_request("obs", f"/emit/{action}", "POST", payload)
        if status < 400:
            socketio.emit("state:obs", {"event": action, "data": payload}, room="obs")
        return {"success": status < 400}

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
            resp = http_requests.get(
                f"http://{cam['ip']}/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&{preset}", timeout=3)
            return {"success": resp.status_code == 200}
        except Exception as e:
            return {"success": False, "error": str(e)}

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
        }), 200

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
    # SOCKET.IO EVENTS
    # -------------------------------------------------------------------------

    @socketio.on("connect")
    def on_connect():
        tablet = request.args.get("tablet", "Unknown")
        logger.info(f"SocketIO connect: tablet={tablet} sid={request.sid}")
        db.upsert_session(tablet, socket_id=request.sid)

    @socketio.on("disconnect")
    def on_disconnect():
        logger.info(f"SocketIO disconnect: sid={request.sid}")

    @socketio.on("join")
    def on_join(data):
        room = data.get("room", "")
        if room in ("moip", "x32", "obs", "projectors", "ha", "macros"):
            join_room(room)
            logger.debug(f"sid={request.sid} joined room={room}")

    @socketio.on("leave")
    def on_leave(data):
        room = data.get("room", "")
        leave_room(room)

    @socketio.on("heartbeat")
    def on_heartbeat(data):
        tablet = data.get("tablet", "Unknown")
        db.upsert_session(
            tablet,
            display_name=data.get("displayName", ""),
            socket_id=request.sid,
            current_page=data.get("currentPage", ""),
        )
        emit("heartbeat_ack", {"ok": True})

    # -------------------------------------------------------------------------
    # BACKGROUND STATE POLLERS
    # -------------------------------------------------------------------------

    def _start_pollers():
        poll_cfg = cfg.get("polling", {})

        def poll_loop(name, interval, poll_fn):
            logger.info(f"Poller started: {name} (every {interval}s)")
            while True:
                try:
                    data = poll_fn()
                    if data is not None and state_cache.set(name, data):
                        socketio.emit(f"state:{name}", data, room=name)
                except Exception as e:
                    logger.warning(f"Poller {name} error: {e}")
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
                resp = http_requests.get(
                    f"{mw_cfg['x32']['url']}/status",
                    headers=_poll_headers("x32"),
                    timeout=5,
                )
                return resp.json()
            except Exception:
                return None

        def poll_moip():
            if mock_mode:
                return MockBackend.MOIP_RECEIVERS
            try:
                resp = http_requests.get(
                    f"{mw_cfg['moip']['url']}/receivers",
                    headers=_poll_headers("moip"),
                    timeout=5,
                )
                return resp.json()
            except Exception:
                return None

        def poll_obs():
            if mock_mode:
                return {"streaming": True, "recording": False, "current_scene": "MainChurch_Altar"}
            try:
                resp = http_requests.get(
                    f"{mw_cfg['obs']['url']}/status",
                    headers=_poll_headers("obs"),
                    timeout=5,
                )
                return resp.json()
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

        pollers = [
            ("x32", poll_cfg.get("x32", 5), poll_x32),
            ("moip", poll_cfg.get("moip", 10), poll_moip),
            ("obs", poll_cfg.get("obs", 3), poll_obs),
            ("projectors", poll_cfg.get("projectors", 30), poll_projectors),
        ]

        if ha_state_entities:
            pollers.append(("ha", poll_cfg.get("ha", 15), poll_ha_states))

        for name, interval, fn in pollers:
            t = threading.Thread(target=poll_loop, args=(name, interval, fn), daemon=True)
            t.start()

        # --- Schedule runner ---
        def schedule_loop():
            logger.info("Schedule runner started (checks every 30s)")
            while True:
                try:
                    now = datetime.now()
                    current_day = str(now.weekday())  # 0=Mon, 6=Sun
                    current_hm = now.strftime("%H:%M")

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

    app, socketio = create_app(cfg, mock_mode=args.mock)

    logger.info("=" * 60)
    logger.info("STP Gateway starting")
    logger.info(f"  Host: {host}:{port}")
    logger.info(f"  Mock mode: {args.mock}")
    logger.info(f"  Config: {args.config}")
    logger.info(f"  Static dir: {cfg.get('gateway', {}).get('static_dir', 'N/A')}")
    logger.info(f"  Middleware: moip={cfg['middleware']['moip']['url']}, "
                f"x32={cfg['middleware']['x32']['url']}, "
                f"obs={cfg['middleware']['obs']['url']}")
    logger.info(f"  PTZ cameras: {len(cfg.get('ptz_cameras', {}))}")
    logger.info(f"  Projectors: {len(cfg.get('projectors', {}))}")

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
    logger.info("=" * 60)

    # Start background pollers
    app._start_pollers()

    # Run with eventlet (supports WebSocket)
    socketio.run(app, host=host, port=port, debug=gateway_cfg.get("debug", False))


if __name__ == "__main__":
    main()
