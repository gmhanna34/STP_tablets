"""SocketIO event handlers — connect, disconnect, rooms, heartbeat."""

from __future__ import annotations

import collections
import logging
import time
import threading

from flask import request
from flask_socketio import emit, join_room, leave_room

logger = logging.getLogger("stp-gateway")

# ---------------------------------------------------------------------------
# Per-tablet WiFi / connection quality tracker
# ---------------------------------------------------------------------------
_MAX_HISTORY = 200  # keep last N sessions per tablet


class _TabletConnStats:
    """Thread-safe per-tablet connection statistics for WiFi debugging."""

    def __init__(self):
        self._lock = threading.Lock()
        # tablet -> deque of {connected_at, disconnected_at, uptime, reason}
        self._sessions: dict[str, collections.deque] = {}
        # tablet -> latest client-reported WiFi diag
        self._wifi: dict[str, dict] = {}

    def record_connect(self, tablet: str, ts: float):
        with self._lock:
            if tablet not in self._sessions:
                self._sessions[tablet] = collections.deque(maxlen=_MAX_HISTORY)

    def record_disconnect(self, tablet: str, connected_at: float | None,
                          disconnected_at: float, reason: str = "?"):
        uptime = disconnected_at - connected_at if connected_at else 0
        with self._lock:
            if tablet not in self._sessions:
                self._sessions[tablet] = collections.deque(maxlen=_MAX_HISTORY)
            self._sessions[tablet].append({
                "connected_at": connected_at or disconnected_at,
                "disconnected_at": disconnected_at,
                "uptime": round(uptime, 1),
                "reason": reason,
            })

    def record_wifi_diag(self, tablet: str, data: dict):
        with self._lock:
            self._wifi[tablet] = {**data, "ts": time.time()}

    def update_last_reason(self, tablet: str, reason: str):
        """Update the disconnect reason of the most recent session (backfill from client diag)."""
        with self._lock:
            sessions = self._sessions.get(tablet)
            if sessions:
                sessions[-1]["reason"] = reason

    def get_summary(self) -> dict:
        """Return per-tablet connection stats for the /api/wifi-debug endpoint."""
        now = time.time()
        result = {}
        with self._lock:
            for tablet, sessions in self._sessions.items():
                if not sessions:
                    continue
                uptimes = [s["uptime"] for s in sessions]
                # Sessions in last 10 minutes
                recent = [s for s in sessions if now - s["disconnected_at"] < 600]
                recent_uptimes = [s["uptime"] for s in recent]
                reasons = {}
                for s in recent:
                    r = s["reason"]
                    reasons[r] = reasons.get(r, 0) + 1

                result[tablet] = {
                    "total_sessions": len(sessions),
                    "disconnects_last_10min": len(recent),
                    "avg_uptime_all": round(sum(uptimes) / len(uptimes), 1) if uptimes else 0,
                    "min_uptime_all": round(min(uptimes), 1) if uptimes else 0,
                    "max_uptime_all": round(max(uptimes), 1) if uptimes else 0,
                    "avg_uptime_recent": round(sum(recent_uptimes) / len(recent_uptimes), 1) if recent_uptimes else 0,
                    "disconnect_reasons": reasons,
                    "wifi": self._wifi.get(tablet),
                    "last_disconnect": sessions[-1] if sessions else None,
                }
        return result


# Module-level singleton so the API route can access it
conn_stats = _TabletConnStats()


def register_socket_handlers(ctx):
    """Register all SocketIO event handlers."""
    socketio = ctx.socketio
    db = ctx.db
    state_cache = ctx.state_cache
    cfg = ctx.cfg

    @socketio.on("connect")
    def on_connect():
        tablet = request.args.get("tablet", "Unknown")
        now = time.time()
        with ctx.sid_lock:
            ctx.sid_to_tablet[request.sid] = tablet
            ctx.sid_connect_time[request.sid] = now
        logger.info(f"SocketIO connect: tablet={tablet} sid={request.sid}")
        conn_stats.record_connect(tablet, now)
        db.upsert_session(tablet, socket_id=request.sid)

    @socketio.on("disconnect")
    def on_disconnect():
        now = time.time()
        with ctx.sid_lock:
            tablet = ctx.sid_to_tablet.pop(request.sid, "Unknown")
            connected_at = ctx.sid_connect_time.pop(request.sid, None)
        uptime = f"{now - connected_at:.1f}s" if connected_at else "?"
        logger.info(f"SocketIO disconnect: tablet={tablet} sid={request.sid} uptime={uptime}")
        conn_stats.record_disconnect(tablet, connected_at, now, reason="server-observed")

    @socketio.on("diag")
    def on_diag(data):
        """Receive diagnostic info from client (e.g., previous disconnect reason, WiFi quality)."""
        with ctx.sid_lock:
            tablet = ctx.sid_to_tablet.get(request.sid, "Unknown")
        prev = data.get("prev_disconnect", "?")
        wifi_rssi = data.get("wifi_signal")
        wifi_freq = data.get("wifi_freq")
        rtt = data.get("rtt_ms")
        conn_count = data.get("session_count", "?")
        downtime = data.get("downtime_ms")

        wifi_bssid = data.get("wifi_bssid")
        wifi_ssid = data.get("wifi_ssid")
        wifi_link_speed = data.get("wifi_link_speed")
        ip4 = data.get("ip4")

        parts = [f"SocketIO diag: tablet={tablet} sid={request.sid} prev_disconnect={prev}"]
        if wifi_rssi is not None:
            parts.append(f"wifi_signal={wifi_rssi}")
        if wifi_freq is not None:
            parts.append(f"wifi_freq={wifi_freq}")
        if wifi_bssid is not None:
            parts.append(f"bssid={wifi_bssid}")
        if wifi_ssid is not None:
            parts.append(f"ssid={wifi_ssid}")
        if wifi_link_speed is not None:
            parts.append(f"link_speed={wifi_link_speed}")
        if ip4 is not None:
            parts.append(f"ip={ip4}")
        if rtt is not None:
            parts.append(f"rtt={rtt}ms")
        if downtime is not None:
            parts.append(f"downtime={downtime}ms")
        parts.append(f"session_count={conn_count}")
        logger.info(" ".join(parts))

        # Backfill the most recent session's disconnect reason with the client-reported value
        conn_stats.update_last_reason(tablet, prev)

        # Store WiFi diag for the debug endpoint
        diag_data = {
            "wifi_signal": wifi_rssi,
            "wifi_freq": wifi_freq,
            "rtt_ms": rtt,
            "session_count": conn_count,
        }
        # Include extra fields if present (BSSID, SSID, link speed, IP)
        for extra_key in ("wifi_ssid", "wifi_bssid", "wifi_rssi", "wifi_link_speed", "ip4"):
            val = data.get(extra_key)
            if val is not None:
                diag_data[extra_key] = val
        conn_stats.record_wifi_diag(tablet, diag_data)

    @socketio.on("join")
    def on_join(data):
        room = data.get("room", "")
        if room in ("moip", "x32", "obs", "projectors", "ha", "macros", "camlytics", "health", "wattbox"):
            join_room(room)
            logger.debug(f"sid={request.sid} joined room={room}")
            # Push cached state immediately so reconnecting tablets
            # don't wait for the next state change to get data
            cached = state_cache.get(room)
            if cached is not None:
                emit(f"state:{room}", cached)

    @socketio.on("leave")
    def on_leave(data):
        room = data.get("room", "")
        leave_room(room)

    @socketio.on("heartbeat")
    def on_heartbeat(data):
        tablet = data.get("tablet", "Unknown")
        display_name = data.get("displayName", "")
        role = data.get("role", "")
        db.upsert_session(
            tablet,
            display_name=display_name,
            socket_id=request.sid,
            current_page=data.get("currentPage", ""),
        )
        emit("heartbeat_ack", {"ok": True})

        # Log WiFi quality if present (for continuous monitoring)
        wifi_signal = data.get("wifi_signal")
        wifi_rssi = data.get("wifi_rssi")
        if wifi_signal is not None or wifi_rssi is not None:
            conn_stats.record_wifi_diag(tablet, {
                "wifi_signal": wifi_signal,
                "wifi_rssi": wifi_rssi,
                "wifi_freq": data.get("wifi_freq"),
                "wifi_link_speed": data.get("wifi_link_speed"),
                "session_count": data.get("session_count"),
            })

        # Forward heartbeat to Health Module (in-process, no HTTP)
        _forward_heartbeat_to_health(ctx, tablet)


def _forward_heartbeat_to_health(ctx, tablet_key: str):
    """Record a tablet heartbeat in the health module."""
    if ctx.health is None:
        return
    hd_cfg = ctx.cfg.get("healthdash", {})
    name_map = hd_cfg.get("tablet_names", {})
    friendly = name_map.get(tablet_key, tablet_key)
    ctx.health.record_heartbeat(friendly)
