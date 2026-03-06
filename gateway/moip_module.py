"""
MoIP Module — Direct Telnet communication with the Binary MoIP controller.

Absorbed from STP_scripts/moip-flask.py (Phase 2 of the consolidation plan).
Replaces the standalone Flask+Waitress middleware that ran on port 5002.

Key design:
- Persistent Telnet connection with internal/external IP fallback.
- Keepalive thread sends periodic ?Receivers to detect connection loss.
- Watchdog triggers Home Assistant webhook after prolonged failure.
- All public methods return plain dicts suitable for jsonify().
- Thread-safe: connection_lock protects Telnet I/O, state_lock protects counters.
"""

from __future__ import annotations

import logging
import select
import socket
import threading
import time
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

import requests as http_requests
import urllib3

# Suppress warnings for verify=False calls to Nabu Casa webhooks
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


# =============================================================================
# PARSERS
# =============================================================================

def parse_receivers(response: str) -> dict:
    """Parse receiver-to-transmitter mappings from Telnet response."""
    receivers: Dict[str, dict] = {}
    if not response:
        return receivers
    for line in response.strip().split("\n"):
        line = line.strip()
        if "Receivers=" not in line:
            continue
        data = line.split("Receivers=")[1]
        for pair in data.split(","):
            if ":" not in pair:
                continue
            parts = pair.split(":")
            if len(parts) != 2:
                continue
            tx, rx = parts
            receivers[rx] = {
                "receiver_id": rx,
                "transmitter_id": tx,
                "connected": True,
            }
    return receivers


def parse_devices(response: str) -> dict:
    """Parse device counts from Telnet response."""
    devices = {"transmitters": 0, "receivers": 0}
    if not response:
        return devices
    for line in response.strip().split("\n"):
        line = line.strip()
        if "Devices=" not in line:
            continue
        data = line.split("Devices=")[1]
        counts = data.split(",")
        if len(counts) >= 2:
            devices["transmitters"] = int(counts[0])
            devices["receivers"] = int(counts[1])
    return devices


# =============================================================================
# MOIP CONNECTION
# =============================================================================

class MoIPConnection:
    """Manages persistent TCP connection to the MoIP controller.

    Uses raw sockets instead of telnetlib (removed in Python 3.13).
    The MoIP controller speaks plain ASCII over TCP on port 23.
    """

    def __init__(self, cfg: dict, logger: logging.Logger) -> None:
        self._logger = logger
        self._host_internal = cfg.get("host_internal", "10.100.20.11")
        self._port_internal = cfg.get("port_internal", 23)
        self._host_external = cfg.get("host_external", "external.stpauloc.org")
        self._port_external = cfg.get("port_external", 2323)
        self._username = cfg.get("username", "")
        self._password = cfg.get("password", "")
        self._read_timeout = cfg.get("telnet_read_timeout", 5)

        self._sock: Optional[socket.socket] = None
        self.connected: bool = False
        self.host: str = self._host_internal
        self.port: int = self._port_internal
        self._use_external: bool = False

    def _open_socket(self, host: str, port: int, timeout: int) -> socket.socket:
        """Open a TCP connection and return the socket."""
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.setblocking(False)
        return sock

    def _authenticate(self) -> None:
        """Send username/password if configured."""
        if self._username:
            self._sock.sendall(f"{self._username}\n".encode("ascii"))
            time.sleep(0.1)
            self._sock.sendall(f"{self._password}\n".encode("ascii"))
            time.sleep(0.2)
            self._logger.info("MoIP: Authentication sent")

    def connect(self) -> bool:
        """Establish TCP connection with internal/external fallback."""
        self._close_socket()

        try:
            if not self._use_external:
                try:
                    self._logger.info(
                        f"MoIP: Connecting (internal) {self._host_internal}:{self._port_internal}"
                    )
                    self._sock = self._open_socket(
                        self._host_internal, self._port_internal, timeout=5
                    )
                    self.host = self._host_internal
                    self.port = self._port_internal
                    self._logger.info("MoIP: Connected via internal")
                except Exception as e:
                    self._logger.warning(f"MoIP: Internal connection failed: {e}")
                    raise
            else:
                self._logger.info(
                    f"MoIP: Connecting (external) {self._host_external}:{self._port_external}"
                )
                self._sock = self._open_socket(
                    self._host_external, self._port_external, timeout=10
                )
                self.host = self._host_external
                self.port = self._port_external
                self._logger.info("MoIP: Connected via external")

            self._authenticate()
            self.connected = True
            return True

        except Exception as e:
            self._logger.warning(f"MoIP: Connection failed: {e}")
            self.connected = False
            self._close_socket()

            # Try external fallback if we haven't already
            if not self._use_external:
                self._logger.info("MoIP: Attempting external connection...")
                self._use_external = True
                try:
                    self._sock = self._open_socket(
                        self._host_external, self._port_external, timeout=10
                    )
                    self.host = self._host_external
                    self.port = self._port_external
                    self._authenticate()
                    self.connected = True
                    self._logger.info("MoIP: Connected via external (fallback)")
                    return True
                except Exception as e2:
                    self._logger.error(f"MoIP: External connection also failed: {e2}")
                    self._close_socket()

            return False

    def disconnect(self) -> None:
        """Graceful close: send exit command, then close socket."""
        if self._sock:
            try:
                self._sock.sendall(b"!Exit\n")
                time.sleep(0.1)
            except Exception as e:
                self._logger.debug(f"MoIP: exit command failed: {e}")
        self._close_socket()
        self.connected = False

    def _close_socket(self) -> None:
        """Forcibly close the underlying socket."""
        if self._sock:
            try:
                self._sock.close()
            except Exception as e:
                self._logger.debug(f"MoIP: socket close failed: {e}")
            self._sock = None

    def send_command(self, command: str) -> Optional[str]:
        """Send command and return response. Single attempt — no internal retry.

        Reconnection/retry logic lives in MoIPModule._send() so the failure
        streak counter stays accurate (one call = one attempt = one count).
        """
        if not self.connected:
            if not self.connect():
                return None

        try:
            if not command.endswith("\n"):
                command += "\n"

            self._sock.sendall(command.encode("ascii"))
            time.sleep(0.05)

            if command.strip().startswith("?"):
                return self._read_response()
            return "OK"

        except Exception as e:
            self._logger.error(f"MoIP: Command failed: {e}")
            self.disconnect()
            return None

    def _read_response(self) -> str:
        """Read TCP response with timeout to prevent indefinite hangs.

        Uses select() to poll for available data (replaces telnetlib's
        read_very_eager which was also non-blocking).
        """
        deadline = time.time() + self._read_timeout
        chunks = []
        while time.time() < deadline:
            try:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                ready, _, _ = select.select([self._sock], [], [], min(remaining, 0.1))
                if ready:
                    chunk = self._sock.recv(4096).decode("ascii", errors="ignore")
                    if not chunk:
                        # Connection closed by remote
                        raise ConnectionError("MoIP: Remote closed connection")
                    chunks.append(chunk)
                    time.sleep(0.05)
                else:
                    if chunks:
                        break
            except (ConnectionError, OSError):
                raise
            except Exception as e:
                self._logger.debug(f"MoIP: read error: {e}")
                break
        return "".join(chunks)


# =============================================================================
# MOIP MODULE (public interface for the gateway)
# =============================================================================

class MoIPModule:
    """
    Gateway-facing interface for the MoIP video matrix controller.

    Usage:
        moip = MoIPModule(cfg, logger, ha_cfg={...})
        moip.start()
        # Then call moip.get_receivers(), moip.switch(tx, rx), etc.
    """

    def __init__(self, cfg: dict, logger: logging.Logger,
                 ha_cfg: Optional[dict] = None) -> None:
        self._logger = logger
        self._cfg = cfg
        self._ha_cfg = ha_cfg or {}

        # Connection
        self._conn = MoIPConnection(cfg, logger)
        self._connection_lock = threading.Lock()

        # State (protected by _state_lock)
        self._state_lock = threading.Lock()
        self._healthy: bool = False
        self._failure_streak: int = 0
        self._last_successful_command: Optional[datetime] = None
        self._last_reboot_time: Optional[datetime] = None
        self._last_receivers: dict = {}

        # Thresholds
        self._failure_threshold = cfg.get("failure_threshold", 5)
        self._reboot_cooldown_minutes = cfg.get("reboot_cooldown_minutes", 15)
        self._keepalive_normal = cfg.get("keepalive_interval_normal", 30)
        self._keepalive_max = cfg.get("keepalive_interval_max", 300)

        # Keepalive thread
        self._stop = threading.Event()
        self._keepalive_thread = threading.Thread(
            target=self._keepalive_loop, daemon=True
        )

    def start(self) -> None:
        self._logger.info(
            f"MoIP module starting: {self._cfg.get('host_internal', '?')}:"
            f"{self._cfg.get('port_internal', 23)}"
        )
        self._logger.info(
            f"MoIP watchdog: threshold={self._failure_threshold}, "
            f"cooldown={self._reboot_cooldown_minutes}min, "
            f"webhook={'configured' if self._cfg.get('ha_webhook_id') else 'NOT SET'}"
        )
        self._keepalive_thread.start()

    # --- Thread-safe command send ---

    def _send(self, command: str) -> Optional[str]:
        """Thread-safe command send with one retry on failure.

        First attempt fails → reconnect → second attempt.
        Each call to _send increments the failure streak by at most 1.
        """
        with self._connection_lock:
            result = self._conn.send_command(command)

            # One retry: reconnect and try again
            if result is None:
                if self._conn.connect():
                    result = self._conn.send_command(command)

        if result:
            with self._state_lock:
                self._last_successful_command = datetime.now()
                self._healthy = True
                self._failure_streak = 0
        else:
            with self._state_lock:
                self._healthy = False
                self._failure_streak += 1
                streak = self._failure_streak

            if streak == 1 or streak % 5 == 0:
                self._logger.warning(f"MoIP: Failure streak: {streak}")

            if streak >= self._failure_threshold:
                self._logger.critical(
                    f"MoIP: FAILURE THRESHOLD REACHED ({self._failure_threshold})"
                )
                self._trigger_ha_restart()

        return result

    # --- Public API ---

    def get_receivers(self, force: bool = False) -> Tuple[dict, int]:
        """Get receiver-to-transmitter mappings. Returns (data, status).

        When the module is offline and force=False (default), returns cached
        data immediately instead of hammering the controller with reconnect
        attempts.  The keepalive thread is solely responsible for reconnection.
        """
        # If offline, return cached data — don't pile on reconnect attempts
        if not force:
            with self._state_lock:
                if not self._healthy:
                    cached = self._last_receivers
                    if cached:
                        return cached, 200
                    return {"error": "No data available"}, 503

        response = self._send("?Receivers")
        if response:
            receivers = parse_receivers(response)
            with self._state_lock:
                self._last_receivers = receivers
            return receivers, 200
        # Return cached data if available
        with self._state_lock:
            cached = self._last_receivers
        if cached:
            return cached, 200
        return {"error": "No data available"}, 503

    def get_devices(self) -> Tuple[dict, int]:
        """Get device counts. Returns (data, status)."""
        response = self._send("?Devices")
        if response:
            return parse_devices(response), 200
        return {"error": "No data available"}, 503

    def switch(self, tx: str, rx: str) -> Tuple[dict, int]:
        """Switch a receiver to a transmitter."""
        response = self._send(f"!Switch={tx},{rx}")
        if response:
            self._logger.info(f"MoIP: Switch RX{rx} -> TX{tx}")
            return {"success": True, "transmitter": tx, "receiver": rx}, 200
        return {"error": "Command failed"}, 503

    def send_ir(self, tx: str, rx: str, code: str) -> Tuple[dict, int]:
        """Send IR command via a receiver."""
        response = self._send(f"!IR={tx},{rx},{code}")
        if response:
            self._logger.info(f"MoIP: IR TX{tx}/RX{rx}")
            return {"success": True}, 200
        return {"error": "Command failed"}, 503

    def activate_scene(self, scene: str) -> Tuple[dict, int]:
        """Activate a pre-defined MoIP scene."""
        response = self._send(f"!ActivateScene={scene}")
        if response:
            self._logger.info(f"MoIP: Scene activated: {scene}")
            return {"success": True, "scene": scene}, 200
        return {"error": "Command failed"}, 503

    def send_osd(self, text: Optional[str] = None,
                 clear: bool = False) -> Tuple[dict, int]:
        """Send OSD message or clear."""
        if clear:
            cmd = "!OSD=1,CLEAR"
        elif text:
            cmd = f"!SetOSDImage={text},10,[1],9"
        else:
            return {"error": "Invalid OSD command"}, 400

        response = self._send(cmd)
        if response:
            return {"success": True}, 200
        return {"error": "Command failed"}, 503

    def get_status(self) -> dict:
        """Return health/connection status dict."""
        with self._state_lock:
            healthy = self._healthy
            streak = self._failure_streak
            last_cmd = self._last_successful_command
            last_reboot = self._last_reboot_time

        uptime = None
        if last_cmd:
            uptime = round((datetime.now() - last_cmd).total_seconds(), 2)

        reboot_ago = None
        if last_reboot:
            reboot_ago = round((datetime.now() - last_reboot).total_seconds(), 2)

        return {
            "healthy": healthy,
            "connected": self._conn.connected,
            "mode": "external" if self._conn._use_external else "internal",
            "last_command_seconds_ago": uptime,
            "failure_streak": streak,
            "failure_threshold": self._failure_threshold,
            "last_reboot_seconds_ago": reboot_ago,
            "reboot_cooldown_minutes": self._reboot_cooldown_minutes,
        }

    def reset_watchdog(self) -> dict:
        """Manually reset the failure streak."""
        with self._state_lock:
            old = self._failure_streak
            self._failure_streak = 0
        self._logger.info(f"MoIP: Watchdog manually reset (was {old})")
        return {"success": True, "previous_streak": old, "current_streak": 0}

    # --- Keepalive ---

    def _keepalive_loop(self) -> None:
        """Periodically check connection health with exponential backoff.

        This is the ONLY thread that should attempt reconnection when offline.
        The poller and route handlers return cached data instead of piling on.
        """
        self._logger.info("MoIP keepalive thread started")
        interval = self._keepalive_normal
        consecutive_failures = 0

        while not self._stop.is_set():
            self._stop.wait(timeout=interval)
            if self._stop.is_set():
                break

            response = self._send("?Receivers")
            if response:
                interval = self._keepalive_normal
                consecutive_failures = 0
                # Cache the receivers data from keepalive
                receivers = parse_receivers(response)
                if receivers:
                    with self._state_lock:
                        self._last_receivers = receivers
            else:
                consecutive_failures += 1
                interval = min(
                    self._keepalive_normal * (2 ** consecutive_failures),
                    self._keepalive_max,
                )
                self._logger.warning(
                    f"MoIP: Keepalive no response (failures={consecutive_failures}), "
                    f"next check in {interval}s"
                )

                # Check if _send() already triggered a restart (streak was
                # reset to 0 inside _trigger_ha_restart).  If so, just reset
                # the local counter — no need for a duplicate trigger.
                with self._state_lock:
                    streak = self._failure_streak
                if streak == 0 and consecutive_failures >= self._failure_threshold:
                    self._logger.info(
                        "MoIP: Restart already triggered by send path, "
                        "resetting keepalive counter"
                    )
                    consecutive_failures = 0
                elif consecutive_failures >= self._failure_threshold:
                    self._logger.critical(
                        f"MoIP: KEEPALIVE FAILURE THRESHOLD REACHED "
                        f"({self._failure_threshold})"
                    )
                    self._trigger_ha_restart()
                    consecutive_failures = 0

    # --- HA Watchdog ---

    def _check_reboot_cooldown(self) -> bool:
        """Check if enough time has passed since last reboot."""
        with self._state_lock:
            last_reboot = self._last_reboot_time

        if last_reboot:
            minutes_since = (datetime.now() - last_reboot).total_seconds() / 60
            self._logger.info(f"MoIP: Last reboot was {minutes_since:.1f} min ago")
            if minutes_since < self._reboot_cooldown_minutes:
                self._logger.warning(
                    f"MoIP: Cooldown active: "
                    f"{self._reboot_cooldown_minutes - minutes_since:.1f} min remaining"
                )
                return False
            return True

        # Fall back to HA entity check (persistence across restarts)
        ha_url = self._ha_cfg.get("url", "")
        ha_token = self._ha_cfg.get("token", "")
        if not ha_url or not ha_token:
            return True

        try:
            entity = "input_datetime.moip_last_reboot"
            url = f"{ha_url}/api/states/{entity}"
            headers = {
                "Authorization": f"Bearer {ha_token}",
                "Content-Type": "application/json",
            }
            resp = http_requests.get(url, headers=headers, timeout=6, verify=False)
            if resp.status_code == 200:
                state_str = resp.json()["state"]
                state_str = state_str.replace(" ", "T")
                if "+" in state_str:
                    state_str = state_str.split("+")[0]
                if state_str.endswith("Z"):
                    state_str = state_str[:-1]
                last_reboot_ha = datetime.fromisoformat(state_str)
                minutes_since = (datetime.now() - last_reboot_ha).total_seconds() / 60
                self._logger.info(
                    f"MoIP: Last reboot was {minutes_since:.1f} min ago (from HA)"
                )
                if minutes_since < self._reboot_cooldown_minutes:
                    with self._state_lock:
                        self._last_reboot_time = last_reboot_ha
                    return False
                return True
        except Exception as e:
            self._logger.error(f"MoIP: Cooldown check error: {e}")
        return True

    def _trigger_ha_restart(self) -> bool:
        """Trigger Home Assistant webhook to restart MoIP controller."""
        ha_url = self._ha_cfg.get("url", "")
        ha_token = self._ha_cfg.get("token", "")
        if not ha_url:
            self._logger.warning(
                "MoIP: Watchdog triggered but HA not configured — "
                "set HA_URL in .env to enable automatic restart"
            )
            return False

        if not self._check_reboot_cooldown():
            self._logger.warning("MoIP: Restart blocked by cooldown period")
            with self._state_lock:
                self._failure_streak = 0
            return False

        try:
            # Use the HA webhook to trigger restart
            webhook_url = self._cfg.get("ha_webhook_id", "")
            if not webhook_url:
                self._logger.warning(
                    "MoIP: Watchdog triggered but no webhook configured — "
                    "set MOIP_HA_WEBHOOK_ID in .env to enable automatic restart"
                )
                return False

            with self._state_lock:
                streak = self._failure_streak

            payload = {
                "source": "gateway_moip_module",
                "failure_streak": streak,
                "timestamp": datetime.now().isoformat(),
            }

            self._logger.warning(
                f"MoIP: WATCHDOG TRIGGERED: Sending restart webhook "
                f"(failure streak: {streak})"
            )

            resp = http_requests.post(
                webhook_url, json=payload, timeout=10, verify=False
            )

            if resp.status_code in [200, 204]:
                self._logger.info("MoIP: Restart webhook sent successfully")
                with self._state_lock:
                    self._last_reboot_time = datetime.now()
                    self._failure_streak = 0
                return True
            else:
                self._logger.error(
                    f"MoIP: Webhook failed: HTTP {resp.status_code}"
                )
                return False

        except Exception as e:
            self._logger.error(f"MoIP: Failed to send webhook: {e}")
            return False
