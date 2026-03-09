"""SQLite audit log, session tracking, and schedule database."""

from __future__ import annotations

import logging
import sqlite3
import threading
from typing import Any

logger = logging.getLogger("stp-gateway")


class Database:
    def __init__(self, path: str):
        self._path = path
        self._local = threading.local()
        self._init_schema()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(self._path, check_same_thread=False)
            self._local.conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn.execute("PRAGMA busy_timeout=5000")
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def _init_schema(self):
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT DEFAULT (datetime('now')),
                tablet_id TEXT,
                action TEXT,
                target TEXT,
                request_data TEXT,
                result TEXT,
                latency_ms REAL,
                actor TEXT
            );
            CREATE TABLE IF NOT EXISTS sessions (
                tablet_id TEXT PRIMARY KEY,
                display_name TEXT,
                last_seen TEXT DEFAULT (datetime('now')),
                socket_id TEXT,
                current_page TEXT
            );
            CREATE TABLE IF NOT EXISTS schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                macro_key TEXT NOT NULL,
                days TEXT DEFAULT '0,1,2,3,4,5,6',
                time_of_day TEXT DEFAULT '08:00',
                enabled INTEGER DEFAULT 1,
                last_run TEXT,
                created TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_audit_tablet ON audit_log(tablet_id);
        """)
        conn.commit()
        # Migrate existing databases before creating actor index
        self._migrate_actor_column(conn)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)")
        conn.commit()

    def _migrate_actor_column(self, conn):
        """Add 'actor' column to audit_log if it doesn't exist (migration for existing databases)."""
        try:
            cols = [row[1] for row in conn.execute("PRAGMA table_info(audit_log)").fetchall()]
            if "actor" not in cols:
                conn.execute("ALTER TABLE audit_log ADD COLUMN actor TEXT")
                conn.commit()
                logger.info("Migrated audit_log: added 'actor' column")
        except Exception as e:
            logger.warning(f"audit_log migration check failed: {e}")

    def log_action(self, tablet_id: str, action: str, target: str,
                   request_data: str = "", result: str = "", latency_ms: float = 0,
                   actor: str = ""):
        # Auto-derive actor from Flask session if not explicitly provided
        if not actor:
            actor = self._auto_actor(tablet_id)
        try:
            conn = self._get_conn()
            conn.execute(
                "INSERT INTO audit_log (tablet_id, action, target, request_data, result, latency_ms, actor) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (tablet_id, action, target, request_data, result, latency_ms, actor or None),
            )
            conn.commit()
        except Exception as e:
            logger.warning(f"Audit log write failed: {e}")  # Never let audit logging crash a request

    @staticmethod
    def _auto_actor(tablet_id: str) -> str:
        """Derive actor from Flask session context, falling back to tablet_id."""
        try:
            from flask import session as flask_session, has_request_context
            if has_request_context():
                user = flask_session.get("user")
                if user:
                    return f"user:{user}"
            return f"tablet:{tablet_id}" if tablet_id else ""
        except Exception:
            return f"tablet:{tablet_id}" if tablet_id else ""

    def flush(self):
        """Flush WAL to main database file for clean shutdown."""
        try:
            conn = self._get_conn()
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            pass  # Best-effort on shutdown

    def cleanup_old_logs(self, retention_days: int = 30):
        """Delete audit log entries older than retention_days."""
        try:
            conn = self._get_conn()
            conn.execute(
                "DELETE FROM audit_log WHERE timestamp < datetime('now', ?)",
                (f"-{retention_days} days",),
            )
            conn.commit()
        except Exception as e:
            logger.warning(f"Audit log cleanup failed: {e}")

    def upsert_session(self, tablet_id: str, display_name: str = "",
                       socket_id: str = "", current_page: str = ""):
        conn = self._get_conn()
        conn.execute(
            "INSERT INTO sessions (tablet_id, display_name, last_seen, socket_id, current_page) "
            "VALUES (?, ?, datetime('now'), ?, ?) "
            "ON CONFLICT(tablet_id) DO UPDATE SET "
            "display_name=excluded.display_name, last_seen=datetime('now'), "
            "socket_id=excluded.socket_id, current_page=excluded.current_page",
            (tablet_id, display_name, socket_id, current_page),
        )
        conn.commit()

    def get_recent_logs(self, limit: int = 100) -> list:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_sessions(self) -> list:
        conn = self._get_conn()
        rows = conn.execute("SELECT * FROM sessions ORDER BY last_seen DESC").fetchall()
        return [dict(r) for r in rows]

    def get_distinct_actors(self) -> list:
        """Return a sorted list of distinct actor values from the audit log."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT DISTINCT actor FROM audit_log WHERE actor IS NOT NULL AND actor != '' ORDER BY actor"
        ).fetchall()
        return [row[0] for row in rows]

    # --- Schedule CRUD ---

    def get_schedules(self) -> list:
        conn = self._get_conn()
        rows = conn.execute("SELECT * FROM schedules ORDER BY time_of_day").fetchall()
        return [dict(r) for r in rows]

    def create_schedule(self, name: str, macro_key: str, days: str, time_of_day: str) -> int:
        conn = self._get_conn()
        cur = conn.execute(
            "INSERT INTO schedules (name, macro_key, days, time_of_day) VALUES (?, ?, ?, ?)",
            (name, macro_key, days, time_of_day),
        )
        conn.commit()
        return cur.lastrowid

    def update_schedule(self, sched_id: int, **kwargs):
        conn = self._get_conn()
        allowed = {"name", "macro_key", "days", "time_of_day", "enabled", "last_run"}
        sets = []
        vals = []
        for k, v in kwargs.items():
            if k in allowed:
                sets.append(f"{k}=?")
                vals.append(v)
        if sets:
            vals.append(sched_id)
            conn.execute(f"UPDATE schedules SET {','.join(sets)} WHERE id=?", vals)
            conn.commit()

    def delete_schedule(self, sched_id: int):
        conn = self._get_conn()
        conn.execute("DELETE FROM schedules WHERE id=?", (sched_id,))
        conn.commit()
