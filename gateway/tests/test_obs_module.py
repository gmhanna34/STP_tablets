"""Tests for OBS module URL resolution logic."""

import logging
import socket
import sys
import os
import types
from unittest.mock import patch, MagicMock

import pytest

# Stub out websocket before importing obs_module (not installed in test env)
if "websocket" not in sys.modules:
    sys.modules["websocket"] = types.ModuleType("websocket")
    sys.modules["websocket"].WebSocket = MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from obs_module import OBSModule


@pytest.fixture
def logger():
    return logging.getLogger("test_obs")


class TestResolveWsUrl:
    """Test _resolve_ws_url bootstrap probe logic."""

    def test_legacy_single_url(self, logger):
        """Falls back to ws_url when no local/remote keys exist."""
        cfg = {"ws_url": "ws://192.168.1.5:4455"}
        assert OBSModule._resolve_ws_url(cfg, logger) == "ws://192.168.1.5:4455"

    def test_legacy_default(self, logger):
        """Returns default when config is empty."""
        assert OBSModule._resolve_ws_url({}, logger) == "ws://127.0.0.1:4455"

    def test_only_local_configured(self, logger):
        """Uses local directly when remote is missing."""
        cfg = {"ws_url_local": "ws://127.0.0.1:4455"}
        assert OBSModule._resolve_ws_url(cfg, logger) == "ws://127.0.0.1:4455"

    def test_only_remote_configured(self, logger):
        """Uses remote directly when local is missing."""
        cfg = {"ws_url_remote": "ws://10.100.60.230:4455"}
        assert OBSModule._resolve_ws_url(cfg, logger) == "ws://10.100.60.230:4455"

    def test_local_probe_succeeds(self, logger):
        """When local port is open, selects local URL."""
        cfg = {
            "ws_url_local": "ws://127.0.0.1:4455",
            "ws_url_remote": "ws://10.100.60.230:4455",
        }
        mock_sock = MagicMock()
        with patch("obs_module.socket.socket", return_value=mock_sock):
            result = OBSModule._resolve_ws_url(cfg, logger)
        assert result == "ws://127.0.0.1:4455"
        mock_sock.connect.assert_called_once_with(("127.0.0.1", 4455))
        mock_sock.close.assert_called_once()

    def test_local_probe_fails_uses_remote(self, logger):
        """When local port is closed, falls back to remote URL."""
        cfg = {
            "ws_url_local": "ws://127.0.0.1:4455",
            "ws_url_remote": "ws://10.100.60.230:4455",
        }
        mock_sock = MagicMock()
        mock_sock.connect.side_effect = OSError("Connection refused")
        with patch("obs_module.socket.socket", return_value=mock_sock):
            result = OBSModule._resolve_ws_url(cfg, logger)
        assert result == "ws://10.100.60.230:4455"

    def test_local_probe_timeout_uses_remote(self, logger):
        """When local probe times out, falls back to remote URL."""
        cfg = {
            "ws_url_local": "ws://127.0.0.1:4455",
            "ws_url_remote": "ws://10.100.60.230:4455",
        }
        mock_sock = MagicMock()
        mock_sock.connect.side_effect = socket.timeout("timed out")
        with patch("obs_module.socket.socket", return_value=mock_sock):
            result = OBSModule._resolve_ws_url(cfg, logger)
        assert result == "ws://10.100.60.230:4455"

    def test_custom_port_parsed(self, logger):
        """Parses non-default port from URL correctly."""
        cfg = {
            "ws_url_local": "ws://127.0.0.1:9999",
            "ws_url_remote": "ws://10.100.60.230:4455",
        }
        mock_sock = MagicMock()
        with patch("obs_module.socket.socket", return_value=mock_sock):
            OBSModule._resolve_ws_url(cfg, logger)
        mock_sock.connect.assert_called_once_with(("127.0.0.1", 9999))

    def test_probe_timeout_value(self, logger):
        """Probe uses the specified timeout."""
        cfg = {
            "ws_url_local": "ws://127.0.0.1:4455",
            "ws_url_remote": "ws://10.100.60.230:4455",
        }
        mock_sock = MagicMock()
        with patch("obs_module.socket.socket", return_value=mock_sock):
            OBSModule._resolve_ws_url(cfg, logger, probe_timeout=2.0)
        mock_sock.settimeout.assert_called_once_with(2.0)
