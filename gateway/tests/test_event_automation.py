"""Tests for event_automation — calendar-driven event automation module."""

import os
import sys
import threading
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from event_automation import EventAutomation, _parse_rfc822

TZ = ZoneInfo("America/Los_Angeles")

# ---------------------------------------------------------------------------
# Sample RSS feed for testing
# ---------------------------------------------------------------------------

SAMPLE_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Church Calendar</title>
    <item>
      <title>Sunday Liturgy</title>
      <pubDate>Sun, 16 Mar 2026 08:00:00 -0700</pubDate>
      <description>8:00 AM - 11:00 AM Sunday Divine Liturgy</description>
    </item>
    <item>
      <title>Chapel Bible Study</title>
      <pubDate>Wed, 18 Mar 2026 18:00:00 -0700</pubDate>
      <description>6:00 PM - 8:00 PM Weekly Bible Study</description>
    </item>
    <item>
      <title>Social Hall Agape Meal</title>
      <pubDate>Sun, 16 Mar 2026 11:30:00 -0700</pubDate>
      <description>11:30 AM - 1:00 PM Fellowship Luncheon</description>
    </item>
    <item>
      <title>Youth Meeting</title>
      <pubDate>Fri, 20 Mar 2026 19:00:00 -0700</pubDate>
      <description>7:00 PM - 9:00 PM</description>
    </item>
  </channel>
</rss>"""

SAMPLE_CFG = {
    "event_automation": {
        "enabled": True,
        "calendar_url": "https://example.com/calendar.rss",
        "poll_interval_seconds": 900,
        "setup_lead_minutes": 30,
        "teardown_delay_minutes": 15,
        "preflight_minutes": 45,
        "default_profile": "main_church",
        "profiles": {
            "main_church": {
                "label": "Main Church Service",
                "keywords": ["liturgy", "mass", "vespers", "main church"],
                "setup_macro": "main_full_setup",
                "teardown_macro": "main_full_teardown",
                "preflight_checks": ["x32_module", "moip_module"],
            },
            "chapel": {
                "label": "Chapel Service",
                "keywords": ["chapel", "bible study", "youth"],
                "setup_macro": "chapel_full_setup",
                "teardown_macro": "chapel_full_teardown",
                "preflight_checks": ["x32_module"],
            },
            "social_hall": {
                "label": "Social Hall",
                "keywords": ["social hall", "agape", "fellowship", "luncheon"],
                "setup_macro": "social_full_setup",
                "teardown_macro": "social_full_teardown",
                "preflight_checks": [],
            },
        },
    }
}


def _make_ctx():
    ctx = MagicMock()
    ctx.mock_mode = True
    ctx.health = None
    ctx.db = MagicMock()
    ctx.socketio = MagicMock()
    return ctx


# ---------------------------------------------------------------------------
# RSS Parsing
# ---------------------------------------------------------------------------

class TestRSSParsing:
    def test_parse_rss_calendar(self):
        events = EventAutomation._parse_rss_calendar(SAMPLE_RSS)
        assert len(events) == 4

    def test_event_titles(self):
        events = EventAutomation._parse_rss_calendar(SAMPLE_RSS)
        titles = [e["title"] for e in events]
        assert "Sunday Liturgy" in titles
        assert "Chapel Bible Study" in titles
        assert "Social Hall Agape Meal" in titles

    def test_event_start_end_times(self):
        events = EventAutomation._parse_rss_calendar(SAMPLE_RSS)
        liturgy = next(e for e in events if e["title"] == "Sunday Liturgy")
        assert liturgy["start"].hour == 8
        assert liturgy["end"].hour == 11
        assert liturgy["end"].minute == 0

    def test_event_end_from_description(self):
        events = EventAutomation._parse_rss_calendar(SAMPLE_RSS)
        agape = next(e for e in events if "Agape" in e["title"])
        assert agape["start"].hour == 11
        assert agape["start"].minute == 30
        assert agape["end"].hour == 13
        assert agape["end"].minute == 0

    def test_default_duration_no_end_time(self):
        rss = """<?xml version="1.0"?>
        <rss><channel><item>
          <title>Test Event</title>
          <pubDate>Sun, 16 Mar 2026 10:00:00 -0700</pubDate>
          <description>No time range here</description>
        </item></channel></rss>"""
        events = EventAutomation._parse_rss_calendar(rss)
        assert len(events) == 1
        assert events[0]["end"] == events[0]["start"] + timedelta(hours=3)

    def test_empty_rss(self):
        events = EventAutomation._parse_rss_calendar("<rss><channel></channel></rss>")
        assert events == []

    def test_malformed_xml(self):
        events = EventAutomation._parse_rss_calendar("not xml at all")
        assert events == []

    def test_missing_pubdate(self):
        rss = """<?xml version="1.0"?>
        <rss><channel><item>
          <title>No Date Event</title>
          <description>Has no pubDate</description>
        </item></channel></rss>"""
        events = EventAutomation._parse_rss_calendar(rss)
        assert events == []


class TestRFC822Parsing:
    def test_standard_rfc822(self):
        dt = _parse_rfc822("Sun, 16 Mar 2026 08:00:00 -0700")
        assert dt is not None
        assert dt.hour == 8

    def test_invalid_date(self):
        dt = _parse_rfc822("not a date")
        assert dt is None


# ---------------------------------------------------------------------------
# Profile Matching
# ---------------------------------------------------------------------------

class TestProfileMatching:
    def setup_method(self):
        self.ea = EventAutomation(SAMPLE_CFG, _make_ctx())

    def test_liturgy_matches_main_church(self):
        ev = {"title": "Sunday Liturgy", "start": datetime.now(TZ)}
        assert self.ea._match_profile(ev) == "main_church"

    def test_bible_study_matches_chapel(self):
        ev = {"title": "Chapel Bible Study", "start": datetime.now(TZ)}
        assert self.ea._match_profile(ev) == "chapel"

    def test_agape_matches_social_hall(self):
        ev = {"title": "Social Hall Agape Meal", "start": datetime.now(TZ)}
        assert self.ea._match_profile(ev) == "social_hall"

    def test_youth_matches_chapel(self):
        ev = {"title": "Youth Meeting", "start": datetime.now(TZ)}
        assert self.ea._match_profile(ev) == "chapel"

    def test_unknown_event_uses_default(self):
        ev = {"title": "Random Unknown Event", "start": datetime.now(TZ)}
        assert self.ea._match_profile(ev) == "main_church"  # default_profile

    def test_case_insensitive_matching(self):
        ev = {"title": "SUNDAY LITURGY", "start": datetime.now(TZ)}
        assert self.ea._match_profile(ev) == "main_church"


# ---------------------------------------------------------------------------
# Event Key Generation
# ---------------------------------------------------------------------------

class TestEventKey:
    def test_event_key_format(self):
        ev = {"title": "Sunday Liturgy", "start": datetime(2026, 3, 16, 8, 0, tzinfo=TZ)}
        key = EventAutomation._event_key(ev)
        assert key == "Sunday Liturgy|2026-03-16_08:00"

    def test_event_key_uniqueness(self):
        ev1 = {"title": "Sunday Liturgy", "start": datetime(2026, 3, 16, 8, 0, tzinfo=TZ)}
        ev2 = {"title": "Sunday Liturgy", "start": datetime(2026, 3, 23, 8, 0, tzinfo=TZ)}
        assert EventAutomation._event_key(ev1) != EventAutomation._event_key(ev2)


# ---------------------------------------------------------------------------
# Skip / Unskip / Override
# ---------------------------------------------------------------------------

class TestSkipAndOverride:
    def setup_method(self):
        self.ea = EventAutomation(SAMPLE_CFG, _make_ctx())

    def test_skip_event(self):
        assert self.ea.skip_event("test_key")
        assert "test_key" in self.ea._skipped

    def test_unskip_event(self):
        self.ea.skip_event("test_key")
        assert self.ea.unskip_event("test_key")
        assert "test_key" not in self.ea._skipped

    def test_override_profile_valid(self):
        assert self.ea.override_profile("test_key", "chapel")
        assert self.ea._override_profiles["test_key"] == "chapel"

    def test_override_profile_invalid(self):
        assert not self.ea.override_profile("test_key", "nonexistent")

    def test_override_profile_reset(self):
        self.ea.override_profile("test_key", "chapel")
        assert self.ea.override_profile("test_key", "")
        assert "test_key" not in self.ea._override_profiles


# ---------------------------------------------------------------------------
# Get Upcoming Events
# ---------------------------------------------------------------------------

class TestGetUpcomingEvents:
    def setup_method(self):
        self.ea = EventAutomation(SAMPLE_CFG, _make_ctx())
        now = datetime.now(TZ)
        self.ea._events = [
            {"title": "Sunday Liturgy", "start": now + timedelta(hours=2), "end": now + timedelta(hours=5)},
            {"title": "Chapel Bible Study", "start": now + timedelta(hours=26), "end": now + timedelta(hours=28)},
            {"title": "Old Event", "start": now - timedelta(hours=48), "end": now - timedelta(hours=45)},
        ]

    def test_returns_future_events(self):
        events = self.ea.get_upcoming_events(hours=48)
        titles = [e["title"] for e in events]
        assert "Sunday Liturgy" in titles
        assert "Chapel Bible Study" in titles

    def test_excludes_old_events(self):
        events = self.ea.get_upcoming_events(hours=48)
        titles = [e["title"] for e in events]
        assert "Old Event" not in titles

    def test_event_fields(self):
        events = self.ea.get_upcoming_events(hours=48)
        ev = events[0]
        assert "key" in ev
        assert "title" in ev
        assert "start" in ev
        assert "end" in ev
        assert "profile_id" in ev
        assert "profile_label" in ev
        assert "setup_macro" in ev
        assert "teardown_macro" in ev
        assert "status" in ev

    def test_upcoming_status(self):
        events = self.ea.get_upcoming_events(hours=48)
        # Both should be "upcoming" since they're in the future
        for ev in events:
            assert ev["status"] in ("upcoming", "preflight", "ready")

    def test_skipped_status(self):
        events = self.ea.get_upcoming_events(hours=48)
        key = events[0]["key"]
        self.ea.skip_event(key)
        events = self.ea.get_upcoming_events(hours=48)
        skipped = next(e for e in events if e["key"] == key)
        assert skipped["status"] == "skipped"

    def test_events_sorted_by_start(self):
        events = self.ea.get_upcoming_events(hours=48)
        starts = [e["start"] for e in events]
        assert starts == sorted(starts)


# ---------------------------------------------------------------------------
# Get Profiles
# ---------------------------------------------------------------------------

class TestGetProfiles:
    def test_returns_all_profiles(self):
        ea = EventAutomation(SAMPLE_CFG, _make_ctx())
        profiles = ea.get_profiles()
        assert "main_church" in profiles
        assert "chapel" in profiles
        assert "social_hall" in profiles

    def test_profile_fields(self):
        ea = EventAutomation(SAMPLE_CFG, _make_ctx())
        profiles = ea.get_profiles()
        mc = profiles["main_church"]
        assert mc["label"] == "Main Church Service"
        assert mc["setup_macro"] == "main_full_setup"
        assert mc["teardown_macro"] == "main_full_teardown"


# ---------------------------------------------------------------------------
# Get Status
# ---------------------------------------------------------------------------

class TestGetStatus:
    def test_status_when_enabled(self):
        ea = EventAutomation(SAMPLE_CFG, _make_ctx())
        status = ea.get_status()
        assert status["enabled"] is True
        assert status["profiles_count"] == 3
        assert status["setup_lead_minutes"] == 30

    def test_status_when_disabled(self):
        cfg = {"event_automation": {"enabled": False}}
        ea = EventAutomation(cfg, _make_ctx())
        status = ea.get_status()
        assert status["enabled"] is False


# ---------------------------------------------------------------------------
# Trigger / Fire Macro
# ---------------------------------------------------------------------------

class TestTriggerNow:
    def setup_method(self):
        self.ctx = _make_ctx()
        self.ea = EventAutomation(SAMPLE_CFG, self.ctx)
        now = datetime.now(TZ)
        self.ea._events = [
            {"title": "Sunday Liturgy", "start": now + timedelta(hours=2), "end": now + timedelta(hours=5)},
        ]

    def _mock_fire(self):
        """Replace _fire_macro with a version that records but doesn't actually execute."""
        original = self.ea._fire_macro
        def mock_fire(event_key, macro_key, action, title):
            self.ea._fired[event_key] = action
            return {"success": True, "macro": macro_key, "action": action}
        self.ea._fire_macro = mock_fire
        return mock_fire

    def test_trigger_setup(self):
        self._mock_fire()
        events = self.ea.get_upcoming_events(hours=48)
        key = events[0]["key"]
        result = self.ea.trigger_now(key, "setup")
        assert result["success"] is True
        assert result["macro"] == "main_full_setup"

    def test_trigger_teardown(self):
        self._mock_fire()
        events = self.ea.get_upcoming_events(hours=48)
        key = events[0]["key"]
        result = self.ea.trigger_now(key, "teardown")
        assert result["success"] is True
        assert result["macro"] == "main_full_teardown"

    def test_trigger_unknown_event(self):
        result = self.ea.trigger_now("nonexistent|2026-01-01_00:00", "setup")
        assert result["success"] is False

    def test_trigger_records_fired_state(self):
        self._mock_fire()
        events = self.ea.get_upcoming_events(hours=48)
        key = events[0]["key"]
        self.ea.trigger_now(key, "setup")
        assert self.ea._fired[key] == "setup"


# ---------------------------------------------------------------------------
# Preflight Checks
# ---------------------------------------------------------------------------

class TestPreflight:
    def test_preflight_no_health_module(self):
        ctx = _make_ctx()
        ctx.health = None
        ea = EventAutomation(SAMPLE_CFG, ctx)
        now = datetime.now(TZ)
        ea._events = [
            {"title": "Sunday Liturgy", "start": now + timedelta(hours=2), "end": now + timedelta(hours=5)},
        ]
        events = ea.get_upcoming_events(hours=48)
        result = ea.run_preflight(events[0]["key"])
        assert result["success"] is True
        assert result["result"]["all_ok"] is False  # unknown = not ok

    def test_preflight_with_healthy_services(self):
        ctx = _make_ctx()
        ctx.health = MagicMock()
        ctx.health.get_all_results.return_value = {
            "x32_module": {"status": {"level": "ok"}, "message": "Healthy", "name": "X32 Audio"},
            "moip_module": {"status": {"level": "ok"}, "message": "Healthy", "name": "MoIP Video"},
        }
        ea = EventAutomation(SAMPLE_CFG, ctx)
        now = datetime.now(TZ)
        ea._events = [
            {"title": "Sunday Liturgy", "start": now + timedelta(hours=2), "end": now + timedelta(hours=5)},
        ]
        events = ea.get_upcoming_events(hours=48)
        result = ea.run_preflight(events[0]["key"])
        assert result["success"] is True
        assert result["result"]["all_ok"] is True


# ---------------------------------------------------------------------------
# Cleanup Old State
# ---------------------------------------------------------------------------

class TestCleanup:
    def test_cleanup_removes_old_entries(self):
        ea = EventAutomation(SAMPLE_CFG, _make_ctx())
        now = datetime.now(TZ)
        old_event = {"title": "Old", "start": now - timedelta(hours=48), "end": now - timedelta(hours=45)}
        key = EventAutomation._event_key(old_event)
        ea._events = [old_event]
        ea._fired[key] = "teardown"
        ea._skipped.add(key)
        ea._override_profiles[key] = "chapel"
        ea._preflight_results[key] = {"all_ok": True}

        ea._cleanup_old_state(now)

        assert key not in ea._fired
        assert key not in ea._skipped
        assert key not in ea._override_profiles
        assert key not in ea._preflight_results
