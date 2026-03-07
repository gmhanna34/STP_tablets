"""Tests for Database — SQLite audit log, session tracking, and schedule CRUD."""

import os
import tempfile

import pytest

from database import Database


@pytest.fixture
def db():
    """Create a fresh in-memory-like temp database for each test."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    database = Database(path)
    yield database
    try:
        os.unlink(path)
    except OSError:
        pass


class TestAuditLog:
    def test_log_action_inserts_row(self, db):
        db.log_action("test-tablet", "macro:execute", "chapel_tv_on",
                       '{"steps": 3}', "OK", 150.5)
        logs = db.get_recent_logs(limit=10)
        assert len(logs) == 1
        assert logs[0]["tablet_id"] == "test-tablet"
        assert logs[0]["action"] == "macro:execute"
        assert logs[0]["target"] == "chapel_tv_on"
        assert logs[0]["latency_ms"] == 150.5

    def test_get_recent_logs_respects_limit(self, db):
        for i in range(20):
            db.log_action("tablet", "action", f"target_{i}")
        logs = db.get_recent_logs(limit=5)
        assert len(logs) == 5

    def test_get_recent_logs_ordered_newest_first(self, db):
        db.log_action("tablet", "action", "first")
        db.log_action("tablet", "action", "second")
        logs = db.get_recent_logs()
        assert logs[0]["target"] == "second"
        assert logs[1]["target"] == "first"

    def test_cleanup_old_logs(self, db):
        # Insert a log with an old timestamp, then clean up
        conn = db._get_conn()
        conn.execute(
            "INSERT INTO audit_log (timestamp, tablet_id, action, target) "
            "VALUES (datetime('now', '-60 days'), 'tablet', 'action', 'old_entry')"
        )
        conn.commit()
        db.cleanup_old_logs(retention_days=30)
        logs = db.get_recent_logs()
        assert len(logs) == 0

    def test_log_action_silent_on_error(self, db):
        # Close the connection to force an error, should not raise
        db._local.conn.close()
        db._local.conn = None
        # This should not raise — audit logging never crashes a request
        db.log_action("tablet", "action", "target")


class TestSessions:
    def test_upsert_session_creates_new(self, db):
        db.upsert_session("lobby", "Lobby Tablet", "sid123", "home")
        sessions = db.get_sessions()
        assert len(sessions) == 1
        assert sessions[0]["tablet_id"] == "lobby"
        assert sessions[0]["display_name"] == "Lobby Tablet"
        assert sessions[0]["socket_id"] == "sid123"

    def test_upsert_session_updates_existing(self, db):
        db.upsert_session("lobby", "Lobby", "sid1", "home")
        db.upsert_session("lobby", "Lobby", "sid2", "stream")
        sessions = db.get_sessions()
        assert len(sessions) == 1
        assert sessions[0]["socket_id"] == "sid2"
        assert sessions[0]["current_page"] == "stream"

    def test_multiple_sessions(self, db):
        db.upsert_session("lobby", "Lobby", "sid1", "home")
        db.upsert_session("chapel", "Chapel", "sid2", "stream")
        sessions = db.get_sessions()
        assert len(sessions) == 2


class TestSchedules:
    def test_create_schedule(self, db):
        sched_id = db.create_schedule("Morning Lights", "lights_on", "1,2,3,4,5", "08:00")
        assert sched_id is not None
        schedules = db.get_schedules()
        assert len(schedules) == 1
        assert schedules[0]["name"] == "Morning Lights"
        assert schedules[0]["macro_key"] == "lights_on"
        assert schedules[0]["days"] == "1,2,3,4,5"
        assert schedules[0]["time_of_day"] == "08:00"
        assert schedules[0]["enabled"] == 1

    def test_update_schedule(self, db):
        sched_id = db.create_schedule("Test", "test_macro", "0,6", "09:00")
        db.update_schedule(sched_id, name="Updated Name", time_of_day="10:00")
        schedules = db.get_schedules()
        assert schedules[0]["name"] == "Updated Name"
        assert schedules[0]["time_of_day"] == "10:00"

    def test_update_schedule_ignores_invalid_fields(self, db):
        sched_id = db.create_schedule("Test", "test_macro", "0", "09:00")
        # "invalid_field" should be silently ignored
        db.update_schedule(sched_id, invalid_field="hack", name="Safe")
        schedules = db.get_schedules()
        assert schedules[0]["name"] == "Safe"

    def test_delete_schedule(self, db):
        sched_id = db.create_schedule("Temp", "temp_macro", "0", "12:00")
        db.delete_schedule(sched_id)
        assert len(db.get_schedules()) == 0

    def test_schedules_ordered_by_time(self, db):
        db.create_schedule("Evening", "evening", "0", "18:00")
        db.create_schedule("Morning", "morning", "0", "08:00")
        db.create_schedule("Noon", "noon", "0", "12:00")
        schedules = db.get_schedules()
        times = [s["time_of_day"] for s in schedules]
        assert times == ["08:00", "12:00", "18:00"]

    def test_update_last_run(self, db):
        sched_id = db.create_schedule("Test", "test", "0", "08:00")
        db.update_schedule(sched_id, last_run="2026-03-07 08:00")
        schedules = db.get_schedules()
        assert schedules[0]["last_run"] == "2026-03-07 08:00"

    def test_disable_schedule(self, db):
        sched_id = db.create_schedule("Test", "test", "0", "08:00")
        db.update_schedule(sched_id, enabled=0)
        schedules = db.get_schedules()
        assert schedules[0]["enabled"] == 0


class TestFlush:
    def test_flush_does_not_raise(self, db):
        db.log_action("tablet", "action", "target")
        db.flush()  # Should not raise
