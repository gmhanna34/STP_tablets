"""
OBS Module — Direct WebSocket communication with OBS Studio.

Absorbed from STP_scripts/obs-flask.py (Phase 3 of the consolidation plan).
Replaces the standalone Flask+Waitress middleware that ran on port 4456.

Key design:
- Uses websocket-client (sync) instead of simpleobsws (async) to avoid
  eventlet/asyncio cross-thread conflicts. All I/O goes through eventlet's
  patched socket module, running in green threads natively.
- Background poller: PING (GetVersion) determines online/offline with
  fail-streak gating, SNAPSHOT collects streaming/recording/scene/stats.
- All public methods return plain dicts suitable for jsonify().
- Thread-safe via eventlet-patched threading.Lock (green-thread-safe).
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import logging
import socket
import threading
import time
import uuid
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

import websocket


# =============================================================================
# OBS WEBSOCKET V5 PROTOCOL
# =============================================================================
#
# Op codes:
#   0 = Hello (server → client, includes auth challenge)
#   1 = Identify (client → server, includes auth + rpcVersion)
#   2 = Identified (server → client, handshake complete)
#   5 = Event (server → client, unsolicited)
#   6 = Request (client → server)
#   7 = RequestResponse (server → client)

_OP_HELLO = 0
_OP_IDENTIFY = 1
_OP_IDENTIFIED = 2
_OP_REQUEST = 6
_OP_REQUEST_RESPONSE = 7


def _make_auth(password: str, salt: str, challenge: str) -> str:
    """OBS WebSocket v5 authentication."""
    secret = base64.b64encode(
        hashlib.sha256((password + salt).encode("utf-8")).digest()
    ).decode("utf-8")
    auth = base64.b64encode(
        hashlib.sha256((secret + challenge).encode("utf-8")).digest()
    ).decode("utf-8")
    return auth


# =============================================================================
# OBS MODULE
# =============================================================================

class OBSModule:
    """Direct OBS WebSocket client with background polling.

    Replaces obs-flask.py middleware — the gateway connects directly to OBS
    Studio via WebSocket instead of proxying through HTTP on port 4456.

    Uses websocket-client (synchronous) so all I/O goes through eventlet's
    green-thread-safe patched sockets. No real OS threads or asyncio needed.
    """

    @staticmethod
    def _resolve_ws_url(cfg: dict, logger: logging.Logger,
                        probe_timeout: float = 1.5) -> str:
        """Pick OBS WebSocket URL by probing local first, then remote.

        If config has ws_url_local and ws_url_remote, does a quick TCP connect
        to the local address. If it responds, use it; otherwise fall back to
        remote. This runs once at startup so both machines can share identical
        config. If neither key exists, falls back to legacy ws_url.
        """
        local = cfg.get("ws_url_local", "")
        remote = cfg.get("ws_url_remote", "")

        # Legacy single-URL config — no probing needed
        if not local and not remote:
            return cfg.get("ws_url", "ws://127.0.0.1:4455")

        # If only one is configured, use it directly
        if local and not remote:
            return local
        if remote and not local:
            return remote

        # Both configured — probe local
        try:
            parsed = urlparse(local)
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or 4455
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(probe_timeout)
            sock.connect((host, port))
            sock.close()
            logger.info(f"OBS: Local probe succeeded ({host}:{port}) — using {local}")
            return local
        except (OSError, socket.timeout):
            logger.info(f"OBS: Local probe failed — using remote {remote}")
            return remote

    def __init__(self, cfg: dict, logger: logging.Logger) -> None:
        self._cfg = cfg
        self._logger = logger

        self._ws_url = self._resolve_ws_url(cfg, logger)
        self._ws_password = cfg.get("ws_password", "") or ""

        # Poll tuning
        self._ping_seconds = float(cfg.get("ping_seconds", 3.0))
        self._snapshot_seconds = float(cfg.get("snapshot_seconds", 6.0))
        self._offline_after_seconds = float(cfg.get("offline_after_seconds", 10.0))
        self._ping_fails_to_offline = int(cfg.get("ping_fails_to_offline", 3))

        # WebSocket connection (protected by _lock)
        self._lock = threading.Lock()  # eventlet-patched = green-thread-safe
        self._ws: Optional[websocket.WebSocket] = None
        self._connected: bool = False

        # State (written by poller, read by Flask handlers)
        self._online: bool = False
        self._last_ok_ts: float = 0.0
        self._last_error: str = ""
        self._ping_fail_streak: int = 0
        self._snapshot: Optional[Dict[str, Any]] = None
        self._snapshot_ts: float = 0.0

        # Reconnect backoff (exponential when OBS is offline)
        self._reconnect_delay = self._ping_seconds
        self._reconnect_delay_max = float(cfg.get("reconnect_delay_max", 60.0))

        # Thread control (eventlet green thread via patched threading)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    # --- Lifecycle ---

    def start(self) -> None:
        self._logger.info(
            f"OBS module starting: {self._ws_url} "
            f"(ping={self._ping_seconds}s, snapshot={self._snapshot_seconds}s)"
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._disconnect()

    # --- Connection management ---

    def _do_connect(self) -> bool:
        """Connect and perform OBS WebSocket v5 handshake. Must hold _lock."""
        try:
            ws = websocket.WebSocket()
            ws.connect(self._ws_url, timeout=10)

            # Receive Hello (op 0)
            hello_raw = ws.recv()
            hello = json.loads(hello_raw)
            if hello.get("op") != _OP_HELLO:
                ws.close()
                raise RuntimeError(f"Expected Hello (op 0), got op {hello.get('op')}")

            # Build Identify (op 1)
            identify_d: Dict[str, Any] = {"rpcVersion": 1}
            auth_info = hello.get("d", {}).get("authentication")
            if auth_info and self._ws_password:
                identify_d["authentication"] = _make_auth(
                    self._ws_password,
                    auth_info["salt"],
                    auth_info["challenge"],
                )

            ws.send(json.dumps({"op": _OP_IDENTIFY, "d": identify_d}))

            # Receive Identified (op 2)
            ws.settimeout(10)
            id_raw = ws.recv()
            identified = json.loads(id_raw)
            if identified.get("op") != _OP_IDENTIFIED:
                ws.close()
                raise RuntimeError(
                    f"Expected Identified (op 2), got op {identified.get('op')}"
                )

            self._ws = ws
            self._connected = True
            self._logger.info(f"OBS: Connected to {self._ws_url}")
            return True

        except Exception as e:
            self._logger.warning(f"OBS: Connect failed: {e}")
            self._ws = None
            self._connected = False
            return False

    def _ensure_connected(self) -> bool:
        """Ensure WebSocket is connected. Must hold _lock."""
        if self._connected and self._ws:
            return True
        return self._do_connect()

    def _disconnect(self) -> None:
        """Close WebSocket connection."""
        ws = self._ws
        self._ws = None
        self._connected = False
        if ws:
            try:
                ws.close()
            except Exception as e:
                self._logger.debug(f"OBS: WebSocket close failed: {e}")

    # --- Raw OBS request/response ---

    def _send_request(self, request_type: str,
                      request_data: dict = None) -> str:
        """Send an OBS request and return the requestId. Must hold _lock."""
        req_id = str(uuid.uuid4())
        msg: Dict[str, Any] = {
            "op": _OP_REQUEST,
            "d": {
                "requestType": request_type,
                "requestId": req_id,
            },
        }
        if request_data:
            msg["d"]["requestData"] = request_data
        self._ws.send(json.dumps(msg))
        return req_id

    def _recv_response(self, req_id: str, timeout: float = 10.0) -> dict:
        """Read messages until we get the matching RequestResponse. Must hold _lock."""
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError("OBS request timed out")
            self._ws.settimeout(max(0.1, remaining))
            raw = self._ws.recv()
            msg = json.loads(raw)
            # Skip events (op 5) and non-matching responses
            if (msg.get("op") == _OP_REQUEST_RESPONSE
                    and msg.get("d", {}).get("requestId") == req_id):
                return msg["d"]

    # --- Public request methods (called from Flask/eventlet green threads) ---

    def call(self, request_type: str, request_data: dict = None,
             timeout: float = 10.0) -> Tuple[Optional[dict], Optional[str]]:
        """Execute OBS request and return (response_dict, error_string).

        response_dict matches obs-websocket-http JSON format for backward compat.
        """
        if not self._online or not self._connected:
            return None, "obs-websocket is not connected."
        with self._lock:
            if not self._ws:
                return None, "obs-websocket is not connected."
            try:
                req_id = self._send_request(request_type, request_data)
                resp_d = self._recv_response(req_id, timeout)
                ret = {
                    "requestType": resp_d.get("requestType", request_type),
                    "requestStatus": resp_d.get("requestStatus", {}),
                }
                if resp_d.get("responseData"):
                    ret["responseData"] = resp_d["responseData"]
                return ret, None
            except TimeoutError:
                return None, "The obs-websocket request timed out."
            except Exception as e:
                self._online = False
                self._last_error = str(e)
                self._disconnect()
                return None, str(e)

    def emit(self, request_type: str,
             request_data: dict = None) -> Optional[str]:
        """Fire-and-forget OBS request. Returns error string or None on success."""
        if not self._online or not self._connected:
            return "obs-websocket is not connected."
        with self._lock:
            if not self._ws:
                return "obs-websocket is not connected."
            try:
                # Send and immediately read response (to keep socket clean)
                req_id = self._send_request(request_type, request_data)
                self._recv_response(req_id, timeout=5)
                return None
            except Exception as e:
                return str(e)

    # --- Status / snapshot (called from Flask/eventlet green threads) ---

    def get_status(self) -> Tuple[dict, int]:
        """Return health/status dict for /api/obs/status. Returns (dict, http_status)."""
        online = self._online
        error = self._last_error
        age_ok = (
            round(time.time() - self._last_ok_ts, 2)
            if self._last_ok_ts else None
        )
        snap = self._snapshot

        status_code = 200 if online else 503
        return {
            "healthy": online,
            "age_seconds": age_ok,
            "data": snap if isinstance(snap, dict) else None,
            "error": error or "",
        }, status_code

    def get_snapshot(self) -> Optional[dict]:
        """Return cached snapshot for the polling loop. None if offline."""
        with self._lock:
            if not self._online:
                return None
            return copy.deepcopy(self._snapshot)

    # --- Poll internals ---

    def _obs_call_internal(self, request_type: str,
                           timeout: float = 5.0) -> dict:
        """Internal call used by poller. Must hold _lock. Returns response data dict."""
        req_id = self._send_request(request_type)
        resp_d = self._recv_response(req_id, timeout)
        status = resp_d.get("requestStatus", {})
        if not status.get("result"):
            raise RuntimeError(
                f"{request_type} failed: code={status.get('code')}"
            )
        return resp_d.get("responseData") or {}

    def _ping(self) -> None:
        """Ping OBS with GetVersion. Must hold _lock."""
        self._obs_call_internal("GetVersion")

    def _build_snapshot(self) -> Dict[str, Any]:
        """Collect all snapshot data. Must hold _lock."""
        snap: Dict[str, Any] = {}

        # Stream status
        try:
            data = self._obs_call_internal("GetStreamStatus")
            snap["streaming"] = data.get("outputActive", False)
            snap["stream_timecode"] = data.get("outputTimecode", "")
            snap["stream_bytes"] = data.get("outputBytes", 0)
            snap["stream_reconnecting"] = data.get("outputReconnecting", False)
        except Exception as e:
            snap["streaming"] = None
            self._logger.debug(f"OBS: GetStreamStatus failed: {e}")

        # Record status
        try:
            data = self._obs_call_internal("GetRecordStatus")
            snap["recording"] = data.get("outputActive", False)
            snap["record_timecode"] = data.get("outputTimecode", "")
            snap["record_paused"] = data.get("outputPaused", False)
        except Exception as e:
            snap["recording"] = None
            self._logger.debug(f"OBS: GetRecordStatus failed: {e}")

        # Current program scene
        try:
            data = self._obs_call_internal("GetCurrentProgramScene")
            snap["current_scene"] = data.get("currentProgramSceneName", "")
        except Exception as e:
            snap["current_scene"] = None
            self._logger.debug(f"OBS: GetCurrentProgramScene failed: {e}")

        # Scene list
        try:
            data = self._obs_call_internal("GetSceneList")
            scenes = data.get("scenes", [])
            snap["scenes"] = [s.get("sceneName", "") for s in scenes]
            snap["scene_count"] = len(scenes)
        except Exception as e:
            snap["scenes"] = []
            snap["scene_count"] = 0
            self._logger.debug(f"OBS: GetSceneList failed: {e}")

        # OBS stats (CPU, memory, FPS, frame drops)
        try:
            data = self._obs_call_internal("GetStats")
            snap["cpu_usage"] = data.get("cpuUsage", 0)
            snap["memory_usage"] = data.get("memoryUsage", 0)
            snap["active_fps"] = data.get("activeFps", 0)
            snap["render_skipped_frames"] = data.get("renderSkippedFrames", 0)
            snap["render_total_frames"] = data.get("renderTotalFrames", 0)
            snap["output_skipped_frames"] = data.get("outputSkippedFrames", 0)
            snap["output_total_frames"] = data.get("outputTotalFrames", 0)
        except Exception as e:
            self._logger.debug(f"OBS: GetStats failed: {e}")

        return snap

    # --- Poller loop (runs in eventlet green thread) ---

    def _run(self) -> None:
        self._logger.info("OBS: Poller thread started")
        time.sleep(0.5)

        last_snapshot_attempt = 0.0
        last_warn_log = 0.0

        while not self._stop.is_set():
            start = time.time()

            # 1) PING determines online/offline
            with self._lock:
                try:
                    if not self._ensure_connected():
                        raise RuntimeError("Cannot connect to OBS")
                    self._ping()

                    self._ping_fail_streak = 0
                    self._online = True
                    self._last_ok_ts = time.time()
                    self._last_error = ""
                    self._reconnect_delay = self._ping_seconds  # reset backoff
                except Exception as e:
                    self._ping_fail_streak += 1
                    self._last_error = (
                        f"ping failed ({self._ping_fail_streak}): {e}"
                    )

                    if (self._ping_fail_streak == 1
                            or self._ping_fail_streak % 5 == 0):
                        self._logger.warning(f"OBS: {self._last_error}")

                    if self._ping_fail_streak >= self._ping_fails_to_offline:
                        self._online = False
                        self._disconnect()
                        # Exponential backoff on reconnect attempts
                        self._reconnect_delay = min(
                            self._reconnect_delay * 2,
                            self._reconnect_delay_max,
                        )

            # Belt-and-suspenders offline threshold
            if (self._last_ok_ts
                    and (time.time() - self._last_ok_ts)
                    > self._offline_after_seconds):
                self._online = False

            # 2) SNAPSHOT refresh (only if online and due)
            now = time.time()
            if now - last_snapshot_attempt >= self._snapshot_seconds:
                last_snapshot_attempt = now

                if self._online and self._connected:
                    with self._lock:
                        try:
                            snap = self._build_snapshot()
                            self._snapshot = snap
                            self._snapshot_ts = time.time()
                        except Exception as e:
                            self._last_error = f"snapshot failed: {e}"
                            if now - last_warn_log >= 10.0:
                                last_warn_log = now
                                self._logger.warning(
                                    f"OBS: {self._last_error}"
                                )

            # Sleep until next ping cadence (uses backoff delay when offline)
            elapsed = time.time() - start
            cadence = self._reconnect_delay if not self._online else self._ping_seconds
            sleep_for = max(0.2, cadence - elapsed)
            self._stop.wait(timeout=sleep_for)
