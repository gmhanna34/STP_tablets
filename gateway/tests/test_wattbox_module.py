"""Tests for WattBox module — parsers, device resolution, state management."""

import logging
import os
import sys
import threading
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from wattbox_module import (
    WattBoxConnection,
    WattBoxDevice,
    WattBoxModule,
    parse_outlet_status,
    parse_outlet_name,
    parse_simple_value,
)


@pytest.fixture
def logger():
    return logging.getLogger("test_wattbox")


# =============================================================================
# PARSER TESTS
# =============================================================================

class TestParseOutletStatus:
    def test_basic(self):
        resp = "OutletStatus=1,0,1,1,0,1,0,0,1,1,0,0"
        states = parse_outlet_status(resp)
        assert states[1] is True
        assert states[2] is False
        assert states[3] is True
        assert states[5] is False
        assert states[9] is True
        assert len(states) == 12

    def test_push_format(self):
        """Push broadcasts use ~ prefix."""
        resp = "~OutletStatus=1,0,1"
        states = parse_outlet_status(resp, 3)
        assert states == {1: True, 2: False, 3: True}

    def test_empty(self):
        assert parse_outlet_status("") == {}
        assert parse_outlet_status(None) == {}

    def test_multiline(self):
        resp = "some header\nOutletStatus=1,0\nsome footer"
        states = parse_outlet_status(resp, 2)
        assert states == {1: True, 2: False}

    def test_whitespace(self):
        resp = "  OutletStatus=1, 0, 1  \n"
        states = parse_outlet_status(resp, 3)
        assert states == {1: True, 2: False, 3: True}


class TestParseOutletName:
    def test_basic(self):
        resp = "OutletName=3,X32 Mixer"
        result = parse_outlet_name(resp)
        assert result == (3, "X32 Mixer")

    def test_empty_name(self):
        resp = "OutletName=1,"
        result = parse_outlet_name(resp)
        assert result == (1, "")

    def test_name_with_comma(self):
        """Names can contain commas — only split on first comma."""
        resp = "OutletName=5,Device A, Unit B"
        result = parse_outlet_name(resp)
        assert result == (5, "Device A, Unit B")

    def test_empty_response(self):
        assert parse_outlet_name("") is None
        assert parse_outlet_name(None) is None

    def test_no_match(self):
        assert parse_outlet_name("SomeOtherResponse=foo") is None


class TestParseSimpleValue:
    def test_model(self):
        resp = "Model=WB-800VPS-IPVM-12"
        assert parse_simple_value(resp, "Model") == "WB-800VPS-IPVM-12"

    def test_firmware(self):
        resp = "Firmware=2.10.0"
        assert parse_simple_value(resp, "Firmware") == "2.10.0"

    def test_voltage(self):
        resp = "Voltage=1215"
        assert parse_simple_value(resp, "Voltage") == "1215"

    def test_empty(self):
        assert parse_simple_value("", "Model") is None
        assert parse_simple_value(None, "Model") is None

    def test_no_match(self):
        assert parse_simple_value("Firmware=2.10.0", "Model") is None


# =============================================================================
# WATTBOX DEVICE TESTS
# =============================================================================

class TestWattBoxDevice:
    def _make_device(self, logger):
        return WattBoxDevice(
            pdu_id="wb_008_av_audiorack2",
            ip="10.100.60.68",
            port=23,
            username="admin",
            password="test",
            label="WB-8 AV Audio Rack 2",
            logger=logger,
        )

    def test_initial_state(self, logger):
        dev = self._make_device(logger)
        assert dev.pdu_id == "wb_008_av_audiorack2"
        assert dev.ip == "10.100.60.68"
        assert not dev.connected
        health = dev.get_health()
        assert health["healthy"] is False
        assert health["pdu_id"] == "wb_008_av_audiorack2"

    def test_outlet_on_success(self, logger):
        dev = self._make_device(logger)
        dev._conn = MagicMock()
        dev._conn.connected = True
        dev._conn.connect.return_value = True
        # Set command returns "OK"; verify query returns outlet 3 as ON
        dev._conn.send_command.side_effect = lambda cmd: (
            "~OutletStatus=0,0,1,0,0,0,0,0,0,0,0,0" if cmd == "?OutletStatus"
            else "OK"
        )

        ok = dev.outlet_on(3)
        assert ok is True
        with dev._state_lock:
            assert dev._outlet_states[3] is True
            assert dev._healthy is True
            assert dev._failure_streak == 0

    def test_outlet_off_success(self, logger):
        dev = self._make_device(logger)
        dev._conn = MagicMock()
        dev._conn.connected = True
        # Outlet 5 is OFF in the status response
        dev._conn.send_command.side_effect = lambda cmd: (
            "~OutletStatus=1,1,1,1,0,0,0,0,0,0,0,0" if cmd == "?OutletStatus"
            else "OK"
        )

        ok = dev.outlet_off(5)
        assert ok is True
        with dev._state_lock:
            assert dev._outlet_states[5] is False

    def test_outlet_cycle_success(self, logger):
        dev = self._make_device(logger)
        dev._conn = MagicMock()
        dev._conn.connected = True
        dev._conn.send_command.side_effect = lambda cmd: (
            "~OutletStatus=0,1,1,0,0,0,0,0,0,0,0,0" if cmd == "?OutletStatus"
            else "OK"
        )

        ok = dev.outlet_cycle(1)
        assert ok is True

    def test_command_failure_increments_streak(self, logger):
        dev = self._make_device(logger)
        dev._conn = MagicMock()
        dev._conn.send_command.return_value = None
        dev._conn.connect.return_value = False

        ok = dev.outlet_on(1)
        assert ok is False
        with dev._state_lock:
            assert dev._healthy is False
            assert dev._failure_streak == 1

    def test_update_from_push(self, logger):
        dev = self._make_device(logger)
        dev._outlet_states = {1: True, 2: True, 3: False}

        changed = dev.update_from_push("~OutletStatus=1,0,1")
        assert changed is True
        with dev._state_lock:
            assert dev._outlet_states == {1: True, 2: False, 3: True}
            assert dev._healthy is True

    def test_update_from_push_no_change(self, logger):
        dev = self._make_device(logger)
        dev._outlet_states = {1: True, 2: False}

        changed = dev.update_from_push("~OutletStatus=1,0")
        assert changed is False

    def test_get_all_states(self, logger):
        dev = self._make_device(logger)
        dev._outlet_states = {1: True, 2: False}
        dev._outlet_names = {1: "X32 Mixer", 2: "Amplifier"}
        dev._model = "WB-800VPS-IPVM-12"
        dev._firmware = "2.10.0"
        dev._voltage = 121.5
        dev._healthy = True
        dev._conn = MagicMock()
        dev._conn.connected = True

        result = dev.get_all_states()
        assert result["pdu_id"] == "wb_008_av_audiorack2"
        assert result["model"] == "WB-800VPS-IPVM-12"
        assert result["voltage"] == 121.5
        assert result["connected"] is True
        assert result["outlets"][1]["state"] == "on"
        assert result["outlets"][1]["name"] == "X32 Mixer"
        assert result["outlets"][1]["stable_id"] == "wb_008_av_audiorack2.outlet_1"
        assert result["outlets"][2]["state"] == "off"


# =============================================================================
# WATTBOX MODULE TESTS
# =============================================================================

class TestWattBoxModule:
    def _make_cfg(self):
        return {
            "username": "admin",
            "password": "test",
            "port": 23,
            "keepalive_interval_normal": 60,
            "keepalive_interval_max": 300,
            "failure_threshold": 5,
            "reboot_cooldown_minutes": 15,
            "pdus": {
                "wb_004_av_audiorack1": {
                    "ip": "10.100.60.64",
                    "label": "WB-4 AV Audio Rack 1",
                },
                "wb_008_av_audiorack2": {
                    "ip": "10.100.60.68",
                    "label": "WB-8 AV Audio Rack 2",
                },
            },
            "devices": {
                "x32_mixer": {
                    "label": "X32 Mixer",
                    "ip": "10.100.60.64",
                    "outlet": 3,
                },
            },
        }

    def test_init_creates_devices(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        assert len(mod._devices) == 2
        assert "wb_004_av_audiorack1" in mod._devices
        assert "wb_008_av_audiorack2" in mod._devices

    def test_resolve_stable_id(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        result = mod._resolve_device("wb_004_av_audiorack1.outlet_3")
        assert result is not None
        device, outlet = result
        assert device.pdu_id == "wb_004_av_audiorack1"
        assert outlet == 3

    def test_resolve_stable_id_not_found(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        assert mod._resolve_device("wb_999_fake.outlet_1") is None

    def test_resolve_legacy_device_key(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        result = mod._resolve_device("x32_mixer")
        assert result is not None
        device, outlet = result
        assert device.ip == "10.100.60.64"
        assert outlet == 3

    def test_outlet_on_unknown_device(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        result, status = mod.outlet_on("nonexistent.outlet_1")
        assert status == 404
        assert "error" in result

    def test_outlet_on_success(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        device = mod._devices["wb_004_av_audiorack1"]
        device._conn = MagicMock()
        device._conn.connected = True
        # Outlet 3 is ON after set command
        device._conn.send_command.side_effect = lambda cmd: (
            "~OutletStatus=0,0,1,0,0,0,0,0,0,0,0,0" if cmd == "?OutletStatus"
            else "OK"
        )

        result, status = mod.outlet_on("wb_004_av_audiorack1.outlet_3")
        assert status == 200
        assert result["success"] is True
        assert result["action"] == "on"
        assert result["verified"] is True

    def test_outlet_off_success(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        device = mod._devices["wb_008_av_audiorack2"]
        device._conn = MagicMock()
        device._conn.connected = True
        # Outlet 5 is OFF after set command
        device._conn.send_command.side_effect = lambda cmd: (
            "~OutletStatus=1,1,1,1,0,0,0,0,0,0,0,0" if cmd == "?OutletStatus"
            else "OK"
        )

        result, status = mod.outlet_off("wb_008_av_audiorack2.outlet_5")
        assert status == 200
        assert result["success"] is True

    def test_get_all_devices(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        result, status = mod.get_all_devices()
        assert status == 200
        assert "wb_004_av_audiorack1" in result
        assert "wb_008_av_audiorack2" in result

    def test_get_health(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        health = mod.get_health()
        assert "healthy" in health
        assert health["pdus_total"] == 2
        assert "wb_004_av_audiorack1" in health["pdus"]

    def test_reboot_pdu_unknown(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        result, status = mod.reboot_pdu("nonexistent")
        assert status == 404

    @patch("wattbox_module.http_requests.get")
    def test_reboot_pdu_success(self, mock_get, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        result, status = mod.reboot_pdu("wb_004_av_audiorack1")
        assert status == 200
        assert result["success"] is True
        mock_get.assert_called_once()
        # Verify reboot endpoint was called
        call_url = mock_get.call_args[0][0]
        assert "reboot.cgi" in call_url

    def test_reset_watchdog(self, logger):
        cfg = self._make_cfg()
        mod = WattBoxModule(cfg, logger)
        device = mod._devices["wb_004_av_audiorack1"]
        with device._state_lock:
            device._failure_streak = 10

        result, status = mod.reset_watchdog("wb_004_av_audiorack1")
        assert status == 200
        assert result["previous_streak"] == 10
        assert result["current_streak"] == 0

    def test_skip_pdu_without_ip(self, logger):
        cfg = self._make_cfg()
        cfg["pdus"]["bad_pdu"] = {"label": "No IP"}
        mod = WattBoxModule(cfg, logger)
        assert "bad_pdu" not in mod._devices
        assert len(mod._devices) == 2

    def test_broadcast_state(self, logger):
        cfg = self._make_cfg()
        mock_sio = MagicMock()
        mod = WattBoxModule(cfg, logger, socketio=mock_sio)
        device = mod._devices["wb_004_av_audiorack1"]
        device._outlet_states = {1: True}

        mod._broadcast_state(device)
        mock_sio.emit.assert_called_once()
        call_args = mock_sio.emit.call_args
        assert call_args[0][0] == "state:wattbox"
        assert "wb_004_av_audiorack1" in call_args[0][1]
