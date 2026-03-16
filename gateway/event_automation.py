"""Calendar-driven event automation — auto-runs setup/teardown macros for church services.

Fetches the church calendar RSS feed, matches events to profiles (by keyword),
and fires setup macros before services and teardown macros after they end.

Reuses the calendar RSS parser from health_module.py.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests

logger = logging.getLogger("stp-gateway")

TZ = ZoneInfo("America/Los_Angeles")


class EventAutomation:
    """Monitors the church calendar and auto-fires setup/teardown macros."""

    def __init__(self, cfg: dict, ctx):
        self._cfg = cfg.get("event_automation", {})
        self._ctx = ctx
        self._enabled = self._cfg.get("enabled", False)

        # Timing config
        self._poll_interval = int(self._cfg.get("poll_interval_seconds", 900))
        self._setup_lead = int(self._cfg.get("setup_lead_minutes", 30))
        self._teardown_delay = int(self._cfg.get("teardown_delay_minutes", 15))
        self._preflight_minutes = int(self._cfg.get("preflight_minutes", 45))
        self._calendar_url = self._cfg.get("calendar_url", "")
        self._default_profile = self._cfg.get("default_profile", "")
        self._auto_teardown = bool(self._cfg.get("auto_teardown", False))

        # Profiles: keyword → macro mapping
        self._profiles: Dict[str, dict] = self._cfg.get("profiles", {})

        # Runtime state
        self._events: List[dict] = []           # Parsed calendar events
        self._events_lock = threading.Lock()
        self._last_fetch = 0.0
        self._feed_ok = False
        self._fired: Dict[str, str] = {}        # event_key -> "setup"|"teardown" (prevents double-fire)
        self._skipped: set = set()               # event_keys that the user manually skipped
        self._override_profiles: Dict[str, str] = {}  # event_key -> profile_id override
        self._preflight_results: Dict[str, dict] = {}  # event_key -> {checks, timestamp}
        self._teardown_enabled: set = set()      # event_keys with per-event teardown enabled

        # Thread control
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load_persisted_state(self):
        """Load overrides, skips, and teardown flags from the database."""
        try:
            rows = self._ctx.db.get_event_overrides()
            for row in rows:
                key, field, value = row["event_key"], row["field"], row["value"]
                if field == "skip":
                    self._skipped.add(key)
                elif field == "profile":
                    self._override_profiles[key] = value
                elif field == "teardown":
                    self._teardown_enabled.add(key)
            if rows:
                logger.info(f"Event automation: loaded {len(rows)} persisted overrides from database")
        except Exception as e:
            logger.warning(f"Event automation: failed to load persisted state: {e}")

    def _persist(self, event_key: str, field: str, value: str = ""):
        """Save an override to the database."""
        try:
            self._ctx.db.save_event_override(event_key, field, value)
        except Exception as e:
            logger.warning(f"Event automation: failed to persist {field} for {event_key}: {e}")

    def _unpersist(self, event_key: str, field: str):
        """Remove an override from the database."""
        try:
            self._ctx.db.delete_event_override(event_key, field)
        except Exception as e:
            logger.warning(f"Event automation: failed to unpersist {field} for {event_key}: {e}")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start(self):
        if not self._enabled:
            logger.info("Event automation disabled in config")
            return
        if not self._calendar_url:
            logger.warning("Event automation enabled but no calendar_url configured")
            return
        # Load persisted overrides now that ctx.db is available
        self._load_persisted_state()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="event-automation")
        self._thread.start()
        logger.info(f"Event automation started (poll every {self._poll_interval}s, "
                     f"setup {self._setup_lead}m before, teardown {self._teardown_delay}m after)")

    def stop(self):
        self._stop.set()

    def get_upcoming_events(self, hours: int = 48) -> List[dict]:
        """Return upcoming events with their automation state for the API."""
        now = datetime.now(TZ)
        cutoff = now + timedelta(hours=hours)
        result = []
        with self._events_lock:
            for ev in self._events:
                if ev["end"] < now - timedelta(hours=2):
                    continue
                if ev["start"] > cutoff:
                    continue
                event_key = self._event_key(ev)
                profile_id = self._override_profiles.get(event_key) or self._match_profile(ev)
                profile = self._profiles.get(profile_id, {})

                setup_time = ev["start"] - timedelta(minutes=self._setup_lead)
                teardown_time = ev["end"] + timedelta(minutes=self._teardown_delay)
                preflight_time = ev["start"] - timedelta(minutes=self._preflight_minutes)

                fired_state = self._fired.get(event_key)
                skipped = event_key in self._skipped

                # Determine status
                if skipped:
                    status = "skipped"
                elif fired_state == "teardown":
                    status = "completed"
                elif fired_state == "setup":
                    status = "active"
                elif now >= setup_time:
                    status = "ready"
                elif now >= preflight_time:
                    status = "preflight"
                else:
                    status = "upcoming"

                result.append({
                    "key": event_key,
                    "title": ev.get("title", "Untitled"),
                    "start": ev["start"].isoformat(),
                    "end": ev["end"].isoformat(),
                    "profile_id": profile_id,
                    "profile_label": profile.get("label", profile_id or "No Profile"),
                    "setup_macro": profile.get("setup_macro", ""),
                    "teardown_macro": profile.get("teardown_macro", ""),
                    "setup_time": setup_time.isoformat(),
                    "teardown_time": teardown_time.isoformat(),
                    "preflight_time": preflight_time.isoformat(),
                    "status": status,
                    "teardown_enabled": self._auto_teardown or event_key in self._teardown_enabled,
                    "preflight_result": self._preflight_results.get(event_key),
                })
        result.sort(key=lambda e: e["start"])
        return result

    def get_profiles(self) -> Dict[str, dict]:
        """Return all configured profiles."""
        return {pid: {"label": p.get("label", pid),
                      "setup_macro": p.get("setup_macro", ""),
                      "teardown_macro": p.get("teardown_macro", ""),
                      "keywords": p.get("keywords", [])}
                for pid, p in self._profiles.items()}

    def skip_event(self, event_key: str) -> bool:
        """Mark an event to be skipped (no auto-setup/teardown)."""
        self._skipped.add(event_key)
        self._persist(event_key, "skip")
        logger.info(f"Event automation: skipped event {event_key}")
        return True

    def unskip_event(self, event_key: str) -> bool:
        """Remove skip flag from an event."""
        self._skipped.discard(event_key)
        self._unpersist(event_key, "skip")
        logger.info(f"Event automation: unskipped event {event_key}")
        return True

    def enable_teardown(self, event_key: str) -> bool:
        """Enable auto-teardown for a specific event."""
        self._teardown_enabled.add(event_key)
        self._persist(event_key, "teardown")
        logger.info(f"Event automation: teardown enabled for {event_key}")
        return True

    def disable_teardown(self, event_key: str) -> bool:
        """Disable auto-teardown for a specific event."""
        self._teardown_enabled.discard(event_key)
        self._unpersist(event_key, "teardown")
        logger.info(f"Event automation: teardown disabled for {event_key}")
        return True

    def override_profile(self, event_key: str, profile_id: str) -> bool:
        """Override the auto-detected profile for a specific event."""
        if profile_id and profile_id not in self._profiles:
            return False
        if profile_id:
            self._override_profiles[event_key] = profile_id
            self._persist(event_key, "profile", profile_id)
        else:
            self._override_profiles.pop(event_key, None)
            self._unpersist(event_key, "profile")
        logger.info(f"Event automation: profile override {event_key} -> {profile_id or 'auto'}")
        return True

    def trigger_now(self, event_key: str, action: str) -> dict:
        """Manually trigger setup or teardown for an event right now."""
        ev = self._find_event(event_key)
        if not ev:
            return {"success": False, "error": "Event not found"}
        profile_id = self._override_profiles.get(event_key) or self._match_profile(ev)
        profile = self._profiles.get(profile_id, {})
        macro_key = profile.get(f"{action}_macro", "")
        if not macro_key:
            return {"success": False, "error": f"No {action} macro in profile {profile_id}"}
        return self._fire_macro(event_key, macro_key, action, ev.get("title", ""))

    def run_preflight(self, event_key: str) -> dict:
        """Run preflight health checks for an event."""
        ev = self._find_event(event_key)
        if not ev:
            return {"success": False, "error": "Event not found"}
        profile_id = self._override_profiles.get(event_key) or self._match_profile(ev)
        profile = self._profiles.get(profile_id, {})
        checks = profile.get("preflight_checks", [])
        result = self._run_preflight_checks(event_key, checks)
        return {"success": True, "result": result}

    def get_status(self) -> dict:
        """Return module status summary."""
        now = datetime.now(TZ)
        with self._events_lock:
            total_events = len(self._events)
            upcoming = sum(1 for e in self._events if e["start"] > now)
        return {
            "enabled": self._enabled,
            "calendar_url": self._calendar_url,
            "feed_ok": self._feed_ok,
            "last_fetch": datetime.fromtimestamp(self._last_fetch, TZ).isoformat() if self._last_fetch else None,
            "total_events": total_events,
            "upcoming_events": upcoming,
            "setup_lead_minutes": self._setup_lead,
            "teardown_delay_minutes": self._teardown_delay,
            "auto_teardown": self._auto_teardown,
            "profiles_count": len(self._profiles),
        }

    # ------------------------------------------------------------------
    # Calendar fetching & parsing (adapted from health_module.py)
    # ------------------------------------------------------------------

    def fetch_calendar(self) -> Tuple[List[dict], bool]:
        """Fetch and parse the church calendar RSS feed."""
        if not self._calendar_url:
            return [], False
        try:
            resp = requests.get(self._calendar_url, timeout=15,
                                headers={"User-Agent": "STP-Gateway/1.0"})
            if resp.status_code != 200:
                logger.warning(f"Event automation: calendar HTTP {resp.status_code}")
                return self._events, self._feed_ok  # return stale
            events = self._parse_rss_calendar(resp.text)
            self._last_fetch = time.time()
            self._feed_ok = True
            with self._events_lock:
                self._events = events
            logger.info(f"Event automation: fetched {len(events)} events from calendar")
            return events, True
        except Exception as e:
            logger.warning(f"Event automation: calendar fetch failed: {type(e).__name__}: {e}")
            return self._events, self._feed_ok

    @staticmethod
    def _parse_rss_calendar(xml_text: str) -> List[dict]:
        """Parse FaithConnector RSS 2.0 feed into event dicts with title, start, end."""
        events = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return events

        for item in root.iter("item"):
            title_el = item.find("title")
            pub_date_el = item.find("pubDate")
            desc_el = item.find("description")

            if pub_date_el is None or pub_date_el.text is None:
                continue

            title = (title_el.text or "Untitled") if title_el is not None else "Untitled"
            event_dt = _parse_rfc822(pub_date_el.text.strip())
            if event_dt is None:
                continue

            # Extract end time from description
            duration_hours = 3
            desc = (desc_el.text or "") if desc_el is not None else ""
            time_range = re.search(
                r'(\d{1,2}:\d{2}\s*[APap][Mm])\s*[-–]\s*(\d{1,2}:\d{2}\s*[APap][Mm])',
                desc
            )
            if time_range:
                try:
                    raw_end = time_range.group(2).strip()
                    raw_end = re.sub(r'([APap][Mm])', lambda m: ' ' + m.group(1).upper(), raw_end).strip()
                    end_time = datetime.strptime(raw_end, "%I:%M %p").time()
                    event_end = event_dt.replace(hour=end_time.hour, minute=end_time.minute)
                    if event_end <= event_dt:
                        event_end += timedelta(hours=duration_hours)
                except ValueError:
                    event_end = event_dt + timedelta(hours=duration_hours)
            else:
                event_end = event_dt + timedelta(hours=duration_hours)

            events.append({"title": title, "start": event_dt, "end": event_end})

        return events

    # ------------------------------------------------------------------
    # Profile matching
    # ------------------------------------------------------------------

    _DAY_ABBREVS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}

    def _match_profile(self, event: dict) -> str:
        """Match an event to a profile by keyword search in the title.

        Keywords can be plain strings (match any day) or dicts with
        'keyword' and 'days' keys for day-of-week constraints:
            keywords:
              - "feast"                              # any day
              - keyword: "liturgy"
                days: [sun]                          # Sundays only
        """
        title = event.get("title", "").lower()
        event_start = event.get("start")
        event_weekday = event_start.weekday() if hasattr(event_start, "weekday") else None

        for profile_id, profile in self._profiles.items():
            keywords = profile.get("keywords", [])
            for entry in keywords:
                if isinstance(entry, dict):
                    kw = entry.get("keyword", "").lower()
                    allowed_days = entry.get("days")
                    if kw and kw in title:
                        if allowed_days and event_weekday is not None:
                            day_nums = [self._DAY_ABBREVS.get(d.lower()) for d in allowed_days]
                            if event_weekday not in day_nums:
                                continue  # keyword matches but wrong day
                        return profile_id
                else:
                    if str(entry).lower() in title:
                        return profile_id
        return self._default_profile

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def _run_loop(self):
        """Background loop: fetch calendar, check for events needing setup/teardown."""
        logger.info("Event automation loop started")
        # Initial fetch
        self.fetch_calendar()

        while not self._stop.is_set():
            try:
                now = datetime.now(TZ)

                # Re-fetch calendar periodically
                if time.time() - self._last_fetch >= self._poll_interval:
                    self.fetch_calendar()

                # Clean up old fired/skipped entries (events more than 24h old)
                self._cleanup_old_state(now)

                # Check each event
                with self._events_lock:
                    events_snapshot = list(self._events)

                for ev in events_snapshot:
                    event_key = self._event_key(ev)

                    # Skip if user manually skipped
                    if event_key in self._skipped:
                        continue

                    profile_id = self._override_profiles.get(event_key) or self._match_profile(ev)
                    profile = self._profiles.get(profile_id, {})
                    if not profile:
                        continue

                    setup_time = ev["start"] - timedelta(minutes=self._setup_lead)
                    teardown_time = ev["end"] + timedelta(minutes=self._teardown_delay)
                    preflight_time = ev["start"] - timedelta(minutes=self._preflight_minutes)

                    fired_state = self._fired.get(event_key)

                    # Preflight check (run once when entering preflight window)
                    if (now >= preflight_time and now < setup_time
                            and event_key not in self._preflight_results):
                        checks = profile.get("preflight_checks", [])
                        if checks:
                            self._run_preflight_checks(event_key, checks)

                    # Setup: fire once when entering the setup window
                    if now >= setup_time and now < ev["end"] and fired_state is None:
                        macro_key = profile.get("setup_macro", "")
                        if macro_key:
                            self._fire_macro(event_key, macro_key, "setup", ev.get("title", ""))

                    # Teardown: fire once after teardown delay (only if enabled)
                    teardown_on = self._auto_teardown or event_key in self._teardown_enabled
                    if teardown_on and now >= teardown_time and fired_state == "setup":
                        macro_key = profile.get("teardown_macro", "")
                        if macro_key:
                            self._fire_macro(event_key, macro_key, "teardown", ev.get("title", ""))

            except Exception as e:
                logger.warning(f"Event automation loop error: {type(e).__name__}: {e}")

            self._stop.wait(30)  # Check every 30 seconds

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _event_key(event: dict) -> str:
        """Generate a unique key for an event based on title + start time."""
        title = event.get("title", "untitled")
        start = event.get("start")
        if hasattr(start, "isoformat"):
            return f"{title}|{start.strftime('%Y-%m-%d_%H:%M')}"
        return f"{title}|{start}"

    def _find_event(self, event_key: str) -> Optional[dict]:
        """Find an event by its key."""
        with self._events_lock:
            for ev in self._events:
                if self._event_key(ev) == event_key:
                    return ev
        return None

    def _fire_macro(self, event_key: str, macro_key: str, action: str, title: str) -> dict:
        """Execute a macro and record the action."""
        from macro_engine import execute_macro
        logger.info(f"Event automation: firing {action} macro '{macro_key}' for '{title}'")
        self._fired[event_key] = action

        # Log to audit
        self._ctx.db.log_action(
            "EventAutomation", f"event:{action}", macro_key,
            json.dumps({"event_key": event_key, "title": title, "action": action}),
            "triggered", 0
        )

        # Notify all tablets
        try:
            self._ctx.socketio.emit("event_automation:action", {
                "event_key": event_key,
                "title": title,
                "action": action,
                "macro": macro_key,
            })
        except Exception:
            pass

        # Run macro in background thread
        def _run():
            result = execute_macro(self._ctx, macro_key, "EventAutomation", 0)
            status = "success" if result.get("success") else "failed"
            logger.info(f"Event automation: {action} macro '{macro_key}' {status} for '{title}'")
            self._ctx.db.log_action(
                "EventAutomation", f"event:{action}:result", macro_key,
                json.dumps({"event_key": event_key, "title": title, "result": result}),
                status, 0
            )
            try:
                self._ctx.socketio.emit("event_automation:result", {
                    "event_key": event_key,
                    "action": action,
                    "result": result,
                })
            except Exception:
                pass

        threading.Thread(target=_run, daemon=True, name=f"event-{action}").start()
        return {"success": True, "macro": macro_key, "action": action}

    def _run_preflight_checks(self, event_key: str, check_ids: List[str]) -> dict:
        """Run preflight health checks and store results."""
        results = {}
        health = self._ctx.health
        if health is None:
            results = {cid: {"level": "unknown", "message": "Health module not available"} for cid in check_ids}
        else:
            all_results = health.get_all_results()
            for cid in check_ids:
                svc_result = all_results.get(cid)
                if svc_result:
                    results[cid] = {
                        "level": svc_result.get("status", {}).get("level", "unknown"),
                        "message": svc_result.get("message", ""),
                        "name": svc_result.get("name", cid),
                    }
                else:
                    results[cid] = {"level": "unknown", "message": "Service not found", "name": cid}

        all_ok = all(r.get("level") in ("ok", "expected_off") for r in results.values())
        preflight = {
            "checks": results,
            "all_ok": all_ok,
            "timestamp": datetime.now(TZ).isoformat(),
        }
        self._preflight_results[event_key] = preflight
        level = "OK" if all_ok else "WARNING"
        logger.info(f"Event automation: preflight {level} for {event_key}: "
                     f"{sum(1 for r in results.values() if r['level'] == 'ok')}/{len(results)} healthy")

        # Notify tablets about preflight results
        try:
            self._ctx.socketio.emit("event_automation:preflight", {
                "event_key": event_key,
                "preflight": preflight,
            })
        except Exception:
            pass

        return preflight

    def _cleanup_old_state(self, now: datetime):
        """Remove state entries for events more than 24 hours old."""
        cutoff = now - timedelta(hours=24)
        stale_keys = set()
        with self._events_lock:
            for ev in self._events:
                key = self._event_key(ev)
                if ev["end"] < cutoff:
                    stale_keys.add(key)
        for key in stale_keys:
            self._fired.pop(key, None)
            self._skipped.discard(key)
            self._override_profiles.pop(key, None)
            self._preflight_results.pop(key, None)
            self._teardown_enabled.discard(key)
            try:
                self._ctx.db.delete_event_overrides_for_key(key)
            except Exception:
                pass


def _parse_rfc822(date_str: str) -> Optional[datetime]:
    """Parse RFC 822 date string to timezone-aware datetime in church timezone."""
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.astimezone(TZ)
    except Exception:
        pass
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%d %b %Y %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(date_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=TZ)
            return dt.astimezone(TZ)
        except ValueError:
            continue
    return None
