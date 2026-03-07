#!/usr/bin/env python3
"""
STP Gateway — Compatibility shim.

The gateway has been split into modules for maintainability (Batch 3, Item #7).
This file delegates to gateway_app.py so that existing startup scripts,
DEPLOYMENT.md instructions, and process managers continue to work unchanged.

New module layout:
    gateway_app.py      — Flask/SocketIO setup, GatewayContext, startup, main()
    auth.py             — IP allowlist, PIN, sessions, permissions
    api_routes.py       — REST endpoint handlers
    macro_engine.py     — Macro parsing, execution, step types
    polling.py          — Background pollers, state cache, watchdog
    scheduler.py        — Cron-like schedule execution
    database.py         — SQLite audit log, schedule DB
    socket_handlers.py  — SocketIO events, rooms, heartbeat

Usage (unchanged):
    python gateway.py                    # Normal mode
    python gateway.py --mock             # Mock mode
    python gateway.py --config alt.yaml  # Custom config file
"""

from gateway_app import main  # noqa: F401

if __name__ == "__main__":
    main()
