"""
OBS Module — Direct WebSocket communication with OBS Studio.

Absorbed from STP_scripts/obs-flask.py (Phase 3 of the consolidation plan).
Replaces the standalone Flask+Waitress middleware that ran on port 4456.

Key design:
- Uses simpleobsws (async) with a dedicated asyncio event loop in a background thread.
- Background poller: PING (GetVersion) determines online/offline with fail-streak gating,
  SNAPSHOT collects streaming/recording/scene/stats data.
- All public methods return plain dicts suitable for jsonify().
- IMPORTANT: The asyncio loop and poller run in real OS threads (not eventlet green
  threads) because simpleobsws needs real asyncio. We use eventlet.patcher.original()
  for threading and time to avoid greenlet cross-thread errors. Flask-facing methods
  are lock-free (CPython GIL guarantees atomic attribute reads/writes).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

# asyncio is NOT patched by eventlet — import normally.
import asyncio as _asyncio

# eventlet.monkey_patch() replaces stdlib threading and time.sleep with green
# versions. Our poller runs in a real OS thread, so we need the originals.
import eventlet.patcher
_threading = eventlet.patcher.original("threading")
_time = eventlet.patcher.original("time")

import simpleobsws


# =============================================================================
# ASYNC EVENT LOOP (for simpleobsws)
# =============================================================================
#
# simpleobsws is fully async. We run a dedicated asyncio event loop in a
# background thread so sync callers (Flask handlers, pollers) can use run_async().

_loop: Optional[_asyncio.AbstractEventLoop] = None
_loop_thread: Optional[_threading.Thread] = None


def _start_event_loop() -> None:
    global _loop
    _loop = _asyncio.new_event_loop()
    _asyncio.set_event_loop(_loop)
    _loop.run_forever()


def _ensure_async_loop() -> None:
    """Start the background asyncio loop if not already running."""
    global _loop_thread
    if _loop_thread is not None and _loop_thread.is_alive():
        return
    _loop_thread = _threading.Thread(target=_start_event_loop, daemon=True)
    _loop_thread.start()
    while _loop is None:
        _time.sleep(0.01)


def run_async(coro, timeout: float = 10.0):
    """Submit an async coroutine to the background loop and block for result."""
    future = _asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


# =============================================================================
# OBS MODULE
# =============================================================================

class OBSModule:
    """Direct OBS WebSocket client with background polling.

    Replaces obs-flask.py middleware — the gateway connects directly to OBS
    Studio via WebSocket instead of proxying through HTTP on port 4456.

    Thread safety model:
    - The poller thread (real OS thread) is the sole writer of all state.
    - Flask handlers (eventlet green threads) only read state or submit
      requests to the asyncio event loop.
    - No cross-thread locking needed: CPython's GIL makes single-attribute
      reads/writes atomic, and the asyncio loop serializes WebSocket access.
    """

    def __init__(self, cfg: dict, logger: logging.Logger) -> None:
        self._cfg = cfg
        self._logger = logger

        self._ws_url = cfg.get("ws_url", "ws://127.0.0.1:4455")
        self._ws_password = cfg.get("ws_password", "") or None

        # Poll tuning
        self._ping_seconds = float(cfg.get("ping_seconds", 3.0))
        self._snapshot_seconds = float(cfg.get("snapshot_seconds", 6.0))
        self._offline_after_seconds = float(cfg.get("offline_after_seconds", 10.0))
        self._ping_fails_to_offline = int(cfg.get("ping_fails_to_offline", 3))

        # State — written only by the poller thread, read by Flask handlers.
        # Single-attribute reads are atomic under CPython's GIL.
        self._ws: Optional[simpleobsws.WebSocketClient] = None
        self._connected: bool = False
        self._online: bool = False
        self._last_ok_ts: float = 0.0
        self._last_error: str = ""
        self._ping_fail_streak: int = 0
        self._snapshot: Optional[Dict[str, Any]] = None
        self._snapshot_ts: float = 0.0

        # Thread control (real OS thread, not eventlet green thread)
        self._stop = _threading.Event()
        self._thread = _threading.Thread(target=self._run, daemon=True)

    # --- Lifecycle ---

    def start(self) -> None:
        self._logger.info(
            f"OBS module starting: {self._ws_url} "
            f"(ping={self._ping_seconds}s, snapshot={self._snapshot_seconds}s)"
        )
        _ensure_async_loop()
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._disconnect()

    # --- Connection management (called only from poller thread) ---

    def _ensure_connected(self) -> bool:
        if self._connected and self._ws:
            return True
        try:
            self._ws = simpleobsws.WebSocketClient(
                url=self._ws_url, password=self._ws_password
            )
            run_async(self._ws.connect(), timeout=10)
            identified = run_async(self._ws.wait_until_identified(), timeout=10)
            if not identified:
                self._logger.error("OBS: WebSocket identification timed out")
                self._ws = None
                return False
            self._connected = True
            self._logger.info(f"OBS: Connected to {self._ws_url}")
            return True
        except Exception as e:
            self._logger.warning(f"OBS: Connect failed: {e}")
            self._ws = None
            self._connected = False
            return False

    def _disconnect(self) -> None:
        if self._ws:
            try:
                run_async(self._ws.disconnect(), timeout=5)
            except Exception:
                pass
        self._ws = None
        self._connected = False

    # --- Public request methods (called from Flask/eventlet green threads) ---
    #
    # These grab a reference to self._ws (atomic read under GIL), then submit
    # work to the asyncio event loop which serializes WebSocket access.
    # No lock needed.

    def call(self, request_type: str, request_data: dict = None,
             timeout: float = 10.0) -> Tuple[Optional[dict], Optional[str]]:
        """Execute OBS request and return (response_dict, error_string).

        response_dict matches obs-websocket-http JSON format for backward compat.
        """
        if not self._online or not self._connected:
            return None, "obs-websocket is not connected."
        ws = self._ws
        if ws is None:
            return None, "obs-websocket is not connected."
        try:
            req = simpleobsws.Request(request_type, request_data)
            resp = run_async(ws.call(req), timeout=timeout)
            ret = {
                "requestType": resp.requestType,
                "requestStatus": {
                    "result": resp.requestStatus.result,
                    "code": resp.requestStatus.code,
                },
            }
            if resp.requestStatus.comment:
                ret["requestStatus"]["comment"] = resp.requestStatus.comment
            if resp.responseData:
                ret["responseData"] = resp.responseData
            return ret, None
        except simpleobsws.MessageTimeout:
            return None, "The obs-websocket request timed out."
        except Exception as e:
            # Flag offline so the poller can reconnect on next cycle.
            self._online = False
            self._last_error = str(e)
            return None, str(e)

    def emit(self, request_type: str,
             request_data: dict = None) -> Optional[str]:
        """Fire-and-forget OBS request. Returns error string or None on success."""
        if not self._online or not self._connected:
            return "obs-websocket is not connected."
        ws = self._ws
        if ws is None:
            return "obs-websocket is not connected."
        try:
            req = simpleobsws.Request(request_type, request_data)
            run_async(ws.emit(req), timeout=5)
            return None
        except Exception as e:
            return str(e)

    # --- Status / snapshot (called from Flask/eventlet green threads) ---
    #
    # Lock-free reads — CPython GIL guarantees atomic attribute access.

    def get_status(self) -> Tuple[dict, int]:
        """Return health/status dict for /api/obs/status. Returns (dict, http_status)."""
        online = self._online
        error = self._last_error
        age_ok = (
            round(_time.time() - self._last_ok_ts, 2)
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
        if not self._online:
            return None
        return self._snapshot

    # --- Poll internals (called only from poller thread) ---

    def _ping(self) -> None:
        req = simpleobsws.Request("GetVersion")
        resp = run_async(self._ws.call(req), timeout=5)
        if not resp.requestStatus.result:
            raise RuntimeError(
                f"GetVersion failed: code={resp.requestStatus.code}"
            )

    def _build_snapshot(self) -> Dict[str, Any]:
        snap: Dict[str, Any] = {}

        # Stream status
        try:
            resp = run_async(
                self._ws.call(simpleobsws.Request("GetStreamStatus")), timeout=5
            )
            if resp.requestStatus.result and resp.responseData:
                snap["streaming"] = resp.responseData.get("outputActive", False)
                snap["stream_timecode"] = resp.responseData.get("outputTimecode", "")
                snap["stream_bytes"] = resp.responseData.get("outputBytes", 0)
                snap["stream_reconnecting"] = resp.responseData.get(
                    "outputReconnecting", False
                )
            else:
                snap["streaming"] = None
        except Exception as e:
            snap["streaming"] = None
            self._logger.debug(f"OBS: GetStreamStatus failed: {e}")

        # Record status
        try:
            resp = run_async(
                self._ws.call(simpleobsws.Request("GetRecordStatus")), timeout=5
            )
            if resp.requestStatus.result and resp.responseData:
                snap["recording"] = resp.responseData.get("outputActive", False)
                snap["record_timecode"] = resp.responseData.get("outputTimecode", "")
                snap["record_paused"] = resp.responseData.get("outputPaused", False)
            else:
                snap["recording"] = None
        except Exception as e:
            snap["recording"] = None
            self._logger.debug(f"OBS: GetRecordStatus failed: {e}")

        # Current program scene
        try:
            resp = run_async(
                self._ws.call(simpleobsws.Request("GetCurrentProgramScene")),
                timeout=5,
            )
            if resp.requestStatus.result and resp.responseData:
                snap["current_scene"] = resp.responseData.get(
                    "currentProgramSceneName", ""
                )
            else:
                snap["current_scene"] = None
        except Exception as e:
            snap["current_scene"] = None
            self._logger.debug(f"OBS: GetCurrentProgramScene failed: {e}")

        # Scene list
        try:
            resp = run_async(
                self._ws.call(simpleobsws.Request("GetSceneList")), timeout=5
            )
            if resp.requestStatus.result and resp.responseData:
                scenes = resp.responseData.get("scenes", [])
                snap["scenes"] = [s.get("sceneName", "") for s in scenes]
                snap["scene_count"] = len(scenes)
            else:
                snap["scenes"] = []
                snap["scene_count"] = 0
        except Exception as e:
            snap["scenes"] = []
            snap["scene_count"] = 0
            self._logger.debug(f"OBS: GetSceneList failed: {e}")

        # OBS stats (CPU, memory, FPS, frame drops)
        try:
            resp = run_async(
                self._ws.call(simpleobsws.Request("GetStats")), timeout=5
            )
            if resp.requestStatus.result and resp.responseData:
                snap["cpu_usage"] = resp.responseData.get("cpuUsage", 0)
                snap["memory_usage"] = resp.responseData.get("memoryUsage", 0)
                snap["active_fps"] = resp.responseData.get("activeFps", 0)
                snap["render_skipped_frames"] = resp.responseData.get(
                    "renderSkippedFrames", 0
                )
                snap["render_total_frames"] = resp.responseData.get(
                    "renderTotalFrames", 0
                )
                snap["output_skipped_frames"] = resp.responseData.get(
                    "outputSkippedFrames", 0
                )
                snap["output_total_frames"] = resp.responseData.get(
                    "outputTotalFrames", 0
                )
        except Exception as e:
            self._logger.debug(f"OBS: GetStats failed: {e}")

        return snap

    # --- Poller loop (runs in real OS thread) ---

    def _run(self) -> None:
        self._logger.info("OBS: Poller thread started")
        _time.sleep(0.5)

        last_snapshot_attempt = 0.0
        last_warn_log = 0.0

        while not self._stop.is_set():
            start = _time.time()

            # 1) PING determines online/offline
            try:
                if not self._ensure_connected():
                    raise RuntimeError("Cannot connect to OBS")
                self._ping()

                self._ping_fail_streak = 0
                self._online = True
                self._last_ok_ts = _time.time()
                self._last_error = ""
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

            # Belt-and-suspenders offline threshold
            if (self._last_ok_ts
                    and (_time.time() - self._last_ok_ts)
                    > self._offline_after_seconds):
                self._online = False

            # 2) SNAPSHOT refresh (only if online and due)
            now = _time.time()
            if now - last_snapshot_attempt >= self._snapshot_seconds:
                last_snapshot_attempt = now

                if self._online and self._connected:
                    try:
                        snap = self._build_snapshot()
                        self._snapshot = snap
                        self._snapshot_ts = _time.time()
                    except Exception as e:
                        self._last_error = f"snapshot failed: {e}"
                        if now - last_warn_log >= 10.0:
                            last_warn_log = now
                            self._logger.warning(
                                f"OBS: {self._last_error}"
                            )

            # Sleep until next ping cadence
            elapsed = _time.time() - start
            sleep_for = max(0.2, self._ping_seconds - elapsed)
            self._stop.wait(timeout=sleep_for)
