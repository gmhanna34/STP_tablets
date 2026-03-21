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
import yaml

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
    ctx.permissions_path = ""
    ctx.devices_data = {}
    ctx.settings_data = {"version": "test"}
    ctx.static_dir = tempfile.mkdtemp()
    ctx.known_location_slugs = {"lobby", "chapel"}

    # Macro engine
    macros_doc = {
        "macros": {
            "test_power_cycle": {
                "label": "Test Power Cycle",
                "description": "Simple builder-compatible macro",
                "steps": [
                    {"type": "wattbox_power", "device": "rack_outlet", "action": "off"},
                    {"type": "delay", "seconds": 10},
                    {"type": "wattbox_power", "device": "rack_outlet", "action": "on", "verify": True},
                ],
                "ui_builder": {"managed": True, "category": "Power"},
            },
            "unsupported_macro": {
                "label": "Unsupported",
                "steps": [
                    {"type": "wait_until", "target": "switch.example", "timeout": 10},
                ],
            },
        },
        "buttons": {},
    }
    macros_fd, macros_path = tempfile.mkstemp(suffix=".yaml")
    os.close(macros_fd)
    with open(macros_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(macros_doc, f, sort_keys=False)
    ctx.macros_path = macros_path
    ctx.macros_cfg = macros_doc
    ctx.macro_defs = macros_doc["macros"]
    ctx.button_defs = macros_doc["buttons"]
    ctx.ha_state_entities = set()

    # Modules (all None in mock)
    ctx.x32 = None
    ctx.moip = None
    ctx.obs = None
    ctx.health = None
    ctx.occupancy = None

    from announcement_module import AnnouncementModule
    ctx.announcements = AnnouncementModule(ctx.cfg, logging.getLogger("test"), ctx=ctx)

    # Security
    ctx.allowed_ips = ["127.0.0.1"]
    ctx.trusted_proxy_prefixes = []
    ctx.settings_pin = "1234"
    ctx.secure_pin = "5678"
    ctx.remote_auth = {}
    ctx.session_timeout = 480
    ctx.user_module = None

    # Register auth and routes
    from auth import register_auth
    from api_routes import register_api_routes

    register_auth(ctx)
    register_api_routes(ctx)

    # Write a minimal index.html so static serving works
    with open(os.path.join(ctx.static_dir, "index.html"), "w") as f:
        f.write("<html><body>test</body></html>")

    return app, ctx, db_path, macros_path


@pytest.fixture(scope="module")
def client():
    """Module-scoped test client for API smoke tests."""
    app, ctx, db_path, macros_path = _build_test_app()
    with app.test_client() as c:
        yield c
    try:
        os.unlink(db_path)
    except OSError:
        pass
    try:
        os.unlink(macros_path)
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

    def test_macro_builder_list(self, client):
        resp = client.get("/api/macro-builder",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "macros" in data
        assert any(m["key"] == "test_power_cycle" for m in data["macros"])

    def test_macro_builder_preview(self, client):
        payload = {
            "key": "preview_test",
            "label": "Preview Test",
            "steps": [
                {"type": "delay", "seconds": 5},
            ],
        }
        resp = client.post("/api/macro-builder/preview",
                           data=json.dumps(payload),
                           content_type="application/json",
                           environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "macros:" in data["preview"]

    def test_macro_builder_save_and_delete(self, client):
        payload = {
            "key": "builder_created",
            "label": "Builder Created",
            "description": "Saved from test",
            "category": "Power",
            "steps": [
                {"type": "wattbox_power", "device": "rack_outlet", "action": "cycle"},
                {"type": "delay", "seconds": 8},
                {"type": "ha_service", "domain": "switch", "service": "turn_on",
                 "data": {"entity_id": "switch.example_outlet"}, "verify": True},
            ],
        }
        save_resp = client.post("/api/macro-builder",
                                data=json.dumps(payload),
                                content_type="application/json",
                                environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert save_resp.status_code == 200
        saved = save_resp.get_json()
        assert saved["macro"]["key"] == "builder_created"

        get_resp = client.get("/api/macro-builder/builder_created",
                              environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert get_resp.status_code == 200
        loaded = get_resp.get_json()
        assert loaded["managed"] is True
        assert loaded["steps"][0]["type"] == "wattbox_power"

        delete_resp = client.delete("/api/macro-builder/builder_created",
                                    environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert delete_resp.status_code == 200

        missing_resp = client.get("/api/macro-builder/builder_created",
                                  environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert missing_resp.status_code == 404


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
