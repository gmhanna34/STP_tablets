"""
WattBox Module — Direct Telnet communication with WattBox PDUs (WB-800 series).

Manages persistent Telnet connections to 9 WattBox PDUs for direct outlet
control, bypassing Home Assistant. Uses the WattBox Telnet API v2.2 which
supports push-based state change broadcasts.

Key design:
- One persistent Telnet connection per unique PDU IP (9 connections for 9 PDUs).
- Push listener threads receive unsolicited outlet state broadcasts (~instant).
- Lightweight keepalive poll as fallback (every 60s, backoff on failure).
- Watchdog triggers HTTP reboot (firmware restart, outlets keep power) after
  prolonged failure.
- Stable outlet IDs derived from PDU key + outlet number (e.g.,
  "wb_008_av_audiorack2.outlet_3") — macros reference these, never change.
- Friendly names pulled from WattBox UI via Telnet at connect time.
- Thread-safe: connection_lock protects Telnet I/O, state_lock protects caches.
"""

from __future__ import annotations

import logging
import re
import select
import socket
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests as http_requests
import urllib3

# Suppress warnings for verify=False calls
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


# =============================================================================
# PARSERS
# =============================================================================

def parse_outlet_status(response: str, outlet_count: int = 12) -> Dict[int, bool]:
    """Parse outlet status response: 'OutletStatus=1,0,1,...' -> {1: True, ...}."""
    states: Dict[int, bool] = {}
    if not response:
        return states
    for line in response.strip().split("\n"):
        line = line.strip()
        # Match both query response and push broadcast formats
        if "OutletStatus=" in line:
            data = line.split("OutletStatus=")[1].strip()
            for i, val in enumerate(data.split(","), start=1):
                val = val.strip()
                if val in ("0", "1"):
                    states[i] = val == "1"
    return states


def parse_outlet_name(response: str) -> Optional[Tuple[int, str]]:
    """Parse outlet name response: 'OutletName=3,X32 Mixer' -> (3, 'X32 Mixer')."""
    if not response:
        return None
    for line in response.strip().split("\n"):
        line = line.strip()
        if "OutletName=" in line:
            data = line.split("OutletName=")[1].strip()
            parts = data.split(",", 1)
            if len(parts) == 2:
                try:
                    return int(parts[0].strip()), parts[1].strip()
                except ValueError:
                    pass
    return None


def parse_simple_value(response: str, key: str) -> Optional[str]:
    """Parse a simple key=value response (e.g., 'Model=WB-800VPS-IPVM-12')."""
    if not response:
        return None
    for line in response.strip().split("\n"):
        line = line.strip()
        if f"{key}=" in line:
            return line.split(f"{key}=")[1].strip()
    return None


# =============================================================================
# WATTBOX CONNECTION (single PDU)
# =============================================================================

class WattBoxConnection:
    """Manages a persistent Telnet TCP connection to a single WattBox PDU.

    Uses raw sockets (not telnetlib — removed in Python 3.13).
    The WattBox speaks ASCII over TCP on port 23.

    Thread safety: the socket is shared between the command path (send_command)
    and the push listener (read_push_data). Callers must use an external lock
    (WattBoxDevice._connection_lock) to prevent concurrent access.
    """

    def __init__(self, ip: str, port: int, username: str, password: str,
                 logger: logging.Logger, read_timeout: float = 2.0) -> None:
        self._logger = logger
        self._ip = ip
        self._port = port
        self._username = username
        self._password = password
        self._read_timeout = read_timeout

        self._sock: Optional[socket.socket] = None
        self.connected: bool = False

    @property
    def ip(self) -> str:
        return self._ip

    def connect(self) -> bool:
        """Open TCP socket to WattBox and authenticate.

        Socket is kept in blocking mode with a timeout for reliable sendall().
        select() is used for non-blocking reads where needed.
        """
        self._close_socket()

        try:
            self._logger.info(f"WattBox [{self._ip}]: Connecting on port {self._port}")
            self._sock = socket.create_connection((self._ip, self._port), timeout=10)
            # Keep socket in blocking mode with a timeout — sendall() is reliable,
            # and we use select() for non-blocking reads where needed.
            self._sock.settimeout(5.0)

            # Wait for login prompt, then authenticate
            time.sleep(0.3)
            self._drain_buffer()  # Read and discard the login banner

            if self._username:
                self._sock.sendall(f"{self._username}\r\n".encode("ascii"))
                time.sleep(0.3)
                self._drain_buffer()  # Read username echo/prompt

            if self._password:
                self._sock.sendall(f"{self._password}\r\n".encode("ascii"))
                time.sleep(0.5)
                response = self._drain_buffer()

                # Check for auth failure indicators
                if response and ("denied" in response.lower() or
                                 "invalid" in response.lower() or
                                 "failed" in response.lower()):
                    self._logger.error(f"WattBox [{self._ip}]: Authentication failed")
                    self._close_socket()
                    return False

            self.connected = True
            self._logger.info(f"WattBox [{self._ip}]: Connected and authenticated")
            return True

        except Exception as e:
            self._logger.warning(f"WattBox [{self._ip}]: Connection failed: {e}")
            self.connected = False
            self._close_socket()
            return False

    def disconnect(self) -> None:
        """Graceful close."""
        self._close_socket()
        self.connected = False

    def _close_socket(self) -> None:
        """Forcibly close the underlying socket."""
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def _drain_buffer(self) -> str:
        """Read all available data from socket without blocking."""
        chunks = []
        deadline = time.time() + 1.0
        while time.time() < deadline:
            try:
                ready, _, _ = select.select([self._sock], [], [], 0.1)
                if ready:
                    chunk = self._sock.recv(4096).decode("ascii", errors="ignore")
                    if not chunk:
                        break
                    chunks.append(chunk)
                else:
                    if chunks:
                        break
            except Exception:
                break
        return "".join(chunks)

    def send_command(self, command: str) -> Optional[str]:
        """Send command and return response. Single attempt — no internal retry.

        IMPORTANT: Caller must hold WattBoxDevice._connection_lock to prevent
        the push listener from reading data meant for this command's response.

        Reconnection/retry logic lives in WattBoxDevice._send() so the failure
        streak counter stays accurate (one call = one attempt = one count).
        """
        if not self.connected or not self._sock:
            return None

        try:
            if not command.endswith("\r\n"):
                if command.endswith("\n"):
                    command = command[:-1] + "\r\n"
                else:
                    command += "\r\n"

            cmd_stripped = command.strip()
            self._logger.info(f"WattBox [{self._ip}]: Sending: {cmd_stripped}")
            self._sock.sendall(command.encode("ascii"))
            time.sleep(0.05)

            # Read response for query commands
            if cmd_stripped.startswith("?"):
                return self._read_response()

            # For set commands (! prefix), briefly check for error responses.
            if cmd_stripped.startswith("!"):
                try:
                    ready, _, _ = select.select([self._sock], [], [], 0.5)
                    if ready:
                        resp = self._sock.recv(4096).decode("ascii", errors="ignore").strip()
                        if resp and ("error" in resp.lower() or "denied" in resp.lower()):
                            self._logger.warning(
                                f"WattBox [{self._ip}]: Set command rejected: {resp}")
                            return None
                except Exception:
                    pass  # Non-fatal — command may have succeeded without response
            return "OK"

        except Exception as e:
            self._logger.error(f"WattBox [{self._ip}]: Command failed: {e}")
            self.connected = False
            self._close_socket()
            return None

    def _read_response(self) -> str:
        """Read TCP response with timeout."""
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
                        raise ConnectionError("WattBox: Remote closed connection")
                    chunks.append(chunk)
                    time.sleep(0.05)
                else:
                    if chunks:
                        break
            except (ConnectionError, OSError):
                raise
            except Exception as e:
                self._logger.debug(f"WattBox [{self._ip}]: read error: {e}")
                break
        return "".join(chunks)

    def read_push_data(self, timeout: float = 1.0) -> Optional[str]:
        """Non-blocking read for unsolicited push data from WattBox v2.2.

        Returns any data received within timeout, or None.
        """
        if not self.connected or not self._sock:
            return None
        try:
            ready, _, _ = select.select([self._sock], [], [], timeout)
            if ready:
                data = self._sock.recv(4096).decode("ascii", errors="ignore")
                if not data:
                    # Connection closed
                    self.connected = False
                    return None
                return data
            return None
        except Exception:
            self.connected = False
            return None


# =============================================================================
# WATTBOX DEVICE (one PDU: connection + state + reconnect)
# =============================================================================

class WattBoxDevice:
    """Manages a single WattBox PDU: connection, state cache, failure tracking."""

    def __init__(self, pdu_id: str, ip: str, port: int, username: str,
                 password: str, label: str, logger: logging.Logger) -> None:
        self._logger = logger
        self.pdu_id = pdu_id
        self.ip = ip
        self.label = label

        self._conn = WattBoxConnection(ip, port, username, password, logger)
        self._connection_lock = threading.Lock()

        # State (protected by _state_lock)
        self._state_lock = threading.Lock()
        self._outlet_states: Dict[int, bool] = {}
        self._outlet_names: Dict[int, str] = {}
        self._outlet_count: int = 12  # default, updated from device
        self._model: Optional[str] = None
        self._firmware: Optional[str] = None
        self._voltage: Optional[float] = None
        self._current: Optional[float] = None
        self._healthy: bool = False
        self._failure_streak: int = 0
        self._last_success: Optional[datetime] = None
        self._last_reboot: Optional[datetime] = None

    @property
    def connected(self) -> bool:
        return self._conn.connected

    # --- Thread-safe command send ---

    def _send(self, command: str) -> Optional[str]:
        """Thread-safe command send with one retry on failure."""
        with self._connection_lock:
            result = self._conn.send_command(command)

            # One retry: reconnect and try again
            if result is None:
                if self._conn.connect():
                    result = self._conn.send_command(command)

        if result:
            with self._state_lock:
                self._last_success = datetime.now()
                self._healthy = True
                self._failure_streak = 0
        else:
            with self._state_lock:
                self._healthy = False
                self._failure_streak += 1
                streak = self._failure_streak

            if streak == 1 or streak % 5 == 0:
                self._logger.warning(
                    f"WattBox [{self.ip}] ({self.pdu_id}): Failure streak: {streak}")

        return result

    # --- Outlet control ---
    #
    # These methods hold _connection_lock for the ENTIRE send+verify cycle.
    # This prevents the push listener thread from grabbing the lock in between,
    # which was causing 15s+ delays (lock contention × 3 acquires × read timeout).

    def outlet_on(self, outlet: int) -> bool:
        """Turn outlet on. Returns True if device confirms the state change."""
        return self._set_outlet(outlet, value=1, expected=True, label="ON")

    def outlet_off(self, outlet: int) -> bool:
        """Turn outlet off. Returns True if device confirms the state change."""
        return self._set_outlet(outlet, value=0, expected=False, label="OFF")

    def outlet_cycle(self, outlet: int) -> bool:
        """Power cycle outlet. Returns True if command was sent."""
        acquired = self._connection_lock.acquire(timeout=8)
        if not acquired:
            self._logger.warning(f"WattBox [{self.ip}]: Lock timeout for cycle outlet {outlet}")
            return False
        try:
            # Use text RESET action — firmware 2.x uses ON/OFF/RESET
            result = self._conn.send_command(f"!OutletSet={outlet},RESET")
            if result is None:
                if self._conn.connect():
                    result = self._conn.send_command(f"!OutletSet={outlet},RESET")
            if result is None:
                self._logger.warning(f"WattBox [{self.ip}]: Outlet {outlet} CYCLE failed to send")
                return False
            self._logger.info(f"WattBox [{self.ip}]: Outlet {outlet} CYCLE (sent)")
            # Brief pause then refresh states within the same lock hold
            time.sleep(0.5)
            resp = self._conn.send_command("?OutletStatus")
            if resp:
                states = parse_outlet_status(resp, self._outlet_count)
                if states:
                    with self._state_lock:
                        self._outlet_states = states
            return True
        finally:
            self._connection_lock.release()
            self._record_success() if result else self._record_failure()

    def _set_outlet(self, outlet: int, value: int, expected: bool, label: str) -> bool:
        """Send outlet set command and verify state — all under one lock hold.

        Holds _connection_lock for the entire operation (~2-3s) so the push
        listener thread cannot grab the socket between send and verify.
        """
        acquired = self._connection_lock.acquire(timeout=8)
        if not acquired:
            self._logger.warning(
                f"WattBox [{self.ip}]: Lock timeout for {label} outlet {outlet}")
            return False
        try:
            # Use text action values (ON/OFF) — firmware 2.x ignores numeric 0/1
            action_str = "ON" if value == 1 else "OFF"
            cmd = f"!OutletSet={outlet},{action_str}"
            result = self._conn.send_command(cmd)
            if result is None:
                if self._conn.connect():
                    result = self._conn.send_command(cmd)
            if result is None:
                self._logger.warning(
                    f"WattBox [{self.ip}]: Outlet {outlet} {label} failed to send")
                self._record_failure()
                return False

            self._logger.info(f"WattBox [{self.ip}]: Outlet {outlet} {label} (sent)")

            # Verify state — 2 attempts
            for attempt in range(2):
                delay = 0.3 * (attempt + 1)  # 0.3s, 0.6s
                time.sleep(delay)
                resp = self._conn.send_command("?OutletStatus")
                if resp:
                    states = parse_outlet_status(resp, self._outlet_count)
                    if states:
                        with self._state_lock:
                            self._outlet_states = states
                        actual = states.get(outlet)
                        if actual == expected:
                            self._logger.info(
                                f"WattBox [{self.ip}]: Outlet {outlet} verified "
                                f"{label} (attempt {attempt + 1})")
                            self._record_success()
                            return True
                        self._logger.info(
                            f"WattBox [{self.ip}]: Outlet {outlet} verify attempt "
                            f"{attempt + 1}: expected={label}, got={'ON' if actual else 'OFF'}")

            self._logger.warning(
                f"WattBox [{self.ip}]: Outlet {outlet} did NOT change to {label} after 2 checks")
            self._record_success()  # command sent OK, just didn't verify
            return False
        finally:
            self._connection_lock.release()

    def _record_success(self):
        with self._state_lock:
            self._last_success = datetime.now()
            self._healthy = True
            self._failure_streak = 0

    def _record_failure(self):
        with self._state_lock:
            self._healthy = False
            self._failure_streak += 1
            streak = self._failure_streak
        if streak == 1 or streak % 5 == 0:
            self._logger.warning(
                f"WattBox [{self.ip}] ({self.pdu_id}): Failure streak: {streak}")

    # --- State queries ---

    def refresh_outlet_states(self) -> Dict[int, bool]:
        """Query current outlet states from device."""
        response = self._send("?OutletStatus")
        if response:
            states = parse_outlet_status(response, self._outlet_count)
            if states:
                with self._state_lock:
                    self._outlet_states = states
                return states
        with self._state_lock:
            return dict(self._outlet_states)

    def refresh_outlet_names(self) -> Dict[int, str]:
        """Query outlet names from device."""
        names: Dict[int, str] = {}
        for i in range(1, self._outlet_count + 1):
            response = self._send(f"?OutletName={i}")
            if response:
                parsed = parse_outlet_name(response)
                if parsed:
                    names[parsed[0]] = parsed[1]
            time.sleep(0.05)  # Don't flood
        if names:
            with self._state_lock:
                self._outlet_names = names
        return names

    def refresh_device_info(self) -> None:
        """Query model, firmware, outlet count from device."""
        resp = self._send("?Model")
        if resp:
            val = parse_simple_value(resp, "Model")
            if val:
                with self._state_lock:
                    self._model = val

        resp = self._send("?Firmware")
        if resp:
            val = parse_simple_value(resp, "Firmware")
            if val:
                with self._state_lock:
                    self._firmware = val

        resp = self._send("?OutletCount")
        if resp:
            val = parse_simple_value(resp, "OutletCount")
            if val:
                try:
                    with self._state_lock:
                        self._outlet_count = int(val)
                except ValueError:
                    pass

    def refresh_power_info(self) -> None:
        """Query voltage and current from device."""
        resp = self._send("?Voltage")
        if resp:
            val = parse_simple_value(resp, "Voltage")
            if val:
                try:
                    with self._state_lock:
                        self._voltage = int(val) / 10.0
                except ValueError:
                    pass

        resp = self._send("?Current")
        if resp:
            val = parse_simple_value(resp, "Current")
            if val:
                try:
                    with self._state_lock:
                        self._current = int(val) / 10.0
                except ValueError:
                    pass

    def update_from_push(self, data: str) -> bool:
        """Process push data from the WattBox. Returns True if state changed."""
        if "OutletStatus=" in data:
            states = parse_outlet_status(data, self._outlet_count)
            if states:
                with self._state_lock:
                    changed = states != self._outlet_states
                    self._outlet_states = states
                    self._healthy = True
                    self._last_success = datetime.now()
                return changed
        return False

    # --- Status ---

    def get_outlet_state(self, outlet: int) -> Optional[bool]:
        """Get cached outlet state."""
        with self._state_lock:
            return self._outlet_states.get(outlet)

    def get_all_states(self) -> dict:
        """Get full device state dict for API/UI."""
        with self._state_lock:
            return {
                "pdu_id": self.pdu_id,
                "ip": self.ip,
                "label": self.label,
                "connected": self._conn.connected,
                "healthy": self._healthy,
                "model": self._model,
                "firmware": self._firmware,
                "voltage": self._voltage,
                "current": self._current,
                "outlet_count": self._outlet_count,
                "outlets": {
                    num: {
                        "state": "on" if on else "off",
                        "name": self._outlet_names.get(num, f"Outlet {num}"),
                        "stable_id": f"{self.pdu_id}.outlet_{num}",
                    }
                    for num, on in sorted(self._outlet_states.items())
                },
            }

    def get_health(self) -> dict:
        """Return health/connection status dict."""
        with self._state_lock:
            healthy = self._healthy
            streak = self._failure_streak
            last_cmd = self._last_success
            last_reboot = self._last_reboot

        uptime = None
        if last_cmd:
            uptime = round((datetime.now() - last_cmd).total_seconds(), 2)

        reboot_ago = None
        if last_reboot:
            reboot_ago = round((datetime.now() - last_reboot).total_seconds(), 2)

        return {
            "pdu_id": self.pdu_id,
            "ip": self.ip,
            "label": self.label,
            "healthy": healthy,
            "connected": self._conn.connected,
            "last_command_seconds_ago": uptime,
            "failure_streak": streak,
            "last_reboot_seconds_ago": reboot_ago,
        }

    def initial_connect(self) -> bool:
        """Connect and load initial state from device."""
        with self._connection_lock:
            ok = self._conn.connect()
        if ok:
            self.refresh_device_info()
            self.refresh_outlet_states()
            self.refresh_outlet_names()
            self.refresh_power_info()
            with self._state_lock:
                self._healthy = True
                self._last_success = datetime.now()
        return ok


# =============================================================================
# WATTBOX MODULE (gateway-facing interface for all PDUs)
# =============================================================================

class WattBoxModule:
    """Gateway-facing interface managing all WattBox PDUs.

    Usage:
        wattbox = WattBoxModule(cfg, logger, socketio)
        wattbox.start()
        # Then call wattbox.outlet_on("wb_008_av_audiorack2.outlet_3"), etc.
    """

    def __init__(self, cfg: dict, logger: logging.Logger,
                 socketio=None) -> None:
        self._logger = logger
        self._cfg = cfg
        self._socketio = socketio

        # Connection settings
        username = cfg.get("username", "admin")
        password = cfg.get("password", "")
        port = cfg.get("port", 23)

        # Thresholds
        self._keepalive_normal = cfg.get("keepalive_interval_normal", 60)
        self._keepalive_max = cfg.get("keepalive_interval_max", 300)
        self._failure_threshold = cfg.get("failure_threshold", 5)
        self._reboot_cooldown_minutes = cfg.get("reboot_cooldown_minutes", 15)

        # Build devices — one WattBoxDevice per unique PDU
        self._devices: Dict[str, WattBoxDevice] = {}  # pdu_id -> device
        pdus = cfg.get("pdus", {})
        for pdu_id, pdu_cfg in pdus.items():
            ip = pdu_cfg.get("ip", "")
            label = pdu_cfg.get("label", pdu_id)
            if not ip:
                logger.warning(f"WattBox PDU '{pdu_id}' has no IP — skipping")
                continue
            self._devices[pdu_id] = WattBoxDevice(
                pdu_id=pdu_id,
                ip=ip,
                port=port,
                username=username,
                password=password,
                label=label,
                logger=logger,
            )

        # Background threads
        self._stop = threading.Event()
        self._keepalive_thread: Optional[threading.Thread] = None
        self._listener_threads: Dict[str, threading.Thread] = {}

    def start(self) -> None:
        """Connect to all PDUs and start background threads."""
        self._logger.info(f"WattBox module starting: {len(self._devices)} PDUs configured")

        for pdu_id, device in self._devices.items():
            self._logger.info(f"  WattBox [{pdu_id}]: {device.ip} — {device.label}")

        # Connect to all PDUs (in parallel using threads)
        connect_threads = []
        for pdu_id, device in self._devices.items():
            t = threading.Thread(target=device.initial_connect, daemon=True)
            t.start()
            connect_threads.append((pdu_id, t))

        for pdu_id, t in connect_threads:
            t.join(timeout=15)
            device = self._devices[pdu_id]
            if device.connected:
                self._logger.info(f"  WattBox [{pdu_id}]: Connected OK")
            else:
                self._logger.warning(f"  WattBox [{pdu_id}]: Connection failed (will retry via keepalive)")

        # Start push listener threads (one per device)
        for pdu_id, device in self._devices.items():
            t = threading.Thread(
                target=self._listener_loop, args=(device,),
                daemon=True, name=f"wb-listener-{pdu_id}"
            )
            t.start()
            self._listener_threads[pdu_id] = t

        # Start keepalive thread
        self._keepalive_thread = threading.Thread(
            target=self._keepalive_loop, daemon=True, name="wb-keepalive"
        )
        self._keepalive_thread.start()

        self._logger.info("WattBox module started")

    def stop(self) -> None:
        """Stop all background threads and disconnect."""
        self._stop.set()
        for device in self._devices.values():
            device._conn.disconnect()
        self._logger.info("WattBox module stopped")

    # --- Stable ID resolution ---

    def _resolve_device(self, stable_id: str) -> Optional[Tuple[WattBoxDevice, int]]:
        """Resolve a stable ID like 'wb_008_av_audiorack2.outlet_3' to (device, outlet_num).

        Also accepts legacy config keys like 'x32_mixer' from the devices: section.
        """
        # Format: pdu_id.outlet_N
        if ".outlet_" in stable_id:
            parts = stable_id.rsplit(".outlet_", 1)
            if len(parts) == 2:
                pdu_id = parts[0]
                try:
                    outlet = int(parts[1])
                except ValueError:
                    return None
                device = self._devices.get(pdu_id)
                if device:
                    return device, outlet

        # Legacy: look up in devices: section of config
        legacy_devices = self._cfg.get("devices", {})
        dev_cfg = legacy_devices.get(stable_id)
        if dev_cfg:
            ip = dev_cfg.get("ip", "")
            outlet = dev_cfg.get("outlet", 0)
            # Find device by IP
            for device in self._devices.values():
                if device.ip == ip:
                    return device, outlet

        return None

    # --- Public API (by stable ID) ---

    def outlet_on(self, stable_id: str) -> Tuple[dict, int]:
        """Turn outlet on by stable ID. Verifies state change before returning."""
        resolved = self._resolve_device(stable_id)
        if not resolved:
            return {"error": f"Unknown device: {stable_id}"}, 404
        device, outlet = resolved
        success = device.outlet_on(outlet)
        self._broadcast_state(device)
        if success:
            return {"success": True, "device": stable_id, "action": "on", "verified": True}, 200
        return {"error": f"Command sent but outlet did not change: {stable_id}"}, 503

    def outlet_off(self, stable_id: str) -> Tuple[dict, int]:
        """Turn outlet off by stable ID. Verifies state change before returning."""
        resolved = self._resolve_device(stable_id)
        if not resolved:
            return {"error": f"Unknown device: {stable_id}"}, 404
        device, outlet = resolved
        success = device.outlet_off(outlet)
        self._broadcast_state(device)
        if success:
            return {"success": True, "device": stable_id, "action": "off", "verified": True}, 200
        return {"error": f"Command sent but outlet did not change: {stable_id}"}, 503

    def outlet_cycle(self, stable_id: str) -> Tuple[dict, int]:
        """Power cycle outlet by stable ID."""
        resolved = self._resolve_device(stable_id)
        if not resolved:
            return {"error": f"Unknown device: {stable_id}"}, 404
        device, outlet = resolved
        success = device.outlet_cycle(outlet)
        self._broadcast_state(device)
        if success:
            return {"success": True, "device": stable_id, "action": "cycle", "verified": True}, 200
        return {"error": f"Command sent but state unclear: {stable_id}"}, 503

    def get_outlet_state(self, stable_id: str) -> Tuple[dict, int]:
        """Get single outlet state by stable ID."""
        resolved = self._resolve_device(stable_id)
        if not resolved:
            return {"error": f"Unknown device: {stable_id}"}, 404
        device, outlet = resolved
        state = device.get_outlet_state(outlet)
        with device._state_lock:
            name = device._outlet_names.get(outlet, f"Outlet {outlet}")
        return {
            "device": stable_id,
            "outlet": outlet,
            "state": "on" if state else ("off" if state is not None else "unknown"),
            "name": name,
            "pdu_id": device.pdu_id,
            "pdu_label": device.label,
        }, 200

    # --- Bulk APIs ---

    def get_all_devices(self) -> Tuple[dict, int]:
        """Get all PDU states. Used by UI device browser."""
        result = {}
        for pdu_id, device in self._devices.items():
            result[pdu_id] = device.get_all_states()
        return result, 200

    def get_health(self) -> dict:
        """Get module-level health for health dashboard."""
        pdu_health = {}
        all_healthy = True
        any_connected = False
        for pdu_id, device in self._devices.items():
            h = device.get_health()
            pdu_health[pdu_id] = h
            if not h["healthy"]:
                all_healthy = False
            if h["connected"]:
                any_connected = True

        return {
            "healthy": all_healthy and any_connected,
            "pdus_total": len(self._devices),
            "pdus_connected": sum(1 for d in self._devices.values() if d.connected),
            "pdus": pdu_health,
        }

    # --- PDU-level operations ---

    def reboot_pdu(self, pdu_id: str) -> Tuple[dict, int]:
        """Reboot a WattBox PDU's firmware (network restart, outlets keep power).

        Tries Telnet !Reset first (firmware 2.x), then HTTP /reboot.cgi as fallback.
        """
        device = self._devices.get(pdu_id)
        if not device:
            return {"error": f"Unknown PDU: {pdu_id}"}, 404

        # --- Method 1: Telnet !Reset (preferred for firmware 2.x) ---
        if device.connected:
            result = device._send("!Reset")
            if result is not None:
                self._logger.warning(
                    f"WattBox [{pdu_id}]: Firmware reboot triggered via Telnet !Reset "
                    f"(outlets remain powered)")
                with device._state_lock:
                    device._last_reboot = datetime.now()
                    device._failure_streak = 0
                return {"success": True, "pdu_id": pdu_id, "action": "reboot",
                        "method": "telnet"}, 200

        # --- Method 2: HTTP fallback (if Telnet is down) ---
        username = self._cfg.get("username", "admin")
        password = self._cfg.get("password", "")
        timeout = self._cfg.get("timeout", 10)

        try:
            resp = http_requests.get(
                f"http://{device.ip}/reboot.cgi",
                auth=(username, password),
                timeout=timeout,
            )
            if resp.status_code in (200, 302):
                self._logger.warning(
                    f"WattBox [{pdu_id}]: Firmware reboot triggered via HTTP "
                    f"(outlets remain powered)")
                with device._state_lock:
                    device._last_reboot = datetime.now()
                    device._failure_streak = 0
                return {"success": True, "pdu_id": pdu_id, "action": "reboot",
                        "method": "http"}, 200

            self._logger.warning(
                f"WattBox [{pdu_id}]: Reboot returned HTTP {resp.status_code}")
            return {"error": f"Reboot returned HTTP {resp.status_code}"}, 502

        except Exception as e:
            self._logger.error(f"WattBox [{pdu_id}]: Reboot failed: {e}")
            return {"error": f"Reboot failed: {e}"}, 503

    def reset_watchdog(self, pdu_id: str) -> Tuple[dict, int]:
        """Manually reset failure streak for a PDU."""
        device = self._devices.get(pdu_id)
        if not device:
            return {"error": f"Unknown PDU: {pdu_id}"}, 404
        with device._state_lock:
            old = device._failure_streak
            device._failure_streak = 0
        self._logger.info(f"WattBox [{pdu_id}]: Watchdog manually reset (was {old})")
        return {"success": True, "previous_streak": old, "current_streak": 0}, 200

    # --- Background threads ---

    def _listener_loop(self, device: WattBoxDevice) -> None:
        """Listen for push state change broadcasts from a single WattBox.

        WattBox v2.2 sends unsolicited '~OutletStatus=1,0,1,...' when any
        outlet changes state (from any source — UI, API, schedule, auto-reboot).

        IMPORTANT: Acquires the device's _connection_lock before reading, so
        command threads (send_command) have exclusive socket access during
        their send-then-read sequences.
        """
        self._logger.info(f"WattBox [{device.pdu_id}]: Push listener started")
        while not self._stop.is_set():
            if not device.connected:
                self._stop.wait(timeout=2)
                continue

            try:
                # Acquire lock so we don't read data meant for a command response.
                # Use a short timeout so we don't starve command threads.
                acquired = device._connection_lock.acquire(timeout=0.5)
                if not acquired:
                    # Command thread holds the lock — yield and retry
                    self._stop.wait(timeout=0.1)
                    continue
                try:
                    data = device._conn.read_push_data(timeout=1.0)
                finally:
                    device._connection_lock.release()

                if data:
                    changed = device.update_from_push(data)
                    if changed:
                        self._logger.debug(
                            f"WattBox [{device.pdu_id}]: Push state update received")
                        self._broadcast_state(device)

                # Yield time between lock cycles so command threads can acquire
                # the lock. Without this gap, the push listener re-acquires
                # immediately and starves outlet set/verify operations.
                self._stop.wait(timeout=0.2)
            except Exception as e:
                self._logger.debug(
                    f"WattBox [{device.pdu_id}]: Listener error: {e}")
                self._stop.wait(timeout=1)

    def _keepalive_loop(self) -> None:
        """Periodically check all PDU connections with exponential backoff.

        This is the ONLY thread that should attempt reconnection when offline.
        """
        self._logger.info("WattBox keepalive thread started")
        intervals: Dict[str, float] = {
            pdu_id: self._keepalive_normal for pdu_id in self._devices
        }
        consecutive_failures: Dict[str, int] = {
            pdu_id: 0 for pdu_id in self._devices
        }
        last_check: Dict[str, float] = {
            pdu_id: 0.0 for pdu_id in self._devices
        }

        while not self._stop.is_set():
            self._stop.wait(timeout=5)  # Check every 5s which devices need attention
            if self._stop.is_set():
                break

            now = time.time()
            for pdu_id, device in self._devices.items():
                if now - last_check[pdu_id] < intervals[pdu_id]:
                    continue

                last_check[pdu_id] = now

                # Try a lightweight query
                response = device._send("?OutletStatus")
                if response:
                    states = parse_outlet_status(response, device._outlet_count)
                    if states:
                        with device._state_lock:
                            old_states = dict(device._outlet_states)
                            device._outlet_states = states
                        if states != old_states:
                            self._broadcast_state(device)

                    intervals[pdu_id] = self._keepalive_normal
                    consecutive_failures[pdu_id] = 0

                    # Periodically refresh names and power info (every 10 cycles)
                    cycle_count = int(now / self._keepalive_normal) % 10
                    if cycle_count == 0:
                        device.refresh_outlet_names()
                        device.refresh_power_info()
                else:
                    consecutive_failures[pdu_id] += 1
                    failures = consecutive_failures[pdu_id]
                    intervals[pdu_id] = min(
                        self._keepalive_normal * (2 ** failures),
                        self._keepalive_max,
                    )
                    self._logger.warning(
                        f"WattBox [{pdu_id}]: Keepalive failed "
                        f"(failures={failures}), next in {intervals[pdu_id]}s")

                    # Watchdog: trigger reboot after threshold
                    if failures >= self._failure_threshold:
                        self._logger.critical(
                            f"WattBox [{pdu_id}]: FAILURE THRESHOLD REACHED "
                            f"({self._failure_threshold}) — triggering reboot")
                        self._trigger_pdu_reboot(pdu_id, device)
                        consecutive_failures[pdu_id] = 0
                        intervals[pdu_id] = self._keepalive_normal

    def _trigger_pdu_reboot(self, pdu_id: str, device: WattBoxDevice) -> None:
        """Watchdog-triggered reboot of a WattBox PDU."""
        # Check cooldown
        with device._state_lock:
            last_reboot = device._last_reboot
        if last_reboot:
            minutes_since = (datetime.now() - last_reboot).total_seconds() / 60
            if minutes_since < self._reboot_cooldown_minutes:
                self._logger.warning(
                    f"WattBox [{pdu_id}]: Reboot blocked by cooldown "
                    f"({self._reboot_cooldown_minutes - minutes_since:.1f} min remaining)")
                return

        result, status = self.reboot_pdu(pdu_id)
        if status == 200:
            self._logger.info(f"WattBox [{pdu_id}]: Watchdog reboot triggered successfully")
        else:
            self._logger.error(
                f"WattBox [{pdu_id}]: Watchdog reboot failed: {result}")

    def _broadcast_state(self, device: WattBoxDevice) -> None:
        """Broadcast device state to all tablets via Socket.IO."""
        if self._socketio:
            try:
                self._socketio.emit(
                    "state:wattbox",
                    {device.pdu_id: device.get_all_states()},
                    room="wattbox",
                )
            except Exception as e:
                self._logger.debug(f"WattBox state broadcast failed: {e}")
