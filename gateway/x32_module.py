"""
X32 Module — Direct OSC/UDP communication with the Behringer X32 mixer.

Absorbed from STP_scripts/x32-flask.py (Phase 1 of the consolidation plan).
Replaces the standalone Flask+Waitress middleware that ran on port 3400.

Key design:
- Background poller thread owns the mixer connection via xair_api.
- Two-stage polling: PING (cheap, determines online/offline) and SNAPSHOT
  (heavier, refreshes cached status less often).
- All public methods return plain dicts suitable for jsonify().
- Thread-safe: HTTP routes and macro engine can call methods concurrently.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple

import xair_api


# =============================================================================
# MIXER OWNER
# =============================================================================

class MixerOwner:
    """Owns the xair_api connection. Not thread-safe; caller must hold lock."""

    def __init__(self, mixer_type: str, ip: str, logger: logging.Logger) -> None:
        self.mixer_type = mixer_type
        self.ip = ip
        self.mixer = None
        self.connected = False
        self._logger = logger

    def connect(self) -> None:
        self._logger.info(f"X32: Connecting to {self.mixer_type} @ {self.ip}...")
        m = xair_api.connect(self.mixer_type, ip=self.ip)
        try:
            m.__enter__()
        except Exception:
            # Clean up the socket so it doesn't leak file descriptors
            try:
                m.__exit__(None, None, None)
            except Exception as e:
                self._logger.debug(f"X32: cleanup after failed connect: {e}")
            raise
        self.mixer = m
        self.connected = True
        self._logger.info("X32: Connected to mixer")

    def disconnect(self) -> None:
        if self.mixer is not None:
            try:
                self.mixer.__exit__(None, None, None)
            except Exception as e:
                self._logger.debug(f"X32: disconnect cleanup: {e}")
        self.mixer = None
        self.connected = False

    def require(self):
        if not self.connected or self.mixer is None:
            self.connect()
        return self.mixer


# =============================================================================
# HELPERS
# =============================================================================

def _fmt_ch(num: int) -> str:
    return f"{num:02d}"


def _mute_str(v: Any) -> str:
    return "unmuted" if str(v) == "1" else "muted"


# =============================================================================
# X32 POLLER
# =============================================================================

class X32Poller:
    """
    Background poller:
      - PING determines online/offline (with fail-streak gating)
      - SNAPSHOT refreshes cached data (but does not flip offline by itself)
    """

    def __init__(self, mixer_type: str, ip: str, logger: logging.Logger,
                 ping_seconds: float = 2.0,
                 snapshot_seconds: float = 6.0,
                 offline_after_seconds: float = 8.0,
                 ping_fails_to_offline: int = 3) -> None:
        self._lock = threading.Lock()
        self._logger = logger
        self._owner = MixerOwner(mixer_type, ip, logger)

        self._online: bool = False
        self._last_ok_ts: float = 0.0
        self._last_error: str = ""

        self._snapshot: Optional[Dict[str, Any]] = None
        self._snapshot_ts: float = 0.0

        self._ping_fail_streak: int = 0
        self._ping_seconds = ping_seconds
        self._snapshot_seconds = snapshot_seconds
        self._offline_after_seconds = offline_after_seconds
        self._ping_fails_to_offline = ping_fails_to_offline

        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def online(self) -> Tuple[bool, float, str]:
        last_ok = self._last_ok_ts
        age_ok = (time.time() - last_ok) if last_ok else float("inf")
        return self._online, age_ok, self._last_error

    def snapshot(self) -> Tuple[Optional[Dict[str, Any]], float, bool, str]:
        snap_ts = self._snapshot_ts
        snap_age = (time.time() - snap_ts) if snap_ts else float("inf")
        return self._snapshot, snap_age, self._online, self._last_error

    def command(self, func: Callable[[Any], Any]) -> Tuple[Optional[Any], Optional[str]]:
        """Execute a command against the mixer. If it fails, flip offline + disconnect."""
        with self._lock:
            try:
                m = self._owner.require()
                res = func(m)
                return res, None
            except Exception as e:
                self._online = False
                self._last_error = str(e)
                self._ping_fail_streak = self._ping_fails_to_offline
                self._owner.disconnect()
                return None, str(e)

    # -------------------
    # Poll internals
    # -------------------

    def _ping(self, m) -> None:
        m._info_response = []
        r = m.query("/-show/prepos/current ")
        if not r or r[0] is None:
            raise RuntimeError("no response from mixer (ping)")
        v = r[0]
        if isinstance(v, bytes):
            v = v.decode(errors="ignore")
        s = str(v).strip()
        n = int(s)
        if n < 0 or n > 999:
            raise RuntimeError(f"cur_scene out of range: {n}")

    def _build_snapshot(self, m) -> Dict[str, Any]:
        snap: Dict[str, Any] = {}

        # Current scene
        r = m.query("/-show/prepos/current ")
        if not r or r[0] is None:
            raise RuntimeError("no response from mixer (snapshot/current)")
        cur_raw = r[0]
        if isinstance(cur_raw, bytes):
            cur_raw = cur_raw.decode(errors="ignore")
        cur_scene = int(str(cur_raw).strip())

        snap["cur_scene"] = str(cur_scene)
        try:
            snap["cur_scene_name"] = m.query(f"/-show/showfile/scene/{cur_scene:03d}/name ")[0]
        except Exception as e:
            self._logger.debug(f"X32 snapshot: cur_scene_name query failed: {e}")
            snap["cur_scene_name"] = ""

        # Channels 1-32
        for i in range(1, 33):
            ch = _fmt_ch(i)
            try:
                mute_val = m.query(f"/ch/{ch}/mix/on")[0]
                snap[f"ch{i}mutestatus"] = _mute_str(mute_val)
            except Exception as e:
                self._logger.debug(f"X32 snapshot: ch{i} mute query failed: {e}")
                snap[f"ch{i}mutestatus"] = "unknown"
            try:
                snap[f"ch{i}name"] = m.strip[i - 1].config.name
            except Exception as e:
                self._logger.debug(f"X32 snapshot: ch{i} name query failed: {e}")
                snap[f"ch{i}name"] = ""
            try:
                vol = float(m.query(f"/ch/{ch}/mix/fader")[0])
                snap[f"ch{i}vol"] = str(int(vol * 100))
            except Exception as e:
                self._logger.debug(f"X32 snapshot: ch{i} vol query failed: {e}")
                snap[f"ch{i}vol"] = ""

        # Aux 1-8
        for i in range(1, 9):
            ax = _fmt_ch(i)
            try:
                mute_val = m.query(f"/auxin/{ax}/mix/on")[0]
                snap[f"aux{i}_mutestatus"] = _mute_str(mute_val)
            except Exception as e:
                self._logger.debug(f"X32 snapshot: aux{i} mute query failed: {e}")
                snap[f"aux{i}_mutestatus"] = "unknown"
            try:
                snap[f"aux{i}_name"] = m.auxin[i - 1].config.name
            except Exception as e:
                self._logger.debug(f"X32 snapshot: aux{i} name query failed: {e}")
                snap[f"aux{i}_name"] = ""
            try:
                vol = float(m.query(f"/auxin/{ax}/mix/fader")[0])
                snap[f"aux{i}vol"] = str(int(vol * 100))
            except Exception as e:
                self._logger.debug(f"X32 snapshot: aux{i} vol query failed: {e}")
                snap[f"aux{i}vol"] = ""

        # Buses 1-16
        for i in range(1, 17):
            bx = _fmt_ch(i)
            try:
                mute_val = m.query(f"/bus/{bx}/mix/on")[0]
                snap[f"bus{i}_mutestatus"] = _mute_str(mute_val)
            except Exception as e:
                self._logger.debug(f"X32 snapshot: bus{i} mute query failed: {e}")
                snap[f"bus{i}_mutestatus"] = "unknown"
            try:
                snap[f"bus{i}_name"] = m.bus[i - 1].config.name
            except Exception as e:
                self._logger.debug(f"X32 snapshot: bus{i} name query failed: {e}")
                snap[f"bus{i}_name"] = ""
            try:
                vol = float(m.query(f"/bus/{bx}/mix/fader")[0])
                snap[f"bus{i}vol"] = str(int(vol * 100))
            except Exception as e:
                self._logger.debug(f"X32 snapshot: bus{i} vol query failed: {e}")
                snap[f"bus{i}vol"] = ""

        # DCAs 1-8
        for i in range(1, 9):
            try:
                mute_val = m.query(f"/dca/{i}/on")[0]
                snap[f"dca{i}_mutestatus"] = _mute_str(mute_val)
            except Exception as e:
                self._logger.debug(f"X32 snapshot: dca{i} mute query failed: {e}")
                snap[f"dca{i}_mutestatus"] = "unknown"
            try:
                snap[f"dca{i}_name"] = m.dca[i - 1].config.name
            except Exception as e:
                self._logger.debug(f"X32 snapshot: dca{i} name query failed: {e}")
                snap[f"dca{i}_name"] = ""
            try:
                vol = float(m.query(f"/dca/{i}/fader")[0])
                snap[f"dca{i}vol"] = str(int(vol * 100))
            except Exception as e:
                self._logger.debug(f"X32 snapshot: dca{i} vol query failed: {e}")
                snap[f"dca{i}vol"] = ""

        # Scene names 0-25
        for i in range(26):
            try:
                snap[f"scene{i}name"] = m.query(f"/-show/showfile/scene/{i:03d}/name ")[0]
            except Exception as e:
                self._logger.debug(f"X32 snapshot: scene{i} name query failed: {e}")
                snap[f"scene{i}name"] = ""

        return snap

    def _run(self) -> None:
        self._logger.info("X32 poller thread started")
        time.sleep(0.25)

        last_snapshot_attempt = 0.0
        last_warn_log = 0.0
        _reconnect_backoff = 0.0  # extra delay after repeated connect failures

        while not self._stop.is_set():
            start = time.time()

            # ---- 0) CONNECT outside lock (may block) ----
            if not self._owner.connected:
                try:
                    self._owner.connect()
                    _reconnect_backoff = 0.0  # reset on success
                except Exception as e:
                    self._ping_fail_streak += 1
                    self._last_error = f"connect failed ({self._ping_fail_streak}): {e}"
                    if self._ping_fail_streak == 1 or self._ping_fail_streak % 5 == 0:
                        self._logger.warning(f"X32: {self._last_error}")
                    if self._ping_fail_streak >= self._ping_fails_to_offline:
                        self._online = False
                    # Exponential backoff: 2s, 4s, 8s, … capped at 30s
                    _reconnect_backoff = min(_reconnect_backoff * 2 or 2.0, 30.0)
                    self._stop.wait(timeout=_reconnect_backoff)
                    continue

            # ---- 1) PING determines online/offline ----
            with self._lock:
                try:
                    m = self._owner.mixer
                    if m is None:
                        raise RuntimeError("mixer not connected")
                    self._ping(m)
                    self._ping_fail_streak = 0
                    self._online = True
                    self._last_ok_ts = time.time()
                    self._last_error = ""
                except Exception as e:
                    self._ping_fail_streak += 1
                    self._last_error = f"ping failed ({self._ping_fail_streak}): {e}"
                    if self._ping_fail_streak == 1 or self._ping_fail_streak % 5 == 0:
                        self._logger.warning(f"X32: {self._last_error}")
                    if self._ping_fail_streak >= self._ping_fails_to_offline:
                        self._online = False
                        self._owner.disconnect()

            # Belt & suspenders offline threshold
            if self._last_ok_ts and (time.time() - self._last_ok_ts) > self._offline_after_seconds:
                self._online = False

            # ---- 2) SNAPSHOT refresh (only if online and due) ----
            now = time.time()
            if now - last_snapshot_attempt >= self._snapshot_seconds:
                last_snapshot_attempt = now
                with self._lock:
                    if self._online:
                        try:
                            m = self._owner.mixer
                            if m is None:
                                raise RuntimeError("mixer not connected")
                            snap = self._build_snapshot(m)
                            self._snapshot = snap
                            self._snapshot_ts = time.time()
                        except Exception as e:
                            self._last_error = f"snapshot failed: {e}"
                            if now - last_warn_log >= 10.0:
                                last_warn_log = now
                                self._logger.warning(f"X32: {self._last_error}")

            elapsed = time.time() - start
            sleep_for = max(0.2, self._ping_seconds - elapsed)
            self._stop.wait(timeout=sleep_for)


# =============================================================================
# X32 MODULE (public interface for the gateway)
# =============================================================================

class X32Module:
    """
    Gateway-facing interface for the X32 mixer.

    Usage:
        x32 = X32Module(cfg, logger)
        x32.start()
        # Then call x32.get_status(), x32.set_scene(num), etc.
    """

    def __init__(self, cfg: dict, logger: logging.Logger) -> None:
        self._logger = logger
        self._mixer_ip = cfg.get("mixer_ip", "192.168.1.231")
        self._mixer_type = cfg.get("mixer_type", "X32")
        self._poller = X32Poller(
            mixer_type=self._mixer_type,
            ip=self._mixer_ip,
            logger=logger,
            ping_seconds=cfg.get("ping_seconds", 2.0),
            snapshot_seconds=cfg.get("snapshot_seconds", 6.0),
            offline_after_seconds=cfg.get("offline_after_seconds", 8.0),
            ping_fails_to_offline=cfg.get("ping_fails_to_offline", 3),
        )

    def start(self) -> None:
        self._logger.info(f"X32 module starting: {self._mixer_type} @ {self._mixer_ip}")
        self._poller.start()

    def stop(self) -> None:
        self._poller._stop.set()
        self._poller._owner.disconnect()

    # --- Status / Health ---

    def get_status(self) -> dict:
        """Returns status dict matching the old /status endpoint format."""
        snap, snap_age, online, err = self._poller.snapshot()
        if not online:
            return {"healthy": False, "error": err or "offline", "data": None}
        return {
            "healthy": True,
            "age_seconds": None if snap_age == float("inf") else round(snap_age, 2),
            "data": snap,
            "error": err or "",
        }

    def get_health(self) -> dict:
        """Returns health dict matching the old /health endpoint format."""
        online, age_ok, err = self._poller.online()
        snap, _, _, _ = self._poller.snapshot()
        cur_scene = None
        cur_scene_name = None
        if isinstance(snap, dict):
            cur_scene = snap.get("cur_scene")
            cur_scene_name = snap.get("cur_scene_name")
        return {
            "healthy": bool(online),
            "mixer_type": self._mixer_type,
            "mixer_ip": self._mixer_ip,
            "cur_scene": cur_scene,
            "cur_scene_name": cur_scene_name,
            "seconds_since_last_ok": None if age_ok == float("inf") else round(age_ok, 2),
            "error": err or "",
        }

    # --- Scene ---

    def set_scene(self, num: int) -> Tuple[dict, int]:
        """Load a scene. Returns (result_dict, http_status)."""
        if num < 0 or num > 25:
            return {"error": "Scene must be 0-25"}, 400

        def do(m):
            m.send("/-action/goscene", num)
            return {"success": True, "scene": num}

        res, err = self._poller.command(do)
        if err:
            return {"error": err}, 503
        return res, 200

    # --- Channel mute/volume ---

    def mute_channel(self, ch: int, state: str) -> Tuple[dict, int]:
        """Mute or unmute a channel (1-32). state='on' mutes, 'off' unmutes."""
        if ch < 1 or ch > 32:
            return {"error": "Channel must be 1-32"}, 400

        mute_value = (state == "off")  # mix.on=False means muted

        def do(m):
            m.strip[ch - 1].mix.on = mute_value
            return {"success": True, "channel": ch, "muted": state == "on"}

        res, err = self._poller.command(do)
        if err:
            return {"error": err}, 503
        return res, 200

    def volume_channel(self, ch: int, direction: str) -> Tuple[dict, int]:
        """Adjust channel volume up or down by 5%."""
        if ch < 1 or ch > 32:
            return {"error": "Channel must be 1-32"}, 400

        step = 0.05 if direction == "up" else -0.05

        def do(m):
            chs = _fmt_ch(ch)
            vol = float(m.query(f"/ch/{chs}/mix/fader")[0])
            new_vol = min(1.0, max(0.0, vol + step))
            m.send(f"/ch/{chs}/mix/fader", new_vol)
            return {"success": True, "channel": ch, "volume": round(new_vol, 3)}

        res, err = self._poller.command(do)
        if err:
            return {"error": err}, 503
        return res, 200

    # --- Aux mute/volume ---

    def mute_aux(self, ch: int, state: str) -> Tuple[dict, int]:
        """Mute or unmute an aux input (1-8)."""
        if ch < 1 or ch > 8:
            return {"error": "Aux must be 1-8"}, 400

        mute_value = (state == "off")

        def do(m):
            m.auxin[ch - 1].mix.on = mute_value
            return {"success": True, "aux": ch, "muted": state == "on"}

        res, err = self._poller.command(do)
        if err:
            return {"error": err}, 503
        return res, 200

    # --- Bus mute/volume (NEW — not in old x32-flask.py) ---

    def mute_bus(self, ch: int, state: str) -> Tuple[dict, int]:
        """Mute or unmute a bus (1-16)."""
        if ch < 1 or ch > 16:
            return {"error": "Bus must be 1-16"}, 400

        mute_value = (state == "off")

        def do(m):
            m.bus[ch - 1].mix.on = mute_value
            return {"success": True, "bus": ch, "muted": state == "on"}

        res, err = self._poller.command(do)
        if err:
            return {"error": err}, 503
        return res, 200

    def volume_bus(self, ch: int, direction: str) -> Tuple[dict, int]:
        """Adjust bus volume up or down by 5%."""
        if ch < 1 or ch > 16:
            return {"error": "Bus must be 1-16"}, 400

        step = 0.05 if direction == "up" else -0.05

        def do(m):
            bx = _fmt_ch(ch)
            vol = float(m.query(f"/bus/{bx}/mix/fader")[0])
            new_vol = min(1.0, max(0.0, vol + step))
            m.send(f"/bus/{bx}/mix/fader", new_vol)
            return {"success": True, "bus": ch, "volume": round(new_vol, 3)}

        res, err = self._poller.command(do)
        if err:
            return {"error": err}, 503
        return res, 200

    # --- DCA mute/volume (NEW — not in old x32-flask.py) ---

    def mute_dca(self, ch: int, state: str) -> Tuple[dict, int]:
        """Mute or unmute a DCA (1-8)."""
        if ch < 1 or ch > 8:
            return {"error": "DCA must be 1-8"}, 400

        mute_value = (state == "off")

        def do(m):
            m.dca[ch - 1].config.on = mute_value
            return {"success": True, "dca": ch, "muted": state == "on"}

        res, err = self._poller.command(do)
        if err:
            return {"error": err}, 503
        return res, 200

    def volume_dca(self, ch: int, direction: str) -> Tuple[dict, int]:
        """Adjust DCA volume up or down by 5%."""
        if ch < 1 or ch > 8:
            return {"error": "DCA must be 1-8"}, 400

        step = 0.05 if direction == "up" else -0.05

        def do(m):
            vol = float(m.query(f"/dca/{ch}/fader")[0])
            new_vol = min(1.0, max(0.0, vol + step))
            m.send(f"/dca/{ch}/fader", new_vol)
            return {"success": True, "dca": ch, "volume": round(new_vol, 3)}

        res, err = self._poller.command(do)
        if err:
            return {"error": err}, 503
        return res, 200
