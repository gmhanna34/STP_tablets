#!/usr/bin/env python3
"""
STP Gateway — Unified backend for St. Paul Church AV Control Platform.

Proxies requests to existing middleware (moip-flask, x32-flask, obs-flask),
adds server-side PTZ camera and Epson projector control, Home Assistant proxy,
auth/permissions, audit logging, real-time state sync via Socket.IO,
macro execution engine, and scheduled automation.

Usage:
    python gateway_app.py                    # Normal mode (connects to real devices)
    python gateway_app.py --mock             # Mock mode (canned responses, no network)
    python gateway_app.py --config alt.yaml  # Custom config file
"""

from __future__ import annotations

import eventlet
eventlet.monkey_patch()

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from logging.handlers import RotatingFileHandler

import yaml
from dotenv import load_dotenv

load_dotenv()
from flask import Flask
from flask_socketio import SocketIO

# Local modules
from database import Database
from polling import StateCache, PollerWatchdog
from macro_engine import load_macros


# =============================================================================
# CONFIG
# =============================================================================

def load_config(path: str = "config.yaml") -> dict:
    with open(path, "r") as f:
        cfg = yaml.safe_load(f)
    _apply_env_overrides(cfg)
    return cfg


def _apply_env_overrides(cfg: dict):
    """Override config secrets from environment variables when set."""
    def _env(key: str, fallback: str = "") -> str:
        return os.environ.get(key) or fallback

    mw = cfg.setdefault("middleware", {})

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
    sec["secure_pin"] = _env("SECURE_PIN", sec.get("secure_pin", ""))
    ra = sec.setdefault("remote_auth", {})
    ra["username"] = _env("REMOTE_AUTH_USER", ra.get("username", ""))
    ra["password"] = _env("REMOTE_AUTH_PASS", ra.get("password", ""))

    fk = cfg.setdefault("fully_kiosk", {})
    fk["password"] = _env("FULLY_KIOSK_PASSWORD", fk.get("password", ""))

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
# GATEWAY CONTEXT (shared state for all modules)
# =============================================================================

class GatewayContext:
    """Central shared-state object passed to all gateway sub-modules."""

    def __init__(self):
        self.app = None
        self.socketio = None
        self.cfg = None
        self.logger = None
        self.db = None
        self.state_cache = None
        self.watchdog = None
        self.mock_mode = False
        self.config_path = ""

        # Module instances
        self.x32 = None
        self.moip = None
        self.obs = None
        self.health = None
        self.occupancy = None
        self.announcements = None

        # Security config
        self.allowed_ips = []
        self.trusted_proxy_prefixes = []
        self.settings_pin = ""
        self.secure_pin = ""
        self.remote_auth = {}
        self.session_timeout = 480

        # Frontend data
        self.permissions_data = {}
        self.devices_data = {}
        self.settings_data = {}
        self.static_dir = ""
        self.known_location_slugs = set()

        # Runtime verbose logging flag (threading.Event for thread-safe reads/writes)
        self.verbose_logging = threading.Event()

        # Camlytics runtime buffer state
        self.camlytics_buffers = {}
        self.camlytics_lock = threading.Lock()

        # HA device cache (cameras + locks)
        self.ha_device_cache = {"cameras": [], "locks": [], "ready": False}
        self.ha_cache_lock = threading.Lock()

        # SocketIO session tracking (thread-safe)
        self.sid_to_tablet = {}
        self.sid_connect_time = {}
        self.sid_lock = threading.Lock()

        # Macro engine
        self.macro_defs = {}
        self.button_defs = {}
        self.macros_cfg = {}
        self.ha_state_entities = set()


# =============================================================================
# GATEWAY APPLICATION
# =============================================================================

def create_app(cfg: dict, mock_mode: bool = False, config_path: str = "config.yaml") -> tuple:
    """Create and configure the Flask app + SocketIO instance."""

    gateway_cfg = cfg.get("gateway", {})
    _gateway_dir = os.path.dirname(os.path.abspath(__file__))
    static_dir = os.path.normpath(
        os.path.join(_gateway_dir, gateway_cfg.get("static_dir", "../frontend"))
    )
    sec_cfg = cfg.get("security", {})

    app = Flask(__name__, static_folder=None)
    app.config["SECRET_KEY"] = sec_cfg.get("secret_key", os.urandom(24).hex())
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = False          # gateway serves HTTP
    app.config["SESSION_REFRESH_EACH_REQUEST"] = True
    app.config["PERMANENT_SESSION_LIFETIME"] = int(
        sec_cfg.get("session_timeout_minutes", 480)
    ) * 60

    socketio = SocketIO(
        app,
        async_mode="eventlet",
        cors_allowed_origins="*",
        ping_timeout=60,
        ping_interval=15,
    )

    logger = setup_logging(cfg)

    # Engine.IO / Socket.IO logging — WARNING only
    import logging as _logging
    for _eio_name in ("engineio.server", "engineio.client", "socketio.server", "socketio.client"):
        _eio_lg = _logging.getLogger(_eio_name)
        _eio_lg.setLevel(_logging.WARNING)
        _eio_lg.propagate = False
        for h in logger.handlers:
            _eio_lg.addHandler(h)

    db = Database(cfg.get("database", {}).get("path", "stp_gateway.db"))
    state_cache = StateCache()
    watchdog = PollerWatchdog()

    # Initialize device modules
    from x32_module import X32Module
    x32 = None if mock_mode else X32Module(cfg.get("x32", {}), logger)

    from moip_module import MoIPModule
    moip = None if mock_mode else MoIPModule(
        cfg.get("moip", {}), logger, ha_cfg=cfg.get("home_assistant", {})
    )

    from obs_module import OBSModule
    obs = None if mock_mode else OBSModule(cfg.get("obs", {}), logger)

    from health_module import HealthModule
    health = None if mock_mode else HealthModule(cfg, logger)
    if health:
        def _broadcast_health(summary):
            state_cache.set("health", summary)
            socketio.emit("state:health", summary, room="health")
        health._on_summary_change = _broadcast_health

    from occupancy_module import OccupancyModule
    occupancy = None if mock_mode else OccupancyModule(cfg, logger, db=db)

    from announcement_module import AnnouncementModule
    announcements = AnnouncementModule(cfg, logger)

    # Build the shared context
    ctx = GatewayContext()
    ctx.app = app
    ctx.socketio = socketio
    ctx.cfg = cfg
    ctx.logger = logger
    ctx.db = db
    ctx.state_cache = state_cache
    ctx.watchdog = watchdog
    ctx.mock_mode = mock_mode
    ctx.config_path = config_path

    ctx.x32 = x32
    ctx.moip = moip
    ctx.obs = obs
    ctx.health = health
    ctx.occupancy = occupancy
    ctx.announcements = announcements
    announcements.ctx = ctx

    ctx.allowed_ips = sec_cfg.get("allowed_ips", ["127.0.0.1"])
    ctx.trusted_proxy_prefixes = sec_cfg.get("trusted_proxy_prefixes", [])
    ctx.settings_pin = sec_cfg.get("settings_pin", "1234")
    ctx.secure_pin = sec_cfg.get("secure_pin", "")
    ctx.remote_auth = sec_cfg.get("remote_auth", {})
    ctx.session_timeout = int(sec_cfg.get("session_timeout_minutes", 480))

    ctx.static_dir = static_dir

    # Load frontend config files
    permissions_path = os.path.join(static_dir, "config", "permissions.json")
    try:
        with open(permissions_path) as f:
            ctx.permissions_data = json.load(f)
    except Exception as e:
        logger.warning(f"Could not load permissions from {permissions_path}: {e}, using defaults")
        ctx.permissions_data = {"roles": {}, "locations": {}, "defaultRole": "full_access"}

    ctx.known_location_slugs = set((ctx.permissions_data.get("locations") or {}).keys())

    devices_path = os.path.join(static_dir, "config", "devices.json")
    try:
        logger.info(f"Loading devices from: {devices_path} (exists={os.path.isfile(devices_path)})")
        with open(devices_path) as f:
            ctx.devices_data = json.load(f)
        logger.info(f"Devices loaded OK: top-level keys={list(ctx.devices_data.keys())}, "
                     f"moip={'yes' if 'moip' in ctx.devices_data else 'NO'}")
    except Exception as e:
        logger.warning(f"Could not load devices from {devices_path}: {e}")
        ctx.devices_data = {}

    settings_path = os.path.join(static_dir, "config", "settings.json")
    try:
        with open(settings_path) as f:
            ctx.settings_data = json.load(f)
    except Exception as e:
        logger.warning(f"Could not load settings from {settings_path}: {e}")
        ctx.settings_data = {}

    # Camlytics runtime buffer state
    cam_cfg = cfg.get("camlytics", {})
    ctx.camlytics_buffers = {
        "communion": float(cam_cfg.get("communion_buffer_default", -5)),
        "occupancy": float(cam_cfg.get("occupancy_buffer_default", 20)),
        "enter": float(cam_cfg.get("enter_buffer_default", 0)),
    }

    # Load macros
    macros_cfg, macro_defs, button_defs, ha_state_entities = load_macros(cfg, logger)
    ctx.macros_cfg = macros_cfg
    ctx.macro_defs = macro_defs
    ctx.button_defs = button_defs
    ctx.ha_state_entities = ha_state_entities

    # Register all routes and handlers
    from auth import register_auth
    from api_routes import register_api_routes
    from socket_handlers import register_socket_handlers

    register_auth(ctx)
    register_api_routes(ctx)
    register_socket_handlers(ctx)

    # Store references for use in main and shutdown
    app._modules = {"x32": x32, "moip": moip, "obs": obs, "health": health, "occupancy": occupancy, "announcements": announcements}
    app._db = db
    app._ctx = ctx

    return app, socketio, ctx


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

    app, socketio, ctx = create_app(cfg, mock_mode=args.mock, config_path=args.config)

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
    except Exception as e:
        logger.warning(f"Could not load macros.yaml: {e}")
        macro_count = 0
        button_pages = 0
    logger.info(f"  Macros: {macro_count} defined, {button_pages} pages with buttons")
    eio = socketio.server.eio
    logger.info(f"  SocketIO: ping_interval={eio.ping_interval}s, ping_timeout={eio.ping_timeout}s")
    # Warn about missing critical secrets
    sec = cfg.get("security", {})
    if not sec.get("secret_key"):
        logger.warning("FLASK_SECRET_KEY is not set — sessions will use an insecure default")
    if not sec.get("settings_pin"):
        logger.warning("SETTINGS_PIN is not set — settings page PIN defaults to '1234'")
    if not cfg.get("home_assistant", {}).get("token"):
        logger.warning("HA_TOKEN is not set — Home Assistant integration will not work")

    logger.info("=" * 60)

    # ---- Graceful shutdown ----
    _shutting_down = threading.Event()

    def _graceful_shutdown(signum, frame):
        sig_name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
        if _shutting_down.is_set():
            logger.warning(f"Received {sig_name} again during shutdown — forcing exit")
            sys.exit(1)
        _shutting_down.set()
        logger.info(f"Received {sig_name} — starting graceful shutdown...")

        # 1. Stop modules
        modules = app._modules
        for name, mod in modules.items():
            if mod is None:
                continue
            try:
                if hasattr(mod, "stop"):
                    mod.stop()
                    logger.info(f"  Stopped {name} module")
                elif hasattr(mod, "_running"):
                    mod._running = False
                    logger.info(f"  Stopped {name} module (set _running=False)")
                elif hasattr(mod, "disconnect"):
                    mod.disconnect()
                    logger.info(f"  Disconnected {name} module")
            except Exception as e:
                logger.warning(f"  Error stopping {name}: {e}")

        # 2. Stop watchdog
        watchdog = ctx.watchdog
        if watchdog and hasattr(watchdog, "_stop"):
            try:
                watchdog._stop.set()
                logger.info("  Stopped MoIP watchdog")
            except Exception as e:
                logger.warning(f"  Error stopping watchdog: {e}")

        # 3. Flush SQLite WAL
        if ctx.db:
            try:
                ctx.db.flush()
                logger.info("  Flushed SQLite WAL")
            except Exception as e:
                logger.warning(f"  SQLite flush failed: {e}")

        logger.info("Graceful shutdown complete")
        sys.exit(0)

    signal.signal(signal.SIGTERM, _graceful_shutdown)
    signal.signal(signal.SIGINT, _graceful_shutdown)

    # Start background pollers and scheduler
    from polling import start_pollers
    from scheduler import start_scheduler

    start_pollers(ctx)
    start_scheduler(ctx)

    # Run with eventlet (supports WebSocket)
    socketio.run(app, host=host, port=port, debug=gateway_cfg.get("debug", False))


if __name__ == "__main__":
    main()
