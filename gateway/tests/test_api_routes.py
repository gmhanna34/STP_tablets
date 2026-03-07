"""Smoke tests for API routes — status codes and response shapes.

These tests use mock mode so no real devices are needed.
They verify the API contract (status codes, JSON shapes) rather than device behavior.
"""

import json
import os
import sys
import tempfile
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from flask import Flask
from polling import StateCache, PollerWatchdog
from database import Database


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _build_test_app():
    """Build a Flask app with auth + API routes registered in mock mode."""

    app = Flask(__name__, static_folder=None)
    app.config["SECRET_KEY"] = "test-secret"
    app.config["TESTING"] = True

    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    # Build a minimal context
    class Ctx:
        pass

    ctx = Ctx()
    ctx.app = app
    ctx.socketio = type("FakeSocketIO", (), {"emit": lambda *a, **kw: None})()
    ctx.db = Database(db_path)
    ctx.cfg = {
        "home_assistant": {"url": "", "token": ""},
        "middleware": {},
        "camlytics": {},
        "polling": {},
        "projectors": {},
        "ptz_cameras": {},
        "wattbox": {"ip": "", "username": "", "password": ""},
    }
    ctx.mock_mode = True
    ctx.config_path = ""
    ctx.state_cache = StateCache()
    ctx.watchdog = PollerWatchdog()
    ctx.verbose_logging = threading.Event()
    ctx.camlytics_buffers = {"communion": 0, "occupancy": 0, "enter": 0}
    ctx.camlytics_lock = threading.Lock()
    ctx.ha_device_cache = {"cameras": [], "locks": [], "ready": True}
    ctx.ha_cache_lock = threading.Lock()
    ctx.sid_to_tablet = {}
    ctx.sid_connect_time = {}
    ctx.sid_lock = threading.Lock()

    # Frontend data
    ctx.permissions_data = {"roles": {}, "defaultRole": "full_access"}
    ctx.devices_data = {}
    ctx.settings_data = {"version": "test"}
    ctx.static_dir = tempfile.mkdtemp()
    ctx.known_location_slugs = {"lobby", "chapel"}

    # Macro engine
    from macro_engine import load_macros
    import logging
    _, ctx.macro_defs, ctx.button_defs, ctx.ha_state_entities = load_macros({}, logging.getLogger("test"))
    ctx.macros_cfg = {}

    # Modules (all None in mock)
    ctx.x32 = None
    ctx.moip = None
    ctx.obs = None
    ctx.health = None
    ctx.occupancy = None

    # Security
    ctx.allowed_ips = ["127.0.0.1"]
    ctx.settings_pin = "1234"
    ctx.secure_pin = "5678"
    ctx.remote_auth = {}
    ctx.session_timeout = 480

    # Register auth and routes
    from auth import register_auth
    from api_routes import register_api_routes

    register_auth(ctx)
    register_api_routes(ctx)

    # Write a minimal index.html so static serving works
    with open(os.path.join(ctx.static_dir, "index.html"), "w") as f:
        f.write("<html><body>test</body></html>")

    return app, ctx, db_path


@pytest.fixture(scope="module")
def client():
    """Module-scoped test client for API smoke tests."""
    app, ctx, db_path = _build_test_app()
    with app.test_client() as c:
        yield c
    try:
        os.unlink(db_path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Static / index
# ---------------------------------------------------------------------------

class TestStaticRoutes:
    def test_index_returns_html(self, client):
        resp = client.get("/", environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        assert b"html" in resp.data.lower()


# ---------------------------------------------------------------------------
# Config endpoints
# ---------------------------------------------------------------------------

class TestConfigEndpoints:
    def test_api_config(self, client):
        resp = client.get("/api/config", environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, dict)

    def test_api_settings_verbose(self, client):
        resp = client.get("/api/settings/verbose-logging",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "enabled" in data


# ---------------------------------------------------------------------------
# Macro endpoints
# ---------------------------------------------------------------------------

class TestMacroEndpoints:
    def test_api_macros_list(self, client):
        resp = client.get("/api/macros",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, dict)

    def test_api_macro_state(self, client):
        resp = client.get("/api/macro/state",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Health / status endpoints
# ---------------------------------------------------------------------------

class TestHealthEndpoints:
    def test_api_health(self, client):
        resp = client.get("/api/health",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200

    def test_api_health_includes_pollers(self, client):
        resp = client.get("/api/health",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "pollers" in data


# ---------------------------------------------------------------------------
# Audit / session endpoints
# ---------------------------------------------------------------------------

class TestAuditEndpoints:
    def test_api_audit_logs(self, client):
        resp = client.get("/api/audit/logs",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, list)

    def test_api_audit_sessions(self, client):
        resp = client.get("/api/audit/sessions",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, list)


# ---------------------------------------------------------------------------
# Schedule endpoints
# ---------------------------------------------------------------------------

class TestScheduleEndpoints:
    def test_api_schedules_list(self, client):
        resp = client.get("/api/schedules",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, list)


# ---------------------------------------------------------------------------
# HA endpoints
# ---------------------------------------------------------------------------

class TestHAEndpoints:
    def test_api_ha_entities(self, client):
        resp = client.get("/api/ha/entities",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        # In mock mode with no HA configured, this may return an error or empty
        assert resp.status_code in (200, 502)


# ---------------------------------------------------------------------------
# Auth-blocked endpoints (non-allowed IP)
# ---------------------------------------------------------------------------

class TestAuthBlocking:
    def test_api_blocked_for_unknown_ip(self, client):
        resp = client.get("/api/config",
                          environ_base={"REMOTE_ADDR": "10.0.0.1"})
        assert resp.status_code == 403
