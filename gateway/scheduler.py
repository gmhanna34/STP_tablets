"""Cron-like schedule execution for macro automation."""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime

from macro_engine import execute_macro

logger = logging.getLogger("stp-gateway")


def start_scheduler(ctx):
    """Start the schedule runner thread."""
    db = ctx.db
    macro_defs = ctx.macro_defs

    _last_cleanup_date = ""

    def schedule_loop():
        nonlocal _last_cleanup_date
        logger.info("Schedule runner started (checks every 30s)")
        while True:
            try:
                now = datetime.now()
                current_day = str(now.weekday())  # 0=Mon, 6=Sun
                current_hm = now.strftime("%H:%M")

                # Daily audit log cleanup (run once at 03:00)
                today_str = now.strftime("%Y-%m-%d")
                if current_hm == "03:00" and _last_cleanup_date != today_str:
                    _last_cleanup_date = today_str
                    db.cleanup_old_logs(30)
                    logger.info("Audit log cleanup complete (>30 days deleted)")

                for sched in db.get_schedules():
                    if not sched.get("enabled"):
                        continue
                    days = str(sched.get("days", ""))
                    sched_time = sched.get("time_of_day", "")
                    if current_day not in days.split(","):
                        continue
                    if current_hm != sched_time:
                        continue
                    # Check if already run this minute
                    last_run = sched.get("last_run", "")
                    run_key = now.strftime("%Y-%m-%d %H:%M")
                    if last_run == run_key:
                        continue

                    macro_key = sched.get("macro_key", "")
                    sched_name = sched.get("name", "")
                    logger.info(f"Schedule firing: {sched_name} -> {macro_key}")
                    db.update_schedule(sched["id"], last_run=run_key)
                    db.log_action(f"Schedule:{sched_name}", "schedule:fire", macro_key,
                                  json.dumps({"schedule_id": sched["id"], "name": sched_name,
                                              "time": sched_time, "day": current_day}),
                                  "triggered", 0)

                    # Run macro in a separate thread to not block scheduler
                    threading.Thread(
                        target=execute_macro,
                        args=(ctx, macro_key, f"Schedule:{sched_name}", 0),
                        daemon=True,
                    ).start()

            except Exception as e:
                logger.warning(f"Schedule runner error: {e}")

            time.sleep(30)

    sched_thread = threading.Thread(target=schedule_loop, daemon=True)
    sched_thread.start()
