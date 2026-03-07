"""Shared fixtures for gateway tests."""

import os
import sys
import threading

import pytest

# Ensure gateway/ is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# Minimal GatewayContext stub (avoids importing gateway_app which monkey-patches)
# ---------------------------------------------------------------------------

class StubContext:
    """Lightweight stand-in for GatewayContext that doesn't require eventlet."""

    def __init__(self):
        from polling import StateCache, PollerWatchdog

        self.cfg = {
            "home_assistant": {"url": "", "token": ""},
            "middleware": {},
            "camlytics": {},
            "polling": {},
        }
        self.logger = None
        self.mock_mode = True
        self.config_path = ""
        self.state_cache = StateCache()
        self.watchdog = PollerWatchdog()

        # Modules (all None in mock)
        self.x32 = None
        self.moip = None
        self.obs = None
        self.health = None
        self.occupancy = None

        # Security
        self.allowed_ips = ["192.168.1.", "127.0.0.1"]
        self.settings_pin = "1234"
        self.secure_pin = "5678"
        self.remote_auth = {}
        self.session_timeout = 480

        # Frontend data
        self.permissions_data = {}
        self.devices_data = {}
        self.settings_data = {}
        self.static_dir = ""
        self.known_location_slugs = set()

        # Runtime
        self.verbose_logging = threading.Event()
        self.camlytics_buffers = {"communion": 0, "occupancy": 0, "enter": 0}
        self.camlytics_lock = threading.Lock()
        self.ha_device_cache = {"cameras": [], "locks": [], "ready": False}
        self.ha_cache_lock = threading.Lock()
        self.sid_to_tablet = {}
        self.sid_connect_time = {}
        self.sid_lock = threading.Lock()

        # Macro engine
        self.macro_defs = {}
        self.button_defs = {}
        self.macros_cfg = {}
        self.ha_state_entities = set()


@pytest.fixture
def stub_ctx():
    """Return a fresh StubContext for each test."""
    return StubContext()
