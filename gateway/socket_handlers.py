"""SocketIO event handlers — connect, disconnect, rooms, heartbeat."""

from __future__ import annotations

import logging
import time

from flask import request
from flask_socketio import emit, join_room, leave_room

logger = logging.getLogger("stp-gateway")


def register_socket_handlers(ctx):
    """Register all SocketIO event handlers."""
    socketio = ctx.socketio
    db = ctx.db
    state_cache = ctx.state_cache
    cfg = ctx.cfg

    @socketio.on("connect")
    def on_connect():
        tablet = request.args.get("tablet", "Unknown")
        with ctx.sid_lock:
            ctx.sid_to_tablet[request.sid] = tablet
            ctx.sid_connect_time[request.sid] = time.time()
        logger.info(f"SocketIO connect: tablet={tablet} sid={request.sid}")
        db.upsert_session(tablet, socket_id=request.sid)

    @socketio.on("disconnect")
    def on_disconnect():
        with ctx.sid_lock:
            tablet = ctx.sid_to_tablet.pop(request.sid, "Unknown")
            connected_at = ctx.sid_connect_time.pop(request.sid, None)
        uptime = f"{time.time() - connected_at:.1f}s" if connected_at else "?"
        logger.info(f"SocketIO disconnect: tablet={tablet} sid={request.sid} uptime={uptime}")

    @socketio.on("diag")
    def on_diag(data):
        """Receive diagnostic info from client (e.g., previous disconnect reason)."""
        with ctx.sid_lock:
            tablet = ctx.sid_to_tablet.get(request.sid, "Unknown")
        prev = data.get("prev_disconnect", "?")
        logger.info(f"SocketIO diag: tablet={tablet} sid={request.sid} prev_disconnect={prev}")

    @socketio.on("join")
    def on_join(data):
        room = data.get("room", "")
        if room in ("moip", "x32", "obs", "projectors", "ha", "macros", "camlytics", "health"):
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
